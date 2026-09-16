#!/usr/bin/env python3
"""
Seven tests Nick asked for on 2026-09-16, run against data already on disk
from tonight's opener-CLV work plus three small read-only joins against the
live database. No new ensemble fit -- the per-component predictions saved
in docs/evidence/2026-09-16/opener-clv/games-*.jsonl already carry every
one of the ~35 components' own margin for every game, which is what makes
all seven of these cheap tonight instead of another multi-hour pass.

Reuses existing, already-built logic rather than reinventing it:
  - #5 referee: the exact join/statistics from nfl-officials.js's
    refereeTotals() (read directly, ported here since that function goes
    through the JS db layer, which needs the extract rebuilt to include
    nfl_officials; this project's read-only-live-DB convention is used
    instead for a pure read).
  - #8 Kelly: the exact formula from staking.js's kellyFraction()/stakeFor(),
    including the DEFAULT_KELLY_FRACTION=0.25 already used in production
    (teaser-staking.js).

SURVIVORS is the four double-adjusted signals from tonight's headline
result (second_half_eff, opp_adjusted, dynamic_state, epa_net) --
series_sustain is deliberately excluded; it did not survive the double
adjustment for home-field and favorite/underdog drift.

Read-only against the live 16GB database via mode=ro, per RUNBOOK Sec0a
rule 1. Writes nothing to any database.
"""
import json, math, statistics as st, sqlite3, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
D = REPO / "docs/evidence/2026-09-16/opener-clv"
LIVE_DB = "/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/data.sqlite"
POOL = (2022, 2023, 2024)
SURVIVORS = ["second_half_eff", "opp_adjusted", "dynamic_state", "epa_net"]

def r2(x): return None if x is None else round(x, 4)

def load_pool():
    rows = []
    for s in POOL:
        for line in open(D / f"games-{s}.jsonl"):
            r = json.loads(line)
            r["_s"] = s
            rows.append(r)
    return rows

def comp_map(r):
    return {c["id"]: c["pred"] for c in (r.get("components") or [])}

def composite_pred(r):
    cm = comp_map(r)
    vals = [cm.get(c) for c in SURVIVORS]
    return sum(vals) / 4 if all(v is not None for v in vals) else None

def grade_adjusted(rows, pred_fn, mu, fav_dog_baseline=None):
    """Home-drift-adjusted CLV, week-clustered. fav_dog_baseline, if given,
    is the {(side, role): baseline} 4-bucket table for the double adjustment."""
    vals, clusters = [], {}
    for r in rows:
        p = pred_fn(r)
        if p is None:
            continue
        o, c = r["open_spread"], r["close_spread"]
        if o == 0:
            continue
        lean = p - (-o)
        if abs(lean) < 1e-9:
            continue
        bh = lean > 0
        v = (o if bh else -o) - (c if bh else -c)
        if fav_dog_baseline is not None:
            role = "fav" if (bh and o < 0) or (not bh and o > 0) else "dog"
            base = fav_dog_baseline[("home" if bh else "away", role)]
        else:
            base = mu if bh else -mu
        a = v - base
        vals.append(a)
        clusters.setdefault((r["_s"], r["week"]), []).append(a)
    if len(clusters) < 3:
        return None
    cm = [st.mean(x) for x in clusters.values()]
    se = st.stdev(cm) / math.sqrt(len(cm))
    m = st.mean(vals)
    z = m / se if se else None
    p = math.erfc(abs(z) / math.sqrt(2)) if z is not None else None
    return {"n": len(vals), "mean": m, "z": z, "p": p}

def four_bucket_baseline(rows):
    out = {}
    for side in ("home", "away"):
        for role in ("fav", "dog"):
            vals = []
            for r in rows:
                o, c = r["open_spread"], r["close_spread"]
                if o == 0:
                    continue
                bh = side == "home"
                is_fav = o < 0
                this_role = "fav" if (bh and is_fav) or (not bh and not is_fav) else "dog"
                if this_role != role:
                    continue
                vals.append((o if bh else -o) - (c if bh else -c))
            out[(side, role)] = st.mean(vals) if vals else 0.0
    return out


def main():
    rows = load_pool()
    by_key = {(r["_s"], r["week"], r["home"]): r for r in rows}
    mu = st.mean([(-r["close_spread"]) - (-r["open_spread"]) for r in rows])
    fdb = four_bucket_baseline(rows)
    out = {}

    # ---------------------------------------------------------------- #6
    # Segment-conditional: slice the composite's ALREADY-double-adjusted
    # result by home/away role, spread size, divisional-or-not, and season
    # thirds -- exactly nfl-replay.js's segmentsFor() categories, applied
    # to this test instead of to a placed bet.
    print("Loading div_game via direct read-only join (not in the JS extract)...", file=sys.stderr)
    con = sqlite3.connect(f"file:{LIVE_DB}?mode=ro", uri=True)
    div = {}
    for s, w, home, away, dg in con.execute(
        "SELECT season, week, team, opponent, div_game FROM game_lines WHERE home=1 AND season IN (2022,2023,2024)"
    ):
        div[(s, w, home)] = dg

    def seg_test(pred_fn, filt):
        sub = [r for r in rows if filt(r)]
        return grade_adjusted(sub, pred_fn, mu, fdb)

    seg6 = {}
    seg6["divisional"] = seg_test(composite_pred, lambda r: div.get((r["_s"], r["week"], r["home"])) == 1)
    seg6["non_divisional"] = seg_test(composite_pred, lambda r: div.get((r["_s"], r["week"], r["home"])) == 0)
    seg6["small_spread_0_3"] = seg_test(composite_pred, lambda r: abs(r["open_spread"]) <= 3)
    seg6["mid_spread_3_7"] = seg_test(composite_pred, lambda r: 3 < abs(r["open_spread"]) <= 7)
    seg6["big_spread_7plus"] = seg_test(composite_pred, lambda r: abs(r["open_spread"]) > 7)
    seg6["early_season_wk1_6"] = seg_test(composite_pred, lambda r: r["week"] <= 6)
    seg6["mid_season_wk7_12"] = seg_test(composite_pred, lambda r: 7 <= r["week"] <= 12)
    seg6["late_season_wk13plus"] = seg_test(composite_pred, lambda r: r["week"] >= 13)
    out["6_segments"] = seg6

    # ---------------------------------------------------------------- #7
    # Stress test: the edge should be WEAKEST exactly where "last week's
    # form" is least informative -- week 1, right after a bye (rest_days
    # extreme), a team's first season under a new head coach. Stated
    # before running: shrinking or reversing here is evidence FOR the
    # mechanism (form-lag), not evidence to explain away.
    rest = {}
    for s, w, home, rd in con.execute(
        "SELECT season, week, team, rest_days FROM game_lines WHERE home=1 AND season IN (2022,2023,2024)"
    ):
        rest[(s, w, home)] = rd
    coach_first_year = {}
    for s, team, coach in con.execute(
        "SELECT season, team, coach FROM nfl_team_coaches WHERE season IN (2021,2022,2023,2024)"
    ):
        coach_first_year[(s, team)] = coach
    def is_new_coach_season(s, team):
        prev = coach_first_year.get((s - 1, team))
        cur = coach_first_year.get((s, team))
        return prev is not None and cur is not None and prev != cur

    seg7 = {}
    seg7["week_1_only"] = seg_test(composite_pred, lambda r: r["week"] == 1)
    seg7["week_2_plus"] = seg_test(composite_pred, lambda r: r["week"] >= 2)
    seg7["off_bye_rest_ge_13"] = seg_test(composite_pred, lambda r: (rest.get((r["_s"], r["week"], r["home"])) or 0) >= 13)
    seg7["normal_rest_lt_13"] = seg_test(composite_pred, lambda r: (rest.get((r["_s"], r["week"], r["home"])) or 0) < 13)
    seg7["new_coach_season_home"] = seg_test(composite_pred, lambda r: is_new_coach_season(r["_s"], r["home"]))
    seg7["same_coach_home"] = seg_test(composite_pred, lambda r: not is_new_coach_season(r["_s"], r["home"]))
    out["7_stress_test"] = seg7

    # ---------------------------------------------------------------- #11
    # Consensus-line grading: the median CLOSING spread across every book
    # in the archive, instead of nflverse's single reported close.
    consensus = {}
    for s, w, home, away, line in con.execute(
        """SELECT season, week, home, away, line FROM nfl_odds_archive
           WHERE market='spreads' AND phase='close' AND side=home AND season IN (2022,2023,2024)"""
    ):
        consensus.setdefault((s, w, home), []).append(line)
    n_with_consensus = sum(1 for k in ((r["_s"], r["week"], r["home"]) for r in rows) if k in consensus)
    cons_rows = []
    for r in rows:
        key = (r["_s"], r["week"], r["home"])
        if key in consensus and len(consensus[key]) >= 3:
            r2c = dict(r)
            r2c["close_spread"] = st.median(consensus[key])
            cons_rows.append(r2c)
    out["11_consensus_line"] = {
        "games_with_3plus_books": n_with_consensus,
        "games_used": len(cons_rows),
        "vs_single_book_nflverse_close": grade_adjusted(rows, composite_pred, mu, fdb),
        "vs_consensus_close": grade_adjusted(cons_rows, composite_pred, mu, four_bucket_baseline(cons_rows)) if cons_rows else None,
    }

    # ---------------------------------------------------------------- #3
    # Internal disagreement: does the SPREAD of the ~35 components'
    # predictions (already saved per game tonight) carry information --
    # either about which games the composite gets more right, or about CLV
    # size itself?
    disagreement_rows = []
    for r in rows:
        cm = comp_map(r)
        vals = [v for v in cm.values() if v is not None]
        if len(vals) < 10:
            continue
        disagreement_rows.append((r, st.pstdev(vals)))
    disp_vals = [d for _, d in disagreement_rows]
    med_disp = st.median(disp_vals)
    low_disp = [r for r, d in disagreement_rows if d <= med_disp]
    high_disp = [r for r, d in disagreement_rows if d > med_disp]
    out["3_disagreement"] = {
        "n_games": len(disagreement_rows),
        "median_disagreement_pts": r2(med_disp),
        "low_disagreement_half": grade_adjusted(low_disp, composite_pred, mu, four_bucket_baseline(low_disp)),
        "high_disagreement_half": grade_adjusted(high_disp, composite_pred, mu, four_bucket_baseline(high_disp)),
    }

    # ---------------------------------------------------------------- #5
    # Referee tendency, ported from nfl-officials.js refereeTotals() --
    # same exact join and same Sidak-corrected multiplicity discipline,
    # run here read-only instead of through the JS db layer.
    ref_joined = list(con.execute(
        """SELECT o.name, g.season, g.week, g.total, (g.team_score+g.opp_score) AS actual,
                  g.spread, g.open_spread, g.team, g.opponent
           FROM nfl_officials o
           JOIN game_lines g ON g.season=o.season AND g.week=o.week AND g.home=1
             AND g.team=o.home_team AND g.opponent=o.away_team
           WHERE o.position='Referee' AND g.total IS NOT NULL
             AND g.team_score IS NOT NULL AND g.opp_score IS NOT NULL
             AND g.season IN (2022,2023,2024)"""
    ))
    by_ref = {}
    for name, season, week, total, actual, spread, open_spread, team, opp in ref_joined:
        by_ref.setdefault(name, []).append(dict(total=total, actual=actual))
    crews = []
    for name, g in by_ref.items():
        if len(g) < 25:
            continue
        overs = sum(1 for x in g if x["actual"] > x["total"])
        unders = sum(1 for x in g if x["actual"] < x["total"])
        graded = overs + unders
        rate = overs / graded if graded else None
        se = math.sqrt(0.25 / graded) if graded else None
        z = (rate - 0.5) / se if (rate is not None and se) else None
        crews.append({"referee": name, "games": len(g), "graded": graded,
                       "over_rate": r2(rate), "z_vs_coinflip": r2(z)})
    crews.sort(key=lambda c: -(c["over_rate"] or 0))
    n_crews = len(crews)
    corrected_alpha = 1 - (1 - 0.05) ** (1 / max(1, n_crews))
    def inv_norm(p):
        # Acklam's algorithm, same one used elsewhere in this codebase
        a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00]
        b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01]
        c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00]
        d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00]
        pl=0.02425
        if p<pl:
            q=math.sqrt(-2*math.log(p))
            return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
        if p>1-pl:
            q=math.sqrt(-2*math.log(1-p))
            return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
        q=p-0.5; rr=q*q
        return (((((a[0]*rr+a[1])*rr+a[2])*rr+a[3])*rr+a[4])*rr+a[5])*q/(((((b[0]*rr+b[1])*rr+b[2])*rr+b[3])*rr+b[4])*rr+1)
    z_required = abs(inv_norm(corrected_alpha / 2))
    significant = [c for c in crews if c["z_vs_coinflip"] is not None and abs(c["z_vs_coinflip"]) > z_required]
    out["5_referee"] = {
        "referee_games_joined": len(ref_joined), "crews_examined": n_crews, "min_games": 25,
        "corrected_alpha": r2(corrected_alpha), "z_required": r2(z_required),
        "significant_crews": significant, "top_5_by_over_rate": crews[:5],
    }

    # ---------------------------------------------------------------- #2
    # Cover-probability calibration, WITHOUT a new expensive ensemble
    # pass. Fit a simple logistic relationship between |composite lean|
    # and real cover outcome on an EARLY split of the pool, predict on a
    # LATER, disjoint split (same chronological-holdout discipline used
    # everywhere else tonight), then check whether the predicted
    # probability bins match the realized frequency in the holdout --
    # a real, if simplified, reliability diagram.
    scored = []
    for r in rows:
        p = composite_pred(r)
        if p is None:
            continue
        lean = p - (-r["open_spread"])
        push = r["actual_margin"] + r["open_spread"] == 0
        if push:
            continue
        covered = (lean > 0) == (r["actual_margin"] + r["open_spread"] > 0)
        scored.append((r["_s"], r["week"], lean, covered))
    scored.sort(key=lambda x: (x[0], x[1]))
    split = int(len(scored) * 0.6)
    fit_rows, score_rows = scored[:split], scored[split:]
    # one-variable logistic regression by simple gradient ascent
    b0, b1 = 0.0, 0.05
    xs = [abs(x[2]) for x in fit_rows]
    ys = [1.0 if x[3] else 0.0 for x in fit_rows]
    for _ in range(2000):
        g0 = g1 = 0.0
        for x, y in zip(xs, ys):
            p = 1 / (1 + math.exp(-(b0 + b1 * x)))
            g0 += (y - p); g1 += (y - p) * x
        b0 += 0.01 * g0 / len(xs); b1 += 0.01 * g1 / len(xs)
    def pred_prob(abs_lean):
        return 1 / (1 + math.exp(-(b0 + b1 * abs_lean)))
    bins = [(0, 1), (1, 2), (2, 3), (3, 5), (5, 99)]
    calib = []
    for lo, hi in bins:
        sub = [x for x in score_rows if lo <= abs(x[2]) < hi]
        if not sub:
            continue
        realized = st.mean(1.0 if x[3] else 0.0 for x in sub)
        predicted = st.mean(pred_prob(abs(x[2])) for x in sub)
        calib.append({"bin": f"[{lo},{hi})", "n": len(sub), "predicted_p_cover": r2(predicted), "realized_cover_rate": r2(realized)})
    out["2_cover_calibration"] = {"fit_n": len(fit_rows), "score_n": len(score_rows),
        "logistic_b0": r2(b0), "logistic_b1_per_point": r2(b1), "calibration_bins": calib}

    # ---------------------------------------------------------------- #8
    # Risk-adjusted growth: fractional Kelly (0.25x, the same multiplier
    # already used in production teaser-staking.js), using the SAME
    # calibrated probability curve from #2's fit split, applied to the
    # score split's actual outcomes. -110 odds throughout.
    def american_to_decimal(o): return 1 + (100 / abs(o) if o < 0 else o / 100)
    def kelly_fraction(win_prob, american_odds=-110):
        b = american_to_decimal(american_odds) - 1
        if b <= 0: return 0
        q = 1 - win_prob
        f = (b * win_prob - q) / b
        return f if f > 0 else 0
    bankroll = 100.0
    bankroll_flat = 100.0
    staked_games = 0
    for _, _, lean, covered in score_rows:
        p = pred_prob(abs(lean))
        full_k = kelly_fraction(p)
        frac = min(full_k * 0.25, 0.05)
        if frac <= 0:
            continue
        staked_games += 1
        stake = frac * bankroll
        bankroll += stake * (american_to_decimal(-110) - 1) if covered else -stake
        flat_stake = 0.01 * bankroll_flat
        bankroll_flat += flat_stake * (american_to_decimal(-110) - 1) if covered else -flat_stake
    out["8_kelly_growth"] = {
        "games_in_score_split": len(score_rows), "games_staked_fractional_kelly": staked_games,
        "kelly_multiplier": 0.25, "starting_bankroll": 100.0,
        "ending_bankroll_fractional_kelly": r2(bankroll),
        "ending_bankroll_flat_1pct_every_game": r2(bankroll_flat),
    }

    con.close()
    print(json.dumps(out, indent=1, default=str))

if __name__ == "__main__":
    main()
