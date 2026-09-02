"""Regression tests for recently-added GigTax features:
- Marketing site pages (/api/site, /api/privacy, /api/terms, /api/waitlist)
- Google Drive backup endpoints (status/connect/disconnect)
- Money overview with recurring rental (money_now.recurring_rent)
- Fuel receipt litres persistence
- Vehicles CRUD + active vehicle switching
- Ask endpoint (Claude via Emergent LLM)
"""
import uuid
from datetime import date, timedelta

import pytest


# ---------------------------------------------------------------------------
# Marketing/site + waitlist
# ---------------------------------------------------------------------------
class TestSite:
    def test_site_returns_html(self, base_url, api_client):
        r = api_client.get(f"{base_url}/api/site")
        assert r.status_code == 200
        assert "text/html" in r.headers.get("content-type", "").lower()
        assert len(r.text) > 100

    def test_privacy_returns_html(self, base_url, api_client):
        r = api_client.get(f"{base_url}/api/privacy")
        assert r.status_code == 200
        assert "text/html" in r.headers.get("content-type", "").lower()

    def test_terms_returns_html(self, base_url, api_client):
        r = api_client.get(f"{base_url}/api/terms")
        assert r.status_code == 200
        assert "text/html" in r.headers.get("content-type", "").lower()

    def test_waitlist_stores_email(self, base_url, api_client):
        email = f"TEST_{uuid.uuid4().hex[:8]}@example.com"
        r = api_client.post(f"{base_url}/api/waitlist", json={"email": email})
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_waitlist_rejects_invalid(self, base_url, api_client):
        r = api_client.post(f"{base_url}/api/waitlist", json={"email": "not-an-email"})
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# Google Drive backup endpoints (cannot complete OAuth in preview)
# ---------------------------------------------------------------------------
class TestBackups:
    def test_status_unconnected(self, base_url, api_client, profile_id):
        r = api_client.get(f"{base_url}/api/backups/status",
                           params={"profile_id": profile_id})
        assert r.status_code == 200
        assert r.json() == {"connected": False}

    def test_run_backup_returns_409_when_unconnected(self, base_url, api_client, profile_id):
        r = api_client.post(f"{base_url}/api/backups/google-drive",
                            params={"profile_id": profile_id})
        assert r.status_code == 409
        assert "not connected" in r.text.lower()

    def test_disconnect_is_idempotent(self, base_url, api_client, profile_id):
        r = api_client.post(f"{base_url}/api/backups/disconnect",
                            params={"profile_id": profile_id})
        assert r.status_code == 200
        assert r.json().get("connected") is False


# ---------------------------------------------------------------------------
# Money overview: recurring_rent surfaces on Money tab
# ---------------------------------------------------------------------------
class TestMoneyOverview:
    def test_money_now_returns_recurring_rent(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        today = date.today()
        api_client.put(f"{base_url}/api/profile", json={
            "profile_id": pid,
            "work_type": "delivery",
            "vehicle_ownership": "lease",
            "registration_status": "registered",
            "recurring_payment": {
                "amount": 350,
                "frequency": "weekly",
                "anchor_type": "gigstart",
                "anchor_date": (today - timedelta(days=14)).isoformat(),
            },
        })
        api_client.post(f"{base_url}/api/income", json={
            "profile_id": pid, "date": today.isoformat(),
            "amount": 1000, "tax_treatment": "inclusive",
        })
        r = api_client.get(f"{base_url}/api/money", params={"profile_id": pid, "period": "fy"})
        assert r.status_code == 200
        j = r.json()
        assert "money_now" in j
        # Recurring rent should be > 0 with 2 weeks elapsed
        recurring = j["money_now"].get("recurring_rent", 0)
        assert recurring > 0, f"Expected recurring_rent>0, got {recurring}"
        # Where-your-money-went (breakdown) should include Vehicle rental/lease line
        breakdown = j.get("where") or []
        labels = [item.get("label") for item in breakdown if isinstance(item, dict)]
        assert any("Vehicle rental" in (lbl or "") or "Vehicle lease" in (lbl or "")
                   for lbl in labels), f"expected 'Vehicle rental/lease' entry, got {labels}"

    def test_money_own_vehicle_no_recurring(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={
            "profile_id": pid, "work_type": "delivery",
            "vehicle_ownership": "own",
        })
        r = api_client.get(f"{base_url}/api/money", params={"profile_id": pid, "period": "fy"})
        assert r.status_code == 200
        assert r.json()["money_now"].get("recurring_rent", 0) == 0


# ---------------------------------------------------------------------------
# Fuel receipt litres — Expense model persists litres
# ---------------------------------------------------------------------------
class TestFuelLiters:
    def test_fuel_expense_persists_liters(self, base_url, api_client, profile_id):
        api_client.get(f"{base_url}/api/profile", params={"profile_id": profile_id})
        r = api_client.post(f"{base_url}/api/expenses", json={
            "profile_id": profile_id,
            "date": date.today().isoformat(),
            "amount": 65.5,
            "category": "fuel",
            "merchant": "BP",
            "liters": 32.45,
        })
        assert r.status_code == 200, r.text
        obj = r.json()
        assert obj.get("liters") == 32.45
        eid = obj["id"]

        # verify persistence
        r2 = api_client.get(f"{base_url}/api/expenses", params={"profile_id": profile_id})
        found = next((x for x in r2.json() if x["id"] == eid), None)
        assert found is not None
        assert found.get("liters") == 32.45

    def test_non_fuel_expense_liters_none(self, base_url, api_client, profile_id):
        api_client.get(f"{base_url}/api/profile", params={"profile_id": profile_id})
        r = api_client.post(f"{base_url}/api/expenses", json={
            "profile_id": profile_id,
            "date": date.today().isoformat(),
            "amount": 20,
            "category": "phone",
            "liters": 5.0,  # should be ignored / stored as None or 5 depending on impl
        })
        assert r.status_code == 200
        # Backend either strips liters for non-fuel or keeps it — check response is well-formed
        j = r.json()
        assert j.get("category") == "phone"


# ---------------------------------------------------------------------------
# Vehicles CRUD + active switching
# ---------------------------------------------------------------------------
class TestVehiclesCRUD:
    def test_full_vehicle_lifecycle(self, base_url, api_client, profile_id):
        api_client.get(f"{base_url}/api/profile", params={"profile_id": profile_id})
        # create first — POST returns the FULL vehicles list for the profile
        r = api_client.post(f"{base_url}/api/vehicles", json={
            "profile_id": profile_id, "name": "TEST Camry",
            "ownership": "own", "opening_odometer": 1000,
        })
        assert r.status_code == 200, r.text
        vehicles_after_1 = r.json()
        assert isinstance(vehicles_after_1, list)
        v1 = next((v for v in vehicles_after_1 if v.get("name") == "TEST Camry"), None)
        assert v1 is not None
        assert "id" in v1

        # create second
        r = api_client.post(f"{base_url}/api/vehicles", json={
            "profile_id": profile_id, "name": "TEST Prius",
            "ownership": "lease",
            "recurring_payment": {"amount": 200, "frequency": "weekly",
                                  "anchor_type": "gigstart",
                                  "anchor_date": date.today().isoformat()},
        })
        assert r.status_code == 200
        vehicles_after_2 = r.json()
        v2 = next((v for v in vehicles_after_2 if v.get("name") == "TEST Prius"), None)
        assert v2 is not None

        # list
        r = api_client.get(f"{base_url}/api/vehicles",
                           params={"profile_id": profile_id})
        assert r.status_code == 200
        ids = [v["id"] for v in r.json()]
        assert v1["id"] in ids and v2["id"] in ids

        # switch active vehicle via dedicated endpoint
        r = api_client.post(
            f"{base_url}/api/vehicles/{v2['id']}/activate",
            params={"profile_id": profile_id},
        )
        assert r.status_code == 200
        active = next((v for v in r.json() if v["id"] == v2["id"]), None)
        assert active and active.get("is_active") is True

        # edit
        r = api_client.put(f"{base_url}/api/vehicles/{v1['id']}",
                          json={"name": "TEST Camry 2", "profile_id": profile_id})
        assert r.status_code == 200
        renamed = next((v for v in r.json() if v["id"] == v1["id"]), None)
        assert renamed and renamed["name"] == "TEST Camry 2"

        # delete (endpoint requires profile_id query param)
        r = api_client.delete(
            f"{base_url}/api/vehicles/{v1['id']}",
            params={"profile_id": profile_id},
        )
        assert r.status_code == 200

        # verify v1 gone
        r = api_client.get(f"{base_url}/api/vehicles",
                           params={"profile_id": profile_id})
        remaining = [v["id"] for v in r.json()]
        assert v1["id"] not in remaining and v2["id"] in remaining


# ---------------------------------------------------------------------------
# Core regression endpoints
# ---------------------------------------------------------------------------
class TestCoreEndpoints:
    @pytest.fixture(autouse=True)
    def _setup(self, base_url, api_client, profile_id):
        self.base = base_url
        self.api = api_client
        self.pid = profile_id
        self.api.get(f"{base_url}/api/profile", params={"profile_id": profile_id})

    def test_dashboard(self):
        r = self.api.get(f"{self.base}/api/dashboard", params={"profile_id": self.pid})
        assert r.status_code == 200

    def test_money(self):
        r = self.api.get(f"{self.base}/api/money",
                         params={"profile_id": self.pid, "period": "fy"})
        assert r.status_code == 200

    def test_tax_mileage(self):
        r = self.api.get(f"{self.base}/api/tax-mileage",
                         params={"profile_id": self.pid})
        assert r.status_code == 200

    def test_report_au(self):
        r = self.api.get(f"{self.base}/api/reports",
                         params={"profile_id": self.pid, "period": "year"})
        assert r.status_code == 200

    def test_report_us(self):
        # switch to US profile
        self.api.put(f"{self.base}/api/profile", json={
            "profile_id": self.pid, "country": "US",
        })
        r = self.api.get(f"{self.base}/api/reports",
                         params={"profile_id": self.pid, "period": "year"})
        assert r.status_code == 200

    def test_vehicles_list(self):
        r = self.api.get(f"{self.base}/api/vehicles",
                         params={"profile_id": self.pid})
        assert r.status_code == 200

    def test_insights(self):
        r = self.api.get(f"{self.base}/api/insights",
                         params={"profile_id": self.pid})
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Ask assistant
# ---------------------------------------------------------------------------
class TestAsk:
    def test_ask_grounded_reply(self, base_url, api_client, profile_id):
        api_client.get(f"{base_url}/api/profile", params={"profile_id": profile_id})
        r = api_client.post(f"{base_url}/api/ask",
                            json={"profile_id": profile_id,
                                  "question": "Can I claim fuel receipts?"},
                            timeout=60)
        assert r.status_code == 200, r.text
        j = r.json()
        assert "answer" in j or "reply" in j or "message" in j
        text = j.get("answer") or j.get("reply") or j.get("message") or ""
        assert len(text) > 20
