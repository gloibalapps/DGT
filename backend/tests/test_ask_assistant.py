"""Tests for POST /api/ask — grounded AI tax assistant (Claude Sonnet 4.6).

Verifies:
  * AU grounded question returns a substantive ATO answer.
  * AU out-of-scope question REFUSES (no fabrication).
  * US grounded question returns an IRS answer.
  * Regression endpoints (dashboard, tax-mileage, reports, vehicles) still 200.
"""
import os
import re
import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL") \
    or os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback to internal for the container
    BASE_URL = "http://localhost:8001"
BASE_URL = BASE_URL.rstrip("/")

PROFILE_ID = "smoketest"


@pytest.fixture(scope="module")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ------------------ /api/ask — grounded AI assistant ------------------
class TestAsk:
    def test_ask_au_grounded_fuel_cents_per_km(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/ask",
            json={"question": "Can I claim fuel on the cents per km method?", "country": "AU"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert "answer" in data and isinstance(data["answer"], str)
        assert len(data["answer"]) > 40, "answer too short"
        assert data.get("country") == "AU"
        # Should mention cents-per-km context and that fuel is included / cannot be claimed separately
        ans_low = data["answer"].lower()
        assert "cents" in ans_low or "per km" in ans_low or "per-km" in ans_low, \
            f"answer missing cents-per-km context: {data['answer']}"

    def test_ask_au_out_of_scope_refuses(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/ask",
            json={
                "question": "What is the capital of France and can I deduct Netflix?",
                "country": "AU",
            },
            timeout=60,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        answer = (data.get("answer") or "").lower()
        # Should refuse / point to registered tax agent / not answer capital of France
        refuse_markers = [
            "not in my verified",
            "verified sources",
            "registered tax",
            "tax professional",
            "tax agent",
            "only set up to answer",
            "isn't something i can help",
            "can't help with",
            "cannot help with",
            "outside", 
            "not able to answer",
        ]
        assert any(m in answer for m in refuse_markers), \
            f"expected refusal, got: {data.get('answer')}"
        # Should NOT confidently name Paris (out-of-scope fabrication guard)
        assert "paris" not in answer, f"assistant leaked outside knowledge: {data.get('answer')}"

    def test_ask_us_grounded_standard_mileage(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/ask",
            json={
                "question": "What is the standard mileage rate and can I deduct tolls too?",
                "country": "US",
            },
            timeout=60,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("country") == "US"
        ans = data.get("answer") or ""
        assert len(ans) > 40, "answer too short"
        ans_low = ans.lower()
        # Should mention standard mileage and tolls
        assert "mileage" in ans_low, ans
        assert "toll" in ans_low, ans


# ------------------ Regression — legacy endpoints ------------------
class TestRegression:
    def test_dashboard_ok(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/dashboard", params={"profile_id": PROFILE_ID}, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        # Sanity keys
        for key in ("income_today", "expense_today", "net_today"):
            assert key in data, f"missing dashboard key: {key}"

    def test_tax_mileage_ok(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tax-mileage", params={"profile_id": PROFILE_ID}, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        for key in ("financial_year", "logbook", "method_comparison", "odometer"):
            assert key in data, f"missing tax-mileage key: {key}"

    def test_reports_quarter_ok(self, api_client):
        r = api_client.get(
            f"{BASE_URL}/api/reports",
            params={"profile_id": PROFILE_ID, "period": "quarter"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        for key in ("period_label", "total_income", "total_deductions", "net_profit"):
            assert key in data, f"missing report key: {key}"

    def test_vehicles_auto_created(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/vehicles", params={"profile_id": PROFILE_ID}, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, list) and len(data) >= 1, \
            f"expected auto-created vehicle, got {data}"
        # No MongoDB _id leak
        for v in data:
            assert "_id" not in v
