"""Kalshi fee model: quadratic taker/maker fees with per-series multipliers.

Reference numbers come from Kalshi's published fee schedule (fee = 0.07 * C * P * (1 - P),
rounded up to the next cent) and the worked example in docs.kalshi.com "Fee Rounding".
"""
import math

import pytest

from kalshi_edge import fees


def test_taker_fee_unrounded_is_quadratic():
    assert fees.taker_fee(100, 0.50, rate=0.07, round_up=False) == pytest.approx(1.75)
    assert fees.taker_fee(100, 0.10, rate=0.07, round_up=False) == pytest.approx(0.63)
    assert fees.taker_fee(100, 0.90, rate=0.07, round_up=False) == pytest.approx(0.63)


def test_taker_fee_rounds_up_to_the_cent():
    # 1 contract at 99c: 0.07 * 0.99 * 0.01 = 0.000693 -> charged a full cent
    assert fees.taker_fee(1, 0.99, rate=0.07) == pytest.approx(0.01)
    # 100 contracts at 95c: 0.3325 -> 0.34
    assert fees.taker_fee(100, 0.95, rate=0.07) == pytest.approx(0.34)
    # exact cents are not bumped
    assert fees.taker_fee(100, 0.50, rate=0.07) == pytest.approx(1.75)


def test_fee_is_zero_at_the_boundaries_and_for_empty_orders():
    assert fees.taker_fee(0, 0.5) == 0.0
    assert fees.taker_fee(10, 0.0) == 0.0
    assert fees.taker_fee(10, 1.0) == 0.0


def test_fee_rejects_prices_outside_the_unit_interval():
    with pytest.raises(ValueError):
        fees.taker_fee(1, 1.2)
    with pytest.raises(ValueError):
        fees.taker_fee(1, -0.1)
    with pytest.raises(ValueError):
        fees.taker_fee(-1, 0.5)


def test_series_rate_uses_fee_type_and_multiplier():
    assert fees.series_rates({"fee_type": "quadratic", "fee_multiplier": 1}) == (pytest.approx(0.07), 0.0)
    assert fees.series_rates({"fee_type": "quadratic", "fee_multiplier": 0.5}) == (pytest.approx(0.035), 0.0)
    taker, maker = fees.series_rates({"fee_type": "quadratic_with_maker_fees", "fee_multiplier": 1})
    assert taker == pytest.approx(0.07) and maker == pytest.approx(0.0175)
    # a missing multiplier means 1, an unknown fee type must not be silently priced at zero
    assert fees.series_rates({"fee_type": "quadratic"}) == (pytest.approx(0.07), 0.0)
    with pytest.raises(ValueError):
        fees.series_rates({"fee_type": "flat_mystery", "fee_multiplier": 1})


def test_breakeven_probability_for_a_taker_buy():
    # buying at 60c with a 7% quadratic fee costs 0.60 + 0.07*0.6*0.4 = 0.6168 per contract
    assert fees.taker_cost_per_contract(0.60, rate=0.07) == pytest.approx(0.6168)
    # the fee is largest at 50c and vanishes at the extremes
    assert fees.taker_cost_per_contract(0.50, rate=0.07) - 0.50 == pytest.approx(0.0175)
    assert fees.taker_cost_per_contract(0.99, rate=0.07) - 0.99 == pytest.approx(0.000693)
    assert math.isclose(fees.taker_cost_per_contract(0.60, rate=0.0), 0.60)
