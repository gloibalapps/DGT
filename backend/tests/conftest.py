import os
import re
import json
import uuid
import asyncio
import pytest
import requests
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from dotenv import load_dotenv

# Load frontend .env for EXPO_PUBLIC_BACKEND_URL (public URL)
load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
DB_URL = os.environ.get("SUPABASE_DB_URL", "")


# ---------------------------------------------------------------------------
# Session minting straight into Postgres (the same DB the server under test
# uses). Every data route now requires a Bearer session, and a session's
# user_id IS its profile_id.
# ---------------------------------------------------------------------------
def _run(coro):
    return asyncio.run(coro)


async def _mint_async(user_id: str, expires_at: datetime, is_demo: bool = False) -> str:
    import asyncpg
    conn = await asyncpg.connect(DB_URL)
    try:
        token = uuid.uuid4().hex
        user = {"user_id": user_id, "email": f"{user_id.lower()}@test.invalid", "name": "Test",
                "picture": None, "created_at": datetime.now(timezone.utc).isoformat()}
        if is_demo:
            user["is_demo"] = True
        await conn.execute(
            "insert into public.users (doc) select $1::jsonb where not exists "
            "(select 1 from public.users where user_id = $2)", json.dumps(user), user_id)
        await conn.execute("insert into public.user_sessions (doc) values ($1::jsonb)", json.dumps({
            "session_token": token, "user_id": user_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "expires_at": expires_at.isoformat()}))
        return token
    finally:
        await conn.close()


def mint_session(user_id: str, *, expired: bool = False, is_demo: bool = False) -> str:
    if not DB_URL:
        pytest.skip("SUPABASE_DB_URL not set — needed to mint test sessions")
    delta = timedelta(days=-1) if expired else timedelta(days=7)
    return _run(_mint_async(user_id, datetime.now(timezone.utc) + delta, is_demo))


def db_fetch(sql: str, *args):
    import asyncpg

    async def go():
        conn = await asyncpg.connect(DB_URL)
        try:
            return await conn.fetch(sql, *args)
        finally:
            await conn.close()
    return _run(go())


# ---------------------------------------------------------------------------
# Legacy suite compatibility: the pre-auth tests identify a driver only by
# profile_id. Transparently sign them in as that profile (user_id == pid) by
# injecting a Bearer header, unless the request sets its own Authorization or
# the opt-out header `X-Test-No-Auto-Auth`. Requests without a profile_id
# (PUT/DELETE by id) reuse the last profile seen in this worker.
# ---------------------------------------------------------------------------
_tokens: dict = {}
_last_pid = {"pid": None}
_orig_request = requests.Session.request


def _pid_of(url, params, data, json_body):
    if isinstance(params, dict) and params.get("profile_id"):
        return params["profile_id"]
    q = parse_qs(urlparse(url).query).get("profile_id")
    if q:
        return q[0]
    body = json_body
    if body is None and isinstance(data, (str, bytes)):
        try:
            body = json.loads(data)
        except Exception:
            body = None
    if isinstance(body, dict) and isinstance(body.get("profile_id"), str):
        return body["profile_id"]
    return None


def _auto_auth_request(self, method, url, params=None, data=None, headers=None, json=None, **kw):
    headers = dict(headers or {})
    if headers.pop("X-Test-No-Auto-Auth", None) is None and "/api/" in url \
            and "Authorization" not in headers and "Authorization" not in self.headers:
        pid = _pid_of(url, params, data, json)
        if pid:
            _last_pid["pid"] = pid
        pid = pid or _last_pid["pid"]
        if pid and DB_URL:
            if pid not in _tokens:
                _tokens[pid] = mint_session(pid)
            headers["Authorization"] = f"Bearer {_tokens[pid]}"
    return _orig_request(self, method, url, params=params, data=data, headers=headers, json=json, **kw)


requests.Session.request = _auto_auth_request


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture
def profile_id():
    """Unique profile per test-run so we don't collide with other data."""
    return f"TEST_{uuid.uuid4().hex[:12]}"
