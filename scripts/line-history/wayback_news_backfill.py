#!/usr/bin/env python3
"""
Reconstruct point-in-time NFL news and injury pages from the Wayback Machine (free, no auth).

The news→line-movement study needs to know WHAT WAS KNOWN AT TIME T. ESPN's news API only
serves the latest 50 articles (about one day), so it can only ever capture forward. The
Internet Archive has been snapshotting the injury and news index pages several times a day
since 2019, and every snapshot carries an exact capture timestamp — which is the field the
deleted nfl_tweet_line_watch table was built on.

  http://web.archive.org/cdx/search/cdx?url=<page>&output=json&from=&to=&collapse=timestamp:10
      -> one row per archived snapshot: timestamp, original url, status, digest
  https://web.archive.org/web/<timestamp>id_/<url>
      -> that snapshot's raw bytes, unrewritten (the `id_` suffix suppresses Archive's
         own header/script injection, so the HTML is what the page actually served)

Raw HTML is stored zlib-compressed and parsed later: reparsing a stored snapshot is free,
refetching 20,000 of them is not. `digest` is Archive's content hash — consecutive snapshots
with the same digest mean the page did not change, which is itself the signal (a page that
changes at 14:02 is a news event at 14:02).

Output tables: wayback_snapshots, wayback_pages. Resumable per (url, timestamp).
Usage: python3 scripts/line-history/wayback_news_backfill.py [--from 2019] [--urls ...]
"""
import argparse
import datetime as dt
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor

from common import connect, fetch, fetch_json, log

CDX = "http://web.archive.org/cdx/search/cdx"

# Pages whose CONTENT is a point-in-time statement of player availability or breaking news.
DEFAULT_URLS = [
    "espn.com/nfl/injuries",
    "www.nfl.com/injuries/",
    "profootballtalk.nbcsports.com",
    "www.cbssports.com/nfl/injuries/",
    "www.rotowire.com/football/injury-report.php",
    "espn.com/nfl/",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS wayback_snapshots (
  url TEXT, timestamp TEXT, original TEXT, mimetype TEXT, statuscode TEXT, digest TEXT,
  length INTEGER, captured_at TEXT, fetched_at TEXT, body_bytes INTEGER,
  PRIMARY KEY (url, timestamp));
CREATE INDEX IF NOT EXISTS wayback_snap_at ON wayback_snapshots(captured_at);
CREATE TABLE IF NOT EXISTS wayback_pages (
  url TEXT, timestamp TEXT, html_z BLOB,
  PRIMARY KEY (url, timestamp));
"""


def iso(ts):
    """Wayback's 14-digit UTC stamp -> ISO. This is the field the whole study keys on."""
    try:
        return dt.datetime.strptime(ts, "%Y%m%d%H%M%S").replace(tzinfo=dt.timezone.utc).isoformat()
    except ValueError:
        return None


def list_snapshots(url, frm, to, collapse):
    q = (f"{CDX}?url={url}&output=json&from={frm}&to={to}"
         f"&filter=statuscode:200&collapse=timestamp:{collapse}")
    st, d = fetch_json(q, sleep=1.0, timeout=180)
    if st != 200 or not d or len(d) < 2:
        return []
    head, *rows = d
    return [dict(zip(head, r)) for r in rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--urls", nargs="*", default=DEFAULT_URLS)
    ap.add_argument("--from", dest="frm", default="2019")
    ap.add_argument("--to", default=dt.date.today().strftime("%Y%m%d"))
    ap.add_argument("--collapse", type=int, default=10,
                    help="dedupe by first N digits of the stamp: 10 = hourly, 8 = daily")
    ap.add_argument("--workers", type=int, default=1,
                    help="Archive.org refuses connections above ~1 concurrent stream")
    ap.add_argument("--throttle", type=float, default=3.0,
                    help="seconds between requests; Archive.org is strict")
    ap.add_argument("--max-per-url", type=int)
    args = ap.parse_args()

    con = connect()
    con.executescript(SCHEMA)

    jobs = []
    for u in args.urls:
        snaps = list_snapshots(u, args.frm, args.to, args.collapse)
        log(f"{u}: {len(snaps)} snapshots in the index")
        have = {r[0] for r in con.execute(
            "SELECT timestamp FROM wayback_snapshots WHERE url=? AND fetched_at IS NOT NULL", (u,))}
        todo = [s for s in snaps if s.get("timestamp") not in have]
        if args.max_per_url:
            todo = todo[:args.max_per_url]
        rows = [(u, s.get("timestamp"), s.get("original"), s.get("mimetype"), s.get("statuscode"),
                 s.get("digest"), int(s.get("length") or 0), iso(s.get("timestamp")), None, None)
                for s in snaps]
        con.executemany(
            "INSERT OR IGNORE INTO wayback_snapshots VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
        con.commit()
        jobs += [(u, s.get("timestamp"), s.get("original")) for s in todo]
    log(f"{len(jobs)} snapshot bodies to fetch")

    local = threading.local()
    state = {"n": 0, "bytes": 0}
    lock = threading.Lock()

    def worker(job):
        u, ts, original = job
        if not ts:
            return
        if getattr(local, "con", None) is None:
            local.con = connect()
        c = local.con
        url = f"https://web.archive.org/web/{ts}id_/{original or u}"
        # Archive.org throttles by refusing the TCP connection outright (Errno 61), which arrives
        # as a URLError rather than an HTTP 429 -- so a status-code backoff never fires and the
        # crawl burns through its work list fetching nothing. The first run of this collector did
        # exactly that: 156 refusals, 80 bodies out of 18,239 snapshots. Back off on any failure,
        # and keep concurrency at 1: Archive sustains roughly one request every few seconds.
        st, body = fetch(url, sleep=args.throttle, retries=2, timeout=120)
        if st != 200 or not body:
            for attempt in range(6):
                wait = min(20 * 2 ** attempt, 600)
                time.sleep(wait)
                st, body = fetch(url, sleep=args.throttle, retries=2, timeout=120)
                if st == 200 and body:
                    break
                if st in (400, 404):
                    return
        if st != 200 or not body:
            with lock:
                state["failed"] = state.get("failed", 0) + 1
            return
        c.execute("INSERT OR IGNORE INTO wayback_pages VALUES (?,?,?)",
                  (u, ts, zlib.compress(body, 6)))
        c.execute("UPDATE wayback_snapshots SET fetched_at=?, body_bytes=? WHERE url=? AND timestamp=?",
                  (dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), len(body), u, ts))
        c.commit()
        with lock:
            state["n"] += 1
            state["bytes"] += len(body)
            if state["n"] % 50 == 0:
                log(f"  {state['n']}/{len(jobs)} ok, {state.get('failed',0)} failed ({state['bytes'] / 1e6:.0f} MB raw)")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(worker, jobs))
    log(f"done: {state['n']} snapshot bodies, {state['bytes'] / 1e6:.0f} MB raw HTML")


if __name__ == "__main__":
    main()
