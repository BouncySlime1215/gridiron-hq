#!/usr/bin/env python3
"""ML-TESTBENCH section D: matchup win-probability calibration (docs/tdd/ML-TESTBENCH-PREREG.md).

No weekly win probability was stored for 2026 weeks 1-3, so the served formula is reproduced:
lineup-posture.js#lineupMoments (sd = sqrt(sum (proj x POSITION_CV)^2) x SPREAD_SCALE) and
P(win) = normalCdf(edge / sqrt(sd_a^2 + sd_b^2)), on each side's ACTUAL starters, with
  D1 ESPN frozen (week 2), D2 ours (week 2; K / D/ST from frozen ESPN), D3 ESPN RETRO (weeks 1-2).
Outcome: league_week_scores (official). One row per game; ties excluded. Simple = 0.5 (Brier 0.25).
Usage: python d_winprob.py --db <copy.sqlite> --out d-results.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tb_common import boot_indices, brier_each, log_loss_each, murphy, n_for_power, open_copy, r, verdict  # noqa: E402
from tb_lineups import complete, load, posture_constants  # noqa: E402


def moments(starters, key, cvs, scale, default):
    vals = []
    for s in starters:
        v = s['ours'][0] if key == 'ours' and s['ours'] is not None else (s['frozen'] if key == 'ours' else s[key])
        if v is None:
            return None
        vals.append((v, s['position']))
    mean = sum(v for v, _ in vals)
    var = sum((v * cvs.get(p, default)) ** 2 for v, p in vals if v > 0)
    return mean, math.sqrt(var) * scale


def ncdf(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    con = open_copy(a.db)
    cvs, scale, default = posture_constants()
    teams, scores = load(con)
    arms = {'D1_espn_frozen_wk2': ('frozen', (2,)), 'D2_ours_wk2': ('ours', (2,)), 'D3_espn_retro_wk1_2': ('retro', (1, 2))}
    out = {'constants': {'position_cv': cvs, 'spread_scale': scale, 'default_cv': default},
           'served_note': 'no weekly win probability was stored for weeks 1-3; the served formula is reproduced', 'arms': {}}
    ties = set()
    for name, (key, weeks) in arms.items():
        p, y, cl = [], [], []
        for (lg, wk, team), (pts, opp) in sorted(scores.items()):
            if wk not in weeks or opp is None or not (int(team) < int(opp)):
                continue
            mine, theirs = teams.get((lg, wk, team)), teams.get((lg, wk, opp))
            if not (mine and theirs and complete(mine) and complete(theirs)):
                continue
            opp_pts = scores.get((lg, wk, opp), (None,))[0]
            if pts is None or opp_pts is None:
                continue
            if pts == opp_pts:
                ties.add((lg, wk, team))
                continue
            ma, mb = moments(mine, key, cvs, scale, default), moments(theirs, key, cvs, scale, default)
            if not ma or not mb or not (ma[1] > 0 and mb[1] > 0):
                continue
            p.append(ncdf((ma[0] - mb[0]) / math.sqrt(ma[1] ** 2 + mb[1] ** 2)))
            y.append(int(pts > opp_pts))
            cl.append(f'{lg}:{wk}')
        p, y = np.asarray(p), np.asarray(y)
        if not len(y):
            out['arms'][name] = {'n': 0}
            continue
        boots = boot_indices(len(y))
        b = brier_each(p, y)
        d = b - 0.25
        lo, hi = [float(np.percentile([d[i].mean() for i in boots], q)) for q in (2.5, 97.5)]
        m = murphy(p, y)
        fav = np.where(p >= 0.5, y, 1 - y)
        out['arms'][name] = {
            'n_games': int(len(y)), 'weeks': list(weeks), 'brier': r(b.mean()),
            'brier_ci': r([float(np.percentile([b[i].mean() for i in boots], q)) for q in (2.5, 97.5)]),
            'brier_minus_coin': r(d.mean()), 'brier_minus_coin_ci': r([lo, hi]), 'verdict': verdict(lo, hi),
            'log_loss': r(log_loss_each(p, y).mean()), 'reliability': r(m['reliability']), 'resolution': r(m['resolution']),
            'calibration_bins': m['bins'], 'favourite_won': r(float(fav.mean()), 3),
            'games_needed_80pct_power': n_for_power(d.mean(), d.std(ddof=1))}
    out['ties_excluded'] = len(ties)
    json.dump(out, open(a.out, 'w'), indent=1)
    print(json.dumps(out, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
