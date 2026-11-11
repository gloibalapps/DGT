"""14-day free trial + server-side subscription enforcement.

Trial state lives on the `users` row (doc jsonb, exposed as indexed generated
columns by supabase/migrations/0002_trial_subscription.sql):

  trial_started_at  ISO-8601 UTC. Set at account creation (Google/Apple/demo).
  trial_ends_at     trial_started_at + TRIAL_DAYS (default 14) days, exactly.
  sub_status        trial | active | grace | expired | demo   (last computed)
  sub_expires_at    entitlement expiry from RevenueCat (null = lifetime / none)
  sub_checked_at    when the RevenueCat entitlement was last verified
  sub_product       product id of the active entitlement (informational)

Entitlement source of truth is RevenueCat (GET /v1/subscribers/{app_user_id},
app_user_id == users.user_id), cached on the row for RC_CACHE_TTL_SECONDS and
also updated by the RevenueCat webhook. Because RevenueCat entitlements are
store-agnostic, App Store, Google Play and (later) RevenueCat Web Billing /
Stripe purchases all unify into the same `pro` entitlement check.

All configuration is read from the environment on each call so it can be
toggled without code changes (and tests can monkeypatch it):
  PAYWALL_ENFORCED           "true" to return 402 when expired (default false: ships dark)
  TRIAL_DAYS                 default 14
  TRIAL_EXISTING_USERS_START ISO date/datetime; trial start for accounts created
                             before this feature (no trial_started_at). Start =
                             max(created_at, this). Unset = the moment the server
                             first sees the account (i.e. cutover day).
  DEMO_ENTITLED              "true" to skip the paywall for demo accounts (default false).
                             Demo accounts still cannot call /api/ask or /api/receipts/scan.
  DEMO_ENABLED               "true" to allow POST /api/auth/demo (default false)
  DEMO_REVIEW_SECRET         required X-Demo-Review-Secret when DEMO_ENABLED is true. SECRET.
  REVENUECAT_SECRET_API_KEY  RevenueCat secret (sk_...) key. SECRET.
  RC_ENTITLEMENT_ID          default "pro"
  RC_CACHE_TTL_SECONDS       default 300
  RC_GRACE_HOURS             if RevenueCat is unreachable, keep a previously
                             active user active for this long (default 24)
  REVENUECAT_WEBHOOK_AUTH    exact Authorization header value RevenueCat sends
  REVENUECAT_API_BASE        default https://api.revenuecat.com (tests)
"""
from __future__ import annotations

import logging
import math
import os
import hmac
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Body, Depends, Header, HTTPException

logger = logging.getLogger("gigtax.subscription")

# Tests swap this for httpx.MockTransport to fake RevenueCat.
rc_transport: Optional[httpx.AsyncBaseTransport] = None

PAYWALL_CODE = "subscription_required"


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def enforced() -> bool:
    return _env_bool("PAYWALL_ENFORCED", False)


def trial_days() -> int:
    return int(os.environ.get("TRIAL_DAYS", "14"))


def entitlement_id() -> str:
    return os.environ.get("RC_ENTITLEMENT_ID", "pro")


def demo_entitled() -> bool:
    """Demo accounts skip the paywall only when this is explicitly turned on."""
    return _env_bool("DEMO_ENTITLED", False)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _dt(v) -> Optional[datetime]:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000, tz=timezone.utc)
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
    if isinstance(v, datetime) and v.tzinfo is None:
        v = v.replace(tzinfo=timezone.utc)
    return v if isinstance(v, datetime) else None


def new_user_fields(now: Optional[datetime] = None) -> dict:
    """Fields to merge into a brand-new users doc at signup."""
    now = now or _now()
    return {"trial_started_at": now.isoformat(),
            "trial_ends_at": (now + timedelta(days=trial_days())).isoformat(),
            "sub_status": "trial"}


def existing_user_start(user: dict, now: Optional[datetime] = None) -> datetime:
    now = now or _now()
    created = _dt(user.get("created_at")) or now
    cut = _dt(os.environ.get("TRIAL_EXISTING_USERS_START"))
    if cut is None:
        return now
    return max(created, cut)


def build(db, require_owner):
    """Returns (router, require_entitled, ensure_trial, compute)."""

    async def ensure_trial(user: dict, now: Optional[datetime] = None) -> dict:
        """Backfill trial fields for accounts that pre-date this feature."""
        if user.get("trial_started_at"):
            return user
        start = existing_user_start(user, now)
        fields = {"trial_started_at": start.isoformat(),
                  "trial_ends_at": (start + timedelta(days=trial_days())).isoformat()}
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": fields})
        return {**user, **fields}

    async def fetch_rc(app_user_id: str) -> Optional[dict]:
        """Ask RevenueCat. Returns {'active','expires_at','product'} or None when
        RevenueCat isn't configured / unreachable (caller decides)."""
        key = os.environ.get("REVENUECAT_SECRET_API_KEY")
        if not key:
            return None
        base = os.environ.get("REVENUECAT_API_BASE", "https://api.revenuecat.com").rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=8, transport=rc_transport) as hc:
                r = await hc.get(f"{base}/v1/subscribers/{app_user_id}",
                                 headers={"Authorization": f"Bearer {key}"})
            if r.status_code == 404:
                return {"active": False, "expires_at": None, "product": None}
            r.raise_for_status()
            ent = ((r.json().get("subscriber") or {}).get("entitlements") or {}).get(entitlement_id())
        except Exception as e:
            logger.warning("RevenueCat lookup failed for %s: %s", app_user_id, e)
            return None
        if not ent:
            return {"active": False, "expires_at": None, "product": None}
        exp = _dt(ent.get("expires_date"))
        return {"active": exp is None or exp > _now(),
                "expires_at": exp.isoformat() if exp else None,
                "product": ent.get("product_identifier")}

    async def compute(user: dict, *, force: bool = False) -> dict:
        now = _now()
        uid = user["user_id"]
        if user.get("is_demo") and demo_entitled():
            return {"state": "active", "entitlement": "demo", "trial_ends_at": user.get("trial_ends_at"),
                    "days_left": None, "is_demo": True}
        user = await ensure_trial(user, now)
        ends = _dt(user["trial_ends_at"])
        days_left = max(0, math.ceil((ends - now).total_seconds() / 86400))
        # 1) Paid entitlement (cached, TTL) wins over trial so a trial user who
        #    buys shows as active.
        checked = _dt(user.get("sub_checked_at"))
        ttl = int(os.environ.get("RC_CACHE_TTL_SECONDS", "300"))
        cached_active = user.get("sub_status") in ("active", "grace") and (
            _dt(user.get("sub_expires_at")) is None or _dt(user.get("sub_expires_at")) > now)
        in_trial = now < ends
        fresh = checked is not None and (now - checked).total_seconds() < ttl
        ent_active, state, upd = False, None, {}
        if fresh and not force:
            ent_active = cached_active
            if ent_active:
                state = user.get("sub_status")
        elif in_trial and not force and not os.environ.get("REVENUECAT_SECRET_API_KEY"):
            pass  # nothing to verify against
        else:
            rc = await fetch_rc(uid)
            if rc is not None:
                ent_active = rc["active"]
                state = "active" if ent_active else None
                upd = {"sub_checked_at": now.isoformat(), "sub_expires_at": rc["expires_at"],
                       "sub_product": rc["product"]}
                user.update(upd)
            else:
                grace_h = int(os.environ.get("RC_GRACE_HOURS", "24"))
                if cached_active and checked and (now - checked) < timedelta(hours=grace_h):
                    ent_active, state = True, "grace"
        if not state:
            state = "active" if ent_active else ("trial" if in_trial else "expired")
        if state != user.get("sub_status") or upd:
            await db.users.update_one({"user_id": uid}, {"$set": {"sub_status": state, **upd}})
        return {"state": state, "entitlement": entitlement_id() if ent_active else None,
                "trial_started_at": user["trial_started_at"], "trial_ends_at": user["trial_ends_at"],
                "days_left": days_left if state == "trial" else (0 if state == "expired" else None),
                "expires_at": user.get("sub_expires_at") if ent_active else None,
                "is_demo": bool(user.get("is_demo"))}

    async def require_entitled(owner=Depends(require_owner)):
        """Write / premium routes. 402 + code `subscription_required` once the
        trial is over and there is no active entitlement (when PAYWALL_ENFORCED)."""
        if not enforced():
            return owner
        st = await compute(owner.user)
        if st["state"] == "expired":
            raise HTTPException(status_code=402, detail={
                "code": PAYWALL_CODE,
                "message": "Your 14-day free trial has ended. Subscribe to keep adding records. "
                           "You can still view, export and back up your data, or delete your account.",
                "trial_ends_at": st["trial_ends_at"]})
        return owner

    router = APIRouter(prefix="/api/subscription")

    @router.get("/status")
    async def status(refresh: bool = False, owner=Depends(require_owner)):
        st = await compute(owner.user, force=refresh)
        return {**st, "enforced": enforced(), "trial_days": trial_days()}

    @router.post("/webhook")
    async def webhook(payload: dict = Body(...), authorization: Optional[str] = Header(None)):
        expected = os.environ.get("REVENUECAT_WEBHOOK_AUTH")
        if not expected:
            raise HTTPException(503, "Webhook not configured")
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(401, "Bad webhook auth")
        ev = (payload or {}).get("event") or {}
        ids = {ev.get("app_user_id"), ev.get("original_app_user_id"), *(ev.get("aliases") or [])} - {None}
        typ = ev.get("type")
        ents = ev.get("entitlement_ids") or ([ev["entitlement_id"]] if ev.get("entitlement_id") else [])
        exp = _dt(ev.get("expiration_at_ms"))
        upd: dict
        if typ in ("INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE",
                   "NON_RENEWING_PURCHASE", "SUBSCRIPTION_EXTENDED", "TEMPORARY_ENTITLEMENT_GRANT") \
                and entitlement_id() in ents:
            active = exp is None or exp > _now()
            upd = {"sub_status": "active" if active else "expired",
                   "sub_expires_at": exp.isoformat() if exp else None,
                   "sub_product": ev.get("product_id"), "sub_checked_at": _now().isoformat()}
        elif typ == "EXPIRATION" and (not ents or entitlement_id() in ents):
            upd = {"sub_status": "expired", "sub_expires_at": exp.isoformat() if exp else None,
                   "sub_checked_at": _now().isoformat()}
        else:
            # CANCELLATION (still active until expiry), BILLING_ISSUE, TRANSFER, TEST...:
            # drop the cache so the next request re-verifies with RevenueCat.
            upd = {"sub_checked_at": None}
        n = 0
        for uid in ids:
            n += (await db.users.update_many({"user_id": uid}, {"$set": upd})).modified_count
        return {"ok": True, "updated": n, "type": typ}

    return router, require_entitled, ensure_trial, compute
