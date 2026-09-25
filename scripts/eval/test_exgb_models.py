"""Tests for the pure parts of scripts/eval/exgb_models.py (numpy only; xgboost is imported lazily).

Run: python3 -m unittest scripts/eval/test_exgb_models.py
"""
import json
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exgb_models as M  # noqa: E402


class ModelsTest(unittest.TestCase):
    def test_compare_scores_every_arm_on_the_same_rows(self):
        y = np.array([10.0, 0.0, 5.0, 8.0])
        arms = {'a': np.array([9.0, 1.0, np.nan, 8.0]), 'b': np.array([10.0, 3.0, 5.0, np.nan])}
        r, common = M.compare(y, arms)
        self.assertEqual(r['n'], 2)
        self.assertEqual(list(common), [True, True, False, False])
        self.assertAlmostEqual(r['a_mae'], 1.0)
        self.assertAlmostEqual(r['b_mae'], 1.5)

    def test_trailing_mean_falls_back_to_last_season_then_position_mean(self):
        names = ['std_ppr', 'prev_season_ppg']
        X = np.array([[7.0, 3.0], [np.nan, 4.0], [np.nan, np.nan]])
        self.assertEqual(list(M.trailing_mean(X, names, 6.5)), [7.0, 4.0, 6.5])

    def test_espn_retro_file_must_say_it_is_retrospective(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'x.json')
            with open(p, 'w') as f:
                json.dump({'label': 'frozen', 'rows': []}, f)
            with self.assertRaises(AssertionError):
                M.load_espn_retro([p])

    def test_refuses_the_live_database(self):
        with self.assertRaises(SystemExit):
            M.load_current_and_frozen(M.LIVE_DB)


if __name__ == '__main__':
    unittest.main()
