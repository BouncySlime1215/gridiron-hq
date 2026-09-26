#!/usr/bin/env python3
"""PROJ-DUEL: why the E-XGB shadow model says what it says, and what actually happened (NOTHING IS SERVED).

  drivers  For --season/--week, rebuild the exact forecast rows exgb_shadow.py predict builds (same
           locked panel code, same verified artifacts) and write, per player, arm A_xgb's TreeSHAP
           contributions (XGBoost pred_contribs) and the pre-game expected usage the model saw. It also
           writes the A_xgb prediction it recomputed, so the caller can prove the stored forecast is
           byte-identical: this script never writes a prediction and never changes a model.
  usage    For a finished --season/--week, each player's actual usage line (the panel's own observation:
           carries, targets, receptions, snap %, red-zone share, xfp, TDs) and his team's points scored
           beside its implied total.

It imports the locked modules (exgb_panel.py, exgb_arms.py, exgb_shadow.py) without editing them, and
refuses like predict does when their hashes or the artifacts' no longer match the lock.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import exgb_arms as A  # noqa: E402
import exgb_panel as P  # noqa: E402
import exgb_shadow as SH  # noqa: E402

TOP = 5
EXPECTED = ('trail3_carries', 'trail3_targets', 'trail3_receptions', 'trail3_snap_pct', 'trail3_rz_share', 'trail3_xfp',
            'team_implied', 'opp_allowed_pos_trail')


def _num(v):
    return None if v is None or v != v else round(float(v), 4)


def drivers(a):
    import xgboost as xgb
    lock = json.load(open(a.lock))
    SH.check_lock(lock)
    manifest, models = SH.load_models(a.model_dir)
    if manifest['lock_sha256'] != SH.sha256_file(a.lock):
        raise SystemExit('the artifacts were fitted under a different lock; refusing')
    t = SH._tables(a.db, True)
    panel = P.build_panel(t, [a.season], predict=(a.season, a.week))
    keep = (panel['meta'][:, 3] == a.week) & (panel['played'] == -1)
    X, meta = panel['X'][keep], panel['meta'][keep]
    names = [str(n) for n in panel['feature_names']]
    idx = {n: i for i, n in enumerate(names)}
    rows = []
    for k, name in enumerate(A.POSITIONS):
        at = meta[:, 4] == k
        if not at.any():
            continue
        ax = models[name][0]
        pa = ax.predict(X[at])
        contribs = ax.get_booster().predict(xgb.DMatrix(X[at], feature_names=None), pred_contribs=True)
        for i, m in enumerate(meta[at]):
            c = contribs[i]
            order = np.argsort(-np.abs(c[:-1]))[:TOP]
            rows.append({'player_id': int(m[0]), 'position': name, 'arm': 'A_xgb',
                         'prediction': round(float(pa[i]), 4), 'base': round(float(c[-1]), 4),
                         'contribs': [{'feature': names[j], 'contribution': round(float(c[j]), 4), 'value': _num(X[at][i, j])}
                                      for j in order],
                         'expected': {f: _num(X[at][i, idx[f]]) for f in EXPECTED if f in idx}})
    out = {'season': a.season, 'week': a.week, 'lock_sha256': manifest['lock_sha256'],
           'manifest_sha256': SH.sha256_file(os.path.join(a.model_dir, 'manifest.json')), 'rows': rows}
    with open(a.out, 'w') as f:
        json.dump(out, f)
    print(json.dumps({'season': a.season, 'week': a.week, 'rows': len(rows)}))
    return 0


def usage(a):
    t = SH._tables(a.db, True)
    obs = P._observations(t)
    rows = []
    for pid, lst in obs.items():
        for o in lst:
            if o['season'] != a.season or o['week'] != a.week:
                continue
            u = t['usage'].get((pid, a.season, a.week), {})
            implied = P._team_line(t, a.season, a.week, o['team'])[0] if o['team'] else np.nan
            rows.append({'player_id': int(pid), 'team': o['team'], 'carries': _num(o.get('carries')), 'targets': _num(o.get('targets')),
                         'receptions': _num(o.get('receptions')), 'snap_pct': _num(o.get('snap_pct')),
                         'rz_share': _num(o.get('rz_share')), 'xfp': _num(o.get('xfp')),
                         'tds': _num(float(u.get('rushing_tds') or 0) + float(u.get('receiving_tds') or 0) + float(u.get('passing_tds') or 0)),
                         'team_implied': _num(implied)})
    with open(a.out, 'w') as f:
        json.dump({'season': a.season, 'week': a.week, 'rows': rows}, f)
    print(json.dumps({'season': a.season, 'week': a.week, 'rows': len(rows)}))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    for cmd in ('drivers', 'usage'):
        p = sub.add_parser(cmd)
        p.add_argument('--db', required=True)
        p.add_argument('--season', type=int, default=SH.SEASON)
        p.add_argument('--week', type=int, required=True)
        p.add_argument('--out', required=True)
        if cmd == 'drivers':
            p.add_argument('--lock', default=os.path.join(HERE, 'exgb-lock.json'))
            p.add_argument('--model-dir', required=True)
    a = ap.parse_args(argv)
    return drivers(a) if a.cmd == 'drivers' else usage(a)


if __name__ == '__main__':
    sys.exit(main())
