#!/usr/bin/env python3
"""
Repair press-conference publication times from date-only to full second precision.

WHY. press_conferences_raw.published_at was stored as YYYY-MM-DD for every row, because the
collector printed yt-dlp's %(upload_date)s (a date) rather than %(timestamp)s (a Unix epoch). The
consequence is not cosmetic: 503 in-window pressers collapse onto 44 distinct days, 11.4 events
sharing each stamp, so a news-vs-market lead-lag study against a per-minute Kalshi chain is
unanswerable by construction — the market clock is minutes and the news clock is days. That single
field is what blocked the entire news-coupling line of research.

The collector is fixed going forward. This repairs the rows already captured, fetching metadata
only (no video, no captions), so it is fast and cheap per video.

Resumable: rows that already carry a time component are skipped, and failures are recorded so a
rerun does not retry them forever.

Usage: python3 scripts/line-history/backfill_presser_timestamps.py [--since 2026-08-01] [--limit N]
"""
import argparse
import datetime as dt
import subprocess

from common import connect, log


# Errors that mean "the network was not there", NOT "this video has no timestamp". Recording
# these in the failure table would be a silent catastrophe: the table is permanent and is what
# makes the job resumable, so one DNS blip would burn every remaining row into a do-not-retry
# state and the backfill would report "done" having repaired nothing. A first run did exactly
# that -- 6 of 6 rows failed with "Failed to resolve 'www.youtube.com'" and were recorded as
# final. Transient failures are returned as retryable and are never written down.
TRANSIENT = ("failed to resolve", "temporary failure in name resolution", "nodename nor servname",
             "connection reset", "connection refused", "timed out", "timeout", "network is unreachable",
             "unable to connect", "read operation timed out", "http error 5", "429", "too many requests")


def is_transient(msg):
    m = (msg or "").lower()
    return any(t in m for t in TRANSIENT)


def fetch_epoch(video_id):
    """Return (epoch, error, retryable). retryable=True means DO NOT record the failure."""
    try:
        r = subprocess.run(
            ["yt-dlp", "--no-warnings", "--skip-download", "--print", "%(timestamp)s",
             f"https://www.youtube.com/watch?v={video_id}"],
            capture_output=True, text=True, timeout=90)
        if r.returncode != 0:
            err = (r.stderr or "")[-200:]
            return None, err[-120:], is_transient(err)
        out = r.stdout.strip().splitlines()
        if not out:
            return None, "no output", False
        v = out[-1].strip()
        if not v or v in ("NA", "None"):
            return None, "no timestamp field", False
        return int(float(v)), None, False
    except subprocess.TimeoutExpired:
        return None, "timeout", True
    except Exception as e:  # noqa: BLE001
        return None, str(e)[:120], is_transient(str(e))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-08-01",
                    help="only repair rows published on/after this date (the Kalshi window)")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--all", action="store_true", help="repair every row, not just the window")
    a = ap.parse_args()

    con = connect()
    con.execute("""CREATE TABLE IF NOT EXISTS presser_timestamp_failures (
                     video_id TEXT PRIMARY KEY, reason TEXT, tried_at TEXT)""")

    where = "length(published_at) <= 10"
    params = []
    if not a.all:
        where += " AND substr(published_at,1,10) >= ?"
        params.append(a.since)
    q = (f"""SELECT p.video_id, p.published_at FROM press_conferences_raw p
             LEFT JOIN presser_timestamp_failures f ON f.video_id = p.video_id
             WHERE {where} AND f.video_id IS NULL
             ORDER BY p.published_at DESC""")
    if a.limit:
        q += f" LIMIT {a.limit}"
    rows = con.execute(q, params).fetchall()
    log(f"{len(rows)} rows to repair (date-only, published >= {a.since if not a.all else 'any'})")

    fixed = failed = skipped = 0
    for i, (vid, old) in enumerate(rows, 1):
        epoch, err, retryable = fetch_epoch(vid)
        if epoch is None and retryable:
            skipped += 1
            # the network, not the video. Leave the row alone so a rerun picks it up.
            if skipped >= 8 and fixed == 0:
                log(f"aborting: {skipped} consecutive network failures ({err}). "
                    f"Nothing recorded; rerun when connectivity returns.")
                break
            continue
        skipped = 0
        if epoch is None:
            con.execute("INSERT OR REPLACE INTO presser_timestamp_failures VALUES (?,?,?)",
                        (vid, err, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
            failed += 1
        else:
            iso = dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat(timespec="seconds")
            # sanity: the repaired instant must fall on the date we already had, otherwise the
            # video id and the stored row disagree and overwriting would corrupt the tape
            if old and iso[:10] != old[:10] and abs(
                    (dt.date.fromisoformat(iso[:10]) - dt.date.fromisoformat(old[:10])).days) > 1:
                con.execute("INSERT OR REPLACE INTO presser_timestamp_failures VALUES (?,?,?)",
                            (vid, f"date mismatch {old} vs {iso[:10]}",
                             dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
                failed += 1
            else:
                con.execute("UPDATE press_conferences_raw SET published_at=? WHERE video_id=?",
                            (iso, vid))
                fixed += 1
        if i % 25 == 0:
            con.commit()
            log(f"  {i}/{len(rows)}  fixed={fixed} failed={failed}")
    con.commit()

    have = con.execute(
        "SELECT COUNT(*), SUM(length(published_at) > 10) FROM press_conferences_raw").fetchone()
    log(f"done: fixed {fixed}, failed {failed} (permanent)")
    log(f"press_conferences_raw now {have[1] or 0} of {have[0]} rows with a time component")


if __name__ == "__main__":
    main()
