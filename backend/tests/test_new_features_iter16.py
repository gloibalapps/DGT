"""Iteration 16 — confirmation pass for two new features:
   (1) Active-vs-Online hours logging with per-platform breakdown
   (2) AU GST ride-sourcing correctness (passengers/both vs delivery-only)
"""
import os
import uuid
from datetime import date

import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")


def _pid():
    return f"TEST_iter16_{uuid.uuid4().hex[:10]}"


@pytest.fixture
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# --- FEATURE 1: Active vs Online hours -------------------------------------
class TestActiveVsOnlineHours:
    def test_active_hours_utilisation_and_by_platform(self, client):
        pid = _pid()
        # Onboard AU delivery with two platforms
        r = client.put(f"{BASE_URL}/api/profile", json={
            "profile_id": pid, "country": "AU", "work_type": "delivery",
            "platforms": ["Uber Eats", "DoorDash"], "vehicle_ownership": "own",
        })
        assert r.status_code == 200, r.text

        today = date.today().isoformat()

        # Shift with online=8h, active split UberEats=3.5, DoorDash=2.0
        r = client.post(f"{BASE_URL}/api/shifts", json={
            "profile_id": pid, "date": today, "hours": 8,
            "platform": "Uber Eats",
            "active_by_platform": {"Uber Eats": 3.5, "DoorDash": 2.0},
        })
        assert r.status_code in (200, 201), r.text

        # Two income rows same day
        for plat, amt in [("Uber Eats", 120), ("DoorDash", 80)]:
            r = client.post(f"{BASE_URL}/api/income", json={
                "profile_id": pid, "date": today, "amount": amt,
                "platform": plat, "tax_treatment": "inclusive",
            })
            assert r.status_code in (200, 201), r.text

        # Fetch money for the week containing today
        r = client.get(f"{BASE_URL}/api/money", params={
            "profile_id": pid, "period": "week", "ref_date": today,
        })
        assert r.status_code == 200, r.text
        data = r.json()
        perf = data.get("performance") or {}

        # Check core new fields exist
        assert perf.get("active_hours") == pytest.approx(5.5, rel=1e-3), perf
        assert perf.get("utilisation") is not None, perf
        # 5.5/8 = 68.75 -> rounded 68.8
        assert perf["utilisation"] == pytest.approx(68.8, abs=0.2), perf
        assert perf.get("real_active_per_hour") is not None, perf
        assert perf.get("active_per_hour") is not None, perf

        by_plat = perf.get("by_platform") or []
        assert isinstance(by_plat, list) and len(by_plat) >= 2, by_plat
        by_map = {p["platform"]: p for p in by_plat}
        assert "Uber Eats" in by_map and "DoorDash" in by_map, by_map
        assert by_map["Uber Eats"]["active_hours"] == pytest.approx(3.5, rel=1e-3)
        assert by_map["Uber Eats"]["income"] == pytest.approx(120.0, rel=1e-3)
        assert by_map["Uber Eats"]["per_active_hour"] == pytest.approx(120 / 3.5, rel=1e-2)
        assert by_map["DoorDash"]["active_hours"] == pytest.approx(2.0, rel=1e-3)
        assert by_map["DoorDash"]["per_active_hour"] == pytest.approx(40.0, rel=1e-2)

    def test_active_hours_greater_than_online_would_fail_frontend_only(self, client):
        # Backend accepts any active_by_platform values — frontend guards this.
        # We just confirm the endpoint doesn't crash.
        pid = _pid()
        client.put(f"{BASE_URL}/api/profile", json={
            "profile_id": pid, "country": "AU", "work_type": "delivery",
            "platforms": ["Uber Eats"], "vehicle_ownership": "own",
        })
        r = client.post(f"{BASE_URL}/api/shifts", json={
            "profile_id": pid, "date": date.today().isoformat(),
            "hours": 4, "platform": "Uber Eats",
            "active_by_platform": {"Uber Eats": 3.0},
        })
        assert r.status_code in (200, 201)


# --- FEATURE 2: AU GST ride-sourcing ---------------------------------------
class TestAuGstRidesourcing:
    def test_passengers_shows_bas_even_when_not_registered(self, client):
        pid = _pid()
        r = client.put(f"{BASE_URL}/api/profile", json={
            "profile_id": pid, "country": "AU", "work_type": "passengers",
            "platforms": ["Uber"], "vehicle_ownership": "own",
        })
        assert r.status_code == 200, r.text

        # Add a small ride-sourcing income
        today = date.today().isoformat()
        client.post(f"{BASE_URL}/api/income", json={
            "profile_id": pid, "date": today, "amount": 220.0,
            "platform": "Uber", "tax_treatment": "inclusive",
        })

        r = client.get(f"{BASE_URL}/api/reports", params={
            "profile_id": pid, "period": "quarter", "ref_date": today,
        })
        assert r.status_code == 200, r.text
        rep = r.json()
        assert rep.get("show_bas") is True, rep
        assert rep.get("gst_required") is True, rep
        assert rep.get("gst_registered") is False, rep
        assert rep.get("gst_note"), "gst_note must be a non-empty string"
        assert "Ride-sourcing" in rep["gst_note"] or "ride-sourcing" in rep["gst_note"].lower()
        assert rep.get("registration_warning"), rep
        # BAS block populated
        bas = rep.get("bas") or {}
        assert bas.get("G1") == pytest.approx(220.0)
        assert bas.get("1A") == pytest.approx(20.0, abs=0.02)  # 220 / 11

    def test_both_worktype_also_shows_bas(self, client):
        pid = _pid()
        client.put(f"{BASE_URL}/api/profile", json={
            "profile_id": pid, "country": "AU", "work_type": "both",
            "platforms": ["Uber"], "vehicle_ownership": "own",
        })
        r = client.get(f"{BASE_URL}/api/reports", params={
            "profile_id": pid, "period": "quarter",
            "ref_date": date.today().isoformat(),
        })
        assert r.status_code == 200
        rep = r.json()
        assert rep["show_bas"] is True
        assert rep["gst_required"] is True

    def test_delivery_only_under_threshold_hides_bas(self, client):
        pid = _pid()
        client.put(f"{BASE_URL}/api/profile", json={
            "profile_id": pid, "country": "AU", "work_type": "delivery",
            "platforms": ["Uber Eats"], "vehicle_ownership": "own",
        })
        today = date.today().isoformat()
        client.post(f"{BASE_URL}/api/income", json={
            "profile_id": pid, "date": today, "amount": 500.0,
            "platform": "Uber Eats", "tax_treatment": "inclusive",
        })
        r = client.get(f"{BASE_URL}/api/reports", params={
            "profile_id": pid, "period": "quarter", "ref_date": today,
        })
        assert r.status_code == 200
        rep = r.json()
        assert rep["show_bas"] is False, rep
        assert rep["gst_required"] is False, rep
