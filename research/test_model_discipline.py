"""Tests for research/model_discipline.py.

The point of the module is that the numerator of the ratio is different per
target type, so most of what is worth testing is the LABEL-FREQUENCY logic:
that a 660-row classification fold with 40 positives is treated as 40
observations and not 660, that a hazard fold is counted in events and not in
at-risk rows, that a quantile fit is bound by its most extreme quantile, and
that the degenerate cases (one class, one cluster, constant label, no
features, no rows) each produce a specific readable verdict instead of a
divide-by-zero or an accidental pass.

Run from research/:  python -m unittest test_model_discipline
"""
import ast
import unittest
from pathlib import Path

import numpy as np

from model_discipline import (DisciplineError, RATIO_CONTINUOUS, RATIO_EVENTS,
    check_fold, cluster_design_effect, effective_observations, enforce, record, summarize)


def labels(n_pos, n_neg):
    return np.array([1.0] * n_pos + [0.0] * n_neg)


class EffectiveObservationsByTargetType(unittest.TestCase):
    def test_classification_counts_the_minority_class_not_the_rows(self):
        """The doc's own example: 660 rows, 40 positives, 40 observations."""
        obs = effective_observations(labels(40, 620), target_type='binary_classification')
        self.assertEqual(obs['rows'], 660)
        self.assertEqual(obs['effective_n'], 40.0)
        self.assertEqual(obs['detail']['positives'], 40.0)

    def test_classification_is_symmetric_in_the_rare_class(self):
        rare_negatives = effective_observations(labels(620, 40), target_type='binary_classification')
        self.assertEqual(rare_negatives['effective_n'], 40.0)

    def test_classification_bar_is_stricter_than_a_flat_15_to_1_on_a_balanced_target(self):
        """The module's claim, checked rather than asserted in prose: on this
        project's near-50/50 cover/over target, 10 events per column demands
        about 20 rows per column, more than the proposal's flat 15:1."""
        features = 30
        rows_needed_flat = 15 * features
        y = labels(rows_needed_flat // 2, rows_needed_flat - rows_needed_flat // 2)
        v = check_fold(package='C', label='balanced', target_type='binary_classification',
                       y=y, feature_count=features)
        self.assertFalse(v['passed'])  # 15:1 on rows is NOT enough for a balanced classifier
        y_big = labels(20 * features // 2 + 5, 20 * features // 2 + 5)
        self.assertTrue(check_fold(package='C', label='balanced-2x', target_type='binary_classification',
                                   y=y_big, feature_count=features)['passed'])

    def test_regression_counts_every_row_but_reports_label_concentration(self):
        """A game whose line never moved is a real observation of 'no move',
        so a zero-inflated regression label is NOT discounted -- but the
        concentration is measured and reported."""
        y = np.array([0.0] * 900 + [1.0, -1.0, 2.5, -3.0] * 25)
        obs = effective_observations(y, target_type='continuous_regression')
        self.assertEqual(obs['effective_n'], float(len(y)))
        self.assertGreater(obs['detail']['mass_at_mode'], 0.8)
        self.assertEqual(obs['detail']['mode_value'], 0.0)

    def test_constant_regression_label_has_no_effective_observations(self):
        obs = effective_observations(np.zeros(500), target_type='continuous_regression')
        self.assertEqual(obs['effective_n'], 0.0)
        self.assertIn('constant', obs['basis'])

    def test_hazard_counts_follow_events_not_at_risk_step_rows(self):
        """Twelve races, each eight polls long: 96 rows, 12 events."""
        y = np.array(([0.0] * 7 + [1.0]) * 12)
        obs = effective_observations(y, target_type='discrete_time_hazard')
        self.assertEqual(obs['rows'], 96)
        self.assertEqual(obs['effective_n'], 12.0)
        self.assertEqual(obs['detail']['at_risk_rows'], 96)

    def test_quantile_binds_on_the_most_extreme_quantile(self):
        obs = effective_observations(np.arange(900, dtype=float), target_type='quantile_regression',
                                     quantiles=[0.1, 0.25, 0.5, 0.75, 0.9])
        self.assertAlmostEqual(obs['effective_n'], 90.0, places=3)
        self.assertIn(obs['detail']['binding_quantile'], (0.1, 0.9))
        median_only = effective_observations(np.arange(900, dtype=float),
                                             target_type='quantile_regression', quantiles=[0.5])
        self.assertAlmostEqual(median_only['effective_n'], 450.0, places=3)

    def test_quantile_requires_a_grid(self):
        with self.assertRaises(ValueError):
            effective_observations(np.arange(10, dtype=float), target_type='quantile_regression')

    def test_simplex_reports_free_parameters_as_experts_minus_one(self):
        mask = np.ones((400, 7))
        obs = effective_observations(np.random.default_rng(1).normal(size=400),
                                     target_type='simplex_weights', availability=mask,
                                     expert_names=[f'e{i}' for i in range(7)])
        self.assertEqual(obs['detail']['free_parameters'], 6)
        self.assertEqual(obs['detail']['experts'], 7)

    def test_graded_ranking_counts_top_grade_items_and_labels_its_own_weakness(self):
        y = np.array([0.0] * 80 + [4.0] * 20)
        obs = effective_observations(y, target_type='graded_ranking')
        self.assertEqual(obs['effective_n'], 20.0)
        self.assertEqual(obs['detail']['basis_confidence'], 'analogy')

    def test_unknown_target_type_is_rejected(self):
        with self.assertRaises(ValueError):
            effective_observations(np.zeros(5), target_type='vibes')


class ClusteringTests(unittest.TestCase):
    def test_no_cluster_key_means_no_discount_and_says_so(self):
        block = cluster_design_effect(np.arange(50, dtype=float))
        self.assertEqual(block['design_effect'], 1.0)
        self.assertIn('optimistic', block['note'])

    def test_perfectly_correlated_clusters_collapse_toward_the_cluster_count(self):
        """Ten weeks, twenty rows each, every row in a week identical: the fold
        holds ten observations of a week effect, not two hundred rows."""
        y = np.repeat(np.arange(10, dtype=float), 20)
        clusters = np.repeat(np.arange(10), 20)
        obs = effective_observations(y, target_type='continuous_regression', clusters=clusters)
        self.assertAlmostEqual(obs['clustering']['icc'], 1.0, places=3)
        self.assertAlmostEqual(obs['effective_n'], 10.0, places=2)

    def test_independent_rows_within_clusters_are_barely_discounted(self):
        rng = np.random.default_rng(7)
        y = rng.normal(size=400)
        clusters = np.repeat(np.arange(20), 20)
        obs = effective_observations(y, target_type='continuous_regression', clusters=clusters)
        self.assertLess(obs['clustering']['icc'], 0.2)
        self.assertGreater(obs['effective_n'], 250.0)

    def test_a_single_cluster_is_one_dependent_block(self):
        y = np.arange(100, dtype=float)
        obs = effective_observations(y, target_type='continuous_regression', clusters=['w1'] * 100)
        self.assertEqual(obs['effective_n'], 1.0)
        self.assertIn('one dependent block', obs['clustering']['note'])

    def test_singleton_clusters_have_no_within_cluster_replication(self):
        y = np.arange(40, dtype=float)
        block = cluster_design_effect(y, clusters=list(range(40)))
        self.assertEqual(block['icc'], 0.0)
        self.assertEqual(block['design_effect'], 1.0)

    def test_mismatched_cluster_length_is_rejected(self):
        with self.assertRaises(ValueError):
            cluster_design_effect(np.zeros(5), clusters=[1, 2])


class DegenerateFoldTests(unittest.TestCase):
    def test_all_one_class_fails_with_a_readable_reason(self):
        v = check_fold(package='C', label='spreads/2023/cover', target_type='binary_classification',
                       y=np.ones(500), feature_count=40)
        self.assertFalse(v['passed'])
        self.assertEqual(v['status'], 'fail')
        self.assertEqual(v['effective_n'], 0.0)
        self.assertIn('0 effective observations', v['reason'])

    def test_a_hazard_fold_with_no_events_fails_even_with_many_at_risk_rows(self):
        v = check_fold(package='B', label='spreads/time_to_follow', target_type='discrete_time_hazard',
                       y=np.zeros(5000), feature_count=16)
        self.assertFalse(v['passed'])
        self.assertEqual(v['rows'], 5000)
        self.assertEqual(v['effective_n'], 0.0)

    def test_zero_features_is_not_applicable_and_does_not_block(self):
        v = check_fold(package='C', label='no-features', target_type='continuous_regression',
                       y=np.arange(100, dtype=float), feature_count=0)
        self.assertEqual(v['status'], 'not_applicable')
        self.assertTrue(v['passed'])
        self.assertIsNone(v['observed_ratio'])

    def test_empty_fold_fails_rather_than_dividing_by_zero(self):
        v = check_fold(package='C', label='empty', target_type='continuous_regression',
                       y=np.array([]), feature_count=10)
        self.assertEqual(v['status'], 'fail')
        self.assertEqual(v['rows'], 0)
        self.assertIn('no rows', v['reason'])

    def test_tiny_fold_fails_and_says_how_many_parameters_it_could_support(self):
        v = check_fold(package='C', label='tiny', target_type='continuous_regression',
                       y=np.arange(60, dtype=float), feature_count=40)
        self.assertFalse(v['passed'])
        self.assertEqual(v['max_parameters_supported'], 4)  # 60 / 15
        self.assertIn('supports at most 4', v['reason'])

    def test_one_row_per_feature_never_passes_anywhere(self):
        for target_type, kwargs in [('continuous_regression', {}),
                                    ('binary_classification', {}),
                                    ('quantile_regression', {'quantiles': [0.1, 0.5, 0.9]})]:
            with self.subTest(target_type=target_type):
                y = labels(10, 10) if target_type == 'binary_classification' else np.arange(20, dtype=float)
                v = check_fold(package='C', label='one-per-feature', target_type=target_type,
                               y=y, feature_count=20, **kwargs)
                self.assertFalse(v['passed'])


class SimplexSupportTests(unittest.TestCase):
    def _bundle(self, rows=800, experts=7, sparse_rows=None):
        rng = np.random.default_rng(3)
        mask = np.ones((rows, experts))
        if sparse_rows is not None:
            mask[sparse_rows:, 0] = 0.0
        return rng.normal(size=rows), mask, [f'e{i}' for i in range(experts)]

    def test_a_well_covered_stack_passes_on_experts_minus_one_parameters(self):
        y, mask, names = self._bundle()
        v = check_fold(package='F', label='council', target_type='simplex_weights',
                       y=y, feature_count=len(names), availability=mask, expert_names=names)
        self.assertTrue(v['passed'])
        self.assertEqual(v['parameters'], 6)
        self.assertEqual(v['required_ratio'], RATIO_CONTINUOUS)

    def test_an_expert_present_on_too_few_rows_fails_the_fold_and_is_named(self):
        """The nfelo_line case: the fold is huge, one expert's coverage is not."""
        y, mask, names = self._bundle(rows=800, sparse_rows=9)
        v = check_fold(package='F', label='council', target_type='simplex_weights',
                       y=y, feature_count=len(names), availability=mask, expert_names=names)
        self.assertFalse(v['passed'])
        self.assertEqual(v['under_supported_experts'], ['e0'])
        self.assertIn('e0', v['reason'])

    def test_availability_mask_is_required(self):
        with self.assertRaises(ValueError):
            effective_observations(np.zeros(10), target_type='simplex_weights')

    def test_a_wrongly_shaped_mask_is_rejected(self):
        with self.assertRaises(ValueError):
            effective_observations(np.zeros(10), target_type='simplex_weights',
                                   availability=np.ones((5, 3)))


class VerdictPlumbingTests(unittest.TestCase):
    def test_check_fold_never_raises_so_a_lab_can_record_the_failure(self):
        v = check_fold(package='C', label='tiny', target_type='continuous_regression',
                       y=np.arange(10, dtype=float), feature_count=40)
        self.assertFalse(v['passed'])
        self.assertIn('refuse_and_report', v['compression_policy'])

    def test_enforce_raises_only_in_strict_mode(self):
        v = check_fold(package='C', label='tiny', target_type='continuous_regression',
                       y=np.arange(10, dtype=float), feature_count=40)
        enforce(v, strict=False)  # must not raise
        with self.assertRaises(DisciplineError):
            enforce(v, strict=True)

    def test_record_appends_and_can_raise(self):
        sink = []
        record(sink, check_fold(package='C', label='ok', target_type='continuous_regression',
                                y=np.arange(600, dtype=float), feature_count=10))
        self.assertEqual(len(sink), 1)
        with self.assertRaises(DisciplineError):
            record(sink, check_fold(package='C', label='bad', target_type='continuous_regression',
                                    y=np.arange(10, dtype=float), feature_count=10), strict=True)
        self.assertEqual(len(sink), 2)  # recorded BEFORE raising, so the report keeps it

    def test_summarize_reports_failures_without_hiding_the_run(self):
        good = check_fold(package='C', label='ok', target_type='continuous_regression',
                          y=np.arange(600, dtype=float), feature_count=10)
        bad = check_fold(package='C', label='bad', target_type='binary_classification',
                         y=labels(5, 600), feature_count=40)
        s = summarize([good, bad])
        self.assertFalse(s['passed'])
        self.assertEqual(s['checks'], 2)
        self.assertEqual(len(s['failures']), 1)
        self.assertEqual(s['failures'][0]['label'], 'bad')
        self.assertEqual(s['ratio_constants'], {'RATIO_CONTINUOUS': RATIO_CONTINUOUS,
                                                'RATIO_EVENTS': RATIO_EVENTS})

    def test_summarize_of_nothing_is_a_pass_not_a_crash(self):
        self.assertTrue(summarize([])['passed'])
        self.assertTrue(summarize(None)['passed'])

    def test_a_ratio_override_records_the_reason_it_was_overridden(self):
        v = check_fold(package='C', label='override', target_type='continuous_regression',
                       y=np.arange(100, dtype=float), feature_count=10,
                       required_ratio=5.0, note='declared in preregistered.json')
        self.assertTrue(v['passed'])
        self.assertIn('caller override', v['required_ratio_source'])
        self.assertIn('preregistered', v['required_ratio_source'])


class AuthorityTests(unittest.TestCase):
    def test_the_module_takes_no_production_or_staking_dependency(self):
        src = Path(__file__).with_name('model_discipline.py').read_text()
        body = src.replace(ast.get_docstring(ast.parse(src)) or '', '').lower()
        for forbidden in ('nfl-execution', 'nfl_execution', 'sqlite3', 'kelly', 'stake'):
            self.assertTrue(forbidden not in body,
                            f'{forbidden!r} appears in model_discipline.py; it must stay '
                            'research-only and data-source-free')

    def test_every_python_research_lab_imports_it(self):
        for lab in ('market_lab.py', 'tree_lab.py', 'book_lag_lab.py', 'expert_selector_lab.py'):
            with self.subTest(lab=lab):
                src = Path(__file__).with_name(lab).read_text()
                self.assertTrue('model_discipline' in src, f'{lab} does not import model_discipline')


if __name__ == '__main__':
    unittest.main()
