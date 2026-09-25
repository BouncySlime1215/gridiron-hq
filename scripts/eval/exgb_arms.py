"""E-XGB arms, shared by exgb_lock.py (settings), exgb_shadow.py (fit + predict) and tests.

Arms (docs/tdd/EXGB-PREREG.md and EXGB-PREREG-addendum-1.md):
  A     standalone XGBoost per position on the lagged panel, no ESPN input (primary);
        LightGBM on the same panel is the pre-specified secondary.
  B1    ESPN + lambda * (A - ESPN), lambda fitted on frozen ESPN weeks only.
  B2    ESPN + lambda * r(x, ESPN): r is an XGBoost model of (actual - ESPN) from the panel
        features plus ESPN's projection, PRETRAINED on RETROSPECTIVE ESPN (2022-2025, a
        labelled proxy); lambda, fitted on frozen ESPN weeks only, decides how much of the
        correction is trusted (0 = plain ESPN).

xgboost / lightgbm are imported lazily, so the pure parts run on stdlib + numpy.
"""
from __future__ import annotations

import itertools
import json
import os
import sqlite3

import numpy as np

POSITIONS = ('QB', 'RB', 'WR', 'TE')
SEED = 20260925
LEARNING_RATE = 0.05
MAX_TREES = 3000
EARLY_STOP = 100
FOLD_SEASONS = (2023, 2024, 2025)  # validate s, train on seasons < s (prereg section 1)
# 12 settings each, within the prereg's cap of 24.
XGB_GRID = [dict(objective=o, max_depth=d, min_child_weight=m) for o, d, m in itertools.product(
    ('reg:squarederror', 'reg:absoluteerror'), (3, 4, 5), (5, 20))]
LGBM_GRID = [dict(objective=o, num_leaves=n, min_child_samples=m) for o, n, m in itertools.product(
    ('l2', 'l1'), (7, 15, 31), (20, 50))]
LIVE_DB = os.path.join(os.path.expanduser('~'), 'gridiron-local', 'data.sqlite')
# Week 2's frozen ESPN capture predates E-XGB (espn_player_market_weekly, 2026-09-17 22:08Z);
# it counts only if taken before that week's first kickoff.
WEEK2_FIRST_KICKOFF = '2026-09-18T00:15:00Z'


def mae(y, p):
    return float(np.mean(np.abs(y - p))) if len(y) else float('nan')


def load_retro(paths):
    out = {}
    for p in paths:
        with open(p) as f:
            d = json.load(f)
        if 'RETROSPECTIVE' not in d.get('label', ''):
            raise ValueError(f'{p} is not labelled retrospective')
        for r in d['rows']:
            out[(int(r['espn_id']), int(r['season']), int(r['week']))] = float(r['projected_pts'])
    return out


def load_frozen(con, season, as_of=None):
    """(espn_id, season, week) -> the frozen PPR projection: the latest capture strictly before
    the player's own kickoff (and, when as_of is given, at or before as_of). Never a late row."""
    out = {}
    q = """SELECT espn_id, week, projected_pts, captured_at FROM espn_weekly_projection_snapshots
           WHERE season = ? AND scoring_key = 'ppr' AND late = 0 AND kickoff_at IS NOT NULL
             AND captured_at < kickoff_at"""
    args = [season]
    if as_of:
        q += ' AND captured_at <= ?'
        args.append(as_of)
    best = {}
    for e, w, p, at in con.execute(q + ' ORDER BY captured_at', args):
        best[(int(e), season, int(w))] = (at, float(p))
    has_week2 = con.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'espn_player_market_weekly'").fetchone()
    if has_week2 and season == 2026 and (as_of is None or as_of >= WEEK2_FIRST_KICKOFF):
        for e, p in con.execute("""SELECT espn_id, week_proj FROM espn_player_market_weekly
                                   WHERE season = 2026 AND week = 2 AND week_proj IS NOT NULL
                                     AND is_live_capture = 1 AND captured_at < ?""", (WEEK2_FIRST_KICKOFF,)):
            best.setdefault((int(e), 2026, 2), ('', float(p)))
    for k, (_, p) in best.items():
        out[k] = p
    return out


def open_ro(path):
    return sqlite3.connect(f'file:{path}?mode=ro', uri=True)


def espn_column(meta, table):
    return np.array([table.get((int(m[1]), int(m[2]), int(m[3])), np.nan) for m in meta])


def with_espn(X, espn):
    return np.column_stack([X, espn])


def _xgb(params, n_estimators=MAX_TREES, early=True):
    import xgboost as xgb
    kw = dict(n_estimators=n_estimators, learning_rate=LEARNING_RATE, subsample=0.8, colsample_bytree=0.8,
              n_jobs=2, random_state=SEED, tree_method='hist', eval_metric='mae', **params)
    if early:
        kw['early_stopping_rounds'] = EARLY_STOP
    return xgb.XGBRegressor(**kw)


def _lgbm(params, n_estimators=MAX_TREES):
    import lightgbm as lgb
    return lgb.LGBMRegressor(n_estimators=n_estimators, learning_rate=LEARNING_RATE, subsample=0.8,
                             subsample_freq=1, colsample_bytree=0.8, random_state=SEED, n_jobs=2,
                             verbose=-1, **params)


def fold_score(kind, params, X, y, season, mask):
    """Mean validation MAE and mean best size over the rolling-origin folds."""
    import lightgbm as lgb
    maes, sizes = [], []
    for s in FOLD_SEASONS:
        tr, va = mask & (season < s), mask & (season == s)
        if tr.sum() < 50 or va.sum() < 20:
            continue
        if kind == 'xgb':
            m = _xgb(params).fit(X[tr], y[tr], eval_set=[(X[va], y[va])], verbose=False)
            n = int(m.best_iteration + 1)
            p = m.predict(X[va], iteration_range=(0, n))
        else:
            m = _lgbm(params).fit(X[tr], y[tr], eval_X=(X[va],), eval_y=(y[va],), eval_metric='l1',
                                  callbacks=[lgb.early_stopping(EARLY_STOP, verbose=False)])
            n = int(m.best_iteration_ or MAX_TREES)
            p = m.predict(X[va], num_iteration=n)
        maes.append(mae(y[va], p))
        sizes.append(n)
    return float(np.mean(maes)), int(round(float(np.mean(sizes)))), [round(v, 4) for v in maes]


def select(kind, grid, X, y, season, mask):
    """The prereg rule: lowest mean rolling-origin validation MAE over the grid."""
    scored = []
    for params in grid:
        score, n, folds = fold_score(kind, params, X, y, season, mask)
        scored.append({'params': params, 'n_estimators': n, 'mean_val_mae': round(score, 4), 'fold_mae': folds})
    scored.sort(key=lambda r: r['mean_val_mae'])
    return scored[0], scored


def fit_final(kind, chosen, X, y):
    if kind == 'xgb':
        return _xgb(chosen['params'], n_estimators=chosen['n_estimators'], early=False).fit(X, y, verbose=False)
    return _lgbm(chosen['params'], n_estimators=chosen['n_estimators']).fit(X, y)


def fit_lambda(y, espn, target_pred):
    """lambda in [0, 1] (step 0.01) minimising sum |y - (espn + lambda * (target_pred - espn))|."""
    y, espn, target_pred = map(np.asarray, (y, espn, target_pred))
    if not len(y):
        return 0.0, None
    grid = np.round(np.arange(0, 1.0001, 0.01), 2)
    losses = [float(np.mean(np.abs(y - (espn + g * (target_pred - espn))))) for g in grid]
    i = int(np.argmin(losses))
    return float(grid[i]), round(losses[i], 4)


def blend(espn, target_pred, lam):
    return espn + lam * (target_pred - espn)
