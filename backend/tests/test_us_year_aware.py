"""US year-aware tax engine tests (2025 vs 2026).

Covers the review-request scenarios:
- Standard deduction: $15,000 (2025) vs $16,100 (2026) single-filer.
- Federal income tax brackets: 2026 brackets (10/12/22/24/32/35/37) with 2026 caps.
- SE tax with Social Security wage-base cap: $176,100 (2025), $184,500 (2026);
  Medicare 2.9% uncapped; typical gig income stays ~15.3%; very high net profit
  caps out the SS portion.
- Standard mileage: 70c/mi (2025); 72.5c/mi Jan-Jun 2026, 76c/mi Jul-Dec 2026.
- tax_jar/dashboard: applies the correct year's figures based on ref_date year.

All tests use the public EXPO_PUBLIC_BACKEND_URL.
"""
import os
import uuid
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")
BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _pid():
    return f"TEST_{uuid.uuid4().hex[:12]}"


def _seed_us(pid, region="CA", work_type="delivery"):
    r = requests.put(
        f"{BASE_URL}/api/profile",
        json={"profile_id": pid, "country": "US", "region": region,
              "work_type": work_type, "legal_name": "TEST Driver"},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _add_income(pid, dt, amount):
    r = requests.post(f"{BASE_URL}/api/income",
                      json={"profile_id": pid, "date": dt, "amount": amount,
                            "platform": "Uber"})
    assert r.status_code == 200, r.text


def _add_trip(pid, dt, dist, typ="business"):
    r = requests.post(f"{BASE_URL}/api/trips",
                      json={"profile_id": pid, "date": dt,
                            "distance_km": dist, "type": typ})
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Direct math checks on backend/tax.py helpers
# (imported here so regressions in the pure functions fail immediately.)
# ---------------------------------------------------------------------------
class TestPureHelpers:
    """Exercises the year-aware helpers directly."""

    def test_us_std_deduction_by_year(self):
        from tax import us_std_deduction
        assert us_std_deduction(2025) == 15000.0
        assert us_std_deduction(2026) == 16100.0

    def test_us_tax_year_clamps(self):
        from tax import us_tax_year
        from datetime import date
        assert us_tax_year(date(2025, 6, 15)) == 2025
        assert us_tax_year(date(2026, 6, 15)) == 2026
        # future years clamp to the latest supported (2026)
        assert us_tax_year(date(2030, 1, 1)) == 2026
        # very old years also fall back to a supported year
        assert us_tax_year(date(2000, 1, 1)) in (2025, 2026)

    def test_us_federal_income_tax_2025_vs_2026(self):
        """Same $60k taxable → 2026 owes slightly less (brackets shift up)."""
        from tax import us_federal_income_tax
        # 2025 brackets: 10% to 11925, 12% to 48475, 22% to 103350...
        # $60k: 11925*.10 + (48475-11925)*.12 + (60000-48475)*.22 = 8113.00
        assert us_federal_income_tax(60000, 2025) == 8114.00
        # 2026 brackets: 10% to 12400, 12% to 50400, 22% to 105700...
        # $60k: 12400*.10 + (50400-12400)*.12 + (60000-50400)*.22 = 7912.00
        assert us_federal_income_tax(60000, 2026) == 7912.00

    def test_us_se_tax_typical_vs_capped(self):
        """~15.3% for typical gig income; SS portion caps at wage base."""
        from tax import us_se_tax
        # Typical: $60k net → 60000*.9235 = 55410; 55410*.153 = 8477.73
        assert us_se_tax(60000, 2025) == 8477.73
        assert us_se_tax(60000, 2026) == 8477.73

        # Very high net (SS portion caps out at wage base):
        # 2025 wage base 176100; net_se = 300000*.9235 = 277050
        # SS = min(277050, 176100)*.124 = 21836.4
        # Medicare = 277050*.029 = 8034.45
        # SE = 29870.85
        assert us_se_tax(300000, 2025) == 29870.85
        # 2026 wage base 184500; SS = 184500*.124 = 22878.0
        # SE = 22878.0 + 277050*.029 = 30912.45
        assert us_se_tax(300000, 2026) == 30912.45

    def test_us_mileage_rate_date_keyed(self):
        from tax import us_mileage_rate
        from datetime import date
        assert us_mileage_rate(date(2025, 6, 30)) == 0.70
        # 2026 mid-year change: Jan-Jun = 0.725, Jul-Dec = 0.76
        assert us_mileage_rate(date(2026, 1, 1)) == 0.725
        assert us_mileage_rate(date(2026, 6, 30)) == 0.725
        assert us_mileage_rate(date(2026, 7, 1)) == 0.76
        assert us_mileage_rate(date(2026, 12, 31)) == 0.76


# ---------------------------------------------------------------------------
# End-to-end via the API — 2026 report picks up 2026 std deduction & brackets
# ---------------------------------------------------------------------------
class TestYearAwareReports:
    def test_2025_vs_2026_tax_jar_on_dashboard(self):
        """Same $60k net profit yields different fed tax in 2025 vs 2026
        because the standard deduction and brackets differ."""
        # ---- 2025 profile ----
        pid25 = _pid()
        _seed_us(pid25)
        _add_income(pid25, "2025-05-01", 60000)
        rep25 = requests.get(f"{BASE_URL}/api/reports",
                             params={"profile_id": pid25, "period": "year",
                                     "ref_date": "2025-06-15"}).json()
        assert rep25["country"] == "US"
        assert rep25["se_tax"]["tax_year"] == 2025

        # se_tax on $60k: 60000*.9235*.153 = 8477.73
        se25 = rep25["se_tax"]["amount"]
        assert se25 == 8477.73

        # ---- 2026 profile ----
        pid26 = _pid()
        _seed_us(pid26)
        _add_income(pid26, "2026-05-01", 60000)
        rep26 = requests.get(f"{BASE_URL}/api/reports",
                             params={"profile_id": pid26, "period": "year",
                                     "ref_date": "2026-06-15"}).json()
        assert rep26["se_tax"]["tax_year"] == 2026
        se26 = rep26["se_tax"]["amount"]
        assert se26 == 8477.73  # SE tax same at typical income

        # ---- Dashboard tax_jar picks up the correct year's fed tax ----
        # 2025: taxable = 60000 - 8477.73/2 - 15000 = 40761.135
        # fed 2025 on 40761.14: 11925*.10 + (40761.14-11925)*.12 = 4652.84
        jar25 = requests.get(f"{BASE_URL}/api/dashboard",
                             params={"profile_id": pid25,
                                     "ref_date": "2025-06-15"}).json()["tax_jar"]
        fed25 = [c for c in jar25["components"]
                 if c["label"].startswith("Federal")][0]["amount"]
        assert fed25 == 4652.84

        # 2026: taxable = 60000 - 8477.73/2 - 16100 = 39661.135
        # fed 2026: 12400*.10 + (39661.14-12400)*.12 = 1240 + 3271.34 = 4511.34
        jar26 = requests.get(f"{BASE_URL}/api/dashboard",
                             params={"profile_id": pid26,
                                     "ref_date": "2026-06-15"}).json()["tax_jar"]
        fed26 = [c for c in jar26["components"]
                 if c["label"].startswith("Federal")][0]["amount"]
        assert fed26 == 4511.34

        # 2026 owes less federal tax (bigger std ded + wider brackets)
        assert fed26 < fed25

    def test_us_mileage_year_report_sums_date_keyed_rates(self):
        """Standard mileage in a 2026 year report sums each trip's miles ×
        the IRS rate applicable to that trip's date."""
        pid = _pid()
        _seed_us(pid)
        # 100 mi in Feb (0.725) + 100 mi in Aug (0.76) = 72.5 + 76.0 = 148.5
        _add_trip(pid, "2026-02-15", 100, "business")
        _add_trip(pid, "2026-08-15", 100, "business")

        rep = requests.get(f"{BASE_URL}/api/reports",
                           params={"profile_id": pid, "period": "year",
                                   "ref_date": "2026-06-15"}).json()
        assert rep["country"] == "US"
        assert rep["schedule_c"]["standard_mileage"] == 148.5

    def test_us_se_tax_ss_cap_2026_via_api(self):
        """Very-high net profit exercises the SS wage-base cap on SE tax."""
        pid = _pid()
        _seed_us(pid)
        _add_income(pid, "2026-05-01", 300000)
        rep = requests.get(f"{BASE_URL}/api/reports",
                           params={"profile_id": pid, "period": "year",
                                   "ref_date": "2026-06-15"}).json()
        assert rep["se_tax"]["tax_year"] == 2026
        # net_profit = 300000 (no deductions), SS capped at 184500 for 2026
        # SE = 184500*.124 + (300000*.9235)*.029 = 22878.0 + 8034.45 = 30912.45
        assert rep["se_tax"]["amount"] == 30912.45


# ---------------------------------------------------------------------------
# AU regression — untouched by the US year-aware changes
# ---------------------------------------------------------------------------
class TestAURegression:
    def test_au_endpoints_still_200(self):
        pid = _pid()
        r = requests.put(f"{BASE_URL}/api/profile",
                         json={"profile_id": pid, "country": "AU",
                               "work_type": "delivery",
                               "registration_status": "registered",
                               "legal_name": "TEST AU Driver"})
        assert r.status_code == 200
        _add_income(pid, "2026-08-15", 1100)
        _add_trip(pid, "2026-08-15", 80, "business")

        for path, params in [
            ("dashboard", {"profile_id": pid}),
            ("reports", {"profile_id": pid, "period": "year",
                         "ref_date": "2026-08-15"}),
            ("reports", {"profile_id": pid, "period": "quarter",
                         "ref_date": "2026-08-15"}),
            ("money", {"profile_id": pid, "period": "week",
                       "ref_date": "2026-08-15"}),
            ("tax-mileage", {"profile_id": pid, "ref_date": "2026-08-15"}),
        ]:
            r = requests.get(f"{BASE_URL}/api/{path}", params=params)
            assert r.status_code == 200, f"{path} → {r.status_code}: {r.text[:200]}"
            # AU currency / unit unaffected by US changes
            j = r.json()
            if "currency" in j:
                assert j["currency"] == "AUD"
            if "distance_unit" in j:
                assert j["distance_unit"] == "km"
