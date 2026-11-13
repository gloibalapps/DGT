"""Print Python tax/UE/Fernet results for the Deno parity tests. Not a migration."""
import datetime as dt
import json
import sys

sys.path.insert(0, "backend")
import tax  # noqa: E402
import ue_guarantee as ue  # noqa: E402
from cryptography.fernet import Fernet  # noqa: E402


class FrozenDate(dt.date):
    @classmethod
    def today(cls):
        y, m, d = map(int, sys.argv[2].split("-")) if len(sys.argv) > 2 and sys.argv[1] == "calc" else (2026, 11, 11)
        return cls(y, m, d)


def calc():
    raw = json.load(open(sys.argv[2]))
    today = tax.parse_date(raw["today"])
    FrozenDate.today = classmethod(lambda cls: cls(today.year, today.month, today.day))  # type: ignore
    tax.date = FrozenDate
    p, trips, inc, exp, shifts, vehs = (
        raw["profile"], raw["trips"], raw["incomes"], raw["expenses"], raw["shifts"], raw["vehicles"])
    us = dict(p, country="US", region="TX")
    ref = today
    start = tax.parse_date(raw["analytics_start"])
    end = tax.parse_date(raw["analytics_end"]) + dt.timedelta(days=1)
    out = {
        "report": tax.compute_report(p, trips, inc, exp, "quarter", ref, vehs),
        "report_us": tax.compute_report(us, trips, inc, exp, "year", ref, vehs),
        "dashboard": tax.dashboard(p, trips, inc, exp, ref, vehs),
        "performance": tax.performance(p, trips, inc, exp, ref, shifts),
        "insights": tax.insights(p, inc, exp, shifts, ref),
        "money": tax.money_overview(p, trips, inc, exp, shifts, ref, period="week", vehicles=vehs),
        "tax_mileage": tax.tax_mileage(p, trips, inc, exp, ref, vehicles=vehs),
        "analytics": tax.compute_analytics(p, trips, inc, exp, shifts, vehs, start, end, ["Uber Eats"], "v1"),
        "summarise": ue.summarise(raw["ue_jobs"], ue.RATES["car"]),
    }
    json.dump(out, sys.stdout)


def fernet_make():
    key = Fernet.generate_key()
    token = Fernet(key).encrypt(b"existing-drive-refresh")
    json.dump({"key": key.decode(), "token": token.decode(), "plain": "existing-drive-refresh"}, sys.stdout)


def fernet_open():
    key, token = sys.argv[2], sys.argv[3]
    print(Fernet(key.encode()).decrypt(token.encode()).decode())


if __name__ == "__main__":
    {"calc": calc, "make": fernet_make, "open": fernet_open}[sys.argv[1]]()
