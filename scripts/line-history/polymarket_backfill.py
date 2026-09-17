#!/usr/bin/env python3
"""
Backfill per-minute Polymarket price history for NFL game markets (free, public).

Sources (no auth):
  https://gamma-api.polymarket.com/events?tag_slug=nfl&closed=<bool>&limit=100&offset=N
      -> events ("Bills vs. Jets") with markets: winner, "Spread: X (-3.5)" (2025+), "...: O/U 45.5" (2025+)
  https://clob.polymarket.com/prices-history?market=<token>&startTs=&endTs=&fidelity=1
      -> one point per minute while the market traded. NOTE: interval=max returns nothing for closed
         markets; you MUST pass startTs/endTs (verified 2026-09-16).

Coverage verified: 2024 season (352 game events, winner only), 2025 (348, + spreads/totals), 2026 to date.

Usage: python3 scripts/line-history/polymarket_backfill.py [--only-closed] [--max-events N]
Resumable: markets with a stored history_fetched_at are skipped.
"""
import argparse
import datetime as dt
import json
import re

from common import connect, fetch_json, log

GAMMA = "https://gamma-api.polymarket.com/events?tag_slug=nfl&closed={closed}&limit=100&offset={off}&order=startDate&ascending=true"
CLOB = "https://clob.polymarket.com/prices-history?market={tok}&startTs={s}&endTs={e}&fidelity=1"
GAME_RE = re.compile(r"\bvs\.?\b", re.I)
NOT_GAME_RE = re.compile(r"touchdown|yards|first|half|quarter|MVP|draft|coach|retire|trade|Super Bowl winner|win the|make the", re.I)

SCHEMA = """
CREATE TABLE IF NOT EXISTS pm_events (event_id TEXT PRIMARY KEY, slug TEXT, title TEXT, start_date TEXT, end_date TEXT,
  created_at TEXT, closed INTEGER, volume REAL, liquidity REAL, raw_json TEXT);
CREATE TABLE IF NOT EXISTS pm_markets (condition_id TEXT PRIMARY KEY, event_id TEXT, question TEXT, market_type TEXT,
  line REAL, outcome0 TEXT, outcome1 TEXT, token0 TEXT, token1 TEXT, created_at TEXT, end_date TEXT, game_start_time TEXT,
  volume REAL, closed INTEGER, history_fetched_at TEXT, history_points INTEGER, is_core INTEGER);
CREATE TABLE IF NOT EXISTS pm_price_history (condition_id TEXT, t INTEGER, p REAL, PRIMARY KEY(condition_id, t)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pm_ph_t ON pm_price_history(t);
"""


def is_core_market(event_title, question):
    q = (question or "").strip(); t = (event_title or "").strip()
    # winner: the market question IS the event title; spread: "Spread: Team (-3.5)"; game total: "<title>: O/U 45.5".
    # Everything else living inside a game event (player props, 1H/1Q spreads, first TD) is not core.
    if q == t or q.startswith("Spread:") or (t and q.startswith(t) and "O/U" in q):
        return 1
    return 0


def classify(question):
    q = question or ""
    if q.startswith("Spread:"):
        m = re.search(r"\(([+-]?\d+(?:\.\d+)?)\)", q)
        return "spread", float(m.group(1)) if m else None
    if "O/U" in q or re.search(r"over/under|total", q, re.I):
        m = re.search(r"(\d+(?:\.\d+)?)\s*$", q) or re.search(r"O/U\s*(\d+(?:\.\d+)?)", q)
        return "total", float(m.group(1)) if m else None
    return "winner", None


def iso_ts(s):
    if not s:
        return None
    return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())


def list_events(closed):
    off = 0
    while True:
        st, d = fetch_json(GAMMA.format(closed=str(closed).lower(), off=off), sleep=0.4)
        if st != 200 or not d:
            return
        for e in d:
            yield e
        if len(d) < 100:
            return
        off += 100


def store_event(con, e):
    con.execute("INSERT OR REPLACE INTO pm_events VALUES (?,?,?,?,?,?,?,?,?,?)",
                (str(e.get("id")), e.get("slug"), (e.get("title") or "").strip(), e.get("startDate"), e.get("endDate"),
                 e.get("createdAt"), 1 if e.get("closed") else 0, float(e.get("volume") or 0), float(e.get("liquidity") or 0), json.dumps(e)[:20000]))
    for m in e.get("markets", []):
        toks = json.loads(m.get("clobTokenIds") or "[]")
        outs = json.loads(m.get("outcomes") or "[]")
        mtype, ln = classify(m.get("question"))
        cur = con.execute("SELECT history_fetched_at, history_points FROM pm_markets WHERE condition_id=?", (m.get("conditionId"),)).fetchone()
        con.execute("INSERT OR REPLACE INTO pm_markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (m.get("conditionId"), str(e.get("id")), m.get("question"), mtype, ln,
                     outs[0] if outs else None, outs[1] if len(outs) > 1 else None,
                     toks[0] if toks else None, toks[1] if len(toks) > 1 else None,
                     m.get("createdAt"), m.get("endDate"), m.get("gameStartTime"), float(m.get("volume") or 0),
                     1 if m.get("closed") else 0, cur[0] if cur else None, cur[1] if cur else None,
                     is_core_market(e.get("title"), m.get("question"))))


def fetch_history(con, cid, tok, start_iso, end_iso):
    s = (iso_ts(start_iso) or 0) - 86400
    e = (iso_ts(end_iso) or int(dt.datetime.utcnow().timestamp())) + 3 * 86400
    e = min(e, int(dt.datetime.utcnow().timestamp()) + 60)
    n = 0
    win = 7 * 86400
    a = s
    while a < e:
        b = min(a + win, e)
        st, d = fetch_json(CLOB.format(tok=tok, s=a, e=b), sleep=0.25)
        if st == 200 and d:
            pts = d.get("history", [])
            con.executemany("INSERT OR IGNORE INTO pm_price_history VALUES (?,?,?)", [(cid, int(p["t"]), float(p["p"])) for p in pts])
            n += len(pts)
        a = b
    con.execute("UPDATE pm_markets SET history_fetched_at=?, history_points=? WHERE condition_id=?", (dt.datetime.utcnow().isoformat(), n, cid))
    con.commit()
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only-closed", action="store_true")
    ap.add_argument("--max-events", type=int)
    ap.add_argument("--refetch-open", action="store_true", help="re-pull history for markets not yet closed")
    ap.add_argument("--types", nargs="*", default=["winner", "spread", "total"],
                    help="market types to pull history for (game events also carry prop-style markets; those are 'winner' by default classification unless the question names a team matchup)")
    a = ap.parse_args()
    con = connect()
    con.executescript(SCHEMA)
    kept = 0
    for closed in ([True] if a.only_closed else [True, False]):
        for e in list_events(closed):
            t = e.get("title") or ""
            if not GAME_RE.search(t) or NOT_GAME_RE.search(t):
                continue
            store_event(con, e)
            kept += 1
            if a.max_events and kept >= a.max_events:
                break
        con.commit()
        log(f"indexed {kept} game events (closed={closed})")
    todo = con.execute("""SELECT m.condition_id, m.token0, m.created_at, COALESCE(m.end_date, e.end_date), m.closed, e.title, m.question
                          FROM pm_markets m JOIN pm_events e ON e.event_id=m.event_id
                          WHERE m.token0 IS NOT NULL AND (m.history_fetched_at IS NULL OR (m.closed=0 AND ?))
                            AND m.market_type IN (%s) AND m.is_core=1
                          ORDER BY e.start_date""" % ",".join("?" * len(a.types)), (1 if a.refetch_open else 0, *a.types)).fetchall()
    log(f"{len(todo)} markets need price history")
    for i, (cid, tok, c_at, end, closed, title, q) in enumerate(todo, 1):
        n = fetch_history(con, cid, tok, c_at, end)
        if i % 50 == 0:
            log(f"  {i}/{len(todo)} {title[:30]} | {q[:30]} -> {n} pts")
    tot = con.execute("SELECT COUNT(*), COUNT(DISTINCT condition_id) FROM pm_price_history").fetchone()
    log(f"done: {tot[0]} price points across {tot[1]} markets")


if __name__ == "__main__":
    main()
