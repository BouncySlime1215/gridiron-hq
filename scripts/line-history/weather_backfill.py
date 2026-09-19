#!/usr/bin/env python3
"""
Hourly weather at every NFL stadium, 2016 to today, plus what the forecast said before the game (free, Open-Meteo).

  Archive (observed/reanalysis, hourly):
    https://archive-api.open-meteo.com/v1/archive?latitude&longitude&start_date&end_date&hourly=...
  Previous runs (what the model forecast N days earlier for the same hour; this is the pre-game forecast):
    https://previous-runs-api.open-meteo.com/v1/forecast?latitude&longitude&start_date&end_date&hourly=temperature_2m_previous_day1,...

Stadium coordinates come from the repo database's nfl_stadiums (read-only), keyed by the same stadium_id
nflverse games use. One archive request per stadium per season (Aug-Feb), one previous-runs request per
stadium per season for lead days 1, 3 and 5.

Output tables in data/line-history/line_history.sqlite:
  weather_hourly(stadium_id, ts_utc, temp_c, wind_kmh, gust_kmh, wind_dir, precip_mm, rain_mm, snow_cm, humidity, pressure_hpa, cloud_pct)
  weather_forecast_hourly(stadium_id, ts_utc, lead_days, temp_c, wind_kmh, gust_kmh, precip_mm)
Join to games on stadium_id and the kickoff hour (games.gameday + gametime, stadium tz).
"""
import argparse
import datetime as dt
import sqlite3

from common import connect, fetch_json, log, REPO

ARCHIVE = ("https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&start_date={s}&end_date={e}"
           "&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,rain,snowfall,relative_humidity_2m,surface_pressure,cloud_cover&timezone=UTC")
PREV = ("https://previous-runs-api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&start_date={s}&end_date={e}"
        "&hourly={vars}&timezone=UTC")
SCHEMA = """
CREATE TABLE IF NOT EXISTS weather_hourly (stadium_id TEXT, ts_utc TEXT, temp_c REAL, wind_kmh REAL, gust_kmh REAL, wind_dir REAL,
  precip_mm REAL, rain_mm REAL, snow_cm REAL, humidity REAL, pressure_hpa REAL, cloud_pct REAL, PRIMARY KEY(stadium_id, ts_utc)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS weather_forecast_hourly (stadium_id TEXT, ts_utc TEXT, lead_days INTEGER, temp_c REAL, wind_kmh REAL, gust_kmh REAL,
  precip_mm REAL, PRIMARY KEY(stadium_id, ts_utc, lead_days)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS weather_manifest (stadium_id TEXT, season INTEGER, kind TEXT, rows INTEGER, fetched_at TEXT, PRIMARY KEY(stadium_id, season, kind));
CREATE TABLE IF NOT EXISTS stadiums (stadium_id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL, altitude REAL, roof_type TEXT, surface_type TEXT, tz TEXT, city TEXT, state TEXT);
"""


def stadiums(con):
    src = sqlite3.connect(f"file:{REPO / 'server' / 'data.sqlite'}?mode=ro", uri=True)
    rows = src.execute("SELECT stadium_id, name, lat, lon, altitude, roof_type, surface_type, tz, city, state FROM nfl_stadiums WHERE lat IS NOT NULL").fetchall()
    con.executemany("INSERT OR REPLACE INTO stadiums VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="*", type=int, default=list(range(2016, 2027)))
    ap.add_argument("--leads", nargs="*", type=int, default=[1, 3, 5])
    a = ap.parse_args()
    con = connect()
    con.executescript(SCHEMA)
    st = stadiums(con)
    done = {(r[0], r[1], r[2]) for r in con.execute("SELECT stadium_id, season, kind FROM weather_manifest")}
    log(f"{len(st)} stadiums x {len(a.seasons)} seasons")
    today = dt.date.today()
    for sid, name, lat, lon, *_ in st:
        for season in a.seasons:
            s, e = dt.date(season, 8, 1), min(dt.date(season + 1, 2, 20), today - dt.timedelta(days=2))
            if s > e:
                continue
            if (sid, season, "archive") not in done:
                stt, d = fetch_json(ARCHIVE.format(lat=lat, lon=lon, s=s, e=e), sleep=0.4)
                h = (d or {}).get("hourly") or {}
                n = 0
                if h.get("time"):
                    rows = list(zip([sid] * len(h["time"]), h["time"], h["temperature_2m"], h["wind_speed_10m"], h["wind_gusts_10m"], h["wind_direction_10m"],
                                    h["precipitation"], h["rain"], h["snowfall"], h["relative_humidity_2m"], h["surface_pressure"], h["cloud_cover"]))
                    con.executemany("INSERT OR REPLACE INTO weather_hourly VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
                    n = len(rows)
                con.execute("INSERT OR REPLACE INTO weather_manifest VALUES (?,?,?,?,?)", (sid, season, "archive", n, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
                con.commit()
            if (sid, season, "forecast") not in done and season >= 2022:
                vars_ = ",".join(f"{v}_previous_day{L}" for L in a.leads for v in ("temperature_2m", "wind_speed_10m", "wind_gusts_10m", "precipitation"))
                stt, d = fetch_json(PREV.format(lat=lat, lon=lon, s=max(s, dt.date(2022, 1, 1)), e=e, vars=vars_), sleep=0.4)
                h = (d or {}).get("hourly") or {}
                n = 0
                if h.get("time"):
                    for L in a.leads:
                        rows = list(zip([sid] * len(h["time"]), h["time"], [L] * len(h["time"]), h.get(f"temperature_2m_previous_day{L}", []),
                                        h.get(f"wind_speed_10m_previous_day{L}", []), h.get(f"wind_gusts_10m_previous_day{L}", []), h.get(f"precipitation_previous_day{L}", [])))
                        con.executemany("INSERT OR REPLACE INTO weather_forecast_hourly VALUES (?,?,?,?,?,?,?)", rows)
                        n += len(rows)
                con.execute("INSERT OR REPLACE INTO weather_manifest VALUES (?,?,?,?,?)", (sid, season, "forecast", n, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
                con.commit()
        log(f"{sid} {name}: done")
    tot = con.execute("SELECT count(*) FROM weather_hourly").fetchone()[0]
    tof = con.execute("SELECT count(*) FROM weather_forecast_hourly").fetchone()[0]
    log(f"done: {tot} observed hours, {tof} forecast hours")


if __name__ == "__main__":
    main()
