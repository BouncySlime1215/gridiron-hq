#!/usr/bin/env python3
"""
Trade-level Polymarket history for the core NFL game markets (free, public data-api).

  https://data-api.polymarket.com/trades?market=<conditionId>&limit=500&offset=N
      -> every fill: timestamp, side (BUY/SELL), price, size (shares), outcome, wallet. Newest first.

Adds what the per-minute price series lacks: how much traded, at what size, and in which direction,
which is the raw material for informed-flow and "who moved first" work against the sportsbook ticks.

Reads pm_markets (is_core=1) from data/line-history/line_history.sqlite and writes pm_trades there.
Resumable per market. Big games have 10K+ trades; the API pages 500 at a time.
"""
import argparse
import datetime as dt

from common import connect, fetch_json, log

URL = "https://data-api.polymarket.com/trades?market={cid}&limit=500&offset={off}"
SCHEMA = """
CREATE TABLE IF NOT EXISTS pm_trades (condition_id TEXT, ts INTEGER, tx_hash TEXT, wallet TEXT, side TEXT, outcome TEXT,
  outcome_index INTEGER, price REAL, size REAL, PRIMARY KEY(condition_id, tx_hash, wallet, outcome_index, ts, price, size)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pm_trades_ts ON pm_trades(condition_id, ts);
CREATE TABLE IF NOT EXISTS pm_trades_done (condition_id TEXT PRIMARY KEY, fetched_at TEXT, rows INTEGER, complete INTEGER);
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--types", nargs="*", default=["winner", "spread", "total"])
    ap.add_argument("--max-pages", type=int, default=200, help="500 trades per page")
    ap.add_argument("--refetch-open", action="store_true")
    a = ap.parse_args()
    con = connect()
    con.executescript(SCHEMA)
    todo = con.execute("""SELECT m.condition_id, e.title, m.question, m.closed FROM pm_markets m JOIN pm_events e USING(event_id)
                          LEFT JOIN pm_trades_done d USING(condition_id)
                          WHERE m.is_core=1 AND m.market_type IN (%s) AND (d.condition_id IS NULL OR (m.closed=0 AND ?))
                          ORDER BY e.start_date""" % ",".join("?" * len(a.types)), (*a.types, 1 if a.refetch_open else 0)).fetchall()
    log(f"{len(todo)} markets to pull trades for")
    for i, (cid, title, q, closed) in enumerate(todo, 1):
        n, off, complete = 0, 0, 1
        for page in range(a.max_pages):
            st, d = fetch_json(URL.format(cid=cid, off=off), sleep=0.2)
            if st != 200 or not isinstance(d, list) or not d:
                break
            rows = [(cid, int(t.get("timestamp") or 0), t.get("transactionHash"), t.get("proxyWallet"), t.get("side"), t.get("outcome"),
                     t.get("outcomeIndex"), float(t.get("price") or 0), float(t.get("size") or 0)) for t in d]
            con.executemany("INSERT OR IGNORE INTO pm_trades VALUES (?,?,?,?,?,?,?,?,?)", rows)
            n += len(rows)
            if len(d) < 500:
                break
            off += 500
        else:
            complete = 0
        con.execute("INSERT OR REPLACE INTO pm_trades_done VALUES (?,?,?,?)", (cid, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), n, complete))
        con.commit()
        if i % 50 == 0:
            log(f"  {i}/{len(todo)} {title[:28]} | {q[:24]} -> {n} trades")
    tot = con.execute("SELECT count(*), count(distinct condition_id), min(ts), max(ts) FROM pm_trades").fetchone()
    log(f"done: {tot[0]} trades across {tot[1]} markets")


if __name__ == "__main__":
    main()
