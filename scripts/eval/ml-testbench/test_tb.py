"""ML-TESTBENCH unit checks: metrics, verdict words, the arm-5/6 fitters. Run with the ML venv:
  ~/gridiron-local/venv-ml/bin/python scripts/eval/ml-testbench/test_tb.py   (or pytest, where installed)
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from a_acceptance import hier_predict, lgbm_predict  # noqa: E402
from tb_common import auc, murphy, n_for_power, verdict  # noqa: E402
from tb_lineups import posture_constants  # noqa: E402


def test_verdict_words():
    assert verdict(-0.2, -0.01) == 'promising'
    assert verdict(0.01, 0.2) == 'worse than simple'
    assert verdict(-0.1, 0.1) == 'no evidence yet'
    assert verdict(float('nan'), 0.1) == 'no evidence yet'


def test_murphy_decomposition_adds_up_when_bins_are_pure():
    p = np.array([0.1, 0.1, 0.9, 0.9, 0.5, 0.5])
    y = np.array([0, 0, 1, 1, 1, 0])
    m = murphy(p, y)
    assert abs(m['brier'] - (m['reliability'] - m['resolution'] + m['uncertainty'])) < 1e-9


def test_auc_and_power():
    assert auc([0.9, 0.8, 0.1], [1, 1, 0]) == 1.0
    assert auc([0.1, 0.9], [1, 0]) == 0.0
    assert n_for_power(0, 1) is None
    assert n_for_power(0.1, 1.0) == 784


def test_hier_prior_only_is_half_and_learns_direction():
    p0, _ = hier_predict(np.zeros((0, 2)), np.zeros(0), [], [], np.zeros(2), 'L', 'M')
    assert abs(p0 - 0.5) < 1e-6
    rng = np.random.default_rng(1)
    X = rng.standard_normal((80, 2))
    y = (X[:, 0] + 0.3 * rng.standard_normal(80) > 0).astype(int)
    hi, _ = hier_predict(X, y, ['L'] * 80, [f'M{i % 4}' for i in range(80)], np.array([2.0, 0]), 'L', 'M0')
    lo, _ = hier_predict(X, y, ['L'] * 80, [f'M{i % 4}' for i in range(80)], np.array([-2.0, 0]), 'L', 'M0')
    assert hi > 0.8 and lo < 0.2


def test_lgbm_falls_back_on_tiny_or_one_class():
    p, fb = lgbm_predict(np.zeros((5, 2)), np.zeros(5), np.zeros(2), 0.3)
    assert fb and p == 0.3
    p, fb = lgbm_predict(np.zeros((20, 2)), np.zeros(20), np.zeros(2), 0.3)
    assert fb and p == 0.3


def test_posture_constants_read_from_the_served_file():
    cvs, scale, default = posture_constants()
    assert set(cvs) >= {'QB', 'RB', 'WR', 'TE'} and scale > 1 and 0 < default < 1


if __name__ == '__main__':  # no pytest in the ML venv: run every test_ function directly
    names = [n for n in dir() if n.startswith('test_')]
    for n in names:
        globals()[n]()
    print(f'{len(names)} passed')
