"""
Independent calibration cross-check: MAPIE vs the hand-rolled split-conformal
code in server/services/model-intelligence.py's JS twin (`uncertainty()`).

Giant Plan section 7.3 / FIX #26. The argument for doing this at all is narrow
and specific: this codebase had six hand-rolled numeric bugs found in one file,
so a hand-rolled conformal implementation deserves a second opinion from a
library that many people have reviewed. MAPIE is that second opinion.

This script is research-only. It is NOT imported by the Node app, nothing in
package.json depends on it, and it writes no production pointer. It reads the
panel exported by export-residuals.mjs -- the same predicted/actual rows the JS
side scores -- and re-derives the intervals with MAPIE on identical numbers.

    research/.venv/bin/python research/conformal/mapie_crosscheck.py \
        --panel /tmp/gridiron-m7-out/panel.json \
        --js    /tmp/gridiron-m7-out/js-uncertainty.json \
        --out   /tmp/gridiron-m7-out/mapie-crosscheck.json

What is being compared, precisely
---------------------------------
The JS builds a split-conformal interval per outer fold: calibrate the absolute
residual |y - yhat| on every EARLIER evaluation season, take its p-quantile,
and apply that half-width to the current season. MAPIE is handed exactly the
same calibration rows and the same test rows, with a pass-through estimator so
that no model refitting can make the two disagree for an uninteresting reason.
Any disagreement that survives is a disagreement about the conformal maths.
"""

import argparse
import json
import math
import warnings

import numpy as np
from sklearn.base import BaseEstimator, RegressorMixin
from mapie.regression import SplitConformalRegressor


class PassThrough(RegressorMixin, BaseEstimator):
    """An estimator whose prediction IS the stored prediction.

    The point of the cross-check is the conformal layer, not the point model.
    Feeding MAPIE a fresh regressor would let a fitting difference masquerade
    as a conformal difference, so the single feature column carries yhat and
    this returns it untouched.
    """

    def fit(self, X, y=None):
        self.is_fitted_ = True
        # MAPIE sniffs for these to decide an estimator is really fitted; set
        # them so the cross-check output is not buried in spurious warnings.
        self.n_features_in_ = 1
        self.fitted_ = True
        return self

    def predict(self, X):
        return np.asarray(X, dtype=float).ravel()

    def __sklearn_is_fitted__(self):
        return True


def js_quantile(values, p):
    """A line-for-line port of the `quantile` helper in model-intelligence.js.

    Reproduced here so the report can attribute any gap to a named line of the
    shipped code rather than to 'numpy does it differently'. It is the plain
    linear-interpolated empirical quantile: index (n-1)*p, no (n+1) term.
    """
    if len(values) == 0:
        return None
    a = sorted(values)
    i = (len(a) - 1) * p
    lo, hi = math.floor(i), math.ceil(i)
    return a[lo] + (a[hi] - a[lo]) * (i - lo)


def order_statistic_halfwidth(abs_scores, p):
    """The textbook split-conformal half-width: the ceil((n+1)p)-th order
    statistic of the calibration scores.

    Included so the report can ATTRIBUTE any MAPIE/JS gap to a named formula
    instead of leaving it as an unexplained library difference. Verified below
    to reproduce MAPIE's own half-width exactly on every fold and level.
    """
    a = sorted(abs_scores)
    n = len(a)
    k = min(math.ceil((n + 1) * p), n)
    return a[k - 1]


def mapie_halfwidth(pred_cal, y_cal, pred_test, confidence_level):
    """MAPIE's interval for one fold. Returns (lower, upper, half-widths)."""
    scr = SplitConformalRegressor(
        estimator=PassThrough().fit(np.zeros((1, 1)), np.zeros(1)),
        confidence_level=confidence_level,
        conformity_score="absolute",
        prefit=True,
    )
    scr.conformalize(pred_cal.reshape(-1, 1), y_cal)
    _, intervals = scr.predict_interval(pred_test.reshape(-1, 1))
    lo = intervals[:, 0, 0]
    hi = intervals[:, 1, 0]
    return lo, hi, (hi - lo) / 2.0


def run_target(rows, seasons, pred_key, actual_key, levels):
    """One target (margin or total) across every chronological outer fold."""
    folds = []
    for season in seasons:
        cal = [r for r in rows if r["season"] < season]
        test = [r for r in rows if r["season"] == season]
        if not cal or not test:
            # Matches the JS guard: the first evaluation season has no earlier
            # outer fold to calibrate on, so it is not graded.
            continue

        pred_cal = np.array([r[pred_key] for r in cal], float)
        y_cal = np.array([r[actual_key] for r in cal], float)
        pred_test = np.array([r[pred_key] for r in test], float)
        y_test = np.array([r[actual_key] for r in test], float)
        abs_cal = np.abs(y_cal - pred_cal)
        abs_test = np.abs(y_test - pred_test)

        entry = {"season": season, "n_cal": len(cal), "n_test": len(test)}
        for level in levels:
            p = level / 100.0
            lo, hi, half = mapie_halfwidth(pred_cal, y_cal, pred_test, p)
            m_cov = float(np.mean((y_test >= lo) & (y_test <= hi)))
            m_half = float(np.mean(half))

            # The shipped JS path, recomputed on the identical arrays.
            j_half = js_quantile(list(abs_cal), p)
            j_cov = float(np.mean(abs_test <= j_half))

            # What the textbook finite-sample correction asks for, so the gap
            # can be attributed rather than merely observed.
            n = len(abs_cal)
            adj = min(math.ceil((n + 1) * p) / n, 1.0)
            ref_half = order_statistic_halfwidth(list(abs_cal), p)
            entry[f"level_{level}"] = {
                # True on every cell measured so far. If this ever goes False
                # the attribution below is no longer safe to quote, and the gap
                # must be re-diagnosed rather than re-explained.
                "mapie_matches_order_statistic": bool(abs(ref_half - m_half) < 1e-6),
                "order_statistic_halfwidth": round(float(ref_half), 4),
                "mapie_coverage": round(m_cov, 4),
                "js_coverage": round(j_cov, 4),
                "coverage_gap_mapie_minus_js": round(m_cov - j_cov, 4),
                "mapie_halfwidth": round(m_half, 4),
                "js_halfwidth": round(j_half, 4),
                "halfwidth_gap_mapie_minus_js": round(m_half - j_half, 4),
                "js_quantile_level": p,
                "finite_sample_quantile_level": round(adj, 5),
            }
        folds.append(entry)

    agg = {}
    for level in levels:
        key = f"level_{level}"
        graded = [f for f in folds if key in f]
        if not graded:
            continue
        w = np.array([f["n_test"] for f in graded], float)
        agg[key] = {
            # Pooled over games, and also the JS's own unweighted fold mean, so
            # the two aggregation choices cannot be confused for a real gap.
            "mapie_coverage_pooled": round(float(np.average([f[key]["mapie_coverage"] for f in graded], weights=w)), 4),
            "js_coverage_pooled": round(float(np.average([f[key]["js_coverage"] for f in graded], weights=w)), 4),
            "mapie_coverage_fold_mean": round(float(np.mean([f[key]["mapie_coverage"] for f in graded])), 4),
            "js_coverage_fold_mean": round(float(np.mean([f[key]["js_coverage"] for f in graded])), 4),
            "mapie_halfwidth_mean": round(float(np.mean([f[key]["mapie_halfwidth"] for f in graded])), 4),
            "js_halfwidth_mean": round(float(np.mean([f[key]["js_halfwidth"] for f in graded])), 4),
            "nominal": level / 100.0,
        }
    return {"folds": folds, "aggregate": agg}


def main():
    warnings.filterwarnings("ignore", message="Estimator does not appear fitted")
    ap = argparse.ArgumentParser()
    ap.add_argument("--panel", required=True)
    ap.add_argument("--js", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    panel = json.load(open(args.panel))
    js = json.load(open(args.js))
    rows = panel["rows"]
    seasons = sorted({r["season"] for r in rows})
    levels = [80, 95]

    report = {
        "what": "MAPIE vs hand-rolled split conformal, identical rows, identical folds",
        "mapie_version": __import__("mapie").__version__,
        "data_source": panel.get("source"),
        "data_caveat": (
            "Coverage numbers here characterise the IMPLEMENTATIONS, not the NFL. "
            "The panel is the deterministic fixture league, because the real "
            "server/data.sqlite is out of scope for this worktree."
        ),
        "n_rows": len(rows),
        "evaluation_seasons": panel.get("evaluation_seasons"),
        "margin": run_target(rows, seasons, "pred_margin", "actual_margin", levels),
        "total": run_target(rows, seasons, "pred_total", "actual_total", levels),
        "js_published_aggregate": js.get("aggregate"),
    }

    # A blunt verdict line, because "they broadly agree" is the kind of summary
    # that hides exactly the bug this check exists to find.
    findings = []
    for target in ("margin", "total"):
        for level in levels:
            a = report[target]["aggregate"].get(f"level_{level}")
            if not a:
                continue
            dc = a["mapie_coverage_pooled"] - a["js_coverage_pooled"]
            dw = a["mapie_halfwidth_mean"] - a["js_halfwidth_mean"]
            findings.append({
                "target": target,
                "level": level,
                "coverage_gap": round(dc, 4),
                "halfwidth_gap": round(dw, 4),
                "relative_halfwidth_gap": round(dw / a["js_halfwidth_mean"], 4) if a["js_halfwidth_mean"] else None,
                "materially_different": bool(abs(dc) > 0.01 or (a["js_halfwidth_mean"] and abs(dw) / a["js_halfwidth_mean"] > 0.01)),
            })
    attributed = all(
        cell["mapie_matches_order_statistic"]
        for target in ("margin", "total")
        for fold in report[target]["folds"]
        for key, cell in fold.items()
        if key.startswith("level_")
    )
    report["verdict"] = {
        "any_material_disagreement": any(f["materially_different"] for f in findings),
        "gap_fully_attributed_to_finite_sample_correction": attributed,
        "per_target": findings,
        "note": (
            "MAPIE applies the finite-sample split-conformal correction -- the "
            "ceil((n+1)(1-alpha))/n quantile of the calibration scores. The JS "
            "`quantile(values, p)` helper in model-intelligence.js takes the "
            "plain empirical (1-alpha) quantile with no (n+1) term, so it is "
            "the anti-conservative variant: narrower intervals and coverage "
            "that sits below nominal in expectation. The gap shrinks as the "
            "calibration set grows and is largest at the 95% level."
        ),
    }

    json.dump(report, open(args.out, "w"), indent=2)

    print(f"MAPIE {report['mapie_version']} | rows={report['n_rows']} | {args.panel}")
    print(report["data_caveat"])
    for target in ("margin", "total"):
        for level in levels:
            a = report[target]["aggregate"].get(f"level_{level}")
            if not a:
                continue
            print(
                f"  {target:6s} @{level}%  coverage MAPIE {a['mapie_coverage_pooled']:.3f} "
                f"vs JS {a['js_coverage_pooled']:.3f}   "
                f"half-width MAPIE {a['mapie_halfwidth_mean']:.3f} vs JS {a['js_halfwidth_mean']:.3f}"
            )
    print(f"material disagreement: {report['verdict']['any_material_disagreement']}")
    print("gap fully attributed to the finite-sample correction: "
          f"{report['verdict']['gap_fully_attributed_to_finite_sample_correction']}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
