#!/usr/bin/env python3
"""
Forward capture of tick-level US-book line history from Action Network (free, undocumented).

  https://api.actionnetwork.com/web/v1/scoreboard/nfl?season=YYYY&week=N&period=game  -> game ids
  https://api.actionnetwork.com/web/v2/markets/event/<id>/history?bookIds=...        -> per book/market/side
      "history": [{odds, value, updated_at, line_status}, ...] every change since the line posted

Verified 2026-09-16: history is served for the current and the previous week (median 4 min between
changes, 7 books, back to when the line posted in May). It is GONE for games older than about two
weeks (2025 and earlier return empty history). So this must run at least weekly, forever, to build
a US-book archive. Books: 15 Consensus, 30 Open, 49 Caesars, 68 DraftKings, 69 FanDuel, 71 BetRivers,
75 BetMGM, 79 bet365.

Usage: python3 scripts/line-history/actionnetwork_capture.py [--season 2026 --weeks 1 2 3]
Default: current season, the current week and the previous two. Idempotent (UNIQUE on every tick).
"""
import argparse
import datetime as dt
import json

from common import connect, fetch_json, log

BOOKS = {15: "consensus", 30: "open", 49: "caesars", 68: "draftkings", 69: "fanduel", 71: "betrivers", 75: "betmgm", 79: "bet365"}
SB = "https://api.actionnetwork.com/web/v1/scoreboard/nfl?season={season}&week={week}&period=game"
HIST = "https://api.actionnetwork.com/web/v2/markets/event/{gid}/history?bookIds=" + ",".join(map(str, BOOKS))

SCHEMA = """
CREATE TABLE IF NOT EXISTS an_games (event_id INTEGER PRIMARY KEY, season INTEGER, week INTEGER, start_time TEXT,
  away TEXT, home TEXT, away_team_id INTEGER, home_team_id INTEGER, last_capture TEXT, raw_json TEXT);
CREATE TABLE IF NOT EXISTS an_line_history (event_id INTEGER, book_id INTEGER, book TEXT, market TEXT, side TEXT,
  period TEXT, team_id INTEGER, updated_at TEXT, value REAL, odds INTEGER, line_status TEXT,
  UNIQUE(event_id, book_id, market, side, period, updated_at, value, odds));
CREATE INDEX IF NOT EXISTS an_lh_evt ON an_line_history(event_id, market, book_id, updated_at);
"""


def current_week(season):
    st, d = fetch_json(f"https://api.actionnetwork.com/web/v1/scoreboard/nfl?period=game", sleep=0.5)
    g = (d or {}).get("games", [])
    return max((x.get("week") or 0) for x in g) if g else 1


def capture_week(con, season, week):
    st, d = fetch_json(SB.format(season=season, week=week), sleep=0.5)
    games = (d or {}).get("games", [])
    n_ticks = 0
    for g in games:
        gid = g["id"]
        teams = {t["id"]: t for t in g.get("teams", [])}
        away, home = teams.get(g.get("away_team_id"), {}), teams.get(g.get("home_team_id"), {})
        con.execute("INSERT OR REPLACE INTO an_games VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (gid, season, week, g.get("start_time"), away.get("abbr"), home.get("abbr"),
                     g.get("away_team_id"), g.get("home_team_id"), dt.datetime.utcnow().isoformat(), json.dumps(g)[:20000]))
        st, h = fetch_json(HIST.format(gid=gid), sleep=0.6)
        if st != 200 or not h:
            continue
        for book_id, blob in h.items():
            for market, entries in (blob.get("event") or {}).items():
                for e in entries:
                    for tick in e.get("history") or []:
                        con.execute("""INSERT OR IGNORE INTO an_line_history VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                                    (gid, int(book_id), BOOKS.get(int(book_id), book_id), market, e.get("side"), e.get("period"),
                                     e.get("team_id"), tick.get("updated_at"), tick.get("value"), tick.get("odds"), tick.get("line_status")))
                        n_ticks += 1
        con.commit()
    log(f"season {season} week {week}: {len(games)} games, {n_ticks} ticks seen")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=dt.date.today().year if dt.date.today().month >= 3 else dt.date.today().year - 1)
    ap.add_argument("--weeks", nargs="*", type=int)
    a = ap.parse_args()
    con = connect()
    con.executescript(SCHEMA)
    weeks = a.weeks or [w for w in range(current_week(a.season) - 2, current_week(a.season) + 1) if w >= 1]
    for w in weeks:
        capture_week(con, a.season, w)
    tot = con.execute("SELECT COUNT(*), COUNT(DISTINCT event_id) FROM an_line_history").fetchone()
    log(f"archive now holds {tot[0]} ticks across {tot[1]} games")


if __name__ == "__main__":
    main()
