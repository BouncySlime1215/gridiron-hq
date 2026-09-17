#!/usr/bin/env python3
"""
Backfill per-change NFL line history from covers.com (free, undocumented).

Source: https://www.covers.com/sport/matchupodds/linehistorybrick?gameId=<id>
  One HTML document per game. Three tabs (moneyline, spread, total) x four books
  (bet365, BetVictor, William Hill, Betway). Each book has an OPEN table and a
  change-log table; each change-log row is "Mon D HH:MM" Eastern with the full
  two-sided quote at that instant. Verified 2019-2026 seasons all serve history.

Game ids come from https://www.covers.com/sports/nfl/matchups?selectedDate=YYYY-MM-DD,
which lists one week of games per call.

Usage:
  python3 scripts/line-history/covers_backfill.py --seasons 2019 2020 ... 2026
  python3 scripts/line-history/covers_backfill.py --game-ids 305041 305030   # ad hoc

Resumable: games already in covers_games with fetched_at set are skipped.
Polite: ~1.2 s between requests, backoff on errors.
"""
import argparse
import datetime as dt
import html as htmlmod
import re
import zoneinfo

from common import connect, fetch, log

ET = zoneinfo.ZoneInfo("America/New_York")
MATCHUPS = "https://www.covers.com/sports/nfl/matchups?selectedDate={date}"
BRICK = "https://www.covers.com/sport/matchupodds/linehistorybrick?gameId={gid}"
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
# Order of book tabs on the page (verified against data-book-id table order 1,10,7,14).
BOOK_NAMES = {"1": "bet365", "10": "betvictor", "7": "williamhill", "14": "betway"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS covers_games (
  game_id INTEGER PRIMARY KEY, season INTEGER, game_date TEXT, kickoff_et TEXT,
  away TEXT, home TEXT, away_name TEXT, home_name TEXT,
  fetched_at TEXT, source_bytes INTEGER, rows INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS covers_line_history (
  game_id INTEGER, book_id INTEGER, book TEXT, market TEXT,
  ts_et TEXT, ts_utc TEXT, is_open INTEGER,
  away_line REAL, away_price INTEGER, home_line REAL, home_price INTEGER,
  total_line REAL, over_price INTEGER, under_price INTEGER,
  UNIQUE(game_id, book_id, market, ts_et, away_line, away_price, home_line, home_price, total_line, over_price, under_price));
CREATE INDEX IF NOT EXISTS covers_lh_game ON covers_line_history(game_id, market, book_id, ts_utc);
CREATE TABLE IF NOT EXISTS covers_week_index (season INTEGER, selected_date TEXT, game_ids TEXT, fetched_at TEXT,
  PRIMARY KEY(season, selected_date));
"""


def season_dates(season):
    """Weekly probe dates: every 7 days from Aug 1 of `season` through Feb 20 of season+1."""
    d = dt.date(season, 8, 1)
    end = dt.date(season + 1, 2, 20)
    while d <= end:
        yield d.isoformat()
        d += dt.timedelta(days=7)


def index_week(con, season, date):
    row = con.execute("SELECT game_ids FROM covers_week_index WHERE season=? AND selected_date=?", (season, date)).fetchone()
    if row:
        return [int(x) for x in row[0].split(",") if x]
    st, body = fetch(MATCHUPS.format(date=date), sleep=1.2)
    if st != 200:
        log(f"matchups {date}: http {st}")
        return []
    s = body.decode("utf8", "ignore")
    ids = sorted({int(x) for x in re.findall(r'data-game-id="(\d+)"', s)} | {int(x) for x in re.findall(r"/matchup/(\d+)", s)})
    con.execute("INSERT OR REPLACE INTO covers_week_index VALUES (?,?,?,?)",
                (season, date, ",".join(map(str, ids)), dt.datetime.utcnow().isoformat()))
    con.commit()
    return ids


def price(tok):
    t = tok.upper().replace("EVEN", "+100").replace("EV", "+100")
    m = re.fullmatch(r"([+-]\d+)", t)
    return int(m.group(1)) if m else None


def line(tok):
    t = tok.upper()
    if t in ("PK", "PICK", "0", "+0", "-0"):
        return 0.0
    m = re.fullmatch(r"([+-]?\d+(?:\.\d+)?)", t)
    return float(m.group(1)) if m else None


def cell_text(c):
    c = re.sub(r'<span[^>]*style="display: none;"[^>]*>.*?</span>', "", c, flags=re.S)
    c = re.sub(r"<img[^>]*>", "", c)
    c = re.sub(r'<span class="u-sm-display-none[^"]*">.*?</span>', "", c, flags=re.S)
    return htmlmod.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", c))).strip()


def parse_quote(market, txt):
    toks = txt.split()
    try:
        if market == "moneyline" and len(toks) >= 2:
            return dict(away_price=price(toks[0]), home_price=price(toks[1]))
        if market == "spread" and len(toks) >= 4:
            return dict(away_line=line(toks[0]), away_price=price(toks[1]), home_line=line(toks[2]), home_price=price(toks[3]))
        if market == "total" and len(toks) >= 4:
            o = toks[0].lower().lstrip("o"); u = toks[2].lower().lstrip("u")
            return dict(total_line=line(o), over_price=price(toks[1]), under_price=price(toks[3]))
    except Exception:  # noqa: BLE001
        return None
    return None


def parse_brick(s):
    """Returns (header dict, rows list). Rows are dicts ready for insertion (minus game_id)."""
    hdr_txt = htmlmod.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s[:8000])))
    m = re.search(r"(.+?) ([A-Z]{2,3}) at (.+?) ([A-Z]{2,3}) (\d\d)/(\d\d)/(\d{4}) (\d{1,2}:\d\d [AP]M) ET", hdr_txt)
    if not m:
        return None, []
    away_name, away, home_name, home, mm, dd, yyyy, kick = m.groups()
    game_date = dt.date(int(yyyy), int(mm), int(dd))
    hdr = dict(game_date=game_date.isoformat(), kickoff_et=kick, away=away, home=home, away_name=away_name.strip(), home_name=home_name.strip())

    panes = {k: s.find(f'id="lh-tab-{k}"') for k in ("moneyline", "spread", "total")}
    rows = []
    for tm in re.finditer(r'<table data-book-id="(\d+)"[^>]*>(.*?)</table>', s, re.S):
        book_id = tm.group(1)
        market = max((k for k, pos in panes.items() if 0 <= pos < tm.start()), key=lambda k: panes[k], default=None)
        if market is None:
            continue
        trs = re.findall(r"<tr[^>]*>(.*?)</tr>", tm.group(2), re.S)
        for tr in trs:
            cells = [cell_text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
            if len(cells) < 4 or not cells[0]:
                continue
            when = cells[0]
            q = parse_quote(market, cells[3])
            if not q:
                continue
            is_open = 0
            if when.startswith("OPEN"):
                # OPEN table row carries only a time; the change log's earliest row repeats it with a date. Skip here.
                continue
            wm = re.match(r"([A-Z][a-z]{2}) (\d{1,2}) (\d{1,2}):(\d\d)$", when)
            if not wm:
                continue
            mon, day, hh, mi = MONTHS.get(wm.group(1)), int(wm.group(2)), int(wm.group(3)), int(wm.group(4))
            if not mon:
                continue
            year = game_date.year
            if (mon, day) > (game_date.month, game_date.day):
                # A row dated after the game is either a post-game quote (same year, keep it,
                # it lands after kickoff) or a December move for a January game (previous year).
                same_year_gap = (dt.date(year, mon, day) - game_date).days
                if same_year_gap > 21:
                    year -= 1
            try:
                ts_et = dt.datetime(year, mon, day, hh, mi, tzinfo=ET)
            except ValueError:
                continue
            rows.append(dict(book_id=int(book_id), book=BOOK_NAMES.get(book_id, f"book{book_id}"), market=market,
                             ts_et=ts_et.replace(tzinfo=None).isoformat(timespec="minutes"),
                             ts_utc=ts_et.astimezone(dt.timezone.utc).replace(tzinfo=None).isoformat(timespec="minutes"),
                             is_open=is_open, **q))
    # mark the earliest row per (book, market) as the opener
    first = {}
    for r in rows:
        k = (r["book_id"], r["market"])
        if k not in first or r["ts_utc"] < first[k]:
            first[k] = r["ts_utc"]
    for r in rows:
        if first.get((r["book_id"], r["market"])) == r["ts_utc"]:
            r["is_open"] = 1
    return hdr, rows


def store_game(con, gid, season, hdr, rows, nbytes, note=None):
    con.execute("INSERT OR REPLACE INTO covers_games VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (gid, season, hdr.get("game_date") if hdr else None, hdr.get("kickoff_et") if hdr else None,
                 hdr.get("away") if hdr else None, hdr.get("home") if hdr else None,
                 hdr.get("away_name") if hdr else None, hdr.get("home_name") if hdr else None,
                 dt.datetime.utcnow().isoformat(), nbytes, len(rows), note))
    for r in rows:
        con.execute("""INSERT OR IGNORE INTO covers_line_history
          (game_id, book_id, book, market, ts_et, ts_utc, is_open, away_line, away_price, home_line, home_price, total_line, over_price, under_price)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (gid, r["book_id"], r["book"], r["market"], r["ts_et"], r["ts_utc"], r["is_open"],
                     r.get("away_line"), r.get("away_price"), r.get("home_line"), r.get("home_price"),
                     r.get("total_line"), r.get("over_price"), r.get("under_price")))
    con.commit()


def fetch_game(con, gid, season):
    st, body = fetch(BRICK.format(gid=gid), sleep=1.2)
    if st != 200:
        store_game(con, gid, season, {}, [], len(body), note=f"http {st}")
        return 0
    s = body.decode("utf8", "ignore")
    hdr, rows = parse_brick(s)
    if hdr is None:
        store_game(con, gid, season, {}, [], len(body), note="header parse failed")
        return 0
    store_game(con, gid, season, hdr, rows, len(body))
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="*", type=int, default=list(range(2019, 2027)))
    ap.add_argument("--game-ids", nargs="*", type=int)
    ap.add_argument("--refetch", action="store_true", help="re-download games already stored")
    a = ap.parse_args()
    con = connect()
    con.executescript(SCHEMA)
    done = {r[0] for r in con.execute("SELECT game_id FROM covers_games WHERE fetched_at IS NOT NULL AND note IS NULL")}
    if a.game_ids:
        for gid in a.game_ids:
            log(f"game {gid}: {fetch_game(con, gid, None)} rows")
        return
    for season in a.seasons:
        ids = []
        for date in season_dates(season):
            ids += index_week(con, season, date)
        ids = sorted(set(ids))
        todo = [g for g in ids if a.refetch or g not in done]
        log(f"season {season}: {len(ids)} game ids indexed, {len(todo)} to fetch")
        for i, gid in enumerate(todo, 1):
            n = fetch_game(con, gid, season)
            if i % 25 == 0 or n == 0:
                log(f"  {season} {i}/{len(todo)} game {gid}: {n} rows")
    tot = con.execute("SELECT COUNT(*), COUNT(DISTINCT game_id) FROM covers_line_history").fetchone()
    log(f"done: {tot[0]} rows across {tot[1]} games in {con.execute('PRAGMA database_list').fetchone()[2]}")


if __name__ == "__main__":
    main()
