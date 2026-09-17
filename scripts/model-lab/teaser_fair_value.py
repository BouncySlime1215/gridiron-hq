#!/usr/bin/env python3
"""
Price NFL teasers from Pinnacle's own alternate-line ladder. The market answers, not a backtest.

THE QUESTION THIS SETTLES. Two independent lines of evidence point at Wong teasers — 6-point
2-team teasers crossing both 3 and 7 (favourites -7.5/-8.5 down to -1.5/-2.5, dogs +1.5/+2.5 up to
+7.5/+8.5):

  * A backtest here: 74.69% per leg on 1,391 legs, 1999-2025, no decay across three eras
    (73.26% -> 75.41% -> 75.46%). Break-even is 72.37% at -110 and 73.85% at -120.
  * The repo's own MARGIN_MODEL_VERDICT, independently: favourites at -7 to -8.5 beat their number
    by 1.04 points (z=+2.36) and underdogs at +1.5 to +3 by 0.85 points (z=+2.84) — the exact Wong
    window — against a board that is otherwise linear and efficient (chi-square 31.2, p=0.18).

Both are historical. The blocker was always that we hold NO teaser price data, so "74.69% beats
-110 but loses to -120" could not be resolved.

THE INSIGHT. A teaser leg IS an alternate line. Teasing a -7.5 favourite down six points is exactly
a bet at -1.5, and Pinnacle's public API publishes that price. So the sharpest book in the market
already tells us what each teased leg is worth, right now, with no model and no history:

    fair leg probability = Shin-devigged probability of the alternate line
    2-team teaser needs   p^2 * payout = (1 - p^2)  ->  p = sqrt(1/(1+b))
    -110 needs 72.37% | -120 needs 73.85% | -130 needs 75.18%

If Pinnacle's devigged price for the teased leg sits BELOW break-even, the teaser is negative and
the historical 74.69% is either stale or an artifact of the seasons it was measured on. If it sits
ABOVE, there is a live, priced edge.

DEVIG uses the repo's own Shin implementation (server/services/nfl-devig.js) rather than a
proportional split, because these ladders are heavily skewed (-336/+266) and that is exactly where
the two methods diverge — see F03-devig-methods.md.

NOTE ON PINNACLE'S LADDER. It carries duplicate rows at the same points with different prices
(different market versions captured over time). The most recent version per (matchup, points) is
used, and the count of duplicates is reported.

Usage: python3 scripts/model-lab/teaser_fair_value.py [--points 6]
"""
import argparse
import json
import math
import sqlite3
import statistics as st
import subprocess
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"


def breakeven(price, legs=2):
    """p such that p^legs * b == (1 - p^legs), i.e. the per-leg rate a teaser must clear."""
    b = price / 100 if price > 0 else 100 / -price
    return (1 / (1 + b)) ** (1 / legs)


def shin_devig(pairs):
    """Devig a batch of (oddsA, oddsB) through the repo's Shin implementation."""
    js = f"""
import {{ shinNoVig }} from '{REPO}/server/services/nfl-devig.js';
const pairs = {json.dumps(pairs)};
// shinDevig returns {{probA, probB, z}} -- an OBJECT, not a tuple. Indexing it with [0] yields
// undefined and JSON-serialises to null, which silently produced an empty probability curve.
// shinNoVig returns probA directly and is the module's own default export.
console.log(JSON.stringify(pairs.map(([a, b]) => {{
  try {{ const p = shinNoVig(a, b); return Number.isFinite(p) ? p : null; }} catch {{ return null; }}
}})));
"""
    tmp = REPO / "_devig_query.mjs"
    tmp.write_text(js)
    try:
        r = subprocess.run(["node", str(tmp)], capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            print("devig failed:", r.stderr[-400:])
            return None
        return json.loads(r.stdout.strip().splitlines()[-1])
    finally:
        tmp.unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--points", type=float, default=6.0, help="teaser size")
    ap.add_argument("--legs", type=int, default=2)
    a = ap.parse_args()

    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=300)

    # latest version per (matchup, points) — the ladder carries several captures
    ladder, dupes = defaultdict(dict), 0
    for mid, home, away, pts, hp, ap_, ver in arc.execute(
            """SELECT q.matchup_id, m.home, m.away, q.home_points, q.home_price, q.away_price, q.version
               FROM pinnacle_quotes q JOIN pinnacle_matchups m USING (matchup_id)
               WHERE q.market_type='spread' AND q.period=0 AND q.home_points IS NOT NULL
                 AND q.home_price IS NOT NULL AND q.away_price IS NOT NULL AND m.type='matchup'
               ORDER BY q.version"""):
        key = (mid, home, away)
        if pts in ladder[key]:
            dupes += 1
        ladder[key][pts] = (hp, ap_)

    print(f"matchups with a spread ladder: {len(ladder)} | duplicate (points) rows collapsed: {dupes}")
    sizes = [len(v) for v in ladder.values()]
    if sizes:
        print(f"ladder depth: median {st.median(sizes):.0f} points, max {max(sizes)}")

    # Devig EVERY rung first, then interpolate the teased line on the resulting curve.
    # Requiring an exact rung at line+6 found only 2 legs in the whole board: the ladder carries a
    # median of 13 rungs, so the specific teased number usually is not quoted. Implied probability
    # is monotone in the line, so interpolating between the two bracketing rungs is sound and uses
    # the whole ladder rather than discarding it.
    rung_pairs, rung_index = [], []
    for key, rungs in ladder.items():
        for pts, (hp, ap_) in rungs.items():
            rung_index.append((key, pts))
            rung_pairs.append([hp, ap_])
    probs = shin_devig(rung_pairs)
    if probs is None:
        return
    curve = defaultdict(dict)          # key -> home_points -> P(home covers that number)
    for (key, pts), p in zip(rung_index, probs):
        if p is not None:
            curve[key][pts] = p

    def interp(points_map, x):
        """Linear interpolation of P at home-line x; None if x is outside the quoted ladder."""
        xs = sorted(points_map)
        if not xs or x < xs[0] or x > xs[-1]:
            return None
        if x in points_map:
            return points_map[x]
        lo = max(v for v in xs if v < x)
        hi = min(v for v in xs if v > x)
        w = (x - lo) / (hi - lo)
        return points_map[lo] * (1 - w) + points_map[hi] * w

    cands = []
    for key, rungs in ladder.items():
        pm = curve.get(key)
        if not pm or len(pm) < 4:
            continue
        main_pts = min(rungs.items(), key=lambda kv: abs(abs(kv[1][0]) - abs(kv[1][1])))[0]
        for side in ("home", "away"):
            line = main_pts if side == "home" else -main_pts
            teased = line + a.points
            wong = (-8.5 <= line <= -7.5) or (1.5 <= line <= 2.5)
            # express the teased line back in HOME points, which is what the curve is indexed on
            want = teased if side == "home" else -teased
            p_home = interp(pm, want)
            if p_home is None:
                continue
            p = p_home if side == "home" else 1 - p_home
            cands.append(dict(key=key, side=side, line=line, teased=teased,
                              wong=wong, main=main_pts, p=p))

    print(f"teasable legs priced by interpolating the ladder: {len(cands)} "
          f"({sum(1 for c in cands if c['wong'])} in the Wong window)\n")
    if not cands:
        print("ladder does not reach the teased lines")
        return

    good = [c for c in cands if c["p"] is not None]
    print(f"{'bucket':26s} {'n':>4s} {'mean devig p':>13s} {'median':>8s} {'min':>7s} {'max':>7s}")
    def blk(name, rs):
        if not rs:
            return
        ps = [r["p"] for r in rs]
        print(f"{name:26s} {len(rs):4d} {100*st.mean(ps):12.2f}% {100*st.median(ps):7.2f}% "
              f"{100*min(ps):6.2f}% {100*max(ps):6.2f}%")
    blk("ALL teasable legs", good)
    blk("WONG window", [c for c in good if c["wong"]])
    blk("favourites", [c for c in good if c["line"] < 0])
    blk("underdogs", [c for c in good if c["line"] > 0])

    print(f"\nbreak-even per leg for a {a.legs}-team {a.points:g}-point teaser:")
    for price in (-110, -120, -130, -140):
        print(f"   at {price}: {100*breakeven(price, a.legs):.2f}%")

    wong = [c for c in good if c["wong"]]
    if wong:
        m = st.mean([c["p"] for c in wong])
        print(f"\nVERDICT on the Wong window, priced by Pinnacle right now:")
        for price in (-110, -120, -130):
            be = breakeven(price, a.legs)
            edge = m - be
            print(f"   vs {price}: market says {100*m:.2f}% per leg, need {100*be:.2f}% "
                  f"-> {'+' if edge>0 else ''}{100*edge:.2f}pp  "
                  f"({'POSITIVE' if edge>0 else 'negative'})")
        print(f"\n   historical backtest said 74.69% per leg (n=1,391 legs, 1999-2025)")
        print(f"   Pinnacle's live devigged price says {100*m:.2f}%")
    else:
        print("\nNo Wong-window legs quoted in this capture. The ladder is captured every 10 minutes,")
        print("so rerun closer to kickoff when books post deeper alternates.")


if __name__ == "__main__":
    main()
