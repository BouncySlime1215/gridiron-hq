"""Strategy simulation over a snapshot table.

The simulator is vectorised for speed, so the main test is that it agrees bet for bet
with the scalar functions in kalshi_edge.backtest, which carry the money rules. The rest
pin the decision rules from the pre-registration: quotes must be fresh, the edge is
judged at the quote seen at decision time, the order is a limit order, and each event
gets at most one bet.
"""
import numpy as np
import pandas as pd
import pytest

from kalshi_edge import backtest as bt
from kalshi_edge import strategy


def row(**kw):
    base = dict(ticker="KXA-1-X", event_ticker="KXA-1", milestone_id="g1", ask0=0.60, bid0=0.58, ask0_age_min=5,
                bid0_age_min=5, e1_ask=0.60, e1_bid=0.58, e2_ask=np.nan, e2_bid=np.nan, e1_usd_yes=500.0, e1_usd_no=500.0,
                e2_usd_yes=0.0, e2_usd_no=0.0, taker_rate=0.07, y=1.0)
    base.update(kw)
    return base


def sim(rows, q, tau=0.01, **kw):
    df = pd.DataFrame(rows)
    return strategy.simulate(df, np.asarray(q, dtype=float), tau=tau, **kw)


def test_yes_bet_when_the_model_is_above_the_ask_by_more_than_the_threshold():
    b = sim([row()], [0.70])
    assert len(b) == 1 and b.side.iloc[0] == "yes"
    assert b.price.iloc[0] == pytest.approx(0.60)
    ref = bt.settle("yes", 0.60, 1.0, 0.07, 100.0)
    assert b.pnl.iloc[0] == pytest.approx(ref.pnl) and b.cost.iloc[0] == pytest.approx(ref.cost)


def test_no_bet_when_the_model_is_below_the_bid_by_more_than_the_threshold():
    b = sim([row(y=0.0)], [0.45])
    assert len(b) == 1 and b.side.iloc[0] == "no"
    assert b.price.iloc[0] == pytest.approx(1 - 0.58)
    assert b.pnl.iloc[0] == pytest.approx(bt.settle("no", 0.42, 0.0, 0.07, 100.0).pnl)


def test_no_bet_inside_the_spread_plus_fee():
    assert len(sim([row()], [0.61])) == 0          # 0.61 - 0.6168 < 0
    assert len(sim([row()], [0.59])) == 0


def test_stale_or_crossed_quotes_are_not_bet():
    assert len(sim([row(ask0_age_min=31)], [0.90])) == 0
    assert len(sim([row(bid0_age_min=31)], [0.90])) == 0
    assert len(sim([row(ask0=0.50, bid0=0.58)], [0.90])) == 0      # bid above ask: quotes from different moments
    assert len(sim([row(ask0=0.80, bid0=0.58)], [0.95])) == 0      # spread wider than 10c
    assert len(sim([row(ask0_age_min=31)], [0.90], max_quote_age=120)) == 1


def test_order_is_a_limit_and_fills_only_at_a_print_under_it():
    # model 0.70, tau 0.01 -> limit solves p + 0.07 p (1-p) = 0.69 -> about 0.6742
    lim = bt.limit_price(0.70, 0.01, 0.07)
    assert len(sim([row(e1_ask=lim + 0.01)], [0.70])) == 0                       # price ran away: no fill
    b = sim([row(e1_ask=lim + 0.01, e2_ask=0.62)], [0.70])                       # second bar comes back
    assert len(b) == 1 and b.price.iloc[0] == pytest.approx(0.62)
    assert len(sim([row(e1_ask=np.nan, e2_ask=np.nan)], [0.70])) == 0            # nobody traded: no bet
    b = sim([row(e1_ask=0.55)], [0.70])                                          # improved price is taken
    assert b.price.iloc[0] == pytest.approx(0.55)


def test_one_bet_per_event_keeps_the_largest_edge():
    rows = [row(ticker="KXA-1-X", ask0=0.60, bid0=0.58, e1_ask=0.60),
            row(ticker="KXA-1-Y", ask0=0.40, bid0=0.38, e1_ask=0.40, y=0.0),
            row(ticker="KXB-2-X", event_ticker="KXB-2", milestone_id="g2", ask0=0.30, bid0=0.28, e1_ask=0.30)]
    b = sim(rows, [0.70, 0.60, 0.45])     # edges at quote: 0.083, 0.183, 0.135
    assert sorted(b.ticker) == ["KXA-1-Y", "KXB-2-X"]


def test_one_bet_per_event_is_decided_before_the_fill_is_known():
    # the larger edge at decision time does not fill; the smaller one must NOT be used as a fallback
    rows = [row(ticker="KXA-1-X", ask0=0.60, e1_ask=0.60),
            row(ticker="KXA-1-Y", ask0=0.40, bid0=0.38, e1_ask=0.99)]
    b = sim(rows, [0.70, 0.60])
    assert len(b) == 0


def test_vectorised_results_match_the_scalar_money_functions():
    rng = np.random.default_rng(11)
    n = 400
    ask = rng.uniform(0.03, 0.97, n).round(2)
    bid = np.clip(ask - rng.integers(0, 4, n) / 100, 0.01, None).round(2)
    rows = [row(ticker=f"KX{i}-1-X", event_ticker=f"KX{i}-1", milestone_id=f"g{i}", ask0=ask[i], bid0=bid[i],
                e1_ask=np.clip(ask[i] + rng.integers(-2, 3) / 100, 0.01, 0.99).round(2),
                e1_bid=np.clip(bid[i] + rng.integers(-2, 3) / 100, 0.01, 0.99).round(2),
                e2_ask=np.clip(ask[i] + rng.integers(-2, 3) / 100, 0.01, 0.99).round(2),
                e2_bid=np.clip(bid[i] + rng.integers(-2, 3) / 100, 0.01, 0.99).round(2),
                taker_rate=rng.choice([0.07, 0.035]), y=float(rng.choice([0.0, 1.0, 0.5], p=[0.48, 0.48, 0.04])))
            for i in range(n)]
    q = np.clip((ask + bid) / 2 + rng.normal(0, 0.06, n), 0.01, 0.99)
    df = pd.DataFrame(rows)
    b = strategy.simulate(df, q, tau=0.01).set_index("ticker")
    n_ref = 0
    for i, r in df.iterrows():
        e_yes, e_no = bt.edges(q[i], r.ask0, r.bid0, r.taker_rate)
        best = max((e for e in (e_yes, e_no) if e is not None), default=None)
        if best is None or best < 0.01:
            assert r.ticker not in b.index
            continue
        side = "yes" if e_yes == best else "no"
        qq = q[i] if side == "yes" else 1 - q[i]
        prints = [r.e1_ask, r.e2_ask] if side == "yes" else [1 - r.e1_bid, 1 - r.e2_bid]
        px = bt.fill_price(bt.limit_price(qq, 0.01, r.taker_rate), prints)
        if px is None:
            assert r.ticker not in b.index
            continue
        ref = bt.settle(side, px, r.y, r.taker_rate, 100.0)
        got = b.loc[r.ticker]
        assert got.side == side
        assert got.price == pytest.approx(px)
        assert got.contracts == pytest.approx(ref.contracts)
        assert got.cost == pytest.approx(ref.cost)
        assert got.pnl == pytest.approx(ref.pnl)
        n_ref += 1
    assert n_ref == len(b) and n_ref > 50


def test_capacity_is_the_same_side_taker_dollars_in_the_fill_bar():
    b = sim([row(e1_ask=0.99, e2_ask=0.61, e1_usd_yes=111.0, e2_usd_yes=222.0)], [0.70])
    assert b.fill_bar.iloc[0] == 2 and b.capacity_usd.iloc[0] == pytest.approx(222.0)


def test_summary_reports_return_on_stake_with_a_game_clustered_interval():
    rows = [row(ticker=f"KX{i}-1-X", event_ticker=f"KX{i}-1", milestone_id=f"g{i % 40}", y=float(i % 3 != 0)) for i in range(200)]
    b = sim(rows, [0.70] * 200)
    s = strategy.summarize(b, n_boot=500)
    assert s["bets"] == 200 and s["games"] == 40
    assert s["roi"] == pytest.approx(b.pnl.sum() / b.cost.sum())
    assert s["lo"] < s["roi"] < s["hi"]
    assert s["staked"] == pytest.approx(b.cost.sum())


def test_summary_interval_is_clustered_by_game_not_by_bet():
    # 40 games, 10 bets each, every bet in a game sharing its result: the honest interval is the 40-game one
    rows = [row(ticker=f"KX{i}-1-X", event_ticker=f"KX{i}-1", milestone_id=f"g{i % 40}", y=float((i % 40) % 2)) for i in range(400)]
    b = sim(rows, [0.70] * 400)
    s = strategy.summarize(b, n_boot=2000)
    from kalshi_edge import stats
    per_bet = stats.cluster_bootstrap_ratio(b.pnl.to_numpy(), b.cost.to_numpy(), np.arange(len(b)), n_boot=2000, seed=0)
    assert (s["hi"] - s["lo"]) > 2.5 * (per_bet.hi - per_bet.lo)
