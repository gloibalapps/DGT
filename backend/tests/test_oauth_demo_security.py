"""OAuth redirect allowlist, poll secret, and demo gating.

In-process TestClient. Google's token endpoint and the database are faked.
No real accounts, no network.
"""
import os

import httpx
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("EXPO_PUBLIC_BACKEND_URL", "http://127.0.0.1:9")
os.environ.setdefault("GOOGLE_CLIENT_ID", "test-client")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "test-secret")

import server  # noqa: E402


class MemResult:
    def __init__(self, n=0):
        self.modified_count = self.deleted_count = self.matched_count = n


class MemCursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, *a, **k):
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    async def to_list(self, length=None):
        return list(self._docs if length is None else self._docs[:length])

    def __aiter__(self):
        async def gen():
            for d in self._docs:
                yield d
        return gen()


def _match(doc, flt):
    for key, cond in (flt or {}).items():
        val = doc.get(key)
        if isinstance(cond, dict):
            for op, expected in cond.items():
                if op == "$lt":
                    if val is None or not val < expected:
                        return False
                elif op == "$in":
                    if val not in list(expected):
                        return False
                elif op == "$ne":
                    if val == expected:
                        return False
                else:
                    raise AssertionError(f"test double does not implement {op}")
        elif cond is None:
            if val is not None:
                return False
        elif val != cond:
            return False
    return True


class MemColl:
    def __init__(self):
        self.docs = []

    def find(self, flt=None, projection=None):
        return MemCursor([dict(d) for d in self.docs if _match(d, flt)])

    async def find_one(self, flt=None, projection=None, sort=None):
        for d in self.docs:
            if _match(d, flt):
                return dict(d)
        return None

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return MemResult(1)

    async def insert_many(self, docs):
        for d in docs:
            self.docs.append(dict(d))
        return MemResult(len(list(docs)))

    async def _update(self, flt, update, upsert, many):
        matched = [d for d in self.docs if _match(d, flt)]
        if not many:
            matched = matched[:1]
        for d in matched:
            for op, vals in update.items():
                if op == "$set":
                    d.update(vals)
                elif op == "$setOnInsert":
                    pass
                else:
                    raise AssertionError(op)
        if not matched and upsert:
            base = {k: v for k, v in (flt or {}).items() if not isinstance(v, dict)}
            for op, vals in update.items():
                if op in ("$set", "$setOnInsert"):
                    base.update(vals)
            self.docs.append(base)
        return MemResult(len(matched))

    async def update_one(self, flt, update, upsert=False):
        return await self._update(flt, update, upsert, False)

    async def update_many(self, flt, update, upsert=False):
        return await self._update(flt, update, upsert, True)

    async def delete_one(self, flt):
        for i, d in enumerate(self.docs):
            if _match(d, flt):
                del self.docs[i]
                return MemResult(1)
        return MemResult(0)

    async def delete_many(self, flt):
        keep = [d for d in self.docs if not _match(d, flt)]
        n = len(self.docs) - len(keep)
        self.docs[:] = keep
        return MemResult(n)


class MemDB:
    def __init__(self):
        self._cols = {}

    async def close(self):
        return None

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self._cols.setdefault(name, MemColl())

    def __getitem__(self, name):
        return getattr(self, name)


class _Google:
    """Stand-in for httpx.AsyncClient during the code exchange."""

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, data=None):
        return httpx.Response(200, json={"access_token": "google-access", "expires_in": 3600, "scope": "openid email"})

    async def get(self, url, headers=None):
        return httpx.Response(200, json={"email": "driver@example.com", "name": "Driver", "picture": None})


@pytest.fixture
def db(monkeypatch):
    mem = MemDB()
    monkeypatch.setattr(server, "db", mem)
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-secret")
    monkeypatch.setenv("OAUTH_REDIRECT_ORIGINS", "https://driversgigtax.app")
    monkeypatch.delenv("DEMO_ENABLED", raising=False)
    monkeypatch.delenv("DEMO_REVIEW_SECRET", raising=False)
    monkeypatch.delenv("DEMO_ENTITLED", raising=False)
    monkeypatch.setenv("PAYWALL_ENFORCED", "false")
    monkeypatch.setenv("DEMO_RATE_LIMIT", "5")
    monkeypatch.setenv("AI_RATE_LIMIT", "30")
    if hasattr(server, "reset_rate_limits"):
        server.reset_rate_limits()
    return mem


@pytest.fixture
def client(db):
    with TestClient(server.app) as c:
        yield c


def test_evil_https_redirect_is_400_and_does_not_redirect(client, db):
    r = client.post("/api/auth/google/start", json={"app_redirect": "https://evil.example/steal"})
    assert r.status_code == 400
    assert r.headers.get("location") is None
    assert "accounts.google.com" not in r.text
    assert db.oauth_states.docs == []


def test_get_start_cannot_redirect(client):
    r = client.get("/api/auth/google/start", params={"app_redirect": "https://evil.example/steal"}, follow_redirects=False)
    assert r.status_code == 405
    assert r.headers.get("location") is None


@pytest.mark.parametrize("bad", [
    "javascript:alert(1)",
    "http://driversgigtax.app/",
    "https://driversgigtax.app.evil.com/",
    "https://evil.example/driversgigtax.app",
    "https://user@driversgigtax.app/",
    "data:text/html,hi",
    "",
])
def test_redirect_allowlist_rejects(client, bad):
    r = client.post("/api/auth/google/start", json={"app_redirect": bad})
    assert r.status_code == 400
    assert r.headers.get("location") is None


def test_custom_scheme_and_configured_https_origin_are_allowed(client):
    native = client.post("/api/auth/google/start", json={"app_redirect": "driversgigtax://auth"})
    assert native.status_code == 200, native.text
    body = native.json()
    assert body["state"] and body["poll_secret"]
    assert body["poll_secret"] not in body["auth_url"]
    assert body["state"] in body["auth_url"]
    assert "accounts.google.com" in body["auth_url"]
    web = client.post("/api/auth/google/start", json={"app_redirect": "https://driversgigtax.app/signed-in"})
    assert web.status_code == 200, web.text


def test_planted_disallowed_redirect_is_not_followed(client, db):
    db.oauth_states.docs.append({
        "state": "planted", "app_redirect": "https://evil.example/steal", "poll_secret": "sek",
    })
    r = client.get("/api/auth/google/callback", params={"error": "access_denied", "state": "planted"}, follow_redirects=False)
    assert r.status_code == 400
    assert r.headers.get("location") in (None, "")


def test_bounce_page_html_escapes_custom_scheme(client, db):
    nasty = 'driversgigtax://auth?x="><img src=x onerror=alert(1)>'
    db.oauth_states.docs.append({"state": "planted", "app_redirect": nasty, "poll_secret": "sek"})
    r = client.get("/api/auth/google/callback", params={"error": "access_denied", "state": "planted"}, follow_redirects=False)
    assert r.status_code == 200
    assert "<img" not in r.text
    assert "&gt;" in r.text or "&#62;" in r.text
    assert "session_token=" not in r.text


def test_login_redirect_has_no_session_token_and_poll_requires_secret(client, db, monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _Google)
    started = client.post("/api/auth/google/start", json={"app_redirect": "driversgigtax://auth"}).json()
    state, secret = started["state"], started["poll_secret"]

    missing = client.post("/api/auth/google/poll", json={"state": state})
    assert missing.status_code == 401
    wrong = client.post("/api/auth/google/poll", json={"state": state, "poll_secret": "nope"})
    assert wrong.status_code == 401

    cb = client.get("/api/auth/google/callback", params={"code": "fakecode", "state": state}, follow_redirects=False)
    assert cb.status_code == 200
    assert "session_token=" not in cb.text
    assert "session_token" not in (cb.headers.get("location") or "")
    assert secret not in cb.text

    ready = client.post("/api/auth/google/poll", json={"state": state, "poll_secret": secret})
    assert ready.status_code == 200, ready.text
    token = ready.json()["session_token"]
    assert token and token not in cb.text
    # single use
    again = client.post("/api/auth/google/poll", json={"state": state, "poll_secret": secret})
    assert again.status_code == 401


def test_https_login_redirect_omits_token(client, db, monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _Google)
    started = client.post("/api/auth/google/start", json={"app_redirect": "https://driversgigtax.app/app"}).json()
    cb = client.get(
        "/api/auth/google/callback",
        params={"code": "fakecode", "state": started["state"]},
        follow_redirects=False,
    )
    loc = cb.headers.get("location") or ""
    assert cb.status_code in (302, 303, 307, 308)
    assert loc.startswith("https://driversgigtax.app/app")
    assert "session_token" not in loc
    assert started["poll_secret"] not in loc


def test_paywall_enforced_still_defaults_false(monkeypatch):
    monkeypatch.delenv("PAYWALL_ENFORCED", raising=False)
    assert server.subs.enforced() is False


def test_demo_off_by_default(client):
    r = client.post("/api/auth/demo")
    assert r.status_code == 404


def test_demo_requires_review_secret(client, monkeypatch):
    monkeypatch.setenv("DEMO_ENABLED", "true")
    monkeypatch.setenv("DEMO_REVIEW_SECRET", "review-secret")
    assert client.post("/api/auth/demo").status_code == 401
    assert client.post("/api/auth/demo", headers={"X-Demo-Review-Secret": "wrong"}).status_code == 401


def test_demo_rate_limit(client, monkeypatch):
    monkeypatch.setenv("DEMO_ENABLED", "true")
    monkeypatch.setenv("DEMO_REVIEW_SECRET", "review-secret")
    monkeypatch.setenv("DEMO_RATE_LIMIT", "2")
    headers = {"X-Demo-Review-Secret": "nope"}
    assert client.post("/api/auth/demo", headers=headers).status_code == 401
    assert client.post("/api/auth/demo", headers=headers).status_code == 401
    assert client.post("/api/auth/demo", headers=headers).status_code == 429


def _session(db, *, demo=False):
    uid = "demo_user" if demo else "user_real"
    db.users.docs.append({"user_id": uid, "email": f"{uid}@example.com", "is_demo": demo, "name": "T"})
    db.user_sessions.docs.append({
        "session_token": f"tok-{uid}", "user_id": uid,
        "expires_at": "2099-01-01T00:00:00+00:00",
    })
    return {"Authorization": f"Bearer tok-{uid}"}


def test_demo_user_cannot_ask_or_scan(client, db, monkeypatch):
    class _Msg:
        content = [type("B", (), {"type": "text", "text": "ok"})()]

    class _Anth:
        class messages:
            @staticmethod
            async def create(**k):
                return _Msg()

    monkeypatch.setattr(server, "anthropic_client", lambda: _Anth())
    h = _session(db, demo=True)
    ask = client.post("/api/ask", json={"question": "is fuel deductible?", "country": "AU"}, headers=h)
    assert ask.status_code == 403
    scan = client.post("/api/receipts/scan", json={"image_base64": "aGVsbG8="}, headers=h)
    assert scan.status_code == 403


def test_real_user_can_ask(client, db, monkeypatch):
    class _Msg:
        content = [type("B", (), {"type": "text", "text": "Fuel can be claimed."})()]

    class _Anth:
        class messages:
            @staticmethod
            async def create(**k):
                return _Msg()

    monkeypatch.setattr(server, "anthropic_client", lambda: _Anth())
    h = _session(db, demo=False)
    ask = client.post("/api/ask", json={"question": "is fuel deductible?", "country": "AU"}, headers=h)
    assert ask.status_code == 200, ask.text
    assert "Fuel" in ask.json()["answer"]


def test_demo_entitled_defaults_false(monkeypatch):
    monkeypatch.delenv("DEMO_ENTITLED", raising=False)
    assert server.subs.demo_entitled() is False
    monkeypatch.setenv("DEMO_ENTITLED", "true")
    assert server.subs.demo_entitled() is True


def test_enabled_demo_creates_session_that_still_cannot_ask(client, db, monkeypatch):
    monkeypatch.setenv("DEMO_ENABLED", "true")
    monkeypatch.setenv("DEMO_REVIEW_SECRET", "review-secret")
    r = client.post("/api/auth/demo", headers={"X-Demo-Review-Secret": "review-secret"})
    assert r.status_code == 200, r.text
    token = r.json()["session_token"]
    assert r.json()["user_id"].startswith("demo_")
    ask = client.post("/api/ask", json={"question": "fuel?", "country": "AU"}, headers={"Authorization": f"Bearer {token}"})
    assert ask.status_code == 403
