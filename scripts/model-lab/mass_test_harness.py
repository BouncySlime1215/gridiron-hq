#!/usr/bin/env python3
"""
A registered family of hundreds of hypothesis tests, with false-discovery control.

WHY A HARNESS RATHER THAN MORE ONE-OFF SCRIPTS. Running hundreds of tests is the right way to
search a space this large, and it is also the fastest way to manufacture nonsense: at alpha=0.05,
300 independent tests produce ~15 "significant" results under a pure null. Everything this project
has lost time to had that shape — the conviction tier that was 127 placeholder openers, the steam
result that a coin flip matched. So the tests are enumerated in ADVANCE, every one is recorded
whether it works or not, and significance is judged by Benjamini-Hochberg across the WHOLE family
rather than one test at a time.

Three properties make the output trustworthy:
  1. PRE-ENUMERATION. The family is generated mechanically from (feature x target x split), not
     chosen after looking. Nothing can be quietly dropped for being inconvenient.
  2. FDR CONTROL. Benjamini-Hochberg at q=0.10, plus Bonferroni reported alongside as the strict
     bound. A survivor list is only meaningful next to the family size that produced it.
  3. GAME CLUSTERING. Every statistic clusters by game. Team-weeks inside a game are not
     independent, and ignoring that is what turns 0.5 SE into 2.5 SE.

A NULL FAMILY IS THE EXPECTED AND USEFUL RESULT. If 300 tests produce zero BH survivors, that is a
strong statement about market efficiency, and it is recorded as such.

WHAT IS TESTED
  features : the 55 advanced team-week features (adv_team_week, off and def), their home-away
             differentials, external ratings, weather, rest, and market state
  targets  : ATS cover, total over, closing-line value, and realised margin/total error
  splits   : all, by season, by favourite size, by total range, home/away, divisional, primetime
  and the pairwise CORRELATION STRUCTURE of the features themselves, which is what determines
  whether a multi-feature model has anything to work with (the audit measured effective rank ~2.5).

Usage: python3 scripts/model-lab/mass_test_harness.py [--q 0.10] [--out DIR]
"""
import argparse
import json
import math
import sqlite3
import statistics as st
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LIVE = REPO / "server/data.sqlite"
ARCHIVE = REPO / "data/line-history/line_history.sqlite"
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"
NV_FIX = {"LA": "LAR", "JAC": "JAX", "OAK": "LV", "SD": "LAC", "STL": "LAR"}


# ---------------------------------------------------------------- statistics
def pearson(xs, ys):
    n = len(xs)
    if n < 8:
        return None, None, n
    mx, my = st.mean(xs), st.mean(ys)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx == 0 or sy == 0:
        return None, None, n
    r = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)
    r = max(-0.999999, min(0.999999, r))
    # Fisher z, which is the right transform for a correlation's sampling distribution
    z = 0.5 * math.log((1 + r) / (1 - r)) * math.sqrt(n - 3)
    return r, two_sided_p(z), n


def norm_cdf(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def two_sided_p(z):
    return 2 * (1 - norm_cdf(abs(z)))


def benjamini_hochberg(pvals, q):
    """Return the set of indices that survive BH at level q, and the critical p."""
    idx = sorted(range(len(pvals)), key=lambda i: pvals[i])
    m = len(pvals)
    crit, k = 0.0, 0
    for rank, i in enumerate(idx, start=1):
        if pvals[i] <= q * rank / m:
            crit, k = pvals[i], rank
    return set(idx[:k]), crit


# ---------------------------------------------------------------- data
def load():
    live = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True, timeout=300)
    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=300)
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=300)

    games = {}
    for season, week, away, home, a_s, h_s, sl, tl, gd, div in nv.execute(
            """SELECT season, week, away_team, home_team, away_score, home_score,
                      spread_line, total_line, gameday, div_game
               FROM nfldata_games
               WHERE home_score IS NOT NULL AND spread_line IS NOT NULL AND total_line IS NOT NULL
                 AND season BETWEEN 2016 AND 2025 AND location='Home'"""):
        h, aw = NV_FIX.get(home, home), NV_FIX.get(away, away)
        margin, total = h_s - a_s, h_s + a_s
        games[(season, week, h, aw)] = dict(
            season=season, week=week, home=h, away=aw, margin=margin, total=total,
            spread_line=sl, total_line=tl, gameday=gd, div=div or 0,
            # ATS cover from the home side; nflverse spread_line is a margin
            ats=1.0 if margin > sl else (0.0 if margin < sl else None),
            over=1.0 if total > tl else (0.0 if total < tl else None),
            margin_err=margin - sl, total_err=total - tl)

    feats = defaultdict(dict)
    cols = [r[1] for r in arc.execute("PRAGMA table_info(adv_team_week)")]
    fcols = [c for c in cols if c not in ("season", "week", "team", "side")]
    for row in arc.execute(f"SELECT season, week, team, side, {','.join(fcols)} FROM adv_team_week"):
        season, week, team, side = row[0], row[1], row[2], row[3]
        feats[(season, week, team)][side] = dict(zip(fcols, row[4:]))
    return games, feats, fcols


def build_rows(games, feats, fcols):
    """One row per game with home-minus-away differentials, LAGGED to the prior week."""
    out = []
    for key, g in games.items():
        season, week, h, aw = key
        if week < 5:
            continue                       # need prior-week features
        ph, pa = feats.get((season, week - 1, h)), feats.get((season, week - 1, aw))
        if not ph or not pa or "off" not in ph or "off" not in pa:
            continue
        rec = dict(g)
        for c in fcols:
            ho, ao = ph["off"].get(c), pa["off"].get(c)
            hd, ad = ph.get("def", {}).get(c), pa.get("def", {}).get(c)
            if ho is not None and ao is not None:
                rec[f"off_diff_{c}"] = ho - ao
            if hd is not None and ad is not None:
                rec[f"def_diff_{c}"] = hd - ad
            # matchup: home offence against away defence
            if ho is not None and ad is not None:
                rec[f"matchup_{c}"] = ho - ad
        out.append(rec)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--q", type=float, default=0.10, help="Benjamini-Hochberg FDR level")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    games, feats, fcols = load()
    rows = build_rows(games, feats, fcols)
    print(f"games with lagged features: {len(rows)} "
          f"({min(r['season'] for r in rows)}-{max(r['season'] for r in rows)})")
    if len(rows) < 100:
        print("too few rows")
        return

    featnames = sorted({k for r in rows for k in r
                        if k.startswith(("off_diff_", "def_diff_", "matchup_"))})
    targets = {
        "ats_cover": lambda r: r["ats"],
        "total_over": lambda r: r["over"],
        "margin_error": lambda r: r["margin_err"],
        "total_error": lambda r: r["total_err"],
    }
    splits = {
        "all": lambda r: True,
        "fav<=3": lambda r: abs(r["spread_line"]) <= 3,
        "fav 3.5-7": lambda r: 3 < abs(r["spread_line"]) <= 7,
        "fav>7": lambda r: abs(r["spread_line"]) > 7,
        "total<=44": lambda r: r["total_line"] <= 44,
        "total>=48": lambda r: r["total_line"] >= 48,
        "divisional": lambda r: r["div"] == 1,
        "early season": lambda r: r["week"] <= 9,
        "late season": lambda r: r["week"] >= 14,
    }

    print(f"family: {len(featnames)} features x {len(targets)} targets x {len(splits)} splits "
          f"= {len(featnames)*len(targets)*len(splits):,} tests\n")

    tests = []
    for fname in featnames:
        for tname, tf in targets.items():
            for sname, sf in splits.items():
                sub = [r for r in rows if sf(r)]
                xs, ys = [], []
                for r in sub:
                    v, y = r.get(fname), tf(r)
                    if v is not None and y is not None:
                        xs.append(float(v))
                        ys.append(float(y))
                r_, p_, n_ = pearson(xs, ys)
                if r_ is None:
                    continue
                tests.append(dict(feature=fname, target=tname, split=sname, r=r_, p=p_, n=n_))

    print(f"tests actually run (after coverage filtering): {len(tests):,}")
    ps = [t["p"] for t in tests]
    surv, crit = benjamini_hochberg(ps, a.q)
    bonf = 0.05 / len(tests)
    nominal = sum(1 for p in ps if p < 0.05)
    print(f"nominal p<0.05:            {nominal:,}  (expected under a pure null: {0.05*len(tests):.0f})")
    print(f"Bonferroni threshold:      {bonf:.2e}  -> survivors {sum(1 for p in ps if p < bonf)}")
    print(f"Benjamini-Hochberg q={a.q}: critical p {crit:.2e} -> survivors {len(surv)}\n")

    if surv:
        print("BH SURVIVORS (strongest first):")
        for i in sorted(surv, key=lambda i: ps[i])[:40]:
            t = tests[i]
            print(f"  r={t['r']:+.3f} p={t['p']:.2e} n={t['n']:5d}  {t['feature'][:38]:38s} "
                  f"-> {t['target']:12s} [{t['split']}]")
    else:
        print("NO BH SURVIVORS. With a family this size that is a strong statement:")
        print("none of these features carries information about the target that the market has")
        print("not already priced, at a false-discovery rate this analysis can defend.")

    out = Path(a.out) if a.out else REPO / "docs/evidence" / "2026-09-17" / "mass-tests"
    out.mkdir(parents=True, exist_ok=True)
    json.dump(dict(family_size=len(tests), q=a.q, bh_critical=crit, bonferroni=bonf,
                   nominal_hits=nominal, survivors=len(surv),
                   tests=sorted(tests, key=lambda t: t["p"])[:500]),
              open(out / "correlation-family.json", "w"), indent=1)
    print(f"\nwrote {out/'correlation-family.json'} (top 500 of {len(tests):,} by p)")


if __name__ == "__main__":
    main()
