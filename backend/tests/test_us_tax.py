"""US tax support tests — Schedule C, IRS standard mileage, SE tax + AU regression.

Covers the review-request scenarios end-to-end via the public API:
- US method comparison (date-keyed IRS rate, no cap; annual business-use % for actual)
- US logbook (whole tax year, us_mode=true, complete=true)
- US Schedule C report (car_and_truck, se_tax, MM/DD/YYYY period label)
- US calendar quarter + SE quarter due
- US CSV export
- AU regression (distance_unit km, cents_per_km 91c + 5000km cap, 12-week logbook, BAS)
- Multi-vehicle still works under both countries
"""
import os
import uuid
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")
BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")


def _pid():
    return f"TEST_{uuid.uuid4().hex[:12]}"


def _seed_profile(pid, country):
    r = requests.put(f"{BASE_URL}/api/profile",
                     json={"profile_id": pid, "country": country,
                           "legal_name": "Test Driver",
                           "registration_status": "registered" if country == "AU" else None})
    assert r.status_code == 200, r.text
    return r.json()


def _add_trip(pid, dt, dist, typ="business", vehicle_id=None):
    body = {"profile_id": pid, "date": dt, "distance_km": dist, "type": typ}
    if vehicle_id:
        body["vehicle_id"] = vehicle_id
    r = requests.post(f"{BASE_URL}/api/trips", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _add_expense(pid, dt, amount, category="fuel", vehicle_id=None):
    body = {"profile_id": pid, "date": dt, "amount": amount, "category": category}
    if vehicle_id:
        body["vehicle_id"] = vehicle_id
    r = requests.post(f"{BASE_URL}/api/expenses", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _add_income(pid, dt, amount):
    r = requests.post(f"{BASE_URL}/api/income",
                      json={"profile_id": pid, "date": dt, "amount": amount, "platform": "Uber"})
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# US: method comparison, date-keyed IRS rate, no cap
# ---------------------------------------------------------------------------
class TestUSMethodComparison:
    def test_us_standard_mileage_beats_actual(self):
        pid = _pid()
        _seed_profile(pid, "US")
        # 1000 mi in March (rate 0.725), 1000 mi in Aug (rate 0.76), 500 personal, $800 fuel
        _add_trip(pid, "2026-03-15", 1000, "business")
        _add_trip(pid, "2026-08-10", 1000, "business")
        _add_trip(pid, "2026-04-05", 500, "personal")
        _add_expense(pid, "2026-06-01", 800, "fuel")

        r = requests.get(f"{BASE_URL}/api/tax-mileage", params={"profile_id": pid,
                                                                 "ref_date": "2026-08-15"})
        assert r.status_code == 200, r.text
        tm = r.json()
        assert tm["country"] == "US"
        assert tm["distance_unit"] == "mi"
        assert tm["financial_year"]["label"] == "2026"

        mc = tm["method_comparison"]
        assert mc["cents_per_km"]["title"] == "Standard mileage"
        # date-keyed: 1000*0.725 + 1000*0.76 = 1485.0 (no cap)
        assert mc["cents_per_km"]["deduction"] == 1485.0
        assert mc["cents_per_km"]["max_km"] is None

        # actual = $800 * annual business-use %(80%) = 640
        assert mc["logbook"]["title"] == "Actual expenses"
        assert mc["logbook"]["pct_source"] == "annual"
        assert mc["logbook"]["business_pct"] == 80.0
        assert mc["logbook"]["deduction"] == 640.0

        assert mc["recommend_label"] == "Standard mileage"
        assert mc["recommend"] == "cents_per_km"


# ---------------------------------------------------------------------------
# US: logbook covers whole tax year, us_mode=true, complete=true
# ---------------------------------------------------------------------------
class TestUSLogbook:
    def test_us_logbook_whole_year(self):
        pid = _pid()
        _seed_profile(pid, "US")
        _add_trip(pid, "2026-03-15", 1000, "business")
        _add_trip(pid, "2026-08-10", 1000, "business")
        _add_trip(pid, "2026-04-05", 500, "personal")

        r = requests.get(f"{BASE_URL}/api/tax-mileage",
                         params={"profile_id": pid, "ref_date": "2026-08-15"})
        assert r.status_code == 200
        lb = r.json()["logbook"]
        assert lb["available"] is True
        assert lb.get("us_mode") is True
        assert lb["complete"] is True
        assert lb["period_start"] == "2026-01-01"
        assert lb["period_end"] == "2026-12-31"
        assert lb["business_km"] == 2000.0
        assert lb["total_km"] == 2500.0
        assert lb["business_pct"] == 80.0


# ---------------------------------------------------------------------------
# US: Schedule C report (year) + SE tax
# ---------------------------------------------------------------------------
class TestUSScheduleC:
    def test_us_schedule_c_year_report(self):
        pid = _pid()
        _seed_profile(pid, "US")
        _add_trip(pid, "2026-03-15", 1000, "business")
        _add_trip(pid, "2026-08-10", 1000, "business")
        _add_trip(pid, "2026-04-05", 500, "personal")
        _add_expense(pid, "2026-06-01", 800, "fuel")
        _add_income(pid, "2026-05-01", 5000)

        r = requests.get(f"{BASE_URL}/api/reports",
                         params={"profile_id": pid, "period": "year",
                                 "ref_date": "2026-08-15"})
        assert r.status_code == 200, r.text
        rep = r.json()
        assert rep["country"] == "US"
        assert rep["show_bas"] is False
        assert "bas" not in rep or rep.get("show_bas") is False

        sc = rep["schedule_c"]
        assert sc["gross_receipts"] == 5000.0
        assert sc["standard_mileage"] == 1485.0
        assert sc["actual_expenses"] == 640.0
        assert sc["car_and_truck"] == 1485.0
        assert sc["car_method_label"] == "Standard mileage"
        # net_profit = 5000 - (1485 + 0 other) = 3515
        assert sc["net_profit"] == 3515.0

        se = rep["se_tax"]
        assert se["net_earnings"] == round(0.9235 * 3515.0, 2)
        assert se["amount"] == round(se["net_earnings"] * 0.153, 2)

        # US period label uses MM/DD/YYYY
        assert "/" in rep["period_label"]
        assert rep["period_label"].startswith("01/01/2026")


# ---------------------------------------------------------------------------
# US: calendar quarter + SE quarter due
# ---------------------------------------------------------------------------
class TestUSQuarter:
    def test_us_quarter_range_and_due(self):
        pid = _pid()
        _seed_profile(pid, "US")
        r = requests.get(f"{BASE_URL}/api/reports",
                         params={"profile_id": pid, "period": "quarter",
                                 "ref_date": "2026-08-15"})
        assert r.status_code == 200
        rep = r.json()
        assert rep["country"] == "US"
        assert rep["period_start"] == "2026-07-01"
        assert rep["period_end"] == "2026-10-01"
        assert rep["se_tax"]["quarter_due"] == "15 Sep"
        assert rep["show_bas"] is False


# ---------------------------------------------------------------------------
# US: export-mileage CSV
# ---------------------------------------------------------------------------
class TestUSExport:
    def test_us_export_returns_csv(self):
        pid = _pid()
        _seed_profile(pid, "US")
        _add_trip(pid, "2026-03-15", 1000, "business")
        r = requests.get(f"{BASE_URL}/api/export-mileage",
                         params={"profile_id": pid, "ref_date": "2026-08-15"})
        assert r.status_code == 200
        assert "text/csv" in r.headers.get("content-type", "")
        assert "GigTax" in r.text


# ---------------------------------------------------------------------------
# AU regression — no changes to existing behaviour
# ---------------------------------------------------------------------------
class TestAURegression:
    def test_au_defaults_intact(self):
        pid = _pid()
        _seed_profile(pid, "AU")
        # 6000 business km to hit the 5000 cap; ref_date inside FY 2026-27 (starts 1 Jul 2026)
        _add_trip(pid, "2026-08-10", 6000, "business")
        _add_trip(pid, "2026-09-01", 500, "personal")
        _add_income(pid, "2026-08-15", 1100)  # inclusive → GST $100

        r = requests.get(f"{BASE_URL}/api/tax-mileage",
                         params={"profile_id": pid, "ref_date": "2026-08-15"})
        assert r.status_code == 200
        tm = r.json()
        assert tm["country"] == "AU"
        assert tm["distance_unit"] == "km"
        assert tm["financial_year"]["label"] == "2026\u201327"  # 2026-27 (en-dash)

        mc = tm["method_comparison"]
        assert mc["cents_per_km"]["title"] == "Cents / km"
        assert mc["cents_per_km"]["rate"] == 0.91
        assert mc["cents_per_km"]["max_km"] == 5000
        # capped at 5000 km * 0.91 = 4550
        assert mc["cents_per_km"]["capped"] is True
        assert mc["cents_per_km"]["deduction"] == 4550.0

        # Logbook = 12-week window, not us_mode
        lb = tm["logbook"]
        assert lb.get("us_mode") is not True

    def test_au_quarter_has_bas(self):
        pid = _pid()
        _seed_profile(pid, "AU")
        _add_income(pid, "2026-08-15", 1100)
        r = requests.get(f"{BASE_URL}/api/reports",
                         params={"profile_id": pid, "period": "quarter",
                                 "ref_date": "2026-08-15"})
        assert r.status_code == 200
        rep = r.json()
        assert rep.get("show_bas") is True
        assert "bas" in rep
        assert set(["G1", "1A", "1B"]).issubset(rep["bas"].keys())
        # AU BAS quarter Jul-Sep
        assert rep["period_start"] == "2026-07-01"
        assert rep["period_end"] == "2026-10-01"
        # DD/MM/YYYY label
        assert rep["period_label"].startswith("01/07/2026")


# ---------------------------------------------------------------------------
# Multi-vehicle works under US
# ---------------------------------------------------------------------------
class TestMultiVehicleUS:
    def test_multi_vehicle_us(self):
        pid = _pid()
        _seed_profile(pid, "US")
        # ensure a default vehicle
        vlist = requests.get(f"{BASE_URL}/api/vehicles", params={"profile_id": pid}).json()
        car1 = vlist[0]["id"]
        # Add second car
        add = requests.post(f"{BASE_URL}/api/vehicles",
                            json={"profile_id": pid, "name": "Car 2", "ownership": "own"})
        assert add.status_code == 200
        cars = add.json()
        car2 = [v for v in cars if v["name"] == "Car 2"][0]["id"]

        _add_trip(pid, "2026-03-15", 1000, "business", vehicle_id=car1)
        _add_trip(pid, "2026-08-10", 500, "business", vehicle_id=car2)

        r = requests.get(f"{BASE_URL}/api/tax-mileage",
                         params={"profile_id": pid, "ref_date": "2026-08-15",
                                 "vehicle_id": car2})
        assert r.status_code == 200
        tm = r.json()
        assert tm["country"] == "US"
        assert tm["selected_vehicle_id"] == car2
        # summary per vehicle exists
        assert len(tm["vehicles"]) == 2
        # method_comparison for car2 only: 500 mi * 0.76 (Aug 2026) = 380
        assert tm["method_comparison"]["cents_per_km"]["deduction"] == 380.0
