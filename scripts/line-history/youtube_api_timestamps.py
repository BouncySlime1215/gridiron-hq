#!/usr/bin/env python3
"""
Repair presser publication times from YouTube's Data API, which yt-dlp cannot reach.

WHY THIS EXISTS. press_conferences_raw.published_at was stored date-only for all 10,670 rows, which
makes a news-vs-market lead-lag study unanswerable by construction: the market clock is minutes and
the news clock is days. A yt-dlp backfill repaired 482 rows and then hit a wall that is not a bug
and not fixable by retrying:

    2026-09  156 repaired / 0 failed
    2026-08  326 repaired / 21 failed
    2026-07    0 repaired / 59 failed     <- every timestamp field returns NA

YouTube stops exposing an exact publication time to scrapers after roughly six weeks; only
upload_date (a date) survives. The Data API has no such limit -- videos.list(part=snippet) returns
publishedAt as a full RFC-3339 instant for any video, at any age.

COST: ZERO. videos.list costs 1 quota unit per CALL, not per video, and accepts 50 ids per call.
10,670 videos = 214 calls = 214 units against a 10,000/day free allowance, about 2% of one day.
No billing, no card.

The event study this unblocks currently reads t=+1.10 on 482 events -- underpowered, not a null.
At the same effect size the full corpus reaches roughly t=4.9, which is the difference between a
shrug and an answer.

SAFETY. The key is read from the environment only. It is never printed, logged, or written to the
database, and failures are recorded without their query string.

Usage: set -a; . ./.env.local; set +a; python3 scripts/line-history/youtube_api_timestamps.py
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from common import connect, log

API = "https://www.googleapis.com/youtube/v3/videos"
BATCH = 50


def fetch_batch(ids, key):
    """Return {video_id: publishedAt}. One quota unit per call regardless of id count."""
    q = urllib.parse.urlencode({"part": "snippet", "id": ",".join(ids), "key": key})
    req = urllib.request.Request(f"{API}?{q}", headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    out = {}
    for item in data.get("items", []):
        pub = (item.get("snippet") or {}).get("publishedAt")
        if pub:
            out[item["id"]] = pub
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="max videos to repair")
    ap.add_argument("--test", action="store_true", help="one call, one quota unit, then stop")
    a = ap.parse_args()

    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not key or key == "PASTE_KEY_HERE":
        print("YOUTUBE_API_KEY is not set (or is still the placeholder).")
        print("Add it to .env.local, then run:  set -a; . ./.env.local; set +a; python3 <this>")
        sys.exit(1)

    con = connect()
    con.execute("""CREATE TABLE IF NOT EXISTS presser_timestamp_failures (
                     video_id TEXT PRIMARY KEY, reason TEXT, tried_at TEXT)""")

    rows = con.execute(
        """SELECT video_id, published_at FROM press_conferences_raw
           WHERE length(published_at) <= 10 AND video_id IS NOT NULL
           ORDER BY published_at DESC""").fetchall()
    if a.limit:
        rows = rows[:a.limit]
    log(f"{len(rows):,} rows still date-only")
    if not rows:
        log("nothing to repair")
        return
    log(f"{(len(rows) + BATCH - 1) // BATCH} API calls needed "
        f"= {(len(rows) + BATCH - 1) // BATCH} quota units of 10,000/day")

    old_by_id = {v: o for v, o in rows}
    ids = [v for v, _ in rows]
    fixed = missing = mismatch = 0
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    for i in range(0, len(ids), BATCH):
        chunk = ids[i:i + BATCH]
        try:
            got = fetch_batch(chunk, key)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            # never echo the URL back -- it carries the key
            msg = msg.split("?")[0] if "?" in msg else msg
            log(f"  batch {i // BATCH + 1} failed: {msg[:160]}")
            if "403" in msg or "400" in msg:
                log("  a 403/400 usually means the key is not restricted to YouTube Data API v3,")
                log("  or the API is not enabled on the project. Fix that before rerunning.")
                break
            time.sleep(2)
            continue

        for vid in chunk:
            pub = got.get(vid)
            if not pub:
                missing += 1
                con.execute("INSERT OR REPLACE INTO presser_timestamp_failures VALUES (?,?,?)",
                            (vid, "not returned by API (private/deleted)", now))
                continue
            iso = pub.replace("Z", "+00:00")
            old = old_by_id.get(vid) or ""
            # The repaired instant must fall on the date already stored, or the row and the video
            # disagree and overwriting would corrupt the tape. One day of slack for timezone edges.
            try:
                if old and abs((dt.date.fromisoformat(iso[:10])
                                - dt.date.fromisoformat(old[:10])).days) > 1:
                    mismatch += 1
                    con.execute("INSERT OR REPLACE INTO presser_timestamp_failures VALUES (?,?,?)",
                                (vid, f"date mismatch {old[:10]} vs {iso[:10]}", now))
                    continue
            except ValueError:
                pass
            con.execute("UPDATE press_conferences_raw SET published_at=? WHERE video_id=?",
                        (iso, vid))
            fixed += 1

        con.commit()
        done = i + len(chunk)
        if (i // BATCH) % 10 == 0 or done >= len(ids):
            log(f"  {done:,}/{len(ids):,}  fixed={fixed:,} missing={missing} mismatch={mismatch}")
        if a.test:
            log("test mode: stopping after one call")
            break
        time.sleep(0.05)

    con.commit()
    have = con.execute(
        "SELECT COUNT(*), SUM(length(published_at) > 10) FROM press_conferences_raw").fetchone()
    log(f"done: fixed {fixed:,}, missing {missing}, date-mismatch {mismatch}")
    log(f"press_conferences_raw now {have[1] or 0:,} of {have[0]:,} rows with a time component")
    if (have[1] or 0) > 2000:
        log("")
        log("Rerun the event study -- it was underpowered at 482 events (t=+1.10):")
        log("   python3 scripts/model-lab/presser_event_study.py")


if __name__ == "__main__":
    main()
