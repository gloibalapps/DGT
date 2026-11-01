# Iter18: Sign in with Apple endpoint + regression of reports/money used by restyled UI
import requests
import pytest
from conftest import BASE_URL

PID = "ui_tester"


# --- Apple sign-in
class TestAppleAuth:
    def test_apple_invalid_token_401(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/apple", json={"identity_token": "not.a.jwt"})
        assert r.status_code == 401
        assert r.json() == {"detail": "Invalid Apple sign-in"}

    def test_apple_garbage_string_401(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/apple", json={"identity_token": "garbage"})
        assert r.status_code == 401
        assert r.json()["detail"] == "Invalid Apple sign-in"

    def test_apple_missing_token_400(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/apple", json={})
        assert r.status_code == 400
        assert "identity_token" in r.json()["detail"]

    def test_apple_empty_token_400(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/apple", json={"identity_token": ""})
        assert r.status_code == 400


# --- Auth session (seeded)
class TestSession:
    def test_auth_me_seeded(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": "Bearer ui-tester-token"})
        assert r.status_code == 200
        assert r.json()["user"]["user_id"] == "ui_tester"


# --- Reports / Money regression
class TestReportsMoney:
    def test_reports_analytics(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/reports/analytics",
                           params={"profile_id": PID, "start": "2026-07-01", "end": "2026-07-31"})
        assert r.status_code == 200
        d = r.json()
        assert isinstance(d, dict) and len(d) > 0
        print(sorted(d.keys()))

    def test_reports_analytics_provider_filter(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/reports/analytics",
                           params={"profile_id": PID, "start": "2026-07-01", "end": "2026-07-31", "providers": "Uber"})
        assert r.status_code == 200

    @pytest.mark.parametrize("period", ["today", "week", "month", "quarter", "year"])
    def test_money_periods(self, api_client, period):
        r = api_client.get(f"{BASE_URL}/api/money", params={"profile_id": PID, "period": period, "ref_date": "2026-07-28"})
        assert r.status_code == 200, r.text
        assert isinstance(r.json(), dict)

    def test_reports_quarter(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/reports", params={"profile_id": PID, "period": "quarter", "ref_date": "2026-07-28"})
        assert r.status_code == 200
