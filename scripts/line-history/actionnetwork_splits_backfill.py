#!/usr/bin/env python3
"""
Backfill public betting splits per game from Action Network (free, undocumented).

  https://api.actionnetwork.com/web/v1/scoreboard/nfl?season=YYYY&week=N&period=game&bookIds=...
    -> per game, per book: spread/ml/total lines and prices, plus for the consensus book (15):
       spread_home_public (% of bets), spread_home_money (% of money), same for ml and totals,
       num_bets, and `inserted` (when that odds row was written). Past seasons return the closing row.

Verified 2026-09-16: 2022, 2024, 2025 weeks return splits; the current week's splits populate as the
week progresses, so re-run weekly to catch closing values for the current season.

Output: an_public_splits in data/line-history/line_history.sqlite (one row per game, book, capture).
"""
import argparse
import datetime as dt
import json

from common import connect, fetch_json, log

BOOKS = "15,30,49,68,69,71,75,79"
SB = "https://api.actionnetwork.com/web/v1/scoreboard/nfl?season={season}&week={week}&period=game&bookIds=" + BOOKS
FIELDS = ["ml_away", "ml_home", "spread_away", "spread_home", "spread_away_line", "spread_home_line", "over", "under", "total",
          "ml_home_public", "ml_away_public", "spread_home_public", "spread_away_public", "total_under_public", "total_over_public",
          "ml_home_money", "ml_away_money", "spread_home_money", "spread_away_money", "total_over_money", "total_under_money",
          "num_bets", "book_id", "type", "inserted", "line_status"]
SCHEMA = f"""
CREATE TABLE IF NOT EXISTS an_public_splits (season INTEGER, week INTEGER, event_id INTEGER, start_time TEXT, away TEXT, home TEXT,
  status TEXT, away_score INTEGER, home_score INTEGER, {", ".join(f + " " + ("TEXT" if f in ("type", "inserted", "line_status") else "REAL") for f in FIELDS)},
  captured_at TEXT, UNIQUE(season, week, event_id, book_id, type, inserted));
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="*", type=int, default=list(range(2017, 2027)))
    ap.add_argument("--weeks", nargs="*", type=int, default=list(range(1, 23)))
    a = ap.parse_args()
    con = connect()
    con.executescript(SCHEMA)
    for season in a.seasons:
        n = 0
        for week in a.weeks:
            st, d = fetch_json(SB.format(season=season, week=week), sleep=0.7)
            games = (d or {}).get("games", [])
            if not games:
                continue
            for g in games:
                teams = {t["id"]: t for t in g.get("teams", [])}
                away, home = teams.get(g.get("away_team_id"), {}).get("abbr"), teams.get(g.get("home_team_id"), {}).get("abbr")
                bs = g.get("boxscore") or {}
                for o in g.get("odds", []):
                    vals = [json.dumps(o.get(f)) if isinstance(o.get(f), (dict, list)) else o.get(f) for f in FIELDS]
                    con.execute(f"INSERT OR IGNORE INTO an_public_splits VALUES ({','.join('?' * (9 + len(FIELDS) + 1))})",
                                (season, week, g["id"], g.get("start_time"), away, home, g.get("status"),
                                 bs.get("total_away_points"), bs.get("total_home_points"), *vals,
                                 dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
                    n += 1
            con.commit()
        log(f"season {season}: {n} odds rows stored")
    tot = con.execute("SELECT count(*), count(distinct event_id), min(season), max(season), sum(spread_home_public IS NOT NULL) FROM an_public_splits").fetchone()
    log(f"done: {tot[0]} rows, {tot[1]} games, {tot[2]}-{tot[3]}, {tot[4]} rows with public splits")


if __name__ == "__main__":
    main()
