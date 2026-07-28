"""GigTax backend API tests — pytest, uses public EXPO_PUBLIC_BACKEND_URL."""
import base64
import io
import uuid
from datetime import date, timedelta

import pytest
import requests


# ---------------------------------------------------------------------------
# Health / root
# ---------------------------------------------------------------------------
class TestHealth:
    def test_root(self, base_url, api_client):
        r = api_client.get(f"{base_url}/api/")
        assert r.status_code == 200
        j = r.json()
        assert j.get("market") == "AU"


# ---------------------------------------------------------------------------
# Profile (auto-create on GET, upsert on PUT)
# ---------------------------------------------------------------------------
class TestProfile:
    def test_get_creates_default_profile(self, base_url, api_client, profile_id):
        r = api_client.get(f"{base_url}/api/profile", params={"profile_id": profile_id})
        assert r.status_code == 200
        p = r.json()
        assert p["profile_id"] == profile_id
        assert p["country"] == "AU"
        assert p["theme"] in ("dark", "light")
        assert p["onboarded"] is False
        assert "_id" not in p

    def test_put_updates_and_persists(self, base_url, api_client, profile_id):
        payload = {
            "profile_id": profile_id, "region": "NSW", "work_type": "both",
            "platforms": ["Uber", "DoorDash"], "vehicle_ownership": "lease",
            "recurring_payment": {"amount": 350, "frequency": "weekly",
                                  "anchor_type": "gigstart", "anchor_date": "2026-01-01"},
            "legal_name": "TEST Driver", "registration_status": "registered",
            "onboarded": True,
        }
        r = api_client.put(f"{base_url}/api/profile", json=payload)
        assert r.status_code == 200
        p = r.json()
        assert p["work_type"] == "both"
        assert p["platforms"] == ["Uber", "DoorDash"]
        assert p["recurring_payment"]["amount"] == 350
        assert p["registration_status"] == "registered"
        assert p["onboarded"] is True

        # verify persistence
        r2 = api_client.get(f"{base_url}/api/profile", params={"profile_id": profile_id})
        p2 = r2.json()
        assert p2["work_type"] == "both"
        assert p2["legal_name"] == "TEST Driver"

    def test_put_missing_profile_id(self, base_url, api_client):
        r = api_client.put(f"{base_url}/api/profile", json={"work_type": "delivery"})
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# CRUD for trips/income/expenses
# ---------------------------------------------------------------------------
class TestCRUD:
    @pytest.fixture(autouse=True)
    def _setup(self, base_url, api_client, profile_id):
        self.base = base_url
        self.api = api_client
        self.pid = profile_id
        # ensure profile exists
        self.api.get(f"{self.base}/api/profile", params={"profile_id": self.pid})

    def _crud(self, resource, create_payload, updated_field, updated_value):
        create_payload["profile_id"] = self.pid
        r = self.api.post(f"{self.base}/api/{resource}", json=create_payload)
        assert r.status_code == 200, r.text
        obj = r.json()
        assert obj["profile_id"] == self.pid
        assert "id" in obj
        item_id = obj["id"]

        # GET list contains it
        r = self.api.get(f"{self.base}/api/{resource}", params={"profile_id": self.pid})
        assert r.status_code == 200
        assert any(x["id"] == item_id for x in r.json())

        # PUT update
        r = self.api.put(f"{self.base}/api/{resource}/{item_id}",
                         json={updated_field: updated_value})
        assert r.status_code == 200, r.text
        assert r.json()[updated_field] == updated_value

        # DELETE
        r = self.api.delete(f"{self.base}/api/{resource}/{item_id}")
        assert r.status_code == 200
        # verify gone
        r = self.api.get(f"{self.base}/api/{resource}", params={"profile_id": self.pid})
        assert not any(x["id"] == item_id for x in r.json())

    def test_trips_crud(self):
        self._crud("trips",
                   {"date": "2026-01-05", "distance_km": 12.5, "type": "business"},
                   "distance_km", 15.0)

    def test_income_crud(self):
        self._crud("income",
                   {"date": "2026-01-05", "amount": 100, "platform": "Uber"},
                   "amount", 150.5)

    def test_expenses_crud(self):
        self._crud("expenses",
                   {"date": "2026-01-05", "amount": 40, "category": "fuel",
                    "merchant": "BP"},
                   "amount", 55.0)

    def test_update_missing_returns_404(self):
        r = self.api.put(f"{self.base}/api/trips/does-not-exist",
                         json={"distance_km": 1})
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Reports — tax math correctness
# ---------------------------------------------------------------------------
@pytest.fixture
def seeded(base_url, api_client):
    """Seed a profile inside the current BAS quarter with known math."""
    pid = f"TEST_{uuid.uuid4().hex[:12]}"
    today = date.today()

    # Registered lease profile so BAS card is visible
    api_client.put(f"{base_url}/api/profile", json={
        "profile_id": pid, "work_type": "delivery",
        "vehicle_ownership": "lease", "registration_status": "registered",
        "legal_name": "TEST Driver",
        "recurring_payment": {"amount": 350, "frequency": "weekly",
                              "anchor_type": "gigstart",
                              "anchor_date": (today - timedelta(days=14)).isoformat()},
    })

    # 80 business km + 20 personal km => 80% business use
    for km, typ in [(80, "business"), (20, "personal")]:
        api_client.post(f"{base_url}/api/trips", json={
            "profile_id": pid, "date": today.isoformat(),
            "distance_km": km, "type": typ,
        })

    # Income: $1100 inclusive (=> G1=1100, 1A=100)
    api_client.post(f"{base_url}/api/income", json={
        "profile_id": pid, "date": today.isoformat(),
        "amount": 1100, "platform": "Uber", "tax_treatment": "inclusive",
    })
    # Expenses:
    #   fuel $110 (apportioned)  => deduction = 88, GST base = 88
    #   tolls $22  (full claim)  => deduction = 22, GST base = 22
    #   phone $55  (full claim)  => deduction = 55, GST base = 55
    for cat, amt in [("fuel", 110), ("tolls", 22), ("phone", 55)]:
        api_client.post(f"{base_url}/api/expenses", json={
            "profile_id": pid, "date": today.isoformat(),
            "amount": amt, "category": cat, "tax_treatment": "inclusive",
        })
    yield pid


class TestReports:
    def test_business_use_and_deductions(self, base_url, api_client, seeded):
        r = api_client.get(f"{base_url}/api/reports",
                           params={"profile_id": seeded, "period": "quarter"})
        assert r.status_code == 200
        rep = r.json()
        assert rep["business_km"] == 80.0
        assert rep["personal_km"] == 20.0
        assert rep["business_use_pct"] == 80.0
        # fuel apportioned at 80% => 88
        assert rep["vehicle_deduction"]["fuel"] == 88.0
        # tolls & phone full claim
        assert rep["full_claim"]["tolls"] == 22.0
        assert rep["full_claim"]["phone"] == 55.0
        # total income
        assert rep["total_income"] == 1100.0

    def test_bas_math_and_show_bas(self, base_url, api_client, seeded):
        rep = api_client.get(f"{base_url}/api/reports",
                             params={"profile_id": seeded, "period": "quarter"}).json()
        assert rep["show_bas"] is True
        assert rep["bas"]["G1"] == 1100.0
        assert rep["bas"]["1A"] == 100.0  # 1100/11
        # 1B base = fuel apportioned 88 + tolls 22 + phone 55 + lease recurring apportioned
        # recurring gross is >0 (lease active), apportioned at 80%
        rp_gross = rep["vehicle_deduction"]["recurring_payment_gross"]
        expected_1b = round((88 + 22 + 55 + rp_gross * 0.8) / 11.0, 2)
        assert rep["bas"]["1B"] == expected_1b
        assert rep["bas"]["net_gst"] == round(rep["bas"]["1A"] - rep["bas"]["1B"], 2)

    def test_fallback_business_use_when_no_trips(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={
            "profile_id": pid, "work_type": "delivery",
            "registration_status": "not_registered",
        })
        api_client.post(f"{base_url}/api/income", json={
            "profile_id": pid, "date": date.today().isoformat(),
            "amount": 500, "tax_treatment": "inclusive",
        })
        rep = api_client.get(f"{base_url}/api/reports",
                             params={"profile_id": pid, "period": "quarter"}).json()
        assert rep["total_km"] == 0
        assert rep["business_use_pct"] == 100.0  # fallback
        assert rep["business_use_is_fallback"] is True
        # Delivery + not registered + income below threshold => show_bas False
        assert rep["show_bas"] is False

    def test_passengers_not_registered_warning(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        api_client.put(f"{base_url}/api/profile", json={
            "profile_id": pid, "work_type": "passengers",
            "registration_status": "not_registered",
        })
        rep = api_client.get(f"{base_url}/api/reports",
                             params={"profile_id": pid, "period": "quarter"}).json()
        assert rep["registration_warning"] is not None
        assert "GST" in rep["registration_warning"]
        assert rep["show_bas"] is False

    def test_period_boundaries_additive(self, base_url, api_client):
        """Quarter total + rest-of-year = full FY, no double count, no gap."""
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        today = date.today()
        api_client.put(f"{base_url}/api/profile", json={
            "profile_id": pid, "work_type": "delivery",
            "registration_status": "registered",
        })
        # Seed incomes spread across the financial year (Jul1..Jun30)
        # FY start:
        fy_start = date(today.year if today.month >= 7 else today.year - 1, 7, 1)
        for i in range(12):
            d = fy_start + timedelta(days=30 * i)
            api_client.post(f"{base_url}/api/income", json={
                "profile_id": pid, "date": d.isoformat(),
                "amount": 100 + i, "tax_treatment": "inclusive",
            })
        year = api_client.get(f"{base_url}/api/reports",
                              params={"profile_id": pid, "period": "year"}).json()
        # Sum quarter and adjacent windows: iterate 4 BAS quarters covering FY
        # Q1 Jul-Sep, Q2 Oct-Dec, Q3 Jan-Mar, Q4 Apr-Jun
        q_refs = [fy_start, fy_start + timedelta(days=100),
                  fy_start + timedelta(days=200), fy_start + timedelta(days=300)]
        total = 0.0
        seen_periods = set()
        for ref in q_refs:
            q = api_client.get(f"{base_url}/api/reports",
                               params={"profile_id": pid, "period": "quarter",
                                       "ref_date": ref.isoformat()}).json()
            assert (q["period_start"], q["period_end"]) not in seen_periods
            seen_periods.add((q["period_start"], q["period_end"]))
            total += q["total_income"]
        assert round(total, 2) == round(year["total_income"], 2)

    def test_recurring_prorated(self, base_url, api_client):
        pid = f"TEST_{uuid.uuid4().hex[:12]}"
        today = date.today()
        anchor = today - timedelta(days=7)  # exactly one week elapsed
        api_client.put(f"{base_url}/api/profile", json={
            "profile_id": pid, "work_type": "delivery",
            "vehicle_ownership": "lease",
            "recurring_payment": {"amount": 350, "frequency": "weekly",
                                  "anchor_type": "gigstart",
                                  "anchor_date": anchor.isoformat()},
            "registration_status": "registered",
        })
        rep = api_client.get(f"{base_url}/api/reports",
                             params={"profile_id": pid, "period": "quarter"}).json()
        gross = rep["vehicle_deduction"]["recurring_payment_gross"]
        # ~1 week elapsed => ~$350 (allow tolerance for boundary days)
        assert 300 <= gross <= 400, f"unexpected recurring gross {gross}"


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
class TestDashboard:
    def test_dashboard_today(self, base_url, api_client, seeded):
        r = api_client.get(f"{base_url}/api/dashboard",
                           params={"profile_id": seeded})
        assert r.status_code == 200
        d = r.json()
        assert d["income_today"] == 1100.0
        assert d["expense_today"] == 110 + 22 + 55
        assert d["net_today"] == round(1100 - (110 + 22 + 55), 2)
        assert d["business_distance_today"] == 80.0
        assert d["recurring"]["owed_this_quarter"] > 0
        assert len(d["recent"]) <= 8
        assert d["tax_setup_complete"] is True


# ---------------------------------------------------------------------------
# CSV export
# ---------------------------------------------------------------------------
class TestExport:
    def test_csv_contains_recurring_line(self, base_url, api_client, seeded):
        r = api_client.get(f"{base_url}/api/export",
                          params={"profile_id": seeded, "period": "quarter"})
        assert r.status_code == 200
        assert "text/csv" in r.headers.get("content-type", "")
        body = r.text
        assert "GigTax export" in body
        assert "Recurring vehicle payment (calculated)" in body
        assert "Total income" in body
        assert "G1 (total sales incl GST)" in body


# ---------------------------------------------------------------------------
# Receipt scanning (OpenAI gpt-4o via Emergent LLM)
# ---------------------------------------------------------------------------
def _real_receipt_png_b64() -> str:
    """Render a synthetic receipt PNG with real edges/text using Pillow."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (480, 640), "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 16)
    except Exception:
        font = ImageFont.load_default(); small = font
    d.rectangle([10, 10, 470, 630], outline="black", width=2)
    d.text((30, 30),  "BP CONNECT SERVO", fill="black", font=font)
    d.text((30, 70),  "123 King St, Sydney NSW", fill="black", font=small)
    d.text((30, 100), "ABN 12 345 678 901", fill="black", font=small)
    d.text((30, 150), "Date: 12/01/2026", fill="black", font=small)
    d.text((30, 180), "Time: 08:14", fill="black", font=small)
    d.line([20, 210, 460, 210], fill="black", width=1)
    d.text((30, 230), "Unleaded 91  32.45 L", fill="black", font=small)
    d.text((30, 260), "Price/L   $1.899", fill="black", font=small)
    d.line([20, 300, 460, 300], fill="black", width=1)
    d.text((30, 320), "SUBTOTAL", fill="black", font=font)
    d.text((300, 320), "$55.98", fill="black", font=font)
    d.text((30, 360), "GST 10%", fill="black", font=small)
    d.text((300, 360), "$5.60", fill="black", font=small)
    d.text((30, 410), "TOTAL", fill="black", font=font)
    d.text((300, 410), "$61.58", fill="black", font=font)
    d.text((30, 470), "PAID VISA ****1234", fill="black", font=small)
    d.text((30, 500), "Thank you — drive safe", fill="black", font=small)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


class TestReceiptScan:
    def test_scan_returns_expected_shape(self, base_url, api_client):
        b64 = _real_receipt_png_b64()
        r = api_client.post(f"{base_url}/api/receipts/scan",
                            json={"image_base64": b64}, timeout=90)
        assert r.status_code == 200, r.text
        j = r.json()
        assert set(["amount", "date", "merchant", "category"]).issubset(j.keys())
        assert j["category"] in ("fuel", "tolls", "vehicle", "phone", "other")
        # Amount should be numeric-ish (may be None if extraction fails)
        if j["amount"] is not None:
            assert isinstance(j["amount"], (int, float))
