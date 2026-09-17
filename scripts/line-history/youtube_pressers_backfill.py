#!/usr/bin/env python3
"""
Re-scrape coach and player press conferences from the 32 official team YouTube channels (free, yt-dlp).

The deleted database held 2,455 transcripts from Aug-Sep 2026 only. This goes back to 2021 (or --since),
using yt-dlp to list each channel's uploads without downloading video, keep presser-like titles, and pull
the English auto-captions as text. Team handles are the validated list in server/services/press-conference.js.

Output table in data/line-history/line_history.sqlite:
  press_conferences_raw(video_id, team, title, published_at, duration_s, is_presser, speaker_guess, transcript, chars, fetched_at)

Usage: python3 scripts/line-history/youtube_pressers_backfill.py [--since 2021-01-01] [--teams KC BUF]
Slow by nature (about 2-4 s per video for captions). Resumable per video. Polite: sequential, no bursts.
"""
import argparse
import datetime as dt
import json
import re
import subprocess
import tempfile
from pathlib import Path

from common import connect, log, REPO

PRESSER_RE = re.compile(r"press conference|media availability|speaks (to|with) (the )?media|addresses the media|postgame|pregame|"
                        r"\b(hc|head coach|coach|oc|dc)\b.*\b(on|speaks|talks|previews|recaps)\b|availability|presser|"
                        r"talks (with|to) (the )?media|meets (with )?the media", re.I)


def handles():
    src = (REPO / "server" / "services" / "press-conference.js").read_text()
    block = src.split("TEAM_CHANNEL_HANDLES = Object.freeze({")[1].split("});")[0]
    return dict(re.findall(r"([A-Z]{2,3}):\s*'([^']+)'", block))


def ytdlp(args, timeout=600):
    r = subprocess.run(["yt-dlp", "--no-warnings", *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def list_channel(handle, since):
    # flat entries carry no upload date; channels list newest first, so the caller stops after a run of too-old videos
    code, out, err = ytdlp(["--flat-playlist", "--dump-json", "--playlist-items", "1:3000",
                            f"https://www.youtube.com/@{handle}/videos"], timeout=1800)
    vids = []
    for line in out.splitlines():
        try:
            j = json.loads(line)
        except json.JSONDecodeError:
            continue
        vids.append(dict(video_id=j.get("id"), title=j.get("title") or "", duration=j.get("duration"),
                         upload_date=j.get("upload_date") or j.get("release_date")))
    return vids


def captions(video_id):
    with tempfile.TemporaryDirectory() as td:
        code, out, err = ytdlp(["--skip-download", "--no-simulate", "--write-auto-sub", "--write-sub", "--sub-langs", "en", "--sub-format", "vtt",
                                "--print", "%(upload_date)s|%(duration)s|%(title)s", "-o", f"{td}/%(id)s.%(ext)s",
                                f"https://www.youtube.com/watch?v={video_id}"], timeout=300)
        meta = out.strip().splitlines()[-1] if out.strip() else "||"
        vtt = next(iter(Path(td).glob("*.vtt")), None)
        text = ""
        if vtt:
            seen, chunks = set(), []
            for ln in vtt.read_text(errors="ignore").splitlines():
                if not ln or "-->" in ln or ln.startswith(("WEBVTT", "Kind:", "Language:")) or re.match(r"^\d+$", ln):
                    continue
                ln = re.sub(r"<[^>]+>", "", ln).strip()
                if ln and ln not in seen:
                    seen.add(ln)
                    chunks.append(ln)
            text = " ".join(chunks)
        return meta, text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2021-01-01")
    ap.add_argument("--teams", nargs="*")
    ap.add_argument("--all-titles", action="store_true", help="keep every video, not just presser-like titles")
    a = ap.parse_args()
    con = connect()
    con.executescript("""CREATE TABLE IF NOT EXISTS press_conferences_raw (video_id TEXT PRIMARY KEY, team TEXT, title TEXT, published_at TEXT,
        duration_s INTEGER, is_presser INTEGER, speaker_guess TEXT, transcript TEXT, chars INTEGER, fetched_at TEXT);
        CREATE TABLE IF NOT EXISTS yt_channel_index (team TEXT, video_id TEXT, title TEXT, upload_date TEXT, duration_s INTEGER, listed_at TEXT, PRIMARY KEY(team, video_id));""")
    done = {r[0] for r in con.execute("SELECT video_id FROM press_conferences_raw")}
    hs = handles()
    teams = a.teams or sorted(hs)
    for team in teams:
        h = hs.get(team)
        if not h:
            continue
        vids = list_channel(h, a.since)
        con.executemany("INSERT OR IGNORE INTO yt_channel_index VALUES (?,?,?,?,?,?)",
                        [(team, v["video_id"], v["title"], v["upload_date"], v["duration"], dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")) for v in vids])
        con.commit()
        keep = [v for v in vids if v["video_id"] not in done and (a.all_titles or PRESSER_RE.search(v["title"]))]
        log(f"{team} (@{h}): {len(vids)} videos since {a.since}, {len(keep)} presser-like to fetch")
        too_old = 0
        for i, v in enumerate(keep, 1):
            try:
                meta, text = captions(v["video_id"])
            except Exception as e:  # noqa: BLE001
                log(f"  {team} {v['video_id']} failed: {str(e)[:80]}")
                continue
            up, dur, title = (meta.split("|", 2) + ["", "", ""])[:3]
            pub = f"{up[:4]}-{up[4:6]}-{up[6:8]}" if len(up) == 8 else (v["upload_date"] or "")
            if pub and pub < a.since:
                too_old += 1
                if too_old >= 8:
                    log(f"  {team}: reached videos older than {a.since}, stopping this channel")
                    break
                continue
            too_old = 0
            m = re.match(r"^([A-Z][a-zA-Z'.-]+(?: [A-Z][a-zA-Z'.-]+)+)", title or v["title"])
            con.execute("INSERT OR REPLACE INTO press_conferences_raw VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (v["video_id"], team, title or v["title"], pub, int(float(dur)) if dur and dur != "NA" else v["duration"],
                         1 if PRESSER_RE.search(title or v["title"]) else 0, m.group(1) if m else None, text, len(text),
                         dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
            con.commit()
            if i % 25 == 0:
                log(f"  {team} {i}/{len(keep)}")
    tot = con.execute("SELECT count(*), sum(chars>500), min(published_at), max(published_at) FROM press_conferences_raw").fetchone()
    log(f"done: {tot[0]} videos, {tot[1]} with transcripts, {tot[2]} .. {tot[3]}")


if __name__ == "__main__":
    main()
