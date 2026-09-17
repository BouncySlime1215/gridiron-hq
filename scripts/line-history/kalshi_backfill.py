#!/usr/bin/env python3
"""
Backfill Kalshi NFL game-market trade history (free, public, no auth).

  https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNFLGAME&status=settled|open&limit=200&cursor=
      -> one market per team per game ("Chicago vs Tennessee: Tennessee wins?"), with close_time, result
  https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=<ticker>&limit=1000&cursor=
      -> every trade: created_time, yes_price, no_price, count, taker_side

Kalshi listed single-game NFL markets from September 2025, so this is 2025 season onward.
Other series worth adding later: KXNFLSPREAD, KXNFLTOTAL (check they exist with --series).

Output tables in data/line-history/line_history.sqlite: kalshi_markets, kalshi_trades.
Resumable: markets with trades_fetched_at set are skipped unless still open and --refetch-open.
"""
import argparse
import datetime as dt

from common import connect, fetch_json, log

BASE = "https://api.elections.kalshi.com/trade-api/v2"
SCHEMA = """
CREATE TABLE IF NOT EXISTS kalshi_markets (ticker TEXT PRIMARY KEY, series TEXT, event_ticker TEXT, title TEXT, subtitle TEXT,
  status TEXT, open_time TEXT, close_time TEXT, expiration_time TEXT, result TEXT, volume INTEGER, yes_bid INTEGER, yes_ask INTEGER,
  last_price INTEGER, trades_fetched_at TEXT, trade_rows INTEGER);
CREATE TABLE IF NOT EXISTS kalshi_trades (trade_id TEXT PRIMARY KEY, ticker TEXT, created_time TEXT, yes_price INTEGER, no_price INTEGER,
  count REAL, taker_side TEXT);
CREATE INDEX IF NOT EXISTS kalshi_trades_tk ON kalshi_trades(ticker, created_time);
"""


def list_markets(series, status):
    cursor = ""
    while True:
        st, d = fetch_json(f"{BASE}/markets?series_ticker={series}&status={status}&limit=200&cursor={cursor}", sleep=0.3)
        if st != 200 or not d:
            return
        for m in d.get("markets", []):
            yield m
        cursor = d.get("cursor") or ""
        if not cursor:
            return


def fetch_trades(con, ticker):
    cursor = ""
    n = 0
    while True:
        st, d = fetch_json(f"{BASE}/markets/trades?ticker={ticker}&limit=1000&cursor={cursor}", sleep=0.25)
        if st != 200 or not d:
            break
        rows = [(t.get("trade_id"), ticker, t.get("created_time"), t.get("yes_price"), t.get("no_price"),
                 float(t.get("count_fp") or t.get("count") or 0), t.get("taker_side")) for t in d.get("trades", [])]
        con.executemany("INSERT OR IGNORE INTO kalshi_trades VALUES (?,?,?,?,?,?,?)", rows)
        n += len(rows)
        cursor = d.get("cursor") or ""
        if not cursor:
            break
    con.execute("UPDATE kalshi_markets SET trades_fetched_at=?, trade_rows=? WHERE ticker=?",
                (dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), n, ticker))
    con.commit()
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--series", nargs="*", default=["KXNFLGAME", "KXNFLSPREAD", "KXNFLTOTAL"])
    ap.add_argument("--refetch-open", action="store_true")
    a = ap.parse_args()
    con = connect()
    con.executescript(SCHEMA)
    for series in a.series:
        k = 0
        for status in ("settled", "open", "closed"):
            for m in list_markets(series, status):
                con.execute("""INSERT INTO kalshi_markets (ticker, series, event_ticker, title, subtitle, status, open_time, close_time,
                               expiration_time, result, volume, yes_bid, yes_ask, last_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                               ON CONFLICT(ticker) DO UPDATE SET status=excluded.status, result=excluded.result, volume=excluded.volume,
                               close_time=excluded.close_time, last_price=excluded.last_price""",
                            (m.get("ticker"), series, m.get("event_ticker"), m.get("title"), m.get("subtitle") or m.get("yes_sub_title"),
                             m.get("status"), m.get("open_time"), m.get("close_time"), m.get("expiration_time"), m.get("result"),
                             m.get("volume"), m.get("yes_bid"), m.get("yes_ask"), m.get("last_price")))
                k += 1
        con.commit()
        log(f"{series}: {k} markets indexed")
    todo = con.execute("SELECT ticker, title FROM kalshi_markets WHERE trades_fetched_at IS NULL OR (status IN ('open','active') AND ?) ORDER BY close_time",
                       (1 if a.refetch_open else 0,)).fetchall()
    log(f"{len(todo)} markets need trades")
    for i, (tk, title) in enumerate(todo, 1):
        n = fetch_trades(con, tk)
        if i % 50 == 0:
            log(f"  {i}/{len(todo)} {tk} -> {n} trades")
    tot = con.execute("SELECT count(*), count(distinct ticker), min(created_time), max(created_time) FROM kalshi_trades").fetchone()
    log(f"done: {tot[0]} trades across {tot[1]} markets, {tot[2]} .. {tot[3]}")


if __name__ == "__main__":
    main()
