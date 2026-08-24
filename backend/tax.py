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

# ---------------------------------------------------------------------------
# United States configuration (calendar tax year, Schedule C, SE tax)
# ---------------------------------------------------------------------------
US_SE_TAX_RATE = 0.153        # 12.4% Social Security + 2.9% Medicare
US_SE_NET_FACTOR = 0.9235     # net earnings from SE = 92.35% of net profit
US_QUARTER_DUE = {1: "15 Apr", 2: "15 Jun", 3: "15 Sep", 4: "15 Jan"}
US_STD_DEDUCTION = 15000.0    # 2025 single standard deduction (estimate)
# 2025 single-filer federal income tax brackets: (upper_bound, rate)
US_FED_BRACKETS = [(11925, 0.10), (48475, 0.12), (103350, 0.22),
                   (197300, 0.24), (250525, 0.32), (626350, 0.35),
                   (float("inf"), 0.37)]

# AU resident individual tax 2024-25: (upper_bound, rate). Medicare levy added.
AU_INCOME_BRACKETS = [(18200, 0.0), (45000, 0.16), (135000, 0.30),
                      (190000, 0.37), (float("inf"), 0.45)]
AU_MEDICARE_LEVY = 0.02
AU_MEDICARE_THRESHOLD = 27222.0   # single lower threshold (approx)


def _bracket_tax(taxable: float, brackets) -> float:
    tax = 0.0
    prev = 0.0
    for cap, rate in brackets:
        if taxable > prev:
            tax += (min(taxable, cap) - prev) * rate
            prev = cap
        else:
            break
    return round(tax, 2)


def us_federal_income_tax(taxable: float) -> float:
    return _bracket_tax(max(0.0, taxable), US_FED_BRACKETS)


def au_income_tax(taxable: float) -> float:
    taxable = max(0.0, taxable)
    tax = _bracket_tax(taxable, AU_INCOME_BRACKETS)
    levy = taxable * AU_MEDICARE_LEVY if taxable > AU_MEDICARE_THRESHOLD else 0.0
    return round(tax + levy, 2)


# Approximate US state income-tax rates (2025). Flat states use their real flat
# rate; graduated states use a representative rate for typical gig income (not the
# top marginal). Nine states levy no income tax on gig earnings.
US_STATE_TAX_RATE = {
    # no income tax
    "AK": 0.0, "FL": 0.0, "NV": 0.0, "NH": 0.0, "SD": 0.0, "TN": 0.0,
    "TX": 0.0, "WA": 0.0, "WY": 0.0,
    # flat-tax states
    "AZ": 0.025, "CO": 0.044, "GA": 0.0539, "IL": 0.0495, "IN": 0.030,
    "KY": 0.040, "LA": 0.030, "MI": 0.0425, "MS": 0.044, "NC": 0.0425,
    "PA": 0.0307, "UT": 0.0455, "ID": 0.05695, "IA": 0.038, "MA": 0.050,
    # graduated states — representative rate for typical gig income
    "AL": 0.045, "AR": 0.039, "CA": 0.040, "CT": 0.050, "DE": 0.050,
    "DC": 0.060, "HI": 0.075, "ME": 0.0675, "MD": 0.0475, "MN": 0.068,
    "MO": 0.047, "MT": 0.059, "NE": 0.052, "NJ": 0.055, "NM": 0.049,
    "NY": 0.0585, "ND": 0.020, "OH": 0.035, "OK": 0.0475, "OR": 0.0875,
    "RI": 0.0475, "SC": 0.062, "VT": 0.066, "VA": 0.0575, "WV": 0.045,
    "WI": 0.053,
}


def us_state_tax(state: Optional[str], taxable: float):
    st = (state or "").upper()
    rate = US_STATE_TAX_RATE.get(st, 0.05)  # unknown -> generic 5% estimate
    amount = round(max(0.0, taxable) * rate, 2)
    return st, rate, amount



def us_mileage_rate(d: date) -> float:
    """IRS business standard mileage rate, date-keyed (rate can change mid-year)."""
    y = d.year
    if y <= 2024:
        return 0.67
    if y == 2025:
        return 0.70
    if y == 2026:
        return 0.725 if d.month <= 6 else 0.76   # 72.5c Jan-Jun, 76c Jul-Dec
    return 0.76  # sensible default for future years until updated


def us_standard_mileage_deduction(trips: List[dict]) -> float:
    """Sum business miles x the IRS rate applicable to each trip's date."""
    total = 0.0
    for t in trips:
        total += trip_business_km(t) * us_mileage_rate(parse_date(t["date"]))
    return round(total, 2)


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


def us_calendar_quarter(d: date):
    """US calendar quarters: Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec. [start, end)."""
    q = (d.month - 1) // 3          # 0..3
    sm = q * 3 + 1
    start = date(d.year, sm, 1)
    end = date(d.year + 1, 1, 1) if sm == 10 else date(d.year, sm + 3, 1)
    return start, end


def fy_start(d: date, country: str = "AU") -> date:
    """Tax-year start: AU = 1 Jul, US = 1 Jan (calendar year)."""
    if country == "US":
        return date(d.year, 1, 1)
    return au_fy_start(d)


def _add_month(d: date) -> date:
    return date(d.year + 1, 1, 1) if d.month == 12 else date(d.year, d.month + 1, 1)


def period_range(period: str, ref: date, country: str = "AU"):
    """Return [start, end_exclusive) for the given calendar-aligned period."""
    if period == "week":
        start = ref - timedelta(days=ref.weekday())  # Monday
        return start, start + timedelta(days=7)
    if period == "month":
        start = date(ref.year, ref.month, 1)
        return start, _add_month(start)
    if period == "quarter":
        return us_calendar_quarter(ref) if country == "US" else au_bas_quarter(ref)
    # year -> tax year
    start = fy_start(ref, country)
    return start, (date(start.year + 1, 1, 1) if country == "US"
                   else date(start.year + 1, 7, 1))


DATE_FMT = "%d/%m/%Y"


def fmt_period_label(period: str, start: date, end: date, country: str = "AU") -> str:
    last = end - timedelta(days=1)
    fmt = "%m/%d/%Y" if country == "US" else DATE_FMT
    return f"{start.strftime(fmt)} \u2013 {last.strftime(fmt)}"


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
                   expenses: List[dict], period: str, ref: date,
                   vehicles: Optional[List[dict]] = None) -> Dict[str, Any]:
    if profile.get("country") == "US":
        return compute_report_us(profile, trips, incomes, expenses, period, ref, vehicles)
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

    # ---- vehicle cost pool: per-vehicle business-use apportionment ----
    # Each car deducts its own running costs at its own business-use %. When no
    # vehicles list is supplied we fall back to a single pseudo-vehicle built
    # from the profile (preserves single-car behaviour).
    veh_list = vehicles if vehicles else [{
        "id": "__default__",
        "ownership": profile.get("vehicle_ownership", "own"),
        "recurring_payment": profile.get("recurring_payment"),
    }]

    def period_vehicle_use(vid):
        vt = [t for t in p_trips if (t.get("vehicle_id") or "__default__") == vid]
        b = sum(trip_business_km(t) for t in vt)
        tot = sum(float(t["distance_km"]) for t in vt)
        return (b / tot) if tot > 0 else business_use

    uses = {v["id"]: period_vehicle_use(v["id"]) for v in veh_list}

    fuel_ded = vehicle_ded = recurring_ded = recurring_gross = 0.0
    for e in p_exp:
        c = e.get("category", "other")
        if c not in ("fuel", "vehicle"):
            continue
        use = uses.get(e.get("vehicle_id") or "__default__", business_use)
        if c == "fuel":
            fuel_ded += e["amount"] * use
        else:
            vehicle_ded += e["amount"] * use
    for v in veh_list:
        rg = recurring_owed(v.get("recurring_payment"), start, end, today)
        recurring_gross += rg
        recurring_ded += rg * uses[v["id"]]
    fuel_ded = round(fuel_ded, 2)
    vehicle_ded = round(vehicle_ded, 2)
    recurring_ded = round(recurring_ded, 2)
    recurring_gross = round(recurring_gross, 2)
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
        if c in APPORTIONED_CATEGORIES:
            one_b_base += e["amount"] * uses.get(e.get("vehicle_id") or "__default__", business_use)
        else:
            one_b_base += e["amount"]
    # recurring payment carries GST when it's a lease/rental/loan (apportioned per car)
    for v in veh_list:
        if v.get("ownership", profile.get("vehicle_ownership")) in ("lease", "rental", "loan"):
            rg = recurring_owed(v.get("recurring_payment"), start, end, today)
            one_b_base += rg * uses[v["id"]]
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
            "recurring_payment_gross": recurring_gross,
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


def compute_report_us(profile: dict, trips: List[dict], incomes: List[dict],
                      expenses: List[dict], period: str, ref: date,
                      vehicles: Optional[List[dict]] = None) -> Dict[str, Any]:
    """US Schedule C summary: car & truck expense (higher of IRS standard
    mileage vs actual expenses), other business expenses, net profit and a
    self-employment tax estimate. Calendar tax year, miles, no GST."""
    start, end = period_range(period, ref, "US")
    today = date.today()

    def in_period(row):
        return start <= parse_date(row["date"]) < end

    p_trips = [t for t in trips if in_period(t)]
    p_income = [i for i in incomes if in_period(i)]
    p_exp = [e for e in expenses if in_period(e)]

    business_km = round(sum(trip_business_km(t) for t in p_trips), 2)
    personal_km = round(sum(trip_personal_km(t) for t in p_trips), 2)
    total_km = round(business_km + personal_km, 2)
    fallback = float(profile.get("business_use_fallback", 100)) / 100.0
    business_use = (business_km / total_km) if total_km > 0 else fallback

    total_income = round(sum(i["amount"] for i in p_income), 2)

    cat_totals = {c: 0.0 for c in ["fuel", "tolls", "vehicle", "phone", "other"]}
    for e in p_exp:
        c = e.get("category", "other")
        cat_totals[c] = cat_totals.get(c, 0.0) + e["amount"]
    cat_totals = {k: round(v, 2) for k, v in cat_totals.items()}

    # ---- actual expense method (apportioned per vehicle) ----
    veh_list = vehicles if vehicles else [{
        "id": "__default__", "ownership": profile.get("vehicle_ownership", "own"),
        "recurring_payment": profile.get("recurring_payment"),
    }]

    def period_vehicle_use(vid):
        vt = [t for t in p_trips if (t.get("vehicle_id") or "__default__") == vid]
        b = sum(trip_business_km(t) for t in vt)
        tot = sum(float(t["distance_km"]) for t in vt)
        return (b / tot) if tot > 0 else business_use

    uses = {v["id"]: period_vehicle_use(v["id"]) for v in veh_list}
    fuel_ded = vehicle_ded = recurring_ded = recurring_gross = 0.0
    for e in p_exp:
        c = e.get("category", "other")
        if c not in ("fuel", "vehicle"):
            continue
        use = uses.get(e.get("vehicle_id") or "__default__", business_use)
        if c == "fuel":
            fuel_ded += e["amount"] * use
        else:
            vehicle_ded += e["amount"] * use
    for v in veh_list:
        rg = recurring_owed(v.get("recurring_payment"), start, end, today)
        recurring_gross += rg
        recurring_ded += rg * uses[v["id"]]
    actual_expense = round(fuel_ded + vehicle_ded + recurring_ded, 2)

    # ---- standard mileage method (date-keyed IRS rate, no cap) ----
    standard_mileage = us_standard_mileage_deduction(p_trips)

    car_and_truck = round(max(standard_mileage, actual_expense), 2)
    car_method = "standard_mileage" if standard_mileage >= actual_expense else "actual"

    # ---- other business expenses (tolls/parking, phone, supplies) ----
    other_expenses = round(cat_totals["tolls"] + cat_totals["phone"] + cat_totals["other"], 2)
    total_deductions = round(car_and_truck + other_expenses, 2)
    net_profit = round(total_income - total_deductions, 2)

    # ---- self-employment tax estimate ----
    net_se = round(max(0.0, net_profit) * US_SE_NET_FACTOR, 2)
    se_tax = round(net_se * US_SE_TAX_RATE, 2)
    st_code, st_rate, st_tax = us_state_tax(profile.get("region"), max(0.0, net_profit))

    q_due = None
    if period == "quarter":
        q = (start.month - 1) // 3 + 1
        q_due = US_QUARTER_DUE.get(q)

    return {
        "country": "US",
        "period": period,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "period_label": fmt_period_label(period, start, end, "US"),
        "currency": "USD", "symbol": "$", "distance_unit": "mi",
        "business_km": business_km, "personal_km": personal_km, "total_km": total_km,
        "business_use_pct": round(business_use * 100, 1),
        "business_use_is_fallback": total_km == 0,
        "total_income": total_income,
        "total_deductions": total_deductions,
        "net_profit": net_profit,
        "category_totals": cat_totals,
        "vehicle_deduction": {
            "fuel": round(fuel_ded, 2),
            "vehicle_costs": round(vehicle_ded, 2),
            "recurring_payment": round(recurring_ded, 2),
            "recurring_payment_gross": round(recurring_gross, 2),
            "business_use_pct": round(business_use * 100, 1),
            "total": actual_expense,
        },
        "full_claim": {
            "tolls": cat_totals["tolls"], "phone": cat_totals["phone"],
            "other": cat_totals["other"], "total": other_expenses,
        },
        "schedule_c": {
            "gross_receipts": total_income,
            "standard_mileage": standard_mileage,
            "actual_expenses": actual_expense,
            "car_and_truck": car_and_truck,
            "car_method": car_method,
            "car_method_label": "Standard mileage" if car_method == "standard_mileage" else "Actual expenses",
            "other_expenses": other_expenses,
            "total_expenses": total_deductions,
            "net_profit": net_profit,
        },
        "se_tax": {
            "net_earnings": net_se,
            "rate": US_SE_TAX_RATE,
            "amount": se_tax,
            "state": st_code,
            "state_rate": st_rate,
            "state_tax": st_tax,
            "state_has_tax": st_rate > 0,
            "quarter_due": q_due,
            "note": ("Self-employment tax is ~15.3% of 92.35% of net profit. "
                     "Set this aside and pay quarterly estimated taxes (Form 1040-ES). "
                     "This is an estimate, not tax advice."),
        },
        "show_bas": False,
        "registration_warning": None,
        "work_type": profile.get("work_type", "delivery"),
        "vehicle_ownership": profile.get("vehicle_ownership"),
    }



def performance(profile: dict, trips, incomes, expenses, ref: date, shifts=None) -> Dict[str, Any]:
    """Last 4 calendar weeks (Mon-Sun) ending in the week containing ref.

    Hours prefer manually logged online-hours (shifts) when present for a week,
    otherwise fall back to business trip driving time. This lets earnings-per-hour
    reflect real online time (including idle/waiting), not just driving minutes.
    """
    monday = ref - timedelta(days=ref.weekday())
    shifts = shifts or []
    weeks = []
    tot_inc = tot_exp = tot_km = tot_hours = tot_online = 0.0
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
        online_h = sum((s.get("hours") or 0) for s in shifts if in_w(s))
        wk_hours = online_h if online_h > 0 else mins / 60.0
        weeks.append({
            "label": ws.strftime("%d/%m"),
            "start": ws.isoformat(),
            "income": round(inc, 2),
            "expenses": round(exp, 2),
            "profit": round(inc - exp, 2),
            "business_km": round(bkm, 2),
            "hours": round(wk_hours, 2),
        })
        tot_inc += inc
        tot_exp += exp
        tot_km += bkm
        tot_hours += wk_hours
        tot_online += online_h

    return {
        "weeks": weeks,
        "total_income": round(tot_inc, 2),
        "total_expenses": round(tot_exp, 2),
        "total_profit": round(tot_inc - tot_exp, 2),
        "total_km": round(tot_km, 2),
        "total_hours": round(tot_hours, 2),
        "hours_source": "online" if tot_online > 0 else "driving",
        "per_km": round(tot_inc / tot_km, 2) if tot_km > 0 else None,
        "per_hour": round(tot_inc / tot_hours, 2) if tot_hours > 0 else None,
        "symbol": "$",
        "distance_unit": "km",
    }


_WD_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_WD_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def insights(profile: dict, incomes, expenses, shifts, ref: date,
             weeks_back: int = 8, weekday_weeks: int = 12) -> Dict[str, Any]:
    """Driving insights: weekly hours-vs-earnings recap and best-day-to-drive.

    Hours come from manually logged online shifts. Earnings insights work off
    income regardless of whether hours are logged.
    """
    shifts = shifts or []
    symbol = "$"
    monday = ref - timedelta(days=ref.weekday())

    # ---- Weekly recap (oldest -> newest) --------------------------------
    weekly = []
    for i in range(weeks_back - 1, -1, -1):
        ws = monday - timedelta(weeks=i)
        we = ws + timedelta(days=7)

        def in_w(row, s=ws, e=we):
            d = parse_date(row["date"])
            return s <= d < e

        inc = sum(x["amount"] for x in incomes if in_w(x))
        exp = sum(x["amount"] for x in expenses if in_w(x))
        online_h = sum((s.get("hours") or 0) for s in shifts if in_w(s))
        weekly.append({
            "label": ws.strftime("%d/%m"),
            "start": ws.isoformat(),
            "income": round(inc, 2),
            "expenses": round(exp, 2),
            "profit": round(inc - exp, 2),
            "hours": round(online_h, 2),
            "per_hour": round(inc / online_h, 2) if online_h > 0 else None,
        })

    # ---- Best day to drive (last `weekday_weeks` weeks) -----------------
    wd_start = monday - timedelta(weeks=weekday_weeks - 1)
    wd_end = monday + timedelta(days=7)

    def in_win(row):
        d = parse_date(row["date"])
        return wd_start <= d < wd_end

    by = [{"weekday": k, "short": _WD_SHORT[k], "name": _WD_LONG[k],
           "income": 0.0, "hours": 0.0, "sessions": 0, "per_hour": None}
          for k in range(7)]
    for x in incomes:
        if in_win(x):
            by[parse_date(x["date"]).weekday()]["income"] += x["amount"]
    total_hours = 0.0
    for s in shifts:
        if in_win(s):
            k = parse_date(s["date"]).weekday()
            h = s.get("hours") or 0
            by[k]["hours"] += h
            by[k]["sessions"] += 1
            total_hours += h
    for d in by:
        d["income"] = round(d["income"], 2)
        d["hours"] = round(d["hours"], 2)
        d["per_hour"] = round(d["income"] / d["hours"], 2) if d["hours"] > 0 else None

    total_income = round(sum(d["income"] for d in by), 2)

    best_earning_day = None
    earners = [d for d in by if d["income"] > 0]
    if earners:
        b = max(earners, key=lambda d: d["income"])
        best_earning_day = {"short": b["short"], "name": b["name"], "income": b["income"]}

    best_hourly_day = None
    hourly = [d for d in by if d["per_hour"] is not None]
    if hourly:
        b = max(hourly, key=lambda d: d["per_hour"])
        best_hourly_day = {"short": b["short"], "name": b["name"], "per_hour": b["per_hour"]}

    # ---- Time-of-day + best individual (timed) shift --------------------
    # Income has no timestamp, so a shift's earnings are attributed by its day:
    # a day's income is split across that day's shifts in proportion to hours.
    day_income: Dict[str, float] = {}
    day_hours: Dict[str, float] = {}
    for x in incomes:
        if in_win(x):
            day_income[str(x["date"])[:10]] = day_income.get(str(x["date"])[:10], 0.0) + x["amount"]
    for s in shifts:
        if in_win(s):
            day_hours[str(s["date"])[:10]] = day_hours.get(str(s["date"])[:10], 0.0) + (s.get("hours") or 0)

    slots = [
        {"key": "morning", "label": "Morning", "sub": "5am–11am", "income": 0.0, "hours": 0.0, "per_hour": None},
        {"key": "midday", "label": "Midday", "sub": "11am–3pm", "income": 0.0, "hours": 0.0, "per_hour": None},
        {"key": "evening", "label": "Evening", "sub": "3pm–9pm", "income": 0.0, "hours": 0.0, "per_hour": None},
        {"key": "late", "label": "Late night", "sub": "9pm–5am", "income": 0.0, "hours": 0.0, "per_hour": None},
    ]
    slot_idx = {"morning": 0, "midday": 1, "evening": 2, "late": 3}

    def _slot_key(hhmm: str):
        try:
            h = int(str(hhmm).split(":")[0])
        except Exception:
            return None
        if 5 <= h < 11:
            return "morning"
        if 11 <= h < 15:
            return "midday"
        if 15 <= h < 21:
            return "evening"
        return "late"

    timed_shifts = []
    for s in shifts:
        if not in_win(s):
            continue
        h = s.get("hours") or 0
        st = s.get("start_time")
        if h <= 0 or not st:
            continue
        d = str(s["date"])[:10]
        dh = day_hours.get(d, 0.0)
        earned = (day_income.get(d, 0.0) * (h / dh)) if dh > 0 else 0.0
        per_hour = round(earned / h, 2) if h > 0 else None
        sk = _slot_key(st)
        if sk is not None:
            slots[slot_idx[sk]]["income"] += earned
            slots[slot_idx[sk]]["hours"] += h
        timed_shifts.append({
            "id": s.get("id"), "date": d, "start_time": st, "end_time": s.get("end_time"),
            "hours": round(h, 2), "income": round(earned, 2), "per_hour": per_hour,
            "platform": s.get("platform"),
        })
    for sl in slots:
        sl["income"] = round(sl["income"], 2)
        sl["hours"] = round(sl["hours"], 2)
        sl["per_hour"] = round(sl["income"] / sl["hours"], 2) if sl["hours"] > 0 else None

    by_timeofday = [sl for sl in slots]
    rated_slots = [sl for sl in slots if sl["per_hour"] is not None]
    best_timeofday = max(rated_slots, key=lambda s: s["per_hour"]) if rated_slots else None

    rated_shifts = [t for t in timed_shifts if t["per_hour"] is not None]
    best_shift = max(rated_shifts, key=lambda t: t["per_hour"]) if rated_shifts else None
    worst_shift = min(rated_shifts, key=lambda t: t["per_hour"]) if len(rated_shifts) > 1 else None
    has_timed = len(rated_shifts) > 0

    return {
        "symbol": symbol,
        "weeks_back": weeks_back,
        "weekday_weeks": weekday_weeks,
        "weekly": weekly,
        "by_weekday": by,
        "best_earning_day": best_earning_day,
        "best_hourly_day": best_hourly_day,
        "has_income": total_income > 0,
        "has_hours": total_hours > 0,
        "avg_per_hour": round(total_income / total_hours, 2) if total_hours > 0 else None,
        "by_timeofday": by_timeofday,
        "best_timeofday": best_timeofday,
        "best_shift": best_shift,
        "worst_shift": worst_shift,
        "has_timed": has_timed,
    }



def tax_jar(profile: dict, report: dict, ref: date) -> Dict[str, Any]:
    """Recommended running 'set aside for taxes' balance for the tax year to date.
    US: self-employment tax + estimated federal income tax.
    AU: estimated income tax + GST to remit (if registered)."""
    country = profile.get("country", "AU")
    net = report["net_profit"]
    income = report["total_income"]
    sym = report.get("symbol", "$")
    fy_s = fy_start(ref, country)
    year_label = _fy_label(fy_s, country)

    if country == "US":
        se = report["se_tax"]["amount"]
        taxable = max(0.0, net - se / 2 - US_STD_DEDUCTION)  # half SE-tax is deductible
        fed = us_federal_income_tax(taxable)
        st_tax = report["se_tax"].get("state_tax", 0.0)
        st_code = report["se_tax"].get("state") or ""
        set_aside = round(se + fed + st_tax, 2)
        components = [
            {"label": "Self-employment tax", "amount": se},
            {"label": "Federal income tax (est.)", "amount": fed},
        ]
        if report["se_tax"].get("state_has_tax"):
            components.append({"label": f"State income tax (est. · {st_code})", "amount": st_tax})
        note = ("Estimate for a single filer with gig income only, after the standard "
                "deduction. Includes federal, self-employment and approximate state income "
                "tax. Save this for SE tax and quarterly 1040-ES payments. Not tax advice.")
    else:
        it = au_income_tax(max(0.0, net))
        gst_owed = max(0.0, report["bas"]["net_gst"]) if report.get("show_bas") else 0.0
        set_aside = round(it + gst_owed, 2)
        components = [{"label": "Income tax (est.)", "amount": it}]
        if report.get("show_bas"):
            components.append({"label": "GST to remit", "amount": round(gst_owed, 2)})
        note = ("Estimate based on this financial year's net profit as your only income, "
                "resident rates incl. Medicare levy. Not tax advice.")

    rate_pct = round(set_aside / net * 100, 1) if net > 0 else 0.0
    return {
        "set_aside": max(0.0, set_aside),
        "rate_pct": rate_pct,
        "net_profit": net,
        "income": income,
        "tax_year_label": year_label,
        "components": components,
        "symbol": sym,
        "note": note,
    }


def dashboard(profile: dict, trips, incomes, expenses, today: date,
              vehicles: Optional[List[dict]] = None) -> Dict[str, Any]:
    t_iso = today.isoformat()
    income_today = round(sum(i["amount"] for i in incomes if str(i["date"])[:10] == t_iso), 2)
    expense_today = round(sum(e["amount"] for e in expenses if str(e["date"])[:10] == t_iso), 2)
    business_today = round(sum(trip_business_km(t) for t in trips
                              if str(t["date"])[:10] == t_iso), 2)

    country = profile.get("country", "AU")
    # recurring status for the current quarter — summed across all vehicles
    q_start, q_end = period_range("quarter", today, country)
    veh_list = vehicles if vehicles else (
        [{"recurring_payment": profile.get("recurring_payment")}]
        if profile.get("recurring_payment") else [])
    recs = [v.get("recurring_payment") for v in veh_list if v.get("recurring_payment")]
    rec_owed = round(sum(recurring_owed(r, q_start, q_end, today) for r in recs), 2)
    rec_enabled = any(r and r.get("amount") for r in recs)
    rec_amount = round(sum(float(r.get("amount") or 0) for r in recs), 2) if rec_enabled else None
    next_dues = [next_due_date(r, today) for r in recs if r]
    next_dues = [d for d in next_dues if d]
    next_due = min(next_dues) if next_dues else None
    freq = recs[0].get("frequency") if len(recs) == 1 else ("mixed" if len(recs) > 1 else None)

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

    if country == "US":
        tax_setup_complete = bool(profile.get("legal_name"))
    else:
        tax_setup_complete = bool(profile.get("legal_name")) and \
            profile.get("registration_status") in ("registered", "not_registered")

    year_report = compute_report(profile, trips, incomes, expenses, "year", today, vehicles)
    jar = tax_jar(profile, year_report, today)

    return {
        "date": t_iso,
        "income_today": income_today,
        "expense_today": expense_today,
        "net_today": round(income_today - expense_today, 2),
        "business_distance_today": business_today,
        "currency": "USD" if country == "US" else "AUD", "symbol": "$",
        "distance_unit": "mi" if country == "US" else "km",
        "recurring": {
            "enabled": rec_enabled,
            "amount": rec_amount,
            "frequency": freq,
            "owed_this_quarter": rec_owed,
            "next_due": next_due,
            "quarter_label": fmt_period_label("quarter", q_start, q_end, country),
        },
        "recent": items[:8],
        "tax_setup_complete": tax_setup_complete,
        "tax_jar": jar,
    }


# ---------------------------------------------------------------------------
# Money overview — the redesigned Money page (Money Now / Performance /
# Intelligence). Combines earnings, expenses, mileage, hours and an estimated
# tax position so a driver sees what their work is really worth after costs.
# ---------------------------------------------------------------------------
_PERIOD_WORD = {"today": "today", "week": "this week", "month": "this month", "year": "this FY"}


def _period_bounds(period: str, ref: date, country: str):
    if period == "today":
        return ref, ref + timedelta(days=1)
    return period_range(period, ref, country)


def _prev_bounds(period: str, ref: date, country: str):
    if period == "today":
        return ref - timedelta(days=1), ref
    start, _ = _period_bounds(period, ref, country)
    return _period_bounds(period, start - timedelta(days=1), country)


def money_overview(profile: dict, trips, incomes, expenses, shifts, ref: date,
                   period: str = "week", vehicles: Optional[List[dict]] = None) -> Dict[str, Any]:
    country = profile.get("country", "AU")
    sym = "$"
    unit = "mi" if country == "US" else "km"
    shifts = shifts or []

    start, end = _period_bounds(period, ref, country)

    def in_range(row, s, e):
        d = parse_date(row["date"])
        return s <= d < e

    # ---- YTD tax engine → effective tax rate applied to period profit --------
    year_report = compute_report(profile, trips, incomes, expenses, "year", ref, vehicles)
    jar = tax_jar(profile, year_report, ref)
    ytd_net = year_report["net_profit"]
    ytd_tax = jar["set_aside"]
    eff_rate = (ytd_tax / ytd_net) if ytd_net > 0 else 0.0
    eff_rate = min(max(eff_rate, 0.0), 0.6)  # sanity clamp

    def core(s, e):
        gross = sum(i["amount"] for i in incomes if in_range(i, s, e))
        exp = sum(x["amount"] for x in expenses if in_range(x, s, e))
        profit = gross - exp
        tax = max(0.0, profit) * eff_rate
        return round(gross, 2), round(exp, 2), round(profit, 2), round(tax, 2), round(profit - tax, 2)

    gross, expenses_total, profit_before_tax, estimated_tax, money_after_tax = core(start, end)
    keep_rate = round(money_after_tax / gross * 100, 1) if gross > 0 else None

    biz_km = round(sum(trip_business_km(t) for t in trips if in_range(t, start, end)), 2)
    hours = round(sum((s.get("hours") or 0) for s in shifts if in_range(s, start, end)), 2)

    money_now = {
        "take_home": money_after_tax,
        "gross": gross,
        "expenses": expenses_total,
        "estimated_tax": estimated_tax,
        "profit_before_tax": profit_before_tax,
        "keep_rate": keep_rate,
        "effective_tax_rate": round(eff_rate * 100, 1),
    }

    performance = {
        "hours": hours,
        "km": biz_km,
        "gross_per_hour": round(gross / hours, 2) if hours > 0 else None,
        "real_per_hour": round(money_after_tax / hours, 2) if hours > 0 else None,
        "per_km": round(gross / biz_km, 2) if biz_km > 0 else None,
        "cost_per_km": round(expenses_total / biz_km, 2) if biz_km > 0 else None,
        "profit_per_km": round(profit_before_tax / biz_km, 2) if biz_km > 0 else None,
    }

    # ---- Where your money went (period) -------------------------------------
    cat = {c: 0.0 for c in ["fuel", "tolls", "vehicle", "phone", "other"]}
    for e in expenses:
        if in_range(e, start, end):
            c = e.get("category", "other")
            cat[c] = cat.get(c, 0.0) + e["amount"]
    where = [
        {"label": "Fuel / charging", "amount": round(cat["fuel"], 2)},
        {"label": "Vehicle costs", "amount": round(cat["vehicle"], 2)},
        {"label": "Tolls", "amount": round(cat["tolls"], 2)},
        {"label": "Phone", "amount": round(cat["phone"], 2)},
        {"label": "Other expenses", "amount": round(cat["other"], 2)},
        {"label": "Estimated tax", "amount": estimated_tax},
    ]
    where = [w for w in where if w["amount"] > 0]

    # ---- Intelligence window (today -> last 30 days for meaningful stats) ----
    if period == "today":
        w_start, w_end = ref - timedelta(days=29), ref + timedelta(days=1)
        intel_label = "last 30 days"
    else:
        w_start, w_end = start, end
        intel_label = _PERIOD_WORD.get(period, "this period")

    # best / worst day by real $/hr (needs hours & income)
    days: Dict[str, dict] = {}

    def day_bucket(iso):
        return days.setdefault(iso, {"date": iso, "income": 0.0, "expenses": 0.0, "hours": 0.0, "km": 0.0})
    for i in incomes:
        if in_range(i, w_start, w_end):
            day_bucket(str(i["date"])[:10])["income"] += i["amount"]
    for x in expenses:
        if in_range(x, w_start, w_end):
            day_bucket(str(x["date"])[:10])["expenses"] += x["amount"]
    for s in shifts:
        if in_range(s, w_start, w_end):
            day_bucket(str(s["date"])[:10])["hours"] += (s.get("hours") or 0)
    for t in trips:
        if in_range(t, w_start, w_end):
            day_bucket(str(t["date"])[:10])["km"] += trip_business_km(t)

    def day_stat(d):
        prof = d["income"] - d["expenses"]
        after = prof - max(0.0, prof) * eff_rate
        return {
            "date": d["date"],
            "income": round(d["income"], 2),
            "expenses": round(d["expenses"], 2),
            "hours": round(d["hours"], 2),
            "km": round(d["km"], 2),
            "profit_before_tax": round(prof, 2),
            "real_per_hour": round(after / d["hours"], 2) if d["hours"] > 0 else None,
            "per_km": round(d["income"] / d["km"], 2) if d["km"] > 0 else None,
        }
    rated = [day_stat(d) for d in days.values() if d["hours"] > 0 and d["income"] > 0]
    best_day = max(rated, key=lambda d: d["real_per_hour"]) if rated else None
    worst_day = min(rated, key=lambda d: d["real_per_hour"]) if len(rated) > 1 else None

    # best platform by $/hr (fallback: gross)
    plat: Dict[str, dict] = {}
    for i in incomes:
        if in_range(i, w_start, w_end):
            name = i.get("platform") or "Other"
            plat.setdefault(name, {"income": 0.0, "hours": 0.0})["income"] += i["amount"]
    for s in shifts:
        if in_range(s, w_start, w_end):
            name = s.get("platform") or "Other"
            plat.setdefault(name, {"income": 0.0, "hours": 0.0})["hours"] += (s.get("hours") or 0)
    platforms = []
    for name, v in plat.items():
        platforms.append({
            "name": name,
            "income": round(v["income"], 2),
            "hours": round(v["hours"], 2),
            "per_hour": round(v["income"] / v["hours"], 2) if v["hours"] > 0 else None,
        })
    with_hr = [p for p in platforms if p["per_hour"] is not None]
    if with_hr:
        best_platform = max(with_hr, key=lambda p: p["per_hour"])
        platform_metric = "per_hour"
    elif platforms:
        best_platform = max(platforms, key=lambda p: p["income"])
        platform_metric = "income"
    else:
        best_platform, platform_metric = None, "income"

    # deductions tracked (YTD, from the tax engine)
    ded_total = year_report["total_deductions"]
    vehded = year_report.get("vehicle_deduction", {})
    fullc = year_report.get("full_claim", {})
    deductions = {
        "total": ded_total,
        "breakdown": [
            {"label": "Vehicle & mileage", "amount": round(vehded.get("total", 0), 2)},
            {"label": "Phone", "amount": round(fullc.get("phone", 0), 2)},
            {"label": "Tolls", "amount": round(fullc.get("tolls", 0), 2)},
            {"label": "Other", "amount": round(fullc.get("other", 0), 2)},
        ],
        "estimated_tax_impact": round(ded_total * eff_rate, 2),
        "tax_year_label": jar.get("tax_year_label"),
    }
    deductions["breakdown"] = [b for b in deductions["breakdown"] if b["amount"] > 0]

    # tax position (YTD owed vs what the driver has actually set aside)
    set_aside = float(profile.get("tax_set_aside") or 0.0)
    position = round(set_aside - ytd_tax, 2)
    tax_position = {
        "owed_ytd": round(ytd_tax, 2),
        "set_aside": round(set_aside, 2),
        "position": position,             # +ve ahead, -ve behind
        "status": "ahead" if position >= 0 else "behind",
        "recommend_rate": jar.get("rate_pct", 0.0),  # % of profit to set aside
        "tax_year_label": jar.get("tax_year_label"),
    }

    # trend — real earnings vs previous equivalent period
    ps, pe = _prev_bounds(period, ref, country)
    _, _, _, _, prev_after = core(ps, pe)
    trend_pct = None
    if abs(prev_after) > 0.01:
        trend_pct = round((money_after_tax - prev_after) / abs(prev_after) * 100, 1)

    return {
        "period": period,
        "period_label": (start.strftime("%d/%m/%Y") if period == "today"
                         else fmt_period_label(period, start, end, country)),
        "period_start": start.isoformat(),
        "symbol": sym,
        "distance_unit": unit,
        "country": country,
        "money_now": money_now,
        "performance": performance,
        "where": where,
        "intel_label": intel_label,
        "best_day": best_day,
        "worst_day": worst_day,
        "best_platform": best_platform,
        "platform_metric": platform_metric,
        "platforms": sorted(platforms, key=lambda p: p["income"], reverse=True),
        "deductions": deductions,
        "tax_position": tax_position,
        "trend_pct": trend_pct,
        "prev_take_home": round(prev_after, 2),
    }




# ---------------------------------------------------------------------------
# Tax Mileage engine — ATO logbook, method comparison, odometer reconciliation
# ---------------------------------------------------------------------------
def _fy_bounds(ref: date, country: str = "AU"):
    start = fy_start(ref, country)
    end = date(start.year + 1, 1, 1) if country == "US" else date(start.year + 1, 7, 1)
    return start, end


def _fy_label(start: date, country: str = "AU") -> str:
    if country == "US":
        return str(start.year)          # US tax year = calendar year
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


def logbook_summary(profile: dict, trips: List[dict], ref: date,
                    country: str = "AU") -> Dict[str, Any]:
    us = country == "US"
    fy_s, fy_e = _fy_bounds(ref, country)
    fy_trips = [t for t in trips if fy_s <= parse_date(t["date"]) < fy_e]
    dfmt = "%m/%d/%Y" if us else DATE_FMT
    # US IRS wants a mileage log for the whole tax year (no 12-week window).
    if us:
        biz = round(sum(trip_business_km(t) for t in fy_trips), 2)
        tot = round(sum(float(t["distance_km"]) for t in fy_trips), 2)
        if tot <= 0:
            return {"available": False, "business_pct": None,
                    "message": "Log business and personal miles to build your IRS mileage log."}
        journeys = []
        for t in sorted(fy_trips, key=lambda x: parse_date(x["date"])):
            journeys.append({
                "id": t.get("id"), "date": str(t["date"])[:10],
                "date_label": parse_date(t["date"]).strftime(dfmt),
                "distance_km": round(float(t["distance_km"]), 2),
                "business_km": trip_business_km(t),
                "type": t.get("type", "business"), "purpose": t.get("purpose"),
                "from_label": t.get("from_label"), "to_label": t.get("to_label"),
                "odo_start": t.get("odo_start"), "odo_end": t.get("odo_end"),
            })
        return {
            "available": True, "us_mode": True,
            "period_start": fy_s.isoformat(), "period_end": (fy_e - timedelta(days=1)).isoformat(),
            "period_label": _fy_label(fy_s, country),
            "business_km": biz, "private_km": round(tot - biz, 2), "total_km": tot,
            "business_pct": round(biz / tot * 100, 2),
            "journey_count": len(fy_trips), "complete": True,
            "journeys": journeys[:200],
            "note": ("Keep a contemporaneous mileage log — date, purpose and miles for "
                     "each business trip supports your Schedule C car expenses."),
        }

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


def _fy_vehicle_expenses(expenses: List[dict], fy_start: date, fy_end: date,
                         recurring_payment: Optional[dict]):
    cats = {"fuel": 0.0, "vehicle": 0.0, "tolls": 0.0, "phone": 0.0, "other": 0.0}
    for e in expenses:
        d = parse_date(e["date"])
        if fy_start <= d < fy_end:
            c = e.get("category", "other")
            cats[c] = cats.get(c, 0.0) + float(e.get("amount") or 0)
    recurring = recurring_owed(recurring_payment, fy_start, fy_end, date.today())
    cats = {k: round(v, 2) for k, v in cats.items()}
    # Eligible for the vehicle-cost pool (running costs apportioned by business use).
    eligible = round(cats["fuel"] + cats["vehicle"] + recurring, 2)
    return cats, round(recurring, 2), eligible


def method_comparison(profile: dict, trips: List[dict], expenses: List[dict],
                      ref: date, vehicle: Optional[dict] = None,
                      country: str = "AU") -> Dict[str, Any]:
    us = country == "US"
    unit = "mi" if us else "km"
    fy_s, fy_e = _fy_bounds(ref, country)
    fy_trips = [t for t in trips if fy_s <= parse_date(t["date"]) < fy_e]
    business_km = round(sum(trip_business_km(t) for t in fy_trips), 2)
    total_km = round(sum(float(t["distance_km"]) for t in fy_trips), 2)

    if us:
        # US actual-expense method uses annual business-use % (miles), not a 12-week window.
        logbook_pct = (business_km / total_km) if total_km > 0 else \
            float(profile.get("business_use_fallback", 100)) / 100.0
        pct_source = "annual" if total_km > 0 else "fallback"
    else:
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

    recurring_payment = (vehicle or {}).get("recurring_payment") if vehicle else profile.get("recurring_payment")
    cats, recurring, eligible = _fy_vehicle_expenses(expenses, fy_s, fy_e, recurring_payment)
    actual_deduction = round(eligible * logbook_pct, 2)  # "logbook" (AU) / "actual" (US)

    if us:
        rate = us_mileage_rate(fy_s)
        mileage_deduction = us_standard_mileage_deduction(fy_trips)  # date-keyed, no cap
        capped = False
        claimable = business_km
        max_deduction = None
        rate_detail = f"{business_km:g} mi \u00b7 IRS rate"
    else:
        rate = cpk_rate(fy_s.year)
        claimable = min(business_km, AU_CPK_MAX_KM)
        mileage_deduction = round(claimable * rate, 2)
        capped = business_km > AU_CPK_MAX_KM
        max_deduction = round(AU_CPK_MAX_KM * rate, 2)
        rate_detail = f"{round(rate * 100)}c \u00d7 {round(claimable)} km{' (cap)' if capped else ''}"

    # "logbook" key = the % / actual-cost method; "cents_per_km" key = the flat mileage method.
    recommend = "logbook" if actual_deduction >= mileage_deduction else "cents_per_km"
    difference = round(abs(actual_deduction - mileage_deduction), 2)

    actual_title = "Actual expenses" if us else "Logbook"
    mileage_title = "Standard mileage" if us else "Cents / km"
    label_actual = "Actual expense method" if us else "Logbook method"
    label_mileage = "Standard mileage" if us else "Cents per kilometre"
    disclaimer = (
        "This is an estimate, not tax advice. Your final deduction depends on your "
        "actual expenses and IRS rules — report car & truck expenses on Schedule C."
        if us else
        "This is an estimate, not tax advice. Your final deduction depends on your "
        "actual eligible expenses, vehicle circumstances and ATO requirements.")

    return {
        "country": country,
        "unit": unit,
        "fy_start": fy_s.isoformat(),
        "fy_end": fy_e.isoformat(),
        "fy_label": _fy_label(fy_s, country),
        "business_km": business_km,
        "total_km": total_km,
        "logbook": {
            "title": actual_title,
            "business_pct": round(logbook_pct * 100, 2),
            "pct_source": pct_source,
            "eligible_expenses": eligible,
            "expense_breakdown": {"fuel": cats["fuel"], "vehicle": cats["vehicle"],
                                   "recurring_payment": recurring},
            "deduction": actual_deduction,
        },
        "cents_per_km": {
            "title": mileage_title,
            "detail": rate_detail,
            "rate": rate,
            "rate_cents": round(rate * 100),
            "max_km": None if us else AU_CPK_MAX_KM,
            "claimable_km": round(claimable, 2),
            "capped": capped,
            "deduction": mileage_deduction,
            "max_deduction": max_deduction,
        },
        "recommend": recommend,
        "recommend_label": label_actual if recommend == "logbook" else label_mileage,
        "recommended_deduction": actual_deduction if recommend == "logbook" else mileage_deduction,
        "difference": difference,
        "disclaimer": disclaimer,
    }


def odometer_check(vehicle: Optional[dict], trips: List[dict], ref: date) -> Dict[str, Any]:
    fy_start, fy_end = _fy_bounds(ref)
    v = vehicle or {}
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
                expenses: List[dict], ref: date,
                vehicles: Optional[List[dict]] = None,
                vehicle_id: Optional[str] = None) -> Dict[str, Any]:
    country = profile.get("country", "AU")
    us = country == "US"
    unit = "mi" if us else "km"
    fy_start, fy_end = _fy_bounds(ref, country)
    t_iso = ref.isoformat()

    def in_fy(row):
        return fy_start <= parse_date(row["date"]) < fy_end

    veh_list = vehicles or []
    active = next((v for v in veh_list if v.get("is_active")), None)
    selected = None
    if vehicle_id:
        selected = next((v for v in veh_list if v.get("id") == vehicle_id), None)
    selected = selected or active or (veh_list[0] if veh_list else None)
    sel_id = selected.get("id") if selected else None

    def veh_trips(vid):
        return [t for t in trips if t.get("vehicle_id") == vid]

    def veh_exp(vid):
        return [e for e in expenses if e.get("vehicle_id") == vid]

    v_trips = veh_trips(sel_id) if sel_id else trips
    v_exp = veh_exp(sel_id) if sel_id else expenses

    # ---- today (driver-level snapshot across all cars) ----
    today_trips = [t for t in trips if str(t["date"])[:10] == t_iso]
    today_biz = round(sum(trip_business_km(t) for t in today_trips), 2)
    today_priv = round(sum(trip_personal_km(t) for t in today_trips), 2)
    today_total = round(today_biz + today_priv, 2)
    today_income = round(sum(i["amount"] for i in incomes if str(i["date"])[:10] == t_iso), 2)

    # ---- financial year (driver-level snapshot across all cars) ----
    fy_trips = [t for t in trips if in_fy(t)]
    fy_biz = round(sum(trip_business_km(t) for t in fy_trips), 2)
    fy_priv = round(sum(trip_personal_km(t) for t in fy_trips), 2)
    fy_total = round(fy_biz + fy_priv, 2)
    fy_income = round(sum(i["amount"] for i in incomes if in_fy(i)), 2)

    # ---- per-vehicle summaries (each car keeps its own logbook + deduction) ----
    summaries = []
    for v in veh_list:
        vt = veh_trips(v["id"])
        ve = veh_exp(v["id"])
        mc = method_comparison(profile, vt, ve, ref, vehicle=v, country=country)
        summaries.append({
            "id": v["id"],
            "name": v.get("name") or v.get("make_model") or "Vehicle",
            "registration": v.get("registration"),
            "is_active": bool(v.get("is_active")),
            "business_km": mc["business_km"],
            "business_pct": mc["logbook"]["business_pct"],
            "recommend_label": mc["recommend_label"],
            "deduction": mc["recommended_deduction"],
        })

    return {
        "country": country,
        "currency": "USD" if us else "AUD", "symbol": "$", "distance_unit": unit,
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
            "label": _fy_label(fy_start, country),
            "start": fy_start.isoformat(),
            "end": fy_end.isoformat(),
            "total_km": fy_total,
            "business_km": fy_biz,
            "private_km": fy_priv,
            "business_pct": round(fy_biz / fy_total * 100, 2) if fy_total > 0 else 0.0,
            "income": fy_income,
            "per_business_km": round(fy_income / fy_biz, 2) if fy_biz > 0 else None,
        },
        "logbook": logbook_summary(profile, v_trips, ref, country),
        "method_comparison": method_comparison(profile, v_trips, v_exp, ref, vehicle=selected, country=country),
        "odometer": odometer_check(selected, v_trips, ref),
        "vehicle": selected or (profile.get("vehicle") or {}),
        "vehicles": summaries,
        "selected_vehicle_id": sel_id,
        "active_vehicle_id": active.get("id") if active else sel_id,
    }

