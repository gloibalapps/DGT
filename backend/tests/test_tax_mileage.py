"""Tax Mileage backend tests — logbook, method comparison, odometer, export."""
import uuid
from datetime import date, timedelta

import pytest


# ---- helpers ---------------------------------------------------------------
def _au_fy_start(d: date) -> date:
    return date(d.year if d.month >= 7 else d.year - 1, 7, 1)


@pytest.fixture
def fresh_pid():
    return f"TEST_{uuid.uuid4().hex[:12]}"


# ---------------------------------------------------------------------------
# Tax Mileage endpoint — shape and today/FY summaries
# ---------------------------------------------------------------------------
class TestTaxMileageShape:
    def test_returns_all_sections(self, base_url, api_client, fresh_pid):
        api_client.get(f"{base_url}/api/profile", params={"profile_id": fresh_pid})
        r = api_client.get(f"{base_url}/api/tax-mileage",
                           params={"profile_id": fresh_pid})
        assert r.status_code == 200, r.text
        tm = r.json()
        for key in ("today", "financial_year", "logbook",
                    "method_comparison", "odometer", "vehicle"):
            assert key in tm, f"missing section: {key}"
        # basic today shape
        assert "total_km" in tm["today"] and "business_km" in tm["today"]
        assert "fy_label" in tm["method_comparison"]
        assert "recommend" in tm["method_comparison"]
        assert tm["method_comparison"]["recommend"] in ("logbook", "cents_per_km")


# ---------------------------------------------------------------------------
# Mixed trip business_pct → 60% of 50km = 30 business km
# ---------------------------------------------------------------------------
class TestMixedTrips:
    def test_mixed_trip_business_pct_applied(self, base_url, api_client, fresh_pid):
        api_client.get(f"{base_url}/api/profile", params={"profile_id": fresh_pid})
        today = date.today()
        r = api_client.post(f"{base_url}/api/trips", json={
            "profile_id": fresh_pid, "date": today.isoformat(),
            "distance_km": 50, "type": "mixed", "business_pct": 60,
        })
        assert r.status_code == 200, r.text
        tm = api_client.get(f"{base_url}/api/tax-mileage",
                            params={"profile_id": fresh_pid}).json()
        assert tm["financial_year"]["business_km"] == 30.0
        assert tm["financial_year"]["total_km"] == 50.0
        # method_comparison should reflect the same business km
        assert tm["method_comparison"]["business_km"] == 30.0

    def test_regression_reports_mixed_aware(self, base_url, api_client, fresh_pid):
        api_client.put(f"{base_url}/api/profile", json={
            "profile_id": fresh_pid, "work_type": "delivery",
            "registration_status": "registered",
        })
        today = date.today()
        api_client.post(f"{base_url}/api/trips", json={
            "profile_id": fresh_pid, "date": today.isoformat(),
            "distance_km": 100, "type": "mixed", "business_pct": 40,
        })
        rep = api_client.get(f"{base_url}/api/reports",
                             params={"profile_id": fresh_pid, "period": "quarter"}).json()
        assert rep["business_km"] == 40.0
        assert rep["personal_km"] == 60.0


# ---------------------------------------------------------------------------
# Cents-per-km rate & cap
# ---------------------------------------------------------------------------
class TestCentsPerKm:
    def test_fy2026_27_rate_91c_and_5000km_cap(self, base_url, api_client, fresh_pid):
        # ref date deep inside FY 2026-27 (Aug 2026 → FY starts July 2026)
        api_client.get(f"{base_url}/api/profile", params={"profile_id": fresh_pid})
        ref = "2026-08-15"
        # seed one giant business trip 6000km (over cap)
        api_client.post(f"{base_url}/api/trips", json={
            "profile_id": fresh_pid, "date": ref,
            "distance_km": 6000, "type": "business",
        })
        tm = api_client.get(f"{base_url}/api/tax-mileage",
                            params={"profile_id": fresh_pid, "ref_date": ref}).json()
        cpk = tm["method_comparison"]["cents_per_km"]
        assert cpk["rate"] == 0.91
        assert cpk["rate_cents"] == 91
        assert cpk["max_km"] == 5000
        assert cpk["claimable_km"] == 5000
        assert cpk["capped"] is True
        assert cpk["deduction"] == 4550.0  # 5000 * 0.91
        assert cpk["max_deduction"] == 4550.0


# ---------------------------------------------------------------------------
# Logbook 12-week window
# ---------------------------------------------------------------------------
class TestLogbook:
    def test_less_than_12_weeks_incomplete(self, base_url, api_client, fresh_pid):
        api_client.get(f"{base_url}/api/profile", params={"profile_id": fresh_pid})
        today = date.today()
        # 3 trips within a week
        for i in range(3):
            api_client.post(f"{base_url}/api/trips", json={
                "profile_id": fresh_pid,
                "date": (today - timedelta(days=i)).isoformat(),
                "distance_km": 20, "type": "business",
            })
        tm = api_client.get(f"{base_url}/api/tax-mileage",
                            params={"profile_id": fresh_pid}).json()
        lb = tm["logbook"]
        assert lb["available"] is True
        assert lb["complete"] is False

    def test_12_weeks_complete_window(self, base_url, api_client, fresh_pid):
        # Seed >12 weeks of trips inside FY 2025-26 (fully completed FY).
        api_client.get(f"{base_url}/api/profile", params={"profile_id": fresh_pid})
        # FY 2025-26: 2025-07-01 → 2026-06-30 (already finished)
        base = date(2025, 8, 1)
        span_days = 120  # >84
        for i in range(0, span_days, 3):
            d = base + timedelta(days=i)
            typ = "business" if i % 2 == 0 else "personal"
            api_client.post(f"{base_url}/api/trips", json={
                "profile_id": fresh_pid, "date": d.isoformat(),
                "distance_km": 25, "type": typ,
            })
        ref = "2026-06-15"  # inside FY 2025-26
        tm = api_client.get(f"{base_url}/api/tax-mileage",
                            params={"profile_id": fresh_pid, "ref_date": ref}).json()
        lb = tm["logbook"]
        assert lb["available"] is True, lb
        assert lb["complete"] is True, lb
        # window is 84 days (12 weeks); end_date - start_date == 83 days inclusive
        s = date.fromisoformat(lb["period_start"])
        e = date.fromisoformat(lb["period_end"])
        assert (e - s).days == 83


# ---------------------------------------------------------------------------
# Odometer reconciliation
# ---------------------------------------------------------------------------
class TestOdometer:
    def test_odometer_gps_discrepancy_warning(self, base_url, api_client, fresh_pid):
        # profile with vehicle odometers
        api_client.put(f"{base_url}/api/profile", json={
            "profile_id": fresh_pid,
            "vehicle": {"registration": "TST-001", "make_model": "Camry",
                        "opening_odometer": 10000, "closing_odometer": 20000,
                        "fuel_type": "petrol"},
        })
        today = date.today()
        # GPS only records ~5000km (huge discrepancy → warning)
        api_client.post(f"{base_url}/api/trips", json={
            "profile_id": fresh_pid, "date": today.isoformat(),
            "distance_km": 5000, "type": "business",
        })
        tm = api_client.get(f"{base_url}/api/tax-mileage",
                            params={"profile_id": fresh_pid}).json()
        odo = tm["odometer"]
        assert odo["has_odometer"] is True
        assert odo["odometer_km"] == 10000.0
        assert odo["gps_km"] == 5000.0
        assert odo["discrepancy"] == 5000.0
        assert odo["warning"] is not None
        assert odo["discrepancy_pct"] >= 10

    def test_odometer_absent_prompt(self, base_url, api_client, fresh_pid):
        api_client.get(f"{base_url}/api/profile", params={"profile_id": fresh_pid})
        tm = api_client.get(f"{base_url}/api/tax-mileage",
                            params={"profile_id": fresh_pid}).json()
        odo = tm["odometer"]
        assert odo["has_odometer"] is False
        assert odo["prompt"] is not None


# ---------------------------------------------------------------------------
# Export motor-vehicle report
# ---------------------------------------------------------------------------
class TestExportMileage:
    def test_export_returns_csv(self, base_url, api_client, fresh_pid):
        api_client.put(f"{base_url}/api/profile", json={
            "profile_id": fresh_pid,
            "vehicle": {"registration": "TST-002", "make_model": "Prius",
                        "opening_odometer": 5000, "closing_odometer": 15000,
                        "fuel_type": "hybrid"},
        })
        today = date.today()
        api_client.post(f"{base_url}/api/trips", json={
            "profile_id": fresh_pid, "date": today.isoformat(),
            "distance_km": 40, "type": "business",
        })
        r = api_client.get(f"{base_url}/api/export-mileage",
                           params={"profile_id": fresh_pid})
        assert r.status_code == 200
        assert "text/csv" in r.headers.get("content-type", "")
        body = r.text
        assert "Motor Vehicle Report" in body
        assert "Method comparison" in body
        assert "Prius" in body


# ---------------------------------------------------------------------------
# Regression: dashboard + performance still work with mixed trips
# ---------------------------------------------------------------------------
class TestRegressionExisting:
    def test_dashboard_and_performance_work(self, base_url, api_client, fresh_pid):
        api_client.put(f"{base_url}/api/profile", json={
            "profile_id": fresh_pid, "work_type": "delivery",
            "registration_status": "registered",
        })
        today = date.today()
        api_client.post(f"{base_url}/api/trips", json={
            "profile_id": fresh_pid, "date": today.isoformat(),
            "distance_km": 50, "type": "mixed", "business_pct": 60,
        })
        d = api_client.get(f"{base_url}/api/dashboard",
                           params={"profile_id": fresh_pid}).json()
        assert d["business_distance_today"] == 30.0
        p = api_client.get(f"{base_url}/api/performance",
                           params={"profile_id": fresh_pid}).json()
        assert "weeks" in p and len(p["weeks"]) == 4
