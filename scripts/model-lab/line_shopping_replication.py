#!/usr/bin/env python3
"""
Replicate the line-shopping result on a second, independent sample.

WHY. The headline measurement of 2026-09-17 was that line shopping is a COST REDUCTION, not an
edge: best-book EV = -1.82% per bet across 561,746 opportunities. But that came from one window
(2026-09-01..09-17), one market (the Odds API tape carries spreads only) and 260 games. A claim
that overturns the project's founding assumption should not rest on a single fortnight.

This re-measures it on Covers: 2019-2025, seven seasons, four books, spreads. Fewer books than the
11-book tape, so the achievable shopping gain is mechanically SMALLER here — that is expected and
is the point of reporting both. The question is not whether the gain is as large, it is whether
best-book EV ever reaches break-even in any season.

METHOD
  For every (game, book) take the CLOSING quote (last change before kickoff). At each game compare:
    best      — the most favourable line, then price, across books, for the side being bet
    consensus — the median line at the median price
    random    — expectation over books, i.e. the mean EV across available books
    worst     — the least favourable
  Both sides of every game are evaluated, so the sample is not biased toward favourites.
  EV per bet = p_win * payout - (1 - p_win), with p_win the REALISED outcome (0/1, pushes voided),
  which makes this a realised-return measurement rather than a modelled one.
  Standard errors cluster by game: the two sides of a game are perfectly dependent.

SIGN CONVENTION. covers home_line is standard betting notation (negative = home laying). A side
covers when side_margin + its_line > 0. nflverse `result` is a margin and is NOT used for lines
here, only for outcomes, so the two conventions never meet.

Usage: python3 scripts/model-lab/line_shopping_replication.py
"""
import math
import os
import sqlite3
import statistics as st
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"
FIX = {"JAC": "JAX", "LA": "LAR"}
MAX_DISPERSION = 3.0   # points; see the data-quality gate below


def payout(price):
    return price / 100 if price > 0 else 100 / -price


def main():
    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=120)
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=120)

    # outcomes, regular season, home teams only (neutral sites excluded: no real home side)
    out = {}
    for season, week, away, home, a_s, h_s in nv.execute(
            """SELECT season, week, away_team, home_team, away_score, home_score
               FROM nfldata_games
               WHERE home_score IS NOT NULL AND season BETWEEN 2019 AND 2025 AND location='Home'"""):
        out[(season, home, away)] = h_s - a_s

    games = {}
    for gid, season, gdate, away, home in arc.execute(
            "SELECT game_id, season, game_date, away, home FROM covers_games WHERE season BETWEEN 2019 AND 2025"):
        games[gid] = (season, FIX.get(home, home), FIX.get(away, away))

    # closing quote per (game, book): the last change row we hold for that book
    close = defaultdict(dict)
    for gid, book, ts, hl, hp, al, ap in arc.execute(
            """SELECT game_id, book, ts_utc, home_line, home_price, away_line, away_price
               FROM covers_line_history
               WHERE market='spread' AND home_line IS NOT NULL AND home_price IS NOT NULL
               ORDER BY ts_utc"""):
        if gid in games:
            close[gid][book] = (hl, hp, al, ap)

    rows, dropped = [], []
    for gid, books in close.items():
        season, home, away = games[gid]
        margin = out.get((season, home, away))
        if margin is None or len(books) < 2:
            continue
        for side in ("home", "away"):
            offers = []
            for b, (hl, hp, al, ap) in books.items():
                line, price = (hl, hp) if side == "home" else (al, ap)
                if line is None or price is None:
                    continue
                sm = margin if side == "home" else -margin
                edge = sm + line
                if edge == 0:
                    continue                       # push: voided, not a win or a loss
                ev = payout(price) if edge > 0 else -1.0
                offers.append((line, price, ev))
            if len(offers) < 2:
                continue
            # DATA-QUALITY GATE. Covers' early seasons carry corrupted spreads: the mean
            # best-worst disagreement across books is 7.97 pts in 2019 (p90 18.5, max 44.0) and
            # 1.32 in 2020, against 0.51-0.90 in 2021-2025. Books do not disagree by eight points
            # on a closing spread. Left in, those rows manufactured a fake +32.6-point shopping
            # "gain" in 2019. Anything above 3 points is a labelling error, not an opportunity.
            dispersion = max(o[0] for o in offers) - min(o[0] for o in offers)
            if dispersion > MAX_DISPERSION:
                dropped.append((season, dispersion))
                continue
            # "best" is chosen on the OFFER (line then price), never on the outcome
            best = max(offers, key=lambda o: (o[0], o[1]))
            worst = min(offers, key=lambda o: (o[0], o[1]))
            med_line = st.median([o[0] for o in offers])
            cons = min(offers, key=lambda o: (abs(o[0] - med_line), -o[1]))
            rows.append(dict(gid=gid, season=season, side=side,
                             best=best[2], worst=worst[2], cons=cons[2],
                             rand=st.mean([o[2] for o in offers]),
                             books=len(offers), spread=best[0] - worst[0]))

    if not rows:
        print("no rows")
        return

    def blk(name, rs):
        byg = defaultdict(lambda: defaultdict(list))
        for r in rs:
            for k in ("best", "cons", "rand", "worst"):
                byg[r["gid"]][k].append(r[k])
        gids = list(byg)
        cells = {}
        for k in ("best", "cons", "rand", "worst"):
            per_game = [st.mean(byg[g][k]) for g in gids]
            m = st.mean(per_game)
            se = st.stdev(per_game) / math.sqrt(len(per_game)) if len(per_game) > 1 else 0
            cells[k] = (100 * m, 100 * se)
        gain = cells["best"][0] - cells["rand"][0]
        print(f"{name:14s} bets={len(rs):6d} games={len(gids):5d} | "
              f"best {cells['best'][0]:+6.2f}% (SE {cells['best'][1]:4.2f}) | "
              f"cons {cells['cons'][0]:+6.2f}% | rand {cells['rand'][0]:+6.2f}% | "
              f"worst {cells['worst'][0]:+6.2f}% | gain {gain:+5.2f}pts")

    from collections import Counter
    dc = Counter(s for s, _ in dropped)
    print(f"dropped {len(dropped)} side-observations above {MAX_DISPERSION}pt dispersion "
          f"(data errors): {dict(sorted(dc.items()))}")
    print(f"books per side: mean {st.mean([r['books'] for r in rows]):.2f}")
    print(f"mean best-worst line spread: {st.mean([r['spread'] for r in rows]):.2f} pts\n")
    print("=" * 118)
    blk("ALL 2019-2025", rows)
    print("-" * 118)
    for s in sorted({r["season"] for r in rows}):
        blk(f"season {s}", [r for r in rows if r["season"] == s])
    print("=" * 118)
    print("\n2026 11-book comparison (oddsapi, spreads, 260 games): best -1.82% | cons -4.88% |"
          " rand -5.05% | worst -8.42% | gain +3.23pts")


if __name__ == "__main__":
    main()
