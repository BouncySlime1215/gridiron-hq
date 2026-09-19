#!/usr/bin/env python3
"""
"Questionable" is not one designation. It is thirty-two dialects. Does the market speak them?

THE OBSERVATION THAT STARTED THIS. In nflverse `injuries` (55,749 rows, 2016-2026), the share of
entries carrying report_status='Questionable' varies enormously by team:

    NE   63.3%   (1,209 of 1,910)
    DET  40.5%
    BAL  39.9%
    ...

New England sits 23 points above the next team. That is the documented Belichick practice of
listing nearly everyone, and it means a Patriots "Questionable" carries far less information than
another team's. League-wide P(play | Questionable) is 0.670, but a single pooled number is
precisely what you would compute if you had not noticed the dialects.

THE HYPOTHESIS. If a team's Questionable designations resolve to "played" at a rate well above the
league average, then a market applying a league-average haircut is over-discounting that team, and
under-discounting the teams whose Questionable genuinely means doubtful. The mispricing is in the
TRANSLATION, not in the football -- which is the only kind of edge this project has not already
killed twenty-four times.

WHY THIS IS NOT ANOTHER TEAM-STRENGTH FEATURE. It makes no claim about which team is better. It
claims the market mis-reads a specific institutional signal. That is a behavioural/structural
hypothesis and it lives or dies on whether teams' rates are STABLE OUT OF SAMPLE -- a rate fitted
on prior seasons must predict the next one, or it is noise being named.

THREE GATES, IN ORDER, AND THE TEST FAILS HONESTLY AT ANY OF THEM:
  1. DISPERSION.  Do team rates differ by more than sampling noise? Chi-square across teams.
  2. PERSISTENCE. Does a team's rate in seasons 1..t-1 predict its rate in season t? A rate that
     does not persist cannot be traded, however large the in-sample spread.
  3. PRICE.       Does the residual (team rate minus league rate) predict closing-line error?

Gate 2 is where this most likely dies, and it is deliberately tested before anything touches a
price, so no effort is spent pricing a pattern that does not repeat.

Usage: python3 scripts/model-lab/questionable_dialect.py
"""
import collections
import math
import sqlite3
import statistics as st
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"
NV_FIX = {"LA": "LAR", "JAC": "JAX", "OAK": "LV", "SD": "LAC", "STL": "LAR"}


def norm(t):
    return NV_FIX.get(t, t)


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def main():
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=600)

    # ---- did the player actually play? snap_counts is the ground truth --------------------
    played = set()
    for season, week, team, player in nv.execute(
            """SELECT season, week, team, player FROM snap_counts
               WHERE offense_snaps > 0 OR defense_snaps > 0 OR st_snaps > 0"""):
        played.add((season, week, norm(team), str(player).strip().lower()))
    print(f"player-weeks with a recorded snap: {len(played):,}")

    rows = []
    for season, week, team, name, pos, status in nv.execute(
            """SELECT season, week, team, full_name, position, report_status
               FROM injuries WHERE report_status IS NOT NULL"""):
        rows.append((season, week, norm(team), str(name).strip().lower(), pos, status))
    print(f"injury-report entries with a status: {len(rows):,}")

    # sanity: the designations must rank correctly, or the join is broken
    print("\nLEAGUE-WIDE P(play | status) -- a join check as much as a result:")
    by_status = collections.defaultdict(lambda: [0, 0])
    for season, week, team, name, pos, status in rows:
        key = (season, week, team, name)
        by_status[status][1] += 1
        if key in played:
            by_status[status][0] += 1
    for s in ("Out", "Doubtful", "Questionable"):
        k, n = by_status[s]
        if n:
            print(f"   {s:14s} {k:6,}/{n:6,} = {100*k/n:6.2f}%")
    q_k, q_n = by_status["Questionable"]
    league = q_k / q_n if q_n else 0
    print(f"\n   pooled league P(play | Questionable) = {100*league:.2f}%  (n={q_n:,})")

    # ---- GATE 1: dispersion across teams ---------------------------------------------------
    print("\n" + "=" * 74)
    print("GATE 1  DISPERSION. Do teams differ by more than sampling noise?")
    print("=" * 74)
    per_team = collections.defaultdict(lambda: [0, 0])
    per_team_season = collections.defaultdict(lambda: [0, 0])
    for season, week, team, name, pos, status in rows:
        if status != "Questionable":
            continue
        key = (season, week, team, name)
        per_team[team][1] += 1
        per_team_season[(team, season)][1] += 1
        if key in played:
            per_team[team][0] += 1
            per_team_season[(team, season)][0] += 1

    chi, df = 0.0, 0
    for team, (k, n) in per_team.items():
        if n < 30:
            continue
        exp = n * league
        if exp > 0 and n - exp > 0:
            chi += (k - exp) ** 2 / exp + ((n - k) - (n - exp)) ** 2 / (n - exp)
            df += 1
    df = max(1, df - 1)
    # Wilson-Hilferty normal approximation to chi-square, so no scipy dependency
    z = ((chi / df) ** (1 / 3) - (1 - 2 / (9 * df))) / math.sqrt(2 / (9 * df))
    p = 0.5 * math.erfc(z / math.sqrt(2))
    print(f"   chi-square {chi:.1f} on {df} df  ->  p = {p:.3e}")
    print(f"   {'team':6s} {'played/Q':>14s} {'rate':>8s} {'95% CI':>18s}  {'vs league':>10s}")
    ranked = sorted(((t, k, n) for t, (k, n) in per_team.items() if n >= 100),
                    key=lambda x: -x[1] / x[2])
    for t, k, n in ranked[:6] + [("...", 0, 0)] + ranked[-6:]:
        if t == "...":
            print("   ...")
            continue
        lo, hi = wilson(k, n)
        print(f"   {t:6s} {k:6,}/{n:6,} {100*k/n:7.2f}% [{100*lo:6.2f}%,{100*hi:6.2f}%] "
              f"{100*(k/n-league):+9.2f}pp")

    # ---- GATE 2: persistence out of sample --------------------------------------------------
    print("\n" + "=" * 74)
    print("GATE 2  PERSISTENCE. Does a team's rate in prior seasons predict the next one?")
    print("        This is where the test most likely dies, and it is checked BEFORE any price.")
    print("=" * 74)
    seasons = sorted({s for (t, s) in per_team_season})
    xs, ys, labels = [], [], []
    for team in sorted(per_team):
        for si, s in enumerate(seasons):
            if si < 3:
                continue
            prior_k = sum(per_team_season[(team, ps)][0] for ps in seasons[:si])
            prior_n = sum(per_team_season[(team, ps)][1] for ps in seasons[:si])
            cur_k, cur_n = per_team_season[(team, s)]
            if prior_n >= 60 and cur_n >= 20:
                xs.append(prior_k / prior_n)
                ys.append(cur_k / cur_n)
                labels.append((team, s, cur_n))
    if len(xs) < 30:
        print(f"   only {len(xs)} team-seasons with enough data -- not testable")
        return
    mx, my = st.mean(xs), st.mean(ys)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    r = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy) if sx and sy else 0.0
    z_ = 0.5 * math.log((1 + r) / (1 - r)) * math.sqrt(len(xs) - 3) if abs(r) < 1 else 0
    pv = 2 * (1 - 0.5 * (1 + math.erf(abs(z_) / math.sqrt(2))))
    print(f"   n = {len(xs)} team-seasons (prior>=60 Q, current>=20 Q)")
    print(f"   correlation(prior-seasons rate, next-season rate) = {r:+.4f}   p = {pv:.4f}")

    # a split-half control: within the SAME season, do odd and even weeks agree? This bounds how
    # much correlation is achievable given the noise, and separates "teams differ" from
    # "teams differ in a way that persists".
    oh, eh = collections.defaultdict(lambda: [0, 0]), collections.defaultdict(lambda: [0, 0])
    for season, week, team, name, pos, status in rows:
        if status != "Questionable":
            continue
        d = oh if week % 2 else eh
        d[(team, season)][1] += 1
        if (season, week, team, name) in played:
            d[(team, season)][0] += 1
    ax, ay = [], []
    for k in oh:
        if oh[k][1] >= 15 and eh[k][1] >= 15:
            ax.append(oh[k][0] / oh[k][1])
            ay.append(eh[k][0] / eh[k][1])
    if len(ax) > 20:
        m1, m2 = st.mean(ax), st.mean(ay)
        s1 = math.sqrt(sum((x - m1) ** 2 for x in ax))
        s2 = math.sqrt(sum((y - m2) ** 2 for y in ay))
        rr = sum((x - m1) * (y - m2) for x, y in zip(ax, ay)) / (s1 * s2) if s1 and s2 else 0
        print(f"   split-half control (odd vs even weeks, same season): r = {rr:+.4f} "
              f"on {len(ax)} team-seasons")
        print(f"      -> this is the RELIABILITY CEILING. A cross-season r far below it means the")
        print(f"         dialect is not stable; a cross-season r near it means it genuinely persists.")

    print("\n" + "=" * 74)
    print("VERDICT ON GATES 1-2")
    print("=" * 74)
    if p < 0.001 and pv < 0.05 and r > 0.2:
        print("   Teams DO differ, and the difference PERSISTS out of sample. Gate 3 (does the")
        print("   market price it?) is now worth running -- that is the next script.")
    elif p < 0.001:
        print("   Teams differ in sample (gate 1 passes) but the rate does NOT persist out of")
        print("   sample (gate 2 fails). A rate that does not repeat cannot be traded: the")
        print("   in-sample spread is roster churn and small-sample noise wearing a team label.")
        print("   NOT worth pricing. This is the honest kill and it cost nothing to find.")
    else:
        print("   Team rates are within sampling noise. There are no dialects. Dead at gate 1.")
    print("\n   NOTE: P(play|Questionable) uses snap_counts as ground truth, so a player who was")
    print("   active but took zero snaps counts as 'did not play'. That is the right definition")
    print("   for a market question and it is stated so the number is not mistaken for inactives.")


if __name__ == "__main__":
    main()
