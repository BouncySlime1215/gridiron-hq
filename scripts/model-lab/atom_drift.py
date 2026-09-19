#!/usr/bin/env python3
"""
Q26. Have the NFL key-number atoms drifted? Because our own model assumes they have not.

WHY THIS MATTERS MORE THAN IT LOOKS. server/betting/nfl/strategy/margin-distribution.js fits free
atoms at every margin from a POOLED 1999-2024 sample. Everything downstream inherits that: the
Wong teaser break-even of -120.2, the alternate-ladder analysis, every half-point valuation. But
the rules changed underneath it:

    2015  extra point moved from the 2-yard line to the 15 (a 33-yard kick)
    2018  kickoff rules changed (fair catch at the 25 on free kicks, 2024 dynamic kickoff)
    ----  two-point conversion attempts rose steadily as a consequence of the XP move

The XP move is the one with a mechanical prediction: harder extra points mean more missed XPs and
more 2-point tries, which should shift mass between margins that differ by one point -- 6/7/8 in
particular -- and can move 3 if drives that used to end 7-7 now end 7-6.

If the modern atoms differ from the pooled ones, then OUR MODEL IS WRONG FOR THE CURRENT ERA, and
so is anything priced off it. That is worth knowing whether or not it is directly bettable.

WHAT THIS IS NOT. It is not a claim that the market is wrong -- books re-fit continuously. It is
a claim about whether a constant we treat as structural actually is one. The market arm is a
separate question and is reported separately.

METHOD. Empirical P(|margin| = k) per era with Wilson intervals, a chi-square homogeneity test
across eras for each k, and a Cochran-Armitage-style linear trend test so that a monotone drift is
not missed by a chi-square that only sees "different". Multiplicity corrected across all k tested.

Usage: python3 scripts/model-lab/atom_drift.py
"""
import collections
import math
import sqlite3
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"

ERAS = [
    ("1999-2010", 1999, 2010),
    ("2011-2014", 2011, 2014),
    ("2015-2019", 2015, 2019),      # XP moved to the 15 in 2015
    ("2020-2024", 2020, 2024),
    ("2025-2026", 2025, 2026),
]
KS = list(range(0, 15))


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def chi2_sf(x, df):
    """Survival function via Wilson-Hilferty; adequate for df>=2 and the precision needed here."""
    if x <= 0 or df <= 0:
        return 1.0
    t = ((x / df) ** (1 / 3) - (1 - 2 / (9 * df))) / math.sqrt(2 / (9 * df))
    return 0.5 * math.erfc(t / math.sqrt(2))


def norm_sf(z):
    return 0.5 * math.erfc(z / math.sqrt(2))


def benjamini_hochberg(pvals, q=0.10):
    idx = sorted(range(len(pvals)), key=lambda i: pvals[i])
    m = len(pvals)
    crit, kk = 0.0, 0
    for rank, i in enumerate(idx, start=1):
        if pvals[i] <= q * rank / m:
            crit, kk = pvals[i], rank
    return set(idx[:kk]), crit


def main():
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=600)

    # Regular season only, completed games. Playoffs have no ties and different late-game
    # incentives, and preseason is not real football for this purpose.
    rows = nv.execute(
        """SELECT season, home_score, away_score, game_type FROM nfldata_games
           WHERE home_score IS NOT NULL AND away_score IS NOT NULL
             AND season >= 1999""").fetchall()
    by_era = collections.defaultdict(list)
    kept = collections.Counter()
    for season, hs, as_, gt in rows:
        if gt is not None and str(gt).upper() not in ("REG",):
            kept["non-REG dropped"] += 1
            continue
        for name, lo, hi in ERAS:
            if lo <= season <= hi:
                by_era[name].append(abs(hs - as_))
                kept[name] += 1
                break

    print("GAMES PER ERA (regular season, completed)")
    for name, lo, hi in ERAS:
        print(f"   {name}: {len(by_era[name]):,}")
    print(f"   dropped non-REG: {kept['non-REG dropped']:,}")
    total_n = sum(len(v) for v in by_era.values())
    if total_n < 2000:
        print("too few games; check game_type filtering")
        return

    counts = {name: collections.Counter(v) for name, v in by_era.items()}
    ns = {name: len(v) for name, v in by_era.items()}

    # ---- the table -------------------------------------------------------------------------
    print(f"\n{'k':>3s}  " + "  ".join(f"{name:>18s}" for name, _, _ in ERAS))
    print("     " + "  ".join("     pct  [95% CI]" for _ in ERAS))
    for k in KS:
        cells = []
        for name, _, _ in ERAS:
            c, n = counts[name][k], ns[name]
            lo, hi = wilson(c, n)
            cells.append(f"{100*c/n:6.2f} [{100*lo:4.1f},{100*hi:4.1f}]")
        print(f"{k:3d}  " + "  ".join(cells))

    # ---- homogeneity + trend per k ----------------------------------------------------------
    print("\nPER-MARGIN TESTS: is P(|margin|=k) the same across eras?")
    print("  chi2 = homogeneity across 5 eras (4 df); trend = linear drift across eras (1 df,")
    print("  signed: + means the atom is GROWING over time)")
    print(f"\n{'k':>3s} {'chi2':>8s} {'p_homog':>10s} {'trend z':>8s} {'p_trend':>10s}  {'pooled':>7s} {'modern':>7s} {'delta':>7s}")
    tests = []
    for k in KS:
        obs = [counts[name][k] for name, _, _ in ERAS]
        nn = [ns[name] for name, _, _ in ERAS]
        tot_c, tot_n = sum(obs), sum(nn)
        p0 = tot_c / tot_n
        chi = 0.0
        for c, n in zip(obs, nn):
            e1, e0 = n * p0, n * (1 - p0)
            if e1 > 0 and e0 > 0:
                chi += (c - e1) ** 2 / e1 + ((n - c) - e0) ** 2 / e0
        p_hom = chi2_sf(chi, len(ERAS) - 1)

        # Cochran-Armitage linear trend with era index as the score
        scores = list(range(len(ERAS)))
        sbar = sum(s * n for s, n in zip(scores, nn)) / tot_n
        num = sum(n * (s - sbar) * (c / n - p0) for s, c, n in zip(scores, obs, nn))
        den = p0 * (1 - p0) * sum(n * (s - sbar) ** 2 for s, n in zip(scores, nn))
        z = num / math.sqrt(den) if den > 0 else 0.0
        p_tr = 2 * norm_sf(abs(z))

        pooled_pct = 100 * p0
        modern_c = counts["2020-2024"][k] + counts["2025-2026"][k]
        modern_n = ns["2020-2024"] + ns["2025-2026"]
        modern_pct = 100 * modern_c / modern_n if modern_n else 0.0
        tests.append(dict(k=k, chi=chi, p_hom=p_hom, z=z, p_tr=p_tr,
                          pooled=pooled_pct, modern=modern_pct))
        print(f"{k:3d} {chi:8.2f} {p_hom:10.4f} {z:+8.2f} {p_tr:10.4f}  "
              f"{pooled_pct:6.2f}% {modern_pct:6.2f}% {modern_pct-pooled_pct:+6.2f}pp")

    # ---- multiplicity ------------------------------------------------------------------------
    allp = [t["p_hom"] for t in tests] + [t["p_tr"] for t in tests]
    surv, crit = benjamini_hochberg(allp, 0.10)
    bonf = 0.05 / len(allp)
    print(f"\nMULTIPLICITY over {len(allp)} tests ({len(KS)} margins x 2 tests):")
    print(f"   nominal p<0.05: {sum(1 for p in allp if p < 0.05)} "
          f"(expected under a pure null: {0.05*len(allp):.1f})")
    print(f"   Bonferroni threshold {bonf:.2e} -> survivors "
          f"{sum(1 for p in allp if p < bonf)}")
    print(f"   Benjamini-Hochberg q=0.10 critical p {crit:.2e} -> survivors {len(surv)}")

    print("\nSURVIVORS (BH q=0.10):")
    labels = [f"homog k={t['k']}" for t in tests] + [f"trend k={t['k']}" for t in tests]
    if surv:
        for i in sorted(surv, key=lambda i: allp[i]):
            t = tests[i % len(tests)]
            print(f"   {labels[i]:14s} p={allp[i]:.2e}   pooled {t['pooled']:.2f}% -> "
                  f"modern {t['modern']:.2f}%  ({t['modern']-t['pooled']:+.2f}pp)")
    else:
        print("   NONE. The atoms are stable across eras at this sample size.")

    # ---- the key numbers, stated plainly -----------------------------------------------------
    print("\n" + "=" * 78)
    print("THE KEY NUMBERS, ERA BY ERA")
    print("=" * 78)
    for k in (3, 6, 7, 8, 10, 14):
        line = f"  |margin|={k:2d}: "
        for name, _, _ in ERAS:
            c, n = counts[name][k], ns[name]
            line += f"{name} {100*c/n:5.2f}%   "
        t = next(x for x in tests if x["k"] == k)
        line += f"| trend z={t['z']:+.2f}"
        print(line)

    print("\n" + "=" * 78)
    print("WHAT THIS MEANS FOR THE MODEL")
    print("=" * 78)
    t3 = next(x for x in tests if x["k"] == 3)
    t7 = next(x for x in tests if x["k"] == 7)
    print(f"   atom at 3: pooled {t3['pooled']:.2f}% vs modern {t3['modern']:.2f}% "
          f"({t3['modern']-t3['pooled']:+.2f}pp, trend z={t3['z']:+.2f}, p={t3['p_tr']:.4f})")
    print(f"   atom at 7: pooled {t7['pooled']:.2f}% vs modern {t7['modern']:.2f}% "
          f"({t7['modern']-t7['pooled']:+.2f}pp, trend z={t7['z']:+.2f}, p={t7['p_tr']:.4f})")
    print()
    print("   margin-distribution.js fits these POOLED over 1999-2024. If the modern values differ")
    print("   materially, every number priced off that model -- the Wong teaser break-even, the")
    print("   half-point valuations, the alternate-ladder comparison -- is fitted to an era that")
    print("   is partly over. A drift that is statistically real but small in POINTS may still be")
    print("   economically irrelevant: 1pp of atom mass at 3 is worth roughly 1pp of push")
    print("   probability on a 3-point teaser leg, against a break-even margin measured in tenths.")


if __name__ == "__main__":
    main()
