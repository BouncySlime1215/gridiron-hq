"""Phase 0: the extended (availability) feature set must be genuinely opt-in.

Two properties this pins, both load-bearing for every existing baseline
(including the 10.678-MAE walk-forward audit run
`20260915T193513Z-89562259`):

  1. DEFAULT REPRODUCES EXACTLY. A fit with no `feature_names` argument must
     produce byte-identical training data and artifact identity whether or
     not the input rows happen to carry availability fields. If it didn't,
     every existing report's numbers would be silently unreproducible the
     moment `dataset.py`'s `availability_path` is passed anywhere upstream.
  2. THE EXTENDED SET IS DIFFERENT. A fit that explicitly asks for
     `stage3.EXTENDED_FEATURE_NAMES` must produce a genuinely different
     artifact identity when the availability values differ -- proving the
     model actually consumed them, not merely accepted the parameter.

Synthetic fixtures only; never the real database.
"""
import copy
import tempfile
import unittest
from pathlib import Path

import model_artifact as ma
import stage3_team_strength as stage3
from test_stage3_team_strength import _synthetic_multiseason_rows


def _with_availability(rows, seed=3):
    """A deep copy with real, varying (not all-null) availability fields."""
    out = copy.deepcopy(rows)
    for i, r in enumerate(out):
        # Deterministic, not all-identical and not all-null -- a feature
        # that's constant or always-missing couldn't move a fitted model
        # even if it were wired in correctly, which would make test #2 above
        # pass for the wrong reason.
        r['home_availability_deficit'] = 0.05 * ((i * seed) % 7)
        r['away_availability_deficit'] = 0.03 * ((i * seed + 2) % 5)
        r['availability_evidence'] = (i % 2 == 0)
    return out


class DefaultSetIsUnaffectedByExtraRowFields(unittest.TestCase):
    def test_row_features_default_ignores_availability_even_when_present(self):
        rows = _with_availability(_synthetic_multiseason_rows())
        plain = _synthetic_multiseason_rows()
        feat_with = stage3.row_features(rows[10])
        feat_without = stage3.row_features(plain[10])
        self.assertEqual(feat_with, feat_without)
        self.assertNotIn('home_availability_deficit', feat_with)

    def test_ridge_training_hash_identical_with_or_without_availability_present(self):
        rows_with = _with_availability(_synthetic_multiseason_rows())
        rows_without = _synthetic_multiseason_rows()
        _, meta_with = ma.fit_ridge_artifact(rows_with)
        _, meta_without = ma.fit_ridge_artifact(rows_without)
        self.assertEqual(meta_with['training_data_hash'], meta_without['training_data_hash'])
        self.assertEqual(meta_with['feature_names'], list(stage3.FEATURE_NAMES))

    def test_fit_and_save_artifact_id_identical_with_or_without_availability_present(self):
        rows_with = _with_availability(_synthetic_multiseason_rows())
        rows_without = _synthetic_multiseason_rows()
        with tempfile.TemporaryDirectory() as tmp:
            _, meta_with = ma.fit_and_save(
                None, through_season=2004, output_root=Path(tmp), rows=rows_with)
            _, meta_without = ma.fit_and_save(
                None, through_season=2004, output_root=Path(tmp), rows=rows_without)
        self.assertEqual(meta_with['run_id'], meta_without['run_id'])
        self.assertEqual(meta_with['config_content_hash'], meta_without['config_content_hash'])


class ExtendedSetActuallyChangesTheFit(unittest.TestCase):
    def test_row_features_extended_carries_availability(self):
        rows = _with_availability(_synthetic_multiseason_rows())
        feat = stage3.row_features(rows[10], feature_names=stage3.EXTENDED_FEATURE_NAMES)
        self.assertEqual(feat['home_availability_deficit'], rows[10]['home_availability_deficit'])
        self.assertEqual(feat['away_availability_deficit'], rows[10]['away_availability_deficit'])
        self.assertIn(feat['availability_evidence'], (0.0, 1.0))

    def test_extended_training_hash_differs_from_default_on_the_same_rows(self):
        rows = _with_availability(_synthetic_multiseason_rows())
        _, meta_default = ma.fit_ridge_artifact(copy.deepcopy(rows))
        _, meta_extended = ma.fit_ridge_artifact(
            copy.deepcopy(rows), feature_names=stage3.EXTENDED_FEATURE_NAMES)
        self.assertNotEqual(meta_default['training_data_hash'], meta_extended['training_data_hash'])
        self.assertEqual(meta_extended['feature_names'], stage3.EXTENDED_FEATURE_NAMES)

    def test_fit_and_save_produces_a_different_artifact_id_for_the_extended_set(self):
        rows = _with_availability(_synthetic_multiseason_rows())
        with tempfile.TemporaryDirectory() as tmp:
            _, meta_default = ma.fit_and_save(
                None, through_season=2004, output_root=Path(tmp), rows=copy.deepcopy(rows))
            _, meta_extended = ma.fit_and_save(
                None, through_season=2004, output_root=Path(tmp), rows=copy.deepcopy(rows),
                feature_names=stage3.EXTENDED_FEATURE_NAMES)
        self.assertNotEqual(meta_default['run_id'], meta_extended['run_id'])
        self.assertNotEqual(meta_default['config_content_hash'], meta_extended['config_content_hash'])
        self.assertEqual(meta_extended['feature_contract_source'], 'caller-supplied feature_names')
        self.assertEqual(meta_default['feature_contract_source'], 'stage3_team_strength.FEATURE_NAMES')

    def test_two_fits_with_identical_availability_values_reuse_the_same_artifact(self):
        # Idempotency must survive the extended set too: fitting twice on
        # content-identical rows is a no-op, not a collision.
        rows_a = _with_availability(_synthetic_multiseason_rows())
        rows_b = _with_availability(_synthetic_multiseason_rows())
        with tempfile.TemporaryDirectory() as tmp:
            _, meta_a = ma.fit_and_save(
                None, through_season=2004, output_root=Path(tmp), rows=rows_a,
                feature_names=stage3.EXTENDED_FEATURE_NAMES)
            _, meta_b = ma.fit_and_save(
                None, through_season=2004, output_root=Path(tmp), rows=rows_b,
                feature_names=stage3.EXTENDED_FEATURE_NAMES)
        self.assertEqual(meta_a['run_id'], meta_b['run_id'])


class UnifiedModelThreadsFeatureNamesThrough(unittest.TestCase):
    def test_fit_unified_default_matches_explicit_frozen_set(self):
        from test_weekly_training import _synthetic_shadow_rows
        rows_a = _synthetic_shadow_rows()
        rows_b = copy.deepcopy(rows_a)
        import unified_model as um
        _, meta_default = um.fit_unified(rows_a)
        _, meta_explicit = um.fit_unified(rows_b, feature_names=stage3.FEATURE_NAMES)
        self.assertEqual(meta_default['training_data_hash'], meta_explicit['training_data_hash'])
        self.assertEqual(meta_default['feature_names'], list(stage3.FEATURE_NAMES))

    def test_fit_unified_extended_set_changes_training_hash(self):
        from test_weekly_training import _synthetic_shadow_rows
        rows = _with_availability(_synthetic_shadow_rows(), seed=5)
        import unified_model as um
        _, meta_default = um.fit_unified(copy.deepcopy(rows))
        _, meta_extended = um.fit_unified(copy.deepcopy(rows), feature_names=stage3.EXTENDED_FEATURE_NAMES)
        self.assertNotEqual(meta_default['training_data_hash'], meta_extended['training_data_hash'])
        self.assertEqual(meta_extended['feature_names'], stage3.EXTENDED_FEATURE_NAMES)


if __name__ == '__main__':
    unittest.main()
