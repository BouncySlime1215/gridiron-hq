#!/usr/bin/env python3
"""
Bridge the Odds API tape into nfl_line_snapshots so the weekly board can be produced again.

THE PROBLEM. `scripts/board/weekly_board.py` reads quotes from `nfl_line_snapshots`, which was fed
by the live odds collector that lived in the folder deleted on 2026-09-16. With that feed dead the
table's newest rows are from 2026-09-03, so the board now renders with **every section empty** —
no spreads, no totals, no timing watch. There is nothing wrong with the board code; it simply has
no quotes to read.

Meanwhile 1.9M week-2 quotes across 11 US books are sitting in `oddsapi_snapshots` in the archive
database, already paid for. This copies the latest ones across.

WHAT IT WRITES. The most recent snapshot per (event, book, market, side) within the requested
window, mapped onto the schema the board expects:
  oddsapi                          nfl_line_snapshots
  home/away (full team names)  ->  home_team/away_team (full names — same convention)
  side 'home'/'away'           ->  side = the TEAM NAME, because nfl_line_snapshots stores the name
                                    there, unlike oddsapi which stores the literal word. Getting
                                    this backwards is why an earlier analysis silently returned
                                    zero rows.
  book                         ->  book, and provider 'free:oddsapi'

Totals are absent by construction: the Odds API tape carries `spreads` only (no h2h, no totals), so
the board's totals section will stay empty until another source fills it. That limitation is the
tape's, not this script's, and is reported rather than hidden.

Idempotent — rows are keyed by (captured_at, event_id, book, market, side).

Usage: python3 scripts/line-history/oddsapi_to_snapshots.py [--hours 48]
"""
import argparse
import sqlite3
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"
LIVE = REPO / "server/data.sqlite"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=48,
                    help="only copy quotes this recent relative to the tape's own latest snapshot")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=180)
    latest = arc.execute("SELECT MAX(snapshot_at) FROM oddsapi_snapshots").fetchone()[0]
    if not latest:
        print("no oddsapi rows")
        return
    import datetime as dt
    cutoff = (dt.datetime.fromisoformat(latest.replace("Z", "+00:00"))
              - dt.timedelta(hours=a.hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"tape latest {latest}; copying quotes since {cutoff}")

    # keep only the most recent quote per (event, book, market, side)
    best = {}
    for snap, eid, ct, home, away, book, market, side, line, price, upd in arc.execute(
            """SELECT snapshot_at, event_id, commence_time, home, away, book, market, side,
                      line, price, book_updated_at
               FROM oddsapi_snapshots
               WHERE snapshot_at >= ? AND line IS NOT NULL AND price IS NOT NULL
               ORDER BY snapshot_at""", (cutoff,)):
        best[(eid, book, market, side)] = (snap, eid, ct, home, away, book, market, side,
                                           line, price, upd)

    rows = []
    for (eid, book, market, side), v in best.items():
        snap, eid, ct, home, away, book, market, side, line, price, upd = v
        # nfl_line_snapshots stores the TEAM NAME in `side` for spreads
        side_name = home if side == "home" else away
        rows.append((snap, eid, ct, home, away, book, market, side_name,
                     line, price, "free:oddsapi", upd))

    games = len({r[1] for r in rows})
    books = len({r[5] for r in rows})
    print(f"{len(rows)} quotes across {games} games and {books} books")
    if a.dry_run:
        return

    live = sqlite3.connect(LIVE, timeout=180)
    live.execute("PRAGMA busy_timeout=180000")
    before = live.execute("SELECT COUNT(*) FROM nfl_line_snapshots").fetchone()[0]
    live.executemany(
        """INSERT OR IGNORE INTO nfl_line_snapshots
           (captured_at, event_id, commence_time, home_team, away_team, book, market, side,
            line, price, provider, book_updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", rows)
    live.commit()
    after = live.execute("SELECT COUNT(*) FROM nfl_line_snapshots").fetchone()[0]
    print(f"nfl_line_snapshots: {before:,} -> {after:,} (+{after - before:,})")
    for r in live.execute(
            """SELECT provider, market, COUNT(*), MAX(captured_at) FROM nfl_line_snapshots
               GROUP BY provider, market ORDER BY provider"""):
        print("  ", r)


if __name__ == "__main__":
    main()
