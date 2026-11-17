"""Bet accounting: the limit a model edge implies, whether it fills, and what it pays.

Money rules pinned here: a bet never costs more than its stake, fees are always paid,
a NO bet is priced off the bid print, a void pays the settlement value, and a market
with no qualifying print is no bet at all (not a zero-profit bet).
"""
import math

import pytest

from kalshi_edge import backtest as bt
from kalshi_edge import fees


def test_limit_price_is_where_edge_equals_the_threshold():
    q, tau, rate = 0.70, 0.02, 0.07
    lim = bt.limit_price(q, tau, rate)
    assert fees.taker_cost_per_contract(lim, rate) == pytest.approx(q - tau, abs=1e-9)
    assert bt.limit_price(q, tau, 0.0) == pytest.approx(q - tau)
    # a bigger required edge means a lower limit; a fee means a lower limit than no fee
    assert bt.limit_price(q, 0.05, rate) < lim < bt.limit_price(q, tau, 0.0)


def test_limit_price_is_none_when_no_price_can_give_the_edge():
    assert bt.limit_price(0.01, 0.02, 0.07) is None
    assert bt.limit_price(0.50, 0.60, 0.07) is None


def test_limit_price_never_exceeds_a_dollar():
    assert bt.limit_price(1.0, 0.0, 0.07) == pytest.approx(1.0)
    assert bt.limit_price(1.0, -0.05, 0.07) == pytest.approx(1.0)


def test_fill_takes_the_first_print_at_or_under_the_limit():
    nan = float("nan")
    assert bt.fill_price(0.60, [0.59, 0.55]) == pytest.approx(0.59)      # first bar qualifies
    assert bt.fill_price(0.60, [0.61, 0.58]) == pytest.approx(0.58)      # first too dear, second fills
    assert bt.fill_price(0.60, [0.60, nan]) == pytest.approx(0.60)       # at the limit counts
    assert bt.fill_price(0.60, [0.61, 0.62]) is None
    assert bt.fill_price(0.60, [nan, nan]) is None
    assert bt.fill_price(0.60, [None, 0.50]) == pytest.approx(0.50)
    assert bt.fill_price(None, [0.10, 0.10]) is None


def test_yes_bet_wins_and_loses():
    win = bt.settle("yes", price=0.60, settle_yes=1.0, rate=0.07, stake=100.0)
    lose = bt.settle("yes", price=0.60, settle_yes=0.0, rate=0.07, stake=100.0)
    # 100 / 0.6168 = 162.127 contracts, but the fee rounds up to the cent (2.73), which would make
    # 162.12 contracts cost 100.002. The largest size that fits the stake is 162.11.
    assert win.contracts == pytest.approx(162.11)
    assert win.cost <= 100.0 and win.cost == pytest.approx(162.11 * 0.60 + win.fee)
    assert win.fee == pytest.approx(math.ceil(0.07 * 162.11 * 0.6 * 0.4 * 100 - 1e-9) / 100)
    assert win.pnl == pytest.approx(162.11 - win.cost)
    assert 100.0 - win.cost < 0.02      # and it uses the stake: no more than a tick is left over
    assert lose.pnl == pytest.approx(-lose.cost)
    assert win.cost == pytest.approx(lose.cost)


def test_no_bet_is_priced_at_one_minus_the_yes_price_and_pays_when_yes_fails():
    # NO bought when a NO taker printed at yes-price 0.25 -> NO costs 0.75
    win = bt.settle("no", price=0.75, settle_yes=0.0, rate=0.07, stake=100.0)
    lose = bt.settle("no", price=0.75, settle_yes=1.0, rate=0.07, stake=100.0)
    assert win.pnl == pytest.approx(win.contracts - win.cost) and win.pnl > 0
    assert lose.pnl == pytest.approx(-lose.cost)


def test_void_pays_the_settlement_value():
    half = bt.settle("yes", price=0.60, settle_yes=0.5, rate=0.07, stake=100.0)
    assert half.pnl == pytest.approx(half.contracts * 0.5 - half.cost)
    half_no = bt.settle("no", price=0.40, settle_yes=0.5, rate=0.07, stake=100.0)
    assert half_no.pnl == pytest.approx(half_no.contracts * 0.5 - half_no.cost)


def test_fee_is_always_charged_and_zero_rate_means_zero_fee():
    assert bt.settle("yes", 0.50, 1.0, rate=0.07).fee > 0
    assert bt.settle("yes", 0.50, 1.0, rate=0.0).fee == 0.0
    # a fair coin at 50c loses exactly the fee on average
    w = bt.settle("yes", 0.50, 1.0, rate=0.07)
    l = bt.settle("yes", 0.50, 0.0, rate=0.07)
    assert (w.pnl + l.pnl) / 2 == pytest.approx(-w.fee, abs=0.01)


def test_settle_rejects_nonsense():
    with pytest.raises(ValueError):
        bt.settle("maybe", 0.5, 1.0)
    with pytest.raises(ValueError):
        bt.settle("yes", 0.0, 1.0)      # a free contract is not a bet
    with pytest.raises(ValueError):
        bt.settle("yes", 0.5, 1.5)


def test_edge_at_quote_for_each_side():
    # model says 70%. YES at 0.60 costs 0.6168 -> edge 0.0832. NO at (1 - bid 0.58) = 0.42 costs 0.4371 -> edge 0.30 - 0.4371 < 0
    e_yes, e_no = bt.edges(q=0.70, ask=0.60, bid=0.58, rate=0.07)
    assert e_yes == pytest.approx(0.70 - 0.6168)
    assert e_no == pytest.approx(0.30 - (0.42 + 0.07 * 0.42 * 0.58))
    # a missing quote gives no edge on that side rather than a guess
    e_yes, e_no = bt.edges(q=0.70, ask=float("nan"), bid=0.58, rate=0.07)
    assert e_yes is None and e_no is not None
