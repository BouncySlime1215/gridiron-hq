#!/usr/bin/env python3
"""E-XGB shadow arms: fit the locked models, then forecast a week (NOTHING IS SERVED).

  fit      Refit every arm with the settings in scripts/eval/exgb-lock.json on 2022-2025 plus
           2026 weeks 1..--through-week, and fit the B1/B2 lambdas on 2026 frozen-ESPN weeks
           2..--through-week using models trained on 2022-2025 only (so lambda is fitted out of
           sample). Writes the artifacts and a manifest with their SHA-256 to --model-dir.
  predict  Forecast --season/--week for every eligible player from the artifacts, with ESPN
           as frozen at --as-of, and write JSON for server/services/exgb-shadow.js to ingest.

Refuses to run when the feature or model code no longer matches the lock's hashes.
Reads the database read-only (a copy for fit; the live file is allowed read-only for predict,
which the refresh loop runs). Needs xgboost + lightgbm (scripts/eval/requirements-exgb.txt).
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

SEASON = 2026
FIRST_FROZEN_WEEK = 2


def sha256_file(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def check_lock(lock):
    for f, want in lock['code_sha256'].items():
        got = sha256_file(os.path.join(HERE, f))
        if got != want:
            raise SystemExit(f'LOCK: {f} changed since the lock ({got[:12]} != {want[:12]}); refusing')


def open_db(path, allow_live=False):
    if not allow_live and os.path.realpath(path) == os.path.realpath(A.LIVE_DB):
        raise SystemExit('refusing the live database; pass a copy')
    import sqlite3
    return sqlite3.connect(f'file:{path}?mode=ro', uri=True)


def _tables(db, allow_live):
    con = open_db(db, allow_live)
    con.row_factory = __import__('sqlite3').Row
    t = P.load_tables(con, 2022, SEASON)
    con.close()
    return t


def fit(a):
    lock = json.load(open(a.lock))
    check_lock(lock)
    t = _tables(a.db, False)
    panel = P.build_panel(t, list(range(2022, SEASON + 1)))
    X, y, meta = panel['X'], panel['y'], panel['meta']
    assert [str(n) for n in panel['feature_names']] == lock['features'], 'feature list differs from the lock'
    season, week, pos = meta[:, 2].astype(int), meta[:, 3].astype(int), meta[:, 4].astype(int)
    con = open_db(a.db)
    frozen = A.load_frozen(con, SEASON)
    con.close()
    retro = A.load_retro(a.espn_retro)
    espn_retro, espn_frozen = A.espn_column(meta, retro), A.espn_column(meta, frozen)
    hist = season <= 2025
    cur = (season == SEASON) & (week <= a.through_week)
    lam_rows = (season == SEASON) & (week >= FIRST_FROZEN_WEEK) & (week <= a.through_week) & ~np.isnan(espn_frozen)
    os.makedirs(a.model_dir, exist_ok=True)
    manifest = {'lock_sha256': sha256_file(a.lock), 'fitted_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                'through_week': a.through_week, 'positions': {}, 'artifacts': {}}
    for k, name in enumerate(A.POSITIONS):
        L = lock['positions'][name]
        at = pos == k
        # lambda: models that never saw 2026, scored on 2026 frozen weeks
        a_pre = A.fit_final('xgb', L['A_xgb'], X[at & hist], y[at & hist])
        hb = at & hist & ~np.isnan(espn_retro)
        b_pre = A.fit_final('xgb', L['B2_residual_xgb'], A.with_espn(X, espn_retro)[hb], (y - espn_retro)[hb])
        lr = at & lam_rows
        e = espn_frozen[lr]
        lam1, loss1 = A.fit_lambda(y[lr], e, a_pre.predict(X[lr]))
        lam2, loss2 = A.fit_lambda(y[lr], e, e + b_pre.predict(A.with_espn(X[lr], e)))
        # final artifacts: history + 2026 through the cutoff
        tr = at & (hist | cur)
        a_x = A.fit_final('xgb', L['A_xgb'], X[tr], y[tr])
        a_l = A.fit_final('lgbm', L['A_lgbm'], X[tr], y[tr])
        espn_train = np.where(season <= 2025, espn_retro, espn_frozen)
        bt = tr & ~np.isnan(espn_train)
        b_f = A.fit_final('xgb', L['B2_residual_xgb'], A.with_espn(X, espn_train)[bt], (y - espn_train)[bt])
        for label, m, ext in (('A_xgb', a_x, 'json'), ('A_lgbm', a_l, 'txt'), ('B2_residual_xgb', b_f, 'json')):
            path = os.path.join(a.model_dir, f'{name}-{label}.{ext}')
            if ext == 'json':
                m.save_model(path)
            else:
                m.booster_.save_model(path)
            manifest['artifacts'][os.path.basename(path)] = sha256_file(path)
        manifest['positions'][name] = {
            'lambda_B1': lam1, 'lambda_B1_mae': loss1, 'lambda_B2': lam2, 'lambda_B2_mae': loss2,
            'lambda_rows': int(lr.sum()), 'espn_frozen_mae_on_lambda_rows': round(A.mae(y[lr], e), 4) if lr.any() else None,
            'train_rows': int(tr.sum()), 'b2_train_rows': int(bt.sum()),
            'b2_frozen_rows': int((bt & (season == SEASON)).sum())}
        print(json.dumps({name: manifest['positions'][name]}), flush=True)
    with open(os.path.join(a.model_dir, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    return 0


def load_models(model_dir):
    import lightgbm as lgb
    import xgboost as xgb
    manifest = json.load(open(os.path.join(model_dir, 'manifest.json')))
    for f, want in manifest['artifacts'].items():
        if sha256_file(os.path.join(model_dir, f)) != want:
            raise SystemExit(f'artifact {f} does not match its manifest hash; refusing')
    models = {}
    for name in A.POSITIONS:
        ax, bx = xgb.XGBRegressor(), xgb.XGBRegressor()
        ax.load_model(os.path.join(model_dir, f'{name}-A_xgb.json'))
        bx.load_model(os.path.join(model_dir, f'{name}-B2_residual_xgb.json'))
        al = lgb.Booster(model_file=os.path.join(model_dir, f'{name}-A_lgbm.txt'))
        models[name] = (ax, al, bx)
    return manifest, models


def predict(a):
    lock = json.load(open(a.lock))
    check_lock(lock)
    manifest, models = load_models(a.model_dir)
    if manifest['lock_sha256'] != sha256_file(a.lock):
        raise SystemExit('the artifacts were fitted under a different lock; refusing')
    t = _tables(a.db, True)
    panel = P.build_panel(t, [a.season], predict=(a.season, a.week))
    keep = (panel['meta'][:, 3] == a.week) & (panel['played'] == -1)
    X, meta = panel['X'][keep], panel['meta'][keep]
    con = open_db(a.db, True)
    frozen = A.load_frozen(con, a.season, as_of=a.as_of)
    con.close()
    espn = A.espn_column(meta, frozen)
    rows = []
    for k, name in enumerate(A.POSITIONS):
        at = meta[:, 4] == k
        if not at.any():
            continue
        ax, al, bx = models[name]
        lam = manifest['positions'][name]
        pa, pl = ax.predict(X[at]), al.predict(X[at])
        e = espn[at]
        b1 = np.where(np.isnan(e), np.nan, A.blend(e, pa, lam['lambda_B1']))
        r = bx.predict(A.with_espn(X[at], e))
        b2 = np.where(np.isnan(e), np.nan, e + lam['lambda_B2'] * r)
        for i, m in enumerate(meta[at]):
            for arm, v in (('A_xgb', pa[i]), ('A_lgbm', pl[i]), ('B1', b1[i]), ('B2', b2[i])):
                if v == v:
                    rows.append({'player_id': int(m[0]), 'espn_id': int(m[1]) if m[1] > 0 else None,
                                 'position': name, 'arm': arm, 'prediction': round(float(v), 4),
                                 'espn_input': None if e[i] != e[i] else round(float(e[i]), 4),
                                 'kickoff_at': None if m[5] != m[5] else
                                 datetime.fromtimestamp(float(m[5]), timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')})
    out = {'season': a.season, 'week': a.week, 'as_of': a.as_of,
           'lock_sha256': manifest['lock_sha256'], 'manifest_sha256': sha256_file(os.path.join(a.model_dir, 'manifest.json')),
           'rows': rows}
    with open(a.out, 'w') as f:
        json.dump(out, f)
    print(json.dumps({'season': a.season, 'week': a.week, 'rows': len(rows)}))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    f = sub.add_parser('fit')
    f.add_argument('--db', required=True)
    f.add_argument('--lock', default=os.path.join(HERE, 'exgb-lock.json'))
    f.add_argument('--espn-retro', action='append', default=[])
    f.add_argument('--model-dir', required=True)
    f.add_argument('--through-week', type=int, required=True)
    p = sub.add_parser('predict')
    p.add_argument('--db', required=True)
    p.add_argument('--lock', default=os.path.join(HERE, 'exgb-lock.json'))
    p.add_argument('--model-dir', required=True)
    p.add_argument('--season', type=int, default=SEASON)
    p.add_argument('--week', type=int, required=True)
    p.add_argument('--as-of', default=None)
    p.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    if a.cmd == 'predict' and not a.as_of:
        a.as_of = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    return fit(a) if a.cmd == 'fit' else predict(a)


if __name__ == '__main__':
    sys.exit(main())
