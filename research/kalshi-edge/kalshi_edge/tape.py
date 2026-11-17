"""Tape reading: public fills -> parent orders -> flow classes -> 5-minute bars.

Kalshi's public tape carries no trader identity, only (ticker, size, price, taker
side, time). Two facts about how orders reach the exchange make it possible to
recover who is trading anyway:

  * An aggressive order that sweeps several resting orders prints one fill per
    resting order, all stamped with the same microsecond and taker side. Grouping
    on (ticker, taker_side, created_time) rebuilds the taker's parent order.

  * Consumer apps let people buy in dollars ("Buy $10"). Since fractional
    contracts exist, such an order is filled for a fractional contract count
    chosen so that cost + fee is a whole number of dollars. Nobody sizing in
    contracts through the API produces that pattern.

So every taker parent order falls in one of three kinds:

  RB  fractional count, total cost incl. fee within 1.1c of a whole dollar (>= $1):
      a dollar-denominated retail BUY of the taker side.
  FX  fractional count, off the dollar grid: mostly retail closing a position that
      was opened in dollars, plus partial fills of dollar orders.
  IN  integer count: contract-count retail apps and API / professional flow.

and one of four sizes by order cost: S < $25 <= M < $250 <= L < $2,500 <= X.

The dollar-grid tolerance of 1.1c is deliberate: the app rounds the contract
count down to 0.01, so the total falls short of the target by less than a cent.
A fractional order lands inside the tolerance by chance about 2% of the time.
"""
from __future__ import annotations

KINDS = ("RB", "FX", "IN")
SIZES = ("S", "M", "L", "X")
SIDES = ("yes", "no")
SIZE_BOUNDS = (25.0, 250.0, 2500.0)
DOLLAR_TOLERANCE = 0.011
BUCKET_MINUTES = 5

_SERIES_SQL = "regexp_extract(t.ticker, '^([^-]+)', 1)"


def series_of(ticker: str) -> str:
    return ticker.split("-", 1)[0]


def event_of(ticker: str) -> str:
    """Event ticker heuristic: the first two dash-separated parts."""
    return "-".join(ticker.split("-")[:2])


def parent_orders_sql(source: str, fee_table: str) -> str:
    """SQL for one row per taker parent order.

    `source` has the public-tape columns (ticker, count, yes_price, no_price in
    cents, taker_side, created_time). `fee_table` has (series, taker_rate); a
    series missing from it is dropped, which is how non-sports tickers are excluded.
    """
    b1, b2, b3 = SIZE_BOUNDS
    return f"""
    select ticker, series, taker_side, created_time, fills, cnt, cost, total, yes_px, yes_px_min, yes_px_max,
           case when frac and total >= 0.995 and abs(total - round(total)) <= {DOLLAR_TOLERANCE} then 'RB'
                when frac then 'FX' else 'IN' end as kind,
           case when cost < {b1} then 'S' when cost < {b2} then 'M' when cost < {b3} then 'L' else 'X' end as size
    from (
        select t.ticker, any_value(f.series) as series, t.taker_side, t.created_time,
               count(*) as fills,
               sum(t."count") as cnt,
               sum(t."count" * (case when t.taker_side = 'yes' then t.yes_price else t.no_price end) / 100.0) as cost,
               sum(t."count" * (case when t.taker_side = 'yes' then t.yes_price else t.no_price end) / 100.0)
                 + any_value(f.taker_rate) * sum(t."count" * (t.yes_price / 100.0) * (1 - t.yes_price / 100.0)) as total,
               sum(t."count" * t.yes_price / 100.0) / sum(t."count") as yes_px,
               min(t.yes_price) / 100.0 as yes_px_min,
               max(t.yes_price) / 100.0 as yes_px_max,
               abs(sum(t."count") - round(sum(t."count"))) > 1e-6 as frac
        from {source} t
        join {fee_table} f on f.series = {_SERIES_SQL}
        where t."count" > 0
        group by t.ticker, t.taker_side, t.created_time
    )
    """


def class_columns() -> list[str]:
    cols = []
    for kind in KINDS:
        for size in SIZES:
            for side in SIDES:
                cond = f"kind = '{kind}' and size = '{size}' and taker_side = '{side}'"
                tag = f"{kind}{size}_{side}"
                cols.append(f"coalesce(sum(cnt) filter (where {cond}), 0) as c_{tag}")
                cols.append(f"coalesce(sum(cost) filter (where {cond}), 0) as d_{tag}")
                cols.append(f"count(*) filter (where {cond}) as n_{tag}")
    return cols


def bars_sql(source: str, fee_table: str, bucket_minutes: int = BUCKET_MINUTES) -> str:
    """SQL for one row per (ticker, time bucket) with prices and flow by class.

    c_<kind><size>_<side>  contracts taken, d_...  dollars paid by takers, n_...  orders.
    ask_px / bid_px are the yes-price of the last YES-taker / NO-taker order in the
    bar: a YES taker pays the ask, a NO taker hits the bid, so these are executable
    quotes that somebody actually traded at, not midpoints.
    """
    classes = ",\n           ".join(class_columns())
    return f"""
    select ticker, any_value(series) as series,
           time_bucket(interval '{bucket_minutes} minutes', created_time) as bucket,
           count(*) as n_orders, sum(fills) as n_fills, sum(cnt) as contracts, sum(cost) as dollars,
           arg_min(yes_px, created_time) as px_open, arg_max(yes_px, created_time) as px_close,
           max(yes_px_max) as px_high, min(yes_px_min) as px_low,
           sum(cnt * yes_px) / sum(cnt) as vwap,
           arg_max(yes_px, created_time) filter (where taker_side = 'yes') as ask_px,
           arg_max(yes_px, created_time) filter (where taker_side = 'no') as bid_px,
           {classes}
    from ({parent_orders_sql(source, fee_table)})
    group by ticker, time_bucket(interval '{bucket_minutes} minutes', created_time)
    """


def minute_bars_sql(source: str, fee_table: str, series: list[str] | None = None) -> str:
    """SQL for one-minute bars that keep the FIRST and LAST taker print on each side.

    This is the in-game execution clock. An order sent at the end of minute m meets,
    at the earliest, the first print of minute m + 1; ask_first / bid_first of that
    minute are therefore the nearest thing on a public tape to "the quote a few seconds
    later". A 5-minute bar's last print cannot play that role: using it conditions the
    fill on five more minutes of the game.

    Flow is collapsed to dollars by kind and side, plus integer orders of $250 and up
    (usd_inl_*). `series`, if given, restricts the output to those series tickers.
    """
    where = ""
    if series is not None:
        quoted = ", ".join("'" + s.replace("'", "''") + "'" for s in series)
        where = f"where series in ({quoted})"
    flow = []
    for kind, name in (("RB", "rb"), ("FX", "fx"), ("IN", "in")):
        for side in SIDES:
            flow.append(f"coalesce(sum(cost) filter (where kind = '{kind}' and taker_side = '{side}'), 0) as usd_{name}_{side}")
    for side in SIDES:
        flow.append(f"coalesce(sum(cost) filter (where kind = 'IN' and size in ('L', 'X') and taker_side = '{side}'), 0) as usd_inl_{side}")
    flow_sql = ",\n           ".join(flow)
    return f"""
    select ticker, any_value(series) as series,
           time_bucket(interval '1 minute', created_time) as bucket,
           count(*) as n_orders, sum(cnt) as contracts, sum(cost) as dollars,
           max(yes_px_max) as px_high, min(yes_px_min) as px_low,
           sum(cnt * yes_px) / sum(cnt) as vwap,
           arg_min(yes_px, created_time) filter (where taker_side = 'yes') as ask_first,
           arg_max(yes_px, created_time) filter (where taker_side = 'yes') as ask_last,
           arg_min(yes_px, created_time) filter (where taker_side = 'no') as bid_first,
           arg_max(yes_px, created_time) filter (where taker_side = 'no') as bid_last,
           epoch(min(created_time) filter (where taker_side = 'yes')) - epoch(time_bucket(interval '1 minute', min(created_time))) as ask_first_sec,
           epoch(min(created_time) filter (where taker_side = 'no')) - epoch(time_bucket(interval '1 minute', min(created_time))) as bid_first_sec,
           {flow_sql}
    from ({parent_orders_sql(source, fee_table)})
    {where}
    group by ticker, time_bucket(interval '1 minute', created_time)
    """
