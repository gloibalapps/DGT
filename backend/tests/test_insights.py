"""Tests for the /api/insights endpoint (weekly recap + best day to drive)."""
import uuid
from datetime import date, timedelta

REF = "2026-08-14"  # a Friday


def _monday_of_ref():
    ref = date.fromisoformat(REF)
    return ref - timedelta(days=ref.weekday())


class TestInsights:
    def test_shape_empty(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={"profile_id": pid})
        j = api_client.get(f"{base_url}/api/insights",
                           params={"profile_id": pid, "ref_date": REF}).json()
        assert j["has_income"] is False
        assert j["has_hours"] is False
        assert len(j["weekly"]) == j["weeks_back"]
        assert len(j["by_weekday"]) == 7
        assert j["best_earning_day"] is None
        assert j["best_hourly_day"] is None

    def test_best_hourly_day(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={"profile_id": pid})
        monday = _monday_of_ref()
        sat = (monday + timedelta(days=5)).isoformat()   # Saturday
        tue = (monday + timedelta(days=1)).isoformat()   # Tuesday
        # Saturday: $200 over 4h => $50/h ; Tuesday: $150 over 6h => $25/h
        api_client.post(f"{base_url}/api/income", json={"profile_id": pid, "date": sat, "amount": 200, "tax_treatment": "inclusive"})
        api_client.post(f"{base_url}/api/shifts", json={"profile_id": pid, "date": sat, "hours": 4})
        api_client.post(f"{base_url}/api/income", json={"profile_id": pid, "date": tue, "amount": 150, "tax_treatment": "inclusive"})
        api_client.post(f"{base_url}/api/shifts", json={"profile_id": pid, "date": tue, "hours": 6})

        j = api_client.get(f"{base_url}/api/insights",
                           params={"profile_id": pid, "ref_date": REF}).json()
        assert j["has_income"] is True
        assert j["has_hours"] is True
        assert j["best_hourly_day"]["name"] == "Saturday"
        assert j["best_hourly_day"]["per_hour"] == 50.0
        assert j["best_earning_day"]["name"] == "Saturday"
        # weekday buckets carry per_hour
        by = {d["short"]: d for d in j["by_weekday"]}
        assert by["Tue"]["per_hour"] == 25.0
