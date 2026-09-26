"""Vehicle lifecycle: a disposed vehicle must stop accruing recurring costs at
its disposal date, and a same-day replacement must not double-charge."""
from datetime import date

import tax


PERIOD_START = date(2026, 9, 1)
PERIOD_END = date(2026, 10, 1)
TODAY = date(2026, 9, 30)

V1 = {"amount": 280, "frequency": "weekly", "anchor_date": "2026-09-01"}
V2 = {"amount": 350, "frequency": "weekly", "anchor_date": "2026-09-15"}
DISPOSAL = date(2026, 9, 15)


def test_disposed_vehicle_stops_at_disposal_date():
    # 1 Sep -> 15 Sep exclusive = 14 days @ 280/7 = 40/day = 560
    owed = tax.recurring_owed(V1, PERIOD_START, PERIOD_END, TODAY, DISPOSAL)
    assert owed == 560.0


def test_replacement_charges_from_commencement():
    # 15 Sep -> 1 Oct exclusive = 16 days @ 350/7 = 50/day = 800
    owed = tax.recurring_owed(V2, PERIOD_START, PERIOD_END, TODAY, None)
    assert owed == 800.0


def test_no_double_charge_on_changeover_day():
    v1 = tax.recurring_owed(V1, PERIOD_START, PERIOD_END, TODAY, DISPOSAL)
    v2 = tax.recurring_owed(V2, PERIOD_START, PERIOD_END, TODAY, None)
    # 14 + 16 = 30 elapsed days across BOTH cars — never 31 (no overlap on 15 Sep).
    assert (v1 / 40.0) + (v2 / 50.0) == 30.0


def test_disposal_actually_reduces_cost_vs_no_disposal():
    with_disposal = tax.recurring_owed(V1, PERIOD_START, PERIOD_END, TODAY, DISPOSAL)
    without = tax.recurring_owed(V1, PERIOD_START, PERIOD_END, TODAY, None)
    assert with_disposal < without  # 560 < 1200 (the old overstated figure)


def test_helpers_read_disposal_date():
    assert tax._veh_end({"disposal_date": "2026-09-15"}) == DISPOSAL
    assert tax._veh_end({}) is None
    assert tax._veh_disposed_by({"disposal_date": "2026-09-15"}, TODAY) is True
    assert tax._veh_disposed_by({"disposal_date": "2026-09-15"}, date(2026, 9, 10)) is False
    assert tax._veh_disposed_by({}, TODAY) is False
