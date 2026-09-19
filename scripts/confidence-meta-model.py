#!/usr/bin/env python3
"""
CONFIDENCE META-MODEL -- can the system learn WHEN to trust itself?

WHY THIS EXISTS (2026-09-16, at Nick's request "yes build that")
----------------------------------------------------------------
Tonight we established that the size of the ensemble's own conviction --
how far its composite margin sits from the opening line -- carries NO
information about whether the pick is right. Correlation between edge size
and ATS correctness was r = -0.010 across 647 games, and still -0.021 after
removing early-season and week-18 games. Bigger swing, same coin flip.

That is a calibration gap, not a bug. This script asks the follow-up
question: the model cannot tell when it is right FROM EDGE SIZE ALONE, but
could a small supervised model, given richer point-in-time features, learn
to tell? If yes, we bet the confident slice and skip the rest. If no, we
have a documented null and we stop asking.

PREREGISTRATION -- WRITTEN BEFORE ANY RESULT WAS SEEN
------------------------------------------------------
Targets (both reported; A is primary because it is continuous and therefore
far more statistically powerful than a win/loss count at this sample size):

  A. PRIMARY   double-adjusted CLV in points, per game, signed toward the
               side we backed. Same metric and same 4-bucket zero-skill
               baseline subtraction as the headline result in
               seven-attack-tests.py -- reused, not reinvented.
  B. SECONDARY binary: did the pick cover at the OPENING number (pushes
               dropped). This is the literal "is it right" question.

Split: strictly chronological. FIT on 2022 + 2023. TEST on 2024, untouched
until scoring. No walk-forward re-fit, no hyperparameter search on test.

Features (9). Every one is knowable at bet time, before the game:
   week                week number, a proxy for how mature the season
                       sample feeding every component is
   abs_open_spread     |opening spread| -- how close the game is
   abs_lean            |composite - opener| -- the conviction measure that
                       ALREADY FAILED alone; included so the model can use
                       it in combination if it is conditionally useful
   disp_all            stdev across all available non-contaminated components
   disp_surv           stdev across the four survivor signals
   dir_frac_all        fraction of non-contaminated components leaning the
                       same way as the composite
   dir_frac_surv       same, among the four survivors
   sim_agrees          1 if the drive sim leans the same way, 0 if opposed,
                       0.5 if the sim produced nothing for that game
   n_comp_avail        how many components returned a number at all, i.e.
                       a data-completeness proxy

CONTAMINATION GUARD: component `market_correction_research` is EXCLUDED from
every feature. Per opener-clv-pass2.mjs's header it is the Python
`correction` model, whose feature list is ['football_prediction',
'market_spread', 'market_movement'] -- it is handed the CLOSING spread and
the opener-to-close move. Letting it into a dispersion or direction feature
would leak the exact quantity target A measures. It is dropped by id.

The 4-bucket CLV baseline is computed on FIT SEASONS ONLY and applied to
test. A bettor in 2024 could only know 2022-23 drift. Computing it pooled
would let the test set peek at its own structural correction.

SUCCESS CRITERIA -- fixed in advance, no post-hoc rescue:
  PRIMARY PASSES if, on held-out 2024, the top quartile by predicted
  confidence shows mean double-adjusted CLV > 0 with week-clustered
  |z| > 1.96, AND beats the bottom quartile.
  SECONDARY PASSES if out-of-sample AUC > 0.55 with a bootstrap 95% CI
  that excludes 0.50.
  CALIBRATION PASSES if out-of-sample quintiles of predicted probability
  show a positive reliability slope.
If PRIMARY fails, this is reported as a null result and no feature hunting
is performed to save it. Three checks in the family -> Holm correction
applied to the primary family's p-values.

Also scored, as honest reference points, on the SAME held-out games:
  - `abs_lean` alone (the conviction measure already shown to be flat)
  - `disp_all` alone, sign-flipped (low disagreement = confident). This is
    the one confidence-ish signal that survived Holm earlier tonight, so a
    learned model that cannot beat it has earned nothing.

Reads only the saved JSONL evidence. No database, no GRIDIRON_DB_PATH.

Usage:  python3 scripts/confidence-meta-model.py
"""
import json, math, statistics as st
from pathlib import Path
import numpy as np

REPO = Path(__file__).resolve().parents[1]
D = REPO / "docs/evidence/2026-09-16/opener-clv"
OUT = D / "confidence-meta-model.json"
FIT_SEASONS = (2022, 2023)
TEST_SEASONS = (2024,)
SURVIVORS = ["second_half_eff", "opp_adjusted", "dynamic_state", "epa_net"]
CONTAMINATED = {"market_correction_research"}
RNG = np.random.default_rng(20260916)

FEATURES = ["week", "abs_open_spread", "abs_lean", "disp_all", "disp_surv",
            "dir_frac_all", "dir_frac_surv", "sim_agrees", "n_comp_avail"]


def load(seasons):
    rows = []
    for s in seasons:
        for line in open(D / f"games-{s}.jsonl"):
            r = json.loads(line)
            r["_s"] = s
            rows.append(r)
    return rows


def comp_map(r):
    """All components EXCEPT the contaminated one, with a real prediction."""
    return {c["id"]: c["pred"] for c in (r.get("components") or [])
            if c["id"] not in CONTAMINATED and c["pred"] is not None}


def composite_pred(r):
    cm = comp_map(r)
    vals = [cm.get(c) for c in SURVIVORS]
    return sum(vals) / 4 if all(v is not None for v in vals) else None


def four_bucket_baseline(rows):
    """Zero-skill drift baseline per (side backed, favourite/underdog role)."""
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


def build(rows, baseline):
    """One record per gradeable game: features + both targets."""
    recs = []
    for r in rows:
        p = composite_pred(r)
        if p is None:
            continue
        o, c = r["open_spread"], r["close_spread"]
        if o == 0:                       # pick'em: no fav/dog role to adjust
            continue
        lean = p - (-o)
        if abs(lean) < 1e-9:
            continue
        bh = lean > 0

        cm = comp_map(r)
        allv = list(cm.values())
        survv = [cm[s] for s in SURVIVORS]
        opener_margin = -o
        dir_all = [1 if (v > opener_margin) == bh else 0 for v in allv]
        dir_surv = [1 if (v > opener_margin) == bh else 0 for v in survv]
        sim = r.get("sim")
        if sim and sim.get("back_home") is not None:
            sim_ag = 1.0 if sim["back_home"] == bh else 0.0
        else:
            sim_ag = 0.5

        # Target A: double-adjusted CLV, signed toward the backed side.
        raw_clv = (o if bh else -o) - (c if bh else -c)
        role = "fav" if (bh and o < 0) or (not bh and o > 0) else "dog"
        adj_clv = raw_clv - baseline[("home" if bh else "away", role)]

        # Target B: covered at the opener. Pushes are not gradeable.
        margin_vs_open = r["actual_margin"] + o
        covered = None if margin_vs_open == 0 else (bh == (margin_vs_open > 0))

        recs.append({
            "season": r["_s"], "week": r["week"], "home": r["home"], "away": r["away"],
            "feat": {
                "week": float(r["week"]),
                "abs_open_spread": abs(o),
                "abs_lean": abs(lean),
                "disp_all": st.pstdev(allv) if len(allv) > 1 else 0.0,
                "disp_surv": st.pstdev(survv),
                "dir_frac_all": sum(dir_all) / len(dir_all) if dir_all else 0.5,
                "dir_frac_surv": sum(dir_surv) / len(dir_surv),
                "sim_agrees": sim_ag,
                "n_comp_avail": float(len(allv)),
            },
            "adj_clv": adj_clv, "covered": covered,
        })
    return recs


def matrix(recs):
    return np.array([[r["feat"][f] for f in FEATURES] for r in recs], dtype=float)


def ridge_fit(X, y, lam=1.0):
    """Closed-form ridge on standardized X with an unpenalized intercept."""
    n, k = X.shape
    Xb = np.hstack([np.ones((n, 1)), X])
    P = np.eye(k + 1) * lam
    P[0, 0] = 0.0
    return np.linalg.solve(Xb.T @ Xb + P, Xb.T @ y)


def logistic_fit(X, y, lam=1.0, iters=60):
    """IRLS / Newton with a ridge penalty, intercept unpenalized."""
    n, k = X.shape
    Xb = np.hstack([np.ones((n, 1)), X])
    w = np.zeros(k + 1)
    P = np.eye(k + 1) * lam
    P[0, 0] = 0.0
    for _ in range(iters):
        eta = np.clip(Xb @ w, -30, 30)
        mu = 1.0 / (1.0 + np.exp(-eta))
        s = np.clip(mu * (1 - mu), 1e-8, None)
        grad = Xb.T @ (y - mu) - P @ w
        H = Xb.T @ (Xb * s[:, None]) + P
        step = np.linalg.solve(H, grad)
        w += step
        if np.max(np.abs(step)) < 1e-9:
            break
    return w


def predict(w, X):
    return np.hstack([np.ones((X.shape[0], 1)), X]) @ w


def auc(scores, labels):
    """Mann-Whitney U, with ties at half credit."""
    pos = scores[labels == 1]
    neg = scores[labels == 0]
    if len(pos) == 0 or len(neg) == 0:
        return None
    order = np.argsort(np.concatenate([pos, neg]), kind="mergesort")
    allv = np.concatenate([pos, neg])[order]
    ranks = np.empty(len(allv), dtype=float)
    i = 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1] == allv[i]:
            j += 1
        ranks[i:j + 1] = (i + j) / 2.0 + 1.0
        i = j + 1
    back = np.empty(len(allv), dtype=float)
    back[order] = ranks
    rp = back[:len(pos)].sum()
    return (rp - len(pos) * (len(pos) + 1) / 2.0) / (len(pos) * len(neg))


def auc_ci(scores, labels, boots=2000):
    vals = []
    n = len(scores)
    for _ in range(boots):
        idx = RNG.integers(0, n, n)
        a = auc(scores[idx], labels[idx])
        if a is not None:
            vals.append(a)
    if not vals:
        return (None, None)
    return (float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5)))


def clustered(recs):
    """Mean adjusted CLV with week-clustered SE. Games in one week share
    market state, so they are not independent observations."""
    if not recs:
        return None
    clusters = {}
    for r in recs:
        clusters.setdefault((r["season"], r["week"]), []).append(r["adj_clv"])
    if len(clusters) < 3:
        return None
    cm = [st.mean(v) for v in clusters.values()]
    se = st.stdev(cm) / math.sqrt(len(cm))
    m = st.mean([r["adj_clv"] for r in recs])
    z = m / se if se else None
    p = math.erfc(abs(z) / math.sqrt(2)) if z is not None else None
    return {"n": len(recs), "mean_clv": m, "z": z, "p": p}


def wilson(k, n, z=1.96):
    if n == 0:
        return (None, None)
    ph = k / n
    d = 1 + z * z / n
    c = ph + z * z / (2 * n)
    h = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def quartile_report(test, scores, label):
    """Split held-out games into quartiles of a confidence score and report
    what each quartile actually did, on both targets."""
    order = np.argsort(scores, kind="mergesort")
    q = len(order) // 4
    out = []
    for i in range(4):
        idx = order[i * q:(i + 1) * q] if i < 3 else order[i * q:]
        sub = [test[j] for j in idx]
        cl = clustered(sub)
        graded = [r for r in sub if r["covered"] is not None]
        k = sum(1 for r in graded if r["covered"])
        lo, hi = wilson(k, len(graded))
        out.append({
            "quartile": i + 1, "n": len(sub),
            "mean_score": float(np.mean(scores[idx])),
            "mean_adj_clv": cl["mean_clv"] if cl else None,
            "z": cl["z"] if cl else None, "p": cl["p"] if cl else None,
            "ats_n": len(graded), "ats_wins": k,
            "ats_rate": k / len(graded) if graded else None,
            "ats_ci": [lo, hi],
        })
    return {"label": label, "quartiles": out}


def holm(pairs):
    """pairs = [(name, p)]. Returns name -> (p, corrected_alpha, passes)."""
    live = sorted([x for x in pairs if x[1] is not None], key=lambda t: t[1])
    m = len(live)
    res, blocked = {}, False
    for i, (name, p) in enumerate(live):
        a = 0.05 / (m - i)
        ok = (p <= a + 1e-12) and not blocked
        if not ok:
            blocked = True
        res[name] = {"p": p, "alpha": a, "passes": ok}
    return res


def main():
    fit_rows, test_rows = load(FIT_SEASONS), load(TEST_SEASONS)
    baseline = four_bucket_baseline(fit_rows)          # FIT-ONLY, no peeking
    fit = build(fit_rows, baseline)
    test = build(test_rows, baseline)
    print(f"fit games {len(fit)} ({FIT_SEASONS})   held-out games {len(test)} ({TEST_SEASONS})")
    print("4-bucket baseline from fit seasons:",
          {f"{k[0]}/{k[1]}": round(v, 3) for k, v in baseline.items()})

    Xf, Xt = matrix(fit), matrix(test)
    mu, sd = Xf.mean(axis=0), Xf.std(axis=0)
    sd[sd == 0] = 1.0
    Zf, Zt = (Xf - mu) / sd, (Xt - mu) / sd          # standardize on FIT only

    # ---- Target A: predict double-adjusted CLV (continuous) --------------
    ya = np.array([r["adj_clv"] for r in fit])
    wa = ridge_fit(Zf, ya, lam=10.0)
    score_a = predict(wa, Zt)

    # ---- Target B: predict "did it cover" (binary) -----------------------
    gb = [i for i, r in enumerate(fit) if r["covered"] is not None]
    yb = np.array([1.0 if fit[i]["covered"] else 0.0 for i in gb])
    wb = logistic_fit(Zf[gb], yb, lam=10.0)
    score_b = 1.0 / (1.0 + np.exp(-np.clip(predict(wb, Zt), -30, 30)))

    result = {
        "generated": "2026-09-16", "fit_seasons": list(FIT_SEASONS),
        "test_seasons": list(TEST_SEASONS), "n_fit": len(fit), "n_test": len(test),
        "features": FEATURES, "excluded_contaminated": sorted(CONTAMINATED),
        "baseline_from_fit": {f"{k[0]}/{k[1]}": v for k, v in baseline.items()},
        "ridge_coefs": dict(zip(["intercept"] + FEATURES, [float(x) for x in wa])),
        "logit_coefs": dict(zip(["intercept"] + FEATURES, [float(x) for x in wb])),
    }

    print("\n=== ridge coefficients (standardized; target = adjusted CLV) ===")
    for name, v in zip(["intercept"] + FEATURES, wa):
        print(f"  {name:18s} {v:+.4f}")

    # ---- PRIMARY: quartiles by learned CLV score ------------------------
    print("\n=== PRIMARY: held-out 2024, quartiles by LEARNED confidence (target A) ===")
    qa = quartile_report(test, score_a, "learned_clv_model")
    for q in qa["quartiles"]:
        print(f"  Q{q['quartile']} n={q['n']:3d}  mean adj CLV={q['mean_adj_clv']:+.3f} pts  "
              f"z={q['z']:+.2f}  p={q['p']:.3f}   ATS {q['ats_rate']*100:.1f}% ({q['ats_wins']}/{q['ats_n']})")
    result["primary_learned"] = qa

    # ---- SECONDARY: binary discrimination -------------------------------
    gt = [i for i, r in enumerate(test) if r["covered"] is not None]
    lab = np.array([1 if test[i]["covered"] else 0 for i in gt])
    sb = score_b[gt]
    a_val = auc(sb, lab)
    a_lo, a_hi = auc_ci(sb, lab)
    print(f"\n=== SECONDARY: out-of-sample AUC (target B) ===")
    print(f"  AUC = {a_val:.3f}   bootstrap 95% CI [{a_lo:.3f}, {a_hi:.3f}]   n={len(lab)}")
    result["secondary_auc"] = {"auc": a_val, "ci": [a_lo, a_hi], "n": int(len(lab))}

    # ---- CALIBRATION: predicted vs realized, quintiles -------------------
    print("\n=== CALIBRATION: predicted vs realized cover rate, held-out quintiles ===")
    order = np.argsort(sb, kind="mergesort")
    qn = len(order) // 5
    cal = []
    for i in range(5):
        idx = order[i * qn:(i + 1) * qn] if i < 4 else order[i * qn:]
        pr, re_ = float(np.mean(sb[idx])), float(np.mean(lab[idx]))
        cal.append({"bin": i + 1, "n": int(len(idx)), "predicted": pr, "realized": re_})
        print(f"  bin {i+1}  n={len(idx):3d}  predicted {pr*100:5.1f}%   realized {re_*100:5.1f}%")
    pv = np.array([c["predicted"] for c in cal])
    rv = np.array([c["realized"] for c in cal])
    slope = float(np.polyfit(pv, rv, 1)[0]) if np.std(pv) > 0 else None
    print(f"  reliability slope = {slope:+.3f}  (want clearly positive; 1.0 = perfectly calibrated)")
    result["calibration"] = {"bins": cal, "slope": slope}

    # ---- REFERENCE SIGNALS on the same held-out games -------------------
    print("\n=== REFERENCE: same held-out games, simple signals ===")
    refs = {}
    for name, sc in [
        ("abs_lean_alone", np.array([r["feat"]["abs_lean"] for r in test])),
        ("low_disagreement", -np.array([r["feat"]["disp_all"] for r in test])),
    ]:
        rep = quartile_report(test, sc, name)
        refs[name] = rep
        top = rep["quartiles"][-1]
        print(f"  {name:18s} top quartile: adj CLV={top['mean_adj_clv']:+.3f} z={top['z']:+.2f} "
              f"p={top['p']:.3f}  ATS {top['ats_rate']*100:.1f}%")
    result["reference_signals"] = refs

    # ---- Preregistered verdicts, Holm-corrected -------------------------
    topq = qa["quartiles"][-1]
    botq = qa["quartiles"][0]
    fam = [("primary_top_quartile_clv", topq["p"]),
           ("reference_low_disagreement", refs["low_disagreement"]["quartiles"][-1]["p"]),
           ("reference_abs_lean", refs["abs_lean_alone"]["quartiles"][-1]["p"])]
    hres = holm(fam)
    print("\n=== Holm correction across the primary family (3 tests) ===")
    for k, v in sorted(hres.items(), key=lambda t: t[1]["p"]):
        print(f"  {k:32s} p={v['p']:.4f}  alpha={v['alpha']:.4f}  {'PASS' if v['passes'] else 'fail'}")
    result["holm"] = hres

    primary_pass = (topq["mean_adj_clv"] is not None and topq["mean_adj_clv"] > 0
                    and topq["z"] is not None and abs(topq["z"]) > 1.96
                    and hres.get("primary_top_quartile_clv", {}).get("passes", False)
                    and topq["mean_adj_clv"] > botq["mean_adj_clv"])
    secondary_pass = (a_val is not None and a_val > 0.55 and a_lo is not None and a_lo > 0.50)
    calib_pass = slope is not None and slope > 0

    print("\n=== PREREGISTERED VERDICT ===")
    print(f"  PRIMARY   (top-quartile adj CLV > 0, |z|>1.96, Holm-pass, beats bottom): "
          f"{'PASS' if primary_pass else 'FAIL'}")
    print(f"  SECONDARY (AUC > 0.55, CI excludes 0.50):                                "
          f"{'PASS' if secondary_pass else 'FAIL'}")
    print(f"  CALIBRATION (positive reliability slope):                                "
          f"{'PASS' if calib_pass else 'FAIL'}")
    result["verdict"] = {"primary": bool(primary_pass), "secondary": bool(secondary_pass),
                         "calibration": bool(calib_pass)}

    def jsonable(o):
        if isinstance(o, (np.bool_,)):
            return bool(o)
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return float(o)
        raise TypeError(f"not serializable: {type(o)}")

    OUT.write_text(json.dumps(result, indent=2, default=jsonable))
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
