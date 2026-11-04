# Faster receipt loading: list omits receipt_image (has_receipt flag), get-by-id returns it, PUT keeps it
import base64
import io
import uuid
import pytest
import requests
from conftest import BASE_URL


def _jpeg_b64():
    try:
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (60, 40), (200, 30, 30)).save(buf, "JPEG")
        return base64.b64encode(buf.getvalue()).decode()
    except Exception:
        # tiny valid jpeg fallback
        return "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="


@pytest.fixture(scope="module")
def ctx():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    pid = f"TEST_rcpt_{uuid.uuid4().hex[:10]}"
    img = _jpeg_b64()
    created = []
    with_img = s.post(f"{BASE_URL}/api/expenses", json={
        "profile_id": pid, "date": "2026-01-10", "amount": 55.5, "category": "fuel",
        "merchant": "TEST_Shell", "receipt_image": img}).json()
    created.append(with_img["id"])
    no_img = s.post(f"{BASE_URL}/api/expenses", json={
        "profile_id": pid, "date": "2026-01-09", "amount": 12.0, "category": "tolls",
        "merchant": "TEST_Linkt"}).json()
    created.append(no_img["id"])
    yield {"s": s, "pid": pid, "img": img, "with": with_img, "without": no_img}
    for i in created:
        s.delete(f"{BASE_URL}/api/expenses/{i}")


class TestReceiptLoading:
    def test_list_omits_image_and_flags(self, ctx):
        r = ctx["s"].get(f"{BASE_URL}/api/expenses", params={"profile_id": ctx["pid"]})
        assert r.status_code == 200
        items = {e["id"]: e for e in r.json()}
        assert len(items) == 2
        for e in items.values():
            assert "receipt_image" not in e
            assert "_id" not in e
        assert items[ctx["with"]["id"]]["has_receipt"] is True
        assert items[ctx["without"]["id"]]["has_receipt"] is False
        assert items[ctx["with"]["id"]]["amount"] == 55.5

    def test_list_sorted_desc(self, ctx):
        r = ctx["s"].get(f"{BASE_URL}/api/expenses", params={"profile_id": ctx["pid"]})
        dates = [e["date"] for e in r.json()]
        assert dates == sorted(dates, reverse=True)

    def test_get_by_id_returns_image(self, ctx):
        r = ctx["s"].get(f"{BASE_URL}/api/expenses/{ctx['with']['id']}", params={"profile_id": ctx["pid"]})
        assert r.status_code == 200
        d = r.json()
        assert d["receipt_image"] == ctx["img"]
        assert d["merchant"] == "TEST_Shell" and d["category"] == "fuel"
        assert "_id" not in d

    def test_get_by_id_no_image(self, ctx):
        r = ctx["s"].get(f"{BASE_URL}/api/expenses/{ctx['without']['id']}", params={"profile_id": ctx["pid"]})
        assert r.status_code == 200
        assert not r.json().get("receipt_image")

    def test_get_wrong_profile_404(self, ctx):
        r = ctx["s"].get(f"{BASE_URL}/api/expenses/{ctx['with']['id']}", params={"profile_id": "TEST_other"})
        assert r.status_code == 404

    def test_get_unknown_id_404(self, ctx):
        r = ctx["s"].get(f"{BASE_URL}/api/expenses/nope-{uuid.uuid4().hex}", params={"profile_id": ctx["pid"]})
        assert r.status_code == 404

    def test_get_missing_profile_uses_session(self, ctx):
        # profile_id is optional now: the owner comes from the Bearer session.
        r = ctx["s"].get(f"{BASE_URL}/api/expenses/{ctx['with']['id']}")
        assert r.status_code == 200 and r.json()["id"] == ctx["with"]["id"]
        r = ctx["s"].get(f"{BASE_URL}/api/expenses/{ctx['with']['id']}", headers={"X-Test-No-Auto-Auth": "1"})
        assert r.status_code == 401

    def test_put_without_image_keeps_photo(self, ctx):
        eid = ctx["with"]["id"]
        r = ctx["s"].put(f"{BASE_URL}/api/expenses/{eid}", json={"amount": 60.25, "merchant": "TEST_Shell2"})
        assert r.status_code == 200
        g = ctx["s"].get(f"{BASE_URL}/api/expenses/{eid}", params={"profile_id": ctx["pid"]}).json()
        assert g["amount"] == 60.25 and g["merchant"] == "TEST_Shell2"
        assert g["receipt_image"] == ctx["img"]

    def test_put_null_image_removes(self, ctx):
        eid = ctx["without"]["id"]
        ctx["s"].put(f"{BASE_URL}/api/expenses/{eid}", json={"receipt_image": ctx["img"]})
        lst = ctx["s"].get(f"{BASE_URL}/api/expenses", params={"profile_id": ctx["pid"]}).json()
        assert {e["id"]: e for e in lst}[eid]["has_receipt"] is True
        ctx["s"].put(f"{BASE_URL}/api/expenses/{eid}", json={"receipt_image": None})
        lst = ctx["s"].get(f"{BASE_URL}/api/expenses", params={"profile_id": ctx["pid"]}).json()
        assert {e["id"]: e for e in lst}[eid]["has_receipt"] is False

    def test_reports_still_work(self, ctx):
        r = ctx["s"].get(f"{BASE_URL}/api/expenses", params={"profile_id": ctx["pid"]})
        total = round(sum(e["amount"] for e in r.json()), 2)
        assert total == round(60.25 + 12.0, 2)
