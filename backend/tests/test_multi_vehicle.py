"""Multi-vehicle tests — each car keeps its own trips/expenses/logbook/deduction.
Income & GST stay combined. Existing single-car data auto-migrates to first vehicle."""
import uuid
from datetime import date, timedelta

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _new_profile(base_url, api_client, **fields):
    pid = f"TEST_{uuid.uuid4().hex[:12]}"
    payload = {"profile_id": pid, "work_type": "delivery",
               "registration_status": "not_registered"}
    payload.update(fields)
    api_client.put(f"{base_url}/api/profile", json=payload)
    return pid


# ---------------------------------------------------------------------------
# GET /vehicles auto-creates a default active vehicle (migration)
# ---------------------------------------------------------------------------
class TestVehiclesList:
    def test_get_vehicles_auto_creates_default(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        # fresh profile via GET
        api_client.get(f"{base_url}/api/profile", params={"profile_id": pid})
        r = api_client.get(f"{base_url}/api/vehicles", params={"profile_id": pid})
        assert r.status_code == 200
        v = r.json()
        assert isinstance(v, list) and len(v) == 1
        assert v[0]["is_active"] is True
        assert v[0]["profile_id"] == pid
        assert "_id" not in v[0]

    def test_migration_backfills_existing_trips_and_expenses(self, base_url, api_client):
        """Trips/expenses created before any vehicle should be tagged with default
        vehicle_id on first ensure_vehicles."""
        pid = _new_profile(base_url, api_client)
        # Create trip WITHOUT vehicle_id first
        r = api_client.post(f"{base_url}/api/trips", json={
            "profile_id": pid, "date": date.today().isoformat(),
            "distance_km": 10, "type": "business",
        })
        assert r.status_code == 200
        r = api_client.post(f"{base_url}/api/expenses", json={
            "profile_id": pid, "date": date.today().isoformat(),
            "amount": 40, "category": "fuel",
        })
        assert r.status_code == 200
        # Now trigger vehicle creation
        vlist = api_client.get(f"{base_url}/api/vehicles",
                               params={"profile_id": pid}).json()
        car_id = vlist[0]["id"]
        # Trips & expenses should now be tagged
        trips = api_client.get(f"{base_url}/api/trips",
                               params={"profile_id": pid}).json()
        exps = api_client.get(f"{base_url}/api/expenses",
                              params={"profile_id": pid}).json()
        assert all(t.get("vehicle_id") == car_id for t in trips)
        assert all(e.get("vehicle_id") == car_id for e in exps)


# ---------------------------------------------------------------------------
# POST /vehicles adds a second car; activate; update; delete
# ---------------------------------------------------------------------------
class TestVehicleCRUD:
    def test_add_second_vehicle_first_stays_active(self, base_url, api_client):
        pid = _new_profile(base_url, api_client)
        v1 = api_client.get(f"{base_url}/api/vehicles",
                            params={"profile_id": pid}).json()[0]
        r = api_client.post(f"{base_url}/api/vehicles", json={
            "profile_id": pid, "name": "Car 2", "ownership": "own",
        })
        assert r.status_code == 200
        vlist = r.json()
        assert len(vlist) == 2
        # Only one active
        active_ids = [v["id"] for v in vlist if v["is_active"]]
        assert len(active_ids) == 1
        # First car remains active
        assert active_ids[0] == v1["id"]

    def test_add_vehicle_with_is_active_switches(self, base_url, api_client):
        pid = _new_profile(base_url, api_client)
        r = api_client.post(f"{base_url}/api/vehicles", json={
            "profile_id": pid, "name": "Car 2", "ownership": "lease",
            "is_active": True,
        })
        assert r.status_code == 200
        vlist = r.json()
        car2 = next(v for v in vlist if v["name"] == "Car 2")
        assert car2["is_active"] is True
        assert sum(1 for v in vlist if v["is_active"]) == 1

    def test_activate_endpoint_switches(self, base_url, api_client):
        pid = _new_profile(base_url, api_client)
        v1 = api_client.get(f"{base_url}/api/vehicles",
                            params={"profile_id": pid}).json()[0]
        vlist = api_client.post(f"{base_url}/api/vehicles", json={
            "profile_id": pid, "name": "Car 2"}).json()
        car2_id = next(v["id"] for v in vlist if v["name"] == "Car 2")
        r = api_client.post(f"{base_url}/api/vehicles/{car2_id}/activate",
                            params={"profile_id": pid})
        assert r.status_code == 200
        out = r.json()
        by_id = {v["id"]: v for v in out}
        assert by_id[car2_id]["is_active"] is True
        assert by_id[v1["id"]]["is_active"] is False

    def test_update_vehicle_fields(self, base_url, api_client):
        pid = _new_profile(base_url, api_client)
        v1 = api_client.get(f"{base_url}/api/vehicles",
                            params={"profile_id": pid}).json()[0]
        payload = {
            "profile_id": pid,
            "name": "Updated Car",
            "ownership": "lease",
            "recurring_payment": {"amount": 250, "frequency": "weekly",
                                  "anchor_type": "gigstart",
                                  "anchor_date": "2026-01-01"},
            "opening_odometer": 10000,
            "closing_odometer": 25000,
        }
        r = api_client.put(f"{base_url}/api/vehicles/{v1['id']}", json=payload)
        assert r.status_code == 200
        vlist = r.json()
        updated = next(v for v in vlist if v["id"] == v1["id"])
        assert updated["name"] == "Updated Car"
        assert updated["ownership"] == "lease"
        assert updated["recurring_payment"]["amount"] == 250
        assert updated["opening_odometer"] == 10000
        assert updated["closing_odometer"] == 25000

    def test_delete_blocked_when_only_one(self, base_url, api_client):
        pid = _new_profile(base_url, api_client)
        v1 = api_client.get(f"{base_url}/api/vehicles",
                            params={"profile_id": pid}).json()[0]
        r = api_client.delete(f"{base_url}/api/vehicles/{v1['id']}",
                              params={"profile_id": pid})
        assert r.status_code == 400

    def test_delete_active_promotes_another(self, base_url, api_client):
        pid = _new_profile(base_url, api_client)
        v1 = api_client.get(f"{base_url}/api/vehicles",
                            params={"profile_id": pid}).json()[0]
        vlist = api_client.post(f"{base_url}/api/vehicles", json={
            "profile_id": pid, "name": "Car 2"}).json()
        # v1 is active. Delete it.
        r = api_client.delete(f"{base_url}/api/vehicles/{v1['id']}",
                              params={"profile_id": pid})
        assert r.status_code == 200
        out = r.json()
        assert len(out) == 1
        assert out[0]["is_active"] is True
        assert out[0]["name"] == "Car 2"


# ---------------------------------------------------------------------------
# Per-vehicle isolation in /api/tax-mileage
# ---------------------------------------------------------------------------
@pytest.fixture
def two_car_profile(base_url, api_client):
    """Create profile with 2 vehicles + trips tagged to each.
    Car1: 20km business + 10km personal (business_pct ~66.67%)
    Car2: 30km business (business_pct = 100%)."""
    pid = _new_profile(base_url, api_client, work_type="delivery")
    v1 = api_client.get(f"{base_url}/api/vehicles",
                       params={"profile_id": pid}).json()[0]
    vlist = api_client.post(f"{base_url}/api/vehicles", json={
        "profile_id": pid, "name": "Car 2",
        "recurring_payment": {"amount": 100, "frequency": "weekly",
                              "anchor_type": "gigstart",
                              "anchor_date": (date.today() - timedelta(days=7)).isoformat()},
    }).json()
    car2 = next(v for v in vlist if v["name"] == "Car 2")

    today = date.today().isoformat()
    # Car 1 trips
    api_client.post(f"{base_url}/api/trips", json={
        "profile_id": pid, "date": today, "distance_km": 20,
        "type": "business", "vehicle_id": v1["id"]})
    api_client.post(f"{base_url}/api/trips", json={
        "profile_id": pid, "date": today, "distance_km": 10,
        "type": "personal", "vehicle_id": v1["id"]})
    # Car 2 trips
    api_client.post(f"{base_url}/api/trips", json={
        "profile_id": pid, "date": today, "distance_km": 30,
        "type": "business", "vehicle_id": car2["id"]})
    # Income (driver-level, combined)
    api_client.post(f"{base_url}/api/income", json={
        "profile_id": pid, "date": today, "amount": 500, "platform": "Uber",
        "tax_treatment": "inclusive"})
    # Fuel expense tagged to Car 1
    api_client.post(f"{base_url}/api/expenses", json={
        "profile_id": pid, "date": today, "amount": 60, "category": "fuel",
        "vehicle_id": v1["id"], "tax_treatment": "inclusive"})
    return {"pid": pid, "car1": v1["id"], "car2": car2["id"]}


class TestPerVehicleIsolation:
    def test_tax_mileage_car1_only(self, base_url, api_client, two_car_profile):
        pid = two_car_profile["pid"]
        car1 = two_car_profile["car1"]
        tm = api_client.get(f"{base_url}/api/tax-mileage",
                            params={"profile_id": pid, "vehicle_id": car1}).json()
        # Logbook / method_comparison for car1 only: 20 biz + 10 personal
        mc = tm["method_comparison"]
        assert mc["business_km"] == 20.0
        assert mc["total_km"] == 30.0
        # Logbook pct ~66.67%
        assert abs(mc["logbook"]["business_pct"] - 66.67) < 0.5
        assert tm["selected_vehicle_id"] == car1

    def test_tax_mileage_car2_only(self, base_url, api_client, two_car_profile):
        pid = two_car_profile["pid"]
        car2 = two_car_profile["car2"]
        tm = api_client.get(f"{base_url}/api/tax-mileage",
                            params={"profile_id": pid, "vehicle_id": car2}).json()
        mc = tm["method_comparison"]
        assert mc["business_km"] == 30.0
        assert mc["total_km"] == 30.0
        assert mc["logbook"]["business_pct"] == 100.0
        assert tm["selected_vehicle_id"] == car2

    def test_today_and_fy_combined_across_cars(self, base_url, api_client,
                                                two_car_profile):
        pid = two_car_profile["pid"]
        tm = api_client.get(f"{base_url}/api/tax-mileage",
                            params={"profile_id": pid,
                                    "vehicle_id": two_car_profile["car1"]}).json()
        # today: 20+10 (car1) + 30 (car2) = 60 total_km, 50 business
        assert tm["today"]["total_km"] == 60.0
        assert tm["today"]["business_km"] == 50.0
        # FY same as today because trips are today
        assert tm["financial_year"]["total_km"] == 60.0
        assert tm["financial_year"]["business_km"] == 50.0
        # income is driver-level
        assert tm["today"]["income"] == 500.0

    def test_vehicles_summary_present(self, base_url, api_client, two_car_profile):
        pid = two_car_profile["pid"]
        car1 = two_car_profile["car1"]
        car2 = two_car_profile["car2"]
        tm = api_client.get(f"{base_url}/api/tax-mileage",
                            params={"profile_id": pid}).json()
        assert "vehicles" in tm and isinstance(tm["vehicles"], list)
        assert len(tm["vehicles"]) == 2
        by_id = {v["id"]: v for v in tm["vehicles"]}
        # car1: ~66.67% biz, car2: 100%
        assert abs(by_id[car1]["business_pct"] - 66.67) < 0.5
        assert by_id[car2]["business_pct"] == 100.0
        # deductions are numeric
        assert isinstance(by_id[car1]["deduction"], (int, float))
        assert isinstance(by_id[car2]["deduction"], (int, float))
        assert "active_vehicle_id" in tm and tm["active_vehicle_id"] is not None


# ---------------------------------------------------------------------------
# Per-vehicle apportionment in /api/reports
# ---------------------------------------------------------------------------
class TestReportsMultiVehicle:
    def test_fuel_apportioned_by_car1_business_pct(self, base_url, api_client,
                                                     two_car_profile):
        pid = two_car_profile["pid"]
        rep = api_client.get(f"{base_url}/api/reports",
                             params={"profile_id": pid, "period": "quarter"}).json()
        # Fuel $60 tagged to car1 (66.67% biz) => ~40.00
        assert abs(rep["vehicle_deduction"]["fuel"] - 40.0) <= 0.5
        # Recurring_payment_gross reflects car2's $100/wk lease
        assert rep["vehicle_deduction"]["recurring_payment_gross"] > 0

    def test_dashboard_recurring_sums_across_cars(self, base_url, api_client,
                                                    two_car_profile):
        pid = two_car_profile["pid"]
        d = api_client.get(f"{base_url}/api/dashboard",
                           params={"profile_id": pid}).json()
        # car2 has recurring; car1 does not. Owed > 0.
        assert d["recurring"]["enabled"] is True
        assert d["recurring"]["owed_this_quarter"] > 0


# ---------------------------------------------------------------------------
# Export mileage still works
# ---------------------------------------------------------------------------
class TestExportMileageMulti:
    def test_export_returns_csv(self, base_url, api_client, two_car_profile):
        pid = two_car_profile["pid"]
        r = api_client.get(f"{base_url}/api/export-mileage",
                           params={"profile_id": pid})
        assert r.status_code == 200
        assert "text/csv" in r.headers.get("content-type", "")
        assert "Motor Vehicle Report" in r.text
