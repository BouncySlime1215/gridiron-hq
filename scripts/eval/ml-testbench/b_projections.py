#!/usr/bin/env python3
"""ML-TESTBENCH section B: E-XGB rolling-origin backtest (docs/tdd/ML-TESTBENCH-PREREG.md).

For each test season S in {2024, 2025} and each week t: train on every panel row of the position
with season < S, or season = S and week < t; predict week t. Settings fixed at the phase-1
selections (no re-tuning). Arms: XGB, LGBM, trailing mean, ESPN RETRO (retrospective, NOT frozen),
B2 = ESPN RETRO + r(x, ESPN) with r an XGB model of (actual - ESPN RETRO), lambda = 1.
Smoke test: 2026 week 2 vs the frozen ESPN week-2 capture and our own snapshot.

Usage: python b_projections.py --panel panel.npz --db <copy.sqlite> --espn-retro <f> [...] --out b-results.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))  # scripts/eval: reuse exgb_models.py, unchanged
from exgb_models import load_current_and_frozen, load_espn_retro, trailing_mean  # noqa: E402
from tb_common import SEED, boot_indices, open_copy, r, verdict  # noqa: E402

POSITIONS = ('QB', 'RB', 'WR', 'TE')
# Phase-1 selections (docs/tdd/2026-09-25-exgb-retrospective.tdd.md), fixed by the prereg.
XGB = {'QB': ('reg:absoluteerror', 3, 251), 'RB': ('reg:absoluteerror', 5, 215),
       'WR': ('reg:absoluteerror', 4, 162), 'TE': ('reg:absoluteerror', 3, 176)}
LGBM = {'QB': ('l1', 7, 156), 'RB': ('l1', 15, 100), 'WR': ('l1', 15, 124), 'TE': ('l1', 7, 222)}
TEST_SEASONS = (2024, 2025)


def xgb_model(pos):
    import xgboost as xgb
    obj, depth, n = XGB[pos]
    return xgb.XGBRegressor(n_estimators=n, learning_rate=0.05, max_depth=depth, subsample=0.8, colsample_bytree=0.8,
                            min_child_weight=5, objective=obj, n_jobs=2, random_state=SEED, tree_method='hist')


def lgbm_model(pos):
    import lightgbm as lgb
    obj, leaves, n = LGBM[pos]
    return lgb.LGBMRegressor(n_estimators=n, learning_rate=0.05, num_leaves=leaves, min_child_samples=20,
                             subsample=0.8, subsample_freq=1, colsample_bytree=0.8, objective=obj,
                             random_state=SEED, n_jobs=2, verbose=-1)


def predict_block(X, y, espn, trmask, temask, pos):
    xm = xgb_model(pos).fit(X[trmask], y[trmask])
    lm = lgbm_model(pos).fit(X[trmask], y[trmask])
    out = {'xgb': xm.predict(X[temask]), 'lgbm': lm.predict(X[temask])}
    tr2 = trmask & ~np.isnan(espn)
    Xe = np.column_stack([X, espn])
    rm = xgb_model(pos).fit(Xe[tr2], (y - espn)[tr2])
    b2 = espn[temask] + rm.predict(Xe[temask])
    out['b2'] = np.where(np.isnan(espn[temask]), np.nan, b2)
    return out


def mae(a, b):
    return float(np.mean(np.abs(a - b)))


def week_boot_diff(y, a, b, weeks, idx_list):
    vals = []
    for idx in idx_list:
        vals.append(mae(y[idx], a[idx]) - mae(y[idx], b[idx]))
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))]


def summarize(y, preds, weeks, mask, arms, ref):
    """MAE per arm on `mask` rows where every arm has a value; week-clustered CIs of arm - ref."""
    common = mask.copy()
    for a in arms:
        common &= ~np.isnan(preds[a])
    idx = np.flatnonzero(common)
    res = {'n': int(len(idx)), 'weeks': int(len(np.unique(weeks[idx])))}
    if not len(idx):
        return res
    yy, ww = y[idx], weeks[idx]
    boots = boot_indices(len(idx), clusters=ww)
    for a in arms:
        res[f'{a}_mae'] = r(mae(yy, preds[a][idx]), 3)
        res[f'{a}_mae_ci'] = r([float(np.percentile([mae(yy[b], preds[a][idx][b]) for b in boots], q)) for q in (2.5, 97.5)], 3)
    for a in arms:
        if a == ref:
            continue
        d = mae(yy, preds[a][idx]) - mae(yy, preds[ref][idx])
        lo, hi = week_boot_diff(yy, preds[a][idx], preds[ref][idx], ww, boots)
        res[f'{a}_minus_{ref}'] = r(d, 3)
        res[f'{a}_minus_{ref}_ci'] = r([lo, hi], 3)
        res[f'{a}_vs_{ref}_verdict'] = verdict(lo, hi)
    return res


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--panel', required=True)
    ap.add_argument('--db', required=True)
    ap.add_argument('--espn-retro', action='append', default=[])
    ap.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    p = np.load(a.panel)
    X, y, meta = p['X'], p['y'], p['meta']
    names = [str(n) for n in p['feature_names']]
    season, week, pos = meta[:, 2].astype(int), meta[:, 3].astype(int), meta[:, 4].astype(int)
    pid, espn_id = meta[:, 0].astype(int), meta[:, 1].astype(int)
    retro = load_espn_retro(a.espn_retro)
    open_copy(a.db).close()  # refuses the live file
    current, frozen = load_current_and_frozen(a.db)
    espn = np.array([retro.get((e, s, w), np.nan) for e, s, w in zip(espn_id, season, week)])
    cur = np.array([current.get((i, s, w), np.nan) for i, s, w in zip(pid, season, week)])
    frz = np.array([frozen.get((e, s, w), np.nan) for e, s, w in zip(espn_id, season, week)])
    gw = season * 100 + week  # global week key for clustering
    preds = {k: np.full(len(y), np.nan) for k in ('xgb', 'lgbm', 'b2')}
    tested = np.zeros(len(y), bool)
    fits = 0
    for k, P in enumerate(POSITIONS):
        at = pos == k
        fallback = float(np.mean(y[at & (season < 2024)]))
        for S in TEST_SEASONS:
            for t in sorted(np.unique(week[at & (season == S)])):
                tr = at & ((season < S) | ((season == S) & (week < t)))
                te = at & (season == S) & (week == t)
                out = predict_block(X, y, espn, tr, te, P)
                for kk, v in out.items():
                    preds[kk][te] = v
                tested |= te
                fits += 3
        print(f'{P}: rolling fits done ({fits})', flush=True)
    trail = np.full(len(y), np.nan)
    for k, P in enumerate(POSITIONS):
        at = pos == k
        trail[at] = trailing_mean(X[at], names, float(np.mean(y[at & (season < 2024)])))
    preds['trailing'] = trail
    preds['espn_retro'] = espn

    results = {'panel_rows': int(len(y)), 'rolling_fits': fits, 'settings': {'xgb': XGB, 'lgbm': LGBM},
               'label': 'ESPN RETRO = fetched 2026-09-25 after the games (retrospective, NOT frozen)', 'positions': {}}
    arms_all = ['xgb', 'lgbm', 'trailing']
    arms_espn = ['xgb', 'lgbm', 'b2', 'trailing', 'espn_retro']
    for k, P in enumerate(POSITIONS):
        at = (pos == k) & tested
        rp = {}
        for S in TEST_SEASONS:
            m = at & (season == S)
            rp[f'{S}_vs_espn_retro'] = summarize(y, preds, gw, m, arms_espn, 'espn_retro')
            rp[f'{S}_all_rows_vs_trailing'] = summarize(y, preds, gw, m, arms_all, 'trailing')
        rp['pooled_2024_2025_vs_espn_retro'] = summarize(y, preds, gw, at, arms_espn, 'espn_retro')
        rp['pooled_2024_2025_all_rows_vs_trailing'] = summarize(y, preds, gw, at, arms_all, 'trailing')
        results['positions'][P] = rp
        print(json.dumps({P: {kk: vv for kk, vv in rp['pooled_2024_2025_vs_espn_retro'].items() if 'minus' in kk or kk == 'n'}}), flush=True)

    # Prereg verdict per model: CI of MAE(model) - MAE(ESPN RETRO), pooled, across positions.
    verdicts = {}
    for mname in ('xgb', 'lgbm', 'b2'):
        v = [results['positions'][P]['pooled_2024_2025_vs_espn_retro'].get(f'{mname}_vs_espn_retro_verdict') for P in POSITIONS]
        better, worse = v.count('promising'), v.count('worse than simple')
        verdicts[mname] = {'per_position': dict(zip(POSITIONS, v)),
                           'verdict': 'promising' if better >= 2 and worse == 0 else ('worse than simple' if worse >= 3 else 'no evidence yet')}
    results['verdicts_vs_espn_retro'] = verdicts

    # Smoke test: 2026 week 2, models trained on everything before it.
    smoke = {}
    for k, P in enumerate(POSITIONS):
        at = pos == k
        tr = at & ((season < 2026) | ((season == 2026) & (week < 2)))
        te = at & (season == 2026) & (week == 2)
        out = predict_block(X, y, espn, tr, te, P)
        sp = {kk: np.full(len(y), np.nan) for kk in out}
        for kk, v in out.items():
            sp[kk][te] = v
        sp.update({'trailing': np.where(te, trail, np.nan), 'espn_frozen': np.where(te, frz, np.nan),
                   'espn_retro': np.where(te, espn, np.nan), 'ours_current': np.where(te, cur, np.nan)})
        common = te.copy()
        for kk in ('xgb', 'lgbm', 'trailing', 'espn_frozen'):
            common &= ~np.isnan(sp[kk])
        idx = np.flatnonzero(common)
        row = {'n': int(len(idx))}
        boots = boot_indices(len(idx)) if len(idx) else []
        for kk in ('xgb', 'lgbm', 'trailing', 'espn_frozen'):
            row[f'{kk}_mae'] = r(mae(y[idx], sp[kk][idx]), 3)
        for kk in ('xgb', 'lgbm'):
            d = [mae(y[idx][b], sp[kk][idx][b]) - mae(y[idx][b], sp['espn_frozen'][idx][b]) for b in boots]
            row[f'{kk}_minus_espn_frozen'] = r(mae(y[idx], sp[kk][idx]) - mae(y[idx], sp['espn_frozen'][idx]), 3)
            row[f'{kk}_minus_espn_frozen_ci'] = r([float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))], 3)
        c2 = common & ~np.isnan(sp['ours_current'])
        i2 = np.flatnonzero(c2)
        row['with_ours_n'] = int(len(i2))
        for kk in ('xgb', 'espn_frozen', 'ours_current'):
            row[f'with_ours_{kk}_mae'] = r(mae(y[i2], sp[kk][i2]), 3) if len(i2) else None
        c3 = common & ~np.isnan(sp['b2'])
        i3 = np.flatnonzero(c3)
        row['with_b2_n'] = int(len(i3))
        for kk in ('b2', 'espn_retro', 'espn_frozen'):
            row[f'with_b2_{kk}_mae'] = r(mae(y[i3], sp[kk][i3]), 3) if len(i3) else None
        smoke[P] = row
    results['smoke_2026_week2_frozen_espn'] = smoke
    con = open_copy(a.db)
    wk3 = con.execute("""SELECT COUNT(*), SUM(late = 0 AND captured_at < kickoff_at) FROM espn_weekly_projection_snapshots
                         WHERE season = 2026 AND week = 3 AND scoring_key = 'ppr'""").fetchone()
    finals3 = int((season == 2026).sum() and ((season == 2026) & (week == 3)).sum())
    results['week3'] = {'espn_rows': wk3[0], 'pre_kickoff_rows': wk3[1], 'panel_rows_with_finals': finals3,
                        'scored': False, 'why': 'week-3 finals are not in player_week_usage yet' if not finals3 else ''}
    json.dump(results, open(a.out, 'w'), indent=1)
    print(json.dumps({'verdicts': verdicts, 'smoke': smoke, 'week3': results['week3']}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
