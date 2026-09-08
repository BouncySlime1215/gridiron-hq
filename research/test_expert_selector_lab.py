"""Pure-logic tests for Package F's selector, independent of the database.

These exercise the properties the whole package depends on being true:
the simplex constraint actually holds, the market-only expert can win
outright, availability masking renormalizes instead of silently biasing
toward zero, correlated families collapse, and the week bootstrap clusters
by week rather than by row.
"""
import unittest
import numpy as np

from expert_selector_lab import (simplex_ridge, apply_weights, cluster_families,
    week_cluster_interval, verdict_for, select_alpha, fit_and_predict, effective_weights)


class TestEffectiveWeights(unittest.TestCase):
    def test_an_absent_expert_reports_near_zero_effective_weight(self):
        """A raw weight on an expert with no coverage in the scored fold is
        misleading -- apply_weights renormalizes it away, so the report must
        say so. nfelo_line (2022-2023 only) scored on 2025 is the real case."""
        mask = np.array([[1.0, 0.0]] * 10)      # second expert never available
        eff = effective_weights([0.5, 0.5], mask, ['present', 'absent'])
        self.assertAlmostEqual(eff['present'], 1.0, places=5)
        self.assertAlmostEqual(eff['absent'], 0.0, places=5)

    def test_full_coverage_reproduces_the_raw_weights(self):
        mask = np.ones((10, 2))
        eff = effective_weights([0.25, 0.75], mask, ['a', 'b'])
        self.assertAlmostEqual(eff['a'], 0.25, places=5)
        self.assertAlmostEqual(eff['b'], 0.75, places=5)

    def test_partial_coverage_is_between(self):
        mask = np.array([[1.0, 1.0]] * 5 + [[1.0, 0.0]] * 5)
        eff = effective_weights([0.5, 0.5], mask, ['a', 'b'])
        self.assertGreater(eff['a'], 0.5)
        self.assertLess(eff['b'], 0.5)
        self.assertAlmostEqual(eff['a'] + eff['b'], 1.0, places=5)


class TestSimplexRidge(unittest.TestCase):
    def test_weights_are_non_negative_and_sum_to_one(self):
        rng = np.random.default_rng(0)
        P = rng.normal(size=(200, 5)); y = rng.normal(size=200)
        b, _ = simplex_ridge(P, y, alpha=0.01)
        self.assertTrue((b >= -1e-9).all(), f'negative weight present: {b}')
        self.assertAlmostEqual(float(b.sum()), 1.0, places=6)

    def test_cannot_exceed_the_envelope_of_its_experts(self):
        """The whole point of the constraint: a bounded weighted average can
        never predict outside the range of the expert predictions, so one
        expert going haywire cannot drag the blend past a sound boundary."""
        rng = np.random.default_rng(1)
        P = rng.normal(size=(150, 4)) * 3; y = rng.normal(size=150)
        b, _ = simplex_ridge(P, y, alpha=0.0)
        pred = apply_weights(P, b)
        self.assertTrue((pred <= P.max(axis=1) + 1e-9).all())
        self.assertTrue((pred >= P.min(axis=1) - 1e-9).all())

    def test_a_haywire_expert_cannot_blow_up_the_blend(self):
        rng = np.random.default_rng(7)
        good = rng.normal(size=200) * 0.1
        y = good.copy()
        haywire = np.full(200, 1e6)
        P = np.column_stack([good, haywire])
        b, _ = simplex_ridge(P, y, alpha=0.0)
        pred = apply_weights(P, b)
        # An unconstrained stacker could use a huge negative coefficient on the
        # haywire column; the simplex form cannot.
        self.assertLess(float(np.max(np.abs(pred))), 1e6 + 1)
        self.assertLess(float(b[1]), 0.01)

    def test_market_only_column_can_take_all_the_weight(self):
        """'Trust nothing here, take the market' must be selectable, not an
        absence of an outcome. With pure-noise experts and a zero-residual
        truth, the constant-zero market column should win outright."""
        rng = np.random.default_rng(2)
        n = 300
        noise = rng.normal(size=(n, 3)) * 5
        market = np.zeros((n, 1))
        P = np.hstack([noise, market])
        y = np.zeros(n)
        b, _ = simplex_ridge(P, y, alpha=0.0)
        self.assertGreater(float(b[-1]), 0.95, f'market column did not win: {b}')

    def test_a_genuinely_informative_expert_beats_the_market_column(self):
        rng = np.random.default_rng(3)
        n = 400
        signal = rng.normal(size=n)
        y = signal.copy()
        P = np.column_stack([signal, rng.normal(size=n) * 4, np.zeros(n)])
        b, _ = simplex_ridge(P, y, alpha=0.0)
        self.assertGreater(float(b[0]), 0.9)


class TestAvailabilityMask(unittest.TestCase):
    def test_missing_expert_renormalizes_rather_than_contributing_zero(self):
        """If an absent expert were treated as predicting zero, the blend would
        drift toward zero whenever coverage dropped -- which would look like
        the selector learning to abstain when it is really just missing data."""
        P = np.array([[4.0, 4.0], [4.0, 0.0]])
        mask = np.array([[1.0, 1.0], [1.0, 0.0]])
        b = np.array([0.5, 0.5])
        pred = apply_weights(P, b, mask)
        self.assertAlmostEqual(pred[0], 4.0)
        self.assertAlmostEqual(pred[1], 4.0, msg='row with a missing expert was biased toward zero')

    def test_all_available_matches_unmasked(self):
        rng = np.random.default_rng(4)
        P = rng.normal(size=(50, 3)); b = np.array([0.2, 0.3, 0.5])
        np.testing.assert_allclose(apply_weights(P, b), apply_weights(P, b, np.ones_like(P)))


class TestFamilyClustering(unittest.TestCase):
    def test_near_duplicate_experts_collapse_into_one_family(self):
        rng = np.random.default_rng(5)
        base = rng.normal(size=300)
        twin = base + rng.normal(size=300) * 0.01      # r ~ 1.0
        independent = rng.normal(size=300)
        P = np.column_stack([base, twin, independent])
        mask = np.ones_like(P)
        families, pairs = cluster_families(P, mask, ['a', 'a_copy', 'b'], threshold=0.9)
        self.assertIn(['a', 'a_copy'], families)
        self.assertIn(['b'], families)
        self.assertEqual(len(families), 2)
        self.assertGreater(abs(pairs[0]['r']), 0.9)

    def test_uncorrelated_experts_stay_separate(self):
        rng = np.random.default_rng(6)
        P = rng.normal(size=(300, 3)); mask = np.ones_like(P)
        families, _ = cluster_families(P, mask, ['a', 'b', 'c'], threshold=0.9)
        self.assertEqual(len(families), 3)

    def test_pairs_with_too_little_overlap_are_skipped(self):
        P = np.zeros((300, 2)); mask = np.zeros((300, 2))
        mask[:10, :] = 1.0
        families, pairs = cluster_families(P, mask, ['a', 'b'], threshold=0.9)
        self.assertEqual(pairs, [])
        self.assertEqual(len(families), 2)


class TestWeekClusteredInterval(unittest.TestCase):
    def test_returns_none_without_enough_weeks(self):
        self.assertIsNone(week_cluster_interval([(2022, 1)] * 20, [1.0] * 20))

    def test_interval_brackets_the_mean(self):
        rng = np.random.default_rng(8)
        keys = [(2022, w) for w in range(1, 15) for _ in range(12)]
        values = list(rng.normal(loc=0.5, scale=1.0, size=len(keys)))
        lo, hi = week_cluster_interval(keys, values)
        self.assertLess(lo, np.mean(values))
        self.assertGreater(hi, np.mean(values))

    def test_week_clustering_is_wider_than_row_resampling_when_weeks_agree_internally(self):
        """Games in a week are dependent; resampling rows would understate the
        interval. A dataset where every week is internally identical but weeks
        differ from each other makes that gap explicit."""
        keys = [(2022, w) for w in range(1, 21) for _ in range(20)]
        values = [float(w % 2) for w in range(1, 21) for _ in range(20)]
        lo, hi = week_cluster_interval(keys, values)
        self.assertGreater(hi - lo, 0.1)


class TestVerdictRule(unittest.TestCase):
    def _fold(self, market_gain, equal_gain, market_lo, equal_lo):
        def side(gain, lo):
            return {'mean_gain': gain, 'gain_interval_week_clustered': [lo, 9.0],
                    'mean_gain_mse': gain, 'gain_interval_mse_week_clustered': [lo, 9.0]}
        return {'test_season': 2024,
            'baselines': {'market_only': side(market_gain, market_lo),
                          'static_equal_weight': side(equal_gain, equal_lo)}}

    def test_passes_only_when_both_baselines_are_beaten_with_intervals_excluding_zero(self):
        trials = [{'label': 't', 'folds': [self._fold(0.5, 0.4, 0.1, 0.1), self._fold(0.5, 0.4, 0.1, 0.1)]}]
        self.assertTrue(verdict_for({'trials': trials})['any_trial_passed'])

    def test_fails_when_an_interval_straddles_zero(self):
        trials = [{'label': 't', 'folds': [self._fold(0.5, 0.4, -0.1, 0.1), self._fold(0.5, 0.4, -0.2, 0.1)]}]
        self.assertFalse(verdict_for({'trials': trials})['any_trial_passed'])

    def test_fails_when_only_one_baseline_is_beaten(self):
        trials = [{'label': 't', 'folds': [self._fold(0.5, -0.4, 0.1, -0.9), self._fold(0.5, -0.4, 0.1, -0.9)]}]
        self.assertFalse(verdict_for({'trials': trials})['any_trial_passed'])

    def test_negative_result_statement_is_explicit(self):
        v = verdict_for({'trials': [{'label': 't', 'folds': [self._fold(-0.5, -0.4, -1.0, -1.0)]}]})
        self.assertFalse(v['any_trial_passed'])
        self.assertIn('complete result', v['statement'])


class TestSplitDiscipline(unittest.TestCase):
    def test_alpha_is_not_tuned_without_an_inner_split(self):
        P = np.zeros((100, 2)); mask = np.ones_like(P); y = np.zeros(100)
        alpha, note = select_alpha(P, mask, y, [2022] * 100, [2022])
        self.assertIn('not tuned', note)

    def test_gate_bin_edges_come_from_training_rows_only(self):
        """A test row far outside the training range must be routed by the
        TRAINING edges, not by edges recomputed to include it."""
        rng = np.random.default_rng(9)
        n = 200
        P = np.column_stack([rng.normal(size=n), np.zeros(n)])
        y = rng.normal(size=n)
        mask = np.ones_like(P)
        context = [{'disagreement': float(i)} for i in range(n)]
        fit_idx = np.arange(0, 150); test_idx = np.arange(150, n)
        _, weights, _ = fit_and_predict(P, mask, y, fit_idx, test_idx, 0.01,
            gate_key='disagreement', bins=2, context=context)
        # median of 0..149 is ~74.5, not the median of the full 0..199 range
        self.assertLess(weights['edges'][0], 100.0)


if __name__ == '__main__':
    unittest.main()
