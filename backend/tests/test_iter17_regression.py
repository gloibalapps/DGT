"""Iteration 17 regression — verify P0 endpoints still return 200 after
manual-drive foreground-service refactor (frontend-only change, so backend
should be unaffected)."""
import os
import uuid
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")
BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")


@pytest.fixture
def pid():
    return f"TEST_iter17_{uuid.uuid4().hex[:8]}"


@pytest.fixture
def seeded_profile(pid):
    # Create profile
    r = requests.put(
        f"{BASE}/api/profile",
        json={
            "profile_id": pid,
            "country": "AU",
            "region": "NSW",
            "work_type": "delivery",
            "platforms": ["Uber Eats"],
            "vehicle_ownership": "own",
        },
    )
    assert r.status_code in (200, 201), f"profile create failed: {r.status_code} {r.text}"
    yield pid


class TestCoreEndpoints:
    def test_money_today(self, seeded_profile):
        r = requests.get(f"{BASE}/api/money", params={"profile_id": seeded_profile, "period": "today"})
        assert r.status_code == 200, r.text
        j = r.json()
        # Must have basic keys — don't over-assert schema
        assert isinstance(j, dict)

    def test_money_week(self, seeded_profile):
        r = requests.get(f"{BASE}/api/money", params={"profile_id": seeded_profile, "period": "week"})
        assert r.status_code == 200
        assert isinstance(r.json(), dict)

    def test_dashboard(self, seeded_profile):
        r = requests.get(f"{BASE}/api/dashboard", params={"profile_id": seeded_profile})
        assert r.status_code == 200
        assert isinstance(r.json(), dict)

    def test_reports_au_quarter(self, seeded_profile):
        r = requests.get(
            f"{BASE}/api/reports",
            params={"profile_id": seeded_profile, "period": "quarter"},
        )
        assert r.status_code == 200
        j = r.json()
        assert isinstance(j, dict)

    def test_reports_us_year(self, pid):
        # Fresh US profile
        requests.put(
            f"{BASE}/api/profile",
            json={
                "profile_id": pid,
                "country": "US",
                "region": "CA",
                "work_type": "delivery",
                "platforms": ["DoorDash"],
                "vehicle_ownership": "own",
            },
        )
        r = requests.get(f"{BASE}/api/reports", params={"profile_id": pid, "period": "year"})
        assert r.status_code == 200
        assert isinstance(r.json(), dict)

    def test_vehicles_list(self, seeded_profile):
        r = requests.get(f"{BASE}/api/vehicles", params={"profile_id": seeded_profile})
        assert r.status_code == 200
        assert isinstance(r.json(), list)


class TestTripsCRUD:
    def test_trip_create_read_delete(self, seeded_profile):
        # list initial
        r = requests.get(f"{BASE}/api/trips", params={"profile_id": seeded_profile})
        assert r.status_code == 200
        initial = r.json()
        assert isinstance(initial, list)

        # create
        payload = {
            "profile_id": seeded_profile,
            "date": "2026-01-15",
            "distance_km": 12.5,
            "duration_min": 20,
            "type": "business",
            "source": "gps",
        }
        r = requests.post(f"{BASE}/api/trips", json=payload)
        assert r.status_code in (200, 201), r.text
        created = r.json()
        tid = created.get("id")
        assert tid, f"no id returned: {created}"
        assert created.get("distance_km") == 12.5

        # verify persisted
        r = requests.get(f"{BASE}/api/trips", params={"profile_id": seeded_profile})
        assert r.status_code == 200
        ids = [t["id"] for t in r.json()]
        assert tid in ids

        # delete
        r = requests.delete(f"{BASE}/api/trips/{tid}", params={"profile_id": seeded_profile})
        assert r.status_code in (200, 204), r.text

        # verify gone
        r = requests.get(f"{BASE}/api/trips", params={"profile_id": seeded_profile})
        ids = [t["id"] for t in r.json()]
        assert tid not in ids


class TestAsk:
    def test_ask_endpoint(self, seeded_profile):
        r = requests.post(
            f"{BASE}/api/ask",
            json={"profile_id": seeded_profile, "question": "How is my week?"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert isinstance(j, dict)
        # answer key common — but don't be too strict
        assert any(k in j for k in ("answer", "text", "message", "reply"))
