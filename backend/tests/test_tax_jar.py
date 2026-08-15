"""Tests for the Tax-Savings Jar on GET /api/dashboard (US + AU + edge cases)."""
import os
import uuid
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")
BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")


# --- helpers ---------------------------------------------------------------
def _new_profile(country="AU", **extra):
    pid = f"TEST_{uuid.uuid4().hex[:12]}"
    body = {"profile_id": pid, "country": country,
            "legal_name": "T Driver", "onboarded": True, **extra}
    r = requests.put(f"{BASE_URL}/api/profile", json=body, timeout=15)
    assert r.status_code == 200, r.text
    return pid


def _add_income(pid, amount, dt, platform="TEST"):
    r = requests.post(f"{BASE_URL}/api/income",
                      json={"profile_id": pid, "amount": amount, "date": dt,
                            "platform": platform, "tax_treatment": "inclusive"},
                      timeout=15)
    assert r.status_code == 200, r.text
    return r.json()


def _add_trip(pid, km, dt, ttype="business"):
    r = requests.post(f"{BASE_URL}/api/trips",
                      json={"profile_id": pid, "distance_km": km, "date": dt,
                            "type": ttype, "purpose": "deliver"},
                      timeout=15)
    assert r.status_code == 200, r.text
    return r.json()


def _dashboard(pid, ref):
    r = requests.get(f"{BASE_URL}/api/dashboard",
                     params={"profile_id": pid, "ref_date": ref}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()


# --- 1. shape --------------------------------------------------------------
class TestTaxJarShape:
    def test_dashboard_returns_tax_jar_object(self):
        pid = _new_profile("AU")
        d = _dashboard(pid, "2026-03-01")
        assert "tax_jar" in d, "dashboard must expose tax_jar"
        jar = d["tax_jar"]
        for key in ("set_aside", "rate_pct", "net_profit",
                    "tax_year_label", "components", "symbol", "note"):
            assert key in jar, f"tax_jar missing key: {key}"
        assert isinstance(jar["components"], list)
        # regression: existing dashboard keys still there
        for key in ("income_today", "recurring", "recent", "tax_setup_complete"):
            assert key in d


# --- 2. US -----------------------------------------------------------------
class TestTaxJarUS:
    def test_us_jar_components_and_positive_set_aside(self):
        pid = _new_profile("US")
        _add_income(pid, 40000.0, "2026-03-15")
        _add_trip(pid, 2000.0, "2026-03-15")
        d = _dashboard(pid, "2026-06-30")
        jar = d["tax_jar"]
        labels = [c["label"] for c in jar["components"]]
        assert "Self-employment tax" in labels
        assert "Federal income tax (est.)" in labels
        se = next(c["amount"] for c in jar["components"] if c["label"] == "Self-employment tax")
        fed = next(c["amount"] for c in jar["components"] if c["label"] == "Federal income tax (est.)")
        assert se > 0
        assert fed >= 0
        # set_aside = sum of all components (SE + Fed + optional State)
        comp_sum = round(sum(c["amount"] for c in jar["components"]), 2)
        assert abs(jar["set_aside"] - comp_sum) < 0.02
        assert jar["set_aside"] > 0
        assert jar["tax_year_label"] == "2026"
        assert jar["net_profit"] > 0
        assert jar["rate_pct"] > 0


# --- 3. AU -----------------------------------------------------------------
class TestTaxJarAU:
    def test_au_jar_income_tax_only_when_unregistered(self):
        pid = _new_profile("AU", registration_status="not_registered", work_type="delivery")
        _add_income(pid, 50000.0, "2026-08-10")   # inside 2026-27 FY (starts 1 Jul 2026)
        d = _dashboard(pid, "2026-09-01")
        jar = d["tax_jar"]
        labels = [c["label"] for c in jar["components"]]
        assert "Income tax (est.)" in labels
        assert "GST to remit" not in labels   # unregistered → no GST component
        it = next(c["amount"] for c in jar["components"] if c["label"] == "Income tax (est.)")
        # 50k AU resident 2024-25 brackets: (45000-18200)*0.16 + (50000-45000)*0.30 = 4288 + 1500 = 5788
        # + 2% Medicare levy on 50k = 1000 → 6788
        assert abs(it - 6788.0) < 1.0, f"expected ~6788 got {it}"
        assert abs(jar["set_aside"] - it) < 0.02
        assert jar["tax_year_label"] == "2026\u201327"
        assert jar["net_profit"] == 50000.0

    def test_au_jar_gst_component_when_registered_passengers(self):
        pid = _new_profile("AU", registration_status="registered", work_type="passengers")
        _add_income(pid, 50000.0, "2026-08-10")
        d = _dashboard(pid, "2026-09-01")
        jar = d["tax_jar"]
        labels = [c["label"] for c in jar["components"]]
        assert "Income tax (est.)" in labels
        assert "GST to remit" in labels
        gst = next(c["amount"] for c in jar["components"] if c["label"] == "GST to remit")
        # $50,000 GST-inclusive income => GST = 50000 / 11 ≈ 4545.45 remit
        assert gst > 4000  # sanity


# --- 4. Zero-data ----------------------------------------------------------
class TestTaxJarZero:
    def test_fresh_profile_has_zero_jar(self):
        pid = _new_profile("AU")
        d = _dashboard(pid, "2026-03-01")
        jar = d["tax_jar"]
        assert jar["set_aside"] == 0
        assert jar["rate_pct"] == 0
        assert jar["net_profit"] == 0
        # no crash → components list still returned
        assert isinstance(jar["components"], list)

    def test_fresh_us_profile_has_zero_jar(self):
        pid = _new_profile("US")
        d = _dashboard(pid, "2026-03-01")
        jar = d["tax_jar"]
        assert jar["set_aside"] == 0
        assert jar["rate_pct"] == 0


# --- 5. Regression: dashboard AU unit is km --------------------------------
class TestDashboardRegression:
    def test_au_distance_unit_km(self):
        pid = _new_profile("AU")
        d = _dashboard(pid, "2026-03-01")
        assert d["distance_unit"] == "km"

    def test_us_distance_unit_mi(self):
        pid = _new_profile("US")
        d = _dashboard(pid, "2026-03-01")
        assert d["distance_unit"] == "mi"
