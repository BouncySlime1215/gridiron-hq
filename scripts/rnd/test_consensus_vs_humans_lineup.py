"""Unit tests for scripts/rnd/consensus_vs_humans_lineup.py (RL-8-2). Stdlib + numpy only; no data files.

Run: python3 -m unittest scripts/rnd/test_consensus_vs_humans_lineup.py
"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import consensus_vs_humans_lineup as C  # noqa: E402


class Orient(unittest.TestCase):
    def test_one_for_one_uses_primary_rng_like_r8(self):
        # r8 draws the side with rng.choice(rids) for 1-for-1 trades; the same seed must give the same side.
        rids = [3, 7]
        adds = {'p1': 3, 'p2': 7}
        drops = {'p1': 7, 'p2': 3}
        expect = random.Random(7).choice(rids)
        got = C.orient(rids, adds, drops, random.Random(7), random.Random(99))
        self.assertEqual(got[0], expect)
        self.assertEqual(got[3], '1for1')
        recv = [p for p, r in adds.items() if r == expect]
        self.assertEqual(got[1], recv)

    def test_two_for_one_uses_second_rng_and_leaves_primary_untouched(self):
        rids = [1, 2]
        adds = {'a': 1, 'b': 1, 'c': 2}
        drops = {'a': 2, 'b': 2, 'c': 1}
        rng = random.Random(7)
        got = C.orient(rids, adds, drops, rng, random.Random(5))
        self.assertEqual(got[3], '2for1')
        self.assertEqual(sorted([len(got[1]), len(got[2])]), [1, 2])
        self.assertEqual(rng.random(), random.Random(7).random())  # primary stream not consumed

    def test_rejects_bundled_free_agent_and_three_team(self):
        self.assertIsNone(C.orient([1, 2], {'a': 1, 'b': 2}, {'a': 2, 'x': 1}, random.Random(1), random.Random(1)))
        self.assertIsNone(C.orient([1, 2, 3], {'a': 1, 'b': 2}, {'a': 2, 'b': 1}, random.Random(1), random.Random(1)))
        self.assertIsNone(C.orient([1, 2], {'a': 1, 'b': 1, 'c': 1, 'd': 2},
                                   {'a': 2, 'b': 2, 'c': 2, 'd': 1}, random.Random(1), random.Random(1)))

    def test_rejects_two_for_two(self):
        adds = {'a': 1, 'b': 1, 'c': 2, 'd': 2}
        drops = {'a': 2, 'b': 2, 'c': 1, 'd': 1}
        self.assertIsNone(C.orient([1, 2], adds, drops, random.Random(1), random.Random(1)))


class ValueDiff(unittest.TestCase):
    def test_one_for_one_is_raw_difference(self):
        self.assertAlmostEqual(C.value_diff([(12.0, 'WR')], [(9.0, 'RB')], '1for1'), 3.0)

    def test_two_for_one_is_above_replacement(self):
        repl = C.REPL_PPG_DEFAULT
        got = C.value_diff([(10.0, 'WR'), (8.0, 'WR')], [(15.0, 'RB')], '2for1', repl)
        want = (10.0 - repl['WR']) + (8.0 - repl['WR']) - (15.0 - repl['RB'])
        self.assertAlmostEqual(got, want)


class Disagreement(unittest.TestCase):
    def test_signs(self):
        self.assertTrue(C.is_disagreement(1.0, -0.5))
        self.assertFalse(C.is_disagreement(1.0, 0.5))
        self.assertFalse(C.is_disagreement(0.0, -0.5))
        self.assertFalse(C.is_disagreement(1.0, 0.0))


class WinRate(unittest.TestCase):
    def test_excludes_ties_and_reports_tie_share(self):
        pairs = [(1.0, 2.0), (1.0, -1.0), (-2.0, -3.0), (1.0, 0.0)]
        rate, n, ties = C.win_rate(pairs)
        self.assertAlmostEqual(rate, 2 / 3)
        self.assertEqual(n, 3)
        self.assertAlmostEqual(ties, 0.25)

    def test_empty_is_none_not_zero(self):
        self.assertEqual(C.win_rate([(1.0, 0.0)])[0], None)

    def test_signed_mean(self):
        self.assertAlmostEqual(C.signed_mean([(2.0, 1.5), (-1.0, 0.5)]), (1.5 - 0.5) / 2)


class PerWeek(unittest.TestCase):
    def test_divides_and_refuses_zero_weeks(self):
        self.assertAlmostEqual(C.per_week(30.0, 6), 5.0)
        self.assertIsNone(C.per_week(30.0, 0))
        self.assertIsNone(C.per_week(None, 5))


class Bootstrap(unittest.TestCase):
    def test_clusters_resampled_whole(self):
        # two clusters: one all wins, one all losses; a cluster bootstrap can only produce 0, 0.5 or 1 shares
        rows = [dict(k='a', x=1.0, y=1.0)] * 5 + [dict(k='b', x=1.0, y=-1.0)] * 5
        stat = lambda q: C.win_rate([(r['x'], r['y']) for r in q])[0]
        est, lo, hi, se, nc = C.cluster_boot(rows, stat, 'k', reps=400, seed=1)
        self.assertAlmostEqual(est, 0.5)
        self.assertEqual(nc, 2)
        self.assertIn(round(lo, 6), (0.0, 0.5))
        self.assertIn(round(hi, 6), (0.5, 1.0))
        self.assertGreater(se, 0.2)

    def test_resample_carries_every_row_of_a_drawn_cluster(self):
        # added after the mutation sweep: identical rows let a "one row per cluster" bootstrap pass the test above
        rows = [dict(k='a')] * 5 + [dict(k='b')]
        est, lo, hi, se, nc = C.cluster_boot(rows, len, 'k', reps=400, seed=2)
        self.assertEqual(est, 6)
        self.assertEqual(hi, 10)   # {a, a} drawn: 10 rows
        self.assertEqual(lo, 2)    # {b, b} drawn: 2 rows

    def test_interval_is_prereg_90_percent(self):
        # added after skeptic review: prereg item 7 fixes a 90% interval; 2-cluster fixtures cannot tell 5/95 from 2.5/97.5
        import numpy as np
        rows = [dict(k=i, v=float(i * i)) for i in range(40)]
        stat = lambda q: sum(r['v'] for r in q) / len(q)
        est, lo, hi, se, nc = C.cluster_boot(rows, stat, 'k', reps=500, seed=7)
        rg = np.random.default_rng(7)
        boot = [sum(rows[i]['v'] for i in rg.integers(0, 40, 40)) / 40 for _ in range(500)]
        p5, p95 = np.percentile(boot, [5, 95])
        p25, p975 = np.percentile(boot, [2.5, 97.5])
        self.assertGreater(abs(p5 - p25), 1.0)     # fixture really separates the two levels
        self.assertGreater(abs(p975 - p95), 1.0)
        self.assertAlmostEqual(lo, p5, places=9)
        self.assertAlmostEqual(hi, p95, places=9)
        self.assertEqual(nc, 40)

    def test_mde_uses_house_constant(self):
        self.assertAlmostEqual(C.MDE_Z, 1.6449 + 0.8416)
        self.assertAlmostEqual(C.mde80(0.04), 0.04 * (1.6449 + 0.8416))


class Gate(unittest.TestCase):
    def test_pass_needs_all_three(self):
        self.assertEqual(C.gate_verdict(0.58, 0.52, 0.51, 0.1), 'PASS')
        self.assertEqual(C.gate_verdict(0.549, 0.52, 0.51, 0.1), 'FAIL')
        self.assertEqual(C.gate_verdict(0.58, 0.50, 0.51, 0.1), 'FAIL')
        self.assertEqual(C.gate_verdict(0.58, 0.52, 0.49, 0.1), 'FAIL')
        self.assertEqual(C.gate_verdict(0.58, 0.52, 0.51, 0.0), 'FAIL')
        self.assertEqual(C.gate_verdict(None, 0.52, 0.51, 0.1), 'FAIL')


if __name__ == '__main__':
    unittest.main()
