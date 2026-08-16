"""Tests for the /api/money overview endpoint (Money Now / Performance / Intelligence)."""
import uuid
from datetime import date, timedelta

REF = "2026-08-14"  # a Friday


def _monday():
    ref = date.fromisoformat(REF)
    return ref - timedelta(days=ref.weekday())


class TestMoney:
    def test_shape(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={"profile_id": pid, "country": "AU"})
        j = api_client.get(f"{base_url}/api/money",
                           params={"profile_id": pid, "period": "week", "ref_date": REF}).json()
        for k in ["money_now", "performance", "where", "deductions", "tax_position",
                  "best_day", "best_platform", "period_label", "symbol"]:
            assert k in j, k
        assert set(["take_home", "gross", "expenses", "estimated_tax", "keep_rate"]).issubset(j["money_now"].keys())

    def test_money_now_math(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={"profile_id": pid, "country": "AU"})
        mon = _monday().isoformat()
        api_client.post(f"{base_url}/api/income", json={"profile_id": pid, "date": mon, "amount": 1000, "tax_treatment": "inclusive"})
        api_client.post(f"{base_url}/api/expenses", json={"profile_id": pid, "date": mon, "amount": 200, "category": "fuel", "tax_treatment": "inclusive"})
        api_client.post(f"{base_url}/api/shifts", json={"profile_id": pid, "date": mon, "hours": 10})
        api_client.post(f"{base_url}/api/trips", json={"profile_id": pid, "date": mon, "distance_km": 400, "type": "business"})

        j = api_client.get(f"{base_url}/api/money",
                           params={"profile_id": pid, "period": "week", "ref_date": REF}).json()
        mn = j["money_now"]
        assert mn["gross"] == 1000.0
        assert mn["expenses"] == 200.0
        assert mn["profit_before_tax"] == 800.0
        # take_home = profit - estimated_tax ; keep_rate = take_home/gross*100
        assert abs(mn["take_home"] - (mn["profit_before_tax"] - mn["estimated_tax"])) < 0.02
        assert abs(mn["keep_rate"] - round(mn["take_home"] / mn["gross"] * 100, 1)) < 0.2
        perf = j["performance"]
        assert perf["hours"] == 10.0
        assert perf["km"] == 400.0
        assert perf["gross_per_hour"] == 100.0  # 1000 / 10
        assert perf["per_km"] == 2.5            # 1000 / 400
        assert perf["cost_per_km"] == 0.5       # 200 / 400

    def test_tax_position_uses_set_aside(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={"profile_id": pid, "country": "AU", "tax_set_aside": 5000})
        j = api_client.get(f"{base_url}/api/money",
                           params={"profile_id": pid, "period": "week", "ref_date": REF}).json()
        assert j["tax_position"]["set_aside"] == 5000.0
        assert j["tax_position"]["status"] == "ahead"
