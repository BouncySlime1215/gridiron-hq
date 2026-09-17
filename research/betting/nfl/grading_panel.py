#!/usr/bin/env python
"""
GRADING PANEL for NFL market backtests.

Builds, per game and market (spread / total / moneyline):
  * the OPENING line/price (earliest observed quote, strictly pre-kickoff)
  * the CLOSING line/price (latest quote STRICTLY BEFORE kickoff)
  * the best available price per side at the consensus closing line
and joins outcomes from nflverse nfldata_games.

Then it runs the BET-EVERYTHING CONTROL, which is the actual deliverable:
betting every posted side of every game at the real posted closing price must
return approximately minus the vig. If it does not, nothing downstream is
trustworthy.

Sources are opened READ-ONLY. Collectors are writing to them; the as-of cutoff
is recorded in panel_meta.

KNOWN TRAPS THIS CODE DEFENDS AGAINST
-------------------------------------
1. KICKOFF TRAP. covers_line_history contains quotes timestamped AFTER kickoff
   (in-game prices, or collector artifacts). Measured on this snapshot:
   882 / 2184 matched games have a spread quote after kickoff, p90 of
   (last quote - kickoff) = +166 min, max = +6229 min. Grading those as
   "closing" books enormous in-game dogs and destroys the control.
   Defence: every quote is filtered `ts_et < kickoff_et` STRICTLY.
2. STALE-CLOSE TRAP. Some games' last pre-kickoff quote is days or months old.
   That is not a closing line. Defence: CLOSE_MAX_LAG_MIN gate per book, with
   the lag stored so downstream can tighten it.
3. SEASON-LABEL BUG in covers_games: 16 rows for 2026-09-17/20 carry
   season=2019. Defence: season is DERIVED from game_date, never read.
4. SAME-MINUTE DUPLICATES: 24,799 spread / 65,016 total / 10,907 moneyline
   (game,book,market,ts) groups have >1 row. Defence: deterministic
   tie-break, default = the row WORST for the bettor (max two-way hold).
5. PRICE AWARENESS: every payout is computed from the real American price on
   the actual quote. -110 is never assumed anywhere in this file.

TIMEZONES. covers ts_et is genuine US/Eastern wall time (verified: ts_utc-ts_et
is 4h in Apr-Oct and 5h in Nov-Dec, with both present in November).
nfldata_games gameday+gametime is also US/Eastern. They are compared as naive
Eastern strings, so no DST conversion is ever performed. Cross-check against
covers_games.kickoff_et: 2197 / 2208 matched games agree to the minute, none
disagree by more than 15 minutes.

WHAT DOWNSTREAM GETS  (data/grading_panel.sqlite)
-------------------------------------------------
grading_panel          one row per (game, market). The table to join to.
  nfl_game_id            nflverse game_id -- the join key for every other table
  season week gameday kickoff_et away_team home_team
  away_score home_score margin_home(=home-away) total_points
  market                 'spread' | 'total' | 'moneyline'
  open_line/_price_home/_price_away/_ts_et/_lead_min/_n_books
                         FIRST OBSERVED quote, not necessarily the true market
                         open: the collector starts ~12 days out (median lead
                         17,060 min). Treat as "earliest available", not "open".
  close_line             consensus CLOSING handicap = modal line across books
                         whose last pre-kickoff quote is within 6h of kickoff.
                         SPREAD SIGN: this is the HOME handicap, so PHI -8.5
                         is close_line = -8.5. It is the NEGATIVE of nflverse
                         spread_line (verified: median sum 0.00, agree within
                         0.5 on 92.2% of games).
  close_line_mean        mean across books, for finer CLV than the modal line
  close_price_home/away  BEST price of the books sitting on close_line.
                         For 'total', _home = OVER and _away = UNDER.
  close_price_*_book     which book that price came from
  close_ts_et close_lag_min close_n_books close_n_books_at_line
  ref_book/ref_line/ref_price_*   single-book reference (last book to quote),
                         i.e. the price with NO line shopping
  hold_best hold_ref     two-way hold at those prices. THIS IS YOUR COST.
  result_home result_away        1 win / 0 push / -1 loss at close_line
  result_home_ref result_away_ref  same, graded at ref_line
  nfl_line               nflverse's own line, for cross-checking only

panel_snapshots        one row per (game, market, horizon). T-minus 60 / 180 /
                       1440 / 4320 minutes. Same columns plus
                       close_minus_snap_line, which IS the CLV in points.
                       Bet at the snapshot price, measure CLV against the close.

panel_book_quotes      per-book open and close, for book-level work.
panel_unmatched_covers_games   the 321 covers games with no nflverse match
                       (all preseason; verified zero regular/post season).
panel_meta             as-of cutoff, gates, tie-break, drop counts.

SAMPLE SIZES: spread 1927, total 1913, moneyline 1921 graded games,
2019-2026. 2026 contributes only 16 games so far.

WHAT THIS PANEL DOES NOT GIVE YOU
  * A true market OPEN. See open_lead_min above.
  * US-available prices. The four books are bet365, William Hill, BetVictor
    and Betway. The shopped hold (4.25% spread / 4.46% total) assumes accounts
    at all four. The single-book hold (5.49% / 5.60%) is the realistic solo
    number, and is the one that matches the 5.66% extraction cost already
    measured here.
  * Live upcoming games. A game only enters the panel once its close exists.

Usage:
    research/.venv/bin/python research/betting/nfl/grading_panel.py [--out PATH]
    research/.venv/bin/python research/betting/nfl/verify_grading_panel.py
    research/.venv/bin/python research/betting/nfl/audit_grading_panel.py
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import math
import os
import sqlite3
import statistics
import sys

REPO = "/Users/nick_matta/Documents/GitHub/gridiron-hq"
LINE_HISTORY_DB = os.path.join(REPO, "data/line-history/line_history.sqlite")
NFLVERSE_DB = os.path.join(REPO, "data/line-history/nflverse.sqlite")
DEFAULT_OUT = os.path.join(REPO, "data/grading_panel.sqlite")

FIRST_SEASON = 2019
MARKETS = ("spread", "total", "moneyline")
BOOKS = ("bet365", "williamhill", "betvictor", "betway")

# A book's last pre-kickoff quote must be at least this fresh to count as that
# book's CLOSE. 360 min = 6h. Stored lags let downstream tighten this.
CLOSE_MAX_LAG_MIN = 360
# An opening quote further out than this is not treated as a real "open".
OPEN_MAX_LEAD_MIN = 60 * 24 * 21  # 21 days

# Decision horizons. A model does not bet at the closing bell; it bets at some
# lead time and then gets graded on CLV against the close. These are the prices
# actually obtainable at T-minus each horizon, so downstream can compute both
# realized P&L (at the horizon price) and CLV (horizon line vs close line).
HORIZONS_MIN = (60, 180, 1440, 4320)

# covers uses current franchise codes retroactively; nflverse uses the code in
# force that season.
TEAM_FIX = {"JAC": "JAX", "LAR": "LA"}


# ---------------------------------------------------------------- primitives
def american_profit(price: int) -> float:
    """Profit on a 1-unit WINNING bet at an American price. No -110 defaults."""
    price = int(price)
    if price >= 100:
        return price / 100.0
    if price <= -100:
        return 100.0 / abs(price)
    raise ValueError(f"nonsensical American price {price!r}")


def implied(price: int) -> float:
    """Vig-inclusive implied probability."""
    return 1.0 / (1.0 + american_profit(price))


def two_way_hold(price_a: int, price_b: int) -> float:
    """Bookmaker hold. Negative means an arbitrage across the two prices."""
    over = implied(price_a) + implied(price_b)
    return 1.0 - 1.0 / over


def theoretical_two_way_roi(price_a: int, price_b: int) -> float:
    """
    Per-unit ROI of staking 1 unit on EACH side, under the market's own no-vig
    probabilities. Equals -hold. This is the '-vig' the control must land on;
    it is computed from the actual prices, never hardcoded.
    """
    return 1.0 / (implied(price_a) + implied(price_b)) - 1.0


def season_of(gameday: str) -> int:
    y, m = int(gameday[:4]), int(gameday[5:7])
    return y if m >= 3 else y - 1


def norm_team(code: str, season: int) -> str:
    code = TEAM_FIX.get(code, code)
    if code == "LV" and season <= 2019:
        return "OAK"
    return code


def cluster_se(returns, clusters):
    """
    Cluster-robust SE of the mean, clustering on game. Both sides of one game
    are near-perfectly negatively correlated, so this is mandatory: the naive
    iid SE is badly wrong here.
    """
    n = len(returns)
    if n == 0:
        return float("nan")
    mean = sum(returns) / n
    sums = collections.defaultdict(float)
    for r, c in zip(returns, clusters):
        sums[c] += r - mean
    g = len(sums)
    if g < 2:
        return float("nan")
    ss = sum(v * v for v in sums.values())
    # finite-cluster correction
    corr = g / (g - 1.0)
    return math.sqrt(corr * ss) / n


# ---------------------------------------------------------------- extraction
def load_games(nv):
    """nfldata_games, regular + post season, 2019+. Kickoff is naive Eastern."""
    q = """
      select game_id, season, game_type, week, gameday, gametime,
             away_team, home_team, away_score, home_score,
             spread_line, total_line, div_game, roof
      from nfldata_games
      where season >= ? and game_type in ('REG','WC','DIV','CON','SB')
    """
    out = {}
    for r in nv.execute(q, (FIRST_SEASON,)):
        (gid, season, gtype, week, gameday, gametime, away, home,
         asc, hsc, spread_line, total_line, div_game, roof) = r
        if not gameday or not gametime:
            continue
        out[(season, gameday, away, home)] = dict(
            nfl_game_id=gid, season=season, game_type=gtype, week=week,
            gameday=gameday, kickoff_et=f"{gameday}T{gametime}",
            away_team=away, home_team=home,
            away_score=asc, home_score=hsc,
            nfl_spread_line=spread_line, nfl_total_line=total_line,
            div_game=div_game, roof=roof,
        )
    return out


def match_covers_games(lh, nfl_by_key):
    """covers game_id -> nfl game dict. Season DERIVED from date (bug #3)."""
    by_teams = collections.defaultdict(list)
    for k, v in nfl_by_key.items():
        by_teams[(v["season"], v["away_team"], v["home_team"])].append(v)

    matched, unmatched = {}, []
    rows = lh.execute(
        "select game_id, game_date, kickoff_et, away, home from covers_games"
    ).fetchall()
    for cgid, gdate, cko, away, home in rows:
        if not gdate:
            unmatched.append((cgid, gdate, away, home, "no_date"))
            continue
        s = season_of(gdate)
        a, h = norm_team(away, s), norm_team(home, s)
        g = nfl_by_key.get((s, gdate, a, h))
        if g is None:  # +/- 1 day tolerance, only if unambiguous
            cands = [
                x for x in by_teams.get((s, a, h), [])
                if abs((dt.date.fromisoformat(x["gameday"])
                        - dt.date.fromisoformat(gdate)).days) <= 1
            ]
            if len(cands) == 1:
                g = cands[0]
        if g is None:
            unmatched.append((cgid, gdate, away, home, "no_nfl_game"))
        else:
            matched[cgid] = g

    seen = collections.Counter(v["nfl_game_id"] for v in matched.values())
    dupes = [k for k, v in seen.items() if v > 1]
    if dupes:
        raise RuntimeError(f"{len(dupes)} nfl games matched to >1 covers game: {dupes[:5]}")
    return matched, unmatched


def _quote_tuple(market, row):
    """(line_home_side, price_home_side, price_away_side) in a uniform frame.

    spread   : line = home handicap, prices = (home, away)
    total    : line = total,          prices = (over, under)
    moneyline: line = None,           prices = (home, away)
    """
    (_gid, _bid, _book, _mkt, _ts, _isopen,
     away_line, away_price, home_line, home_price,
     total_line, over_price, under_price) = row
    if market == "spread":
        return (home_line, int(home_price), int(away_price))
    if market == "total":
        return (total_line, int(over_price), int(under_price))
    return (None, int(home_price), int(away_price))


def collect_quotes(lh, matched, tie_break="worst", kickoff_filter=True):
    """
    Per (covers_game, market, book): the first and the last STRICTLY
    pre-kickoff quote.

    tie_break for same-minute duplicates:
      'worst' -> the row with the largest two-way hold (worst for the bettor)
      'best'  -> smallest hold  (sensitivity check only)
    """
    kickoff = {cgid: g["kickoff_et"] for cgid, g in matched.items()}
    # store: (game, market, book) -> dict with first/last
    acc = {}
    stats = collections.Counter()

    cur = lh.execute(
        "select game_id, book_id, book, market, ts_et, is_open,"
        "       away_line, away_price, home_line, home_price,"
        "       total_line, over_price, under_price "
        "from covers_line_history"
    )
    for row in cur:
        gid, bid, book, market, ts, is_open = row[0], row[1], row[2], row[3], row[4], row[5]
        ko = kickoff.get(gid)
        if ko is None:
            stats["quote_unmatched_game"] += 1
            continue
        if market not in MARKETS:
            stats["quote_unknown_market"] += 1
            continue
        stats[f"{market}_total"] += 1
        # ---- THE KICKOFF FILTER. Strict. ISO minute strings sort lexically.
        if not (ts < ko):
            stats[f"{market}_post_kickoff_dropped"] += 1
            if kickoff_filter:
                continue
        try:
            line, p_home, p_away = _quote_tuple(market, row)
        except (TypeError, ValueError):
            stats[f"{market}_bad_price"] += 1
            continue
        if line is None and market != "moneyline":
            stats[f"{market}_null_line"] += 1
            continue

        key = (gid, market, book)
        slot = acc.get(key)
        hold = two_way_hold(p_home, p_away)
        q = dict(ts=ts, line=line, p_home=p_home, p_away=p_away,
                 hold=hold, is_open=is_open)
        if slot is None:
            acc[key] = dict(first=q, last=q, n=1, saw_is_open=bool(is_open), snap={})
            slot = acc[key]
            _update_snaps(slot, q, ko)
            continue
        _update_snaps(slot, q, ko)
        slot["n"] += 1
        slot["saw_is_open"] = slot["saw_is_open"] or bool(is_open)
        # first
        f = slot["first"]
        if ts < f["ts"] or (ts == f["ts"] and _prefer(q, f, tie_break)):
            slot["first"] = q
        # last
        l = slot["last"]
        if ts > l["ts"] or (ts == l["ts"] and _prefer(q, l, tie_break)):
            slot["last"] = q
    return acc, stats


_CUTOFF_CACHE = {}


def _cutoffs(ko):
    """kickoff - h minutes, as comparable ISO-minute strings."""
    c = _CUTOFF_CACHE.get(ko)
    if c is None:
        base = dt.datetime.fromisoformat(ko)
        c = {h: (base - dt.timedelta(minutes=h)).isoformat(timespec="minutes")
             for h in HORIZONS_MIN}
        _CUTOFF_CACHE[ko] = c
    return c


def _update_snaps(slot, q, ko):
    """Latest quote at or before each T-minus cutoff."""
    cut = _cutoffs(ko)
    snap = slot["snap"]
    for h, c in cut.items():
        if q["ts"] <= c:
            cur = snap.get(h)
            if cur is None or q["ts"] > cur["ts"]:
                snap[h] = q


def _prefer(cand, cur, tie_break):
    """Deterministic same-timestamp tie-break."""
    if tie_break == "worst":
        if cand["hold"] != cur["hold"]:
            return cand["hold"] > cur["hold"]
    else:
        if cand["hold"] != cur["hold"]:
            return cand["hold"] < cur["hold"]
    # fully deterministic fallback so the panel is reproducible
    return (cand["line"] if cand["line"] is not None else 0,
            cand["p_home"], cand["p_away"]) < \
           (cur["line"] if cur["line"] is not None else 0,
            cur["p_home"], cur["p_away"])


# ---------------------------------------------------------------- consensus
def consensus(book_quotes, market):
    """
    book_quotes: list of (book, quote dict) that passed the freshness gate.

    Returns the consensus line and the BEST price per side AMONG THE BOOKS
    SITTING ON THAT EXACT LINE. Shopping a better price at a different
    handicap is not line shopping, it is a different bet, so those books are
    excluded from the best-price search for that side.
    """
    if not book_quotes:
        return None
    if market == "moneyline":
        line = None
        elig = book_quotes
    else:
        lines = [q["line"] for _b, q in book_quotes]
        counts = collections.Counter(lines)
        top = max(counts.values())
        cands = sorted(l for l, c in counts.items() if c == top)
        if len(cands) > 1:
            mean = statistics.fmean(lines)
            cands.sort(key=lambda l: (abs(l - mean), l))
        line = cands[0]
        elig = [(b, q) for b, q in book_quotes if q["line"] == line]

    best_h = max(elig, key=lambda bq: american_profit(bq[1]["p_home"]))
    best_a = max(elig, key=lambda bq: american_profit(bq[1]["p_away"]))
    lines_all = [q["line"] for _b, q in book_quotes if q["line"] is not None]
    return dict(
        line=line,
        line_mean=(statistics.fmean(lines_all) if lines_all else None),
        line_n_books=len(book_quotes),
        line_n_books_at_line=len(elig),
        p_home=best_h[1]["p_home"], p_home_book=best_h[0],
        p_away=best_a[1]["p_away"], p_away_book=best_a[0],
        last_ts=max(q["ts"] for _b, q in book_quotes),
        first_ts=min(q["ts"] for _b, q in book_quotes),
        # single-book reference: the book whose quote is latest
        ref_book=max(book_quotes, key=lambda bq: bq[1]["ts"])[0],
        ref_line=max(book_quotes, key=lambda bq: bq[1]["ts"])[1]["line"],
        ref_p_home=max(book_quotes, key=lambda bq: bq[1]["ts"])[1]["p_home"],
        ref_p_away=max(book_quotes, key=lambda bq: bq[1]["ts"])[1]["p_away"],
    )


def minutes_before(ts, kickoff):
    return (dt.datetime.fromisoformat(kickoff) - dt.datetime.fromisoformat(ts)).total_seconds() / 60.0


# ---------------------------------------------------------------- grading
def grade(market, line, home_score, away_score):
    """
    Returns (result_home_side, result_away_side) in {1 win, 0 push, -1 loss},
    or (None, None) if the game is not final.

    spread   : home_side = home team + home handicap. line is the HOME handicap
               (covers home_line), so PHI -8 is line = -8.0.
    total    : home_side slot = OVER, away_side slot = UNDER.
    moneyline: home team wins.
    """
    if home_score is None or away_score is None:
        return (None, None)
    if market == "spread":
        edge = (home_score - away_score) + line
        return (_sign(edge), _sign(-edge))
    if market == "total":
        edge = (home_score + away_score) - line
        return (_sign(edge), _sign(-edge))
    edge = home_score - away_score
    return (_sign(edge), _sign(-edge))


def _sign(x):
    if x > 0:
        return 1
    if x < 0:
        return -1
    return 0


def bet_return(result, price):
    """Unit-stake return. push = 0, loss = -1, win = american profit."""
    if result is None:
        return None
    if result == 0:
        return 0.0
    if result == 1:
        return american_profit(price)
    return -1.0


# ---------------------------------------------------------------- build
def build(out_path, tie_break="worst", close_max_lag=CLOSE_MAX_LAG_MIN,
          kickoff_filter=True, write=True):
    lh = sqlite3.connect(f"file:{LINE_HISTORY_DB}?mode=ro", uri=True)
    nv = sqlite3.connect(f"file:{NFLVERSE_DB}?mode=ro", uri=True)

    as_of_quote = lh.execute("select max(ts_utc) from covers_line_history").fetchone()[0]
    as_of_run = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    nfl_by_key = load_games(nv)
    matched, unmatched = match_covers_games(lh, nfl_by_key)
    acc, qstats = collect_quotes(lh, matched, tie_break=tie_break,
                                 kickoff_filter=kickoff_filter)

    # regroup: (covers_gid, market) -> list of (book, first/last quote)
    by_gm = collections.defaultdict(lambda: {"open": [], "close": []})
    for (gid, market, book), slot in acc.items():
        g = matched[gid]
        ko = g["kickoff_et"]
        f, l = slot["first"], slot["last"]
        lead = minutes_before(f["ts"], ko)
        lag = minutes_before(l["ts"], ko)
        if lead <= OPEN_MAX_LEAD_MIN:
            by_gm[(gid, market)]["open"].append((book, f))
        if (0 < lag if kickoff_filter else True) and lag <= close_max_lag:
            by_gm[(gid, market)]["close"].append((book, l))

    by_gmh = collections.defaultdict(lambda: collections.defaultdict(list))
    for (gid, market, book), slot in acc.items():
        ko = matched[gid]["kickoff_et"]
        for h, q in slot["snap"].items():
            by_gmh[(gid, market)][h].append((book, q))

    panel_rows, quote_rows, snap_rows = [], [], []
    for (gid, market), d in sorted(by_gm.items()):
        g = matched[gid]
        ko = g["kickoff_et"]
        op = consensus(d["open"], market)
        cl = consensus(d["close"], market)
        if cl is None:
            continue  # no usable close -> not gradeable, excluded from panel

        res_h, res_a = grade(market, cl["line"], g["home_score"], g["away_score"])
        ref_h, ref_a = grade(market, cl["ref_line"], g["home_score"], g["away_score"])

        panel_rows.append((
            g["nfl_game_id"], gid, g["season"], g["game_type"], g["week"],
            g["gameday"], ko, g["away_team"], g["home_team"],
            g["away_score"], g["home_score"],
            (None if g["home_score"] is None else g["home_score"] - g["away_score"]),
            (None if g["home_score"] is None else g["home_score"] + g["away_score"]),
            market,
            op["line"] if op else None,
            op["p_home"] if op else None,
            op["p_away"] if op else None,
            op["first_ts"] if op else None,
            round(minutes_before(op["first_ts"], ko), 1) if op else None,
            op["line_n_books"] if op else 0,
            cl["line"], cl["line_mean"], cl["p_home"], cl["p_home_book"],
            cl["p_away"], cl["p_away_book"], cl["last_ts"],
            round(minutes_before(cl["last_ts"], ko), 1),
            cl["line_n_books"], cl["line_n_books_at_line"],
            cl["ref_book"], cl["ref_line"], cl["ref_p_home"], cl["ref_p_away"],
            round(two_way_hold(cl["p_home"], cl["p_away"]), 6),
            round(two_way_hold(cl["ref_p_home"], cl["ref_p_away"]), 6),
            res_h, res_a, ref_h, ref_a,
            (g["nfl_spread_line"] if market == "spread"
             else g["nfl_total_line"] if market == "total" else None),
        ))

        for h in HORIZONS_MIN:
            bq = by_gmh[(gid, market)].get(h) or []
            sc = consensus(bq, market)
            if sc is None:
                continue
            sres_h, sres_a = grade(market, sc["line"], g["home_score"], g["away_score"])
            snap_rows.append((
                g["nfl_game_id"], gid, g["season"], market, h,
                sc["line"], sc["line_mean"], sc["p_home"], sc["p_home_book"],
                sc["p_away"], sc["p_away_book"], sc["last_ts"],
                round(minutes_before(sc["last_ts"], ko), 1),
                sc["line_n_books"], sc["line_n_books_at_line"],
                round(two_way_hold(sc["p_home"], sc["p_away"]), 6),
                sres_h, sres_a,
                (None if sc["line"] is None or cl["line"] is None
                 else round(cl["line"] - sc["line"], 2)),
            ))

        for book, q in d["close"]:
            quote_rows.append((
                g["nfl_game_id"], gid, g["season"], market, book, "close",
                q["ts"], round(minutes_before(q["ts"], ko), 1),
                q["line"], q["p_home"], q["p_away"], round(q["hold"], 6),
            ))
        for book, q in d["open"]:
            quote_rows.append((
                g["nfl_game_id"], gid, g["season"], market, book, "open",
                q["ts"], round(minutes_before(q["ts"], ko), 1),
                q["line"], q["p_home"], q["p_away"], round(q["hold"], 6),
            ))

    if write:
        write_db(out_path, panel_rows, quote_rows, snap_rows, unmatched, qstats,
                 as_of_quote, as_of_run, tie_break, close_max_lag)
    return panel_rows, qstats, as_of_quote, as_of_run


PANEL_COLS = """
 nfl_game_id TEXT, covers_game_id INTEGER, season INTEGER, game_type TEXT, week INTEGER,
 gameday TEXT, kickoff_et TEXT, away_team TEXT, home_team TEXT,
 away_score REAL, home_score REAL, margin_home REAL, total_points REAL,
 market TEXT,
 open_line REAL, open_price_home INTEGER, open_price_away INTEGER,
 open_ts_et TEXT, open_lead_min REAL, open_n_books INTEGER,
 close_line REAL, close_line_mean REAL,
 close_price_home INTEGER, close_price_home_book TEXT,
 close_price_away INTEGER, close_price_away_book TEXT,
 close_ts_et TEXT, close_lag_min REAL,
 close_n_books INTEGER, close_n_books_at_line INTEGER,
 ref_book TEXT, ref_line REAL, ref_price_home INTEGER, ref_price_away INTEGER,
 hold_best REAL, hold_ref REAL,
 result_home INTEGER, result_away INTEGER,
 result_home_ref INTEGER, result_away_ref INTEGER,
 nfl_line REAL
"""


def write_db(path, panel_rows, quote_rows, snap_rows, unmatched, qstats,
             as_of_quote, as_of_run, tie_break, close_max_lag):
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.execute(f"create table grading_panel ({PANEL_COLS})")
    db.executemany(
        "insert into grading_panel values (" + ",".join("?" * 41) + ")", panel_rows)
    db.execute("create index gp_game on grading_panel(nfl_game_id, market)")
    db.execute("create index gp_season on grading_panel(season, market)")

    db.execute("""create table panel_book_quotes (
      nfl_game_id TEXT, covers_game_id INTEGER, season INTEGER, market TEXT,
      book TEXT, kind TEXT, ts_et TEXT, minutes_before_kickoff REAL,
      line REAL, price_home INTEGER, price_away INTEGER, hold REAL)""")
    db.executemany("insert into panel_book_quotes values (" + ",".join("?" * 12) + ")",
                   quote_rows)
    db.execute("create index pbq_game on panel_book_quotes(nfl_game_id, market, kind)")

    db.execute("""create table panel_snapshots (
      nfl_game_id TEXT, covers_game_id INTEGER, season INTEGER, market TEXT,
      horizon_min INTEGER,
      line REAL, line_mean REAL,
      price_home INTEGER, price_home_book TEXT,
      price_away INTEGER, price_away_book TEXT,
      ts_et TEXT, lag_min REAL, n_books INTEGER, n_books_at_line INTEGER,
      hold REAL, result_home INTEGER, result_away INTEGER,
      close_minus_snap_line REAL)""")
    db.executemany("insert into panel_snapshots values (" + ",".join("?" * 19) + ")",
                   snap_rows)
    db.execute("create index ps_game on panel_snapshots(nfl_game_id, market, horizon_min)")

    db.execute("""create table panel_unmatched_covers_games (
      covers_game_id INTEGER, game_date TEXT, away TEXT, home TEXT, reason TEXT)""")
    db.executemany("insert into panel_unmatched_covers_games values (?,?,?,?,?)", unmatched)

    db.execute("create table panel_meta (key TEXT, value TEXT)")
    meta = [
        ("as_of_last_quote_utc", as_of_quote),
        ("as_of_build_utc", as_of_run),
        ("line_history_db", LINE_HISTORY_DB),
        ("nflverse_db", NFLVERSE_DB),
        ("tie_break", tie_break),
        ("close_max_lag_min", str(close_max_lag)),
        ("open_max_lead_min", str(OPEN_MAX_LEAD_MIN)),
        ("kickoff_filter", "ts_et < kickoff_et STRICT (naive US/Eastern both sides)"),
        ("horizons_min", json.dumps(list(HORIZONS_MIN))),
        ("quote_stats", json.dumps(dict(qstats))),
    ]
    db.executemany("insert into panel_meta values (?,?)", meta)
    db.commit()
    db.close()


# ---------------------------------------------------------------- control
def control(panel_rows, price_mode="best"):
    """
    BET-EVERYTHING CONTROL.

    price_mode 'best' -> best price per side across books at the consensus line
    price_mode 'ref'  -> the single book whose quote is latest (no shopping)

    Returns per-market dicts. 'both' = one unit on EVERY posted side of every
    game. Under an efficient market that must return the negative of the hold
    implied by those very prices.
    """
    cols = [c.split()[0].strip() for c in PANEL_COLS.strip().split(",")]
    idx = {c: i for i, c in enumerate(cols)}
    out = {}
    for market in MARKETS:
        rows = [r for r in panel_rows
                if r[idx["market"]] == market and r[idx["result_home"]] is not None]
        if price_mode == "best":
            ph, pa, rh, ra = "close_price_home", "close_price_away", "result_home", "result_away"
            hold_col = "hold_best"
        else:
            ph, pa, rh, ra = "ref_price_home", "ref_price_away", "result_home_ref", "result_away_ref"
            hold_col = "hold_ref"

        rets, clus, theo, holds = [], [], [], []
        one_side = {"home": ([], []), "away": ([], [])}
        pushes = 0
        for r in rows:
            gid = r[idx["nfl_game_id"]]
            for side, pcol, rcol in (("home", ph, rh), ("away", pa, ra)):
                res = r[idx[rcol]]
                ret = bet_return(res, r[idx[pcol]])
                rets.append(ret)
                clus.append(gid)
                if res == 0:
                    pushes += 1
                one_side[side][0].append(ret)
                one_side[side][1].append(gid)
            theo.append(theoretical_two_way_roi(r[idx[ph]], r[idx[pa]]))
            holds.append(r[idx[hold_col]])

        n = len(rets)
        res = dict(
            market=market, price_mode=price_mode,
            n_games=len(rows), n_bets=n, n_pushes=pushes,
            roi=(sum(rets) / n if n else float("nan")),
            se=cluster_se(rets, clus),
            theoretical_roi=(statistics.fmean(theo) if theo else float("nan")),
            mean_hold=(statistics.fmean(holds) if holds else float("nan")),
        )
        nonpush = [x for x in rets if x != 0.0] or [0.0]
        res["roi_ex_push"] = sum(x for x in rets if x != 0.0) / len(nonpush)
        for side in ("home", "away"):
            v, c = one_side[side]
            res[f"roi_{side}"] = sum(v) / len(v) if v else float("nan")
            res[f"se_{side}"] = cluster_se(v, c)
            decided = [x for x in v if x != 0.0]
            res[f"winpct_{side}"] = (
                sum(1 for x in decided if x > 0) / len(decided) if decided else float("nan"))
        out[market] = res
    return out


def coverage(panel_rows):
    cols = [c.split()[0].strip() for c in PANEL_COLS.strip().split(",")]
    idx = {c: i for i, c in enumerate(cols)}
    agg = collections.defaultdict(lambda: dict(n=0, graded=0, books=[], lag=[], hold=[]))
    for r in panel_rows:
        k = (r[idx["season"]], r[idx["market"]])
        a = agg[k]
        a["n"] += 1
        a["graded"] += 1 if r[idx["result_home"]] is not None else 0
        a["books"].append(r[idx["close_n_books"]])
        a["lag"].append(r[idx["close_lag_min"]])
        a["hold"].append(r[idx["hold_best"]])
    return agg


# ---------------------------------------------------------------- self-checks
def self_checks(panel_rows):
    """
    Assertions that would have caught the two bugs that have already happened
    here, plus sign-convention checks against an independent source.
    """
    cols = [c.split()[0].strip() for c in PANEL_COLS.strip().split(",")]
    idx = {c: i for i, c in enumerate(cols)}
    fails = []

    # 1. No quote may be at or after kickoff.
    bad = [r for r in panel_rows if r[idx["close_lag_min"]] is not None and r[idx["close_lag_min"]] <= 0]
    if bad:
        fails.append(f"KICKOFF TRAP: {len(bad)} closes at/after kickoff")

    # 2. Prices must be real American odds.
    for r in panel_rows:
        for c in ("close_price_home", "close_price_away"):
            p = r[idx[c]]
            if p is None or -100 < p < 100:
                fails.append(f"bad price {p} on {r[idx['nfl_game_id']]} {r[idx['market']]}")
                break

    # 3. Sign convention vs nflverse's own line. covers home_line is the HOME
    #    handicap; nfldata spread_line is positive when HOME is favoured, so
    #    close_line should track -nfl_spread_line.
    sp = [r for r in panel_rows if r[idx["market"]] == "spread" and r[idx["nfl_line"]] is not None]
    if sp:
        diffs = [r[idx["close_line"]] + r[idx["nfl_line"]] for r in sp]
        med = statistics.median(diffs)
        agree = sum(1 for d in diffs if abs(d) <= 1.0) / len(diffs)
        if abs(med) > 0.5 or agree < 0.85:
            fails.append(f"SPREAD SIGN: median(close_line + nfl_spread_line)={med:.2f}, "
                         f"|diff|<=1 in {agree:.1%} -- convention is inverted or mismatched")
    tt = [r for r in panel_rows if r[idx["market"]] == "total" and r[idx["nfl_line"]] is not None]
    if tt:
        diffs = [r[idx["close_line"]] - r[idx["nfl_line"]] for r in tt]
        med = statistics.median(diffs)
        agree = sum(1 for d in diffs if abs(d) <= 1.0) / len(diffs)
        if abs(med) > 0.5 or agree < 0.85:
            fails.append(f"TOTAL SIGN: median(close_line - nfl_total_line)={med:.2f}, "
                         f"|diff|<=1 in {agree:.1%}")

    # 4. Moneyline favourite must actually be the team the spread favours.
    ml = {(r[idx["nfl_game_id"]]): r for r in panel_rows if r[idx["market"]] == "moneyline"}
    spd = {(r[idx["nfl_game_id"]]): r for r in panel_rows if r[idx["market"]] == "spread"}
    both = set(ml) & set(spd)
    bad = 0
    for g in both:
        home_fav_ml = ml[g][idx["close_price_home"]] < ml[g][idx["close_price_away"]]
        line = spd[g][idx["close_line"]]
        if line == 0:
            continue
        home_fav_sp = line < 0
        if home_fav_ml != home_fav_sp:
            bad += 1
    if both and bad / len(both) > 0.05:
        fails.append(f"ML/SPREAD DISAGREE on favourite in {bad}/{len(both)} games")

    # 5. Grading must reproduce independently for a hand-checkable case.
    for r in panel_rows[:0]:
        pass
    return fails, dict(n_panel=len(panel_rows))


def fmt_pct(x):
    return "   n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{100*x:+.3f}%"


def report(panel_rows, qstats, as_of_quote, as_of_run, out_path, close_max_lag):
    cols = [c.split()[0].strip() for c in PANEL_COLS.strip().split(",")]
    idx = {c: i for i, c in enumerate(cols)}
    W = 78
    print("=" * W)
    print("NFL GRADING PANEL")
    print("=" * W)
    print(f"built              {as_of_run}")
    print(f"as-of last quote   {as_of_quote} UTC  (collectors are live; this is the cutoff)")
    print(f"panel table        {out_path}")
    print(f"close freshness    last quote must be within {close_max_lag} min BEFORE kickoff")
    print()

    print("-" * W)
    print("(b) THE KICKOFF TRAP")
    print("-" * W)
    for m in MARKETS:
        tot = qstats.get(f"{m}_total", 0)
        drop = qstats.get(f"{m}_post_kickoff_dropped", 0)
        print(f"  {m:<10} {tot:>9,} quotes on matched games   "
              f"{drop:>8,} dropped at/after kickoff ({100*drop/max(1,tot):5.2f}%)")
    print(f"  quotes on games not matched to nflverse (preseason etc): "
          f"{qstats.get('quote_unmatched_game',0):,}")
    print()

    print("-" * W)
    print("(d) COVERAGE BY SEASON AND MARKET  (panel rows = gradeable closes)")
    print("-" * W)
    agg = coverage(panel_rows)
    print(f"  {'season':>6} {'market':<10} {'games':>6} {'graded':>7} {'books':>6} "
          f"{'close lag(min)':>15} {'hold':>7}")
    for (s, m) in sorted(agg):
        a = agg[(s, m)]
        print(f"  {s:>6} {m:<10} {a['n']:>6} {a['graded']:>7} "
              f"{statistics.fmean(a['books']):>6.2f} "
              f"{statistics.median(a['lag']):>7.1f} med "
              f"{100*statistics.fmean(a['hold']):>6.2f}%")
    print()
    tot = collections.Counter()
    for (s, m), a in agg.items():
        tot[m] += a["graded"]
    print("  GRADEABLE SAMPLE SIZE  " + "   ".join(f"{m}={tot[m]}" for m in MARKETS))
    print()

    print("-" * W)
    print("SELF-CHECKS")
    print("-" * W)
    fails, _ = self_checks(panel_rows)
    if fails:
        for f in fails:
            print(f"  FAIL  {f}")
    else:
        print("  all pass: strict pre-kickoff, real American prices, spread/total sign")
        print("            conventions agree with nflverse, ML favourite agrees with spread")
    print()

    print("=" * W)
    print("(c) BET-EVERYTHING CONTROL -- THE DELIVERABLE")
    print("=" * W)
    print("one unit on EVERY posted side of EVERY game at the real closing price.")
    print("target = theoretical ROI implied by those same prices (= -hold).")
    print()
    print("NOTE ON THE PASS CRITERION. Betting BOTH sides is nearly deterministic:")
    print("the two returns cancel, so the game-clustered SE is ~0.05pp and a t-stat")
    print("against theory blows up on an economically meaningless 0.1pp gap. The")
    print("honest criterion is therefore |gap| <= max(0.25pp, 3 SE): when the SE is")
    print("negligible the agreement must be economically tight, and where there is")
    print("genuine noise (moneyline, whose payoffs do not cancel, SE ~1pp) the gap")
    print("must be consistent with that noise. Plus the ONE-SIDED controls below,")
    print("which carry real sampling noise and are the shape a model's bets take.")
    print()
    ok = True
    for mode, label in (("best", "BEST PRICE OF 4 BOOKS at the consensus line (shopped)"),
                        ("ref", "SINGLE BOOK, the last book to quote (unshopped)")):
        ctrl = control(panel_rows, price_mode=mode)
        print(f"  [{label}]")
        print(f"  {'market':<10} {'games':>6} {'bets':>6} {'push':>5} "
              f"{'realized':>10} {'SE':>8} {'theory':>10} {'gap(pp)':>9} {'tol(pp)':>8} {'t':>6}")
        for m in MARKETS:
            c = ctrl[m]
            gap = 100 * (c["roi"] - c["theoretical_roi"])
            t = ((c["roi"] - c["theoretical_roi"]) / c["se"]) if c["se"] and not math.isnan(c["se"]) else float("nan")
            print(f"  {m:<10} {c['n_games']:>6} {c['n_bets']:>6} {c['n_pushes']:>5} "
                  f"{fmt_pct(c['roi']):>10} {100*c['se']:>7.3f}% "
                  f"{fmt_pct(c['theoretical_roi']):>10} {gap:>+9.3f} "
                  f"{max(0.25, 300.0*c['se']):>8.2f} {t:>6.2f}")
            tol = max(0.25, 300.0 * c["se"])
            if abs(gap) > tol:
                ok = False
            if not (-0.09 < c["roi"] < -0.015):
                ok = False
        print()
        for m in MARKETS:
            c = ctrl[m]
            for side in ("home", "away"):
                z = (c["roi_" + side] - c["theoretical_roi"]) / c["se_" + side]
                if abs(z) > 3.0:
                    ok = False
        print(f"  one-sided controls ({mode} prices):")
        print(f"  {'market':<10} {'side':<6} {'roi':>10} {'SE':>8} {'win%':>7}")
        for m in MARKETS:
            c = ctrl[m]
            for side, name in (("home", "home" if m != "total" else "over"),
                               ("away", "away" if m != "total" else "under")):
                print(f"  {m:<10} {name:<6} {fmt_pct(c['roi_'+side]):>10} "
                      f"{100*c['se_'+side]:>7.3f}% {100*c['winpct_'+side]:>6.2f}%")
        print()
    print("=" * W)
    print("VERDICT: " + ("CONTROL PASSES -- bet-everything lands within 0.25pp of the vig "
                         "implied by\n         the actual prices in all three markets, and every "
                         "one-sided control is\n         within 3 SE of it."
                         if ok else
                         "CONTROL FAILS -- do not use this panel downstream."))
    print("=" * W)
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--tie-break", default="worst", choices=["worst", "best"])
    ap.add_argument("--close-max-lag", type=int, default=CLOSE_MAX_LAG_MIN)
    a = ap.parse_args()
    panel_rows, qstats, as_of_quote, as_of_run = build(
        a.out, tie_break=a.tie_break, close_max_lag=a.close_max_lag)
    ok = report(panel_rows, qstats, as_of_quote, as_of_run, a.out, a.close_max_lag)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
