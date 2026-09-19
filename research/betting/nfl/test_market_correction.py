"""Tests for market_correction.py.

The one property that matters most: the football prediction fed to the
correction head must be genuinely out-of-fold -- fit only on `base` weeks,
never on the `combination` weeks it then predicts. If that broke, the
correction head would be learning to correct a football model that had
already memorized part of what it's "predicting," which would make any
measured improvement meaningless. Everything else here is shape and
missing-evidence accounting.

Synthetic fixtures only; never the real database.
"""
import copy
import random
import unittest

import market_correction as mc
import stage3_team_strength as stage3
from test_weekly_training import _synthetic_shadow_rows


def _with_market(rows, seed=13):
    """Real, varying open_spread/market_movement -- _synthetic_shadow_rows
    already sets market_spread; this adds the opener and derives movement
    the same way dataset.py's football_feature_row does."""
    rng = random.Random(seed)
    out = copy.deepcopy(rows)
    for r in out:
        move = rng.uniform(-2.5, 2.5)
        r['open_spread'] = r['market_spread'] - move
        r['market_movement'] = -(r['market_spread'] - r['open_spread'])
    return out


class OutOfFoldDisciplineTests(unittest.TestCase):
    def test_football_model_never_saw_combination_weeks_own_outcomes(self):
        rows = _with_market(_synthetic_shadow_rows())
        model, meta = mc.fit_market_correction(copy.deepcopy(rows))

        # The football model inside the fitted result is the one refit on
        # base+combination (for calibration). Independently fit a football
        # model on ONLY `base` (mirroring what fit_market_correction does
        # internally before the refit) and confirm mutating a combination
        # row's outcome does not change that base-only model's predictions
        # on that same row -- proving it was never trained on it.
        from unified_model import chronological_blocks
        base, combo, _ = chronological_blocks(copy.deepcopy(rows))
        import model_artifact as ma
        base_model, _ = ma.fit_ridge_artifact(copy.deepcopy(base), feature_names=stage3.FEATURE_NAMES)
        combo_with_market = [r for r in combo if mc.has_market_evidence(r)]
        target = copy.deepcopy(combo_with_market[0])
        target['_features'] = stage3.row_features(target)
        pred_before = base_model.predict(stage3.feature_matrix([target]))[0]

        mutated_combo = copy.deepcopy(combo_with_market)
        mutated_combo[0]['actual_margin'] = 999
        mutated_base_model, _ = ma.fit_ridge_artifact(copy.deepcopy(base), feature_names=stage3.FEATURE_NAMES)
        probe = copy.deepcopy(mutated_combo[0])
        probe['_features'] = stage3.row_features(probe)
        pred_after = mutated_base_model.predict(stage3.feature_matrix([probe]))[0]
        self.assertAlmostEqual(pred_before, pred_after, places=9,
            msg='mutating a combination-week outcome changed the base-only football '
                'model -- it must never have been trained on combination weeks at all')

    def test_mutating_a_calibration_outcome_does_not_change_the_final_football_refit_on_earlier_rows(self):
        rows = _with_market(_synthetic_shadow_rows())
        rows_mutated = copy.deepcopy(rows)
        from unified_model import chronological_blocks
        _, _, calibration = chronological_blocks(copy.deepcopy(rows_mutated))
        target_key = (calibration[0]['season'], calibration[0]['week'],
                      calibration[0]['home'], calibration[0]['away'])
        for r in rows_mutated:
            if (r['season'], r['week'], r['home'], r['away']) == target_key:
                r['actual_margin'] = 999

        model_a, _ = mc.fit_market_correction(copy.deepcopy(rows))
        model_b, _ = mc.fit_market_correction(rows_mutated)
        # The final football refit trains on base+combination only, never
        # calibration, so its predictions on an EARLY combination-week row
        # must be identical regardless of the calibration mutation.
        probe = copy.deepcopy([r for r in rows if mc.has_market_evidence(r)][50])
        probe['_features'] = stage3.row_features(probe)
        pred_a = model_a.football_model.predict(stage3.feature_matrix([copy.deepcopy(probe)]))[0]
        pred_b = model_b.football_model.predict(stage3.feature_matrix([copy.deepcopy(probe)]))[0]
        self.assertAlmostEqual(pred_a, pred_b, places=9)


class MissingMarketEvidenceTests(unittest.TestCase):
    def test_rows_without_market_spread_are_excluded_not_defaulted(self):
        rows = _with_market(_synthetic_shadow_rows())
        for r in rows[::3]:
            r['market_spread'] = None
        model, meta = mc.fit_market_correction(rows)
        self.assertGreater(meta['lineage']['combination_rows_dropped_no_market_evidence'], 0)
        self.assertGreater(meta['lineage']['calibration_rows_dropped_no_market_evidence'], 0)

    def test_too_few_market_evidenced_rows_raises_rather_than_fitting_on_noise(self):
        rows = _with_market(_synthetic_shadow_rows())
        for r in rows:
            r['market_spread'] = None
        with self.assertRaises(ValueError):
            mc.fit_market_correction(rows)

    def test_predict_rows_returns_none_for_a_game_with_no_market_evidence(self):
        rows = _with_market(_synthetic_shadow_rows())
        model, meta = mc.fit_market_correction(copy.deepcopy(rows))
        probe_with = copy.deepcopy([r for r in rows if mc.has_market_evidence(r)][0])
        probe_without = copy.deepcopy(probe_with)
        probe_without['market_spread'] = None
        probe_with['_features'] = stage3.row_features(probe_with)
        probe_without['_features'] = stage3.row_features(probe_without)
        preds = model.predict_rows([probe_with, probe_without])
        self.assertIsNotNone(preds[0])
        self.assertIsNone(preds[1])

    def test_describe_reports_unavailable_honestly_for_no_market_evidence(self):
        rows = _with_market(_synthetic_shadow_rows())
        model, meta = mc.fit_market_correction(copy.deepcopy(rows))
        probe = copy.deepcopy([r for r in rows if mc.has_market_evidence(r)][0])
        probe['market_spread'] = None
        probe['_features'] = stage3.row_features(probe)
        result = model.describe(probe)
        self.assertEqual(result, {'available': False, 'reason': 'no_market_evidence_for_this_game'})


class ShapeTests(unittest.TestCase):
    def test_describe_shape_for_an_available_game(self):
        rows = _with_market(_synthetic_shadow_rows())
        model, meta = mc.fit_market_correction(copy.deepcopy(rows))
        probe = copy.deepcopy([r for r in rows if mc.has_market_evidence(r)][0])
        probe['_features'] = stage3.row_features(probe)
        result = model.describe(probe)
        self.assertTrue(result['available'])
        self.assertIsInstance(result['predicted_margin'], float)
        self.assertEqual(result['market_prediction'], -probe['market_spread'])
        self.assertAlmostEqual(result['correction'],
            result['predicted_margin'] - result['market_prediction'], places=9)
        self.assertEqual(len(result['interval_80']), 2)
        self.assertLess(result['interval_80'][0], result['interval_80'][1])

    def test_meta_declares_the_narrow_three_feature_correction_contract(self):
        rows = _with_market(_synthetic_shadow_rows())
        _, meta = mc.fit_market_correction(copy.deepcopy(rows))
        self.assertEqual(meta['recipe']['correction_feature_names'],
                         ['football_prediction', 'market_spread', 'market_movement'])
        self.assertEqual(meta['algorithm'], 'market_correction')
        self.assertIn('football_alpha', meta['hyperparameters'])
        self.assertIn('correction_alpha', meta['hyperparameters'])


def _with_availability(rows, seed=29):
    """Real, varying availability deficits on every row -- what a dataset
    built with `availability_path=...` and full evidence coverage looks
    like. `all_missing` fixtures simply never call this at all, which is
    what a dataset built with `availability_path=None` looks like -- the
    keys are absent from every row, not present-and-null."""
    rng = random.Random(seed)
    out = copy.deepcopy(rows)
    for r in out:
        r['home_availability_deficit'] = rng.uniform(0.0, 2.0)
        r['away_availability_deficit'] = rng.uniform(0.0, 2.0)
    return out


class RecipeVersioningTests(unittest.TestCase):
    """RUNBOOK Sec4.1 (Phase 3): RECIPE_V2 adds the two availability-deficit
    columns to the correction head. Two properties matter: real availability
    signal must actually reach the fit (otherwise the wiring is a no-op),
    and its total absence must degenerate to RECIPE_V1's own fit exactly,
    not silently diverge or error -- a dataset built without
    `availability_path` must be scoreable with either recipe."""

    def test_v1_is_the_default_and_v2_is_additive_not_a_replacement(self):
        self.assertEqual(mc.RECIPE, mc.RECIPE_V1)
        self.assertEqual(mc.RECIPE_V2['correction_feature_names'],
                         mc.RECIPE_V1['correction_feature_names']
                         + ['home_availability_deficit', 'away_availability_deficit'])
        self.assertEqual(mc.RECIPE_V2['football_family'], mc.RECIPE_V1['football_family'])

    def test_v2_with_real_availability_signal_changes_the_fitted_predictions(self):
        rows = _with_availability(_with_market(_synthetic_shadow_rows()))
        model_v1, meta_v1 = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V1)
        model_v2, meta_v2 = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V2)
        self.assertEqual(meta_v1['recipe']['version'], 'market-correction-recipe-v1')
        self.assertEqual(meta_v2['recipe']['version'], 'market-correction-recipe-v2')
        self.assertEqual(model_v1.feature_names, mc.RECIPE_V1['correction_feature_names'])
        self.assertEqual(model_v2.feature_names, mc.RECIPE_V2['correction_feature_names'])

        probe = copy.deepcopy([r for r in rows if mc.has_market_evidence(r)][:20])
        for r in probe:
            r['_features'] = stage3.row_features(r)
        preds_v1 = model_v1.predict_rows(copy.deepcopy(probe))
        preds_v2 = model_v2.predict_rows(copy.deepcopy(probe))
        self.assertTrue(any(abs(a - b) > 1e-9 for a, b in zip(preds_v1, preds_v2)),
            'RECIPE_V2 with real, varying availability signal produced predictions identical '
            'to RECIPE_V1 -- the extra columns are not reaching the correction fit')

    def test_a_feature_with_too_few_combination_values_is_dropped_and_the_week_degrades_to_v1(self):
        # Availability present on only a handful of rows -- the shape of the
        # first 2021 test weeks on real data, whose combination block is
        # mostly 2020 (no injury rows exist). Without the support rule this
        # produced corrections of +2,000 points; with it, the week must fit
        # exactly what v1 would, and say which features it dropped.
        rows = _with_market(_synthetic_shadow_rows())
        rng = random.Random(7)
        for r in rows[:12]:
            r['home_availability_deficit'] = rng.uniform(0.0, 2.0)
            r['away_availability_deficit'] = rng.uniform(0.0, 2.0)
        model_v1, _ = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V1)
        model_v2, meta_v2 = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V2)
        self.assertEqual(sorted(meta_v2['lineage']['correction_features_dropped_insufficient_support']),
                         ['away_availability_deficit', 'home_availability_deficit'])
        self.assertEqual(meta_v2['lineage']['correction_features_used'],
                         mc.RECIPE_V1['correction_feature_names'])
        self.assertEqual(model_v2.feature_names, mc.RECIPE_V1['correction_feature_names'])
        probe = copy.deepcopy([r for r in rows if mc.has_market_evidence(r)][:20])
        for r in probe:
            r['_features'] = stage3.row_features(r)
        for a, b in zip(model_v1.predict_rows(copy.deepcopy(probe)), model_v2.predict_rows(copy.deepcopy(probe))):
            self.assertAlmostEqual(a, b, places=6)

    def test_v2_with_availability_entirely_absent_reproduces_v1s_predictions(self):
        # No `_with_availability` call: these rows never carry the two keys
        # at all, exactly like a dataset built with `availability_path=None`.
        # `_correction_matrix` reads them as NaN on every row -> the shared
        # ridge pipeline's imputer drops the all-missing columns entirely,
        # so RECIPE_V2 must fit and predict identically to RECIPE_V1.
        rows = _with_market(_synthetic_shadow_rows())
        model_v1, _ = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V1)
        model_v2, _ = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V2)

        probe = copy.deepcopy([r for r in rows if mc.has_market_evidence(r)][:20])
        for r in probe:
            r['_features'] = stage3.row_features(r)
        preds_v1 = model_v1.predict_rows(copy.deepcopy(probe))
        preds_v2 = model_v2.predict_rows(copy.deepcopy(probe))
        for a, b in zip(preds_v1, preds_v2):
            self.assertAlmostEqual(a, b, places=6,
                msg='RECIPE_V2 with no availability evidence anywhere must reproduce '
                    "RECIPE_V1's fit, not silently diverge")


def _with_qb_quality(rows, seed=41):
    """Real, varying home/away starting-QB QBR on every row -- what a dataset
    built with `qb_quality_path=...` and full evidence coverage looks like."""
    rng = random.Random(seed)
    out = copy.deepcopy(rows)
    for r in out:
        r['home_qb_qbr'] = rng.uniform(30.0, 90.0)
        r['away_qb_qbr'] = rng.uniform(30.0, 90.0)
    return out


class RecipeV3QbQualityTests(unittest.TestCase):
    """RUNBOOK Sec4.1 (continued): RECIPE_V3 adds the two starting-QB-QBR
    columns on top of RECIPE_V2's own. Same two properties as
    `RecipeVersioningTests` above, one level up: real QB-quality signal must
    actually reach the fit, and its total absence must degenerate to
    RECIPE_V2's own fit exactly -- a dataset built without `qb_quality_path`
    must be scoreable with RECIPE_V3 just as one built without
    `availability_path` is scoreable with RECIPE_V2."""

    def test_v3_is_additive_on_top_of_v2_not_a_replacement(self):
        self.assertEqual(mc.RECIPE_V3['correction_feature_names'],
                         mc.RECIPE_V2['correction_feature_names'] + ['home_qb_qbr', 'away_qb_qbr'])
        self.assertEqual(mc.RECIPE_V3['football_family'], mc.RECIPE_V1['football_family'])
        self.assertEqual(mc.RECIPE_V3['minimum_feature_support'], mc.RECIPE_V2['minimum_feature_support'])

    def test_v3_with_real_qb_quality_signal_changes_the_fitted_predictions(self):
        # Real availability signal too, so RECIPE_V2's own two columns clear
        # `minimum_feature_support` and this isolates what QB quality alone
        # adds on top of a fully-populated V2 -- not a V2 that has itself
        # degraded to V1 for lack of availability evidence.
        rows = _with_qb_quality(_with_availability(_with_market(_synthetic_shadow_rows())))
        model_v2, meta_v2 = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V2)
        model_v3, meta_v3 = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V3)
        self.assertEqual(meta_v2['recipe']['version'], 'market-correction-recipe-v2')
        self.assertEqual(meta_v3['recipe']['version'], 'market-correction-recipe-v3')
        self.assertEqual(model_v2.feature_names, mc.RECIPE_V2['correction_feature_names'])
        self.assertEqual(model_v3.feature_names, mc.RECIPE_V3['correction_feature_names'])

        probe = copy.deepcopy([r for r in rows if mc.has_market_evidence(r)][:20])
        for r in probe:
            r['_features'] = stage3.row_features(r)
        preds_v2 = model_v2.predict_rows(copy.deepcopy(probe))
        preds_v3 = model_v3.predict_rows(copy.deepcopy(probe))
        self.assertTrue(any(abs(a - b) > 1e-9 for a, b in zip(preds_v2, preds_v3)),
            'RECIPE_V3 with real, varying QB-quality signal produced predictions identical '
            'to RECIPE_V2 -- the extra columns are not reaching the correction fit')

    def test_a_qb_quality_feature_with_too_few_combination_values_is_dropped_and_degrades_to_v2(self):
        # Mirrors RecipeVersioningTests' own minimum_feature_support test, one
        # recipe up: real availability everywhere (so V2's own two columns
        # are NOT what's sparse here), but QB quality present on only a
        # handful of rows -- the shape of an early season where
        # nfl_qbr_weekly's own trailing history has barely accumulated. The
        # week must fit exactly what a fully-populated v2 would, and say
        # which features it dropped.
        rows = _with_availability(_with_market(_synthetic_shadow_rows()))
        rng = random.Random(17)
        for r in rows[:12]:
            r['home_qb_qbr'] = rng.uniform(30.0, 90.0)
            r['away_qb_qbr'] = rng.uniform(30.0, 90.0)
        model_v2, _ = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V2)
        model_v3, meta_v3 = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V3)
        self.assertEqual(sorted(meta_v3['lineage']['correction_features_dropped_insufficient_support']),
                         ['away_qb_qbr', 'home_qb_qbr'])
        self.assertEqual(meta_v3['lineage']['correction_features_used'],
                         mc.RECIPE_V2['correction_feature_names'])
        self.assertEqual(model_v3.feature_names, mc.RECIPE_V2['correction_feature_names'])
        probe = copy.deepcopy([r for r in rows if mc.has_market_evidence(r)][:20])
        for r in probe:
            r['_features'] = stage3.row_features(r)
        for a, b in zip(model_v2.predict_rows(copy.deepcopy(probe)), model_v3.predict_rows(copy.deepcopy(probe))):
            self.assertAlmostEqual(a, b, places=6)

    def test_v3_with_qb_quality_entirely_absent_reproduces_v2s_predictions(self):
        # No `_with_qb_quality` call: these rows never carry the two keys at
        # all, exactly like a dataset built with `qb_quality_path=None`.
        # `_correction_matrix` reads them as NaN on every row -> the shared
        # ridge pipeline's imputer drops the all-missing columns entirely, so
        # RECIPE_V3 must fit and predict identically to RECIPE_V2 -- and, by
        # the existing RecipeVersioningTests chain, identically to RECIPE_V1
        # too when availability is also absent.
        rows = _with_market(_synthetic_shadow_rows())
        model_v1, _ = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V1)
        model_v2, _ = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V2)
        model_v3, _ = mc.fit_market_correction(copy.deepcopy(rows), recipe=mc.RECIPE_V3)

        probe = copy.deepcopy([r for r in rows if mc.has_market_evidence(r)][:20])
        for r in probe:
            r['_features'] = stage3.row_features(r)
        preds_v1 = model_v1.predict_rows(copy.deepcopy(probe))
        preds_v2 = model_v2.predict_rows(copy.deepcopy(probe))
        preds_v3 = model_v3.predict_rows(copy.deepcopy(probe))
        for a, b, c in zip(preds_v1, preds_v2, preds_v3):
            self.assertAlmostEqual(a, b, places=6)
            self.assertAlmostEqual(b, c, places=6,
                msg='RECIPE_V3 with no QB-quality evidence anywhere must reproduce '
                    "RECIPE_V2's fit, not silently diverge")


if __name__ == '__main__':
    unittest.main()
