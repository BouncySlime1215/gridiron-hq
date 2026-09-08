"""A leakage scanner, run for real on every experiment, not just in a test.

The chronological fold discipline in market_lab.py (time_folds, the outer-season
cutoff, the label embargo) protects against ONE kind of leak: mixing rows across
time so a model trains on data from after the moment it is meant to predict.
It does not protect against a SECOND kind: a feature column that was, by
construction, computed from information only available after the decision
time -- the closing line captured as a "feature", or the label itself copied
into a column under a different name. Chronological folds cannot see that;
the row's timestamp is honest even when one of its numbers is not.

This module is the check for the second kind. `detect_feature_leakage` fits a
single-feature model per column, per fold, using the SAME chronological folds
the real experiment uses, and flags any feature whose out-of-fold performance
is implausibly close to perfect. A feature that alone predicts the label to
five decimal places is not a strong signal; on a target this noisy it is
almost always the label wearing a different name.

This is a heuristic, not a proof. A feature could leak weakly (a same-day news
reaction folded into a "prior" average with the wrong publication delay,
say) without tripping a single-feature threshold. It catches the sharp case
the master plan's "done when" bar asks for: prove the pipeline would catch a
leak if one existed. research/test_tree_lab.py exercises it against a
synthetic leak; tree_lab.py's run() calls it against the real dataset too.
"""
from __future__ import annotations
import numpy as np
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import r2_score, roc_auc_score

LEAKAGE_VERSION = 'leakage-scan-v1'


def _fold_r2(values, y, folds):
    scores = []
    for tr, va in folds:
        xt, xv = values[tr].reshape(-1, 1), values[va].reshape(-1, 1)
        yt, yv = y[tr], y[va]
        if not np.isfinite(xt).all() or np.unique(xt).size < 2:
            continue
        model = LinearRegression().fit(xt, yt)
        pred = model.predict(xv)
        if np.unique(yv).size < 2:
            continue
        scores.append(r2_score(yv, pred))
    return float(np.mean(scores)) if scores else None


def _fold_auc(values, y, folds):
    scores = []
    for tr, va in folds:
        xt, xv = values[tr].reshape(-1, 1), values[va].reshape(-1, 1)
        yt, yv = y[tr], y[va]
        if not np.isfinite(xt).all() or np.unique(xt).size < 2 or np.unique(yt).size < 2:
            continue
        model = LogisticRegression(max_iter=200).fit(xt, yt)
        proba = model.predict_proba(xv)[:, 1]
        if np.unique(yv).size < 2:
            continue
        scores.append(roc_auc_score(yv, proba))
    return float(np.mean(scores)) if scores else None


def detect_feature_leakage(X, y, folds, feature_names, *, task='regression',
                            r2_threshold=0.98, auc_threshold=0.985, min_folds=2):
    """Flag columns whose single-feature out-of-fold skill looks like a leak.

    `X` is a 2D array (rows x features), `y` the label array, `folds` the exact
    chronological (train_idx, val_idx) pairs the real experiment fits on --
    reusing them here is the point: a feature that only leaks when combined
    with the honest folds (rather than some other split) still gets caught.
    `task` is 'regression' or 'classification'. Returns a report dict with a
    `flagged` list (never silently dropped -- the caller decides what to do)
    and the raw per-feature score for every column, so a run's report can show
    the near-misses too.
    """
    if len(folds) < min_folds:
        return {'version': LEAKAGE_VERSION, 'task': task, 'folds_used': len(folds),
                'skipped': True, 'reason': f'fewer than {min_folds} folds available', 'features': [], 'flagged': []}
    X = np.asarray(X, dtype=float)
    y = np.asarray(y)
    features = []
    for i, name in enumerate(feature_names):
        col = X[:, i]
        if task == 'classification':
            score = _fold_auc(col, y, folds)
            flagged = score is not None and score >= auc_threshold
            metric = 'auc'
        else:
            score = _fold_r2(col, y, folds)
            flagged = score is not None and score >= r2_threshold
            metric = 'r2'
        features.append({'feature': name, 'metric': metric, 'score': score, 'flagged': bool(flagged)})
    flagged = [f['feature'] for f in features if f['flagged']]
    return {'version': LEAKAGE_VERSION, 'task': task, 'folds_used': len(folds),
            'skipped': False, 'r2_threshold': r2_threshold, 'auc_threshold': auc_threshold,
            'features': features, 'flagged': flagged}
