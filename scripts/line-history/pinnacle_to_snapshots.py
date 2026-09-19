#!/usr/bin/env python3
"""
Bridge captured Pinnacle quotes into nfl_line_snapshots, where the models actually look.

THE PROBLEM THIS SOLVES. Pinnacle is the benchmark every CLV number in this project is graded
against, and the beat-the-close signal machinery reads it from `nfl_line_snapshots` with
provider='free:pinnacle'. That table's last Pinnacle row is 2026-09-03 — before week 1 — because
the collector died with the database on 09-16. The replacement collector
(`pinnacle_capture.py`) writes to `pinnacle_quotes` in a DIFFERENT database, so nothing reads it:
`snapshotSignals` returned 0 signals and `decideBeatTheClose` froze 0 decisions for week 2, not
because the logic is broken but because the line it needs is in the wrong table.

WHAT IT FILTERS, AND WHY IT MATTERS. Pinnacle publishes a full alternate ladder: one matchup
carries spread rows at -4.0, -3.5, -2.0, -1.5 simultaneously. Copying those in indiscriminately
would let a model "find" whichever number flattered it. Only `is_alternate=0` and `period=0`
(full game) rows cross the bridge, and only `type='matchup'` events — Pinnacle's feed is full of
`special` rows with no teams attached.

Team names come across verbatim ("Buffalo Bills"), which is already the format nfl_line_snapshots
uses, so no mapping is needed or invented here.

Idempotent: re-running inserts nothing new, since rows are keyed by
(captured_at, event_id, book, market, side).

Usage: python3 scripts/line-history/pinnacle_to_snapshots.py [--since 2026-09-01]
"""
import argparse
import sqlite3
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"
LIVE = REPO / "server/data.sqlite"

CODE = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
    "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-09-01")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=120)
    rows = arc.execute("""
        SELECT q.captured_at, m.start_time, m.home, m.away, q.market_type,
               q.home_points, q.home_price, q.away_points, q.away_price,
               q.over_points, q.over_price, q.under_points, q.under_price
        FROM pinnacle_quotes q
        JOIN pinnacle_matchups m USING (matchup_id)
        WHERE q.period = 0 AND q.is_alternate = 0 AND m.type = 'matchup'
          AND m.home IS NOT NULL AND m.home <> '' AND m.start_time >= ?
        ORDER BY q.captured_at""", (a.since,)).fetchall()

    out, unmapped = [], set()
    for (cap, start, home, away, mkt, hp, hpr, ap_, apr, op, opr, up, upr) in rows:
        if home not in CODE or away not in CODE:
            unmapped.add(home if home not in CODE else away)
            continue
        eid = f"nfl:{start[:10]}:{CODE[away]}@{CODE[home]}"
        base = (cap, eid, start, home, away, "pinnacle")
        if mkt == "spread" and hp is not None:
            out.append(base + ("spreads", home, hp, hpr, "free:pinnacle", None))
            out.append(base + ("spreads", away, ap_, apr, "free:pinnacle", None))
        elif mkt == "total" and op is not None:
            out.append(base + ("totals", "Over", op, opr, "free:pinnacle", None))
            out.append(base + ("totals", "Under", up, upr, "free:pinnacle", None))
        elif mkt == "moneyline" and hpr is not None:
            out.append(base + ("h2h", home, None, hpr, "free:pinnacle", None))
            out.append(base + ("h2h", away, None, apr, "free:pinnacle", None))

    print(f"{len(rows)} main-line quote rows -> {len(out)} snapshot rows")
    if unmapped:
        print(f"  UNMAPPED TEAM NAMES (skipped, fix CODE): {sorted(unmapped)}")
    if a.dry_run:
        return

    live = sqlite3.connect(LIVE, timeout=120)
    live.execute("PRAGMA busy_timeout=120000")
    before = live.execute(
        "SELECT COUNT(*) FROM nfl_line_snapshots WHERE provider='free:pinnacle'").fetchone()[0]
    live.executemany(
        """INSERT OR IGNORE INTO nfl_line_snapshots
           (captured_at, event_id, commence_time, home_team, away_team, book, market, side,
            line, price, provider, book_updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", out)
    live.commit()
    after = live.execute(
        "SELECT COUNT(*) FROM nfl_line_snapshots WHERE provider='free:pinnacle'").fetchone()[0]
    print(f"free:pinnacle rows: {before} -> {after} (+{after - before})")
    for r in live.execute(
            """SELECT market, COUNT(*), MIN(captured_at), MAX(captured_at)
               FROM nfl_line_snapshots WHERE provider='free:pinnacle' GROUP BY market"""):
        print("  ", r)


if __name__ == "__main__":
    main()
