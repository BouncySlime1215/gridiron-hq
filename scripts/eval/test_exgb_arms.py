"""Tests for scripts/eval/exgb_arms.py's pure parts and exgb_panel's forecast mode (numpy only).

Run: python3 -m unittest scripts/eval/test_exgb_arms.py
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exgb_arms as A  # noqa: E402
import exgb_panel as P  # noqa: E402
import test_exgb_panel as TP  # noqa: E402


class ArmsTest(unittest.TestCase):
    def test_fit_lambda_finds_the_blend_and_stays_in_0_1(self):
        y = np.array([10.0, 20.0, 30.0])
        espn = np.array([12.0, 18.0, 33.0])
        self.assertEqual(A.fit_lambda(y, espn, y)[0], 1.0, 'a perfect model gets all the weight')
        self.assertEqual(A.fit_lambda(y, espn, espn + 50)[0], 0.0, 'a useless one gets none')
        self.assertEqual(A.fit_lambda([], [], [])[0], 0.0)

    def test_grids_respect_the_prereg_cap(self):
        self.assertLessEqual(len(A.XGB_GRID), 24)
        self.assertLessEqual(len(A.LGBM_GRID), 24)
        self.assertEqual(A.FOLD_SEASONS, (2023, 2024, 2025))

    def test_load_frozen_takes_the_latest_pre_kickoff_capture_and_never_a_late_row(self):
        con = sqlite3.connect(':memory:')
        con.executescript("""
          CREATE TABLE espn_weekly_projection_snapshots (season INTEGER, week INTEGER, espn_id INTEGER,
            projected_pts REAL, scoring_key TEXT, captured_at TEXT, kickoff_at TEXT, late INTEGER);
          INSERT INTO espn_weekly_projection_snapshots VALUES
            (2026, 6, 1, 10, 'ppr', '2026-10-17T13:00:00.000Z', '2026-10-18T17:00:00.000Z', 0),
            (2026, 6, 1, 11, 'ppr', '2026-10-18T15:00:00.000Z', '2026-10-18T17:00:00.000Z', 0),
            (2026, 6, 1, 99, 'ppr', '2026-10-18T18:00:00.000Z', '2026-10-18T17:00:00.000Z', 1),
            (2026, 6, 1, 55, 'league:4', '2026-10-18T15:30:00.000Z', '2026-10-18T17:00:00.000Z', 0);
        """)
        self.assertEqual(A.load_frozen(con, 2026)[(1, 2026, 6)], 11.0)
        self.assertEqual(A.load_frozen(con, 2026, as_of='2026-10-18T00:00:00.000Z')[(1, 2026, 6)], 10.0)

    def test_retro_files_must_say_retrospective(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'x.json')
            json.dump({'label': 'frozen', 'rows': []}, open(p, 'w'))
            with self.assertRaises(ValueError):
                A.load_retro([p])


class ForecastModeTest(unittest.TestCase):
    def test_a_forecast_row_ignores_that_week_and_matches_the_final_row(self):
        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, 'f.sqlite')
            TP.make_db(db)
            con = P.open_db(db)
            t = P.load_tables(con, TP.S, TP.S)
            con.close()
            final = P.build_panel(t, [TP.S])
            fc = P.build_panel(t, [TP.S], predict=(TP.S, 5))
            m, f = final['meta'], fc['meta']
            for pid in (1, 2, 3):
                i = int(np.where((m[:, 0] == pid) & (m[:, 3] == 5))[0][0])
                j = int(np.where((f[:, 0] == pid) & (f[:, 3] == 5))[0][0])
                self.assertEqual(fc['played'][j], -1)
                self.assertTrue(np.isnan(fc['y'][j]))
                np.testing.assert_array_equal(np.nan_to_num(final['X'][i]), np.nan_to_num(fc['X'][j]))


if __name__ == '__main__':
    unittest.main()
