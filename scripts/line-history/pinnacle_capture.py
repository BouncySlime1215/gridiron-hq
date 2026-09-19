#!/usr/bin/env python3
"""
Forward capture of Pinnacle NFL lines from its public guest API (free, undocumented, no login).

  https://guest.api.arcadia.pinnacle.com/0.1/leagues/889/matchups          (league 889 = NFL)
  https://guest.api.arcadia.pinnacle.com/0.1/leagues/889/markets/straight  (spread, moneyline, total; period 0 = full game)
  Header: X-API-Key: CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R  (the public key the Pinnacle website itself sends)

Pinnacle is the sharp benchmark every CLV number in this project is graded against, and no free source
carries its history. This captures it forward every run, with the market `version` so unchanged quotes
dedupe. Run every 10 minutes from launchd.

Output tables in data/line-history/line_history.sqlite: pinnacle_matchups, pinnacle_quotes.
"""
import datetime as dt
import json
import urllib.request

from common import connect, log

BASE = "https://guest.api.arcadia.pinnacle.com/0.1/leagues/889"
HDR = {"X-API-Key": "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R", "User-Agent": "Mozilla/5.0", "Accept": "application/json"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS pinnacle_matchups (matchup_id INTEGER PRIMARY KEY, start_time TEXT, home TEXT, away TEXT, parent_id INTEGER,
  type TEXT, units TEXT, first_seen TEXT, last_seen TEXT);
CREATE TABLE IF NOT EXISTS pinnacle_quotes (captured_at TEXT, matchup_id INTEGER, market_type TEXT, period INTEGER, key TEXT, is_alternate INTEGER,
  version INTEGER, cutoff_at TEXT, status TEXT, max_risk REAL, home_points REAL, home_price INTEGER, away_points REAL, away_price INTEGER,
  over_points REAL, over_price INTEGER, under_points REAL, under_price INTEGER,
  UNIQUE(matchup_id, key, version));
CREATE INDEX IF NOT EXISTS pinnacle_q_m ON pinnacle_quotes(matchup_id, market_type, captured_at);
"""


def get(path):
    r = urllib.request.urlopen(urllib.request.Request(BASE + path, headers=HDR), timeout=60)
    return json.loads(r.read())


def main():
    con = connect()
    con.executescript(SCHEMA)
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    matchups = get("/matchups")
    for m in matchups:
        parts = {p.get("alignment"): p.get("name") for p in m.get("participants", [])}
        con.execute("""INSERT INTO pinnacle_matchups VALUES (?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(matchup_id) DO UPDATE SET last_seen=excluded.last_seen, start_time=excluded.start_time""",
                    (m["id"], m.get("startTime"), parts.get("home"), parts.get("away"), (m.get("parent") or {}).get("id"),
                     m.get("type"), (m.get("units")), now, now))
    markets = get("/markets/straight")
    n = 0
    for k in markets:
        pr = {p.get("designation"): p for p in k.get("prices", [])}
        lim = next((l["amount"] for l in k.get("limits", []) if l.get("type") == "maxRiskStake"), None)
        cur = con.execute("INSERT OR IGNORE INTO pinnacle_quotes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (now, k.get("matchupId"), k.get("type"), k.get("period"), k.get("key"), 1 if k.get("isAlternate") else 0,
                           k.get("version"), k.get("cutoffAt"), k.get("status"), lim,
                           (pr.get("home") or {}).get("points"), (pr.get("home") or {}).get("price"),
                           (pr.get("away") or {}).get("points"), (pr.get("away") or {}).get("price"),
                           (pr.get("over") or {}).get("points"), (pr.get("over") or {}).get("price"),
                           (pr.get("under") or {}).get("points"), (pr.get("under") or {}).get("price")))
        n += cur.rowcount
    con.commit()
    tot = con.execute("SELECT count(*), count(distinct matchup_id) FROM pinnacle_quotes").fetchone()
    log(f"{len(matchups)} matchups, {len(markets)} markets seen, {n} new quote versions; archive {tot[0]} rows / {tot[1]} matchups")


if __name__ == "__main__":
    main()
