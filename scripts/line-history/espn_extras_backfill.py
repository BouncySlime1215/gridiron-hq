#!/usr/bin/env python3
"""
ESPN core API extras, per game 2016 onward (free, public):

  predictor      .../events/<id>/competitions/<id>/predictor        -> ESPN FPI pregame win probability and projected margin
  odds           .../events/<id>/competitions/<id>/odds              -> per provider (ESPN BET, Bet 365, ...): open, close, current spread/total/moneyline
  transactions   .../transactions?dates=YYYYMMDD&limit=1000          -> dated signings, releases, IR moves, trades (roster events)

Uses the event list already stored in espn_events by espn_core_backfill.py (run that first, or pass --seasons to list events itself).
Output tables in data/line-history/line_history.sqlite: espn_predictor, espn_odds, espn_transactions.
"""
import argparse
import datetime as dt
import json

from common import connect, fetch_json, log

CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
SCHEMA = """
CREATE TABLE IF NOT EXISTS espn_predictor (event_id TEXT PRIMARY KEY, last_modified TEXT, home_team_id TEXT, away_team_id TEXT,
  home_win_prob REAL, away_win_prob REAL, home_proj_margin REAL, raw_json TEXT);
CREATE TABLE IF NOT EXISTS espn_odds (event_id TEXT, provider_id TEXT, provider TEXT, spread REAL, over_under REAL, details TEXT,
  home_ml INTEGER, away_ml INTEGER, open_json TEXT, close_json TEXT, current_json TEXT, fetched_at TEXT, PRIMARY KEY(event_id, provider_id));
CREATE TABLE IF NOT EXISTS espn_transactions (date TEXT, team_id TEXT, description TEXT, PRIMARY KEY(date, team_id, description));
CREATE TABLE IF NOT EXISTS espn_extras_done (event_id TEXT PRIMARY KEY, fetched_at TEXT);
"""


def team_id(ref):
    return (ref or "").split("/teams/")[-1].split("?")[0] or None


def stat(stats, name):
    for s in stats or []:
        if s.get("name") == name:
            try:
                return float(s.get("value"))
            except (TypeError, ValueError):
                return None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="*", type=int, default=list(range(2016, 2027)))
    ap.add_argument("--skip-transactions", action="store_true")
    a = ap.parse_args()
    con = connect()
    con.executescript(SCHEMA)
    done = {r[0] for r in con.execute("SELECT event_id FROM espn_extras_done")}
    events = [r[0] for r in con.execute("SELECT event_id FROM espn_events WHERE substr(date,1,4) IN (%s) ORDER BY date"
                                        % ",".join("?" * len(a.seasons)), [str(s) for s in a.seasons] + [])]
    # events dated Jan/Feb belong to the prior season; the date filter above is generous on purpose
    todo = [e for e in events if e not in done]
    log(f"{len(events)} events known, {len(todo)} to fetch")
    for i, eid in enumerate(todo, 1):
        st, p = fetch_json(f"{CORE}/events/{eid}/competitions/{eid}/predictor", sleep=0.2)
        if st == 200 and p:
            ht, at = p.get("homeTeam") or {}, p.get("awayTeam") or {}
            con.execute("INSERT OR REPLACE INTO espn_predictor VALUES (?,?,?,?,?,?,?,?)",
                        (eid, p.get("lastModified"), team_id((ht.get("team") or {}).get("$ref")), team_id((at.get("team") or {}).get("$ref")),
                         stat(ht.get("statistics"), "gameProjection"), stat(at.get("statistics"), "gameProjection"),
                         stat(ht.get("statistics"), "matchupQuality") if False else stat(ht.get("statistics"), "teamPredPtDiff"), json.dumps(p)[:4000]))
        st, o = fetch_json(f"{CORE}/events/{eid}/competitions/{eid}/odds", sleep=0.2)
        for it in (o or {}).get("items", []) if st == 200 else []:
            pv = it.get("provider") or {}
            con.execute("INSERT OR REPLACE INTO espn_odds VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (eid, str(pv.get("id")), pv.get("name"), it.get("spread"), it.get("overUnder"), it.get("details"),
                         (it.get("homeTeamOdds") or {}).get("moneyLine"), (it.get("awayTeamOdds") or {}).get("moneyLine"),
                         json.dumps(it.get("open"))[:3000] if it.get("open") else None, json.dumps(it.get("close"))[:3000] if it.get("close") else None,
                         json.dumps(it.get("current"))[:3000] if it.get("current") else None, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
        con.execute("INSERT OR REPLACE INTO espn_extras_done VALUES (?,?)", (eid, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
        if i % 100 == 0:
            con.commit()
            log(f"  {i}/{len(todo)}")
    con.commit()
    if not a.skip_transactions:
        for season in a.seasons:
            d0 = dt.date(season, 3, 1)
            d1 = min(dt.date(season + 1, 2, 28), dt.date.today())
            day, n = d0, 0
            while day <= d1:
                st, t = fetch_json(f"{CORE}/transactions?dates={day:%Y%m%d}&limit=1000", sleep=0.15)
                for it in (t or {}).get("items", []) if st == 200 else []:
                    con.execute("INSERT OR IGNORE INTO espn_transactions VALUES (?,?,?)",
                                (it.get("date"), team_id((it.get("team") or {}).get("$ref")), it.get("description")))
                    n += 1
                day += dt.timedelta(days=1)
            con.commit()
            log(f"transactions {season}: {n} rows")
    tot = con.execute("SELECT (SELECT count(*) FROM espn_predictor), (SELECT count(*) FROM espn_odds), (SELECT count(*) FROM espn_transactions)").fetchone()
    log(f"done: predictor {tot[0]}, odds rows {tot[1]}, transactions {tot[2]}")


if __name__ == "__main__":
    main()
