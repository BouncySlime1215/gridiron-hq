#!/usr/bin/env python3
"""
Does the era drift in the key-number atoms change the Wong teaser break-even?

THE CHAIN. atom_drift.py established that the margin distribution is NOT stationary: mass moved
OFF 7 (-1.43pp) and ONTO 6 (+0.85pp, z=+2.56) and 8 (+0.74pp, z=+2.04), with 13 and 10 shrinking
and 2 and 5 growing. Eight of thirty tests survive Benjamini-Hochberg. The mechanism is the 2015
extra-point move: a 33-yard XP is missed often enough, and two-point tries are taken often enough,
that games which used to land on 7 now land on 6 or 8.

WHY THAT MIGHT MATTER HERE AND NOWHERE ELSE. A 6-point teaser on a -7.5 favourite moves the number
to -1.5, so the ticket converts a loss into a win exactly when the margin lands in {2,...,7}. That
window is the SUM of six atoms, four of which drifted. The teaser is therefore the one product
whose value is a direct function of the thing that moved -- unlike a side, whose value depends on
the mean rather than the local mass.

server/betting/nfl/strategy/teaser-leg-rates.js measures the leg rate EMPIRICALLY over 1999-2024
and reports 74.06% pooled against 74.97% for 2018-24. This script asks whether the atom drift
EXPLAINS that gap, and what the break-even looks like if the modern era is the right sample.

THE HONEST FRAME, stated before the numbers. This cannot manufacture an edge. The market re-fits
continuously and has the same public box scores we do. What it can do is tell us whether OUR
pooled model -- and the -120.2 break-even everything has been compared against -- is calibrated to
an era that is partly over. A break-even that moves by a point or two changes which prices are
worth taking; it does not make a bad price good.

METHOD. Compute the teaser window mass directly from settled regular-season games per era, both
for the favourite side (margin in the gained window) and the dog side, with Wilson intervals and a
two-proportion test between the pooled and modern samples. No model, no devig -- counting.

Usage: python3 scripts/model-lab/teaser_era_reprice.py
"""
import collections
import math
import sqlite3
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"

# The module's own window. A 6-point teaser crosses BOTH 3 and 7 only from these lines.
CROSS_BOTH = [-8.5, -8.0, -7.5, -7.0, 1.5, 2.0, 2.5, 3.0]
TEASE = 6.0

ERAS = [("1999-2010", 1999, 2010), ("2011-2014", 2011, 2014), ("2015-2019", 2015, 2019),
        ("2020-2024", 2020, 2024), ("2025-2026", 2025, 2026)]


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def two_prop_z(k1, n1, k2, n2):
    if n1 == 0 or n2 == 0:
        return 0.0, 1.0
    p1, p2 = k1 / n1, k2 / n2
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    if se == 0:
        return 0.0, 1.0
    z = (p1 - p2) / se
    return z, 2 * 0.5 * math.erfc(abs(z) / math.sqrt(2))


def breakeven(price, legs=2):
    b = price / 100 if price > 0 else 100 / -price
    return (1 / (1 + b)) ** (1 / legs)


def main():
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=600)
    rows = nv.execute(
        """SELECT season, home_score, away_score, spread_line, game_type FROM nfldata_games
           WHERE home_score IS NOT NULL AND spread_line IS NOT NULL AND season >= 1999""").fetchall()

    games = []
    for season, hs, as_, sl, gt in rows:
        if gt is not None and str(gt).upper() != "REG":
            continue
        # nflverse spread_line is a MARGIN: positive = home favoured. The teaser module's lines
        # are in SPREAD notation (negative = favoured), so the home spread is -spread_line.
        games.append((season, hs - as_, -float(sl)))
    print(f"regular-season games with a closing spread: {len(games):,}")

    def era_of(s):
        for name, lo, hi in ERAS:
            if lo <= s <= hi:
                return name
        return None

    # ---- the atom window: mass at |margin| in 2..7, which is what a 6-pt tease gains ---------
    print("\n" + "=" * 78)
    print("THE TEASER WINDOW AS RAW ATOM MASS  P(|margin| in 2..7)")
    print("=" * 78)
    print("a 6-point tease on a -7.5 favourite moves the number to -1.5, converting a loss into a")
    print("win exactly when the margin lands in {2..7}. four of those six atoms drifted.\n")
    win_counts = collections.Counter()
    tot_counts = collections.Counter()
    for season, margin, spread in games:
        e = era_of(season)
        if not e:
            continue
        tot_counts[e] += 1
        if 2 <= abs(margin) <= 7:
            win_counts[e] += 1
    for name, _, _ in ERAS:
        c, n = win_counts[name], tot_counts[name]
        lo, hi = wilson(c, n)
        print(f"   {name}: {100*c/n:6.2f}%  [{100*lo:5.2f}, {100*hi:5.2f}]   n={n:,}")
    pooled_c = sum(win_counts[n] for n, _, _ in ERAS)
    pooled_n = sum(tot_counts[n] for n, _, _ in ERAS)
    modern_c = win_counts["2020-2024"] + win_counts["2025-2026"]
    modern_n = tot_counts["2020-2024"] + tot_counts["2025-2026"]
    z, p = two_prop_z(modern_c, modern_n, pooled_c - modern_c, pooled_n - modern_n)
    print(f"\n   pooled {100*pooled_c/pooled_n:.2f}%  vs  modern(2020+) {100*modern_c/modern_n:.2f}%"
          f"   delta {100*(modern_c/modern_n - pooled_c/pooled_n):+.2f}pp   z={z:+.2f}  p={p:.4f}")

    # ---- the actual leg rate, per era, on real Wong-window games -----------------------------
    print("\n" + "=" * 78)
    print("THE ACTUAL WONG LEG RATE, PER ERA")
    print("=" * 78)
    print("every game whose closing spread sits on one of the module's eight CROSS_BOTH_LINES,")
    print("teased 6 points, graded on the settled margin. pushes excluded from the denominator.\n")
    legs = collections.defaultdict(lambda: [0, 0, 0])   # era -> [wins, decided, pushes]
    by_line = collections.defaultdict(lambda: [0, 0])
    for season, margin, spread in games:
        e = era_of(season)
        if not e:
            continue
        for side in ("home", "away"):
            line = spread if side == "home" else -spread
            if line not in CROSS_BOTH:
                continue
            teased = line + TEASE
            # the side covers the teased number when its own margin beats -teased
            m = margin if side == "home" else -margin
            diff = m + teased
            if abs(diff) < 1e-9:
                legs[e][2] += 1
                by_line[line][1] += 0
                continue
            legs[e][1] += 1
            by_line[line][1] += 1
            if diff > 0:
                legs[e][0] += 1
                by_line[line][0] += 1

    for name, _, _ in ERAS:
        w, d, pu = legs[name]
        if d == 0:
            print(f"   {name}: no decided legs")
            continue
        lo, hi = wilson(w, d)
        print(f"   {name}: {100*w/d:6.2f}%  [{100*lo:5.2f}, {100*hi:5.2f}]   "
              f"n={d:,} decided ({pu} pushes)")
    pw = sum(legs[n][0] for n, _, _ in ERAS)
    pd = sum(legs[n][1] for n, _, _ in ERAS)
    mw = legs["2020-2024"][0] + legs["2025-2026"][0]
    md = legs["2020-2024"][1] + legs["2025-2026"][1]
    zz, pp = two_prop_z(mw, md, pw - mw, pd - md)
    print(f"\n   pooled {100*pw/pd:.2f}% (n={pd:,})  vs  modern {100*mw/md:.2f}% (n={md:,})"
          f"   delta {100*(mw/md - pw/pd):+.2f}pp   z={zz:+.2f}  p={pp:.4f}")

    print(f"\n   per line (pooled):")
    for line in CROSS_BOTH:
        w, d = by_line[line]
        if d >= 20:
            lo, hi = wilson(w, d)
            print(f"      {line:+5.1f}: {100*w/d:6.2f}%  [{100*lo:5.2f}, {100*hi:5.2f}]  n={d:,}")

    # ---- break-even ---------------------------------------------------------------------------
    print("\n" + "=" * 78)
    print("BREAK-EVEN: WHAT PRICE DOES EACH SAMPLE SUPPORT?")
    print("=" * 78)
    print("2-team 6-point teaser, stake-back pushes, treating legs as independent (the module's")
    print("measured pair correlation is rho=-0.044 with a bootstrap CI that INCLUDES ZERO).\n")
    print(f"   {'price':>7s} {'need/leg':>9s}   {'pooled':>18s}   {'modern':>18s}")
    for price in (-105, -110, -115, -120, -125, -130):
        need = breakeven(price, 2)
        p_pool = pw / pd
        p_mod = mw / md
        se_pool = math.sqrt(p_pool * (1 - p_pool) / pd)
        se_mod = math.sqrt(p_mod * (1 - p_mod) / md)
        d_pool = (p_pool - need) / se_pool
        d_mod = (p_mod - need) / se_mod
        print(f"   {price:>7d} {100*need:8.2f}%   {100*(p_pool-need):+7.2f}pp ({d_pool:+5.2f} SE)   "
              f"{100*(p_mod-need):+7.2f}pp ({d_mod:+5.2f} SE)")

    print("\n" + "=" * 78)
    print("READ THIS BEFORE ACTING")
    print("=" * 78)
    print("   The market re-fits continuously on the same public box scores. A drift we can see is")
    print("   a drift books can see, so this does NOT create an edge -- it tells us whether OUR")
    print("   pooled model, and the -120.2 break-even everything has been measured against, is")
    print("   calibrated to an era that is partly over. Treat the modern column as the honest")
    print("   sample and the pooled column as contaminated by pre-2015 football.")
    print("   The binding constraint remains a price nobody has recorded: nfl_teaser_price_ledger")
    print("   has zero rows and teaser-scan.js gates on reachable=1.")


if __name__ == "__main__":
    main()
