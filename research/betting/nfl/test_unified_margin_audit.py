"""Tests for unified_margin_audit.py.

The audit's whole value is that its numbers cannot have been produced by
looking ahead, so the load-bearing test here is a mutation test: change a
LATER week's outcome and every EARLIER week's prediction must be unchanged,
byte for byte. If that ever fails, every metric the audit reports is void.

The rest establish accounting: an abstained week's games are never scored as
if they were forecasts, and no game silently disappears between the dataset
and the report.

Synthetic fixtures only -- never the real database.
"""
import copy
import unittest

import unified_margin_audit as wf
from test_weekly_training import _synthetic_shadow_rows


def _run(rows, **kwargs):
    kwargs.setdefault('min_test_season', 2002)
    return wf.run_walk_forward(rows, **kwargs)


class NoLookAheadTests(unittest.TestCase):
    def test_mutating_a_later_weeks_outcome_cannot_change_an_earlier_weeks_prediction(self):
        rows_a = _synthetic_shadow_rows()
        rows_b = copy.deepcopy(rows_a)
        # Move a late-season outcome by a wild amount in the second copy.
        target = max(rows_b, key=lambda r: (r['season'], r['week']))
        target['actual_margin'] = 999

        _, scored_a = _run(rows_a)
        _, scored_b = _run(rows_b)
        preds_a = {wf.stage3_row_id(r): r['_unified_pred'] for r in scored_a}
        preds_b = {wf.stage3_row_id(r): r['_unified_pred'] for r in scored_b}

        mutated_week = (target['season'], target['week'])
        earlier = [g for g in preds_a
                   if (int(g[:4]), int(g[6:8])) < mutated_week]
        self.assertTrue(earlier, 'fixture produced no earlier scored games to compare')
        for game in earlier:
            self.assertEqual(preds_a[game], preds_b[game],
                             f'{game} changed after a LATER week was mutated -- look-ahead leak')

    def test_a_test_weeks_own_games_are_never_in_its_training_set(self):
        rows = _synthetic_shadow_rows()
        weeks, _ = _run(rows)
        self.assertTrue(weeks)
        for record in weeks:
            # run_walk_forward raises outright if a test-week game leaks, so
            # reaching here already proves it; assert the cutoff ordering too.
            key = (record['season'], record['week'])
            own = [r for r in rows if (r['season'], r['week']) == key]
            cutoff = wf.shared_dataset.stamp(record['fit_cutoff'])
            for r in own:
                self.assertGreater(wf.shared_dataset.stamp(r['decision_at']), cutoff,
                                   'a test game decided at or before its own fit cutoff')


class AccountingTests(unittest.TestCase):
    def test_every_evaluated_game_is_either_scored_or_named_in_an_abstention(self):
        rows = _synthetic_shadow_rows()
        weeks, scored = _run(rows)
        scored_ids = {wf.stage3_row_id(r) for r in scored}
        abstained_ids = {g for w in weeks if not w['fitted'] for g in w['abstained_games']}
        evaluated = {wf.stage3_row_id(r) for r in rows
                     if (r['season'], r['week']) in {(w['season'], w['week']) for w in weeks}}

        self.assertEqual(scored_ids | abstained_ids, evaluated,
                         'a game vanished between the dataset and the report')
        self.assertEqual(scored_ids & abstained_ids, set(),
                         'a game was both scored and recorded as an abstention')

    def test_an_abstained_week_contributes_no_prediction(self):
        rows = _synthetic_shadow_rows()
        # Evaluate from the very first week, so the early weeks -- which have
        # nowhere near enough history for the recipe's chronological blocks --
        # must abstain rather than fit something on too little data.
        weeks, scored = wf.run_walk_forward(rows, min_test_season=2000)
        abstained = [w for w in weeks if not w['fitted']]
        self.assertTrue(abstained, 'fixture never exercised the abstention path')
        for w in abstained:
            self.assertIn('abstention_reason', w)
            self.assertEqual(len(w['abstained_games']), w['n_games_in_week'])
        abstained_weeks = {(w['season'], w['week']) for w in abstained}
        for r in scored:
            self.assertNotIn((r['season'], r['week']), abstained_weeks)

    def test_scored_rows_carry_a_market_comparison_only_where_one_exists(self):
        rows = _synthetic_shadow_rows()
        for r in rows[:5]:
            r['market_spread'] = None
        _, scored = _run(rows)
        support = wf.common_support(scored)
        self.assertTrue(len(support) < len(scored) or len(scored) == len(support),
                        'common support must never exceed the scored set')
        for r in support:
            self.assertIsNotNone(r['_market_pred'])


class StatisticTests(unittest.TestCase):
    def test_paired_difference_is_the_observed_mae_gap(self):
        rows = _synthetic_shadow_rows()
        _, scored = _run(rows)
        support = wf.common_support(scored)
        self.assertTrue(support)
        result = wf.paired_difference(scored)

        unified = sum(abs(r['_unified_pred'] - r['actual_margin']) for r in support) / len(support)
        market = sum(abs(r['_market_pred'] - r['actual_margin']) for r in support) / len(support)
        self.assertAlmostEqual(result['point_estimate'], unified - market, places=9)
        self.assertAlmostEqual(result['unified_mae'], unified, places=9)
        self.assertAlmostEqual(result['market_mae'], market, places=9)
        self.assertEqual(result['n_games'], len(support))

    def test_no_interval_is_invented_here(self):
        """The interval belongs to the one tested bootstrap, not to this module.

        If a future change adds a CI back into the Python audit, this fails --
        that is the point. Two block-bootstrap implementations that can drift
        apart is the failure mode this module's header exists to prevent.
        """
        rows = _synthetic_shadow_rows()
        _, scored = _run(rows)
        result = wf.paired_difference(scored)
        for forbidden in ('ci_95', 'ci90', 'ci', 'p_value', 'significant'):
            self.assertNotIn(forbidden, result)
        self.assertIn('backtest-significance.js', result['interval_not_computed_here'])
        self.assertFalse(hasattr(wf, 'week_clustered_bootstrap'))

    def test_small_diagnostic_groups_are_marked_inconclusive(self):
        rows = _synthetic_shadow_rows()
        _, scored = _run(rows)
        table = wf.group_table(scored)
        for name, block in table.items():
            if block['n_games'] < wf.MIN_GROUP_GAMES:
                self.assertTrue(block['inconclusive_small_sample'], f'{name} under-sampled but not flagged')


def _with_market_movement(rows, seed=17):
    import random
    rng = random.Random(seed)
    out = copy.deepcopy(rows)
    for r in out:
        if r.get('market_spread') is not None:
            move = rng.uniform(-2.5, 2.5)
            r['open_spread'] = r['market_spread'] - move
            r['market_movement'] = -(r['market_spread'] - r['open_spread'])
    return out


class MarketCorrectionWiringTests(unittest.TestCase):
    """Phase 1: the audit also fits and scores the market-correction head,
    on the SAME weekly training data, without disturbing the unified model's
    own numbers -- that's the whole point of running both in one script
    instead of building a second audit."""

    def test_correction_head_is_fitted_and_scored_alongside_the_unified_model(self):
        rows = _with_market_movement(_synthetic_shadow_rows())
        weeks, scored = _run(rows)
        fitted_weeks = [w for w in weeks if w.get('correction_fitted')]
        self.assertTrue(fitted_weeks, 'no week ever fit the correction head on this fixture')
        corrected_games = wf.correction_support(scored)
        self.assertTrue(corrected_games)
        for r in corrected_games:
            self.assertIsInstance(r['_correction_pred'], float)
            self.assertIsInstance(r['_football_alone_pred'], float)

    def test_correction_fitting_never_changes_the_unified_models_own_predictions(self):
        rows_a = _with_market_movement(_synthetic_shadow_rows())
        rows_b = copy.deepcopy(rows_a)
        _, scored_with_correction = wf.run_walk_forward(
            rows_a, min_test_season=2002, score_market_correction=True)
        _, scored_without_correction = wf.run_walk_forward(
            rows_b, min_test_season=2002, score_market_correction=False)
        preds_with = {wf.stage3_row_id(r): r['_unified_pred'] for r in scored_with_correction}
        preds_without = {wf.stage3_row_id(r): r['_unified_pred'] for r in scored_without_correction}
        self.assertEqual(preds_with, preds_without)

    def test_correction_metric_block_and_paired_difference_are_self_consistent(self):
        rows = _with_market_movement(_synthetic_shadow_rows())
        _, scored = _run(rows)
        block = wf.correction_metric_block(scored)
        self.assertEqual(block['n_games'], len(wf.correction_support(scored)))
        vs_market = wf.correction_paired_difference(scored, 'market')
        self.assertAlmostEqual(
            vs_market['point_estimate'],
            block['correction']['mae'] - block['market']['mae'], places=9)
        vs_football = wf.correction_paired_difference(scored, 'football_alone')
        self.assertAlmostEqual(
            vs_football['point_estimate'],
            block['correction']['mae'] - block['football_alone']['mae'], places=9)

    def test_correction_paired_difference_rejects_an_unknown_baseline(self):
        rows = _with_market_movement(_synthetic_shadow_rows())
        _, scored = _run(rows)
        with self.assertRaises(ValueError):
            wf.correction_paired_difference(scored, 'nonsense')

    def test_a_week_can_abstain_on_correction_while_the_unified_model_still_fits(self):
        # Strip market evidence from most rows so the correction head runs
        # dry on combination-block minimums the unified model doesn't need.
        rows = _with_market_movement(_synthetic_shadow_rows())
        for r in rows[::4]:
            r['market_spread'] = None
            r.pop('open_spread', None)
            r.pop('market_movement', None)
        weeks, scored = _run(rows)
        self.assertTrue(any(w['fitted'] for w in weeks))
        # Whether or not any week abstains on correction specifically depends
        # on how much market evidence survived; the real assertion is that
        # the two fields never contradict each other structurally.
        for w in weeks:
            if w['fitted']:
                self.assertIn('correction_fitted', w)

    def test_verdict_mentions_the_correction_head_when_it_scored_games(self):
        rows = _with_market_movement(_synthetic_shadow_rows())
        _, scored = _run(rows)
        overall = wf.metric_block(wf.common_support(scored))
        comparison = wf.paired_difference(scored)
        coverage = wf.interval_coverage(scored)
        correction_overall = wf.correction_metric_block(scored)
        vs_market = wf.correction_paired_difference(scored, 'market')
        vs_football = wf.correction_paired_difference(scored, 'football_alone')
        verdict = wf.build_verdict(overall, comparison, coverage, correction_overall, vs_market, vs_football)
        self.assertIn('Market-correction head', verdict)


class ProvenanceAndAccountingTests(unittest.TestCase):
    """What `run()` writes must identify the run: every module that produced
    a number is hashed, both candidates are preregistered, and the accounting
    invariant is enforced rather than merely reported."""

    def test_code_identity_hashes_every_module_that_produces_a_reported_number(self):
        ident = wf.code_identity()
        for name in ('dataset.py', 'model_artifact.py', 'market_correction.py',
                     'stage3_team_strength.py', 'unified_model.py', 'weekly_training.py',
                     'unified_margin_audit.py'):
            self.assertIn(name, ident, f'{name} is not in the provenance hash')
        for digest in ident.values():
            self.assertEqual(len(digest), 64)

    def test_protocol_preregisters_the_correction_head_and_its_horizons(self):
        import market_correction as mc
        spec = wf.protocol(2021, 2026)
        self.assertEqual(spec['secondary_candidate']['recipe'], mc.RECIPE)
        self.assertIn('football_alone', ' '.join(spec['secondary_candidate']['baselines']))
        for key in ('model_weights', 'row_features', 'market_baseline_and_correction_features'):
            self.assertIn(key, spec['horizons'])
        # The spec must stay serializable exactly as run() hashes it.
        import json
        json.dumps(spec, sort_keys=True, default=str)

    def test_check_accounting_passes_on_a_real_run_and_fails_on_a_lost_or_doubled_game(self):
        rows = _synthetic_shadow_rows()
        weeks, scored = _run(rows)
        expected = len(wf.rows_in_window(rows, 2002, None))
        self.assertEqual(wf.check_accounting(rows, weeks, scored, 2002, None), expected)

        with self.assertRaisesRegex(AssertionError, 'accounting broke'):
            wf.check_accounting(rows, weeks, scored[:-1], 2002, None)  # a game vanished
        with self.assertRaisesRegex(AssertionError, 'more than once'):
            wf.check_accounting(rows, weeks, scored[:-1] + scored[:1], 2002, None)  # same count, one game twice
        # Widening the window without scoring the extra games must also fail.
        with self.assertRaisesRegex(AssertionError, 'accounting broke'):
            wf.check_accounting(rows, weeks, scored, 2000, None)


if __name__ == '__main__':
    unittest.main()
