"""Decision snapshots: what was knowable about a market h minutes before its game started.

Clock rule (the tests in tests/test_snapshots.py pin every edge of it):

    t0 = t_start - h minutes                     the decision time
    feature bars   bucket + 5 min <= t0          finished before the decision
    entry bars     bucket >= t0 (first two full bars) and bucket + 5 min <= t_start

A bar that straddles t0 is in neither set. In-game bars are never read.

Quote ages (p_last_age_min, ask0_age_min, bid0_age_min) are measured from the START
of the bar the quote was last seen in, so they are upper bounds: a quote reported as
15 minutes old was printed between 10 and 15 minutes before the decision.

Entry bars are not features. They hold the prices at which real takers traded in
the ten minutes after the decision; the backtest uses them to decide whether a
limit order placed at t0 would have been filled, and at what price.
"""
from __future__ import annotations

from kalshi_edge.tape import BUCKET_MINUTES, SIDES, SIZES

# snapshot flow groups -> (kind, sizes) of the bar class columns they collapse
FLOW_GROUPS = {
    "rb": ("RB", "SMLX"),    # dollar-denominated retail buys, any size
    "fx": ("FX", "SMLX"),    # other fractional orders (mostly retail exits and partial fills)
    "ins": ("IN", "SM"),     # integer-count orders under $250
    "inl": ("IN", "LX"),     # integer-count orders of $250 and up
}
RECENT_MINUTES = 60
EARLIER_MINUTES = (60, 360, 1440)

assert all(set(sizes) <= set(SIZES) for _, sizes in FLOW_GROUPS.values())


def _sum_cols(prefix: str, kind: str, sizes: str, side: str) -> str:
    return " + ".join(f"{prefix}_{kind}{z}_{side}" for z in sizes)


def snapshot_sql(bars: str, starts: str, h_minutes: int, lookback_days: int = 7) -> str:
    """SQL for one row per market with features as of t_start - h and the entry-window prints.

    `bars` is the output of tape.bars_sql; `starts` has (ticker, t_start).
    Markets with no finished bar inside the lookback window are omitted.
    """
    b = BUCKET_MINUTES
    feat = f"(bucket + interval '{b} minutes' <= t0)"
    recent = f"({feat} and bucket >= t0 - interval '{RECENT_MINUTES} minutes')"
    e1 = "(bucket = e1_bucket and e1_ok)"
    e2 = f"(bucket = e1_bucket + interval '{b} minutes' and e2_ok)"

    cols = []
    for name, (kind, sizes) in FLOW_GROUPS.items():
        for side in SIDES:
            d = _sum_cols("d", kind, sizes, side)
            cols.append(f"coalesce(sum({d}) filter (where {feat}), 0) as usd_{name}_{side}")
            cols.append(f"coalesce(sum({d}) filter (where {recent}), 0) as usd_{name}_{side}_{RECENT_MINUTES}")
    for side in SIDES:
        n = _sum_cols("n", "RB", "SMLX", side)
        cols.append(f"coalesce(sum({n}) filter (where {feat}), 0)::bigint as n_rb_{side}")
    for m in EARLIER_MINUTES:
        cols.append(f"arg_max(px_close, bucket) filter (where bucket + interval '{b} minutes' <= t0 - interval '{m} minutes') as p_m{m}")
    for i, cond in ((1, e1), (2, e2)):
        cols.append(f"max(ask_px) filter (where {cond}) as e{i}_ask")
        cols.append(f"max(bid_px) filter (where {cond}) as e{i}_bid")
        for side in SIDES:
            d = " + ".join(_sum_cols("d", kind, SIZES, side) for kind in ("RB", "FX", "IN"))
            cols.append(f"coalesce(sum({d}) filter (where {cond}), 0) as e{i}_usd_{side}")
    extra = ",\n           ".join(cols)

    return f"""
    with j as (
        select b.*, s.t_start,
               s.t_start - interval '{h_minutes} minutes' as t0,
               time_bucket(interval '{b} minutes',
                           s.t_start - interval '{h_minutes} minutes' + interval '{b} minutes' - interval '1 microsecond') as e1_bucket
        from {bars} b
        join {starts} s using (ticker)
        where b.bucket < s.t_start
          and b.bucket >= s.t_start - interval '{h_minutes} minutes' - interval '{lookback_days} days'
    ),
    k as (
        select *,
               (e1_bucket + interval '{b} minutes' <= t_start) as e1_ok,
               (e1_bucket + interval '{2 * b} minutes' <= t_start) as e2_ok
        from j
    )
    select ticker, any_value(series) as series, any_value(t_start) as t_start, any_value(t0) as t0,
           count(*) filter (where {feat}) as n_bars,
           min(bucket) filter (where {feat}) as first_bucket,
           arg_max(px_close, bucket) filter (where {feat}) as p_last,
           date_diff('minute', max(bucket) filter (where {feat}), any_value(t0)) as p_last_age_min,
           arg_max(ask_px, bucket) filter (where {feat} and ask_px is not null) as ask0,
           date_diff('minute', max(bucket) filter (where {feat} and ask_px is not null), any_value(t0)) as ask0_age_min,
           arg_max(bid_px, bucket) filter (where {feat} and bid_px is not null) as bid0,
           date_diff('minute', max(bucket) filter (where {feat} and bid_px is not null), any_value(t0)) as bid0_age_min,
           coalesce(sum(dollars) filter (where {feat}), 0) as usd,
           coalesce(sum(n_orders) filter (where {feat}), 0)::bigint as orders,
           coalesce(sum(dollars) filter (where {recent}), 0) as usd_{RECENT_MINUTES},
           {extra}
    from k
    group by ticker
    having count(*) filter (where {feat}) > 0
    """
