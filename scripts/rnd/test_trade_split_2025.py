"""Unit tests for scripts/rnd/trade_split_2025.py (RL-8-2b). Stdlib only; no data files.

Run: python3 -m unittest scripts/rnd/test_trade_split_2025.py
"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trade_split_2025 as S  # noqa: E402


def top2(rate):
    """Toy lineup: two flex slots, best two rates start."""
    return lambda players: sum(sorted((rate.get(p, 0.0) for p in players), reverse=True)[:2])


class Orient(unittest.TestCase):
    def test_two_for_two_uses_third_rng(self):
        rids = [4, 9]
        adds = {'a': 4, 'b': 4, 'c': 9, 'd': 9}
        drops = {'a': 9, 'b': 9, 'c': 4, 'd': 4}
        r1, r2 = random.Random(7), random.Random(8)
        got = S.orient_any(rids, adds, drops, r1, r2, random.Random(9))
        self.assertEqual(got[0], random.Random(9).choice(rids))
        self.assertEqual(got[3], '2for2')
        self.assertEqual((len(got[1]), len(got[2])), (2, 2))
        self.assertEqual(r1.random(), random.Random(7).random())   # 1-for-1 stream untouched
        self.assertEqual(r2.random(), random.Random(8).random())   # 2-for-1 stream untouched

    def test_three_for_one_is_rejected(self):
        adds = {'a': 1, 'b': 1, 'c': 1, 'd': 2}
        drops = {'a': 2, 'b': 2, 'c': 2, 'd': 1}
        self.assertIsNone(S.orient_any([1, 2], adds, drops, random.Random(1), random.Random(1), random.Random(1)))

    def test_one_for_one_and_two_for_one_delegate_to_rl82(self):
        got = S.orient_any([3, 7], {'p': 3, 'q': 7}, {'p': 7, 'q': 3}, random.Random(7), random.Random(8),
                           random.Random(9))
        self.assertEqual(got[3], '1for1')
        self.assertEqual(got[0], random.Random(7).choice([3, 7]))
        got = S.orient_any([1, 2], {'a': 1, 'b': 1, 'c': 2}, {'a': 2, 'b': 2, 'c': 1}, random.Random(7),
                           random.Random(8), random.Random(9))
        self.assertEqual(got[3], '2for1')


class LineupValue(unittest.TestCase):
    POS = {k: 'RB' for k in 'abcxyzw'}

    def test_even_trade_is_plain_lineup_change(self):
        rate = {'a': 10, 'b': 8, 'x': 12}
        lv = S.lineup_value(['a', 'b'], ['a'], ['x'], rate, self.POS, top2(rate), wire=[])
        self.assertEqual(lv['per_week'], 2.0)
        self.assertEqual(lv['roster_spots'], 0)

    def test_side_needing_a_spot_drops_the_least_missed(self):
        rate = {'a': 10, 'b': 8, 'c': 1, 'x': 9, 'y': 7}
        lv = S.lineup_value(['a', 'b', 'c'], ['a'], ['x', 'y'], rate, self.POS, top2(rate), wire=[])
        self.assertEqual(lv['dropped'], ['c'])          # c and y cost the lineup nothing; tie -> lower rate
        self.assertEqual(lv['per_week'], -1.0)          # 9 + 8 - (10 + 8)

    def test_side_freeing_a_spot_fills_from_the_wire(self):
        rate = {'x': 9, 'y': 7, 'z': 2, 'a': 10, 'w1': 6, 'w2': 5, 'w3': 3, 'z2': 99}
        pos = dict(self.POS, w1='RB', w2='WR', w3='RB', z2='RB')
        wire = ['w1', 'w2', 'w3', 'z', 'a']              # z and a are held after the trade: never offered
        lv = S.lineup_value(['x', 'y', 'z'], ['x', 'y'], ['a'], rate, pos, top2(rate), wire=wire)
        self.assertEqual(lv['replacement'], ['w1'])
        self.assertEqual(lv['per_week'], 0.0)           # 10 + 6 - (9 + 7)
        self.assertEqual(lv['unfilled_spots'], 0)       # the freed spot was filled
        bare = S.lineup_value(['x', 'y', 'z'], ['x', 'y'], ['a'], rate, pos, top2(rate), wire=[])
        self.assertEqual(bare['per_week'], -4.0)        # 10 + 2 - 16: the spot stays empty
        self.assertEqual(bare['unfilled_spots'], 1)

    def test_fill_takes_the_best_per_position_then_the_biggest_lineup_gain(self):
        # Best RB on the wire (w1, 6) beats the best WR (w2, 5) on lineup gain.
        rate = {'a': 1, 'b': 1, 'c': 1, 'w1': 6, 'w2': 5, 'n': 0}
        pos = {'a': 'RB', 'b': 'RB', 'c': 'RB', 'w1': 'RB', 'w2': 'WR', 'n': 'RB'}
        lv = S.lineup_value(['a', 'b'], ['a', 'b'], ['c'], rate, pos, top2(rate), wire=['w2', 'w1'])
        self.assertEqual(lv['replacement'], ['w1'])

    def test_fill_prefers_the_biggest_lineup_gain_over_the_highest_rate(self):
        # One RB slot and one WR slot. The best RB on the wire (6) adds 1 over the held RB (5); the best WR (3)
        # fills an empty slot and adds 3, so the WR is picked although its rate is lower.
        rate = {'a': 4, 'b': 4, 'c': 5, 'w1': 6, 'w2': 3}
        pos = {'a': 'WR', 'b': 'WR', 'c': 'RB', 'w1': 'RB', 'w2': 'WR'}

        def rb_wr(players):
            best = lambda ps: max([rate[p] for p in players if pos[p] == ps] or [0])  # noqa: E731
            return best('RB') + best('WR')
        lv = S.lineup_value(['a', 'b'], ['a', 'b'], ['c'], rate, pos, rb_wr, wire=['w1', 'w2'])
        self.assertEqual(lv['replacement'], ['w2'])
        self.assertEqual(lv['per_week'], 4.0)           # 5 + 3 - (0 + 4)


class Verdicts(unittest.TestCase):
    def test_arm_a_needs_rate_above_055_and_lower_bound_above_050(self):
        self.assertEqual(S.verdict_a(0.56, 0.51), 'PASS')
        self.assertEqual(S.verdict_a(0.55, 0.51), 'FAIL')    # strictly above 0.55
        self.assertEqual(S.verdict_a(0.60, 0.50), 'FAIL')
        self.assertEqual(S.verdict_a(None, None), 'FAIL')

    def test_arm_b_also_needs_summed_consensus_to_fail(self):
        self.assertEqual(S.verdict_b(0.60, 0.52, 0.50), 'PASS')
        self.assertEqual(S.verdict_b(0.60, 0.52, 0.51), 'FAIL')
        self.assertEqual(S.verdict_b(0.55, 0.52, 0.40), 'FAIL')
        self.assertEqual(S.verdict_b(0.60, 0.49, 0.40), 'FAIL')


class SkillSlots(unittest.TestCase):
    def test_kicker_defense_and_bench_are_left_out(self):
        self.assertEqual(S.skill_slots(['QB', 'RB', 'RB', 'WR', 'FLEX', 'K', 'DEF', 'SUPER_FLEX']),
                         ['QB', 'RB', 'RB', 'WR', 'FLEX', 'SUPER_FLEX'])
        self.assertIsNone(S.skill_slots(None))


class PickRate(unittest.TestCase):
    def test_counts_only_nonzero_model_and_outcome(self):
        rows = [dict(m=1, y=2), dict(m=-1, y=3), dict(m=0, y=1), dict(m=2, y=0), dict(m=-3, y=-1)]
        rate, n, ties = S.pick_rate(rows, 'm', 'y')
        self.assertEqual((rate, n), (2 / 3, 3))


if __name__ == '__main__':
    unittest.main()


class Sources(unittest.TestCase):
    """FIX-207-2: read the worktree's own data/, never the live repo clone (as --local-db never reads the live DB)."""
    HERE = os.path.dirname(os.path.abspath(__file__))

    def test_repo_data_defaults_to_this_worktree(self):
        want = os.path.normpath(os.path.join(self.HERE, '..', '..', 'data'))
        self.assertEqual(S.DEFAULT_REPO_DATA, want)
        args = S.build_parser().parse_args(['--local-db', 'copy.sqlite'])
        self.assertEqual(args.repo_data, want)
        self.assertNotIn('/Users/', open(os.path.join(self.HERE, 'trade_split_2025.py')).read())

    def test_live_repo_clone_is_refused(self):
        live = os.path.join(self.HERE, 'fake-live-clone')
        with self.assertRaises(SystemExit) as cm:
            S.check_sources('copy.sqlite', os.path.join(live, 'data'), gl='/gl', live_repo=live)
        self.assertIn('live repo clone', str(cm.exception))
        # the same path spelled differently is still the live clone
        with self.assertRaises(SystemExit):
            S.check_sources('copy.sqlite', os.path.join(live, 'x', '..', 'data') + os.sep, gl='/gl', live_repo=live)
        S.check_sources('copy.sqlite', os.path.join(self.HERE, 'data'), gl='/gl', live_repo=live)  # a worktree: fine

    def test_live_db_is_still_refused(self):
        with self.assertRaises(SystemExit) as cm:
            S.check_sources('/gl/data.sqlite', os.path.join(self.HERE, 'data'), gl='/gl', live_repo='/nowhere')
        self.assertIn('live data.sqlite', str(cm.exception))
