#!/usr/bin/env python3
"""E-XGB phase 1: exploratory per-position tree models vs baselines (NOTHING IS SERVED).

Reads the panel from scripts/eval/exgb_panel.py and compares, per position (QB/RB/WR/TE):
  model     XGBoost and LightGBM, standalone (no ESPN input). Train 2022-2023, early-stop and
            pick settings on 2024, refit 2022-2024 at the chosen size, test on 2025.
  trailing  the player's season-to-date mean of earlier games (else last season's per-game
            mean, else the position's training mean).
  ESPN      2025: RETROSPECTIVE, not frozen - fetched in 2026 after the games by
            scripts/eval/exgb-espn-retro.mjs, exactly the Princeton thesis's weakness. Nothing
            proves these equal what ESPN showed before kickoff.
  current   our weekly projection (weekly_prediction_snapshots), where historical values exist
            (2026 week 2 only), with 2026 weeks 1-2 as a second, tiny test set.

Needs xgboost + lightgbm (scripts/eval/requirements-exgb.txt); run with that environment:
  ~/gridiron-local/venv-ml/bin/python scripts/eval/exgb_models.py --panel <panel.npz> \
      --db <copy.sqlite> --espn-retro <espn-retro-2025.json> [--espn-retro <espn-retro-2026.json>] --out <results.json>
"""
from __future__ import annotations

import argparse
import itertools
import json
import os
import sqlite3
import sys

import numpy as np

POSITIONS = ('QB', 'RB', 'WR', 'TE')
SEED = 20260925
LIVE_DB = os.path.join(os.path.expanduser('~'), 'gridiron-local', 'data.sqlite')


def mae(y, p):
    return float(np.mean(np.abs(y - p))) if len(y) else float('nan')


def rmse(y, p):
    return float(np.sqrt(np.mean((y - p) ** 2))) if len(y) else float('nan')


def trailing_mean(X, names, fallback):
    f = X[:, names.index('std_ppr')].copy()
    prev = X[:, names.index('prev_season_ppg')]
    f = np.where(np.isnan(f), prev, f)
    return np.where(np.isnan(f), fallback, f)


def fit_xgb(Xtr, ytr, Xva, yva):
    import xgboost as xgb
    best = None
    for obj, depth in itertools.product(('reg:squarederror', 'reg:absoluteerror'), (3, 4, 5)):
        m = xgb.XGBRegressor(n_estimators=3000, learning_rate=0.05, max_depth=depth, subsample=0.8,
                             colsample_bytree=0.8, min_child_weight=5, objective=obj, eval_metric='mae',
                             early_stopping_rounds=100, n_jobs=2, random_state=SEED, tree_method='hist')
        m.fit(Xtr, ytr, eval_set=[(Xva, yva)], verbose=False)
        score = mae(yva, m.predict(Xva, iteration_range=(0, m.best_iteration + 1)))
        if best is None or score < best[0]:
            best = (score, {'objective': obj, 'max_depth': depth, 'n_estimators': int(m.best_iteration + 1)})
    return best


def refit_xgb(params, X, y):
    import xgboost as xgb
    m = xgb.XGBRegressor(learning_rate=0.05, subsample=0.8, colsample_bytree=0.8, min_child_weight=5,
                         n_jobs=2, random_state=SEED, tree_method='hist', **params)
    return m.fit(X, y, verbose=False)


def fit_lgbm(Xtr, ytr, Xva, yva):
    import lightgbm as lgb
    best = None
    for obj, leaves in itertools.product(('l2', 'l1'), (7, 15, 31)):
        m = lgb.LGBMRegressor(n_estimators=3000, learning_rate=0.05, num_leaves=leaves, min_child_samples=20,
                              subsample=0.8, subsample_freq=1, colsample_bytree=0.8, objective=obj,
                              random_state=SEED, n_jobs=2, verbose=-1)
        m.fit(Xtr, ytr, eval_X=(Xva,), eval_y=(yva,), eval_metric='l1',
              callbacks=[lgb.early_stopping(100, verbose=False)])
        score = mae(yva, m.predict(Xva, num_iteration=m.best_iteration_))
        if best is None or score < best[0]:
            best = (score, {'objective': obj, 'num_leaves': leaves, 'n_estimators': int(m.best_iteration_ or 3000)})
    return best


def refit_lgbm(params, X, y):
    import lightgbm as lgb
    m = lgb.LGBMRegressor(learning_rate=0.05, min_child_samples=20, subsample=0.8, subsample_freq=1,
                          colsample_bytree=0.8, random_state=SEED, n_jobs=2, verbose=-1, **params)
    return m.fit(X, y)


def load_espn_retro(paths):
    out = {}
    for p in paths:
        with open(p) as f:
            d = json.load(f)
        assert 'RETROSPECTIVE' in d.get('label', ''), f'{p} is not labelled retrospective'
        for r in d['rows']:
            out[(int(r['espn_id']), int(r['season']), int(r['week']))] = float(r['projected_pts'])
    return out


def load_current_and_frozen(db):
    if os.path.realpath(db) == os.path.realpath(LIVE_DB):
        raise SystemExit('refusing the live database; pass a copy')
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    cur = {(r[0], r[1], r[2]): float(r[3]) for r in con.execute(
        'SELECT player_id, season, week, prediction FROM weekly_prediction_snapshots')}
    # The one pre-kickoff ESPN capture that predates E-XGB: week 2 of 2026, 2026-09-17 22:08Z,
    # before that week's first kickoff (Thursday 20:15 ET = 00:15Z on 09-18).
    frozen = {(int(r[0]), int(r[1]), int(r[2])): float(r[3]) for r in con.execute(
        """SELECT espn_id, season, week, week_proj FROM espn_player_market_weekly
           WHERE week_proj IS NOT NULL AND is_live_capture = 1 AND captured_at < '2026-09-18T00:15:00Z'""")}
    con.close()
    return cur, frozen


def compare(y, arms, mask=None):
    out = {}
    for name, p in arms.items():
        m = ~np.isnan(p) if mask is None else (~np.isnan(p) & mask)
        out[name] = m
    common = np.logical_and.reduce(list(out.values()))
    res = {'n': int(common.sum())}
    for name, p in arms.items():
        res[f'{name}_mae'] = round(mae(y[common], p[common]), 3)
        res[f'{name}_rmse'] = round(rmse(y[common], p[common]), 3)
    return res, common


def weekly_wins(y, weeks, a, b, mask):
    wins = total = 0
    for w in np.unique(weeks[mask]):
        k = mask & (weeks == w)
        total += 1
        wins += int(mae(y[k], a[k]) < mae(y[k], b[k]))
    return f'{wins}/{total}'


def run(panel_path, db, espn_paths, out_path):
    p = np.load(panel_path)
    X, y, played, meta = p['X'], p['y'], p['played'].astype(bool), p['meta']
    names = [str(n) for n in p['feature_names']]
    season, week, pos = meta[:, 2].astype(int), meta[:, 3].astype(int), meta[:, 4].astype(int)
    pid, espn = meta[:, 0].astype(int), meta[:, 1].astype(int)
    espn_retro = load_espn_retro(espn_paths)
    current, frozen = load_current_and_frozen(db)
    espn_p = np.array([espn_retro.get((e, s, w), np.nan) for e, s, w in zip(espn, season, week)])
    cur_p = np.array([current.get((i, s, w), np.nan) for i, s, w in zip(pid, season, week)])
    frz_p = np.array([frozen.get((e, s, w), np.nan) for e, s, w in zip(espn, season, week)])
    results = {'panel_rows': int(len(y)), 'positions': {}}
    for k, name in enumerate(POSITIONS):
        at = pos == k
        tr, va, te = at & (season <= 2023), at & (season == 2024), at & (season == 2025)
        full, t26 = at & (season <= 2024), at & (season == 2026)
        fallback = float(np.mean(y[tr]))
        xs, xp = fit_xgb(X[tr], y[tr], X[va], y[va])
        ls, lp = fit_lgbm(X[tr], y[tr], X[va], y[va])
        xgb_m, lgb_m = refit_xgb(xp, X[full], y[full]), refit_lgbm(lp, X[full], y[full])
        trail = trailing_mean(X, names, fallback)
        pr = {'xgb': xgb_m.predict(X), 'lgbm': lgb_m.predict(X), 'trailing': trail}
        r = {'validation_2024': {'xgb_mae': round(xs, 3), 'xgb_params': xp, 'lgbm_mae': round(ls, 3), 'lgbm_params': lp}}
        r['test_2025_all'], _ = compare(y, {a: np.where(te, v, np.nan) for a, v in pr.items()})
        r['test_2025_played_only'], _ = compare(y, {a: np.where(te & played, v, np.nan) for a, v in pr.items()})
        arms_espn = {**{a: np.where(te, v, np.nan) for a, v in pr.items()}, 'espn_retro': np.where(te, espn_p, np.nan)}
        r['test_2025_vs_espn_RETROSPECTIVE_not_frozen'], common = compare(y, arms_espn)
        r['test_2025_vs_espn_RETROSPECTIVE_not_frozen']['weeks_xgb_beats_espn'] = weekly_wins(
            y, week, pr['xgb'], espn_p, common)
        # 2026 weeks 1-2: models refit on 2022-2025 would be the honest version; the 2022-2024
        # fit is used here as-is (tiny n, exploratory only).
        arms26 = {**{a: np.where(t26, v, np.nan) for a, v in pr.items()},
                  'espn_retro': np.where(t26, espn_p, np.nan), 'current': np.where(t26, cur_p, np.nan)}
        r['test_2026_w1_2_vs_current_and_espn_retro'], _ = compare(y, arms26)
        arms_fz = {**{a: np.where(t26, v, np.nan) for a, v in pr.items()}, 'espn_frozen_w2': np.where(t26, frz_p, np.nan),
                   'current': np.where(t26, cur_p, np.nan)}
        r['test_2026_w2_vs_frozen_espn_capture'], _ = compare(y, arms_fz)
        top = np.argsort(-xgb_m.feature_importances_)[:8]
        r['xgb_top_features'] = [names[i] for i in top]
        results['positions'][name] = r
        print(json.dumps({name: {kk: vv for kk, vv in r.items() if kk.startswith('test_2025')}}), flush=True)
    with open(out_path, 'w') as f:
        json.dump(results, f, indent=1)
    return results


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--panel', required=True)
    ap.add_argument('--db', required=True)
    ap.add_argument('--espn-retro', action='append', default=[])
    ap.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    run(a.panel, a.db, a.espn_retro, a.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
