#!/usr/bin/env python3
"""
Backfill ESPN team statistics and Football Power Index (free, public, no auth).

Two sources, both keyed long (one row per stat) so the ~286 distinct stat names arrive as
data rather than as 286 columns to migrate every time ESPN adds one:

  sports.core.api.espn.com/v2/.../seasons/{yr}/types/{t}/teams/{id}/statistics
      -> 11 categories, 286 distinct named fields: general, passing, rushing, receiving,
         defensive, defensiveInterceptions, kicking, returning, punting, scoring, miscellaneous.
         Each field carries value, displayValue, perGameValue and rank.

  site.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex?season={yr}
      -> 32 metrics per team across three categories (fpi, projections, efficiencies):
         FPI itself, its offensive/defensive/special-teams components, strength of record,
         remaining strength of schedule, projected wins, playoff and division odds.

Overlap with nflverse is real but partial: box-score counting stats duplicate, while the
rate stats, ranks, per-game values, the ESPN QBR/RB/WR ratings and all of FPI are new.
count_new_metrics() reports the honest distinct-field count after a run.

Output tables: espn_team_stats, espn_fpi. Resumable via espn_stats_done.
Usage: python3 scripts/line-history/espn_stats_backfill.py [--seasons 2002 ... 2026]
"""
import argparse
import datetime as dt
import threading
from concurrent.futures import ThreadPoolExecutor

from common import connect, fetch_json, log

CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
FITT = "https://site.api.espn.com/apis/fitt/v3/sports/football/nfl"
SCHEMA = """
CREATE TABLE IF NOT EXISTS espn_team_stats (
  season INTEGER, season_type INTEGER, team_id TEXT, category TEXT, stat TEXT,
  value REAL, display_value TEXT, per_game REAL, rank INTEGER,
  PRIMARY KEY (season, season_type, team_id, category, stat));
CREATE TABLE IF NOT EXISTS espn_fpi (
  season INTEGER, team_id TEXT, category TEXT, stat TEXT, value REAL, display_value TEXT,
  PRIMARY KEY (season, team_id, category, stat));
CREATE TABLE IF NOT EXISTS espn_stats_done (key TEXT PRIMARY KEY, fetched_at TEXT, rows INTEGER);
"""


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def pull_team(con, season, stype, team_id):
    st, d = fetch_json(f"{CORE}/seasons/{season}/types/{stype}/teams/{team_id}/statistics", sleep=0.1)
    if st != 200 or not d:
        return 0
    rows = []
    for c in ((d.get("splits") or {}).get("categories") or []):
        cat = c.get("name")
        for s in c.get("stats", []):
            rows.append((season, stype, str(team_id), cat, s.get("name"), num(s.get("value")),
                         s.get("displayValue"), num(s.get("perGameValue")), s.get("rank")))
    if rows:
        con.executemany("INSERT OR REPLACE INTO espn_team_stats VALUES (?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


def pull_fpi(con, season):
    st, d = fetch_json(f"{FITT}/powerindex?season={season}&limit=1000", sleep=0.2, ua=None)
    if st != 200 or not d:
        return 0
    rows = []
    for t in d.get("teams", []):
        tid = str((t.get("team") or {}).get("id") or t.get("id") or "")
        for c in t.get("categories", []):
            cat = c.get("name")
            names = c.get("names") or []
            vals = c.get("values") or []
            disp = c.get("displayValues") or []
            for i, v in enumerate(vals):
                nm = names[i] if i < len(names) else f"{cat}_{i}"
                rows.append((season, tid, cat, nm, num(v), disp[i] if i < len(disp) else None))
    if rows:
        con.executemany("INSERT OR REPLACE INTO espn_fpi VALUES (?,?,?,?,?,?)", rows)
    return len(rows)


def count_new_metrics(con):
    a = con.execute("SELECT COUNT(DISTINCT category || '.' || stat) FROM espn_team_stats").fetchone()[0]
    b = con.execute("SELECT COUNT(DISTINCT category || '.' || stat) FROM espn_fpi").fetchone()[0]
    return a, b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="*", type=int, default=list(range(2002, 2027)))
    ap.add_argument("--types", nargs="*", type=int, default=[2, 3], help="2 regular, 3 post")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    con = connect()
    con.executescript(SCHEMA)

    st, teams_doc = fetch_json(f"{CORE}/teams?limit=50")
    team_ids = []
    for it in (teams_doc or {}).get("items", []):
        ref = it.get("$ref", "")
        tid = ref.split("/teams/")[-1].split("?")[0]
        if tid.isdigit():
            team_ids.append(tid)
    if not team_ids:
        team_ids = [str(i) for i in range(1, 35)]
    log(f"{len(team_ids)} teams, {len(args.seasons)} seasons, types {args.types}")

    done = {r[0] for r in con.execute("SELECT key FROM espn_stats_done")}
    jobs = [(s, t, tid) for s in args.seasons for t in args.types for tid in team_ids
            if f"{s}-{t}-{tid}" not in done]
    log(f"{len(jobs)} team-seasons to pull")

    local = threading.local()
    state = {"n": 0, "rows": 0}
    lock = threading.Lock()

    def worker(job):
        s, t, tid = job
        if getattr(local, "con", None) is None:
            local.con = connect()
        c = local.con
        n = pull_team(c, s, t, tid)
        c.execute("INSERT OR REPLACE INTO espn_stats_done VALUES (?,?,?)",
                  (f"{s}-{t}-{tid}", dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), n))
        c.commit()
        with lock:
            state["n"] += 1
            state["rows"] += n
            if state["n"] % 100 == 0:
                log(f"  {state['n']}/{len(jobs)} (rows {state['rows']})")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(worker, jobs))

    fpi_rows = 0
    for s in args.seasons:
        fpi_rows += pull_fpi(con, s)
    con.commit()

    a, b = count_new_metrics(con)
    log(f"done: {state['rows']} team-stat rows, {fpi_rows} FPI rows")
    log(f"distinct metrics: {a} team stats + {b} FPI = {a + b}")


if __name__ == "__main__":
    main()
