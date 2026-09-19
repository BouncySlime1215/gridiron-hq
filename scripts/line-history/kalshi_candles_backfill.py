#!/usr/bin/env python3
"""
Backfill Kalshi per-minute candlesticks for every indexed NFL market (free, public, no auth).

  https://api.elections.kalshi.com/trade-api/v2/series/{series}/markets/{ticker}/candlesticks
      ?start_ts=&end_ts=&period_interval=1
      -> one row per minute of the market's life with OHLC of the traded price AND of the
         yes_bid / yes_ask, plus volume and open interest.

Why this and not just kalshi_trades: the Kalshi-leads-the-books effect shows up in the QUOTE,
not in fills. A minute with no trade still has a bid/ask, and those are exactly the minutes
where Kalshi has moved and the sportsbooks have not yet. The trades table is blind to them.

The API caps a request at 5000 candlesticks, so each market is pulled in <=5000-minute windows
from open_time to close_time. Prices come back as dollar strings ("0.5800"); they are stored as
integer cents to match kalshi_trades.

Requires kalshi_backfill.py to have indexed kalshi_markets first.
Output tables: kalshi_candles, kalshi_candles_done. Resumable: done tickers are skipped unless
still open and --refetch-open.
"""
import argparse
import datetime as dt
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from common import connect, fetch_json, log

BASE = "https://api.elections.kalshi.com/trade-api/v2"
MAX_CANDLES = 5000
SCHEMA = """
CREATE TABLE IF NOT EXISTS kalshi_candles (
  ticker TEXT, period INTEGER, ts INTEGER,
  price_open INTEGER, price_high INTEGER, price_low INTEGER, price_close INTEGER, price_mean INTEGER,
  bid_open INTEGER, bid_high INTEGER, bid_low INTEGER, bid_close INTEGER,
  ask_open INTEGER, ask_high INTEGER, ask_low INTEGER, ask_close INTEGER,
  volume REAL, open_interest REAL,
  PRIMARY KEY (ticker, period, ts));
CREATE INDEX IF NOT EXISTS kalshi_candles_ts ON kalshi_candles(ts);
CREATE TABLE IF NOT EXISTS kalshi_candles_done (ticker TEXT PRIMARY KEY, fetched_at TEXT, rows INTEGER, complete INTEGER);
"""


def cents(d):
    """'0.5800' -> 58. Kalshi returns dollar strings; kalshi_trades stores cents."""
    if d is None or d == "":
        return None
    return int(round(float(d) * 100))


def ts_of(x):
    if not x:
        return None
    return int(dt.datetime.fromisoformat(x.replace("Z", "+00:00")).timestamp())


def fetch_candles(con, series, ticker, start, end, period):
    """Pull [start, end) at `period`-minute resolution, in <=5000-candle windows."""
    total = 0
    lo = start
    span = MAX_CANDLES * period * 60
    while lo < end:
        hi = min(lo + span, end)
        url = (f"{BASE}/series/{series}/markets/{ticker}/candlesticks"
               f"?start_ts={lo}&end_ts={hi}&period_interval={period}")
        # 429 means "ask again later", not "no data here". Advancing the window on a 429 would
        # silently drop candles and leave a backfill that looks complete, so rate limiting gets
        # its own unbounded-ish wait; only a real refusal (400/404) advances past the window.
        for rl_attempt in range(8):
            st, d = fetch_json(url, sleep=0.25, retries=3)
            if st != 429:
                break
            wait = min(5 * 2 ** rl_attempt, 120)
            log(f"  429 on {ticker} p{period}, waiting {wait}s")
            time.sleep(wait)
        if st == 429:
            raise RuntimeError(f"rate limited past retry budget on {ticker}; lower --workers")
        if st != 200 or not d:
            # a window the API genuinely refuses (market not yet open, bad range) is not fatal
            lo = hi
            continue
        rows = []
        for c in d.get("candlesticks", []):
            p = c.get("price") or {}
            b = c.get("yes_bid") or {}
            a = c.get("yes_ask") or {}
            rows.append((
                ticker, period, c.get("end_period_ts"),
                cents(p.get("open_dollars")), cents(p.get("high_dollars")), cents(p.get("low_dollars")),
                cents(p.get("close_dollars")), cents(p.get("mean_dollars")),
                cents(b.get("open_dollars")), cents(b.get("high_dollars")), cents(b.get("low_dollars")), cents(b.get("close_dollars")),
                cents(a.get("open_dollars")), cents(a.get("high_dollars")), cents(a.get("low_dollars")), cents(a.get("close_dollars")),
                float(c.get("volume_fp") or 0), float(c.get("open_interest_fp") or 0)))
        if rows:
            con.executemany(
                "INSERT OR IGNORE INTO kalshi_candles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
            total += len(rows)
        lo = hi
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--series", nargs="*", default=["KXNFLGAME", "KXNFLSPREAD", "KXNFLTOTAL"])
    ap.add_argument("--refetch-open", action="store_true",
                    help="re-pull candles for markets that had not closed when last fetched")
    ap.add_argument("--max-markets", type=int)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--fine-days", type=int, default=3,
                    help="3 days = 4320 minutes, which fits in ONE 5000-candle request")
    ap.add_argument("--pad-hours", type=int, default=6,
                    help="extra window after close_time, to catch settlement-minute quotes")
    args = ap.parse_args()

    con = connect()
    con.executescript(SCHEMA)

    q = """SELECT m.ticker, m.series, m.open_time, m.close_time, m.status, d.complete
           FROM kalshi_markets m LEFT JOIN kalshi_candles_done d ON d.ticker = m.ticker
           WHERE m.series IN (%s) ORDER BY m.close_time""" % ",".join("?" * len(args.series))
    # complete=1 is only set for a market that had already settled when we pulled it, so its
    # candles can never change. Anything else (never fetched, or fetched while still open) is
    # re-pulled; INSERT OR IGNORE makes that cheap.
    todo = [(tk, ser, ot, ct, status)
            for tk, ser, ot, ct, status, complete in con.execute(q, args.series).fetchall()
            if not complete]
    if args.max_markets:
        todo = todo[:args.max_markets]
    log(f"{len(todo)} markets to pull candles for")

    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    # Kalshi answers a candlestick request in ~10s regardless of window size, so the backfill is
    # latency-bound, not rate-bound: one market at a time would take ~32 h. Fan out instead, one
    # SQLite connection per thread (WAL plus the retrying connection makes concurrent writes safe).
    local = threading.local()
    state = {"done": 0, "rows": 0}
    lock = threading.Lock()

    def worker(job):
        tk, ser, ot, ct, status = job
        start, end = ts_of(ot), ts_of(ct)
        if not start:
            return
        end = min((end or now) + args.pad_hours * 3600, now)
        if end <= start:
            return
        if getattr(local, "con", None) is None:
            local.con = connect()
        con_t = local.con
        # Minute resolution only where the lead-lag question lives: the last few days before
        # close, plus the game itself. Everything earlier is pulled hourly, which collapses a
        # month-long market from ~9 requests to 2.
        series = ser or tk.split("-")[0]
        fine_from = max(start, end - args.fine_days * 86400)
        n = fetch_candles(con_t, series, tk, fine_from, end, 1)
        if fine_from > start:
            n += fetch_candles(con_t, series, tk, start, fine_from, 60)
        complete = 1 if status in ("finalized", "settled") else 0
        con_t.execute("INSERT OR REPLACE INTO kalshi_candles_done VALUES (?,?,?,?)",
                      (tk, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), n, complete))
        con_t.commit()
        with lock:
            state["done"] += 1
            state["rows"] += n
            if state["done"] % 25 == 0:
                log(f"  {state['done']}/{len(todo)} {tk}: {n} candles (running {state['rows']})")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(worker, todo))
    log(f"done: {state['rows']} candle rows over {state['done']} markets")


if __name__ == "__main__":
    main()
