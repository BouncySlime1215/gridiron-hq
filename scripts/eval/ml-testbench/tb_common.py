"""ML-TESTBENCH shared metrics (docs/tdd/ML-TESTBENCH-PREREG.md). numpy only.

Bootstrap: 1,000 resamples, seed 20260925, percentile 95% intervals. Paired differences use the
same resample for both arms. Verdict words: promising / worse than simple / no evidence yet.
"""
from __future__ import annotations

import os
import sqlite3

import numpy as np

SEED = 20260925
B = 1000
P_CLIP = 0.02
LIVE_DB = os.path.join(os.path.expanduser('~'), 'gridiron-local', 'data.sqlite')
EVIDENCE = os.path.join(os.path.expanduser('~'), 'gridiron-local', 'evidence', 'ml-testbench')


def open_copy(path):
    """Read-only handle on a COPY of the app database; the live file is refused."""
    if os.path.realpath(path) == os.path.realpath(LIVE_DB):
        raise SystemExit('refusing the live database; pass a copy')
    return sqlite3.connect(f'file:{path}?mode=ro', uri=True)


def clip(p):
    return np.clip(np.asarray(p, float), P_CLIP, 1 - P_CLIP)


def log_loss_each(p, y):
    p, y = clip(p), np.asarray(y, float)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def brier_each(p, y):
    return (np.asarray(p, float) - np.asarray(y, float)) ** 2


def murphy(p, y, bins=5):
    """Brier = reliability - resolution + uncertainty (+ a within-bin term), equal-width bins."""
    p, y = np.asarray(p, float), np.asarray(y, float)
    n = len(y)
    if not n:
        return None
    k = np.minimum((p * bins).astype(int), bins - 1)
    obar = y.mean()
    rel = res = 0.0
    table = []
    for b in range(bins):
        m = k == b
        if not m.any():
            continue
        pb, ob = p[m].mean(), y[m].mean()
        rel += m.sum() / n * (pb - ob) ** 2
        res += m.sum() / n * (ob - obar) ** 2
        table.append({'bin': f'{b / bins:.1f}-{(b + 1) / bins:.1f}', 'n': int(m.sum()),
                      'mean_p': round(float(pb), 3), 'observed': round(float(ob), 3)})
    return {'brier': float(np.mean((p - y) ** 2)), 'reliability': float(rel), 'resolution': float(res),
            'uncertainty': float(obar * (1 - obar)), 'bins': table}


def auc(p, y):
    p, y = np.asarray(p, float), np.asarray(y, int)
    pos, neg = p[y == 1], p[y == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float('nan')
    gt = (pos[:, None] > neg[None, :]).sum() + 0.5 * (pos[:, None] == neg[None, :]).sum()
    return float(gt / (len(pos) * len(neg)))


def boot_indices(n, clusters=None, b=B, seed=SEED):
    """b index arrays: iid over rows, or whole clusters resampled when `clusters` is given."""
    rng = np.random.default_rng(seed)
    if clusters is None:
        return [rng.integers(0, n, n) for _ in range(b)]
    clusters = np.asarray(clusters)
    ids = np.unique(clusters)
    members = {c: np.flatnonzero(clusters == c) for c in ids}
    out = []
    for _ in range(b):
        pick = rng.choice(ids, len(ids), replace=True)
        out.append(np.concatenate([members[c] for c in pick]))
    return out


def ci(stat, idx_list, *arrays):
    vals = []
    for idx in idx_list:
        v = stat(*[a[idx] for a in arrays])
        if np.isfinite(v):
            vals.append(v)
    if not vals:
        return [float('nan'), float('nan')]
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))]


def verdict(lo, hi, better_is_negative=True):
    """promising / worse than simple / no evidence yet from a CI of (model - simple)."""
    if not (np.isfinite(lo) and np.isfinite(hi)):
        return 'no evidence yet'
    if better_is_negative:
        if hi < 0:
            return 'promising'
        if lo > 0:
            return 'worse than simple'
    else:
        if lo > 0:
            return 'promising'
        if hi < 0:
            return 'worse than simple'
    return 'no evidence yet'


def n_for_power(d, s, z_a=1.96, z_b=0.84):
    """Rows needed for a two-sided 5% paired test at 80% power; None when d is 0."""
    if d == 0 or not np.isfinite(d) or not np.isfinite(s):
        return None
    return int(np.ceil(((z_a + z_b) * s / abs(d)) ** 2))


def r(x, k=4):
    if x is None:
        return None
    if isinstance(x, (list, tuple)):
        return [r(v, k) for v in x]
    return None if not np.isfinite(x) else round(float(x), k)
