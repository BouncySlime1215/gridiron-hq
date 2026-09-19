#!/usr/bin/env python3
"""
Opener lab LEVEL 2 (what predicts the move's direction) and CONFIDENCE
WEIGHTS (Kelly), per LATEST-PLAN "PREREGISTERED — OPENER LAB".

Interpretations fixed before running (the preregistration left them open):
- Confirmation betting on 2024-25 uses the model FROZEN on 2022-23, no refit.
- Confidence-weight Kelly uses nested refits (2022-23 -> 2024, 2022-24 -> 2025).
  Its calibration regresses realized CLV probability on |prediction| using
  OUT-OF-FOLD predictions inside the training seasons (week-block 5-fold),
  never in-sample predictions. The level-1 segment interaction is used only
  where level 1 confirmed a segment (totals: top dispersion tercile).
- "Dev EV Holm-significant" = week-clustered z of mean EV over 2024-25 for the
  Kelly-staked bets, Holm-corrected across every betting test in this script.
Output: docs/evidence/2026-09-16/opener-lab/level2.json
"""
import json, math, statistics as st, sys
from collections import defaultdict
from pathlib import Path
import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts/model-lab"))
import lab, clv_kelly  # noqa: E402

OUT = REPO / "docs/evidence/2026-09-16/opener-lab"
AT_OPEN = "--at-open" in sys.argv
GAP, DISP = ("cons_gap_pre", "dispersion_pre") if AT_OPEN else ("cons_gap", "dispersion")
PRED = {"spreads": ["skew", GAP, "kalman_dep", "momentum"], "totals": ["skew", GAP, "kalman_dep"]}


def clustered_slope(x, y, weeks):
    x, y = np.asarray(x, float), np.asarray(y, float)
    X = np.column_stack([np.ones_like(x), x])
    beta = np.linalg.lstsq(X, y, rcond=None)[0]
    e = y - X @ beta
    bread = np.linalg.inv(X.T @ X)
    meat = np.zeros((2, 2))
    groups = defaultdict(list)
    for i, w in enumerate(weeks):
        groups[w].append(i)
    for idx in groups.values():
        s = X[idx].T @ e[idx]
        meat += np.outer(s, s)
    cov = bread @ meat @ bread
    se = math.sqrt(cov[1, 1])
    z = beta[1] / se
    return dict(slope=float(beta[1]), se=se, z=float(z), p=math.erfc(abs(z) / math.sqrt(2)), n=len(x))


def design(rows, names, stats=None):
    X = np.array([[r[n] if r[n] is not None else np.nan for n in names] for r in rows], float)
    if stats is None:
        stats = (np.nanmean(X, 0), np.nanstd(X, 0))
    mu, sd = stats
    sd = np.where(sd > 0, sd, 1)
    return np.nan_to_num((X - mu) / sd), stats


def fit_ridge(rows, names):
    Z, stats = design(rows, names)
    y = [r["move"] for r in rows]
    weeks = [(r["season"], r["week"]) for r in rows]
    model = lab.ridge_cv(Z, y, weeks)
    # out-of-fold predictions with the chosen lambda
    uw = sorted(set(weeks)); fold = np.array([{w: i % 5 for i, w in enumerate(uw)}[w] for w in weeks])
    oof = np.zeros(len(rows)); yv = np.asarray(y, float)
    for k in range(5):
        tr, te = fold != k, fold == k
        A = np.column_stack([np.ones(tr.sum()), Z[tr]]); P = np.eye(A.shape[1]) * model["lam"]; P[0, 0] = 0
        w = np.linalg.solve(A.T @ A + P, A.T @ yv[tr])
        oof[te] = np.column_stack([np.ones(te.sum()), Z[te]]) @ w
    return dict(model=model, stats=stats, names=names, oof=oof)


def predict(fit, rows):
    Z, _ = design(rows, fit["names"], fit["stats"])
    return lab.ridge_predict(fit["model"], Z)


def main():
    table = [json.loads(l) for l in open(OUT / "table.jsonl")]
    l1 = json.load(open(OUT / ("level1-atopen.json" if AT_OPEN else "level1.json")))
    lab_rows = {(r["season"], r["week"], r["home"]): r for r in lab.load_table()}
    grader = clv_kelly.Grader(list(lab_rows.values()))
    report, ev_tests = {}, {}
    for market in ("spreads", "totals"):
        mk = lab.Market(market)
        names = PRED[market]
        rows = [r for r in table if r["market"] == market and (r["season"], r["week"], r["home"]) in lab_rows]
        disc = [r for r in rows if r["season"] in (2022, 2023)]
        conf = [r for r in rows if r["season"] in (2024, 2025)]
        seg_ok = "dispersion_t3" in l1[market]["confirmed"]
        seg_cut = l1[market]["cuts"]["dispersion_tercile_cuts"][1]
        seg = lambda r: 1.0 if (seg_ok and r[DISP] is not None and r[DISP] > seg_cut) else 0.0

        uni = {}
        for n in names:
            for label, sub in (("discovery", disc), ("confirmation", conf)):
                ok = [r for r in sub if r[n] is not None]
                uni[f"{n}|{label}"] = clustered_slope([r[n] for r in ok], [r["move"] for r in ok], [(r["season"], r["week"]) for r in ok])
        frozen = fit_ridge(disc, names)
        pc = predict(frozen, conf)
        ridge_conf = clustered_slope(pc, [r["move"] for r in conf], [(r["season"], r["week"]) for r in conf])
        hc = lab.holm({**{n: uni[f"{n}|confirmation"]["p"] for n in names}, "ridge": ridge_conf["p"]})
        thr = float(np.percentile(np.abs(predict(frozen, disc)), 75))

        bets_out = {}
        for variant in ("reference", "best_book"):
            for tier in ("all", "top25"):
                recs = []
                for r, p in zip(conf, pc):
                    if abs(p) < 1e-9 or (tier == "top25" and abs(p) < thr):
                        continue
                    x = grader.bet(mk, lab_rows[(r["season"], r["week"], r["home"])], bool(p > 0), variant)
                    if x:
                        recs.append(x)
                sm = clv_kelly.summarize(recs)
                bets_out[f"{variant}|{tier}"] = sm
                ev_tests[f"{market}|frozen|{variant}|{tier}"] = math.erfc(sm["ev_z"] / math.sqrt(2)) if sm.get("ev_z") and sm["ev_z"] > 0 else 1.0

        kelly = {}
        for variant in ("reference", "best_book"):
            all_recs, per = [], {}
            for S in (2024, 2025):
                train = [r for r in rows if 2022 <= r["season"] < S]
                test = [r for r in rows if r["season"] == S]
                fit = fit_ridge(train, names)
                cal_x, cal_y = [], []
                for r, p in zip(train, fit["oof"]):
                    if abs(p) < 1e-9:
                        continue
                    x = grader.bet(mk, lab_rows[(r["season"], r["week"], r["home"])], bool(p > 0), "reference")
                    if x:
                        cal_x.append([1.0, abs(p), abs(p) * seg(r)]); cal_y.append(x["clv_prob"])
                A = np.array(cal_x); coef = np.linalg.lstsq(A[:, :3] if seg_ok else A[:, :2], np.array(cal_y), rcond=None)[0]
                e_log = r_log = 0.0; nb = 0; recs = []
                for r, p in zip(test, predict(fit, test)):
                    if abs(p) < 1e-9:
                        continue
                    x = grader.bet(mk, lab_rows[(r["season"], r["week"], r["home"])], bool(p > 0), variant)
                    if not x:
                        continue
                    feats = [1.0, abs(p), abs(p) * seg(r)][:len(coef)]
                    gain = float(np.dot(coef, feats))
                    pe = min(max(x["p_open"] + gain, 0.01), 0.99)
                    f = min(clv_kelly.KELLY_CAP, clv_kelly.KELLY_MULT * max(0.0, (pe * x["b"] - (1 - pe)) / x["b"]))
                    if f <= 0:
                        continue
                    nb += 1; recs.append(x)
                    e_log += x["p_true"] * math.log(1 + f * x["b"]) + (1 - x["p_true"]) * math.log(1 - f)
                    if x["result"] is not None:
                        r_log += math.log(1 + f * x["b"]) if x["result"] else math.log(1 - f)
                per[S] = dict(calibration=[float(c) for c in coef], kelly_bets=nb, expected_growth_pct=100 * (math.exp(e_log) - 1),
                              realized_growth_pct=100 * (math.exp(r_log) - 1), bets_summary=clv_kelly.summarize(recs))
                all_recs += recs
            sm = clv_kelly.summarize(all_recs)
            kelly[variant] = dict(per_season=per, pooled=sm)
            ev_tests[f"{market}|kelly|{variant}"] = math.erfc(sm["ev_z"] / math.sqrt(2)) if sm.get("ev_z") and sm["ev_z"] > 0 else 1.0
        report[market] = dict(univariate=uni, ridge_lambda=frozen["model"]["lam"], ridge_confirmation=ridge_conf,
                              holm_confirmation=hc, top25_threshold=thr, frozen_bets=bets_out, kelly=kelly, level1_segment_used=seg_ok)
    hev = lab.holm(ev_tests)
    for market in report:
        for variant in ("reference", "best_book"):
            k = report[market]["kelly"][variant]
            k["success"] = bool(all(k["per_season"][S]["expected_growth_pct"] > 0 for S in (2024, 2025))
                                and hev[f"{market}|kelly|{variant}"]["passes"])
    report["holm_betting"] = hev
    (OUT / ("level2-atopen.json" if AT_OPEN else "level2.json")).write_text(json.dumps(report, indent=1, default=float))

    f = lambda x, n=2: "   -" if x is None else f"{x:+.{n}f}"
    for market in ("spreads", "totals"):
        R = report[market]
        print(f"\n=== LEVEL 2 {market}: slope of move on predictor (week-clustered)")
        for n in PRED[market]:
            a, b = R["univariate"][f"{n}|discovery"], R["univariate"][f"{n}|confirmation"]
            print(f"  {n:11s} disc slope {a['slope']:+.3f} z {a['z']:+.2f} (n {a['n']}) | conf slope {b['slope']:+.3f} z {b['z']:+.2f} (n {b['n']}) holm {'PASS' if R['holm_confirmation'][n]['passes'] else 'fail'}")
        rc = R["ridge_confirmation"]
        print(f"  ridge (frozen 2022-23) -> 2024-25: slope actual on predicted {rc['slope']:+.3f} z {rc['z']:+.2f} holm {'PASS' if R['holm_confirmation']['ridge']['passes'] else 'fail'}")
        for k, v in R["frozen_bets"].items():
            print(f"  bet predicted direction [{k:18s}] n {v['n']:4d} CLV {f(v.get('clv'))} pts  CLVprob {f(v.get('clv_prob_pp'))}pp  EV {f(v.get('ev_pct'))}%  z {f(v.get('ev_z'))}  win {f(v.get('win_pct'),1)}%  ROI {f(v.get('flat_roi_pct'),1)}%")
        for variant, k in R["kelly"].items():
            s24, s25 = k["per_season"][2024], k["per_season"][2025]
            print(f"  KELLY confidence weights [{variant:9s}] 2024: {s24['kelly_bets']} bets exp {s24['expected_growth_pct']:+.2f}% real {s24['realized_growth_pct']:+.2f}% | 2025: {s25['kelly_bets']} bets exp {s25['expected_growth_pct']:+.2f}% real {s25['realized_growth_pct']:+.2f}% | pooled EV {f(k['pooled'].get('ev_pct'))}% z {f(k['pooled'].get('ev_z'))} | SUCCESS {k['success']}")
    print("\nHolm across betting tests:", {k: v["passes"] for k, v in hev.items()})


if __name__ == "__main__":
    main()
