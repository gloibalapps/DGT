# Uber Eats Engaged-Time Guarantee (/api/ue) — jobs CRUD, duplicates, guarantee maths, mismatches, xlsx export
import io
import uuid
import pytest
import requests
from conftest import BASE_URL

UE = f"{BASE_URL}/api/ue"
CS = "2026-10-19"


@pytest.fixture(scope="module")
def pid():
    p = f"TEST_ue_{uuid.uuid4().hex[:8]}"
    requests.put(f"{BASE_URL}/api/profile", json={"profile_id": p, "country": "AU", "ue_guarantee_enabled": True,
                                                   "ue_vehicle_type": "car"})
    yield p
    for j in requests.get(f"{UE}/jobs", params={"profile_id": p}).json():
        requests.delete(f"{UE}/jobs/{j['id']}")
    for i in requests.get(f"{BASE_URL}/api/income", params={"profile_id": p}).json():
        requests.delete(f"{BASE_URL}/api/income/{i['id']}")


def job(date="2026-10-20", start="12:03 PM", dur=3660, amt=24.59, typ="DELIVERY", km=None):
    return {"date": date, "start_time": start, "type": typ, "duration_sec": dur, "amount": amt, "km": km}


# --- batch save + duplicates
class TestJobs:
    def test_batch_save_and_within_batch_dup(self, pid):
        r = requests.post(f"{UE}/jobs", json={"profile_id": pid, "jobs": [
            job(), job(amt=24.60), job(start="1:30 PM", dur=2316, amt=10.00, km=3.4),
            {"date": "2026-10-20", "type": "Promotion", "amount": 5.0}]})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["duplicates"] == [1]  # later copy within 2c flagged
        assert len(d["saved"]) == 3
        promo = [s for s in d["saved"] if s["type"] == "Promotion"][0]
        assert promo["start_time"] == "" and promo["duration_sec"] == 0
        assert all("_id" not in s for s in d["saved"])
        got = requests.get(f"{UE}/jobs", params={"profile_id": pid}).json()
        assert len(got) == 3

    def test_dup_vs_existing(self, pid):
        r = requests.post(f"{UE}/jobs", json={"profile_id": pid, "jobs": [job(amt=24.61), job(amt=24.62)]})
        assert r.status_code == 200
        d = r.json()
        # 24.61 is within 2c of 24.59 -> dup; 24.62 is 3c away -> saved
        assert d["duplicates"] == [0], d
        assert len(d["saved"]) == 1

    def test_validation_missing_start(self, pid):
        r = requests.post(f"{UE}/jobs", json={"profile_id": pid, "jobs": [job(start="")]})
        assert r.status_code == 422

    def test_validation_missing_duration(self, pid):
        r = requests.post(f"{UE}/jobs", json={"profile_id": pid, "jobs": [job(dur=0)]})
        assert r.status_code == 422

    def test_validation_promo_missing_amount(self, pid):
        r = requests.post(f"{UE}/jobs", json={"profile_id": pid, "jobs": [{"date": "2026-10-21", "type": "Promotion"}]})
        assert r.status_code == 422

    def test_invalid_type_is_4xx_not_500(self, pid):
        r = requests.post(f"{UE}/jobs", json={"profile_id": pid, "jobs": [job(typ="Ride")]})
        assert r.status_code in (400, 422), f"got {r.status_code}"

    def test_missing_profile_id(self):
        r = requests.post(f"{UE}/jobs", json={"jobs": [job()]})
        assert r.status_code == 400

    def test_put_409_and_update_and_delete(self, pid):
        got = requests.get(f"{UE}/jobs", params={"profile_id": pid}).json()
        target = [j for j in got if j["start_time"] == "1:30 PM"][0]
        r = requests.put(f"{UE}/jobs/{target['id']}", json={"start_time": "12:03 PM", "amount": 24.59})
        assert r.status_code == 409
        r = requests.put(f"{UE}/jobs/{target['id']}", json={"amount": 11.25})
        assert r.status_code == 200 and r.json()["amount"] == 11.25
        got = {j["id"]: j for j in requests.get(f"{UE}/jobs", params={"profile_id": pid}).json()}
        assert got[target["id"]]["amount"] == 11.25
        assert requests.put(f"{UE}/jobs/nope", json={"amount": 1}).status_code == 404
        # delete the extra 24.62 job and verify gone
        extra = [j for j in got.values() if j["amount"] == 24.62][0]
        assert requests.delete(f"{UE}/jobs/{extra['id']}").status_code == 200
        ids = [j["id"] for j in requests.get(f"{UE}/jobs", params={"profile_id": pid}).json()]
        assert extra["id"] not in ids


# --- guarantee maths
class TestGuarantee:
    def test_cycle_totals_car(self, pid):
        r = requests.get(f"{UE}/guarantee", params={"profile_id": pid, "cycle_start": CS})
        assert r.status_code == 200
        d = r.json()
        assert d["cycle_start"] == CS and d["cycle_end"] == "2026-11-08"
        assert d["rate"] == 32.0 and d["vehicle_type"] == "car"
        assert len(d["weeks"]) == 3
        assert [w["start"] for w in d["weeks"]] == ["2026-10-19", "2026-10-26", "2026-11-02"]
        t = d["total"]
        # jobs: 3660s 24.59 + 2316s 11.25 + promo 5.00
        assert t["jobs"] == 2 and t["promotions"] == 1
        assert t["engaged_sec"] == 5976
        assert t["earnings"] == round(24.59 + 11.25 + 5.0, 2)
        assert t["promo_total"] == 5.0
        assert t["guaranteed"] == round(5976 / 3600 * 32, 2)
        assert t["top_up"] == round(max(0, t["guaranteed"] - t["earnings"]), 2)
        assert t["effective_rate"] == round(t["earnings"] / (5976 / 3600), 2)
        assert t["engaged_label"] == "1 hr 39 min"
        assert any(c["start"] == CS for c in d["cycles"])

    def test_mid_cycle_date_snaps(self, pid):
        d = requests.get(f"{UE}/guarantee", params={"profile_id": pid, "cycle_start": "2026-10-28"}).json()
        assert d["cycle_start"] == CS

    def test_motorbike_rate(self, pid):
        requests.put(f"{BASE_URL}/api/profile", json={"profile_id": pid, "ue_vehicle_type": "motorbike"})
        d = requests.get(f"{UE}/guarantee", params={"profile_id": pid, "cycle_start": CS}).json()
        assert d["rate"] == 31.5
        assert d["total"]["guaranteed"] == round(5976 / 3600 * 31.5, 2)
        requests.put(f"{BASE_URL}/api/profile", json={"profile_id": pid, "ue_vehicle_type": "bicycle"})
        assert requests.get(f"{UE}/guarantee", params={"profile_id": pid, "cycle_start": CS}).json()["rate"] == 31.3
        requests.put(f"{BASE_URL}/api/profile", json={"profile_id": pid, "ue_vehicle_type": "car"})


# --- mismatches vs logged Uber Eats income
class TestMismatch:
    def test_mismatch_flag_and_clear(self, pid):
        # recent day so /mismatches window (last ~21 days) covers it
        day = "2026-11-02"
        requests.post(f"{UE}/jobs", json={"profile_id": pid, "jobs": [job(date=day, start="9:00 AM", dur=600, amt=10.0)]})
        inc = requests.post(f"{BASE_URL}/api/income", json={"profile_id": pid, "date": day, "amount": 12.0,
                                                           "platform": "Uber Eats"}).json()
        # other platform must be ignored
        requests.post(f"{BASE_URL}/api/income", json={"profile_id": pid, "date": day, "amount": 50, "platform": "DoorDash"})
        m = requests.get(f"{UE}/mismatches", params={"profile_id": pid}).json()
        row = [x for x in m if x["date"] == day]
        assert row and row[0]["jobs_total"] == 10.0 and row[0]["income_logged"] == 12.0 and row[0]["difference"] == 2.0
        g = requests.get(f"{UE}/guarantee", params={"profile_id": pid, "cycle_start": CS}).json()
        assert any(x["date"] == day for x in g["mismatches"])
        requests.put(f"{BASE_URL}/api/income/{inc['id']}", json={"amount": 10.0})
        m = requests.get(f"{UE}/mismatches", params={"profile_id": pid}).json()
        assert not [x for x in m if x["date"] == day]


# --- Excel export
class TestExport:
    def test_xlsx(self, pid):
        from openpyxl import load_workbook
        r = requests.get(f"{UE}/export", params={"profile_id": pid, "cycle_start": CS})
        assert r.status_code == 200
        assert "spreadsheetml" in r.headers["content-type"]
        assert "attachment" in r.headers.get("content-disposition", "")
        wb = load_workbook(io.BytesIO(r.content))
        assert wb.sheetnames == ["Summary", "Job Details"]
        hdr = [c.value for c in wb["Job Details"][1]]
        assert "Overlap with previous job (min)" in hdr
        vals = [c.value for row in wb["Summary"].iter_rows() for c in row if c.value is not None]
        assert "Cycle total" in vals
