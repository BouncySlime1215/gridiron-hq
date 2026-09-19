#!/usr/bin/env python3
"""
Backfill ESPN's own per-play win probability and play log (free, public core API; the site API blocks scripts).

  https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events?dates=YYYYMMDD-YYYYMMDD&limit=100
  https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/<id>/competitions/<id>/plays?limit=400
  https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/<id>/competitions/<id>/probabilities?limit=1000

Why: ESPN's homeWinPercentage is the number the public and the live-edge model see, and each play carries
a `wallclock`. Together with nflverse `time_of_day`, this pins every in-game moment to the per-minute
Polymarket prices and the Odds API 15-minute snapshots.

Output tables in data/line-history/line_history.sqlite: espn_events, espn_plays, espn_probabilities.
Resumable per event.
"""
import argparse
import datetime as dt
import json

from common import connect, fetch_json, log

CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
SCHEMA = """
CREATE TABLE IF NOT EXISTS espn_events (event_id TEXT PRIMARY KEY, date TEXT, name TEXT, season INTEGER, week INTEGER,
  home TEXT, away TEXT, plays_fetched_at TEXT, plays INTEGER, prob_points INTEGER);
CREATE TABLE IF NOT EXISTS espn_plays (event_id TEXT, play_id TEXT, sequence INTEGER, period INTEGER, clock TEXT, wallclock TEXT,
  type TEXT, text TEXT, home_score INTEGER, away_score INTEGER, scoring INTEGER, start_down INTEGER, start_distance INTEGER,
  start_yardline INTEGER, start_team TEXT, stat_yardage INTEGER, PRIMARY KEY(event_id, play_id));
CREATE TABLE IF NOT EXISTS espn_probabilities (event_id TEXT, play_id TEXT, sequence INTEGER, home_wp REAL, away_wp REAL, tie REAL,
  seconds_left INTEGER, last_modified TEXT, PRIMARY KEY(event_id, play_id));
"""


def season_windows(season):
    return f"{season}0801-{season + 1}0228"


def list_events(season):
    page = 1
    while True:
        st, d = fetch_json(f"{CORE}/events?dates={season_windows(season)}&limit=100&page={page}", sleep=0.3)
        if st != 200 or not d:
            return
        for it in d.get("items", []):
            yield it["$ref"].split("/events/")[1].split("?")[0]
        if page >= int(d.get("pageCount", 1)):
            return
        page += 1


def fetch_event(con, eid):
    st, e = fetch_json(f"{CORE}/events/{eid}?lang=en&region=us", sleep=0.2)
    if st != 200 or not e:
        return 0, 0
    comp = (e.get("competitions") or [{}])[0]
    teams = {c.get("homeAway"): (c.get("team") or {}).get("$ref", "").split("/teams/")[-1].split("?")[0] for c in comp.get("competitors", [])}
    season = (e.get("season") or {}).get("year")
    week = (e.get("week") or {}).get("number")
    n_p = n_w = 0
    page = 1
    while True:
        st, d = fetch_json(f"{CORE}/events/{eid}/competitions/{eid}/plays?limit=400&page={page}", sleep=0.2)
        if st != 200 or not d:
            break
        for p in d.get("items", []):
            start = p.get("start") or {}
            con.execute("INSERT OR REPLACE INTO espn_plays VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (eid, p.get("id"), p.get("sequenceNumber"), (p.get("period") or {}).get("number"), (p.get("clock") or {}).get("displayValue"),
                         p.get("wallclock"), (p.get("type") or {}).get("text"), p.get("text"), p.get("homeScore"), p.get("awayScore"),
                         1 if p.get("scoringPlay") else 0, start.get("down"), start.get("distance"), start.get("yardLine"),
                         (start.get("team") or {}).get("$ref", "").split("/teams/")[-1].split("?")[0] or None, (p.get("statYardage"))))
            n_p += 1
        if page >= int(d.get("pageCount", 1)):
            break
        page += 1
    page = 1
    while True:
        st, d = fetch_json(f"{CORE}/events/{eid}/competitions/{eid}/probabilities?limit=1000&page={page}", sleep=0.2)
        if st != 200 or not d:
            break
        for w in d.get("items", []):
            pid = (w.get("play") or {}).get("$ref", "").split("/plays/")[-1].split("?")[0]
            con.execute("INSERT OR REPLACE INTO espn_probabilities VALUES (?,?,?,?,?,?,?,?)",
                        (eid, pid, w.get("sequenceNumber"), w.get("homeWinPercentage"), w.get("awayWinPercentage"), w.get("tiePercentage"),
                         w.get("secondsLeft"), w.get("lastModified")))
            n_w += 1
        if page >= int(d.get("pageCount", 1)):
            break
        page += 1
    con.execute("INSERT OR REPLACE INTO espn_events VALUES (?,?,?,?,?,?,?,?,?,?)",
                (eid, e.get("date"), e.get("name"), season, week, teams.get("home"), teams.get("away"),
                 dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), n_p, n_w))
    con.commit()
    return n_p, n_w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="*", type=int, default=list(range(2016, 2027)))
    ap.add_argument("--max-games", type=int)
    a = ap.parse_args()
    con = connect()
    con.executescript(SCHEMA)
    done = {r[0] for r in con.execute("SELECT event_id FROM espn_events WHERE plays_fetched_at IS NOT NULL")}
    k = 0
    for season in a.seasons:
        ids = [i for i in list_events(season) if i not in done]
        log(f"season {season}: {len(ids)} events to fetch")
        for i, eid in enumerate(ids, 1):
            n_p, n_w = fetch_event(con, eid)
            k += 1
            if i % 50 == 0 or a.max_games:
                log(f"  {season} {i}/{len(ids)} event {eid}: {n_p} plays, {n_w} wp points")
            if a.max_games and k >= a.max_games:
                return
    tot = con.execute("SELECT count(*), sum(plays), sum(prob_points) FROM espn_events").fetchone()
    log(f"done: {tot[0]} events, {tot[1]} plays, {tot[2]} wp points")


if __name__ == "__main__":
    main()
