"""Auth hole regression: every data route needs a valid, unexpired Bearer
session and is scoped to the caller's own profile (profile_id == user_id).

For every protected route:
  * no token              -> 401
  * expired token         -> 401
  * another user's token  -> 403 (foreign profile_id supplied) / 404 (record by id)
  * owner                 -> success (or a config-only error such as 409/503)
"""
import uuid
import pytest
import requests

from conftest import BASE_URL, mint_session, db_fetch

API = f"{BASE_URL}/api"
NOAUTO = {"X-Test-No-Auto-Auth": "1"}
TODAY = "2026-03-10"


def H(token=None):
    h = dict(NOAUTO)
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def call(method, path, token=None, params=None, json=None):
    return requests.request(method, f"{API}{path}", params=params, json=json, headers=H(token), timeout=30)


class Ctx:
    pass


@pytest.fixture(scope="module")
def ctx():
    c = Ctx()
    c.a = f"user_t{uuid.uuid4().hex[:10]}"
    c.b = f"user_t{uuid.uuid4().hex[:10]}"
    c.ta = mint_session(c.a)
    c.tb = mint_session(c.b)
    c.expired = mint_session(c.a, expired=True)
    assert call("GET", "/profile", c.ta).status_code == 200
    assert call("GET", "/profile", c.tb).status_code == 200
    return c


def make(c, kind):
    """Create a fresh record owned by user A; return its id."""
    body = {
        "trips": {"date": TODAY, "distance_km": 12.5},
        "income": {"date": TODAY, "amount": 100.0, "platform": "Uber"},
        "expenses": {"date": TODAY, "amount": 50.0, "category": "fuel", "receipt_image": "aGVsbG8="},
        "shifts": {"date": TODAY, "hours": 4},
    }
    if kind == "vehicles":
        vs = call("POST", "/vehicles", c.ta, json={"name": f"car-{uuid.uuid4().hex[:6]}"}).json()
        return vs[-1]["id"]
    if kind == "ue":
        r = call("POST", "/ue/jobs", c.ta, json={"jobs": [{
            "date": TODAY, "start_time": f"{(uuid.uuid4().int % 11) + 1}:{uuid.uuid4().int % 60:02d} PM",
            "duration_sec": 1200, "amount": 9.0 + (uuid.uuid4().int % 900) / 100}]}).json()
        return r["saved"][0]["id"]
    r = call("POST", f"/{kind}", c.ta, json=body[kind])
    assert r.status_code == 200, r.text
    return r.json()["id"]


# (method, path, json-body, kind-of-record-for-{id} or None, owner-ok-codes)
OK = {200}
ROUTES = [
    ("GET", "/profile", None, None, OK),
    ("PUT", "/profile", {"work_type": "both"}, None, OK),
    ("GET", "/vehicles", None, None, OK),
    ("POST", "/vehicles", {"name": "x"}, None, OK),
    ("PUT", "/vehicles/{id}", {"name": "renamed"}, "vehicles", OK),
    ("POST", "/vehicles/{id}/activate", None, "vehicles", OK),
    ("DELETE", "/vehicles/{id}", None, "vehicles", OK),
    ("GET", "/trips", None, None, OK),
    ("POST", "/trips", {"date": TODAY, "distance_km": 3}, None, OK),
    ("PUT", "/trips/{id}", {"distance_km": 4}, "trips", OK),
    ("DELETE", "/trips/{id}", None, "trips", OK),
    ("GET", "/income", None, None, OK),
    ("POST", "/income", {"date": TODAY, "amount": 5}, None, OK),
    ("PUT", "/income/{id}", {"amount": 6}, "income", OK),
    ("DELETE", "/income/{id}", None, "income", OK),
    ("GET", "/expenses", None, None, OK),
    ("POST", "/expenses", {"date": TODAY, "amount": 7}, None, OK),
    ("GET", "/expenses/{id}", None, "expenses", OK),
    ("PUT", "/expenses/{id}", {"amount": 8}, "expenses", OK),
    ("DELETE", "/expenses/{id}", None, "expenses", OK),
    ("GET", "/shifts", None, None, OK),
    ("POST", "/shifts", {"date": TODAY, "hours": 2}, None, OK),
    ("PUT", "/shifts/{id}", {"hours": 3}, "shifts", OK),
    ("DELETE", "/shifts/{id}", None, "shifts", OK),
    ("GET", "/reports", None, None, OK),
    ("GET", "/reports/analytics?start=2026-01-01&end=2026-12-31", None, None, OK),
    ("GET", "/dashboard", None, None, OK),
    ("GET", "/performance", None, None, OK),
    ("GET", "/insights", None, None, OK),
    ("GET", "/money", None, None, OK),
    ("GET", "/tax-mileage", None, None, OK),
    ("GET", "/export", None, None, OK),
    ("GET", "/export-mileage", None, None, OK),
    ("GET", "/backups/status", None, None, OK),
    ("POST", "/backups/google-drive", None, None, {409, 503}),  # Drive not connected / not configured
    ("POST", "/backups/disconnect", None, None, OK),
    ("POST", "/backups/restore", None, None, {409}),            # Drive not connected
    ("GET", "/ue/jobs", None, None, OK),
    ("POST", "/ue/jobs", {"jobs": []}, None, OK),
    ("PUT", "/ue/jobs/{id}", {"note": "x"}, "ue", OK),
    ("DELETE", "/ue/jobs/{id}", None, "ue", OK),
    ("GET", "/ue/guarantee", None, None, OK),
    ("GET", "/ue/mismatches", None, None, OK),
    ("GET", "/ue/export", None, None, OK),
    ("POST", "/receipts/scan", {"image_base64": "aGVsbG8="}, None, {200, 502, 503}),
    ("POST", "/ask", {"question": "hi"}, None, {200, 502, 503}),
    ("POST", "/auth/claim", {"from_profile_id": "dev-0000"}, None, OK),
    ("POST", "/auth/ticket", None, None, OK),
    ("DELETE", "/account", None, None, None),  # owner success covered in test_account_delete
]
IDS = [f"{m} {p}" for m, p, *_ in ROUTES]


def _resolve(c, path, kind):
    return path.replace("{id}", make(c, kind)) if kind else path


@pytest.mark.parametrize("method,path,body,kind,ok", ROUTES, ids=IDS)
def test_no_token_401(ctx, method, path, body, kind, ok):
    p = path.replace("{id}", "anything")
    assert call(method, p, None, params={"profile_id": ctx.a}, json=body).status_code == 401
    assert call(method, p, "not-a-real-token", json=body).status_code == 401


@pytest.mark.parametrize("method,path,body,kind,ok", ROUTES, ids=IDS)
def test_expired_token_401(ctx, method, path, body, kind, ok):
    p = _resolve(ctx, path, kind)
    r = call(method, p, ctx.expired, json=body)
    assert r.status_code == 401, r.text
    assert "expired" in r.text.lower()


@pytest.mark.parametrize("method,path,body,kind,ok", ROUTES, ids=IDS)
def test_other_user_forbidden(ctx, method, path, body, kind, ok):
    p = _resolve(ctx, path, kind)
    if kind:
        # B tries A's record by id -> 404, and A's record is untouched
        r = call(method, p, ctx.tb, json=body)
        assert r.status_code == 404, r.text
        lst = call("GET", "/" + {"ue": "ue/jobs"}.get(kind, kind), ctx.ta).json()
        assert p.split("/")[-1 if not p.endswith("activate") else -2] in [x["id"] for x in lst]
    # B supplies A's profile_id in the query string -> 403
    r = call(method, p, ctx.tb, params={"profile_id": ctx.a}, json=body)
    assert r.status_code in (403, 404), r.text
    if not kind:
        assert r.status_code == 403
    # ...and in the body
    # (scan/ask/claim never read a body profile_id, so there's nothing to spoof)
    if body is not None and method in ("POST", "PUT") and not kind \
            and path not in ("/receipts/scan", "/ask", "/auth/claim"):
        r = call(method, p, ctx.tb, json={**body, "profile_id": ctx.a})
        assert r.status_code == 403, r.text


@pytest.mark.parametrize("method,path,body,kind,ok", [r for r in ROUTES if r[4]], ids=[i for i, r in zip(IDS, ROUTES) if r[4]])
def test_owner_succeeds(ctx, method, path, body, kind, ok):
    p = _resolve(ctx, path, kind)
    r = call(method, p, ctx.ta, json=body)
    assert r.status_code in ok, r.text
    # owner may still send their own profile_id (legacy clients)
    r = call(method, _resolve(ctx, path, kind), ctx.ta, params={"profile_id": ctx.a}, json=body)
    assert r.status_code in ok, r.text


def test_records_are_owned_by_session_not_body(ctx):
    tid = make(ctx, "trips")
    rows = db_fetch("select profile_id from public.trips where id = $1", tid)
    assert rows[0]["profile_id"] == ctx.a
    # update can't move a record to another profile
    r = call("PUT", f"/trips/{tid}", ctx.ta, json={"profile_id": ctx.b, "distance_km": 1})
    assert r.status_code == 403
    assert db_fetch("select profile_id from public.trips where id = $1", tid)[0]["profile_id"] == ctx.a
    # B's lists never contain A's data
    assert all(t["profile_id"] == ctx.b for t in call("GET", "/trips", ctx.tb).json())
    assert tid not in [t["id"] for t in call("GET", "/trips", ctx.tb).json()]


def test_receipt_image_isolated(ctx):
    eid = make(ctx, "expenses")
    assert call("GET", f"/expenses/{eid}", ctx.ta).json()["receipt_image"] == "aGVsbG8="
    assert call("GET", f"/expenses/{eid}", ctx.tb).status_code == 404
    assert call("GET", f"/expenses/{eid}", ctx.tb, params={"profile_id": ctx.a}).status_code == 403


def test_ticket_for_browser_downloads(ctx):
    t = call("POST", "/auth/ticket", ctx.ta).json()["ticket"]
    r = requests.get(f"{API}/export", params={"ticket": t}, headers=NOAUTO)
    assert r.status_code == 200 and "GigTax export" in r.text
    # single use
    assert requests.get(f"{API}/export", params={"ticket": t}, headers=NOAUTO).status_code == 401
    # tickets don't work on normal (header-only) data routes
    t2 = call("POST", "/auth/ticket", ctx.ta).json()["ticket"]
    assert requests.get(f"{API}/trips", params={"ticket": t2}, headers=NOAUTO).status_code == 401
    # a ticket can't be used for someone else's profile_id
    assert requests.get(f"{API}/ue/export", params={"ticket": t2, "profile_id": ctx.b},
                        headers=NOAUTO).status_code == 403
    # Drive connect needs a ticket (no more binding Drive to an arbitrary profile_id)
    r = requests.get(f"{API}/auth/google/start", params={"backup": 1, "profile_id": ctx.a,
                     "app_redirect": "https://x"}, headers=NOAUTO, allow_redirects=False)
    assert r.status_code in (401, 500)  # 500 only when Google login isn't configured


def test_claim_cannot_take_another_users_data(ctx):
    c = f"user_t{uuid.uuid4().hex[:10]}"
    tc = mint_session(c)
    r = call("POST", "/auth/claim", tc, json={"from_profile_id": ctx.a})
    assert r.status_code == 403
    assert call("GET", "/trips", ctx.ta).status_code == 200


def test_claim_moves_anonymous_device_data():
    dev = str(uuid.uuid4())
    import asyncio, asyncpg, json, os
    from conftest import DB_URL

    async def seed():
        conn = await asyncpg.connect(DB_URL)
        try:
            await conn.execute("insert into public.trips (doc) values ($1::jsonb)", json.dumps(
                {"id": str(uuid.uuid4()), "profile_id": dev, "date": TODAY, "distance_km": 9.0, "type": "business"}))
            await conn.execute("insert into public.shifts (doc) values ($1::jsonb)", json.dumps(
                {"id": str(uuid.uuid4()), "profile_id": dev, "date": TODAY, "hours": 1.0}))
        finally:
            await conn.close()
    asyncio.run(seed())
    u = f"user_t{uuid.uuid4().hex[:10]}"
    tu = mint_session(u)
    r = call("POST", "/auth/claim", tu, json={"from_profile_id": dev})
    assert r.status_code == 200 and r.json()["claimed"] is True and r.json()["moved"] == 2
    assert len(call("GET", "/trips", tu).json()) == 1
    assert len(call("GET", "/shifts", tu).json()) == 1
    # second claim is a no-op (account already has data)
    assert call("POST", "/auth/claim", tu, json={"from_profile_id": str(uuid.uuid4())}).json()["claimed"] is False


def test_account_delete_removes_everything():
    u = f"user_t{uuid.uuid4().hex[:10]}"
    v = f"user_t{uuid.uuid4().hex[:10]}"
    tu, tu2, tv = mint_session(u), mint_session(u), mint_session(v)
    for k, b in (("trips", {"date": TODAY, "distance_km": 1}), ("income", {"date": TODAY, "amount": 1})):
        assert call("POST", f"/{k}", tu, json=b).status_code == 200
        assert call("POST", f"/{k}", tv, json=b).status_code == 200
    call("POST", "/auth/ticket", tu)
    import asyncio, asyncpg, json
    from conftest import DB_URL

    async def seed_drive():
        conn = await asyncpg.connect(DB_URL)
        try:
            await conn.execute("insert into public.drive_tokens (doc) values ($1::jsonb)",
                               json.dumps({"profile_id": u, "email": "x@y"}))
        finally:
            await conn.close()
    asyncio.run(seed_drive())
    # a foreign profile_id is rejected, nothing deleted
    assert call("DELETE", "/account", tu, params={"profile_id": v}).status_code == 403
    r = call("DELETE", "/account", tu)
    assert r.status_code == 200, r.text
    d = r.json()["deleted"]
    assert d["user"] == 1 and d["user_sessions"] == 2 and d["drive_tokens"] == 1 and d["oauth_states"] >= 1
    for t in ("users", "user_sessions"):
        assert db_fetch(f"select 1 from public.{t} where user_id = $1", u) == []
    for t in ("trips", "income", "drive_tokens", "profiles"):
        assert db_fetch(f"select 1 from public.{t} where profile_id = $1", u) == []
    assert db_fetch("select 1 from public.oauth_states where doc->>'user_id' = $1", u) == []
    # both sessions are dead
    assert call("GET", "/trips", tu).status_code == 401
    assert call("GET", "/trips", tu2).status_code == 401
    # the other user is untouched
    assert len(call("GET", "/trips", tv).json()) == 1


def test_public_routes_stay_public():
    for p in ("/site", "/privacy", "/terms"):
        assert requests.get(f"{API}{p}", headers=NOAUTO).status_code in (200, 404)
    assert requests.get(f"{BASE_URL}/health").status_code == 200
    assert requests.post(f"{API}/waitlist", json={"email": f"t{uuid.uuid4().hex[:6]}@ex.com"},
                         headers=NOAUTO).status_code == 200
    assert requests.get(f"{API}/auth/google/poll", params={"state": "nope"}, headers=NOAUTO).json()["status"] == "expired"
    r = requests.post(f"{API}/auth/demo", headers=NOAUTO)
    assert r.status_code == 200
    tok = r.json()["session_token"]
    assert len(call("GET", "/trips", tok).json()) > 0  # demo session works on data routes
