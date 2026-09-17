#!/usr/bin/env python3
"""
Small free extras, one file each, into data/line-history/nflverse.sqlite:

  fivethirtyeight_elo   FiveThirtyEight NFL Elo, 1920-2023 (discontinued): elo, QB-adjusted elo, pregame probabilities,
                        per game. https://projects.fivethirtyeight.com/nfl-api/nfl_elo.csv
  closing_lines_1979_2018  Season game tables from sportsoddshistory (now hosted by covers.com): favorite, score,
                        closing spread with ATS result, closing total with O/U result, back to 1979. Extends the
                        closing-line record 20 seasons before nflverse's 1999 start.
"""
import argparse
import datetime as dt
import html as htmlmod
import io
import os
import re
import sqlite3
import time
import urllib.request
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[2]
DB = Path(os.environ.get("NFLVERSE_DB", REPO / "data" / "line-history" / "nflverse.sqlite"))
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36"}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read()


def elo(con):
    df = pd.read_csv(io.BytesIO(get("https://projects.fivethirtyeight.com/nfl-api/nfl_elo.csv")))
    df["_loaded_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    df.to_sql("fivethirtyeight_elo", con, if_exists="replace", index=False)
    print("fivethirtyeight_elo:", len(df), "rows,", df["season"].min(), "-", df["season"].max())


def soh_season(year):
    s = get(f"https://www.sportsoddshistory.com/nfl-game-season/?y={year}").decode("utf8", "ignore")
    out = []
    for t in re.findall(r"<table[^>]*>(.*?)</table>", s, re.S):
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", t, re.S)
        hdr = [htmlmod.unescape(re.sub(r"<[^>]+>", " ", c)).strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", rows[0], re.S)] if rows else []
        if not hdr or hdr[:2] != ["Day", "Date"]:
            continue
        week = None
        for r in rows[1:]:
            cells = [htmlmod.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", c))).strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.S)]
            if len(cells) < 10:
                continue
            day, date, tm, at1, fav, score, spread, at2, dog, ou = cells[:10]
            notes = cells[10] if len(cells) > 10 else ""
            m = re.match(r"([WLP]?)\s*(-?[\d.]+|PK)", spread)
            sp = 0.0 if m and m.group(2) == "PK" else (float(m.group(2)) if m else None)
            mo = re.match(r"([OUP]?)\s*([\d.]+)", ou)
            out.append(dict(season=year, day=day, date=date, time_et=tm, favorite=fav, fav_home=(at1 == "@"), score=score,
                            fav_result=(m.group(1) if m else None), spread=sp, underdog=dog, dog_home=(at2 == "@"),
                            ou_result=(mo.group(1) if mo else None), total=(float(mo.group(2)) if mo else None), notes=notes))
    return out


def soh(con, years):
    allrows = []
    for y in years:
        rows = soh_season(y)
        allrows += rows
        print(f"  {y}: {len(rows)} games")
        time.sleep(1.0)
    df = pd.DataFrame(allrows)
    df["_loaded_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    df.to_sql("closing_lines_1979_2018", con, if_exists="replace", index=False)
    print("closing_lines_1979_2018:", len(df), "rows")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", nargs="*", type=int, default=list(range(1979, 2019)))
    ap.add_argument("--skip-elo", action="store_true")
    ap.add_argument("--skip-soh", action="store_true")
    a = ap.parse_args()
    con = sqlite3.connect(DB, timeout=120)
    if not a.skip_elo:
        try:
            elo(con)
        except Exception as e:  # noqa: BLE001
            print("elo failed:", str(e)[:120])
    if not a.skip_soh:
        soh(con, a.years)


if __name__ == "__main__":
    main()
