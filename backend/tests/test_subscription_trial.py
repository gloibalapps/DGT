"""14-day trial + server-side paywall (backend/subscription.py).

Runs IN-PROCESS (FastAPI TestClient) against the same Postgres as the rest of
the suite, so RevenueCat can be mocked with httpx.MockTransport and env flags
monkeypatched per test. Trial clocks are moved by editing users.doc directly.
"""
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conftest import DB_URL, db_fetch, mint_session  # noqa: E402

if not DB_URL:
    pytest.skip("SUPABASE_DB_URL not set", allow_module_level=True)

import server  # noqa: E402
import subscription as subs  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

NOW = lambda: datetime.now(timezone.utc)  # noqa: E731


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


@pytest.fixture(autouse=True)
def env(monkeypatch):
    for k in ("TRIAL_EXISTING_USERS_START", "REVENUECAT_SECRET_API_KEY", "REVENUECAT_WEBHOOK_AUTH",
              "RC_CACHE_TTL_SECONDS", "DEMO_ENTITLED", "RC_ENTITLEMENT_ID"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("PAYWALL_ENFORCED", "true")
    monkeypatch.setattr(subs, "rc_transport", None)
    yield


def new_user(started_days_ago=None, *, demo=False, created_days_ago=0, extra=None):
    uid = f"user_t{uuid.uuid4().hex[:10]}" if not demo else f"demo_t{uuid.uuid4().hex[:10]}"
    token = mint_session(uid, is_demo=demo)
    doc = {"created_at": (NOW() - timedelta(days=created_days_ago)).isoformat()}
    if started_days_ago is not None:
        st = NOW() - timedelta(days=started_days_ago)
        doc.update(trial_started_at=st.isoformat(), trial_ends_at=(st + timedelta(days=14)).isoformat())
    doc.update(extra or {})
    db_fetch("update public.users set doc = doc || $1::jsonb where user_id = $2", json.dumps(doc), uid)
    return uid, {"Authorization": f"Bearer {token}", "X-Test-No-Auto-Auth": "1"}


def user_doc(uid):
    return json.loads(db_fetch("select doc from public.users where user_id=$1", uid)[0]["doc"])


TRIP = {"date": "2026-10-01", "start_km": 0, "end_km": 10, "purpose": "business"}


def write(c, h):
    return c.post("/api/income", json={"date": "2026-10-01", "amount": 50, "platform": "uber"}, headers=h)


def rc_mock(entitlements, calls=None, status=200):
    def handler(req):
        if calls is not None:
            calls.append(str(req.url))
        assert req.headers["Authorization"] == "Bearer sk_test"
        return httpx.Response(status, json={"subscriber": {"entitlements": entitlements}})
    return httpx.MockTransport(handler)


def test_day0_trial(client):
    uid, h = new_user(0)
    r = client.get("/api/subscription/status", headers=h).json()
    assert r["state"] == "trial" and r["days_left"] == 14 and r["enforced"] is True
    assert write(client, h).status_code == 200


def test_day13_still_trial(client):
    uid, h = new_user(13)
    r = client.get("/api/subscription/status", headers=h).json()
    assert r["state"] == "trial" and r["days_left"] == 1
    assert write(client, h).status_code == 200


def test_day14_boundary_expired(client):
    uid, h = new_user(14)  # exactly 14*24h ago (plus test latency) -> over
    r = client.get("/api/subscription/status", headers=h).json()
    assert r["state"] == "expired" and r["days_left"] == 0
    assert user_doc(uid)["sub_status"] == "expired"
    w = write(client, h)
    assert w.status_code == 402 and w.json()["detail"]["code"] == "subscription_required"


def test_just_before_day14_is_trial(client):
    uid, h = new_user(14 - 1 / 1440)  # one minute left
    assert client.get("/api/subscription/status", headers=h).json()["state"] == "trial"


def test_expired_reads_export_backup_delete_allowed(client):
    uid, h = new_user(20)
    for path in ("/api/trips", "/api/income", "/api/expenses", "/api/shifts", "/api/profile",
                 "/api/vehicles", "/api/reports", "/api/dashboard", "/api/export", "/api/export-mileage",
                 "/api/backups/status", "/api/ue/jobs"):
        assert client.get(path, headers=h).status_code != 402, path
    assert client.post("/api/auth/ticket", headers=h).status_code == 200
    # Drive backup endpoint is not gated (it may 4xx for "not connected", never 402)
    assert client.post("/api/backups/google-drive", headers=h).status_code != 402
    for m, p, body in (("post", "/api/trips", TRIP), ("put", "/api/profile", {"name": "x"}),
                       ("post", "/api/vehicles", {"name": "car"}), ("post", "/api/expenses", {}),
                       ("post", "/api/shifts", {}), ("post", "/api/ask", {"question": "hi"}),
                       ("post", "/api/ue/jobs", {"jobs": []})):
        assert getattr(client, m)(p, json=body, headers=h).status_code == 402, p
    assert client.delete("/api/account", headers=h).status_code == 200
    assert not db_fetch("select 1 from public.users where user_id=$1", uid)


def test_active_entitlement_passes(client, monkeypatch):
    monkeypatch.setenv("REVENUECAT_SECRET_API_KEY", "sk_test")
    calls = []
    exp = (NOW() + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    monkeypatch.setattr(subs, "rc_transport", rc_mock({"pro": {"expires_date": exp, "product_identifier": "dgt_monthly"}}, calls))
    uid, h = new_user(30)
    r = client.get("/api/subscription/status", headers=h).json()
    assert r["state"] == "active" and r["entitlement"] == "pro"
    assert write(client, h).status_code == 200
    assert calls and calls[0].endswith(f"/v1/subscribers/{uid}")
    d = user_doc(uid)
    assert d["sub_status"] == "active" and d["sub_product"] == "dgt_monthly"


def test_lapsed_entitlement_is_expired(client, monkeypatch):
    monkeypatch.setenv("REVENUECAT_SECRET_API_KEY", "sk_test")
    monkeypatch.setattr(subs, "rc_transport", rc_mock({"pro": {"expires_date": "2020-01-01T00:00:00Z"}}))
    uid, h = new_user(30)
    assert write(client, h).status_code == 402


def test_other_entitlement_id_ignored(client, monkeypatch):
    monkeypatch.setenv("REVENUECAT_SECRET_API_KEY", "sk_test")
    monkeypatch.setattr(subs, "rc_transport", rc_mock({"something_else": {"expires_date": None}}))
    uid, h = new_user(30)
    assert write(client, h).status_code == 402
    monkeypatch.setenv("RC_ENTITLEMENT_ID", "something_else")
    assert client.get("/api/subscription/status?refresh=true", headers=h).json()["state"] == "active"


def test_cache_ttl(client, monkeypatch):
    monkeypatch.setenv("REVENUECAT_SECRET_API_KEY", "sk_test")
    monkeypatch.setenv("RC_CACHE_TTL_SECONDS", "300")
    calls = []
    monkeypatch.setattr(subs, "rc_transport", rc_mock({"pro": {"expires_date": None}}, calls))
    uid, h = new_user(30)
    for _ in range(3):
        assert write(client, h).status_code == 200
    assert len(calls) == 1  # cached
    # age the cache past TTL -> re-verify
    db_fetch("update public.users set doc = doc || $1::jsonb where user_id=$2",
             json.dumps({"sub_checked_at": (NOW() - timedelta(seconds=301)).isoformat()}), uid)
    assert write(client, h).status_code == 200
    assert len(calls) == 2


def test_rc_outage_grace_then_expired(client, monkeypatch):
    monkeypatch.setenv("REVENUECAT_SECRET_API_KEY", "sk_test")
    monkeypatch.setattr(subs, "rc_transport", rc_mock({}, status=500))
    uid, h = new_user(30, extra={"sub_status": "active", "sub_expires_at": None,
                                 "sub_checked_at": (NOW() - timedelta(hours=1)).isoformat()})
    monkeypatch.setenv("RC_CACHE_TTL_SECONDS", "60")
    assert client.get("/api/subscription/status", headers=h).json()["state"] == "grace"
    assert write(client, h).status_code == 200
    uid2, h2 = new_user(30)
    assert write(client, h2).status_code == 402  # never paid + outage -> still expired


def test_webhook(client, monkeypatch):
    monkeypatch.setenv("REVENUECAT_WEBHOOK_AUTH", "Bearer whsecret")
    monkeypatch.setenv("RC_CACHE_TTL_SECONDS", "3600")
    uid, h = new_user(30)
    assert write(client, h).status_code == 402
    exp_ms = int((NOW() + timedelta(days=30)).timestamp() * 1000)
    ev = {"event": {"type": "INITIAL_PURCHASE", "app_user_id": uid, "entitlement_ids": ["pro"],
                    "expiration_at_ms": exp_ms, "product_id": "dgt_yearly"}}
    assert client.post("/api/subscription/webhook", json=ev).status_code == 401
    assert client.post("/api/subscription/webhook", json=ev, headers={"Authorization": "nope"}).status_code == 401
    r = client.post("/api/subscription/webhook", json=ev, headers={"Authorization": "Bearer whsecret"})
    assert r.status_code == 200 and r.json()["updated"] == 1
    assert write(client, h).status_code == 200
    ev["event"]["type"] = "EXPIRATION"
    client.post("/api/subscription/webhook", json=ev, headers={"Authorization": "Bearer whsecret"})
    assert write(client, h).status_code == 402
    ev["event"]["type"] = "CANCELLATION"
    client.post("/api/subscription/webhook", json=ev, headers={"Authorization": "Bearer whsecret"})
    assert user_doc(uid)["sub_checked_at"] is None


def test_webhook_unconfigured_503(client):
    assert client.post("/api/subscription/webhook", json={"event": {}}).status_code == 503


def test_flag_off_no_enforcement(client, monkeypatch):
    monkeypatch.setenv("PAYWALL_ENFORCED", "false")
    uid, h = new_user(40)
    assert write(client, h).status_code == 200
    r = client.get("/api/subscription/status", headers=h).json()
    assert r["state"] == "expired" and r["enforced"] is False


def test_existing_user_default_starts_now(client):
    uid, h = new_user(None, created_days_ago=400)  # pre-feature account, no trial fields
    r = client.get("/api/subscription/status", headers=h).json()
    assert r["state"] == "trial" and r["days_left"] == 14
    assert user_doc(uid)["trial_started_at"]


def test_existing_user_env_start(client, monkeypatch):
    monkeypatch.setenv("TRIAL_EXISTING_USERS_START", (NOW() - timedelta(days=10)).date().isoformat())
    uid, h = new_user(None, created_days_ago=400)
    r = client.get("/api/subscription/status", headers=h).json()
    assert r["state"] == "trial" and r["days_left"] in (4, 5)
    monkeypatch.setenv("TRIAL_EXISTING_USERS_START", "2026-01-01")
    uid2, h2 = new_user(None, created_days_ago=400)
    assert write(client, h2).status_code == 402
    # created after the cutover -> its own created_at counts
    uid3, h3 = new_user(None, created_days_ago=3)
    assert client.get("/api/subscription/status", headers=h3).json()["days_left"] == 11


def test_demo_always_entitled(client, monkeypatch):
    uid, h = new_user(60, demo=True)
    r = client.get("/api/subscription/status", headers=h).json()
    assert r["state"] == "active" and r["entitlement"] == "demo"
    assert write(client, h).status_code == 200
    monkeypatch.setenv("DEMO_ENTITLED", "false")
    assert write(client, h).status_code == 402


def test_demo_signup_sets_trial(client):
    r = client.post("/api/auth/demo").json()
    h = {"Authorization": f"Bearer {r.get('session_token') or r.get('token')}", "X-Test-No-Auto-Auth": "1"}
    st = client.get("/api/subscription/status", headers=h).json()
    assert st["is_demo"] and st["trial_ends_at"]


def test_signup_trial_one_per_identity(monkeypatch):
    import asyncio
    from pgdb import Database
    monkeypatch.setattr(server, "db", Database(DB_URL))
    email = f"t{uuid.uuid4().hex[:8]}@test.invalid"

    async def go():
        f1 = await server._signup_trial(email)
        f2 = await server._signup_trial(email.upper())
        await server.db.close()
        return f1, f2
    f1, f2 = asyncio.run(go())
    assert f1["trial_started_at"] == f2["trial_started_at"]
    s = datetime.fromisoformat(f1["trial_started_at"]); e = datetime.fromisoformat(f1["trial_ends_at"])
    assert e - s == timedelta(days=14)
