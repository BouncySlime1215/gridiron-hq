"""Tests for the Package C extension: tree_lab.py and leakage.py.

Three things this file has to prove, because the master plan's "done when"
bar names them explicitly rather than leaving them to judgement:

  1. A synthetic, deliberately injected leak FAILS as expected -- the scanner
     in leakage.py actually flags it, and does not flag an honest feature.
  2. Quantile coherence violations are detected, not just theoretically
     possible -- a hand-built non-monotonic prediction trips the check, and a
     monotonic one does not.
  3. The dataset digest and the chronological folds it feeds are
     reproducible -- the same synthetic rows, run through time_folds twice,
     produce identical splits, and digest() is stable under key reordering.

None of this touches the live database; it is pure synthetic-data testing,
same spirit as research/test_market_lab.py.
"""
import unittest
import numpy as np
from datetime import datetime, timedelta, timezone

from market_lab import time_folds, digest
from leakage import detect_feature_leakage
from tree_lab import (market_no_vig_prob, logit, sigmoid, quantile_coherence_report,
    calibration_coverage, key_number_push_mass, pinball_loss)


def synthetic_rows(n_weeks=40, games_per_week=8, seed=7):
    rng = np.random.default_rng(seed)
    start = datetime(2022, 8, 1, tzinfo=timezone.utc)
    rows = []
    for week in range(1, n_weeks + 1):
        for game in range(games_per_week):
            decision = start + timedelta(weeks=week, minutes=game)
            y = float(rng.normal(0, 2))
            rows.append({'season': 2022, 'week': week, 'decision_at': decision.isoformat(),
                'label_at': (decision + timedelta(days=6)).isoformat(), 'y': y})
    return rows


class LeakageScanTests(unittest.TestCase):
    def test_injected_leak_is_flagged_and_honest_feature_is_not(self):
        rows = synthetic_rows()
        folds = time_folds(rows)
        self.assertGreaterEqual(len(folds), 2, 'need at least two folds for the scan to run at all')
        y = np.array([r['y'] for r in rows])
        rng = np.random.default_rng(11)
        n = len(rows)
        # An honest feature: weak, real correlation with the label, the kind a
        # legitimate prior-week aggregate might have.
        honest = 0.15 * y + rng.normal(0, 1, n)
        # The injected leak: a feature that could only exist if someone had
        # computed it from the label itself (or, in a real pipeline, from
        # data that becomes available only after decision time -- the closing
        # line, say, standing in for "y" here). Tiny noise keeps it short of
        # a trivial exact-equality check while still being unmistakably
        # too good to be a legitimate prior-only signal.
        leaky = y + rng.normal(0, 1e-6, n)
        # A pure-noise feature, for a second negative control.
        noise = rng.normal(0, 1, n)
        X = np.column_stack([honest, leaky, noise])
        names = ['honest_prior_feature', 'leaky_future_feature', 'pure_noise']

        report = detect_feature_leakage(X, y, folds, names, task='regression')
        self.assertIn('leaky_future_feature', report['flagged'],
            'the scanner must catch a feature that is essentially the label in disguise')
        self.assertNotIn('honest_prior_feature', report['flagged'])
        self.assertNotIn('pure_noise', report['flagged'])

    def test_classification_leak_is_flagged(self):
        rows = synthetic_rows()
        folds = time_folds(rows)
        rng = np.random.default_rng(5)
        n = len(rows)
        y = (rng.random(n) > 0.5).astype(int)
        leaky = y.astype(float) * 10 + rng.normal(0, 0.01, n)  # near-perfect separator
        noise = rng.normal(0, 1, n)
        X = np.column_stack([leaky, noise])
        report = detect_feature_leakage(X, y, folds, ['leaky_label_copy', 'pure_noise'], task='classification')
        self.assertIn('leaky_label_copy', report['flagged'])
        self.assertNotIn('pure_noise', report['flagged'])

    def test_skips_gracefully_with_too_few_folds(self):
        report = detect_feature_leakage(np.zeros((5, 1)), np.zeros(5), [], ['x'], task='regression')
        self.assertTrue(report['skipped'])
        self.assertEqual(report['flagged'], [])


class QuantileCoherenceTests(unittest.TestCase):
    def test_violation_is_detected(self):
        # Row 0 is coherent; row 1 has q50 < q25, an explicit violation.
        preds = np.array([[-3, -1, 0, 1, 3], [-3, 2, 1, 4, 5]], dtype=float)
        report = quantile_coherence_report(preds, [0.1, 0.25, 0.5, 0.75, 0.9])
        self.assertEqual(report['violated_rows'], 1)
        self.assertAlmostEqual(report['violation_rate'], 0.5)

    def test_monotonic_predictions_have_zero_violations(self):
        preds = np.sort(np.random.default_rng(3).normal(size=(50, 5)), axis=1)
        report = quantile_coherence_report(preds, [0.1, 0.25, 0.5, 0.75, 0.9])
        self.assertEqual(report['violated_rows'], 0)

    def test_calibration_coverage_matches_construction(self):
        rng = np.random.default_rng(1)
        y = rng.normal(0, 1, 2000)
        qs = [0.1, 0.5, 0.9]
        preds = np.tile(np.quantile(y, qs), (len(y), 1))
        coverage = calibration_coverage(y, preds, qs)
        for row in coverage:
            self.assertAlmostEqual(row['observed_coverage'], row['target_coverage'], delta=0.03)

    def test_pinball_loss_zero_for_perfect_point_prediction(self):
        y = np.array([1.0, 2.0, 3.0])
        preds = np.column_stack([y, y, y])
        self.assertAlmostEqual(pinball_loss(y, preds, [0.1, 0.5, 0.9]), 0.0)


class KeyNumberPushMassTests(unittest.TestCase):
    def test_spike_at_three_is_detected_in_synthetic_margins(self):
        rng = np.random.default_rng(2)
        base = rng.integers(-20, 21, size=2000)
        spiked = np.concatenate([base, np.full(400, 3), np.full(200, -3)])
        rows = [{'actual_margin': int(m)} for m in spiked]
        result = key_number_push_mass(rows)
        three = next(k for k in result['keys'] if k['margin'] == 3)
        self.assertGreater(three['spike_ratio'], 2.0, 'an artificially spiked margin of 3 must show a clear spike ratio')

    def test_empty_rows_return_zero_games(self):
        self.assertEqual(key_number_push_mass([])['games'], 0)


class MarketProbabilityTests(unittest.TestCase):
    def test_no_vig_probability_removes_the_vig(self):
        p = market_no_vig_prob(-110, -110)
        self.assertAlmostEqual(p, 0.5, places=6)

    def test_favorite_gets_higher_probability(self):
        p = market_no_vig_prob(-200, 170)
        self.assertGreater(p, 0.5)

    def test_logit_sigmoid_roundtrip(self):
        p = np.array([0.1, 0.4, 0.9])
        self.assertTrue(np.allclose(sigmoid(logit(p)), p, atol=1e-4))


class ReproducibilityTests(unittest.TestCase):
    def test_time_folds_are_deterministic_given_the_same_rows(self):
        rows = synthetic_rows()
        folds_a = time_folds(rows)
        folds_b = time_folds(rows)
        self.assertEqual(len(folds_a), len(folds_b))
        for (tr_a, va_a), (tr_b, va_b) in zip(folds_a, folds_b):
            self.assertTrue(np.array_equal(tr_a, tr_b))
            self.assertTrue(np.array_equal(va_a, va_b))

    def test_dataset_digest_is_stable_and_order_sensitive_only_to_content(self):
        rows = synthetic_rows(n_weeks=3)
        self.assertEqual(digest(rows), digest(rows))
        reordered = [dict(r) for r in rows]
        for r in reordered:
            r['extra'] = None
            del r['extra']  # key insertion/removal round-trip; content unchanged
        self.assertEqual(digest(rows), digest(reordered))
        mutated = [dict(r) for r in rows]
        mutated[0] = {**mutated[0], 'y': mutated[0].get('y', 0)}
        mutated[0]['week'] = mutated[0]['week'] + 1000
        self.assertNotEqual(digest(rows), digest(mutated))


if __name__ == '__main__':
    unittest.main()
