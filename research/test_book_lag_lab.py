import ast
import math
import unittest
from pathlib import Path

from book_lag_lab import (
    EventPanel, american_to_prob, build_all_panels, fit_exponential_hazard,
    hawkes_feasibility, lead_lag_matrix, novig_probability, run_target1,
    run_target2, survival_at,
)


def quote(event_key, market, book, snapshot_at, line, price=-110, book_updated_at=None,
          minutes_to_kickoff=1000.0):
    return {'event_key': event_key, 'market': market, 'period': 'full_game',
            'side': 'home' if market == 'spreads' else 'over', 'book': book,
            'snapshot_at': snapshot_at, 'book_updated_at': book_updated_at or snapshot_at,
            'line': line, 'price': price, 'minutes_to_kickoff': minutes_to_kickoff}


TIMES = [f'2026-09-02T{h:02d}:00:00.000Z' for h in range(10)]


class NoVigTests(unittest.TestCase):
    def test_american_to_prob(self):
        self.assertAlmostEqual(american_to_prob(-110), 110 / 210)
        self.assertAlmostEqual(american_to_prob(100), 0.5)
        self.assertIsNone(american_to_prob(50))  # inside (-100, 100): not a legal American price
        self.assertIsNone(american_to_prob(None))

    def test_novig_probability_removes_symmetric_vig(self):
        # -110/-110 is a classic ~4.5% vig book; no-vig probability must land at exactly 0.5.
        self.assertAlmostEqual(novig_probability(-110, -110), 0.5)

    def test_novig_probability_asymmetric(self):
        p = novig_probability(-150, 130)
        self.assertTrue(0.55 < p < 0.62)


class EventPanelTests(unittest.TestCase):
    def test_forward_fill_stops_after_max_gap(self):
        books = {
            'a': [quote('e1', 'spreads', 'a', TIMES[0], -3.0), quote('e1', 'spreads', 'a', TIMES[9], -3.0)],
            'b': [quote('e1', 'spreads', 'b', t, -3.0) for t in TIMES],
        }
        panel = EventPanel('e1', 'spreads', books)
        # 'a' has no row between index 0 and 9: filled must go stale (None) before it reaches index 9.
        self.assertIsNotNone(panel.filled['a'][1])
        self.assertIsNone(panel.filled['a'][5])

    def test_move_detected_only_above_threshold(self):
        books = {
            'a': [quote('e1', 'spreads', 'a', TIMES[0], -3.0), quote('e1', 'spreads', 'a', TIMES[1], -3.2),
                  quote('e1', 'spreads', 'a', TIMES[2], -4.0)],
            'b': [quote('e1', 'spreads', 'b', t, -3.0) for t in TIMES[:3]],
        }
        panel = EventPanel('e1', 'spreads', books)
        # -3.0 -> -3.2 is below MIN_MOVE (0.5) and must not register as a move.
        self.assertEqual(len(panel.moves['a']), 1)
        self.assertAlmostEqual(panel.moves['a'][0]['delta'], -0.8, places=4)

    def test_missing_quote_is_a_real_gap_not_a_move(self):
        books = {
            'a': [quote('e1', 'totals', 'a', TIMES[0], 47.0), quote('e1', 'totals', 'a', TIMES[2], 47.0)],
            'b': [quote('e1', 'totals', 'b', t, 47.0) for t in TIMES[:3]],
        }
        panel = EventPanel('e1', 'totals', books)
        self.assertIsNone(panel.observed['a'][1])
        self.assertEqual(len(panel.moves['a']), 0)


class LeadLagTests(unittest.TestCase):
    def test_leader_moves_first_and_follower_is_credited(self):
        rows = ([quote('e1', 'spreads', 'sharp', TIMES[0], -3.0)]
                + [quote('e1', 'spreads', 'sharp', t, -3.5) for t in TIMES[1:5]]
                + [quote('e1', 'spreads', 'soft', TIMES[0], -3.0),
                   quote('e1', 'spreads', 'soft', TIMES[1], -3.0),  # lags one step
                   quote('e1', 'spreads', 'soft', TIMES[2], -3.5)])  # then matches
        panels = build_all_panels(rows)
        matrix = lead_lag_matrix(panels)
        pair = next(p for p in matrix['pairs'] if p['leader'] == 'sharp' and p['follower'] == 'soft')
        self.assertEqual(pair['confirmed_leads'], 1)
        self.assertGreater(pair['median_lag_minutes'], 0)
        # Symmetry: nothing hardcodes 'sharp' as special — it is just the book whose move led this once.
        self.assertNotIn('permanent_reference', matrix)

    def test_no_hardcoded_book_name_in_module(self):
        # The module docstring legitimately explains, in English, that
        # sharp-lag.js hardcodes Pinnacle and this module deliberately does
        # not. What must never appear is a comparison/constant that special-
        # cases a book name in actual code (e.g. `== 'pinnacle'`).
        import book_lag_lab
        src = Path(book_lag_lab.__file__).read_text()
        code_only = ast.get_docstring(ast.parse(src))
        body = src.replace(code_only or '', '')
        for forbidden in ("'pinnacle'", '"pinnacle"', "'Pinnacle'", '"Pinnacle"'):
            self.assertNotIn(forbidden, body, 'Package B must not hardcode a permanent sharp book in code')


class HawkesFeasibilityTests(unittest.TestCase):
    def test_flags_fetch_time_fallback_and_recommends_against_fitting(self):
        rows = [quote('e1', 'spreads', 'a', t, -3.0, book_updated_at=t) for t in TIMES]  # always equals snapshot_at
        panels = build_all_panels(rows)
        result = hawkes_feasibility(rows, panels)
        self.assertFalse(result['attempted'])
        self.assertFalse(result['would_be_feasible'])
        self.assertEqual(result['fetch_time_fallback_share'], 1.0)

    def test_sparse_moves_relative_to_parameters_blocks_fit(self):
        rows = ([quote('e1', 'spreads', b, TIMES[0], -3.0, book_updated_at='2026-09-01T00:00:00.000Z')
                 for b in ['a', 'b', 'c']])
        panels = build_all_panels(rows)
        result = hawkes_feasibility(rows, panels)
        self.assertFalse(result['would_be_feasible'])


class SurvivalTests(unittest.TestCase):
    def test_exponential_fit_and_extrapolation_direction(self):
        # A 40% hazard per ~3600s step implies decreasing survival as delay grows.
        rate = fit_exponential_hazard({'0': 0.4}, 3600)
        self.assertIsNotNone(rate)
        s5 = survival_at(rate, 5)
        s600 = survival_at(rate, 600)
        s3600 = survival_at(rate, 3600)
        self.assertTrue(s5 > s600 > s3600)
        self.assertAlmostEqual(s3600, 0.6, places=6)  # 1 - hazard, by construction

    def test_degenerate_hazard_returns_none(self):
        self.assertIsNone(fit_exponential_hazard({'0': 0.0}, 3600))
        self.assertIsNone(fit_exponential_hazard({'0': 1.0}, 3600))
        self.assertIsNone(fit_exponential_hazard({}, 3600))


class TargetGateTests(unittest.TestCase):
    def test_sparse_data_reports_not_readable_rather_than_a_verdict(self):
        rows = [quote('e1', 'spreads', 'a', TIMES[0], -3.0), quote('e1', 'spreads', 'b', TIMES[0], -3.0)]
        panels = build_all_panels(rows)
        trials = []
        t1 = run_target1(panels, 'spreads', trials)
        for cell in t1.values():
            self.assertFalse(cell['readable'])
        t2 = run_target2(panels, 'spreads', trials)
        self.assertFalse(t2['readable'])


if __name__ == '__main__':
    unittest.main()
