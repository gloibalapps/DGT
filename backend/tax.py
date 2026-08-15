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

# Cents-per-km rate by AU financial year (year = the July the FY starts).
AU_CENTS_PER_KM = {2024: 0.88, 2025: 0.88, 2026: 0.91}
AU_CPK_MAX_KM = 5000

# Trip purpose taxonomy (used for the audit trail; classification lives on `type`)
BUSINESS_PURPOSES = {"collect", "deliver", "between_jobs", "other_business"}
PRIVATE_PURPOSES = {"home", "shopping", "appointment", "personal_other"}
LOGBOOK_WINDOW_DAYS = 84  # 12 continuous weeks


def cpk_rate(fy_start_year: int) -> float:
    if fy_start_year in AU_CENTS_PER_KM:
        return AU_CENTS_PER_KM[fy_start_year]
    return AU_CENTS_PER_KM[max(AU_CENTS_PER_KM)]


def trip_business_km(t: dict) -> float:
    """Business kilometres for a trip, honouring mixed-trip business_pct."""
    typ = t.get("type", "business")
    d = float(t.get("distance_km") or 0)
    if typ == "personal":
        return 0.0
    if typ == "mixed":
        pct = t.get("business_pct")
        pct = 100.0 if pct is None else float(pct)
        return round(d * max(0.0, min(100.0, pct)) / 100.0, 3)
    return d


def trip_personal_km(t: dict) -> float:
    d = float(t.get("distance_km") or 0)
    return round(d - trip_business_km(t), 3)


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


DATE_FMT = "%d/%m/%Y"


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
    business_km = round(sum(trip_business_km(t) for t in p_trips), 2)
    personal_km = round(sum(trip_personal_km(t) for t in p_trips), 2)
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


def performance(profile: dict, trips, incomes, expenses, ref: date) -> Dict[str, Any]:
    """Last 4 calendar weeks (Mon-Sun) ending in the week containing ref."""
    monday = ref - timedelta(days=ref.weekday())
    weeks = []
    tot_inc = tot_exp = tot_km = tot_min = 0.0
    for i in range(3, -1, -1):
        ws = monday - timedelta(weeks=i)
        we = ws + timedelta(days=7)

        def in_w(row, s=ws, e=we):
            d = parse_date(row["date"])
            return s <= d < e

        inc = sum(x["amount"] for x in incomes if in_w(x))
        exp = sum(x["amount"] for x in expenses if in_w(x))
        wt = [t for t in trips if in_w(t)]
        bkm = sum(trip_business_km(t) for t in wt)
        mins = sum((t.get("duration_min") or 0) for t in wt if trip_business_km(t) > 0)
        weeks.append({
            "label": ws.strftime("%d/%m"),
            "start": ws.isoformat(),
            "income": round(inc, 2),
            "expenses": round(exp, 2),
            "profit": round(inc - exp, 2),
            "business_km": round(bkm, 2),
            "hours": round(mins / 60.0, 2),
        })
        tot_inc += inc
        tot_exp += exp
        tot_km += bkm
        tot_min += mins

    hours = tot_min / 60.0
    return {
        "weeks": weeks,
        "total_income": round(tot_inc, 2),
        "total_expenses": round(tot_exp, 2),
        "total_profit": round(tot_inc - tot_exp, 2),
        "total_km": round(tot_km, 2),
        "total_hours": round(hours, 2),
        "per_km": round(tot_inc / tot_km, 2) if tot_km > 0 else None,
        "per_hour": round(tot_inc / hours, 2) if hours > 0 else None,
        "symbol": "$",
        "distance_unit": "km",
    }



def dashboard(profile: dict, trips, incomes, expenses, today: date) -> Dict[str, Any]:
    t_iso = today.isoformat()
    income_today = round(sum(i["amount"] for i in incomes if str(i["date"])[:10] == t_iso), 2)
    expense_today = round(sum(e["amount"] for e in expenses if str(e["date"])[:10] == t_iso), 2)
    business_today = round(sum(trip_business_km(t) for t in trips
                              if str(t["date"])[:10] == t_iso), 2)

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



# ---------------------------------------------------------------------------
# Tax Mileage engine — ATO logbook, method comparison, odometer reconciliation
# ---------------------------------------------------------------------------
def _fy_bounds(ref: date):
    start = au_fy_start(ref)
    return start, date(start.year + 1, 7, 1)


def _fy_label(start: date) -> str:
    return f"{start.year}\u2013{str(start.year + 1)[2:]}"


def best_logbook_window(trips: List[dict], window_days: int = LOGBOOK_WINDOW_DAYS,
                        min_business_km: float = 1.0) -> Optional[Dict[str, Any]]:
    """Slide a continuous 12-week window across the trips and pick the most
    representative one (highest business-use %, tie-break on total km). This is
    what the ATO logbook method needs: one continuous representative period.

    Only windows that are *fully* covered by the available data are considered
    (start + 84 days must sit within the data span) so we never recommend a
    sparse tail window. If there isn't yet 12 weeks of data, the whole dataset
    is returned as an in-progress (incomplete) window."""
    dated = sorted([t for t in trips if t.get("distance_km")],
                   key=lambda t: parse_date(t["date"]))
    if not dated:
        return None
    first = parse_date(dated[0]["date"])
    last = parse_date(dated[-1]["date"])
    data_span_days = (last - first).days + 1

    def build(start: date, end: date, complete: bool):
        window = [t for t in dated if start <= parse_date(t["date"]) < end]
        tkm = sum(float(t["distance_km"]) for t in window)
        if tkm <= 0:
            return None
        bkm = sum(trip_business_km(t) for t in window)
        if bkm < min_business_km:
            return None
        return {
            "start": start.isoformat(),
            "end": (end - timedelta(days=1)).isoformat(),
            "start_label": start.strftime(DATE_FMT),
            "end_label": (end - timedelta(days=1)).strftime(DATE_FMT),
            "business_km": round(bkm, 2),
            "private_km": round(tkm - bkm, 2),
            "total_km": round(tkm, 2),
            "business_pct": round(bkm / tkm * 100, 2),
            "journeys": len(window),
            "complete": complete,
            "data_span_days": data_span_days,
            "window": window,
            "_score": (round(bkm / tkm, 4), round(tkm, 2)),
        }

    # Not enough data yet for a full 12-week period → return the whole set.
    if data_span_days < window_days:
        w = build(first, last + timedelta(days=1), complete=False)
        if w:
            w.pop("_score", None)
        return w

    best = None
    latest_start = last + timedelta(days=1) - timedelta(days=window_days)
    for anchor in dated:
        start = parse_date(anchor["date"])
        if start > latest_start:  # window would run past our data → skip
            continue
        w = build(start, start + timedelta(days=window_days), complete=True)
        if w is None:
            continue
        if best is None or w["_score"] > best["_score"]:
            best = w
    if best is None:  # fallback: representative pct not found, use full set
        best = build(first, last + timedelta(days=1), complete=False)
    if best:
        best.pop("_score", None)
    return best


def logbook_summary(profile: dict, trips: List[dict], ref: date) -> Dict[str, Any]:
    fy_start, fy_end = _fy_bounds(ref)
    fy_trips = [t for t in trips if fy_start <= parse_date(t["date"]) < fy_end]
    lb = best_logbook_window(fy_trips) or best_logbook_window(trips)
    if not lb:
        return {
            "available": False,
            "business_pct": None,
            "message": "Log at least a few business and private trips to build your 12-week ATO logbook.",
        }
    journeys = []
    for t in sorted(lb.pop("window", []), key=lambda x: parse_date(x["date"])):
        journeys.append({
            "id": t.get("id"),
            "date": str(t["date"])[:10],
            "date_label": parse_date(t["date"]).strftime(DATE_FMT),
            "distance_km": round(float(t["distance_km"]), 2),
            "business_km": trip_business_km(t),
            "type": t.get("type", "business"),
            "purpose": t.get("purpose"),
            "from_label": t.get("from_label"),
            "to_label": t.get("to_label"),
            "odo_start": t.get("odo_start"),
            "odo_end": t.get("odo_end"),
        })
    return {
        "available": True,
        "period_start": lb["start"],
        "period_end": lb["end"],
        "period_label": f"{lb['start_label']} \u2013 {lb['end_label']}",
        "business_km": lb["business_km"],
        "private_km": lb["private_km"],
        "total_km": lb["total_km"],
        "business_pct": lb["business_pct"],
        "journey_count": lb["journeys"],
        "complete": lb["complete"],
        "journeys": journeys[:200],
        "note": ("A valid ATO logbook must cover a continuous 12-week period that "
                 "represents your typical driving. Keep going for the full 12 weeks."),
    }


def _fy_vehicle_expenses(profile: dict, expenses: List[dict], fy_start: date, fy_end: date):
    cats = {"fuel": 0.0, "vehicle": 0.0, "tolls": 0.0, "phone": 0.0, "other": 0.0}
    for e in expenses:
        d = parse_date(e["date"])
        if fy_start <= d < fy_end:
            c = e.get("category", "other")
            cats[c] = cats.get(c, 0.0) + float(e.get("amount") or 0)
    rec = profile.get("recurring_payment")
    recurring = recurring_owed(rec, fy_start, fy_end, date.today())
    cats = {k: round(v, 2) for k, v in cats.items()}
    # Eligible for the vehicle-cost pool (running costs apportioned by business use).
    eligible = round(cats["fuel"] + cats["vehicle"] + recurring, 2)
    return cats, round(recurring, 2), eligible


def method_comparison(profile: dict, trips: List[dict], expenses: List[dict],
                      ref: date) -> Dict[str, Any]:
    fy_start, fy_end = _fy_bounds(ref)
    fy_trips = [t for t in trips if fy_start <= parse_date(t["date"]) < fy_end]
    business_km = round(sum(trip_business_km(t) for t in fy_trips), 2)
    total_km = round(sum(float(t["distance_km"]) for t in fy_trips), 2)

    lb = best_logbook_window(fy_trips) or best_logbook_window(trips)
    if lb:
        logbook_pct = lb["business_pct"] / 100.0
        pct_source = "logbook"
    elif total_km > 0:
        logbook_pct = business_km / total_km
        pct_source = "derived"
    else:
        logbook_pct = float(profile.get("business_use_fallback", 100)) / 100.0
        pct_source = "fallback"

    cats, recurring, eligible = _fy_vehicle_expenses(profile, expenses, fy_start, fy_end)
    logbook_deduction = round(eligible * logbook_pct, 2)

    rate = cpk_rate(fy_start.year)
    capped_km = min(business_km, AU_CPK_MAX_KM)
    cpk_deduction = round(capped_km * rate, 2)

    recommend = "logbook" if logbook_deduction >= cpk_deduction else "cents_per_km"
    difference = round(abs(logbook_deduction - cpk_deduction), 2)

    return {
        "fy_start": fy_start.isoformat(),
        "fy_end": fy_end.isoformat(),
        "fy_label": _fy_label(fy_start),
        "business_km": business_km,
        "total_km": total_km,
        "logbook": {
            "business_pct": round(logbook_pct * 100, 2),
            "pct_source": pct_source,
            "eligible_expenses": eligible,
            "expense_breakdown": {"fuel": cats["fuel"], "vehicle": cats["vehicle"],
                                   "recurring_payment": recurring},
            "deduction": logbook_deduction,
        },
        "cents_per_km": {
            "rate": rate,
            "rate_cents": round(rate * 100),
            "max_km": AU_CPK_MAX_KM,
            "claimable_km": round(capped_km, 2),
            "capped": business_km > AU_CPK_MAX_KM,
            "deduction": cpk_deduction,
            "max_deduction": round(AU_CPK_MAX_KM * rate, 2),
        },
        "recommend": recommend,
        "recommend_label": "Logbook method" if recommend == "logbook" else "Cents per kilometre",
        "difference": difference,
        "disclaimer": ("This is an estimate, not tax advice. Your final deduction "
                       "depends on your actual eligible expenses, vehicle circumstances "
                       "and ATO requirements."),
    }


def odometer_check(profile: dict, trips: List[dict], ref: date) -> Dict[str, Any]:
    fy_start, fy_end = _fy_bounds(ref)
    v = profile.get("vehicle") or {}
    gps_km = round(sum(float(t["distance_km"]) for t in trips
                       if fy_start <= parse_date(t["date"]) < fy_end), 2)
    opening = v.get("opening_odometer")
    closing = v.get("closing_odometer")
    if opening is None or closing is None:
        return {"has_odometer": False, "gps_km": gps_km, "odometer_km": None,
                "opening": opening, "closing": closing, "discrepancy": None,
                "discrepancy_pct": None, "warning": None,
                "prompt": ("Enter your odometer at the start (1 July) and end (30 June) "
                           "of the financial year for an audit-proof total.")}
    odo_km = round(float(closing) - float(opening), 2)
    disc = round(odo_km - gps_km, 2)
    pct = round(abs(disc) / odo_km * 100, 1) if odo_km > 0 else 0.0
    warning = None
    if odo_km > 0 and pct >= 10:
        warning = (f"Your GPS records show {gps_km:,.0f} km but your odometer shows "
                   f"{odo_km:,.0f} km. Review your mileage records.")
    return {
        "has_odometer": True, "gps_km": gps_km, "odometer_km": odo_km,
        "opening": round(float(opening), 2), "closing": round(float(closing), 2),
        "discrepancy": disc, "discrepancy_pct": pct, "warning": warning,
    }


def tax_mileage(profile: dict, trips: List[dict], incomes: List[dict],
                expenses: List[dict], ref: date) -> Dict[str, Any]:
    fy_start, fy_end = _fy_bounds(ref)
    t_iso = ref.isoformat()

    def in_fy(row):
        return fy_start <= parse_date(row["date"]) < fy_end

    # ---- today ----
    today_trips = [t for t in trips if str(t["date"])[:10] == t_iso]
    today_biz = round(sum(trip_business_km(t) for t in today_trips), 2)
    today_priv = round(sum(trip_personal_km(t) for t in today_trips), 2)
    today_total = round(today_biz + today_priv, 2)
    today_income = round(sum(i["amount"] for i in incomes if str(i["date"])[:10] == t_iso), 2)

    # ---- financial year ----
    fy_trips = [t for t in trips if in_fy(t)]
    fy_biz = round(sum(trip_business_km(t) for t in fy_trips), 2)
    fy_priv = round(sum(trip_personal_km(t) for t in fy_trips), 2)
    fy_total = round(fy_biz + fy_priv, 2)
    fy_income = round(sum(i["amount"] for i in incomes if in_fy(i)), 2)

    return {
        "currency": "AUD", "symbol": "$", "distance_unit": "km",
        "today": {
            "date": t_iso,
            "total_km": today_total,
            "business_km": today_biz,
            "private_km": today_priv,
            "business_pct": round(today_biz / today_total * 100, 1) if today_total > 0 else 0.0,
            "income": today_income,
            "per_business_km": round(today_income / today_biz, 2) if today_biz > 0 else None,
        },
        "financial_year": {
            "label": _fy_label(fy_start),
            "start": fy_start.isoformat(),
            "end": fy_end.isoformat(),
            "total_km": fy_total,
            "business_km": fy_biz,
            "private_km": fy_priv,
            "business_pct": round(fy_biz / fy_total * 100, 2) if fy_total > 0 else 0.0,
            "income": fy_income,
            "per_business_km": round(fy_income / fy_biz, 2) if fy_biz > 0 else None,
        },
        "logbook": logbook_summary(profile, trips, ref),
        "method_comparison": method_comparison(profile, trips, expenses, ref),
        "odometer": odometer_check(profile, trips, ref),
        "vehicle": profile.get("vehicle") or {},
    }
