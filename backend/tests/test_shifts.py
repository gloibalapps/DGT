"""CRUD tests for the /api/shifts endpoint (manually logged online hours)."""
import uuid


class TestShifts:
    def test_crud_flow(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={"profile_id": pid})

        # create
        r = api_client.post(f"{base_url}/api/shifts", json={
            "profile_id": pid, "date": "2026-08-10", "hours": 6.5,
            "platform": "Uber", "note": "Fri night"})
        assert r.status_code == 200
        s = r.json()
        assert s["hours"] == 6.5
        assert s["platform"] == "Uber"
        assert s["id"]
        sid = s["id"]

        # list
        lst = api_client.get(f"{base_url}/api/shifts", params={"profile_id": pid}).json()
        assert any(x["id"] == sid for x in lst)

        # update
        r2 = api_client.put(f"{base_url}/api/shifts/{sid}", json={"hours": 8})
        assert r2.status_code == 200
        assert r2.json()["hours"] == 8.0

        # delete
        r3 = api_client.delete(f"{base_url}/api/shifts/{sid}")
        assert r3.status_code == 200
        lst2 = api_client.get(f"{base_url}/api/shifts", params={"profile_id": pid}).json()
        assert not any(x["id"] == sid for x in lst2)

    def test_update_missing_returns_404(self, base_url, api_client):
        r = api_client.put(f"{base_url}/api/shifts/does-not-exist", json={"hours": 3})
        assert r.status_code == 404
