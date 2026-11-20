"""Duplicate flagging for receipt expenses.

Pure functions: no database and no paid vision call. The scan route must call
``plan_paid_scan`` and return when ``skip`` is true, before it contacts the
vision model. Saving is never rejected; callers attach ``match_expense`` to
the response.

Thresholds (tuned on fictional synthetic images, not customer receipts):

* ``PHASH_STRONG_MAX = 8`` bits out of 64. A difference hash (dHash) of a
  modest crop sat at 12, only 4 bits from a visually different picture, so a
  dHash-only cutoff of 8 missed real rescans and a cutoff of 12 was too close
  to unrelated images. A 64-bit average hash (aHash) of that same crop was 6,
  while unrelated pictures stayed at 16 or more. A strong perceptual match is
  therefore either hash within 8, compared across four rotations.
* ``LIKELY_MINUTES = 5`` inclusive.
* ``FUEL_DISTINCT_MINUTES = 10``. Same-day fuel fills are different purchases
  when the times differ by *more than* 10 minutes.
"""
from __future__ import annotations

import base64
import hashlib
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Optional

PHASH_BITS = 64
PHASH_STRONG_MAX = 8
LIKELY_MINUTES = 5
FUEL_DISTINCT_MINUTES = 10

_HEX64 = re.compile(r"^[0-9a-f]{16}$")
_MERCHANT_STOP = {"PTY", "LTD", "LIMITED", "THE", "AND", "CO"}

_REASON_RANK = {
    "exact_image": 70,
    "perceptual": 60,
    "receipt_abn": 50,
    "receipt_merchant": 40,
    "amount_date_merchant_time": 30,
    "amount_date_merchant_card": 20,
    "amount_merchant_day_off": 10,
}

_TRACKED = (
    "image_sha256", "image_dhash", "image_dhash_rots", "image_ahash", "image_ahash_rots",
    "client_dhash", "client_dhash_rots", "client_ahash", "client_ahash_rots",
    "amount_cents", "norm_date", "norm_time", "norm_abn", "norm_receipt_number",
    "merchant_key", "norm_card_last4", "norm_litres", "norm_pump",
)


def decode_image_b64(value: str) -> bytes:
    if not value:
        raise ValueError("empty image")
    s = value.strip()
    if s[:5].lower() == "data:" and "," in s[:128]:
        s = s.split(",", 1)[1]
    return base64.b64decode(s, validate=False)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hamming_hex(a: str, b: str) -> int:
    if not a or not b or len(a) != len(b):
        return PHASH_BITS
    try:
        return (int(a, 16) ^ int(b, 16)).bit_count()
    except ValueError:
        return PHASH_BITS


def _usable_hash(value: Optional[str]) -> bool:
    if not value or not _HEX64.match(value):
        return False
    bits = int(value, 16).bit_count()
    # Flat frames (blank page, solid splash) collide with each other.
    return 8 <= bits <= 56


def luma_from_rgb(rgb: bytes, width: int, height: int) -> list:
    if width < 1 or height < 1 or len(rgb) < width * height * 3:
        raise ValueError("rgb buffer is short")
    out = [0] * (width * height)
    i = 0
    for p in range(width * height):
        r, g, b = rgb[i], rgb[i + 1], rgb[i + 2]
        out[p] = (r * 299 + g * 587 + b * 114) // 1000
        i += 3
    return out


def luma_from_rgba(rgba: bytes, width: int, height: int) -> list:
    if width < 1 or height < 1 or len(rgba) < width * height * 4:
        raise ValueError("rgba buffer is short")
    out = [0] * (width * height)
    i = 0
    for p in range(width * height):
        r, g, b = rgba[i], rgba[i + 1], rgba[i + 2]
        out[p] = (r * 299 + g * 587 + b * 114) // 1000
        i += 4
    return out


def resize_box(luma: list, width: int, height: int, tw: int, th: int) -> list:
    """Integer box filter. Python and the phone use the same arithmetic."""
    out = [0] * (tw * th)
    n = 0
    for y in range(th):
        y0 = y * height // th
        y1 = max(y0 + 1, (y + 1) * height // th)
        for x in range(tw):
            x0 = x * width // tw
            x1 = max(x0 + 1, (x + 1) * width // tw)
            acc = 0
            count = 0
            for yy in range(y0, y1):
                row = yy * width
                for xx in range(x0, x1):
                    acc += luma[row + xx]
                    count += 1
            out[n] = acc // count
            n += 1
    return out


def rot90(luma: list, width: int, height: int):
    nw = height
    out = [0] * (width * height)
    for y in range(height):
        for x in range(width):
            nx = height - 1 - y
            ny = x
            out[ny * nw + nx] = luma[y * width + x]
    return out, nw, width


def dhash_luma(luma: list, width: int, height: int) -> str:
    small = resize_box(luma, width, height, 9, 8)
    bits = 0
    for row in range(8):
        base = row * 9
        for col in range(8):
            bits = (bits << 1) | (1 if small[base + col] > small[base + col + 1] else 0)
    return f"{bits:016x}"


def ahash_luma(luma: list, width: int, height: int) -> str:
    small = resize_box(luma, width, height, 8, 8)
    avg = sum(small) // 64
    bits = 0
    for p in small:
        bits = (bits << 1) | (1 if p > avg else 0)
    return f"{bits:016x}"


def hash_luma(luma: list, width: int, height: int) -> dict:
    d_rots = []
    a_rots = []
    cur, w, h = luma, width, height
    for _ in range(4):
        d_rots.append(dhash_luma(cur, w, h))
        a_rots.append(ahash_luma(cur, w, h))
        cur, w, h = rot90(cur, w, h)
    return {
        "image_dhash": d_rots[0],
        "image_dhash_rots": d_rots,
        "image_ahash": a_rots[0],
        "image_ahash_rots": a_rots,
    }


def hash_image_bytes(data: bytes) -> Optional[dict]:
    try:
        from PIL import Image, ImageOps
        import io
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
        im = im.convert("RGB")
        w, h = im.size
        if w < 8 or h < 8:
            return None
        return hash_luma(luma_from_rgb(im.tobytes(), w, h), w, h)
    except Exception:
        return None


def thumb_base64(image_b64: Optional[str], edge: int = 160) -> Optional[str]:
    if not image_b64:
        return None
    try:
        from PIL import Image, ImageOps
        import io
        raw = decode_image_b64(image_b64)
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
        im.thumbnail((edge, edge))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=40)
        return base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None


def _hex64(value) -> Optional[str]:
    if not isinstance(value, str):
        return None
    s = value.strip().lower()
    return s if _HEX64.match(s) else None


def _hex_list(value) -> Optional[list]:
    if not isinstance(value, (list, tuple)):
        return None
    out = []
    for item in value:
        h = _hex64(item)
        if h:
            out.append(h)
    return out or None


def amount_cents(value) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        d = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    if not d.is_finite():
        return None
    d = d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return int(d * 100)


def norm_date(value) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if not m:
        au = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", s)
        if not au:
            return None
        s = f"{au.group(3)}-{au.group(2)}-{au.group(1)}"
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    try:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        date(y, mo, d)
    except (TypeError, ValueError):
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


def parse_time_mins(value) -> Optional[int]:
    if value is None:
        return None
    t = str(value).strip().upper().replace(".", ":")
    m = re.match(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$", t)
    if not m:
        return None
    hour, minute = int(m.group(1)), int(m.group(2))
    if minute > 59:
        return None
    ap = m.group(4)
    if ap:
        if hour < 1 or hour > 12:
            return None
        if ap == "AM":
            hour = 0 if hour == 12 else hour
        else:
            hour = 12 if hour == 12 else hour + 12
    elif hour > 23:
        return None
    return hour * 60 + minute


def mins_to_hhmm(mins: Optional[int]) -> Optional[str]:
    if mins is None:
        return None
    return f"{mins // 60:02d}:{mins % 60:02d}"


def norm_abn(value) -> Optional[str]:
    if value is None:
        return None
    digits = re.sub(r"\D", "", str(value))
    return digits if len(digits) == 11 else None


def norm_receipt(value) -> Optional[str]:
    if value is None:
        return None
    alnum = re.sub(r"[^A-Za-z0-9]", "", str(value)).upper()
    return alnum or None


def merchant_key(value) -> Optional[str]:
    if value is None:
        return None
    tokens = re.sub(r"[^A-Za-z0-9]+", " ", str(value)).upper().split()
    tokens = [t for t in tokens if t not in _MERCHANT_STOP]
    key = "".join(tokens)
    return key or None


def norm_card(value) -> Optional[str]:
    if value is None:
        return None
    digits = re.sub(r"\D", "", str(value))
    if len(digits) < 4:
        return None
    return digits[-4:]


def norm_litres(value) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        d = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    if not d.is_finite() or d < 0:
        return None
    return float(d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def norm_pump(value) -> Optional[str]:
    if value is None:
        return None
    digits = re.sub(r"\D", "", str(value))
    if digits:
        return digits.lstrip("0") or "0"
    alnum = re.sub(r"[^A-Za-z0-9]", "", str(value)).upper()
    return alnum or None


def is_refund(doc: dict, cents: Optional[int] = None) -> bool:
    if doc.get("refund") is True:
        return True
    if cents is None:
        cents = doc.get("amount_cents")
        if cents is None:
            cents = amount_cents(doc.get("amount"))
    if isinstance(cents, int) and cents < 0:
        return True
    blob = " ".join(str(doc.get(k) or "") for k in ("merchant", "note", "category"))
    return re.search(r"\brefunds?\b", blob, re.I) is not None


def normalise_fields(doc: dict) -> dict:
    cents = amount_cents(doc.get("amount"))
    mins = parse_time_mins(doc.get("txn_time") or doc.get("time") or doc.get("norm_time"))
    litres = norm_litres(doc.get("liters") if doc.get("liters") is not None else doc.get("litres"))
    if litres is None:
        litres = norm_litres(doc.get("norm_litres"))
    return {
        "amount_cents": cents,
        "norm_date": norm_date(doc.get("date") or doc.get("norm_date")),
        "norm_time": mins_to_hhmm(mins),
        "norm_abn": norm_abn(doc.get("abn") or doc.get("norm_abn")),
        "norm_receipt_number": norm_receipt(doc.get("receipt_number") or doc.get("norm_receipt_number")),
        "merchant_key": merchant_key(doc.get("merchant") or doc.get("merchant_key")),
        "norm_card_last4": norm_card(doc.get("card_last4") or doc.get("norm_card_last4")),
        "norm_litres": litres,
        "norm_pump": norm_pump(doc.get("pump") if doc.get("pump") is not None else doc.get("norm_pump")),
        "_time_mins": mins,
    }


def _copy_client_hashes(src: dict, out: dict, server: Optional[dict]) -> None:
    """Keep the phone's hash beside the server hash. They can differ when the
    JPEG decoders differ, and a later phone check compares like with like."""
    mapping = (
        ("client_dhash", "image_dhash"),
        ("client_ahash", "image_ahash"),
        ("client_dhash_rots", "image_dhash_rots"),
        ("client_ahash_rots", "image_ahash_rots"),
    )
    for dest, src_key in mapping:
        existing = _hex64(src.get(dest)) if not dest.endswith("rots") else _hex_list(src.get(dest))
        if existing:
            out[dest] = existing
            continue
        incoming = _hex64(src.get(src_key)) if not src_key.endswith("rots") else _hex_list(src.get(src_key))
        if not incoming or not server:
            continue
        server_val = server.get(src_key)
        if incoming != server_val:
            out[dest] = incoming


_SERVER_HASH_KEYS = (
    "image_sha256", "image_dhash", "image_dhash_rots", "image_ahash", "image_ahash_rots",
)
_CLIENT_HASH_KEYS = (
    "client_dhash", "client_dhash_rots", "client_ahash", "client_ahash_rots",
)


def enrich_expense(doc: dict, keep_hashes_without_image: bool = True) -> dict:
    """Fill hashes and normalised fields. Safe to run twice: the second result
    compares equal on every tracked field.

    ``keep_hashes_without_image`` lets a check echo hashes it already computed
    when the photo itself is not sent again. A save passes False so deleting
    the photo clears the hashes too.
    """
    out = dict(doc)
    raw = None
    image = out.get("receipt_image")
    if isinstance(image, str) and image:
        try:
            raw = decode_image_b64(image)
        except Exception:
            raw = None
            out["image_unreadable"] = True
    server = None
    if raw is not None:
        out["image_sha256"] = sha256_hex(raw)
        out.pop("image_unreadable", None)
        server = hash_image_bytes(raw)
        if server:
            out.update(server)
    elif keep_hashes_without_image and _hex64(out.get("image_sha256")):
        out["image_sha256"] = _hex64(out.get("image_sha256"))
    elif not keep_hashes_without_image:
        for key in _SERVER_HASH_KEYS + _CLIENT_HASH_KEYS:
            out[key] = None
    _copy_client_hashes(doc, out, server)
    # A caller that already received server hashes (the review screen echoing a
    # check) and has no image bytes keeps those hashes.
    if raw is None and keep_hashes_without_image:
        for key in ("image_dhash", "image_ahash"):
            h = _hex64(out.get(key))
            if h:
                out[key] = h
        for key in ("image_dhash_rots", "image_ahash_rots"):
            lst = _hex_list(out.get(key))
            if lst:
                out[key] = lst
    norms = normalise_fields(out)
    mins = norms.pop("_time_mins")
    out.update(norms)
    out["_time_mins"] = mins
    return out


def _family(doc: dict, key: str, rots_key: str) -> list:
    found = []
    primary = doc.get(key)
    if _usable_hash(primary):
        found.append(primary)
    for item in doc.get(rots_key) or []:
        if _usable_hash(item) and item not in found:
            found.append(item)
    return found


def perceptual_distance(a: dict, b: dict) -> Optional[int]:
    best = None
    for key, rots in (
        ("image_dhash", "image_dhash_rots"),
        ("image_ahash", "image_ahash_rots"),
        ("client_dhash", "client_dhash_rots"),
        ("client_ahash", "client_ahash_rots"),
    ):
        left, right = _family(a, key, rots), _family(b, key, rots)
        if not left or not right:
            continue
        dist = min(hamming_hex(x, y) for x in left for y in right)
        best = dist if best is None else min(best, dist)
    return best


def _minutes_apart(a: dict, b: dict) -> Optional[int]:
    ta, tb = a.get("_time_mins"), b.get("_time_mins")
    if ta is None or tb is None:
        return None
    diff = abs(int(ta) - int(tb))
    return min(diff, 1440 - diff)


def _same_amount(a: dict, b: dict) -> bool:
    ca, cb = a.get("amount_cents"), b.get("amount_cents")
    return isinstance(ca, int) and ca > 0 and ca == cb


def _days_apart(a: dict, b: dict) -> Optional[int]:
    da, db = a.get("norm_date"), b.get("norm_date")
    if not da or not db:
        return None
    try:
        return abs((date.fromisoformat(da) - date.fromisoformat(db)).days)
    except ValueError:
        return None


def fuel_is_distinct(a: dict, b: dict) -> bool:
    """Same-day fuel fills are different purchases when a distinguishing
    signal disagrees. Missing signals do not count as a disagreement."""
    if a.get("category") != "fuel" and b.get("category") != "fuel":
        return False
    if not a.get("norm_date") or a.get("norm_date") != b.get("norm_date"):
        return False
    apart = _minutes_apart(a, b)
    if apart is not None and apart > FUEL_DISTINCT_MINUTES:
        return True
    if a.get("norm_pump") and b.get("norm_pump") and a["norm_pump"] != b["norm_pump"]:
        return True
    la, lb = a.get("norm_litres"), b.get("norm_litres")
    if la is not None and lb is not None and abs(float(la) - float(lb)) > 0.009:
        return True
    ra, rb = a.get("norm_receipt_number"), b.get("norm_receipt_number")
    if ra and rb and ra != rb:
        return True
    return False


def _has_match_key(doc: dict) -> bool:
    if doc.get("image_sha256") or _family(doc, "image_dhash", "image_dhash_rots") or _family(doc, "image_ahash", "image_ahash_rots"):
        return True
    if doc.get("client_dhash") or doc.get("client_ahash"):
        return True
    if doc.get("norm_receipt_number") and (doc.get("norm_abn") or doc.get("merchant_key")):
        return True
    if _same_amount(doc, doc) and doc.get("merchant_key") and doc.get("norm_date"):
        return True
    return False


def _kept(cand: dict, other: dict, keep_with) -> bool:
    oid = other.get("id")
    cid = cand.get("id")
    if oid and str(oid) in {str(x) for x in (keep_with or []) if x}:
        return True
    if not oid or not cid:
        return False
    if str(oid) in {str(x) for x in (cand.get("dupe_keep_with") or [])}:
        return True
    if str(cid) in {str(x) for x in (other.get("dupe_keep_with") or [])}:
        return True
    return False


def _hit(reason: str, other: dict, distance: Optional[int] = None) -> dict:
    return {
        "rank": _REASON_RANK[reason],
        "level": "strong" if _REASON_RANK[reason] >= 40 else "likely" if _REASON_RANK[reason] >= 20 else "possible",
        "reason": reason,
        "distance": distance,
        "match": {
            "id": other.get("id"),
            "merchant": other.get("merchant") or "",
            "date": other.get("norm_date") or (other.get("date") or "")[:10],
            "txn_time": other.get("norm_time") or "",
            "amount": other.get("amount"),
            "category": other.get("category"),
            "liters": other.get("liters"),
            "gst": other.get("gst"),
            "receipt_number": other.get("receipt_number"),
            "abn": other.get("abn"),
            "card_last4": other.get("card_last4"),
            "pump": other.get("pump"),
            "has_receipt": bool(other.get("receipt_image") or other.get("has_receipt")),
        },
    }


def _compare(a: dict, b: dict) -> Optional[dict]:
    if a.get("image_sha256") and a["image_sha256"] == b.get("image_sha256"):
        return _hit("exact_image", b, 0)
    dist = perceptual_distance(a, b)
    if dist is not None and dist <= PHASH_STRONG_MAX:
        return _hit("perceptual", b, dist)
    ra, rb = a.get("norm_receipt_number"), b.get("norm_receipt_number")
    if ra and rb and ra == rb:
        if a.get("norm_abn") and a["norm_abn"] == b.get("norm_abn"):
            return _hit("receipt_abn", b)
        if a.get("merchant_key") and a["merchant_key"] == b.get("merchant_key"):
            return _hit("receipt_merchant", b)
    if fuel_is_distinct(a, b):
        return None
    if _same_amount(a, b) and a.get("norm_date") and a["norm_date"] == b.get("norm_date") and a.get("merchant_key") and a["merchant_key"] == b.get("merchant_key"):
        apart = _minutes_apart(a, b)
        if apart is not None and apart <= LIKELY_MINUTES:
            return _hit("amount_date_merchant_time", b)
        if a.get("norm_card_last4") and a["norm_card_last4"] == b.get("norm_card_last4"):
            return _hit("amount_date_merchant_card", b)
    if _same_amount(a, b) and a.get("merchant_key") and a["merchant_key"] == b.get("merchant_key") and _days_apart(a, b) == 1:
        return _hit("amount_merchant_day_off", b)
    return None


def _empty(skipped: bool, reason: Optional[str] = None) -> dict:
    return {"skipped": skipped, "level": None, "reason": reason, "distance": None, "match": None}


def _for_match(doc: dict) -> dict:
    if doc.get("receipt_image") and not doc.get("image_sha256"):
        return enrich_expense(doc)
    out = dict(doc)
    norms = normalise_fields(out)
    mins = norms.pop("_time_mins")
    out.update(norms)
    out["_time_mins"] = mins
    return out


def match_expense(candidate: dict, existing: list, keep_with=None, exclude_id: Optional[str] = None) -> dict:
    """Best match against one driver's expenses. ``skipped`` means the
    candidate did not have enough fields to compare. Refunds never match.
    ``keep_with`` and stored ``dupe_keep_with`` pairs are not flagged again.
    """
    cand = _for_match(candidate)
    if is_refund(cand):
        return _empty(False, "refund")
    if not _has_match_key(cand):
        return _empty(True)
    best = None
    for raw in existing or []:
        if not isinstance(raw, dict):
            continue
        other = _for_match(raw)
        if exclude_id and other.get("id") and str(other["id"]) == str(exclude_id):
            continue
        if cand.get("profile_id") and other.get("profile_id") and str(cand["profile_id"]) != str(other["profile_id"]):
            continue
        if is_refund(other):
            continue
        if _kept(cand, other, keep_with):
            continue
        hit = _compare(cand, other)
        if hit and (best is None or hit["rank"] > best["rank"]):
            best = hit
    if not best:
        return _empty(False)
    return {
        "skipped": False,
        "level": best["level"],
        "reason": best["reason"],
        "distance": best["distance"],
        "match": best["match"],
    }


def plan_paid_scan(image_bytes: bytes, existing: list, keep_with=None) -> dict:
    """Decide whether a paid vision call is required.

    When ``skip`` is true the image is already a strong match (exact file or
    perceptual hash). The caller must return that result and must not call the
    vision model.
    """
    digest = sha256_hex(image_bytes)
    candidate = {"receipt_image": base64.b64encode(image_bytes).decode()}
    report = match_expense(candidate, existing, keep_with=keep_with)
    image_match = report["level"] == "strong" and report["reason"] in ("exact_image", "perceptual")
    return {
        "skip": image_match,
        "image_sha256": digest,
        "duplicate": report if image_match else _empty(report["skipped"], report["reason"]),
    }


def backfill_documents(docs: list) -> dict:
    """Fill hashes and normalised fields on expenses that have a receipt image.

    Idempotent: a second call reports ``updated == 0`` and the documents compare
    equal. Expenses without an image are left untouched.
    """
    out = []
    updated = 0
    for doc in docs or []:
        if not isinstance(doc, dict) or not doc.get("receipt_image"):
            out.append(doc)
            continue
        new = enrich_expense(doc)
        new.pop("_time_mins", None)
        changed = any(new.get(k) != doc.get(k) for k in _TRACKED)
        if changed:
            updated += 1
            out.append(new)
        else:
            out.append(doc)
    return {"documents": out, "updated": updated, "unchanged": len(out) - updated}


def attach_duplicate(stored: dict, report: dict) -> dict:
    """Response body for POST /expenses. Always the saved expense plus match
    info. Never a rejection, including likely and possible matches."""
    body = dict(stored)
    body.pop("_time_mins", None)
    if report.get("level"):
        body["duplicate"] = {
            "skipped": False,
            "level": report["level"],
            "reason": report["reason"],
            "distance": report.get("distance"),
            "match": report.get("match"),
        }
    else:
        body["duplicate"] = None
        body["duplicate_skipped"] = bool(report.get("skipped"))
    return body


def remembered_keep_ids(existing: Optional[list], new_id: str) -> list:
    ids = []
    for item in existing or []:
        if item and str(item) != str(new_id) and str(item) not in ids:
            ids.append(str(item))
    ids.append(str(new_id))
    return ids
