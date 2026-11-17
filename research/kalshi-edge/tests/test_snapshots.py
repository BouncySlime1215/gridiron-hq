"""Decision snapshots: what was knowable about a market h minutes before its game started.

The one property that matters most here is the clock. A feature may use a bar only if
the bar had completely finished by the decision time t0 = start - h. The fill is then
looked for in the bars that begin at or after t0 and end by the start. A bar that
straddles t0 is used for neither. If that boundary leaks, every result downstream is
fiction, so most of these tests are about the boundary.
"""
import datetime as dt

import duckdb
import pytest

from kalshi_edge import snapshots, tape

UTC = dt.timezone.utc
T = "KXNBAGAME-26NOV16HOUMIA-MIA"
START = dt.datetime(2026, 11, 16, 19, 0, tzinfo=UTC)   # on a 5-minute boundary


def at(minutes_before_start, start=START):
    return start - dt.timedelta(minutes=minutes_before_start)


def bar(bucket, close=0.50, ask=None, bid=None, ticker=T, **flow):
    """One bar row; `flow` sets class columns such as d_RBS_yes=10.0."""
    row = {"ticker": ticker, "series": tape.series_of(ticker), "bucket": bucket, "n_orders": 1, "n_fills": 1,
           "contracts": 0.0, "dollars": 0.0, "px_open": close, "px_close": close, "px_high": close, "px_low": close,
           "vwap": close, "ask_px": ask, "bid_px": bid}
    for kind in tape.KINDS:
        for size in tape.SIZES:
            for side in tape.SIDES:
                tag = f"{kind}{size}_{side}"
                row[f"c_{tag}"] = 0.0
                row[f"d_{tag}"] = 0.0
                row[f"n_{tag}"] = 0
    row.update(flow)
    row["dollars"] = sum(v for k, v in row.items() if k.startswith("d_"))
    row["n_orders"] = max(1, sum(v for k, v in row.items() if k.startswith("n_") and k not in ("n_orders", "n_fills")))
    return row


def snap(rows, h=10, starts=((T, START),), **kw):
    import pandas as pd
    con = duckdb.connect()
    bars = pd.DataFrame(rows)  # noqa: F841 (referenced by name in SQL)
    con.execute("create table bars as select * from bars")
    con.execute("alter table bars alter bucket type timestamptz")
    con.execute("create table starts(ticker varchar, t_start timestamptz)")
    con.executemany("insert into starts values (?, ?)", list(starts))
    return con.sql(snapshots.snapshot_sql("bars", "starts", h, **kw)).df()


def test_bar_that_ends_exactly_at_the_decision_time_is_a_feature():
    s = snap([bar(at(15), close=0.61)])            # [T-15, T-10) ends at t0 = T-10
    assert len(s) == 1
    assert s.p_last.iloc[0] == pytest.approx(0.61)
    assert s.n_bars.iloc[0] == 1


def test_bar_that_starts_at_the_decision_time_is_not_a_feature():
    s = snap([bar(at(15), close=0.61), bar(at(10), close=0.70, ask=0.71, bid=0.69)])
    assert s.p_last.iloc[0] == pytest.approx(0.61)   # the T-10 bar must not leak into features
    assert s.n_bars.iloc[0] == 1
    assert s.e1_ask.iloc[0] == pytest.approx(0.71)   # it is the first entry bar instead
    assert s.e1_bid.iloc[0] == pytest.approx(0.69)


def test_market_with_no_completed_bar_before_the_decision_time_is_omitted():
    assert len(snap([bar(at(10), close=0.70)])) == 0


def test_bar_straddling_an_off_grid_decision_time_is_neither_feature_nor_entry():
    start = dt.datetime(2026, 11, 16, 19, 7, tzinfo=UTC)      # t0 = 18:57
    rows = [bar(dt.datetime(2026, 11, 16, 18, 50, tzinfo=UTC), close=0.40),            # ends 18:55 -> feature
            bar(dt.datetime(2026, 11, 16, 18, 55, tzinfo=UTC), close=0.99, ask=0.99),  # straddles 18:57 -> ignored
            bar(dt.datetime(2026, 11, 16, 19, 0, tzinfo=UTC), close=0.45, ask=0.46),   # first full bar after t0 -> e1
            bar(dt.datetime(2026, 11, 16, 19, 5, tzinfo=UTC), close=0.80, ask=0.81)]   # ends 19:10 > start -> not an entry
    s = snap(rows, starts=((T, start),))
    assert s.p_last.iloc[0] == pytest.approx(0.40)
    assert s.e1_ask.iloc[0] == pytest.approx(0.46)
    assert s.e2_ask.isna().iloc[0]


def test_entry_bars_are_the_two_bars_after_the_decision_time():
    rows = [bar(at(15)), bar(at(10), ask=0.52, bid=0.50, d_INS_yes=30.0, d_RBS_no=7.0),
            bar(at(5), ask=0.55, bid=0.53, d_INL_yes=300.0)]
    s = snap(rows).iloc[0]
    assert (s.e1_ask, s.e1_bid, s.e2_ask, s.e2_bid) == (pytest.approx(0.52), pytest.approx(0.50),
                                                         pytest.approx(0.55), pytest.approx(0.53))
    assert s.e1_usd_yes == pytest.approx(30.0) and s.e1_usd_no == pytest.approx(7.0)
    assert s.e2_usd_yes == pytest.approx(300.0) and s.e2_usd_no == pytest.approx(0.0)


def test_in_game_bars_never_appear():
    rows = [bar(at(15), close=0.5), bar(at(0), close=0.9, ask=0.9, bid=0.9), bar(at(-30), close=0.99, ask=0.99)]
    s = snap(rows).iloc[0]
    assert s.p_last == pytest.approx(0.5)
    assert s.e1_ask != s.e1_ask and s.e2_ask != s.e2_ask   # NaN: nothing traded in the entry window


def test_last_quotes_skip_bars_without_a_taker_on_that_side():
    rows = [bar(at(30), close=0.50, ask=0.51, bid=0.49),
            bar(at(25), close=0.52, ask=0.53),             # no NO taker in this bar
            bar(at(20), close=0.51, bid=0.50)]             # no YES taker in this bar
    s = snap(rows).iloc[0]
    assert s.p_last == pytest.approx(0.51)
    assert s.ask0 == pytest.approx(0.53) and s.bid0 == pytest.approx(0.50)
    assert s.ask0_age_min == pytest.approx(15) and s.bid0_age_min == pytest.approx(10)


def test_lookback_window_drops_old_bars():
    rows = [bar(at(15), d_RBS_yes=10.0), bar(at(60 * 24 * 8), close=0.10, d_RBS_yes=1000.0)]
    s = snap(rows, lookback_days=7).iloc[0]
    assert s.usd == pytest.approx(10.0)
    assert s.n_bars == 1


def test_flow_is_collapsed_into_retail_buy_other_fractional_and_small_and_large_integer():
    rows = [bar(at(120), d_RBS_yes=5.0, d_RBM_yes=50.0, d_RBL_no=500.0, n_RBS_yes=1, n_RBM_yes=1, n_RBL_no=1,
                d_FXS_no=3.0, d_FXX_yes=4000.0, d_INS_yes=10.0, d_INM_no=100.0, d_INL_yes=1000.0, d_INX_no=9000.0)]
    s = snap(rows).iloc[0]
    assert (s.usd_rb_yes, s.usd_rb_no) == (pytest.approx(55.0), pytest.approx(500.0))
    assert (s.n_rb_yes, s.n_rb_no) == (2, 1)
    assert (s.usd_fx_yes, s.usd_fx_no) == (pytest.approx(4000.0), pytest.approx(3.0))
    assert (s.usd_ins_yes, s.usd_ins_no) == (pytest.approx(10.0), pytest.approx(100.0))
    assert (s.usd_inl_yes, s.usd_inl_no) == (pytest.approx(1000.0), pytest.approx(9000.0))
    assert s.usd == pytest.approx(55 + 500 + 3 + 4000 + 10 + 100 + 1000 + 9000)


def test_recent_window_is_the_last_sixty_minutes_before_the_decision_time():
    rows = [bar(at(75), d_RBS_yes=1.0),     # ends T-70: exactly 60 minutes before t0 -> outside (window is (t0-60, t0])
            bar(at(70), d_RBS_yes=2.0),     # starts T-70 = t0-60 -> inside
            bar(at(15), d_RBS_yes=4.0)]
    s = snap(rows).iloc[0]
    assert s.usd_rb_yes == pytest.approx(7.0)
    assert s.usd_rb_yes_60 == pytest.approx(6.0)


def test_earlier_prices_use_the_last_bar_that_had_finished_by_then():
    rows = [bar(at(400), close=0.30), bar(at(100), close=0.40), bar(at(75), close=0.45), bar(at(15), close=0.50)]
    s = snap(rows).iloc[0]
    assert s.p_m60 == pytest.approx(0.45)    # bar [T-75, T-70) finished at t0 - 60
    assert s.p_m360 == pytest.approx(0.30)   # t0 - 360 = T-370: only the T-400 bar had finished
    assert s.p_m1440 != s.p_m1440            # NaN: nothing that old


def test_horizon_moves_the_decision_time():
    rows = [bar(at(90), close=0.30), bar(at(60), close=0.35, ask=0.36), bar(at(15), close=0.50)]
    s = snap(rows, h=60).iloc[0]
    assert s.p_last == pytest.approx(0.30)
    assert s.e1_ask == pytest.approx(0.36)
    assert s.t0.to_pydatetime() == at(60)


def test_each_market_gets_its_own_clock():
    other = "KXNBAGAME-26NOV16LALBOS-BOS"
    later = START + dt.timedelta(hours=3)
    rows = [bar(at(15), close=0.5), bar(at(15, later), close=0.7, ticker=other),
            bar(at(15), close=0.9, ticker=other)]   # for `other` this is hours before its own start: a feature
    s = snap(rows, starts=((T, START), (other, later))).set_index("ticker")
    assert s.loc[T].p_last == pytest.approx(0.5)
    assert s.loc[other].p_last == pytest.approx(0.7)
    assert s.loc[other].n_bars == 2
