"""Shared helpers for the free line-history collectors.

Every collector writes to ONE SQLite file (default data/line-history/line_history.sqlite,
override with LINE_HISTORY_DB). None of them touch server/data.sqlite.
"""
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_DB = REPO / "data" / "line-history" / "line_history.sqlite"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")


def db_path():
    return Path(os.environ.get("LINE_HISTORY_DB", DEFAULT_DB))


class _RetryingConnection(sqlite3.Connection):
    """Retries writes that lose the lock race instead of dying on them.

    The collectors run in parallel against one file, and a bulk load holds the
    write lock for minutes (covers inserts 1.9M rows, polymarket 28M), far past
    any reasonable busy_timeout. On 2026-09-16 six of the twelve collectors died
    mid-backfill with "database is locked" and left their sources truncated.

    Retrying is safe here because every collector writes INSERT OR IGNORE or
    INSERT OR REPLACE, so replaying a statement cannot double-apply.
    """

    def _retry(self, fn, *a, **kw):
        delay = 1.0
        for attempt in range(14):
            try:
                return fn(*a, **kw)
            except sqlite3.OperationalError as e:
                msg = str(e).lower()
                if "locked" not in msg and "busy" not in msg:
                    raise
                if attempt == 13:
                    raise
                time.sleep(delay)
                delay = min(delay * 2, 60)

    def execute(self, *a, **kw):
        return self._retry(super().execute, *a, **kw)

    def executemany(self, *a, **kw):
        return self._retry(super().executemany, *a, **kw)

    def commit(self):
        return self._retry(super().commit)


def connect():
    p = db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p, timeout=600, factory=_RetryingConnection)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=600000")
    return con


def fetch(url, *, accept="text/html,application/json,*/*", retries=4, timeout=60, sleep=1.0,
          referer=None, ua=UA):
    """GET with a browser UA, polite retry/backoff. Returns (status, bytes).

    Pass ua=None for hosts that 403 a browser User-Agent. ESPN's fitt API is one: it answers
    urllib's default UA and curl's, but refuses the Chrome string we send everywhere else.
    """
    hdr = {"Accept": accept, "Accept-Language": "en-US,en;q=0.9"}
    if ua:
        hdr["User-Agent"] = ua
    if referer:
        hdr["Referer"] = referer
    delay = sleep
    last_code = -1
    for attempt in range(retries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=timeout)
            body = r.read()
            time.sleep(sleep)
            return r.status, body
        except urllib.error.HTTPError as e:
            body = e.read()[:300]
            if e.code in (400, 404):
                time.sleep(sleep)
                return e.code, body
            last_code = e.code
            log(f"  http {e.code} on {url[:90]} (attempt {attempt + 1})")
        except Exception as e:  # noqa: BLE001
            log(f"  error {type(e).__name__}: {str(e)[:80]} on {url[:90]} (attempt {attempt + 1})")
        time.sleep(delay)
        delay = min(delay * 3, 60)
    # Surface the last HTTP status rather than a flat -1: a caller needs to tell "rate limited,
    # ask again" (429) apart from "nothing here" so it does not advance past data it never read.
    return last_code, b""


def fetch_json(url, **kw):
    st, b = fetch(url, accept="application/json", **kw)
    if st != 200:
        return st, None
    try:
        return st, json.loads(b)
    except json.JSONDecodeError:
        return st, None


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def american_to_prob(price):
    if price is None:
        return None
    return 100 / (price + 100) if price > 0 else -price / (-price + 100)
