import pandas as pd
import pytest

from house import shadow
from house.grid import to_units as u

DAY = 86_400.0


def sweep(ts, side=1, ref="0.25", score=1000.0, ok=True, valid=True, perday=22.0, ticker="MKT"):
    return dict(ts=ts, ticker=ticker, side=side, ok=ok, valid=valid, ref=u(ref), score=score, perday=perday)


def run(rows, dollars=25.0, **kw):
    return shadow.joiner(shadow.intervals(pd.DataFrame(rows), **kw), dollars)


def test_a_newcomers_share_is_their_size_over_everyones_and_one_side_is_half_the_pool():
    # $25 at 25c is 100 contracts; 100 / (1000 + 100) of the side; the side is half of $22 a day
    j = run([sweep(0), sweep(DAY)], max_gap=DAY)
    assert len(j) == 1
    assert j.contracts.iloc[0] == 100
    assert j.reward.iloc[0] == pytest.approx(22 * 0.5 * 100 / 1100) == pytest.approx(1.0)
    assert j.collateral_days.iloc[0] == 25.0


def test_no_reward_while_the_snapshot_does_not_count_but_the_money_is_still_tied_up():
    j = run([sweep(0, valid=False), sweep(DAY)], max_gap=DAY)
    assert j.reward.iloc[0] == 0 and j.collateral_days.iloc[0] == 25.0


def test_a_side_with_no_reference_price_has_nowhere_to_rest():
    j = run([sweep(0, ok=False, valid=False, ref="0"), sweep(DAY)], max_gap=DAY)
    assert j.contracts.iloc[0] == 0 and j.collateral_days.iloc[0] == 0 and j.reward.iloc[0] == 0


def test_the_last_sweep_and_a_sweep_before_a_long_gap_start_no_interval():
    j = run([sweep(0), sweep(100), sweep(5000), sweep(5100)], max_gap=900)
    assert list(j.ts) == [0, 5000] and list(j.dt) == [100, 100]


def test_the_cautious_reward_drops_any_interval_where_the_reference_moved_or_validity_was_lost():
    j = run([sweep(0), sweep(100, ref="0.26"), sweep(200, ref="0.26", valid=False), sweep(300, ref="0.26")])
    assert list(j.reward > 0) == [True, True, False]
    assert list(j.reward_lo > 0) == [False, False, False]
    steady = run([sweep(0), sweep(100), sweep(200)])
    assert list(steady.reward_lo) == list(steady.reward)


def test_side_markets_are_paired_only_with_themselves():
    j = run([sweep(0), sweep(50, side=0, ref="0.70"), sweep(100), sweep(150, side=0, ref="0.70")])
    assert sorted(zip(j.side, j.dt)) == [(0, 100), (1, 100)]


def trade(ts, taker_yes, yes_px, contracts, ticker="MKT"):
    return dict(ts=ts, ticker=ticker, taker_yes=taker_yes, yes_px=u(yes_px), contracts=contracts)


def test_a_yes_bid_is_hit_by_a_taker_selling_yes_at_or_below_it_and_never_by_a_yes_buyer():
    pos = run([sweep(0), sweep(100), sweep(200)])
    f = shadow.fills(pos, pd.DataFrame([
        trade(10, False, "0.26", 5),      # sold above our bid: someone else's order
        trade(20, True, "0.25", 500),     # a YES buyer lifts offers, not bids
        trade(30, False, "0.25", 40),     # hits us
        trade(40, False, "0.24", 30),     # trades through us
    ]))
    assert len(f) == 1 and f.filled.iloc[0] == 70 and f.price.iloc[0] == u("0.25") and f.trade_ts.iloc[0] == 30
    assert f.cost.iloc[0] == pytest.approx(17.5)


def test_a_no_bid_is_hit_by_a_yes_buyer_paying_at_least_one_minus_its_price():
    pos = run([sweep(0, side=0, ref="0.70"), sweep(100, side=0, ref="0.70")])
    f = shadow.fills(pos, pd.DataFrame([
        trade(10, True, "0.29", 9),       # YES at 29c is NO at 71c: above our 70c bid, not ours
        trade(20, True, "0.30", 9),       # NO at 70c: ours
        trade(30, False, "0.30", 9),      # a NO buyer is on our side of the book
    ]))
    assert len(f) == 1 and f.filled.iloc[0] == 9 and f.side.iloc[0] == 0


def test_a_fill_is_capped_at_the_order_and_trades_outside_the_interval_do_not_count():
    pos = run([sweep(0), sweep(100)])
    f = shadow.fills(pos, pd.DataFrame([trade(50, False, "0.20", 5000), trade(150, False, "0.20", 5000)]))
    assert len(f) == 1 and f.filled.iloc[0] == 100          # $25 at 25c
    assert shadow.fills(pos, pd.DataFrame([trade(150, False, "0.20", 5000)])).empty


def test_fills_in_another_market_are_not_ours():
    pos = run([sweep(0), sweep(100)])
    assert shadow.fills(pos, pd.DataFrame([trade(50, False, "0.20", 10, ticker="OTHER")])).empty


def test_a_fill_is_marked_on_the_side_that_was_bought():
    f = pd.DataFrame([dict(side=1, filled=100.0, price=u("0.25")), dict(side=0, filled=100.0, price=u("0.70"))])
    m = shadow.mark(f, pd.Series([0.0, 0.0]))
    assert list(m.pnl) == pytest.approx([-25.0, 30.0])       # YES expired worthless: the YES bid lost, the NO bid won
    m = shadow.mark(f, pd.Series([1.0, 1.0]))
    assert list(m.pnl) == pytest.approx([75.0, -70.0])
