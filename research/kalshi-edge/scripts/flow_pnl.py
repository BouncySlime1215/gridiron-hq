#!/usr/bin/env python3
"""Who pays whom: realised taker profit by flow class, size, side, phase, price and family.

Every fill has a taker and a maker, and the taker's profit before fees is exactly the
maker's loss. So summing takers' settled profit by flow class says which kind of order
gives money away and which kind takes it, and (with the sign flipped) where resting
liquidity gets paid.

For each bar of a market with a settled result and a game clock:

    taker profit (YES side) = contracts * y - dollars
    taker profit (NO side)  = contracts * (1 - y) - dollars
    fee                     = taker_rate * contracts * p * (1 - p)   at the bar's volume-weighted price

Output: data/analysis/flow_pnl.parquet, one row per
(split, month, sport, family, phase, 5c price bin of the taker's side, kind, size, side).
Only train and validation rows are written unless a holdout token is supplied by the
caller (run_holdout.py), in which case the holdout rows go to data/holdout/flow_pnl.parquet.

Usage: python scripts/flow_pnl.py
"""
from __future__ import annotations

import datetime as dt
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from kalshi_edge import guard, tape, taxonomy  # noqa: E402
import build_bars  # noqa: E402
import build_dataset  # noqa: E402

DATA = ROOT / "data"


_JOIN = ("""    with j as (
        select b.*, m.y, g.t_start, g.milestone_id, f.family, f.sport_hint, f.taker_rate,
               case when b.bucket < g.t_start then 'pre' else 'live' end as phase,
               strftime(g.t_start, '%Y-%m') as ym,
               case when g.t_start < timestamptz '__VS__' then 'train'
                    when g.t_start < timestamptz '__HS__' then 'validation'
                    when g.t_start < timestamptz '__FS__' then 'holdout'
                    else 'forward' end as split,
               sp.sport
        from read_parquet('{bar_file}') b
        join ev g on g.event_ticker = array_to_string(list_slice(string_split(b.ticker, '-'), 1, 2), '-')
        join mk m using (ticker)
        join fam f on f.series = b.series
        join sports sp on sp.milestone_type = g.milestone_type
    )
""".replace("__VS__", guard.VALIDATION_START.isoformat())
         .replace("__HS__", guard.HOLDOUT_START.isoformat()).replace("__FS__", guard.FORWARD_START.isoformat()))


def day_sql(bar_file: str, where_split: str) -> str:
    parts = []
    for kind in tape.KINDS:
        for size in tape.SIZES:
            for side in tape.SIDES:
                tag = f"{kind}{size}_{side}"
                win = "y" if side == "yes" else "(1 - y)"
                px = "vwap" if side == "yes" else "(1 - vwap)"
                parts.append(f"""
                select split, ym, sport, family, phase, floor(least({px}, 0.9999) * 20) / 20 as pbin,
                       '{kind}' as kind, '{size}' as size, '{side}' as side,
                       sum(n_{tag}) as orders, sum(c_{tag}) as contracts, sum(d_{tag}) as dollars,
                       sum(c_{tag} * {win}) as payout, sum(taker_rate * c_{tag} * vwap * (1 - vwap)) as fee
                from j where c_{tag} > 0 group by all""")
    union = "\nunion all\n".join(parts)
    return _JOIN.format(bar_file=bar_file) + f"select * from ({union}) where {where_split}"


def game_sql(bar_file: str, where_split: str) -> str:
    """Per game, phase and flow kind: taker dollars, payout and fee (for game-clustered inference)."""
    parts = []
    for kind in tape.KINDS:
        c_yes = " + ".join(f"c_{kind}{z}_yes" for z in tape.SIZES)
        c_no = " + ".join(f"c_{kind}{z}_no" for z in tape.SIZES)
        d_all = " + ".join(f"d_{kind}{z}_{sd}" for z in tape.SIZES for sd in tape.SIDES)
        parts.append(f"""
        select split, milestone_id, any_value(sport) as sport, phase, '{kind}' as kind,
               sum({d_all}) as dollars,
               sum(({c_yes}) * y + ({c_no}) * (1 - y)) as payout,
               sum(taker_rate * (({c_yes}) + ({c_no})) * vwap * (1 - vwap)) as fee
        from j group by split, milestone_id, phase""")
    union = "\nunion all\n".join(parts)
    return _JOIN.format(bar_file=bar_file) + f"select * from ({union}) where dollars > 0 and {where_split}"


def process(args) -> "object":
    bar_file, splits, day_iso = args
    import duckdb

    con = duckdb.connect()
    con.execute("set threads=1")
    con.execute(f"create temp table ev as {build_dataset.milestone_events_sql()}")
    con.execute(f"""create temp table mk as select ticker, any_value(settlement_value_dollars) as y
                    from read_parquet('{DATA}/meta/markets/*/*.parquet')
                    where result in ('yes', 'no', 'scalar') and settlement_value_dollars is not null group by ticker""")
    sched = build_bars.fee_schedule()
    con.execute("create temp table fam(series varchar, family varchar, sport_hint varchar, taker_rate double)")
    con.executemany("insert into fam values (?, ?, ?, ?)",
                    [(s, taxonomy.family_of(s), "", build_bars.rate_on(h, day_iso + "T23:59:59Z")) for s, h in sched.items()])
    types = [r[0] for r in con.execute(f"select distinct type from read_parquet('{DATA}/meta/milestones.parquet')").fetchall()]
    con.execute("create temp table sports(milestone_type varchar, sport varchar)")
    con.executemany("insert into sports values (?, ?)", [(t, taxonomy.sport_of(t)) for t in types])
    where = "split in (" + ",".join(f"'{s}'" for s in splits) + ")"
    return con.execute(day_sql(bar_file, where)).df(), con.execute(game_sql(bar_file, where)).df()


def run(splits: tuple[str, ...], out: Path, workers: int = 3) -> None:
    import pandas as pd

    files = sorted((DATA / "bars").glob("*.parquet"))
    jobs = [(str(f), splits, f.stem.replace("_", "-")) for f in files]
    t0 = time.time()
    frames, games = [], []
    with mp.Pool(workers) as pool:
        for i, (df, gdf) in enumerate(pool.imap_unordered(process, jobs), 1):
            if len(df):
                frames.append(df)
            if len(gdf):
                games.append(gdf)
            if i % 50 == 0:
                print(time.strftime("%H:%M:%S"), f"{i}/{len(jobs)} days, {(time.time()-t0)/60:.1f} min", flush=True)
    allf = pd.concat(frames, ignore_index=True)
    keys = ["split", "ym", "sport", "family", "phase", "pbin", "kind", "size", "side"]
    agg = allf.groupby(keys, as_index=False)[["orders", "contracts", "dollars", "payout", "fee"]].sum()
    out.parent.mkdir(parents=True, exist_ok=True)
    agg.to_parquet(out, compression="zstd")
    g = pd.concat(games, ignore_index=True)
    g = g.groupby(["split", "milestone_id", "sport", "phase", "kind"], as_index=False)[["dollars", "payout", "fee"]].sum()
    g.to_parquet(out.with_name(out.stem + "_games.parquet"), compression="zstd")
    print("wrote", out, len(agg), "rows; taker dollars", round(agg.dollars.sum() / 1e9, 2), "bn;", len(g), "game rows", flush=True)


if __name__ == "__main__":
    run(("train", "validation"), DATA / "analysis" / "flow_pnl.parquet")
