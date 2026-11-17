"""Tape reading: public fills -> parent orders -> flow classes -> 5-minute bars.

The public Kalshi tape has no trader identity. These tests pin the three things the
rest of the study rests on:
  1. fills that share (ticker, taker side, timestamp) are one aggressive parent order;
  2. a parent order with a fractional contract count whose total cost including the
     taker fee lands on a whole dollar is a dollar-denominated retail buy ("RB");
     other fractional orders are "FX" (mostly retail position exits and partial
     fills); integer-count orders are "IN" (contract-count retail apps and API flow);
  3. bars add up: class columns sum to the totals, and prices are time-ordered.
"""
import datetime as dt

import duckdb
import pytest

from kalshi_edge import tape

UTC = dt.timezone.utc


def ts(h, m, s=0, us=0):
    return dt.datetime(2026, 11, 15, h, m, s, us, tzinfo=UTC)


def make_con(rows, fee_rows=(("KXNBAGAME", 0.07), ("KXMLBKS", 0.035))):
    con = duckdb.connect()
    con.execute("create table raw(trade_id varchar, ticker varchar, count double, yes_price double, "
                "no_price double, taker_side varchar, created_time timestamptz)")
    con.executemany("insert into raw values (?,?,?,?,?,?,?)", rows)
    con.execute("create table fee(series varchar, taker_rate double)")
    con.executemany("insert into fee values (?,?)", list(fee_rows))
    return con


T = "KXNBAGAME-26NOV16HOUMIA-MIA"


def orders(con):
    return con.sql(tape.parent_orders_sql("raw", "fee")).df()


def bars(con):
    return con.sql(tape.bars_sql("raw", "fee")).df()


def test_fills_with_one_timestamp_and_side_are_one_parent_order():
    con = make_con([
        ("a", T, 10, 50, 50, "yes", ts(12, 0, 1, 5)),
        ("b", T, 15, 51, 49, "yes", ts(12, 0, 1, 5)),
        ("c", T, 5, 52, 48, "yes", ts(12, 0, 1, 5)),
        ("d", T, 7, 50, 50, "no", ts(12, 0, 1, 5)),      # other side: separate order
        ("e", T, 9, 50, 50, "yes", ts(12, 0, 1, 6)),     # one microsecond later: separate order
    ])
    po = orders(con)
    assert len(po) == 3
    big = po[po.fills == 3].iloc[0]
    assert big.cnt == pytest.approx(30)
    assert big.cost == pytest.approx(10 * 0.50 + 15 * 0.51 + 5 * 0.52)
    assert big.yes_px == pytest.approx((10 * 50 + 15 * 51 + 5 * 52) / 30 / 100)


def test_dollar_denominated_fractional_order_is_a_retail_buy():
    # $10 at 50c with a 7% fee: 19.32 contracts cost 9.66 + 0.3381 fee = 9.9981
    con = make_con([("a", T, 19.32, 50, 50, "yes", ts(12, 0))])
    po = orders(con)
    assert po.kind.tolist() == ["RB"]
    assert po.total.iloc[0] == pytest.approx(9.9981, abs=1e-4)


def test_no_side_taker_price_is_the_no_price():
    # $5 of NO at 30c (yes price 70c): 16.05 * 0.30 = 4.815, fee 0.07*16.05*0.3*0.7 = 0.2359 -> 5.0509? not round
    # 15.9 contracts: 4.77 + 0.2337 = 5.0037 -> round
    con = make_con([("a", T, 15.9, 70, 30, "no", ts(12, 0))])
    po = orders(con)
    assert po.cost.iloc[0] == pytest.approx(15.9 * 0.30)
    assert po.yes_px.iloc[0] == pytest.approx(0.70)
    assert po.kind.tolist() == ["RB"]


def test_fractional_order_off_the_dollar_grid_is_fx_and_integer_is_in():
    con = make_con([
        ("a", T, 19.32, 43, 57, "yes", ts(12, 0, 1)),   # 8.3076 + 0.3315 = 8.639 -> not round
        ("b", T, 20, 50, 50, "yes", ts(12, 0, 2)),      # integer count
        ("c", T, 0.5, 50, 50, "yes", ts(12, 0, 3)),     # fractional, total 0.259 < $1 -> not a dollar order
    ])
    po = orders(con).sort_values("created_time")
    assert po.kind.tolist() == ["FX", "IN", "FX"]


def test_integer_order_is_never_retail_dollar_even_on_a_round_total():
    # 100 contracts at 20c = 20.00 + fee 1.12 = 21.12; craft a round one: rate 0 series
    con = make_con([("a", "KXFREE-1-A", 20, 50, 50, "yes", ts(12, 0))], fee_rows=(("KXFREE", 0.0),))
    assert orders(con).kind.tolist() == ["IN"]


def test_series_fee_rate_drives_the_dollar_test():
    # half-fee series: $10 at 50c -> c*0.5 + 0.035*c*0.25 = 0.50875c -> c = 19.65 -> 9.9969
    row = ("a", "KXMLBKS-26JUL01X-9", 19.65, 50, 50, "yes", ts(12, 0))
    assert orders(make_con([row])).kind.tolist() == ["RB"]
    # the same fill priced with the full 7% fee is 10.1689 -> not a dollar order
    row7 = ("a", T, 19.65, 50, 50, "yes", ts(12, 0))
    assert orders(make_con([row7])).kind.tolist() == ["FX"]


def test_size_buckets_use_order_cost():
    con = make_con([
        ("a", T, 10, 50, 50, "yes", ts(12, 0, 1)),      # $5
        ("b", T, 100, 50, 50, "yes", ts(12, 0, 2)),     # $50
        ("c", T, 1000, 50, 50, "yes", ts(12, 0, 3)),    # $500
        ("d", T, 10000, 50, 50, "yes", ts(12, 0, 4)),   # $5,000
        ("e", T, 50, 50, 50, "yes", ts(12, 0, 5)),      # $25 exactly -> M (lower bound inclusive)
    ])
    po = orders(con).sort_values("created_time")
    assert po["size"].tolist() == ["S", "M", "L", "X", "M"]


def test_series_not_in_the_fee_table_is_dropped():
    con = make_con([("a", "KXBTC15M-26NOV150000-00", 5, 50, 50, "yes", ts(12, 0)),
                    ("b", T, 5, 50, 50, "yes", ts(12, 0))])
    assert orders(con).ticker.tolist() == [T]


def test_bars_bucket_on_five_minute_boundaries_and_order_prices_by_time():
    con = make_con([
        ("a", T, 10, 40, 60, "yes", ts(12, 4, 59)),
        ("b", T, 10, 44, 56, "no", ts(12, 2, 0)),
        ("c", T, 10, 42, 58, "yes", ts(12, 0, 0)),
        ("d", T, 10, 47, 53, "yes", ts(12, 5, 0)),      # next bucket
    ])
    b = bars(con).sort_values("bucket").reset_index(drop=True)
    assert len(b) == 2
    first = b.iloc[0]
    assert first.bucket.to_pydatetime() == ts(12, 0)
    assert (first.px_open, first.px_close) == (pytest.approx(0.42), pytest.approx(0.40))
    assert (first.px_high, first.px_low) == (pytest.approx(0.44), pytest.approx(0.40))
    assert first.n_orders == 3 and first.n_fills == 3
    assert first.contracts == pytest.approx(30)
    assert b.iloc[1].bucket.to_pydatetime() == ts(12, 5)


def test_bar_ask_and_bid_proxies_come_from_the_last_taker_on_each_side():
    con = make_con([
        ("a", T, 10, 55, 45, "yes", ts(12, 0, 1)),
        ("b", T, 10, 56, 44, "yes", ts(12, 0, 3)),   # last YES taker paid 56 -> ask proxy
        ("c", T, 10, 53, 47, "no", ts(12, 0, 2)),
        ("d", T, 10, 54, 46, "no", ts(12, 0, 4)),    # last NO taker hit the 54 bid -> bid proxy
    ])
    b = bars(con).iloc[0]
    assert b.ask_px == pytest.approx(0.56)
    assert b.bid_px == pytest.approx(0.54)


def test_bar_without_a_taker_on_one_side_has_a_null_proxy():
    con = make_con([("a", T, 10, 55, 45, "yes", ts(12, 0, 1))])
    b = bars(con).iloc[0]
    assert b.ask_px == pytest.approx(0.55)
    assert b.bid_px != b.bid_px  # NaN


def test_class_columns_sum_to_bar_totals():
    con = make_con([
        ("a", T, 19.32, 50, 50, "yes", ts(12, 0, 1)),   # RB S yes
        ("b", T, 19.32, 43, 57, "no", ts(12, 0, 2)),    # FX S no
        ("c", T, 1000, 50, 50, "yes", ts(12, 0, 3)),    # IN L yes
        ("d", T, 400, 50, 50, "no", ts(12, 0, 4)),      # IN M no
    ])
    b = bars(con).iloc[0]
    c_cols = [c for c in b.index if c.startswith("c_")]
    d_cols = [c for c in b.index if c.startswith("d_")]
    n_cols = [c for c in b.index if c.startswith("n_") and c not in ("n_orders", "n_fills")]
    assert len(c_cols) == len(tape.KINDS) * len(tape.SIZES) * 2
    assert sum(b[c] for c in c_cols) == pytest.approx(b.contracts)
    assert sum(b[c] for c in d_cols) == pytest.approx(b.dollars)
    assert sum(b[c] for c in n_cols) == b.n_orders
    assert b.c_RBS_yes == pytest.approx(19.32)
    assert b.c_FXS_no == pytest.approx(19.32)
    assert b.c_INL_yes == pytest.approx(1000)
    assert b.d_INM_no == pytest.approx(400 * 0.50)
    assert b.n_RBS_yes == 1 and b.n_INL_yes == 1


def test_series_is_the_ticker_prefix_before_the_first_dash():
    assert tape.series_of("KXNBAGAME-26NOV16HOUMIA-MIA") == "KXNBAGAME"
    assert tape.series_of("KXNFLTD-26NOV15KCDEN-KCPMAHOMES15-1") == "KXNFLTD"
    assert tape.event_of("KXNBAGAME-26NOV16HOUMIA-MIA") == "KXNBAGAME-26NOV16HOUMIA"
    assert tape.event_of("KXNFLTD-26NOV15KCDEN-KCPMAHOMES15-1") == "KXNFLTD-26NOV15KCDEN"
