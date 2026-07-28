"""GigTax — Australian tax logic (milestone 1).

All figures here are computed server-side so they can be validated independently
of the UI. Australia is the reference market; other countries will be layered on
top of these primitives later.
"""
from datetime import date, datetime, timedelta, timezone
from typing import List, Dict, Any, Optional

# ---------------------------------------------------------------------------
# Australian configuration
# ---------------------------------------------------------------------------
AU_GST_RATE = 0.10
AU_CENTS_PER_KM_FY2025_26 = 0.88  # comparison messaging only — NOT an option
AU_CENTS_PER_KM_FY2026_27 = 0.91  # from 1 July 2026
AU_DELIVERY_GST_THRESHOLD = 75000  # delivery-only registration trigger

APPORTIONED_CATEGORIES = {"fuel", "vehicle"}   # scaled by business-use %
FULL_CLAIM_CATEGORIES = {"tolls", "phone", "other"}  # claimed in full

CYCLE_DAYS = {"weekly": 7.0, "fortnightly": 14.0, "monthly": 365.0 / 12.0}


def parse_date(s: str) -> date:
    return datetime.fromisoformat(str(s)[:10]).date()


# ---------------------------------------------------------------------------
# Reporting periods — calendar aligned to the AU filing calendar, never rolling
# ---------------------------------------------------------------------------
def au_fy_start(d: date) -> date:
    """Australian financial year starts 1 July."""
    return date(d.year if d.month >= 7 else d.year - 1, 7, 1)


def au_bas_quarter(d: date):
    """BAS quarters: Jul-Sep, Oct-Dec, Jan-Mar, Apr-Jun. Returns [start, end)."""
    m = d.month
    if 7 <= m <= 9:
        return date(d.year, 7, 1), date(d.year, 10, 1)
    if 10 <= m <= 12:
        return date(d.year, 10, 1), date(d.year + 1, 1, 1)
    if 1 <= m <= 3:
        return date(d.year, 1, 1), date(d.year, 4, 1)
    return date(d.year, 4, 1), date(d.year, 7, 1)


def _add_month(d: date) -> date:
    return date(d.year + 1, 1, 1) if d.month == 12 else date(d.year, d.month + 1, 1)


def period_range(period: str, ref: date):
    """Return [start, end_exclusive) for the given calendar-aligned period."""
    if period == "week":
        start = ref - timedelta(days=ref.weekday())  # Monday
        return start, start + timedelta(days=7)
    if period == "month":
        start = date(ref.year, ref.month, 1)
        return start, _add_month(start)
    if period == "quarter":
        return au_bas_quarter(ref)
    # year -> financial year
    start = au_fy_start(ref)
    return start, date(start.year + 1, 7, 1)


DATE_FMT = "%d %b %Y"


def fmt_period_label(period: str, start: date, end: date) -> str:
    last = end - timedelta(days=1)
    return f"{start.strftime(DATE_FMT)} – {last.strftime(DATE_FMT)}"


# ---------------------------------------------------------------------------
# Recurring vehicle payment — calculated (elapsed cycles), never logged.
# Uses continuous daily proration so adjacent periods sum exactly to the whole
# with no gaps and no double counting at the boundaries.
# ---------------------------------------------------------------------------
def recurring_owed(rec: Optional[dict], start: date, end: date, today: date) -> float:
    if not rec or not rec.get("amount") or not rec.get("anchor_date"):
        return 0.0
    freq = rec.get("frequency", "weekly")
    cycle = CYCLE_DAYS.get(freq, 7.0)
    daily = float(rec["amount"]) / cycle
    anchor = parse_date(rec["anchor_date"])
    # Only count time that has actually elapsed (up to and including today).
    cap = min(end, today + timedelta(days=1))
    ov_start = max(start, anchor)
    ov_end = cap
    days = (ov_end - ov_start).days
    if days <= 0:
        return 0.0
    return round(daily * days, 2)


def next_due_date(rec: Optional[dict], today: date) -> Optional[str]:
    if not rec or not rec.get("anchor_date"):
        return None
    freq = rec.get("frequency", "weekly")
    step = {"weekly": 7, "fortnightly": 14, "monthly": 30}.get(freq, 7)
    d = parse_date(rec["anchor_date"])
    while d <= today:
        if freq == "monthly":
            d = _add_month_keep_day(d)
        else:
            d = d + timedelta(days=step)
    return d.isoformat()


def _add_month_keep_day(d: date) -> date:
    y = d.year + (1 if d.month == 12 else 0)
    m = 1 if d.month == 12 else d.month + 1
    try:
        return date(y, m, d.day)
    except ValueError:
        return date(y, m, 28)


# ---------------------------------------------------------------------------
# Core report
# ---------------------------------------------------------------------------
def compute_report(profile: dict, trips: List[dict], incomes: List[dict],
                   expenses: List[dict], period: str, ref: date) -> Dict[str, Any]:
    start, end = period_range(period, ref)
    today = date.today()

    def in_period(row) -> bool:
        d = parse_date(row["date"])
        return start <= d < end

    p_trips = [t for t in trips if in_period(t)]
    p_income = [i for i in incomes if in_period(i)]
    p_exp = [e for e in expenses if in_period(e)]

    # ---- business-use % (derived, never typed) ----
    def is_business(t):
        return t.get("type", "business") != "personal"  # untagged -> business

    business_km = round(sum(t["distance_km"] for t in p_trips if is_business(t)), 2)
    personal_km = round(sum(t["distance_km"] for t in p_trips if not is_business(t)), 2)
    total_km = round(business_km + personal_km, 2)
    fallback = float(profile.get("business_use_fallback", 100)) / 100.0
    business_use = (business_km / total_km) if total_km > 0 else fallback

    # ---- income ----
    total_income = round(sum(i["amount"] for i in p_income), 2)
    inclusive_income = round(
        sum(i["amount"] for i in p_income if i.get("tax_treatment", "inclusive") == "inclusive"), 2)

    # ---- expenses by category ----
    cat_totals = {c: 0.0 for c in ["fuel", "tolls", "vehicle", "phone", "other"]}
    for e in p_exp:
        c = e.get("category", "other")
        cat_totals[c] = cat_totals.get(c, 0.0) + e["amount"]
    cat_totals = {k: round(v, 2) for k, v in cat_totals.items()}

    # ---- recurring vehicle payment (its own labelled line) ----
    rec = profile.get("recurring_payment")
    recurring_amount = recurring_owed(rec, start, end, today)

    # ---- vehicle deduction breakdown (apportioned by business-use %) ----
    fuel_ded = round(cat_totals["fuel"] * business_use, 2)
    vehicle_ded = round(cat_totals["vehicle"] * business_use, 2)
    recurring_ded = round(recurring_amount * business_use, 2)
    vehicle_deduction_total = round(fuel_ded + vehicle_ded + recurring_ded, 2)

    # ---- full-claim work expenses (not apportioned) ----
    tolls_ded = cat_totals["tolls"]
    phone_ded = cat_totals["phone"]
    other_ded = cat_totals["other"]
    full_claim_total = round(tolls_ded + phone_ded + other_ded, 2)

    total_deductions = round(vehicle_deduction_total + full_claim_total, 2)
    net_profit = round(total_income - total_deductions, 2)

    # ---- BAS / GST (only if registered) ----
    work_type = profile.get("work_type", "delivery")
    registered = profile.get("registration_status") == "registered"

    g1 = inclusive_income
    one_a = round(g1 / 11.0, 2)  # GST on sales at 10% inclusive
    # GST credits on purchases: apportion fuel/vehicle/recurring by business use.
    one_b_base = 0.0
    for e in p_exp:
        if e.get("tax_treatment", "inclusive") != "inclusive":
            continue
        c = e.get("category", "other")
        claimable = e["amount"] * business_use if c in APPORTIONED_CATEGORIES else e["amount"]
        one_b_base += claimable
    # recurring payment carries GST when it's a lease/rental (apportioned)
    if profile.get("vehicle_ownership") in ("lease", "rental", "loan"):
        one_b_base += recurring_amount * business_use
    one_b = round(one_b_base / 11.0, 2)
    net_gst = round(one_a - one_b, 2)

    # ---- registration guidance ----
    reg_warning = None
    if work_type in ("passengers", "both") and not registered:
        reg_warning = ("You carry passengers — ride-sourcing requires GST "
                       "registration from your first dollar. Register with the ATO.")
    elif work_type == "delivery" and not registered:
        fy_start = au_fy_start(today)
        fy_income = round(sum(i["amount"] for i in incomes
                             if fy_start <= parse_date(i["date"])), 2)
        if fy_income >= AU_DELIVERY_GST_THRESHOLD:
            reg_warning = ("Your delivery turnover has passed $75,000 this financial "
                           "year — you now need to register for GST.")

    return {
        "period": period,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "period_label": fmt_period_label(period, start, end),
        "currency": "AUD",
        "symbol": "$",
        "distance_unit": "km",
        # trips / business use
        "business_km": business_km,
        "personal_km": personal_km,
        "total_km": total_km,
        "business_use_pct": round(business_use * 100, 1),
        "business_use_is_fallback": total_km == 0,
        # income / profit
        "total_income": total_income,
        "total_deductions": total_deductions,
        "net_profit": net_profit,
        # category totals
        "category_totals": cat_totals,
        # vehicle deduction breakdown
        "vehicle_deduction": {
            "fuel": fuel_ded,
            "vehicle_costs": vehicle_ded,
            "recurring_payment": recurring_ded,
            "recurring_payment_gross": recurring_amount,
            "business_use_pct": round(business_use * 100, 1),
            "total": vehicle_deduction_total,
        },
        "full_claim": {
            "tolls": tolls_ded,
            "phone": phone_ded,
            "other": other_ded,
            "total": full_claim_total,
        },
        # BAS / GST
        "show_bas": registered,
        "bas": {
            "G1": round(g1, 2),
            "1A": one_a,
            "1B": one_b,
            "net_gst": net_gst,
            "sanity_ok": abs(one_a - round(g1 / 11.0, 2)) < 0.01,
        },
        "work_type": work_type,
        "registered": registered,
        "registration_warning": reg_warning,
        "vehicle_ownership": profile.get("vehicle_ownership"),
    }


def dashboard(profile: dict, trips, incomes, expenses, today: date) -> Dict[str, Any]:
    t_iso = today.isoformat()
    income_today = round(sum(i["amount"] for i in incomes if str(i["date"])[:10] == t_iso), 2)
    expense_today = round(sum(e["amount"] for e in expenses if str(e["date"])[:10] == t_iso), 2)
    business_today = round(sum(t["distance_km"] for t in trips
                              if str(t["date"])[:10] == t_iso
                              and t.get("type", "business") != "personal"), 2)

    # recurring status for the current BAS quarter
    q_start, q_end = au_bas_quarter(today)
    rec = profile.get("recurring_payment")
    rec_owed = recurring_owed(rec, q_start, q_end, today)

    # recent activity — merge & sort
    items = []
    for i in incomes:
        items.append({"kind": "income", "id": i["id"], "date": str(i["date"])[:10],
                      "created_at": i.get("created_at", ""),
                      "title": i.get("platform", "Income"),
                      "subtitle": "Income", "amount": i["amount"]})
    for e in expenses:
        items.append({"kind": "expense", "id": e["id"], "date": str(e["date"])[:10],
                      "created_at": e.get("created_at", ""),
                      "title": e.get("merchant") or e.get("category", "Expense").title(),
                      "subtitle": e.get("category", "other").title(), "amount": -e["amount"]})
    for t in trips:
        biz = t.get("type", "business") != "personal"
        items.append({"kind": "trip", "id": t["id"], "date": str(t["date"])[:10],
                      "created_at": t.get("created_at", ""),
                      "title": f"{t['distance_km']} km trip",
                      "subtitle": "Business" if biz else "Personal", "amount": None})
    items.sort(key=lambda x: (x["date"], x["created_at"]), reverse=True)

    tax_setup_complete = bool(profile.get("legal_name")) and \
        profile.get("registration_status") in ("registered", "not_registered")

    return {
        "date": t_iso,
        "income_today": income_today,
        "expense_today": expense_today,
        "net_today": round(income_today - expense_today, 2),
        "business_distance_today": business_today,
        "currency": "AUD", "symbol": "$", "distance_unit": "km",
        "recurring": {
            "enabled": bool(rec and rec.get("amount")),
            "amount": rec.get("amount") if rec else None,
            "frequency": rec.get("frequency") if rec else None,
            "owed_this_quarter": rec_owed,
            "next_due": next_due_date(rec, today) if rec else None,
            "quarter_label": fmt_period_label("quarter", q_start, q_end),
        },
        "recent": items[:8],
        "tax_setup_complete": tax_setup_complete,
    }
