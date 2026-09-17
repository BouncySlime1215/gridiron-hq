#!/usr/bin/env python3
"""
GATE 3. Does the closing line price each team's own Questionable rate, or a league average?

Gates 1 and 2 already passed (scripts/model-lab/questionable_dialect.py):
  DISPERSION  chi-square 343.9 on 31 df, p=1.1e-48. TB 80.8% play-rate vs PIT 47.0% -- a 34-point
              spread on Wilson intervals that do not overlap.
  PERSISTENCE cross-season r=+0.4018 against a split-half reliability ceiling of +0.5652, so it
              captures 71% of achievable signal. The dialect repeats.

Both of those are statements about INFORMATION. This is the one about MONEY, and it is the only
question that matters: an institutional quirk the market already prices is worth nothing.

THE CONSTRUCTION. For each team-game, count the players listed Questionable before kickoff. Under
a league-average reading, expected absences are n_Q * (1 - 0.6406). Under the team's own reading
they are n_Q * (1 - rate_team). The difference is the DIALECT RESIDUAL:

    residual = n_Q * (rate_team - rate_league)

Positive residual means this team's Questionables play MORE often than the league average, so a
market applying the league rate over-estimates how much talent is missing, and the team should beat
its closing spread. The test is whether residual predicts margin_error = actual_margin - closing
spread. If the market already speaks each dialect, the coefficient is zero and this is dead.

NO LOOK-AHEAD, and this is the part that decides whether the result is real: rate_team for season t
is computed from seasons BEFORE t only. A rate fitted on the season being tested would trivially
predict it and the whole thing would be circular. Teams without enough prior history are dropped
rather than backfilled with the league mean, and the count of drops is reported.

CONTROLS
  * Bet-everything must return roughly -vig. If it does not, the pipeline is broken.
  * PLACEBO: shuffle the team->rate assignment. The residual keeps its magnitude and loses its
    meaning, so anything that survives is structure rather than scale.
  * Game-clustered SEs throughout: home and away rows of one game are one cluster.

Usage: python3 scripts/model-lab/questionable_gate3.py
"""
import collections
import math
import random
import sqlite3
import statistics as st
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"
NV_FIX = {"LA": "LAR", "JAC": "JAX", "OAK": "LV", "SD": "LAC", "STL": "LAR"}
MIN_PRIOR = 60          # prior-season Questionable entries required before a team rate is trusted


def norm(t):
    return NV_FIX.get(t, t)


def clustered(pairs):
    """mean, cluster-robust SE, n, n_clusters for [(cluster_key, value)]."""
    if not pairs:
        return None
    vals = [v for _, v in pairs]
    m = st.mean(vals)
    g = collections.defaultdict(list)
    for k, v in pairs:
        g[k].append(v)
    G = len(g)
    if G < 2:
        return m, 0.0, len(vals), G
    num = sum(sum(v - m for v in vs) ** 2 for vs in g.values())
    se = math.sqrt(num) / len(vals) * math.sqrt(G / (G - 1))
    return m, se, len(vals), G


def main():
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=600)

    played = set()
    for s, w, t, p in nv.execute(
            """SELECT season, week, team, player FROM snap_counts
               WHERE offense_snaps > 0 OR defense_snaps > 0 OR st_snaps > 0"""):
        played.add((s, w, norm(t), str(p).strip().lower()))

    # Questionable entries per team-week, and whether each resolved to playing
    q_rows = collections.defaultdict(list)
    for s, w, t, name in nv.execute(
            """SELECT season, week, team, full_name FROM injuries
               WHERE report_status = 'Questionable'"""):
        tm = norm(t)
        q_rows[(s, w, tm)].append((s, w, tm, str(name).strip().lower()) in played)
    print(f"team-weeks with at least one Questionable: {len(q_rows):,}")

    # per (team, season) tallies, for building WALK-FORWARD rates
    ts = collections.defaultdict(lambda: [0, 0])
    for (s, w, tm), outcomes in q_rows.items():
        ts[(tm, s)][1] += len(outcomes)
        ts[(tm, s)][0] += sum(1 for o in outcomes if o)
    seasons = sorted({s for _, s in ts})
    tot_k = sum(v[0] for v in ts.values())
    tot_n = sum(v[1] for v in ts.values())
    league = tot_k / tot_n
    print(f"league P(play | Questionable) = {100*league:.2f}%  (n={tot_n:,})")

    def prior_rate(team, season):
        """Team rate from seasons strictly before `season`. None if too little history."""
        k = sum(ts[(team, s)][0] for s in seasons if s < season)
        n = sum(ts[(team, s)][1] for s in seasons if s < season)
        return (k / n, n) if n >= MIN_PRIOR else (None, n)

    def prior_league(season):
        k = sum(v[0] for (t, s), v in ts.items() if s < season)
        n = sum(v[1] for (t, s), v in ts.items() if s < season)
        return k / n if n else league

    # ---- games ------------------------------------------------------------------------------
    games = []
    for s, w, home, away, hs, as_, sl in nv.execute(
            """SELECT season, week, home_team, away_team, home_score, away_score, spread_line
               FROM nfldata_games
               WHERE home_score IS NOT NULL AND spread_line IS NOT NULL AND location='Home'"""):
        games.append((s, w, norm(home), norm(away), hs - as_, float(sl)))
    print(f"settled games with a closing spread: {len(games):,}")

    # ---- build the panel --------------------------------------------------------------------
    def build(rate_fn):
        rows, dropped = [], 0
        for s, w, home, away, margin, sl in games:
            lg = prior_league(s)
            rec = {}
            ok = True
            for side, tm in (("home", home), ("away", away)):
                r, n_prior = rate_fn(tm, s)
                if r is None:
                    ok = False
                    break
                nq = len(q_rows.get((s, w, tm), []))
                rec[side] = nq * (r - lg)       # dialect residual, in "extra players available"
            if not ok:
                dropped += 1
                continue
            # nflverse spread_line is a MARGIN (positive = home favoured), so margin_error is
            # actual minus expected directly.
            err = margin - sl
            rows.append((f"{s}-{w}-{home}", rec["home"] - rec["away"], err, s))
        return rows, dropped

    panel, dropped = build(prior_rate)
    print(f"\npanel: {len(panel):,} games ({dropped:,} dropped for <{MIN_PRIOR} prior "
          f"Questionable entries on a side)")
    if len(panel) < 300:
        print("panel too small to conclude.")
        return
    print(f"   seasons {min(r[3] for r in panel)}-{max(r[3] for r in panel)}")

    resid = [r[1] for r in panel]
    print(f"   dialect residual (home minus away): mean {st.mean(resid):+.3f}  "
          f"sd {st.stdev(resid):.3f}  p10 {sorted(resid)[len(resid)//10]:+.3f}  "
          f"p90 {sorted(resid)[9*len(resid)//10]:+.3f}")

    # ---- CONTROL: margin_error should be ~0 on average ---------------------------------------
    m, se, n, G = clustered([(r[0], r[2]) for r in panel])
    print(f"\nCONTROL  mean margin_error over all games: {m:+.4f} pts  SE {se:.4f}  "
          f"t={m/se if se else 0:+.2f}")
    print(f"         expected ~0 (the closing line is unbiased). "
          f"{'PASS' if abs(m/se if se else 0) < 2.5 else 'FAIL'}")

    # ---- THE TEST ----------------------------------------------------------------------------
    print("\n" + "=" * 74)
    print("GATE 3  Does the dialect residual predict margin_error?")
    print("=" * 74)
    xs, ys = [r[1] for r in panel], [r[2] for r in panel]
    mx, my = st.mean(xs), st.mean(ys)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    r_ = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy) if sx and sy else 0.0
    beta = (r_ * sy / sx) if sx else 0.0
    z = 0.5 * math.log((1 + r_) / (1 - r_)) * math.sqrt(len(xs) - 3) if abs(r_) < 1 else 0
    p = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
    print(f"   correlation = {r_:+.4f}   slope = {beta:+.3f} pts per unit residual   p = {p:.4f}")
    print(f"   n = {len(xs):,} games")

    print(f"\n{'residual quintile':22s} {'n':>6s} {'mean margin_error':>18s} {'SE':>7s} {'t':>7s}")
    order = sorted(panel, key=lambda r: r[1])
    qn = len(order) // 5
    for i in range(5):
        sub = order[i * qn:(i + 1) * qn] if i < 4 else order[4 * qn:]
        rr = clustered([(x[0], x[2]) for x in sub])
        if rr:
            mm, ss, nn, gg = rr
            lo = sub[0][1]
            hi = sub[-1][1]
            print(f"Q{i+1} [{lo:+.2f},{hi:+.2f}]".ljust(22)
                  + f" {nn:6d} {mm:+18.4f} {ss:7.4f} {mm/ss if ss else 0:+7.2f}")
    print("   monotone increasing would mean the market under-adjusts for the dialect.")

    # ---- PLACEBO -----------------------------------------------------------------------------
    print("\n" + "=" * 74)
    print("PLACEBO  shuffle which team owns which rate (keeps magnitudes, destroys meaning)")
    print("=" * 74)
    teams = sorted({t for t, s in ts})
    rng = random.Random(20260917)
    cors = []
    for _ in range(300):
        perm = teams[:]
        rng.shuffle(perm)
        mapping = dict(zip(teams, perm))
        shuffled, _d = build(lambda tm, s: prior_rate(mapping.get(tm, tm), s))
        if len(shuffled) < 200:
            continue
        a_ = [r[1] for r in shuffled]
        b_ = [r[2] for r in shuffled]
        ma, mb = st.mean(a_), st.mean(b_)
        sa = math.sqrt(sum((x - ma) ** 2 for x in a_))
        sb = math.sqrt(sum((y - mb) ** 2 for y in b_))
        if sa and sb:
            cors.append(sum((x - ma) * (y - mb) for x, y in zip(a_, b_)) / (sa * sb))
    if cors:
        cors.sort()
        lo, hi = cors[int(.025 * len(cors))], cors[int(.975 * len(cors))]
        print(f"   placebo correlation: mean {st.mean(cors):+.4f}  "
              f"95% band [{lo:+.4f}, {hi:+.4f}]  ({len(cors)} draws)")
        print(f"   REAL correlation:    {r_:+.4f}  -> "
              f"{'INSIDE the band -- NO SIGNAL' if lo <= r_ <= hi else 'OUTSIDE the band'}")

    # ---- what it would be worth ---------------------------------------------------------------
    print("\n" + "=" * 74)
    print("VERDICT")
    print("=" * 74)
    top = [r for r in panel if r[1] > 0.5]
    bot = [r for r in panel if r[1] < -0.5]
    for lab, sub in (("residual > +0.5", top), ("residual < -0.5", bot)):
        rr = clustered([(x[0], x[2]) for x in sub])
        if rr and rr[2] >= 30:
            mm, ss, nn, gg = rr
            print(f"   {lab}: {nn:5d} games, mean margin_error {mm:+.3f} pts, t={mm/ss if ss else 0:+.2f}")
    print(f"\n   A spread bet needs roughly 1.5 points of edge to clear 4.25% vig. If the slope")
    print(f"   times a realistic residual is well under that, the effect can be REAL and still")
    print(f"   not bettable -- which is the outcome this project keeps finding.")


if __name__ == "__main__":
    main()
