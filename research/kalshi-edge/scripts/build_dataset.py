#!/usr/bin/env python3
"""Bars + game clocks -> decision snapshots (no outcomes in here).

For every UTC day of scheduled starts, load the bars of the markets that start that
day and write one snapshot row per market per horizon:

    data/snap/h<minutes>/<YYYY-MM-DD>.parquet

A market is tied to a game through its event ticker (first two dash-separated parts)
appearing in exactly one milestone's related_event_tickers. Events claimed by more
than one milestone are dropped and counted.

Usage: python scripts/build_dataset.py [--start 2025-03-01] [--end 2026-11-15] [--horizons 10 60 360 1440]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from kalshi_edge import snapshots  # noqa: E402

DATA = ROOT / "data"
LOOKBACK_DAYS = 7


def milestone_events_sql() -> str:
    """One row per event ticker that belongs to exactly one milestone."""
    return f"""
    with ex as (
        select id as milestone_id, type as milestone_type, league, start_date::timestamptz as t_start,
               end_date::timestamptz as t_end,
               unnest(from_json(related_event_tickers, '["varchar"]')) as event_ticker
        from read_parquet('{DATA / "meta" / "milestones.parquet"}')
        where start_date is not null
    )
    select event_ticker, any_value(milestone_id) as milestone_id, any_value(milestone_type) as milestone_type,
           any_value(league) as league, any_value(t_start) as t_start, any_value(t_end) as t_end
    from ex group by event_ticker having count(distinct milestone_id) = 1
    """


def process_day(args: tuple[str, list[int]]) -> dict:
    day, horizons = args
    import duckdb

    d = dt.date.fromisoformat(day)
    outs = {h: DATA / "snap" / f"h{h}" / f"{day}.parquet" for h in horizons}
    if all(p.exists() for p in outs.values()):
        return {"day": day, "skipped": True}
    max_h_days = (max(horizons) + 1439) // 1440
    files = []
    for n in range(LOOKBACK_DAYS + max_h_days + 1, -1, -1):
        f = DATA / "bars" / f"{(d - dt.timedelta(n)).isoformat().replace('-', '_')}.parquet"
        if f.exists():
            files.append(str(f))
    if not files:
        return {"day": day, "markets": 0, "note": "no bar files in the window"}
    t0 = time.time()
    con = duckdb.connect()
    con.execute("set threads=2")
    con.execute("set preserve_insertion_order=false")
    con.execute(f"create temp table ev as {milestone_events_sql()}")
    con.execute(f"""create temp table game as select * from ev
                    where t_start >= timestamptz '{day} 00:00:00+00' and t_start < timestamptz '{day} 00:00:00+00' + interval '1 day'""")
    n_games = con.execute("select count(distinct milestone_id) from game").fetchall()[0][0]
    if n_games == 0:
        return {"day": day, "markets": 0, "games": 0}
    file_list = "[" + ",".join(f"'{f}'" for f in files) + "]"
    con.execute(f"""create temp table day_bars as
                    select b.* from read_parquet({file_list}) b
                    join game g on g.event_ticker = array_to_string(list_slice(string_split(b.ticker, '-'), 1, 2), '-')
                    where b.bucket < g.t_start""")
    con.execute("""create temp table starts as
                   select distinct b.ticker, g.t_start, g.event_ticker, g.milestone_id, g.milestone_type, g.league, g.t_end
                   from (select distinct ticker from day_bars) b
                   join game g on g.event_ticker = array_to_string(list_slice(string_split(b.ticker, '-'), 1, 2), '-')""")
    n_rows = {}
    for h, out in outs.items():
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp")
        sql = f"""select s.*, {h} as h_min, st.event_ticker, st.milestone_id, st.milestone_type, st.league, st.t_end
                  from ({snapshots.snapshot_sql('day_bars', 'starts', h, LOOKBACK_DAYS)}) s
                  join starts st using (ticker)"""
        con.execute(f"copy ({sql}) to '{tmp}' (format parquet, compression zstd)")
        n_rows[h] = con.execute(f"select count(*) from read_parquet('{tmp}')").fetchall()[0][0]
        tmp.rename(out)
    con.close()
    return {"day": day, "games": n_games, "markets": n_rows, "files": len(files), "s": round(time.time() - t0, 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2025-03-01")
    ap.add_argument("--end", default="2026-11-15")
    ap.add_argument("--horizons", nargs="*", type=int, default=[10, 60, 360, 1440])
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    d0, d1 = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    days = [(d0 + dt.timedelta(n)).isoformat() for n in range((d1 - d0).days + 1)][::-1]
    log = open(DATA / "logs" / "build_dataset.jsonl", "a")
    t0 = time.time()
    done = 0
    with mp.Pool(a.workers) as pool:
        for res in pool.imap_unordered(process_day, [(d, a.horizons) for d in days]):
            done += 1
            log.write(json.dumps(res) + "\n")
            log.flush()
            if done % 20 == 0 or done <= 3:
                print(time.strftime("%H:%M:%S"), f"{done}/{len(days)}", res, f"elapsed {(time.time()-t0)/60:.1f} min", flush=True)
    print("done", done, "days in", round((time.time() - t0) / 60, 1), "min", flush=True)


if __name__ == "__main__":
    main()
