#!/usr/bin/env python3
"""
Rebuild tables the deleted database held that the models still read, from sources we now own.

After the 2026-09-16 deletion the repo database survives but four model inputs are empty.
Two of them can be rebuilt completely and are done here:

  nfl_team_coaches  <- nflverse nfldata_games.home_coach/away_coach (7,548 games, 1999+).
      Complete and better than the 384 rows that were lost, which only went back to 2014.
      The table's primary key is (season, team), so a team that changed coach mid-season is
      represented by whoever coached the most games that year.

  nfl_odds_archive  <- covers_line_history + covers_games (1.9M per-change rows, 4 books,
      2019-2026). Covers flags the opener with is_open, and the last row per
      (game, book, market) is the close, which is exactly the open/close pair the lost table
      held. Fewer books than the original ten, more seasons, and per-change rather than
      two snapshots.

Vocabulary differences that matter and are handled here:
  market  covers 'spread'/'total'/'moneyline' -> models expect 'spreads'/'totals'/'h2h'
  team    covers 'JAC' -> 'JAX', covers 'LA' -> 'LAR'

Writes to server/data.sqlite. Take a backup first (VACUUM INTO); this script does not.
Usage: python3 scripts/line-history/rebuild_lost_tables.py [--only coaches|odds] [--dry-run]
"""
import argparse
import datetime as dt
import sqlite3
from collections import defaultdict

from common import log, REPO

LIVE = REPO / "server/data.sqlite"
ARCHIVE = REPO / "data/line-history/line_history.sqlite"
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"

TEAM_FIX = {"JAC": "JAX", "LA": "LAR"}
MARKET = {"spread": "spreads", "total": "totals", "moneyline": "h2h"}


def fix(t):
    return TEAM_FIX.get(t, t)


def rebuild_coaches(live, dry):
    src = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True)
    counts = defaultdict(int)
    for season, team, coach in src.execute("""
            SELECT season, home_team, home_coach FROM nfldata_games WHERE home_coach IS NOT NULL AND home_coach <> ''
            UNION ALL
            SELECT season, away_team, away_coach FROM nfldata_games WHERE away_coach IS NOT NULL AND away_coach <> ''"""):
        counts[(season, fix(team), coach)] += 1
    best = {}
    for (season, team, coach), n in counts.items():
        k = (season, team)
        if k not in best or n > best[k][1]:
            best[k] = (coach, n)
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    rows = [(s, t, c, n, now) for (s, t), (c, n) in best.items()]
    log(f"coaches: {len(rows)} team-seasons, {min(r[0] for r in rows)}-{max(r[0] for r in rows)}, "
        f"{len({r[2] for r in rows})} distinct coaches")
    if dry:
        return 0
    live.executemany("INSERT OR REPLACE INTO nfl_team_coaches VALUES (?,?,?,?,?)", rows)
    live.commit()
    return len(rows)


def rebuild_odds(live, dry):
    src = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True)
    games = {g[0]: g[1:] for g in src.execute(
        "SELECT game_id, season, game_date, kickoff_et, away, home FROM covers_games")}

    # Week comes from the surviving game_lines. Match on the matchup, not the date: a home/away
    # pair occurs once per season (teams that meet twice do so at different venues), whereas
    # Covers' game_date is an Eastern-time date that disagrees with gameday often enough to have
    # lost the week on 17% of rows -- and all of 2026 -- when matched on date.
    wk, wk_by_date = {}, {}
    for season, team, opp, gameday, week in live.execute(
            "SELECT season, team, opponent, gameday, week FROM game_lines WHERE home=1"):
        wk[(season, team, opp)] = week
        wk_by_date[(season, team, gameday)] = week

    # The opener is the earliest change per (game, book, market). Covers' own is_open flag marks
    # it correctly for most keys, but some carry up to 985 rows flagged is_open=1 -- presumably a
    # re-scrape re-flagging the row -- and openers are the foundation of every CLV number here,
    # so the timestamp decides rather than the flag.
    openers = src.execute("""
        SELECT c.game_id, c.book, c.market, c.ts_utc, c.away_line, c.away_price, c.home_line,
               c.home_price, c.total_line, c.over_price, c.under_price
        FROM covers_line_history c
        JOIN (SELECT game_id, book, market, MIN(ts_utc) mn FROM covers_line_history
              GROUP BY game_id, book, market) m
          ON m.game_id=c.game_id AND m.book=c.book AND m.market=c.market AND m.mn=c.ts_utc""").fetchall()
    # the close is the latest change per (game, book, market)
    closes = src.execute("""
        SELECT c.game_id, c.book, c.market, c.ts_utc, c.away_line, c.away_price, c.home_line,
               c.home_price, c.total_line, c.over_price, c.under_price
        FROM covers_line_history c
        JOIN (SELECT game_id, book, market, MAX(ts_utc) mx FROM covers_line_history
              GROUP BY game_id, book, market) m
          ON m.game_id=c.game_id AND m.book=c.book AND m.market=c.market AND m.mx=c.ts_utc""").fetchall()

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    out, skipped = [], 0
    for phase, batch in (("open", openers), ("close", closes)):
        for (gid, book, market, ts, al, ap, hl, hp, tl, op, up) in batch:
            g = games.get(gid)
            if not g:
                skipped += 1
                continue
            season, gdate, ko, away, home = g
            away, home = fix(away), fix(home)
            mk = MARKET.get(market)
            if not mk:
                continue
            commence = f"{gdate}T{(ko or '13:00')}"
            week = wk.get((season, home, away)) or wk_by_date.get((season, home, gdate))
            base = (gid, season, week, home, away, commence, book, mk)
            if mk == "spreads":
                sides = (("home", hl, hp), ("away", al, ap))
            elif mk == "totals":
                sides = (("over", tl, op), ("under", tl, up))
            else:
                sides = (("home", None, hp), ("away", None, ap))
            for side, line, price in sides:
                if price is None:
                    continue
                out.append(base + (side, phase, line, price, ts, "covers", now))

    # Covers timestamps are minute-resolution, so several rows can tie for earliest. They collapse
    # onto one primary key anyway; pick deterministically (best-priced quote for that side) rather
    # than letting insertion order decide, so a rerun reproduces the same archive.
    dedup = {}
    for r in out:
        key = (r[0], r[6], r[7], r[8], r[9])   # eid, book, market, side, phase
        prev = dedup.get(key)
        if prev is None or (r[11] or -10 ** 6) > (prev[11] or -10 ** 6):
            dedup[key] = r
    out = sorted(dedup.values())

    log(f"odds archive: {len(out)} rows ({len(openers)} opener changes, {len(closes)} closes), "
        f"{skipped} rows with no game record")
    if dry:
        return 0
    live.executemany(
        """INSERT OR REPLACE INTO nfl_odds_archive
           (eid, season, week, home, away, commence_time, book, market, side, phase, line, price,
            book_updated_at, source, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", out)
    live.commit()
    return len(out)


def rebuild_weather(live, dry):
    """nfl_game_weather_forecast_history <- Open-Meteo previous-runs forecasts.

    The point of this table is lead time: what the forecast SAID 1, 3 and 5 days out, not what
    the weather turned out to be. Open-Meteo's previous-runs API serves exactly that, and
    weather_backfill.py already pulled it per stadium-season.

    Kickoff times in game_lines are local, so they are converted with the stadium's own tz from
    nfl_stadiums before matching the UTC forecast hour -- a naive +4h would be wrong for the
    Arizona and international venues and for anything after the November DST change.
    """
    from zoneinfo import ZoneInfo
    src = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True)

    tz = {r[0]: r[1] for r in live.execute("SELECT stadium_id, tz FROM nfl_stadiums WHERE tz IS NOT NULL")}
    venues = []
    for team, sid, cur, first, last in live.execute(
            "SELECT team, stadium_id, is_current, first_game_date, last_game_date FROM nfl_team_stadiums"):
        venues.append((team, sid, cur, first or "0000", last or "9999"))

    def stadium_for(team, day):
        cands = [v for v in venues if v[0] == team and v[3] <= day <= v[4]]
        if not cands:
            cands = [v for v in venues if v[0] == team and v[2]]
        return cands[0][1] if cands else None

    fc = {}
    for sid, ts, lead, temp, wind, gust, precip in src.execute(
            "SELECT stadium_id, ts_utc, lead_days, temp_c, wind_kmh, gust_kmh, precip_mm FROM weather_forecast_hourly"):
        fc[(sid, lead, ts)] = (wind, gust, precip, temp)

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    rows, no_stadium, no_forecast = [], 0, 0
    for season, week, home, gameday, gametime in live.execute(
            """SELECT season, week, team, gameday, gametime FROM game_lines
               WHERE home=1 AND season >= 2022 AND gameday IS NOT NULL"""):
        sid = stadium_for(home, gameday)
        if not sid:
            no_stadium += 1
            continue
        zone = tz.get(sid)
        try:
            local = dt.datetime.fromisoformat(f"{gameday}T{gametime or '13:00'}")
            aware = local.replace(tzinfo=ZoneInfo(zone)) if zone else local.replace(tzinfo=dt.timezone.utc)
            ko_utc = aware.astimezone(dt.timezone.utc)
        except Exception:
            continue
        hour = ko_utc.strftime("%Y-%m-%dT%H:00")
        hit = False
        for lead in (1, 3, 5):
            v = fc.get((sid, lead, hour))
            if not v:
                continue
            hit = True
            rows.append((season, week, home, ko_utc.isoformat(timespec="minutes"), lead,
                         v[0], v[1], v[2], v[3], "open-meteo-previous-runs", now))
        if not hit:
            no_forecast += 1

    log(f"weather forecasts: {len(rows)} rows for {len(rows)//3 if rows else 0} games; "
        f"{no_stadium} games with no venue, {no_forecast} with no forecast hour")
    if dry:
        return 0
    live.executemany(
        """INSERT OR REPLACE INTO nfl_game_weather_forecast_history
           (season, week, home, kickoff, lead_days, wind_kmh, gust_kmh, precip_mm, temp_c, source, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""", rows)
    live.commit()
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["coaches", "odds", "weather"])
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    live = sqlite3.connect(LIVE, timeout=120)
    live.execute("PRAGMA busy_timeout=120000")
    for name, fn in (("coaches", rebuild_coaches), ("odds", rebuild_odds), ("weather", rebuild_weather)):
        if a.only and a.only != name:
            continue
        n = fn(live, a.dry_run)
        log(f"  -> {name}: {n} rows written" + (" (dry run)" if a.dry_run else ""))
    for t in ("nfl_team_coaches", "nfl_odds_archive", "nfl_game_weather_forecast_history"):
        log(f"  {t}: {live.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]:,} rows now")


if __name__ == "__main__":
    main()
