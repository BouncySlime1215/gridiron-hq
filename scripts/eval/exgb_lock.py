#!/usr/bin/env python3
"""E-XGB model-settings lock (docs/tdd/EXGB-PREREG.md section 1, addendum 1).

Applies the pre-registered selection rule - rolling-origin folds (validate 2023, 2024,
2025 on the seasons before each), at most 24 settings, lowest mean validation MAE - per
position for arm A (XGBoost; LightGBM secondary) and for arm B2's residual model, and
writes the chosen settings to scripts/eval/exgb-lock.json. Uses only 2022-2025 data, so
no 2026 number can influence a setting. The lock also records the SHA-256 of the code
that builds features and fits models, so a later edit to either is visible.

Needs xgboost + lightgbm (scripts/eval/requirements-exgb.txt). Reads a COPY of the DB.
  ~/gridiron-local/venv-ml/bin/python scripts/eval/exgb_lock.py --db <copy.sqlite> \
      --espn-retro <espn-retro-2022.json> ... --espn-retro <espn-retro-2025.json> --out scripts/eval/exgb-lock.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import exgb_arms as A  # noqa: E402
import exgb_panel as P  # noqa: E402

LOCKED_CODE = ('exgb_panel.py', 'exgb_arms.py', 'exgb_shadow.py')


def code_hashes():
    out = {}
    for f in LOCKED_CODE:
        with open(os.path.join(HERE, f), 'rb') as fh:
            out[f] = hashlib.sha256(fh.read()).hexdigest()
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--db')
    ap.add_argument('--espn-retro', action='append', default=[])
    ap.add_argument('--out', required=True)
    ap.add_argument('--rehash', action='store_true',
                    help='refresh code_sha256 in an existing lock without re-selecting any setting')
    a = ap.parse_args(argv)
    if a.rehash:
        with open(a.out) as f:
            lock = json.load(f)
        lock['code_sha256'] = code_hashes()
        with open(a.out, 'w') as f:
            json.dump(lock, f, indent=1)
            f.write('\n')
        print(json.dumps(lock['code_sha256']))
        return 0
    con = P.open_db(a.db)
    t = P.load_tables(con, 2022, 2025)
    con.close()
    panel = P.build_panel(t, [2022, 2023, 2024, 2025])
    X, y, meta = panel['X'], panel['y'], panel['meta']
    season, pos = meta[:, 2].astype(int), meta[:, 4].astype(int)
    espn = A.espn_column(meta, A.load_retro(a.espn_retro))
    XB, yB = A.with_espn(X, espn), y - espn
    lock = {'version': 'exgb-lock-v1', 'selected_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'rule': 'rolling-origin folds validate 2023/2024/2025 on earlier seasons; lowest mean validation MAE',
            'seed': A.SEED, 'learning_rate': A.LEARNING_RATE, 'fixed': 'subsample 0.8, colsample 0.8, hist, n_jobs 2',
            'grids': {'xgb': A.XGB_GRID, 'lgbm': A.LGBM_GRID},
            'features': [str(n) for n in panel['feature_names']], 'b2_extra_feature': 'espn_proj',
            'b2_pretraining': 'RETROSPECTIVE ESPN 2022-2025 (labelled proxy, fetched 2026-09-25)',
            'code_sha256': code_hashes(), 'positions': {}}
    for k, name in enumerate(A.POSITIONS):
        at = pos == k
        a_xgb, _ = A.select('xgb', A.XGB_GRID, X, y, season, at)
        a_lgb, _ = A.select('lgbm', A.LGBM_GRID, X, y, season, at)
        hasb = at & ~np.isnan(espn)
        b2, _ = A.select('xgb', A.XGB_GRID, XB, yB, season, hasb)
        espn_val = {s: round(A.mae(y[hasb & (season == s)], espn[hasb & (season == s)]), 4) for s in A.FOLD_SEASONS}
        lock['positions'][name] = {'A_xgb': a_xgb, 'A_lgbm': a_lgb, 'B2_residual_xgb': b2,
                                   'espn_retro_val_mae_by_season': espn_val}
        print(json.dumps({name: {kk: {'mae': v['mean_val_mae'], 'params': v['params'], 'n': v['n_estimators']}
                                 for kk, v in lock['positions'][name].items() if isinstance(v, dict) and 'params' in v}}),
              flush=True)
    with open(a.out, 'w') as f:
        json.dump(lock, f, indent=1)
        f.write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
