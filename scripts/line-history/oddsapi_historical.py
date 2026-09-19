#!/usr/bin/env python3
"""
Re-pull The Odds API historical snapshots into the line-history archive (paid plan credits).

Endpoint: https://api.the-odds-api.com/v4/historical/sports/americanfootball_nfl/odds/?date=<ISO>
  Returns the snapshot at or just before <date>, plus previous/next snapshot timestamps.
  Snapshots are 5 minutes apart. Cost: 10 credits per region per market per call.
  Verified 2026-09-16 on Nick's key: 11 US books (betmgm, betonlineag, betrivers, betus, bovada,
  draftkings, fanatics, fanduel, lowvig, mybookieag, williamhill_us). Pinnacle needs regions=eu.

Writes to data/line-history/line_history.sqlite (never server/data.sqlite):
  oddsapi_snapshots(snapshot_at, event_id, commence_time, home, away, book, market, side, line, price, book_updated_at)

Safety:
  --dry-run prints the number of calls and credits and exits.
  --reserve N stops when x-requests-remaining would fall below N (default 2000, so the live poll keeps working).
  Resumable: snapshot timestamps already stored are skipped.

Usage:
  python3 scripts/line-history/oddsapi_historical.py --start 2026-09-02T00:00Z --end 2026-09-16T23:59Z --step-min 15 --markets spreads --dry-run
"""
import argparse
import datetime as dt
import json
import os
import urllib.parse
import urllib.request

from common import connect, log, REPO

URL = "https://api.the-odds-api.com/v4/historical/sports/americanfootball_nfl/odds/"
SCHEMA = """
CREATE TABLE IF NOT EXISTS oddsapi_snapshots (
  snapshot_at TEXT, event_id TEXT, commence_time TEXT, home TEXT, away TEXT, book TEXT, market TEXT,
  side TEXT, line REAL, price INTEGER, book_updated_at TEXT,
  UNIQUE(snapshot_at, event_id, book, market, side));
CREATE INDEX IF NOT EXISTS oddsapi_evt ON oddsapi_snapshots(event_id, market, book, snapshot_at);
CREATE TABLE IF NOT EXISTS oddsapi_calls (requested_date TEXT PRIMARY KEY, snapshot_at TEXT, prev_at TEXT, next_at TEXT,
  markets TEXT, regions TEXT, events INTEGER, rows INTEGER, credits_used INTEGER, remaining INTEGER, fetched_at TEXT);
"""


def load_key():
    k = os.environ.get("ODDS_API_KEY")
    if not k:
        env = REPO / ".env"
        if env.exists():
            for line in env.read_text().splitlines():
                if line.startswith("ODDS_API_KEY="):
                    k = line.split("=", 1)[1].strip()
    if not k:
        raise SystemExit("ODDS_API_KEY not set (env or repo .env)")
    return k


def parse_iso(s):
    s = s.replace("Z", "+00:00")
    d = dt.datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def call(key, date_iso, markets, regions):
    q = urllib.parse.urlencode(dict(apiKey=key, regions=regions, markets=markets, oddsFormat="american", dateFormat="iso", date=date_iso))
    r = urllib.request.urlopen(urllib.request.Request(URL + "?" + q, headers={"User-Agent": "gridiron-line-history"}), timeout=180)
    body = json.loads(r.read())
    hdr = {k.lower(): v for k, v in r.getheaders()}
    return body, int(hdr.get("x-requests-last", 0) or 0), int(hdr.get("x-requests-remaining", 0) or 0)


def store(con, requested, body, markets, regions, credits, remaining):
    snap = body.get("timestamp")
    n = 0
    for e in body.get("data", []):
        for b in e.get("bookmakers", []):
            for m in b.get("markets", []):
                for o in m.get("outcomes", []):
                    side = ("home" if o["name"] == e["home_team"] else "away" if o["name"] == e["away_team"] else o["name"].lower()) \
                        if m["key"] != "totals" else o["name"].lower()
                    con.execute("INSERT OR IGNORE INTO oddsapi_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                (snap, e["id"], e["commence_time"], e["home_team"], e["away_team"], b["key"], m["key"], side,
                                 o.get("point"), o.get("price"), m.get("last_update") or b.get("last_update")))
                    n += 1
    con.execute("INSERT OR REPLACE INTO oddsapi_calls VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (requested, snap, body.get("previous_timestamp"), body.get("next_timestamp"), markets, regions,
                 len(body.get("data", [])), n, credits, remaining, dt.datetime.now(dt.timezone.utc).isoformat()))
    con.commit()
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--step-min", type=int, default=15)
    ap.add_argument("--markets", default="spreads")
    ap.add_argument("--regions", default="us")
    ap.add_argument("--reserve", type=int, default=2000)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    start, end = parse_iso(a.start), parse_iso(a.end)
    dates = []
    t = start
    while t <= end:
        dates.append(t.strftime("%Y-%m-%dT%H:%M:%SZ"))
        t += dt.timedelta(minutes=a.step_min)
    per_call = 10 * len(a.markets.split(",")) * len(a.regions.split(","))
    con = connect()
    con.executescript(SCHEMA)
    done = {r[0] for r in con.execute("SELECT requested_date FROM oddsapi_calls")}
    todo = [d for d in dates if d not in done]
    log(f"{len(dates)} snapshot times, {len(todo)} not yet fetched, {per_call} credits each = {per_call * len(todo)} credits")
    if a.dry_run:
        return
    key = load_key()
    for i, d in enumerate(todo, 1):
        body, used, remaining = call(key, d, a.markets, a.regions)
        n = store(con, d, body, a.markets, a.regions, used, remaining)
        if i % 20 == 0 or i == 1:
            log(f"  {i}/{len(todo)} {d} -> snapshot {body.get('timestamp')} events {len(body.get('data', []))} rows {n} | remaining {remaining}")
        if remaining - per_call < a.reserve:
            log(f"stopping: remaining {remaining} would fall below reserve {a.reserve}")
            break
    tot = con.execute("SELECT COUNT(*), COUNT(DISTINCT snapshot_at) FROM oddsapi_snapshots").fetchone()
    log(f"archive: {tot[0]} rows across {tot[1]} snapshots")


if __name__ == "__main__":
    main()
