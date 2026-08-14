"""Tests for the /api/performance endpoint (last 4 weeks aggregations)."""
import uuid
from datetime import date, timedelta

import pytest


REF = "2026-08-14"  # per review-request context


def _weekday_iso_of_ref():
    """Return a date string that falls in the current-week window for REF (Mon-Sun)."""
    ref = date.fromisoformat(REF)
    monday = ref - timedelta(days=ref.weekday())
    return monday.isoformat()  # Monday of current week


class TestPerformance:
    def test_shape_and_length(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={"profile_id": pid})
        r = api_client.get(f"{base_url}/api/performance",
                           params={"profile_id": pid, "ref_date": REF})
        assert r.status_code == 200
        j = r.json()
        assert set(["weeks", "total_profit", "total_km", "total_hours",
                    "per_km", "per_hour", "symbol", "distance_unit"]).issubset(j.keys())
        assert isinstance(j["weeks"], list)
        assert len(j["weeks"]) == 4
        # oldest -> newest
        starts = [w["start"] for w in j["weeks"]]
        assert starts == sorted(starts)
        for w in j["weeks"]:
            assert set(["label", "income", "expenses", "profit",
                        "business_km", "hours"]).issubset(w.keys())

    def test_null_kpis_when_no_data(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={"profile_id": pid})
        j = api_client.get(f"{base_url}/api/performance",
                           params={"profile_id": pid, "ref_date": REF}).json()
        assert j["total_km"] == 0
        assert j["total_hours"] == 0
        assert j["per_km"] is None
        assert j["per_hour"] is None

    def test_expected_math(self, base_url, api_client):
        """Review-request exact math: income 600 + expense 90 + trip 120km/300min in current week
        => total_profit 510, per_km 5.0, per_hour 120.0."""
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={"profile_id": pid})
        d = _weekday_iso_of_ref()
        api_client.post(f"{base_url}/api/income", json={
            "profile_id": pid, "date": d, "amount": 600,
            "tax_treatment": "inclusive"})
        api_client.post(f"{base_url}/api/expenses", json={
            "profile_id": pid, "date": d, "amount": 90, "category": "fuel",
            "tax_treatment": "inclusive"})
        api_client.post(f"{base_url}/api/trips", json={
            "profile_id": pid, "date": d, "distance_km": 120,
            "duration_min": 300, "type": "business"})

        j = api_client.get(f"{base_url}/api/performance",
                           params={"profile_id": pid, "ref_date": REF}).json()
        assert j["total_profit"] == 510.0
        assert j["total_km"] == 120.0
        assert j["total_hours"] == 5.0
        assert j["per_km"] == 5.0
        assert j["per_hour"] == 120.0
        # current week (last in list) should carry the numbers
        cur = j["weeks"][-1]
        assert cur["income"] == 600.0
        assert cur["expenses"] == 90.0
        assert cur["profit"] == 510.0
        assert cur["business_km"] == 120.0
        assert cur["hours"] == 5.0
