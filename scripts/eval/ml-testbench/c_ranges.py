#!/usr/bin/env python3
"""ML-TESTBENCH section C: coverage of p10-p90 weekly lineup ranges (docs/tdd/ML-TESTBENCH-PREREG.md).

No served range was stored for 2026 weeks 1-3 and the served producer (lineup-week-range.js, the
league world) cannot be rebuilt as of a past week, so the pre-registered equivalents are scored:
  C1 ours     week 2: split-normal per starter from weekly_prediction_snapshots (median, lower_80,
              upper_80), floored at 0; K / D/ST fixed at frozen ESPN (as the world fixes them);
              independent draws, 20,000 runs.
  C2 frozen   week 2: frozen ESPN mean, sd = positional CV in quadrature (no SPREAD_SCALE), +/- 1.2816 sd.
  C3 retro    weeks 1-2: as C2 on ESPN RETRO (backfilled after the games).
  simple      ESPN projection +/- 1.2816 x 24.1 (team-week SD measured in league_week_scores 2023-25).
Usage: python c_ranges.py --db <copy.sqlite> --out c-results.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tb_common import SEED, boot_indices, open_copy, r  # noqa: E402
from tb_lineups import complete, load, posture_constants  # noqa: E402

Z90 = 1.2816
TEAM_WEEK_SD = 24.1
RUNS = 20000


def c1_band(starters, rng):
    tot = np.zeros(RUNS)
    for s in starters:
        if s['ours'] is not None:
            m, lo, hi = s['ours']
            z = rng.standard_normal(RUNS)
            sd_lo, sd_hi = max(m - lo, 0) / Z90, max(hi - m, 0) / Z90
            tot += np.maximum(0, m + z * np.where(z > 0, sd_hi, sd_lo))
        elif s['frozen'] is not None:
            tot += s['frozen']
        else:
            return None
    return float(np.quantile(tot, 0.10)), float(np.quantile(tot, 0.90))


def cv_band(starters, key, cvs, default):
    if any(s[key] is None for s in starters):
        return None
    mean = sum(s[key] for s in starters)
    var = sum((s[key] * cvs.get(s['position'], default)) ** 2 for s in starters if s[key] > 0)
    sd = math.sqrt(var)
    return mean - Z90 * sd, mean + Z90 * sd


def simple_band(starters, key):
    if any(s[key] is None for s in starters):
        return None
    mean = sum(s[key] for s in starters)
    return mean - Z90 * TEAM_WEEK_SD, mean + Z90 * TEAM_WEEK_SD


def coverage(rows, clusters):
    rows = np.asarray(rows, float)  # columns: total, lo, hi
    inside = (rows[:, 0] >= rows[:, 1]) & (rows[:, 0] <= rows[:, 2])
    below, above = rows[:, 0] < rows[:, 1], rows[:, 0] > rows[:, 2]
    boots = boot_indices(len(rows), clusters=clusters)
    cis = [float(np.mean(inside[b])) for b in boots]
    return {'n': int(len(rows)), 'league_weeks': int(len(set(clusters))), 'coverage': r(inside.mean(), 3),
            'coverage_ci': r([float(np.percentile(cis, 2.5)), float(np.percentile(cis, 97.5))], 3),
            'below_p10': r(below.mean(), 3), 'above_p90': r(above.mean(), 3),
            'mean_width': r(float(np.mean(rows[:, 2] - rows[:, 1])), 1)}


def judge(model, simple):
    lo, hi = model['coverage_ci']
    inside = lo <= 0.80 <= hi
    miss_m, miss_s = abs(model['coverage'] - 0.8), abs(simple['coverage'] - 0.8)
    if inside and miss_m <= miss_s:
        return 'promising'
    if not inside and miss_s < miss_m:
        return 'worse than simple'
    return 'no evidence yet'


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    con = open_copy(a.db)
    cvs, _scale, default = posture_constants()
    teams, scores = load(con)
    rng = np.random.default_rng(SEED)
    arms = {'C1_ours_wk2': ([], [], []), 'C2_espn_frozen_wk2': ([], [], []), 'C3_espn_retro_wk1_2': ([], [], [])}
    skipped, agree = {}, []
    for (lg, wk, team), st in sorted(teams.items()):
        if not complete(st):
            skipped[wk] = skipped.get(wk, 0) + 1
            continue
        total = sum(s['actual'] for s in st)
        off = scores.get((lg, wk, team))
        if off and off[0] is not None:
            agree.append(abs(off[0] - total))
        cl = f'{lg}:{wk}'
        if wk == 2:
            b = c1_band(st, rng)
            sb = simple_band(st, 'frozen')
            if b and sb:
                arms['C1_ours_wk2'][0].append((total, *b)); arms['C1_ours_wk2'][1].append((total, *sb)); arms['C1_ours_wk2'][2].append(cl)
            b = cv_band(st, 'frozen', cvs, default)
            if b and sb:
                arms['C2_espn_frozen_wk2'][0].append((total, *b)); arms['C2_espn_frozen_wk2'][1].append((total, *sb)); arms['C2_espn_frozen_wk2'][2].append(cl)
        b, sb = cv_band(st, 'retro', cvs, default), simple_band(st, 'retro')
        if b and sb:
            arms['C3_espn_retro_wk1_2'][0].append((total, *b)); arms['C3_espn_retro_wk1_2'][1].append((total, *sb)); arms['C3_espn_retro_wk1_2'][2].append(cl)
    out = {'target': 0.80, 'skipped_incomplete_team_weeks_by_week': skipped,
           'starter_sum_vs_official_score': {'n': len(agree), 'max_abs_diff': r(max(agree) if agree else None, 2),
                                             'share_exact_within_0.05': r(float(np.mean(np.asarray(agree) <= 0.05)) if agree else None, 3)},
           'served_range_note': 'no served weekly range was stored for weeks 1-3; these are the pre-registered equivalents',
           'arms': {}}
    for name, (rows, srows, cl) in arms.items():
        if not rows:
            out['arms'][name] = {'n': 0}
            continue
        m, s = coverage(rows, cl), coverage(srows, cl)
        out['arms'][name] = {'model': m, 'simple_band': s, 'verdict': judge(m, s)}
    json.dump(out, open(a.out, 'w'), indent=1)
    print(json.dumps(out, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
