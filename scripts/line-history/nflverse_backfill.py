#!/usr/bin/env python3
"""
Pull every nflverse dataset, raw, into a research SQLite (free, public, no auth).

Why a separate file: the app database has one writer at a time and its loaders reshape
columns. This keeps the raw releases exactly as published, one table per dataset variant,
so research can use any column nflverse ships (play-by-play alone has 372, including
`time_of_day` wall-clock stamps and `vegas_wp`).

Source: https://github.com/nflverse/nflverse-data/releases  (asset lists via the GitHub API)
Datasets (release tags): pbp, pbp_participation, ftn_charting, player_stats, stats_player,
  stats_team, snap_counts, depth_charts, injuries, weekly_rosters, rosters, players,
  nextgen_stats, pfr_advstats, officials, schedules, draft_picks, combine, contracts, trades,
  teams, espn_data, misc.
Plus Lee Sharpe's nfldata games.csv (results, closing lines, roof, surface, temp, wind, referee).

Output: data/line-history/nflverse.sqlite (override NFLVERSE_DB). Table name = asset file name
with the season stripped, e.g. play_by_play, ngs_passing, advstats_week_def, roster_weekly.
Every row carries `_file` (source asset) and `_loaded_at`. Resumable per asset via nflverse_manifest.

Usage:
  python3 scripts/line-history/nflverse_backfill.py --list                      # show what would load
  python3 scripts/line-history/nflverse_backfill.py --seasons 2016 ... 2026     # load (default 2016-2026)
  python3 scripts/line-history/nflverse_backfill.py --tags pbp injuries --seasons 2024 2025
"""
import argparse
import datetime as dt
import gzip
import io
import json
import os
import re
import sqlite3
import time
import urllib.request
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[2]
DB = Path(os.environ.get("NFLVERSE_DB", REPO / "data" / "line-history" / "nflverse.sqlite"))
API = "https://api.github.com/repos/nflverse/nflverse-data/releases/tags/{tag}"
TAGS = ["pbp", "pbp_participation", "ftn_charting", "player_stats", "stats_player", "stats_team", "snap_counts",
        "depth_charts", "injuries", "weekly_rosters", "rosters", "players", "nextgen_stats", "pfr_advstats",
        "officials", "schedules", "draft_picks", "combine", "contracts", "trades", "teams", "espn_data", "misc"]
EXTRA = {"nfldata_games": "https://github.com/nflverse/nfldata/raw/master/data/games.csv",
         "nfldata_initial_lines": "https://github.com/nflverse/nfldata/raw/master/data/initial_lines.csv",
         "nfldata_sc_lines": "https://github.com/nflverse/nfldata/raw/master/data/sc_lines.csv",
         "nfldata_standings": "https://github.com/nflverse/nfldata/raw/master/data/standings.csv"}
UA = {"User-Agent": "gridiron-line-history", "Accept": "application/vnd.github+json"}


def log(m):
    print(time.strftime("%H:%M:%S"), m, flush=True)


def get(url, timeout=300):
    r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)
    return r.read()


def assets(tag):
    try:
        d = json.loads(get(API.format(tag=tag), timeout=60))
    except Exception as e:  # noqa: BLE001
        log(f"{tag}: asset list failed ({e})")
        return []
    out = []
    for a in d.get("assets", []):
        n = a["name"]
        if n.endswith(".csv.gz") or (n.endswith(".csv") and not any(x["name"] == n + ".gz" for x in d["assets"])):
            out.append((n, a["browser_download_url"], a.get("size", 0)))
    return out


def season_of(name):
    m = re.search(r"(?<!\d)(19|20)(\d\d)(?!\d)", name)
    return int(m.group(1) + m.group(2)) if m else None


def table_for(name):
    base = re.sub(r"\.csv(\.gz)?$", "", name)
    base = re.sub(r"[_-]?(19|20)\d\d(?![\d])", "", base)  # strip season
    base = re.sub(r"[^a-z0-9]+", "_", base.lower()).strip("_")
    return base or "misc"


def load_csv(url):
    raw = get(url)
    if url.endswith(".gz"):
        raw = gzip.decompress(raw)
    return pd.read_csv(io.BytesIO(raw), low_memory=False)


def store(con, table, df, file):
    df = df.copy()
    df["_file"] = file
    df["_loaded_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    # union columns with any existing table so later seasons with new columns still load
    existing = {r[1] for r in con.execute(f"PRAGMA table_info('{table}')")}
    if existing:
        for c in df.columns:
            if c not in existing:
                con.execute(f'ALTER TABLE "{table}" ADD COLUMN "{c}"')
        for c in existing:
            if c not in df.columns:
                df[c] = None
        con.execute(f'DELETE FROM "{table}" WHERE _file=?', (file,))
    df.to_sql(table, con, if_exists="append", index=False, chunksize=5000)
    return len(df)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="*", type=int, default=list(range(2016, 2027)))
    ap.add_argument("--tags", nargs="*", default=TAGS)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--refetch", action="store_true")
    a = ap.parse_args()
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=120)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("""CREATE TABLE IF NOT EXISTS nflverse_manifest (file TEXT PRIMARY KEY, tag TEXT, table_name TEXT, season INTEGER,
                   url TEXT, size INTEGER, rows INTEGER, loaded_at TEXT)""")
    done = {r[0] for r in con.execute("SELECT file FROM nflverse_manifest")}
    plan = []
    for tag in a.tags:
        for name, url, size in assets(tag):
            s = season_of(name)
            if s is not None and s not in a.seasons:
                continue
            plan.append((tag, name, url, size, s))
        time.sleep(0.5)
    for name, url in EXTRA.items():
        plan.append(("nfldata", name + ".csv", url, 0, None))
    todo = [p for p in plan if a.refetch or p[1] not in done]
    log(f"{len(plan)} assets in scope, {len(todo)} to load, {sum(p[3] for p in todo) / 1e6:.0f} MB compressed")
    if a.list:
        for tag, name, url, size, s in plan:
            print(f"  {tag:18s} {name:48s} -> {table_for(name):32s} {size / 1e6:6.1f} MB {'done' if name in done else ''}")
        return
    for i, (tag, name, url, size, s) in enumerate(todo, 1):
        try:
            df = load_csv(url)
            table = table_for(name)
            n = store(con, table, df, name)
            con.execute("INSERT OR REPLACE INTO nflverse_manifest VALUES (?,?,?,?,?,?,?,?)",
                        (name, tag, table, s, url, size, n, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
            con.commit()
            log(f"  {i}/{len(todo)} {name} -> {table} ({n} rows)")
        except Exception as e:  # noqa: BLE001
            log(f"  {i}/{len(todo)} {name} FAILED: {str(e)[:120]}")
        time.sleep(0.3)
    tabs = con.execute("SELECT table_name, sum(rows), count(*) FROM nflverse_manifest GROUP BY 1 ORDER BY 1").fetchall()
    for t, n, k in tabs:
        log(f"{t}: {n} rows from {k} files")


if __name__ == "__main__":
    main()
