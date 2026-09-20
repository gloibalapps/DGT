import os
import io
import csv
import uuid
import time
import json
import logging
import httpx
from pathlib import Path
from datetime import datetime, timezone, date, timedelta
from typing import List, Optional, Literal, Annotated, Dict

from fastapi import FastAPI, APIRouter, HTTPException, Query, Header, Body, Request
from fastapi.responses import StreamingResponse, RedirectResponse, HTMLResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, BeforeValidator, ConfigDict, model_validator

import tax as taxlib

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

EMERGENT_LLM_KEY = os.environ.get('EMERGENT_LLM_KEY')

app = FastAPI(title="GigTax API")
api_router = APIRouter(prefix="/api")


@app.get("/health")
async def health():
    # Liveness/readiness probe for the K8s deployment. Kept dependency-free so a
    # slow/unavailable DB never trips the health check.
    return {"status": "ok"}


# Marketing landing page (served here so it's reachable via the /api ingress).
_SITE_HTML_PATH = Path(__file__).resolve().parent.parent / "website" / "index.html"


@api_router.get("/site")
async def marketing_site():
    try:
        html = _SITE_HTML_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise HTTPException(404, "Site not found")
    return HTMLResponse(html)


@api_router.get("/privacy")
async def privacy_page():
    try:
        return HTMLResponse((_SITE_HTML_PATH.parent / "privacy.html").read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise HTTPException(404, "Not found")


@api_router.get("/terms")
async def terms_page():
    try:
        return HTMLResponse((_SITE_HTML_PATH.parent / "terms.html").read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise HTTPException(404, "Not found")


class WaitlistEntry(BaseModel):
    email: str


@api_router.post("/waitlist")
async def join_waitlist(entry: WaitlistEntry):
    email = (entry.email or "").strip().lower()
    if "@" not in email or "." not in email:
        raise HTTPException(400, "Invalid email")
    await db.waitlist.update_one(
        {"email": email},
        {"$setOnInsert": {"email": email, "created_at": now_iso()}},
        upsert=True,
    )
    return {"ok": True}

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("gigtax")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Authentication — Emergent-managed Google sign-in (cross-device sync)
# ---------------------------------------------------------------------------
EMERGENT_SESSION_URL = "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data"


@app.on_event("startup")
async def _startup_indexes():
    try:
        await db.users.create_index("email", unique=True)
        await db.users.create_index("user_id", unique=True)
        await db.user_sessions.create_index("session_token", unique=True)
        await db.user_sessions.create_index("user_id")
        await db.user_sessions.create_index("expires_at", expireAfterSeconds=0)
        await db.oauth_states.create_index("created_at", expireAfterSeconds=600)
    except Exception as e:  # pragma: no cover
        logger.warning("index setup: %s", e)


async def current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(" ", 1)[1].strip()
    sess = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if not sess:
        raise HTTPException(status_code=401, detail="Invalid session")
    exp = sess.get("expires_at")
    if isinstance(exp, datetime):
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp < datetime.now(timezone.utc):
            raise HTTPException(status_code=401, detail="Session expired")
    user = await db.users.find_one({"user_id": sess["user_id"]}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


@api_router.post("/auth/session")
async def auth_session(payload: dict = Body(...)):
    session_id = (payload or {}).get("session_id")
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")
    async with httpx.AsyncClient(timeout=15) as hc:
        r = await hc.get(EMERGENT_SESSION_URL, headers={"X-Session-ID": session_id})
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid or expired session_id")
    data = r.json()
    email = data.get("email")
    if not email:
        raise HTTPException(status_code=401, detail="No email returned")
    existing = await db.users.find_one({"email": email}, {"_id": 0})
    if existing:
        user_id = existing["user_id"]
        await db.users.update_one({"user_id": user_id},
                                  {"$set": {"name": data.get("name"), "picture": data.get("picture")}})
    else:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        await db.users.insert_one({
            "user_id": user_id, "email": email, "name": data.get("name"),
            "picture": data.get("picture"), "created_at": now_iso(),
        })
    session_token = data.get("session_token") or uuid.uuid4().hex
    await db.user_sessions.insert_one({
        "session_token": session_token, "user_id": user_id,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
    })
    return {"session_token": session_token,
            "user": {"user_id": user_id, "email": email,
                     "name": data.get("name"), "picture": data.get("picture")}}


@api_router.get("/auth/me")
async def auth_me(authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    return {"user": user}


@api_router.post("/auth/logout")
async def auth_logout(authorization: Optional[str] = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ", 1)[1].strip()
        await db.user_sessions.delete_one({"session_token": token})
    return {"ok": True}


@api_router.post("/auth/claim")
async def auth_claim(payload: dict = Body(...), authorization: Optional[str] = Header(None)):
    """Move a device's local (anonymous) data onto the signed-in account, once,
    only if that account has no data yet — so first-time login keeps your work."""
    user = await current_user(authorization)
    src = (payload or {}).get("from_profile_id")
    uid = user["user_id"]
    if not src or src == uid:
        return {"claimed": False}
    has_data = False
    for coll in (db.profiles, db.vehicles, db.trips, db.income, db.expenses):
        if await coll.find_one({"profile_id": uid}):
            has_data = True
            break
    if has_data:
        return {"claimed": False}
    moved = 0
    for coll in (db.profiles, db.vehicles, db.trips, db.income, db.expenses):
        res = await coll.update_many({"profile_id": src}, {"$set": {"profile_id": uid}})
        moved += res.modified_count
    return {"claimed": moved > 0, "moved": moved}


@api_router.delete("/account")
async def delete_account(profile_id: str = Query(...), authorization: Optional[str] = Header(None)):
    """Permanently delete a driver's account and ALL their data.
    Required by the Apple App Store & Google Play for apps with sign-in."""
    deleted: dict = {}
    for name, coll in (
        ("profiles", db.profiles), ("vehicles", db.vehicles), ("trips", db.trips),
        ("income", db.income), ("expenses", db.expenses), ("shifts", db.shifts),
        ("drive_tokens", db.drive_tokens),
    ):
        res = await coll.delete_many({"profile_id": profile_id})
        deleted[name] = res.deleted_count
    # If signed in, also remove the user record + all of their sessions.
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ", 1)[1].strip()
        sess = await db.user_sessions.find_one({"session_token": token})
        if sess:
            uid = sess["user_id"]
            await db.user_sessions.delete_many({"user_id": uid})
            await db.users.delete_one({"user_id": uid})
            deleted["user"] = 1
    return {"ok": True, "deleted": deleted}


# ---------------------------------------------------------------------------
# Own-branded Google OAuth (drivergigtax.com) — backend-mediated code flow.
# The Google consent shows the developer's own app name, not Emergent.
# ---------------------------------------------------------------------------
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"


def _public_base(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto", "https")
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    return f"{proto}://{host}"


async def _login_google_user(email: str, name, picture) -> str:
    existing = await db.users.find_one({"email": email}, {"_id": 0})
    if existing:
        user_id = existing["user_id"]
        await db.users.update_one({"user_id": user_id}, {"$set": {"name": name, "picture": picture}})
    else:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        await db.users.insert_one({
            "user_id": user_id, "email": email, "name": name,
            "picture": picture, "created_at": now_iso(),
        })
    session_token = uuid.uuid4().hex
    await db.user_sessions.insert_one({
        "session_token": session_token, "user_id": user_id,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
    })
    return session_token


@api_router.get("/auth/google/start")
async def google_start(request: Request, app_redirect: str = Query(...),
                       backup: int = Query(0), profile_id: Optional[str] = Query(None)):
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=500, detail="Google login not configured")
    from urllib.parse import urlencode
    state = uuid.uuid4().hex
    await db.oauth_states.insert_one({
        "state": state, "app_redirect": app_redirect,
        "backup": bool(backup), "profile_id": profile_id,
        "created_at": datetime.now(timezone.utc),
    })
    redirect_uri = f"{_public_base(request)}/api/auth/google/callback"
    p = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    }
    if backup:
        # Add Drive scope + request a refresh token for unattended backups.
        p["scope"] = "openid email profile https://www.googleapis.com/auth/drive.file"
        p["access_type"] = "offline"
        p["include_granted_scopes"] = "true"
        p["prompt"] = "consent"  # force refresh_token on re-consent
    return RedirectResponse(f"{GOOGLE_AUTH_URL}?{urlencode(p)}")


@api_router.get("/auth/google/callback")
async def google_callback(request: Request, code: Optional[str] = Query(None),
                          state: Optional[str] = Query(None), error: Optional[str] = Query(None)):
    st = await db.oauth_states.find_one({"state": state}) if state else None
    app_redirect = (st or {}).get("app_redirect") or ""
    if state:
        await db.oauth_states.delete_one({"state": state})

    def bounce(fragment: str):
        # Web (http/https): browsers preserve the fragment, a normal 302 works.
        if app_redirect.startswith("http://") or app_redirect.startswith("https://"):
            return RedirectResponse(f"{app_redirect}#{fragment}")
        # Native custom scheme (e.g. frontend://): Android DROPS the URL fragment
        # when it hands a custom-scheme intent to the app, so a `#token` payload is
        # lost and the user lands back on the sign-in screen. Pass it as a QUERY
        # param instead (reliably preserved); the app parses both `?` and `#`.
        sep = "&" if "?" in app_redirect else "?"
        target = f"{app_redirect}{sep}{fragment}"
        import json as _json
        t = _json.dumps(target)
        html = f"""<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url={target}">
<script>window.location.replace({t});setTimeout(function(){{window.location.href={t};}},400);</script>
<style>body{{font-family:-apple-system,Roboto,Helvetica,sans-serif;background:#0A1420;color:#fff;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center;padding:24px}}
a{{color:#0A1420;background:#4FC3F7;font-size:17px;font-weight:600;text-decoration:none;padding:14px 28px;
border-radius:12px;margin-top:24px;display:inline-block}}p{{opacity:.7;font-size:15px}}</style>
</head><body><div><p>Signing you in…</p>
<a href="{target}">Return to Drivers Gig Tax</a></div></body></html>"""
        return HTMLResponse(html)

    if error or not code or not st:
        return bounce("auth_error=1")
    redirect_uri = f"{_public_base(request)}/api/auth/google/callback"
    async with httpx.AsyncClient(timeout=15) as hc:
        tok = await hc.post(GOOGLE_TOKEN_URL, data={
            "code": code, "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET, "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        })
        if tok.status_code != 200:
            return bounce("auth_error=token")
        tokjson = tok.json()
        access_token = tokjson.get("access_token")
        ui = await hc.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
        if ui.status_code != 200:
            return bounce("auth_error=userinfo")
        info = ui.json()
    email = info.get("email")
    if not email:
        return bounce("auth_error=noemail")

    # Drive-backup connect: persist the encrypted refresh/access token for this
    # profile so the backend can upload backups on the user's behalf later.
    if st.get("backup") and st.get("profile_id"):
        await _save_drive_tokens(st["profile_id"], tokjson, email)
        return bounce("drive_connected=1")

    session_token = await _login_google_user(email, info.get("name"), info.get("picture"))
    return bounce(f"session_token={session_token}")



PyObjectId = Annotated[str, BeforeValidator(str)]


# ---------------------------------------------------------------------------
# Google Drive backup (per-profile, user's own Drive)
# ---------------------------------------------------------------------------
from cryptography.fernet import Fernet as _Fernet
_DRIVE_KEY = os.environ.get("DRIVE_ENCRYPTION_KEY", "")
_fernet = _Fernet(_DRIVE_KEY.encode()) if _DRIVE_KEY else None
DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
DRIVE_API_URL = "https://www.googleapis.com/drive/v3/files"


def _enc(v: str) -> str: return _fernet.encrypt(v.encode()).decode()
def _dec(v: str) -> str: return _fernet.decrypt(v.encode()).decode()


async def _save_drive_tokens(profile_id: str, tokjson: dict, email: str):
    if not _fernet:
        return
    upd = {
        "profile_id": profile_id, "email": email,
        "access_token": _enc(tokjson.get("access_token", "")),
        "access_expires_at": time.time() + int(tokjson.get("expires_in", 3600)),
        "scopes": (tokjson.get("scope") or "").split(),
        "needs_reauth": False, "updated_at": now_iso(),
    }
    # Google only returns refresh_token on first consent — never overwrite with null.
    if tokjson.get("refresh_token"):
        upd["refresh_token"] = _enc(tokjson["refresh_token"])
    await db.drive_tokens.update_one({"profile_id": profile_id}, {"$set": upd}, upsert=True)


async def _drive_access_token(profile_id: str) -> str:
    row = await db.drive_tokens.find_one({"profile_id": profile_id})
    if not row or not row.get("refresh_token"):
        raise HTTPException(409, "Google Drive not connected")
    if row.get("access_expires_at", 0) > time.time() + 60:
        return _dec(row["access_token"])
    async with httpx.AsyncClient(timeout=20) as hc:
        r = await hc.post(GOOGLE_TOKEN_URL, data={
            "client_id": GOOGLE_CLIENT_ID, "client_secret": GOOGLE_CLIENT_SECRET,
            "refresh_token": _dec(row["refresh_token"]), "grant_type": "refresh_token",
        })
    if r.status_code != 200:
        if r.status_code == 400 and r.json().get("error") == "invalid_grant":
            await db.drive_tokens.update_one({"profile_id": profile_id}, {"$set": {"needs_reauth": True}})
        raise HTTPException(502, "Could not refresh Google token")
    new = r.json()
    await db.drive_tokens.update_one({"profile_id": profile_id}, {"$set": {
        "access_token": _enc(new["access_token"]),
        "access_expires_at": time.time() + int(new.get("expires_in", 3600)),
        "updated_at": now_iso(), "needs_reauth": False,
    }})
    return new["access_token"]


async def _drive_folder(token: str, name: str, parent: Optional[str] = None) -> str:
    parent_clause = f"'{parent}' in parents" if parent else "'root' in parents"
    q = (f"name = '{name}' and mimeType = 'application/vnd.google-apps.folder' "
         f"and {parent_clause} and trashed = false")
    async with httpx.AsyncClient(timeout=20) as hc:
        r = await hc.get(DRIVE_API_URL, params={"q": q, "spaces": "drive", "pageSize": 1, "fields": "files(id)"},
                         headers={"Authorization": f"Bearer {token}"})
        r.raise_for_status()
        files = r.json().get("files", [])
        if files:
            return files[0]["id"]
        meta = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
        if parent:
            meta["parents"] = [parent]
        r2 = await hc.post(DRIVE_API_URL, params={"fields": "id"},
                           headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                           json=meta)
        r2.raise_for_status()
        return r2.json()["id"]


async def _drive_find(token: str, folder: str, name: str) -> Optional[str]:
    safe = name.replace("'", "\\'")
    q = f"name = '{safe}' and '{folder}' in parents and trashed = false"
    async with httpx.AsyncClient(timeout=20) as hc:
        r = await hc.get(DRIVE_API_URL, params={"q": q, "spaces": "drive", "pageSize": 1, "fields": "files(id)"},
                         headers={"Authorization": f"Bearer {token}"})
        r.raise_for_status()
        f = r.json().get("files", [])
        return f[0]["id"] if f else None


async def _drive_upload(token: str, content: bytes, filename: str, mime: str,
                        parent: str, file_id: Optional[str] = None) -> dict:
    boundary = "===" + uuid.uuid4().hex
    meta: dict = {"name": filename}
    if parent and not file_id:
        meta["parents"] = [parent]
    body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
            + json.dumps(meta) + f"\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n").encode() \
        + content + f"\r\n--{boundary}--\r\n".encode()
    url = DRIVE_UPLOAD_URL if not file_id else f"{DRIVE_UPLOAD_URL}/{file_id}"
    method = "POST" if not file_id else "PATCH"
    async with httpx.AsyncClient(timeout=60) as hc:
        r = await hc.request(method, url, params={"uploadType": "multipart", "fields": "id,name"},
                             headers={"Authorization": f"Bearer {token}",
                                      "Content-Type": f'multipart/related; boundary="{boundary}"'},
                             content=body)
    r.raise_for_status()
    return r.json()


def _decode_b64_image(s: str) -> bytes:
    import base64 as _b64
    if s[:5] == "data:" and "," in s[:64]:
        s = s.split(",", 1)[1]
    return _b64.b64decode(s)


def _build_backup_csv(income, expenses, trips) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Type", "Date", "Amount / Distance", "Category / Platform", "Merchant / Note", "Vehicle"])
    for i in income:
        w.writerow(["Income", i.get("date"), i.get("amount"), i.get("platform", ""), i.get("note", ""), i.get("vehicle_id", "")])
    for e in expenses:
        w.writerow(["Expense", e.get("date"), e.get("amount"), e.get("category", ""), e.get("merchant") or e.get("note", ""), e.get("vehicle_id", "")])
    for t in trips:
        w.writerow(["Trip", t.get("date"), t.get("distance_km"), t.get("type", ""), t.get("purpose", ""), t.get("vehicle_id", "")])
    return buf.getvalue().encode()


async def backup_profile(profile_id: str) -> dict:
    token = await _drive_access_token(profile_id)
    root = await _drive_folder(token, "GigTax Backups")
    income = [clean(x) for x in await db.income.find({"profile_id": profile_id}).to_list(10000)]
    expenses = [clean(x) for x in await db.expenses.find({"profile_id": profile_id}).to_list(10000)]
    trips = [clean(x) for x in await db.trips.find({"profile_id": profile_id}).to_list(10000)]
    # data CSV (overwrite in place)
    csv_bytes = _build_backup_csv(income, expenses, trips)
    csv_id = await _drive_find(token, root, "gigtax-data.csv")
    await _drive_upload(token, csv_bytes, "gigtax-data.csv", "text/csv", root, csv_id)
    # receipt images organised into month subfolders
    receipts = 0
    month_folders: dict = {}
    for e in expenses:
        img = e.get("receipt_image")
        if not img:
            continue
        month = (e.get("date") or "")[:7] or "undated"
        if month not in month_folders:
            month_folders[month] = await _drive_folder(token, month, root)
        try:
            data = _decode_b64_image(img)
        except Exception:
            continue
        fname = f"receipt-{e.get('date', '')}-{str(e.get('id', ''))[:8]}.jpg"
        fid = await _drive_find(token, month_folders[month], fname)
        await _drive_upload(token, data, fname, "image/jpeg", month_folders[month], fid)
        receipts += 1
    ts = now_iso()
    await db.drive_tokens.update_one({"profile_id": profile_id},
                                     {"$set": {"last_backup_at": ts, "last_backup_count": receipts}})
    return {"backed_up_at": ts, "receipts": receipts,
            "records": len(income) + len(expenses) + len(trips)}


@api_router.get("/backups/status")
async def backup_status(profile_id: str = Query(...)):
    row = await db.drive_tokens.find_one({"profile_id": profile_id})
    if not row:
        return {"connected": False}
    return {
        "connected": bool(row.get("refresh_token")) and not row.get("needs_reauth"),
        "needs_reauth": bool(row.get("needs_reauth")),
        "email": row.get("email"),
        "last_backup_at": row.get("last_backup_at"),
        "last_backup_count": row.get("last_backup_count"),
    }


@api_router.post("/backups/google-drive")
async def run_backup(profile_id: str = Query(...)):
    return await backup_profile(profile_id)


@api_router.post("/backups/disconnect")
async def disconnect_backup(profile_id: str = Query(...)):
    await db.drive_tokens.delete_one({"profile_id": profile_id})
    return {"connected": False}


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class RecurringPayment(BaseModel):
    amount: float
    frequency: Literal["weekly", "fortnightly", "monthly"] = "weekly"
    anchor_type: Literal["acquisition", "gigstart"] = "gigstart"
    anchor_date: str  # YYYY-MM-DD


class Vehicle(BaseModel):
    """Standalone vehicle document — each car keeps its own logbook & deduction."""
    model_config = ConfigDict(extra="allow")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    profile_id: str
    name: Optional[str] = None
    registration: Optional[str] = None
    make_model: Optional[str] = None
    year: Optional[int] = None
    purchase_price: Optional[float] = None
    fuel_type: Optional[Literal["petrol", "diesel", "hybrid", "electric", "lpg"]] = None
    business_use_start: Optional[str] = None
    ownership: Literal["own", "loan", "lease", "rental", "rent_to_buy"] = "own"
    recurring_payment: Optional[RecurringPayment] = None
    opening_odometer: Optional[float] = None
    opening_odometer_date: Optional[str] = None
    closing_odometer: Optional[float] = None
    closing_odometer_date: Optional[str] = None
    gps_calibration_pct: Optional[float] = 100.0  # scales GPS-tracked distance to match this car's odometer
    is_active: bool = False
    created_at: str = Field(default_factory=now_iso)


class Profile(BaseModel):
    model_config = ConfigDict(extra="allow")
    profile_id: str
    country: str = "AU"
    region: Optional[str] = None
    driver_name: Optional[str] = None
    work_type: Literal["passengers", "delivery", "both"] = "delivery"
    platforms: List[str] = Field(default_factory=list)
    vehicle_ownership: Literal["own", "loan", "lease", "rental", "rent_to_buy"] = "own"
    acquisition_date: Optional[str] = None
    recurring_payment: Optional[RecurringPayment] = None
    vehicle: Optional[dict] = None  # legacy single-vehicle blob (migration source)
    # tax setup
    legal_name: Optional[str] = None
    accounting_method: Literal["cash", "accrual"] = "cash"
    tax_id_on_file: bool = False
    registration_status: Optional[Literal["registered", "not_registered", "unknown"]] = None
    registration_date: Optional[str] = None
    reporting_frequency: Optional[str] = None
    business_use_fallback: float = 100.0
    weekly_goal: Optional[float] = None
    week_start: int = 0  # 0=Mon … 6=Sun; first day of the driver's week
    tax_set_aside: Optional[float] = None
    vehicle_method: Optional[str] = None  # US/UK only
    vehicle_first_business_year: Optional[str] = None
    theme: Literal["dark", "light"] = "dark"
    onboarded: bool = False
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class Trip(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    profile_id: str
    date: str
    distance_km: float
    duration_min: Optional[float] = None
    type: Literal["business", "personal", "mixed"] = "business"
    business_pct: Optional[float] = None  # for mixed trips (0-100)
    purpose: Optional[str] = None         # collect/deliver/between_jobs/other_business/home/shopping/appointment/personal_other
    vehicle_id: Optional[str] = None
    from_label: Optional[str] = None
    to_label: Optional[str] = None
    odo_start: Optional[float] = None
    odo_end: Optional[float] = None
    note: Optional[str] = None
    source: Literal["manual", "gps"] = "manual"
    created_at: str = Field(default_factory=now_iso)


class Income(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    profile_id: str
    date: str
    amount: float
    platform: Optional[str] = None
    tax_treatment: Literal["inclusive", "free", "exempt", "out_of_scope"] = "inclusive"
    note: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)


class Expense(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    profile_id: str
    date: str
    amount: float
    category: Literal["fuel", "tolls", "vehicle", "phone", "other"] = "other"
    merchant: Optional[str] = None
    vehicle_id: Optional[str] = None
    tax_treatment: Literal["inclusive", "free", "exempt", "out_of_scope"] = "inclusive"
    note: Optional[str] = None
    liters: Optional[float] = None  # fuel volume (litres), for fuel receipts
    receipt_image: Optional[str] = None  # base64
    created_at: str = Field(default_factory=now_iso)


class Shift(BaseModel):
    """A manually logged online/working session — powers earnings-per-hour."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    profile_id: str
    date: str
    hours: float
    active_hours: Optional[float] = None            # time actually on a job (making money)
    active_by_platform: Optional[Dict[str, float]] = None  # active hrs split per app (multi-apping)
    start_time: Optional[str] = None  # "HH:MM"
    end_time: Optional[str] = None    # "HH:MM"
    platform: Optional[str] = None
    vehicle_id: Optional[str] = None
    note: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)

    @model_validator(mode="after")
    def _sum_active(self):
        # When per-app active hours are provided, the total is their sum.
        if self.active_by_platform:
            cleaned = {k: round(float(v), 2) for k, v in self.active_by_platform.items() if (v or 0) > 0}
            object.__setattr__(self, "active_by_platform", cleaned or None)
            object.__setattr__(self, "active_hours", round(sum(cleaned.values()), 2) if cleaned else None)
        return self


def clean(doc: dict) -> dict:
    doc = dict(doc)
    doc.pop("_id", None)
    return doc


# ---------------------------------------------------------------------------
# Vehicles — each car keeps its own logbook & deduction
# ---------------------------------------------------------------------------
def _default_vehicle_from_profile(profile: dict) -> dict:
    v = profile.get("vehicle") or {}
    return Vehicle(
        profile_id=profile["profile_id"],
        name=v.get("make_model") or "My Vehicle",
        registration=v.get("registration"),
        make_model=v.get("make_model"),
        year=v.get("year"),
        purchase_price=v.get("purchase_price"),
        fuel_type=v.get("fuel_type"),
        business_use_start=v.get("business_use_start"),
        ownership=profile.get("vehicle_ownership", "own"),
        recurring_payment=profile.get("recurring_payment"),
        opening_odometer=v.get("opening_odometer"),
        opening_odometer_date=v.get("opening_odometer_date"),
        closing_odometer=v.get("closing_odometer"),
        closing_odometer_date=v.get("closing_odometer_date"),
        is_active=True,
    ).model_dump()


async def ensure_vehicles(profile_id: str) -> List[dict]:
    """Return the profile's vehicles, migrating legacy single-vehicle data and
    back-filling vehicle_id on existing trips/expenses the first time."""
    docs = await db.vehicles.find({"profile_id": profile_id}).sort("created_at", 1).to_list(100)
    if not docs:
        profile = await db.profiles.find_one({"profile_id": profile_id}) \
            or Profile(profile_id=profile_id).model_dump()
        default = _default_vehicle_from_profile(clean(profile))
        await db.vehicles.insert_one(dict(default))
        # attach any pre-existing untagged trips/expenses to this first car
        await db.trips.update_many({"profile_id": profile_id, "vehicle_id": None},
                                   {"$set": {"vehicle_id": default["id"]}})
        await db.expenses.update_many({"profile_id": profile_id, "vehicle_id": None},
                                      {"$set": {"vehicle_id": default["id"]}})
        docs = [default]
    docs = [clean(d) for d in docs]
    if not any(d.get("is_active") for d in docs):
        await db.vehicles.update_one({"id": docs[0]["id"]}, {"$set": {"is_active": True}})
        docs[0]["is_active"] = True
    return docs


async def _set_active(profile_id: str, vehicle_id: str):
    await db.vehicles.update_many({"profile_id": profile_id}, {"$set": {"is_active": False}})
    await db.vehicles.update_one({"id": vehicle_id, "profile_id": profile_id},
                                 {"$set": {"is_active": True}})


@api_router.get("/vehicles")
async def list_vehicles(profile_id: str = Query(...)):
    return await ensure_vehicles(profile_id)


@api_router.post("/vehicles")
async def add_vehicle(payload: dict):
    existing = await ensure_vehicles(payload["profile_id"])
    make_first_active = payload.get("is_active") or len(existing) == 0
    obj = Vehicle(**payload)
    obj.is_active = bool(make_first_active)
    await db.vehicles.insert_one(obj.model_dump())
    if obj.is_active:
        await _set_active(obj.profile_id, obj.id)
    return await ensure_vehicles(obj.profile_id)


@api_router.put("/vehicles/{vehicle_id}")
async def update_vehicle(vehicle_id: str, payload: dict):
    existing = await db.vehicles.find_one({"id": vehicle_id})
    if not existing:
        raise HTTPException(404, "vehicle not found")
    base = clean(existing)
    base.update(payload)
    obj = Vehicle(**base)
    await db.vehicles.update_one({"id": vehicle_id}, {"$set": obj.model_dump()})
    if obj.is_active:
        await _set_active(obj.profile_id, vehicle_id)
    return await ensure_vehicles(obj.profile_id)


@api_router.post("/vehicles/{vehicle_id}/activate")
async def activate_vehicle(vehicle_id: str, profile_id: str = Query(...)):
    await _set_active(profile_id, vehicle_id)
    return await ensure_vehicles(profile_id)


@api_router.delete("/vehicles/{vehicle_id}")
async def delete_vehicle(vehicle_id: str, profile_id: str = Query(...)):
    all_v = await ensure_vehicles(profile_id)
    if len(all_v) <= 1:
        raise HTTPException(400, "You must keep at least one vehicle")
    was_active = next((v for v in all_v if v["id"] == vehicle_id), {}).get("is_active")
    await db.vehicles.delete_one({"id": vehicle_id, "profile_id": profile_id})
    remaining = await db.vehicles.find({"profile_id": profile_id}).sort("created_at", 1).to_list(100)
    if was_active and remaining:
        await _set_active(profile_id, clean(remaining[0])["id"])
    return await ensure_vehicles(profile_id)


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------
@api_router.get("/profile")
async def get_profile(profile_id: str = Query(...)):
    doc = await db.profiles.find_one({"profile_id": profile_id})
    if not doc:
        prof = Profile(profile_id=profile_id)
        await db.profiles.insert_one(prof.model_dump())
        return clean(prof.model_dump())
    return clean(doc)


@api_router.put("/profile")
async def save_profile(payload: dict):
    profile_id = payload.get("profile_id")
    if not profile_id:
        raise HTTPException(400, "profile_id required")
    existing = await db.profiles.find_one({"profile_id": profile_id})
    base = clean(existing) if existing else Profile(profile_id=profile_id).model_dump()
    base.update(payload)
    base["updated_at"] = now_iso()
    prof = Profile(**base)
    data = prof.model_dump()
    await db.profiles.update_one({"profile_id": profile_id}, {"$set": data}, upsert=True)
    return clean(data)


# ---------------------------------------------------------------------------
# Generic CRUD helpers
# ---------------------------------------------------------------------------
async def _list(coll, profile_id):
    docs = await db[coll].find({"profile_id": profile_id}).sort("date", -1).to_list(2000)
    return [clean(d) for d in docs]


# Trips
@api_router.get("/trips")
async def list_trips(profile_id: str = Query(...)):
    return await _list("trips", profile_id)


@api_router.post("/trips")
async def add_trip(payload: dict):
    obj = Trip(**payload)
    await db.trips.insert_one(obj.model_dump())
    return clean(obj.model_dump())


@api_router.put("/trips/{item_id}")
async def update_trip(item_id: str, payload: dict):
    existing = await db.trips.find_one({"id": item_id})
    if not existing:
        raise HTTPException(404, "trip not found")
    base = clean(existing); base.update(payload)
    obj = Trip(**base)
    await db.trips.update_one({"id": item_id}, {"$set": obj.model_dump()})
    return clean(obj.model_dump())


@api_router.delete("/trips/{item_id}")
async def delete_trip(item_id: str):
    await db.trips.delete_one({"id": item_id})
    return {"ok": True}


# Income
@api_router.get("/income")
async def list_income(profile_id: str = Query(...)):
    return await _list("income", profile_id)


@api_router.post("/income")
async def add_income(payload: dict):
    obj = Income(**payload)
    await db.income.insert_one(obj.model_dump())
    return clean(obj.model_dump())


@api_router.put("/income/{item_id}")
async def update_income(item_id: str, payload: dict):
    existing = await db.income.find_one({"id": item_id})
    if not existing:
        raise HTTPException(404, "income not found")
    base = clean(existing); base.update(payload)
    obj = Income(**base)
    await db.income.update_one({"id": item_id}, {"$set": obj.model_dump()})
    return clean(obj.model_dump())


@api_router.delete("/income/{item_id}")
async def delete_income(item_id: str):
    await db.income.delete_one({"id": item_id})
    return {"ok": True}


# Expenses
@api_router.get("/expenses")
async def list_expenses(profile_id: str = Query(...)):
    return await _list("expenses", profile_id)


@api_router.post("/expenses")
async def add_expense(payload: dict):
    obj = Expense(**payload)
    await db.expenses.insert_one(obj.model_dump())
    return clean(obj.model_dump())


@api_router.put("/expenses/{item_id}")
async def update_expense(item_id: str, payload: dict):
    existing = await db.expenses.find_one({"id": item_id})
    if not existing:
        raise HTTPException(404, "expense not found")
    base = clean(existing); base.update(payload)
    obj = Expense(**base)
    await db.expenses.update_one({"id": item_id}, {"$set": obj.model_dump()})
    return clean(obj.model_dump())


@api_router.delete("/expenses/{item_id}")
async def delete_expense(item_id: str):
    await db.expenses.delete_one({"id": item_id})
    return {"ok": True}


# Shifts — manually logged online hours
@api_router.get("/shifts")
async def list_shifts(profile_id: str = Query(...)):
    return await _list("shifts", profile_id)


@api_router.post("/shifts")
async def add_shift(payload: dict):
    obj = Shift(**payload)
    await db.shifts.insert_one(obj.model_dump())
    return clean(obj.model_dump())


@api_router.put("/shifts/{item_id}")
async def update_shift(item_id: str, payload: dict):
    existing = await db.shifts.find_one({"id": item_id})
    if not existing:
        raise HTTPException(404, "shift not found")
    base = clean(existing); base.update(payload)
    obj = Shift(**base)
    await db.shifts.update_one({"id": item_id}, {"$set": obj.model_dump()})
    return clean(obj.model_dump())


@api_router.delete("/shifts/{item_id}")
async def delete_shift(item_id: str):
    await db.shifts.delete_one({"id": item_id})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Reports / dashboard
# ---------------------------------------------------------------------------
async def _load_all(profile_id):
    profile = await db.profiles.find_one({"profile_id": profile_id})
    if not profile:
        profile = Profile(profile_id=profile_id).model_dump()
    vehicles = await ensure_vehicles(profile_id)
    trips = await db.trips.find({"profile_id": profile_id}).to_list(5000)
    income = await db.income.find({"profile_id": profile_id}).to_list(5000)
    expenses = await db.expenses.find({"profile_id": profile_id}).to_list(5000)
    return (clean(profile), [clean(t) for t in trips],
            [clean(i) for i in income], [clean(e) for e in expenses], vehicles)


@api_router.get("/reports")
async def reports(profile_id: str = Query(...),
                  period: str = Query("quarter"),
                  ref_date: Optional[str] = Query(None)):
    profile, trips, income, expenses, vehicles = await _load_all(profile_id)
    ref = taxlib.parse_date(ref_date) if ref_date else date.today()
    return taxlib.compute_report(profile, trips, income, expenses, period, ref, vehicles)


@api_router.get("/dashboard")
async def dashboard(profile_id: str = Query(...), ref_date: Optional[str] = Query(None)):
    profile, trips, income, expenses, vehicles = await _load_all(profile_id)
    ref = taxlib.parse_date(ref_date) if ref_date else date.today()
    return taxlib.dashboard(profile, trips, income, expenses, ref, vehicles)


@api_router.get("/performance")
async def performance(profile_id: str = Query(...), ref_date: Optional[str] = Query(None)):
    profile, trips, income, expenses, vehicles = await _load_all(profile_id)
    shifts = [clean(s) for s in await db.shifts.find({"profile_id": profile_id}).to_list(5000)]
    ref = taxlib.parse_date(ref_date) if ref_date else date.today()
    return taxlib.performance(profile, trips, income, expenses, ref, shifts=shifts)


@api_router.get("/insights")
async def insights(profile_id: str = Query(...), ref_date: Optional[str] = Query(None)):
    profile, trips, income, expenses, vehicles = await _load_all(profile_id)
    shifts = [clean(s) for s in await db.shifts.find({"profile_id": profile_id}).to_list(5000)]
    ref = taxlib.parse_date(ref_date) if ref_date else date.today()
    return taxlib.insights(profile, income, expenses, shifts, ref)


@api_router.get("/money")
async def money(profile_id: str = Query(...), period: str = Query("week"),
                ref_date: Optional[str] = Query(None)):
    profile, trips, income, expenses, vehicles = await _load_all(profile_id)
    shifts = [clean(s) for s in await db.shifts.find({"profile_id": profile_id}).to_list(5000)]
    ref = taxlib.parse_date(ref_date) if ref_date else date.today()
    return taxlib.money_overview(profile, trips, income, expenses, shifts, ref,
                                 period=period, vehicles=vehicles)


@api_router.get("/tax-mileage")
async def tax_mileage(profile_id: str = Query(...), ref_date: Optional[str] = Query(None),
                      vehicle_id: Optional[str] = Query(None)):
    """Full Tax Mileage engine: today, FY summary, ATO logbook, method
    comparison (logbook vs cents-per-km) and odometer reconciliation."""
    profile, trips, income, expenses, vehicles = await _load_all(profile_id)
    ref = taxlib.parse_date(ref_date) if ref_date else date.today()
    return taxlib.tax_mileage(profile, trips, income, expenses, ref,
                              vehicles=vehicles, vehicle_id=vehicle_id)


@api_router.get("/export")
async def export_csv(profile_id: str = Query(...),
                     period: str = Query("quarter"),
                     ref_date: Optional[str] = Query(None)):
    profile, trips, income, expenses, vehicles = await _load_all(profile_id)
    ref = taxlib.parse_date(ref_date) if ref_date else date.today()
    rep = taxlib.compute_report(profile, trips, income, expenses, period, ref, vehicles)
    start = taxlib.parse_date(rep["period_start"])
    end = taxlib.parse_date(rep["period_end"])

    def in_p(row):
        d = taxlib.parse_date(row["date"])
        return start <= d < end

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["GigTax export", rep["period_label"]])
    w.writerow([])
    w.writerow(["Type", "Date", "Description", "Category/Platform",
                "Amount (AUD)", "Tax treatment"])
    for i in income:
        if in_p(i):
            w.writerow(["Income", i["date"], i.get("note") or "", i.get("platform") or "",
                        f"{i['amount']:.2f}", i.get("tax_treatment", "inclusive")])
    for e in expenses:
        if in_p(e):
            w.writerow(["Expense", e["date"], e.get("merchant") or "", e.get("category", ""),
                        f"-{e['amount']:.2f}", e.get("tax_treatment", "inclusive")])
    for t in trips:
        if in_p(t):
            w.writerow(["Trip", t["date"], t.get("note") or "",
                        t.get("type", "business"), f"{t['distance_km']} km", ""])
    # calculated recurring payment as its own line (exists in no logged entry)
    rp = rep["vehicle_deduction"]["recurring_payment_gross"]
    if rp:
        w.writerow(["Recurring vehicle payment (calculated)", rep["period_label"],
                    "Elapsed cycles × amount", profile.get("vehicle_ownership", ""),
                    f"-{rp:.2f}", "inclusive"])
    w.writerow([])
    w.writerow(["--- Summary ---"])
    w.writerow(["Total income", f"{rep['total_income']:.2f}"])
    w.writerow(["Total deductions", f"{rep['total_deductions']:.2f}"])
    w.writerow(["Net profit", f"{rep['net_profit']:.2f}"])
    w.writerow(["Business-use %", rep["business_use_pct"]])
    if rep["show_bas"]:
        w.writerow(["G1 (total sales incl GST)", f"{rep['bas']['G1']:.2f}"])
        w.writerow(["1A (GST on sales)", f"{rep['bas']['1A']:.2f}"])
        w.writerow(["1B (GST on purchases)", f"{rep['bas']['1B']:.2f}"])
        w.writerow(["Net GST (1A-1B)", f"{rep['bas']['net_gst']:.2f}"])

    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=gigtax_{period}.csv"})


@api_router.get("/export-mileage")
async def export_mileage_csv(profile_id: str = Query(...),
                             ref_date: Optional[str] = Query(None),
                             vehicle_id: Optional[str] = Query(None)):
    profile, trips, income, expenses, vehicles = await _load_all(profile_id)
    ref = taxlib.parse_date(ref_date) if ref_date else date.today()
    tm = taxlib.tax_mileage(profile, trips, income, expenses, ref,
                            vehicles=vehicles, vehicle_id=vehicle_id)
    v = tm["vehicle"] or {}
    fy = tm["financial_year"]
    lb = tm["logbook"]
    mc = tm["method_comparison"]
    odo = tm["odometer"]

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["GigTax — Motor Vehicle Report", f"FY {fy['label']}"])
    w.writerow([])
    w.writerow(["Vehicle", v.get("make_model") or ""])
    w.writerow(["Registration", v.get("registration") or ""])
    w.writerow(["Year", v.get("year") or ""])
    w.writerow(["Fuel type", v.get("fuel_type") or ""])
    w.writerow(["Opening odometer", odo.get("opening") or ""])
    w.writerow(["Closing odometer", odo.get("closing") or ""])
    w.writerow(["Odometer kilometres", odo.get("odometer_km") or ""])
    w.writerow(["GPS kilometres", odo.get("gps_km")])
    w.writerow([])
    w.writerow(["Total kilometres (FY)", fy["total_km"]])
    w.writerow(["Business kilometres (FY)", fy["business_km"]])
    w.writerow(["Private kilometres (FY)", fy["private_km"]])
    w.writerow(["Business-use %", fy["business_pct"]])
    w.writerow([])
    if lb.get("available"):
        w.writerow(["--- ATO Logbook (12-week) ---"])
        w.writerow(["Period", lb["period_label"]])
        w.writerow(["Business %", lb["business_pct"]])
        w.writerow(["Journeys", lb["journey_count"]])
        w.writerow([])
        w.writerow(["Date", "From", "To", "Distance (km)", "Business (km)", "Type", "Purpose"])
        for j in lb.get("journeys", []):
            w.writerow([j["date_label"], j.get("from_label") or "", j.get("to_label") or "",
                        j["distance_km"], j["business_km"], j["type"], j.get("purpose") or ""])
        w.writerow([])
    w.writerow(["--- Method comparison ---"])
    w.writerow(["Logbook deduction", f"{mc['logbook']['deduction']:.2f}",
                f"({mc['logbook']['business_pct']}% of ${mc['logbook']['eligible_expenses']:.2f})"])
    w.writerow(["Cents per km deduction", f"{mc['cents_per_km']['deduction']:.2f}",
                f"({mc['cents_per_km']['rate_cents']}c x {mc['cents_per_km']['claimable_km']:.0f} km)"])
    w.writerow(["Recommended method", mc["recommend_label"], f"better by ${mc['difference']:.2f}"])
    w.writerow([])
    w.writerow([mc["disclaimer"]])

    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=gigtax_motor_vehicle.csv"})


# ---------------------------------------------------------------------------
# AI receipt scanning
# ---------------------------------------------------------------------------
class ScanRequest(BaseModel):
    image_base64: str


@api_router.post("/receipts/scan")
async def scan_receipt(req: ScanRequest):
    from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent
    import json as _json

    system = (
        "You are a receipt data extractor for an Australian gig-driver tax app. "
        "Extract fields from the receipt image and respond with ONLY a compact JSON "
        "object, no markdown, no prose. Schema: "
        '{"amount": number (total incl GST, no currency symbol), '
        '"date": "YYYY-MM-DD" (best guess, today if unclear), '
        '"merchant": string, '
        '"liters": number|null (fuel volume in litres for FUEL receipts, e.g. 42.15; null for non-fuel), '
        '"category": one of "fuel","tolls","vehicle","phone","other"}. '
        "Map petrol/servo/gas -> fuel; car service/tyres/repairs/parts -> vehicle; "
        "toll/etoll/linkt -> tolls; telco/mobile/data -> phone; everything else -> other."
    )
    chat = LlmChat(api_key=EMERGENT_LLM_KEY,
                   session_id=f"receipt-{uuid.uuid4()}",
                   system_message=system).with_model("openai", "gpt-4o")
    img = req.image_base64
    if "," in img and img.strip().startswith("data:"):
        img = img.split(",", 1)[1]
    msg = UserMessage(text="Extract the receipt fields as JSON.",
                      file_contents=[ImageContent(image_base64=img)])
    try:
        resp = await chat.send_message(msg)
    except Exception as e:
        logger.exception("receipt scan failed")
        raise HTTPException(502, f"Receipt scan failed: {e}")

    text = resp if isinstance(resp, str) else str(resp)
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    try:
        s = text.index("{"); en = text.rindex("}") + 1
        data = _json.loads(text[s:en])
    except Exception:
        data = {}
    cat = data.get("category", "other")
    if cat not in ("fuel", "tolls", "vehicle", "phone", "other"):
        cat = "other"
    liters = data.get("liters")
    try:
        liters = round(float(liters), 2) if liters not in (None, "") and cat == "fuel" else None
    except (TypeError, ValueError):
        liters = None
    return {
        "amount": data.get("amount"),
        "date": data.get("date") or date.today().isoformat(),
        "merchant": data.get("merchant") or "",
        "category": cat,
        "liters": liters,
    }


# ---------------------------------------------------------------------------
# AI tax assistant — grounded ONLY in verified ATO/IRS knowledge base
# ---------------------------------------------------------------------------
class AskRequest(BaseModel):
    question: str
    country: Optional[str] = "AU"
    history: Optional[List[dict]] = None  # [{role: "user"|"assistant", text: str}]


@api_router.post("/ask")
async def ask_assistant(req: AskRequest):
    from emergentintegrations.llm.chat import LlmChat, UserMessage
    from tax_kb import kb_for

    country = (req.country or "AU").upper()
    authority = "the ATO (Australian Taxation Office)" if country != "US" else "the IRS (Internal Revenue Service)"
    kb = kb_for(country)

    system = (
        "You are the GigTax Assistant, a tax helper for gig-economy rideshare and "
        f"delivery drivers in {'Australia' if country != 'US' else 'the United States'}. "
        f"You answer questions using ONLY the VERIFIED KNOWLEDGE BASE below, which is based on {authority} guidance.\n\n"
        "STRICT RULES:\n"
        "1. Use ONLY the facts in the VERIFIED KNOWLEDGE BASE. Never use outside knowledge, never guess, never browse the web.\n"
        "2. If the answer is not covered by the knowledge base, say clearly: \"That's not in my verified "
        f"{authority} sources — please check with a registered tax professional.\" Do not attempt an answer from general knowledge.\n"
        "3. When you state a rule or rate, mention the section it came from (e.g. \"cents-per-km method\") and the year for any rate, and note that rates are updated each year.\n"
        "4. Focus on what IS and what is NOT claimable/deductible. Be concise, plain-English, and practical.\n"
        "5. Never invent dollar figures for the driver's personal return. This is general guidance, not personal tax advice; remind them to confirm with a registered tax agent before lodging/filing.\n"
        "6. Keep answers short (a few sentences or a short bullet list). Do not output JSON or markdown headers.\n\n"
        "=== VERIFIED KNOWLEDGE BASE (your ONLY source of truth) ===\n"
        f"{kb}\n"
        "=== END KNOWLEDGE BASE ==="
    )

    # Light multi-turn context: prepend a short transcript of recent messages.
    transcript = ""
    for m in (req.history or [])[-6:]:
        role = "Driver" if m.get("role") == "user" else "Assistant"
        txt = str(m.get("text", "")).strip()
        if txt:
            transcript += f"{role}: {txt}\n"

    user_text = req.question.strip()
    if transcript:
        user_text = (
            "Conversation so far (for context only):\n" + transcript +
            "\nNow answer the driver's latest question:\n" + req.question.strip()
        )

    chat = LlmChat(api_key=EMERGENT_LLM_KEY,
                   session_id=f"ask-{uuid.uuid4()}",
                   system_message=system).with_model("anthropic", "claude-sonnet-4-6")
    try:
        resp = await chat.send_message(UserMessage(text=user_text))
    except Exception as e:
        logger.exception("ask assistant failed")
        raise HTTPException(502, f"Assistant failed: {e}")

    answer = resp if isinstance(resp, str) else str(resp)
    return {"answer": answer.strip(), "country": country}


@api_router.get("/")
async def root():
    return {"message": "GigTax API", "market": "AU"}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
