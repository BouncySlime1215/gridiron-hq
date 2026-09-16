"""Tests for model_artifact.py -- the save/versioning/reload layer around a
fitted ridge model, built on top of Stage 3's already-tested feature code.

Runs against small in-memory synthetic fixtures and a temp directory only --
never the real database, never the real `artifacts/` output directory.

Four things this file establishes, per the task spec:

  1. Fit-and-reload round-trip: predictions from the reloaded model match the
     original in-memory model to numerical tolerance.
  2. A corrupted artifact (one mutated byte in the saved model file) is
     refused on load with `ArtifactIntegrityError`, not silently loaded wrong.
  3. A feature-list mismatch between what's saved and what a caller expects
     is refused with `ArtifactFeatureMismatchError`, not silently misaligned.
  4. A later cutoff's fit does not use any row whose `decision_at`/season
     falls at or after that cutoff -- a mutation test in the same spirit as
     Stage 3's own leakage test.
"""
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import model_artifact as ma  # noqa: E402
import stage3_team_strength as stage3  # noqa: E402
from test_stage3_team_strength import _fake_row, _synthetic_multiseason_rows  # noqa: E402


class TempArtifactRootMixin:
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix='model_artifact_test_'))
        self.addCleanup(shutil.rmtree, self._tmp, ignore_errors=True)


class FitAndReloadRoundTripTests(TempArtifactRootMixin, unittest.TestCase):
    def test_reloaded_model_matches_original_predictions(self):
        rows = _synthetic_multiseason_rows()
        model, model_meta = ma.fit_ridge_artifact(rows)

        training_row_ids = [f"{r['season']}-w{r['week']:02d}-{r['home']}@{r['away']}" for r in rows]
        artifact_dir, meta = ma.save_artifact(
            self._tmp, model=model, model_meta=model_meta,
            feature_names=stage3.FEATURE_NAMES, dataset_version='test-dataset-v1',
            training_cutoff={'fit_through_instant': '2010-01-01T00:00:00+00:00'},
            training_row_ids=training_row_ids, min_season=2000, through_season_query_cap=2009)

        self.assertTrue((artifact_dir / 'model.joblib').exists())
        self.assertTrue((artifact_dir / 'metadata.json').exists())

        reloaded_model, reloaded_meta = ma.load_artifact(
            artifact_dir, expected_feature_names=stage3.FEATURE_NAMES)

        X = stage3.feature_matrix(rows[:10])
        original_pred = model.predict(X)
        reloaded_pred = reloaded_model.predict(X)
        np.testing.assert_allclose(original_pred, reloaded_pred, rtol=0, atol=1e-12)

        self.assertEqual(reloaded_meta['feature_names'], stage3.FEATURE_NAMES)
        self.assertEqual(reloaded_meta['algorithm'], 'ridge')
        self.assertEqual(reloaded_meta['n_training_rows'], len(rows))
        self.assertIsNone(reloaded_meta['calibrator_id'])
        self.assertIsNone(reloaded_meta['combiner_id'])
        self.assertEqual(reloaded_meta['upstream_model_ids'], [])
        self.assertFalse(reloaded_meta['serves_live_decisions'])

    def test_metadata_sidecar_is_plain_json_readable_without_loading_the_model(self):
        """The WP04 contract explicitly requires metadata not be locked inside
        an opaque pickle -- confirm the sidecar is inspectable with plain
        `json.loads`, no joblib/pickle involved."""
        rows = _synthetic_multiseason_rows()
        model, model_meta = ma.fit_ridge_artifact(rows)
        training_row_ids = [f"{r['season']}-w{r['week']:02d}" for r in rows]
        artifact_dir, meta = ma.save_artifact(
            self._tmp, model=model, model_meta=model_meta,
            feature_names=stage3.FEATURE_NAMES, dataset_version='test-dataset-v1',
            training_cutoff={'fit_through_instant': '2010-01-01T00:00:00+00:00'},
            training_row_ids=training_row_ids, min_season=2000, through_season_query_cap=2009)

        raw = json.loads((artifact_dir / 'metadata.json').read_text())
        self.assertEqual(raw['feature_names'], stage3.FEATURE_NAMES)
        self.assertIn('model_content_hash', raw)
        self.assertIn('code_hash', raw)
        self.assertIn('config_content_hash', raw)


class CorruptedArtifactRefusedTests(TempArtifactRootMixin, unittest.TestCase):
    def _save_fixture_artifact(self):
        rows = _synthetic_multiseason_rows()
        model, model_meta = ma.fit_ridge_artifact(rows)
        training_row_ids = [f"{r['season']}-w{r['week']:02d}" for r in rows]
        return ma.save_artifact(
            self._tmp, model=model, model_meta=model_meta,
            feature_names=stage3.FEATURE_NAMES, dataset_version='test-dataset-v1',
            training_cutoff={'fit_through_instant': '2010-01-01T00:00:00+00:00'},
            training_row_ids=training_row_ids, min_season=2000, through_season_query_cap=2009)

    def test_load_succeeds_before_corruption(self):
        artifact_dir, meta = self._save_fixture_artifact()
        model, reloaded_meta = ma.load_artifact(artifact_dir)
        self.assertEqual(reloaded_meta['run_id'], meta['run_id'])

    def test_one_mutated_byte_in_the_model_file_is_refused_not_silently_loaded(self):
        artifact_dir, meta = self._save_fixture_artifact()
        model_path = artifact_dir / 'model.joblib'
        data = bytearray(model_path.read_bytes())
        # Flip one byte somewhere in the middle of the file.
        mid = len(data) // 2
        data[mid] ^= 0xFF
        model_path.write_bytes(bytes(data))

        with self.assertRaises(ma.ArtifactIntegrityError):
            ma.load_artifact(artifact_dir)

    def test_verify_hash_false_bypasses_the_check_explicitly(self):
        """Sanity check that the integrity check is the thing doing the
        refusing (not e.g. joblib itself failing to unpickle) -- with the
        check explicitly disabled, the corrupted bytes either load (if still
        unpicklable-but-valid) or raise a plain unpickling error, never our
        ArtifactIntegrityError."""
        artifact_dir, meta = self._save_fixture_artifact()
        model_path = artifact_dir / 'model.joblib'
        data = bytearray(model_path.read_bytes())
        mid = len(data) // 2
        data[mid] ^= 0xFF
        model_path.write_bytes(bytes(data))

        try:
            ma.load_artifact(artifact_dir, verify_hash=False)
        except ma.ArtifactIntegrityError:
            self.fail('verify_hash=False must not raise ArtifactIntegrityError')
        except Exception:
            pass  # an unpickling error is fine here; the point is it's not our integrity check


class FeatureMismatchRefusedTests(TempArtifactRootMixin, unittest.TestCase):
    def test_mismatched_expected_feature_list_is_refused(self):
        rows = _synthetic_multiseason_rows()
        model, model_meta = ma.fit_ridge_artifact(rows)
        training_row_ids = [f"{r['season']}-w{r['week']:02d}" for r in rows]
        artifact_dir, meta = ma.save_artifact(
            self._tmp, model=model, model_meta=model_meta,
            feature_names=stage3.FEATURE_NAMES, dataset_version='test-dataset-v1',
            training_cutoff={'fit_through_instant': '2010-01-01T00:00:00+00:00'},
            training_row_ids=training_row_ids, min_season=2000, through_season_query_cap=2009)

        wrong_order = list(reversed(stage3.FEATURE_NAMES))
        with self.assertRaises(ma.ArtifactFeatureMismatchError):
            ma.load_artifact(artifact_dir, expected_feature_names=wrong_order)

        truncated = stage3.FEATURE_NAMES[:-1]
        with self.assertRaises(ma.ArtifactFeatureMismatchError):
            ma.load_artifact(artifact_dir, expected_feature_names=truncated)

    def test_exact_matching_feature_list_loads_fine(self):
        rows = _synthetic_multiseason_rows()
        model, model_meta = ma.fit_ridge_artifact(rows)
        training_row_ids = [f"{r['season']}-w{r['week']:02d}" for r in rows]
        artifact_dir, meta = ma.save_artifact(
            self._tmp, model=model, model_meta=model_meta,
            feature_names=stage3.FEATURE_NAMES, dataset_version='test-dataset-v1',
            training_cutoff={'fit_through_instant': '2010-01-01T00:00:00+00:00'},
            training_row_ids=training_row_ids, min_season=2000, through_season_query_cap=2009)
        # Must not raise.
        ma.load_artifact(artifact_dir, expected_feature_names=list(stage3.FEATURE_NAMES))


class CutoffEligibilityTests(unittest.TestCase):
    """resolve_cutoff / eligible_football_rows: the chronological-safety layer."""

    def test_eligible_rows_all_settle_strictly_before_the_cutoff(self):
        rows = _synthetic_multiseason_rows(n_seasons=5, games_per_season=10)
        cutoff_instant, before_season = ma.resolve_cutoff(rows, through_season=2002)
        eligible = ma.eligible_football_rows(rows, cutoff_instant, before_season=before_season)
        self.assertTrue(eligible)
        for r in eligible:
            self.assertLess(r['season'], before_season)
            settled = ma.shared_dataset.stamp(r['decision_at']) + ma.shared_dataset.RESULT_PUBLICATION_LAG
            self.assertLess(settled, cutoff_instant)

    def test_no_row_at_or_after_the_declared_season_is_ever_eligible(self):
        rows = _synthetic_multiseason_rows(n_seasons=5, games_per_season=10)
        cutoff_instant, before_season = ma.resolve_cutoff(rows, through_season=2002)
        eligible = ma.eligible_football_rows(rows, cutoff_instant, before_season=before_season)
        seasons_used = {r['season'] for r in eligible}
        self.assertNotIn(2003, seasons_used)
        self.assertNotIn(2004, seasons_used)
        for s in seasons_used:
            self.assertLessEqual(s, 2002)

    def test_mutating_a_later_seasons_row_does_not_change_an_earlier_cutoffs_eligible_set_or_fit(self):
        """Same spirit as Stage 3's own leakage mutation test: corrupt a row
        in a season strictly after the declared fit-through cutoff and
        confirm the fit against that earlier cutoff is byte-identical."""
        rows_a = _synthetic_multiseason_rows(n_seasons=5, games_per_season=10)
        rows_b = _synthetic_multiseason_rows(n_seasons=5, games_per_season=10)

        cutoff_a, before_season_a = ma.resolve_cutoff(rows_a, through_season=2001)
        eligible_a = ma.eligible_football_rows(rows_a, cutoff_a, before_season=before_season_a)
        model_a, meta_a = ma.fit_ridge_artifact(eligible_a)

        # Corrupt a 2004 (well after the 2001 cutoff) row in rows_b.
        target = next(r for r in rows_b if r['season'] == 2004)
        target['actual_margin'] = 999
        target['market_spread'] = -999
        target['decision_at'] = '2004-01-01T00:00:00+00:00'
        target.pop('_features', None)

        cutoff_b, before_season_b = ma.resolve_cutoff(rows_b, through_season=2001)
        eligible_b = ma.eligible_football_rows(rows_b, cutoff_b, before_season=before_season_b)
        model_b, meta_b = ma.fit_ridge_artifact(eligible_b)

        self.assertEqual(cutoff_a, cutoff_b)
        self.assertEqual(
            [f"{r['season']}-{r['week']}-{r['home']}-{r['away']}" for r in eligible_a],
            [f"{r['season']}-{r['week']}-{r['home']}-{r['away']}" for r in eligible_b])
        self.assertEqual(meta_a['hyperparameters'], meta_b['hyperparameters'])
        self.assertEqual(json.dumps(meta_a['alpha_trials'], sort_keys=True),
                          json.dumps(meta_b['alpha_trials'], sort_keys=True))

        X = stage3.feature_matrix(eligible_a[:5])
        np.testing.assert_allclose(model_a.predict(X), model_b.predict(X), rtol=0, atol=1e-12)

    def test_mutation_actually_matters_for_a_later_cutoff_that_includes_the_row(self):
        """Sanity check: the same mutation DOES change a fit whose cutoff is
        late enough to legitimately include the mutated 2004 row -- so the
        no-change result above is a real leakage guard, not a vacuous pass."""
        rows_a = _synthetic_multiseason_rows(n_seasons=5, games_per_season=10)
        rows_b = _synthetic_multiseason_rows(n_seasons=5, games_per_season=10)

        target = next(r for r in rows_b if r['season'] == 2004)
        target['actual_margin'] = 999
        target['market_spread'] = -999

        cutoff_a, before_season_a = ma.resolve_cutoff(rows_a, through_season=2004)
        eligible_a = ma.eligible_football_rows(rows_a, cutoff_a, before_season=before_season_a)
        cutoff_b, before_season_b = ma.resolve_cutoff(rows_b, through_season=2004)
        eligible_b = ma.eligible_football_rows(rows_b, cutoff_b, before_season=before_season_b)

        self.assertNotEqual(
            [r['actual_margin'] for r in eligible_a],
            [r['actual_margin'] for r in eligible_b],
            'the mutated 2004 row was expected to be eligible (and different) once the cutoff moves past it')

    def test_through_date_cutoff_excludes_rows_settling_at_or_after_it(self):
        rows = [
            _fake_row(2020, 1, 'AAA', 'BBB', 3, home_prior=[], away_prior=[]),
            _fake_row(2020, 5, 'AAA', 'CCC', -4, home_prior=[], away_prior=[]),
        ]
        # decision_at for week 5 is 2020-09-05T17:00:00+00:00; settlement adds
        # RESULT_PUBLICATION_LAG (3 days) -> 2020-09-08T17:00:00+00:00.
        cutoff_instant, before_season = ma.resolve_cutoff(rows, through_date='2020-09-08T00:00:00Z')
        eligible = ma.eligible_football_rows(rows, cutoff_instant, before_season=before_season)
        weeks = {r['week'] for r in eligible}
        self.assertIn(1, weeks)
        self.assertNotIn(5, weeks, 'week 5 settles AFTER the declared through_date cutoff and must be excluded')

    def test_the_last_game_in_the_declared_season_is_itself_eligible(self):
        """Regression test for a real boundary bug found while fitting against
        the actual database: with `through_season=2025`, the cutoff instant
        used to be exactly the LAST game's own settlement instant, and
        `eligible_football_rows`'s strict '<' check then excluded that same
        game from its own declared training window (confirmed for real:
        2025 week 22 NE@SEA was silently dropped). `resolve_cutoff` now adds
        a one-second buffer past the latest settlement so the boundary game
        is included, exactly as a caller asking for "through season 2025"
        would expect."""
        rows = [
            _fake_row(2025, 1, 'AAA', 'BBB', 3, home_prior=[], away_prior=[]),
            _fake_row(2025, 22, 'NE', 'SEA', 7, home_prior=[], away_prior=[]),  # the latest-settling game
        ]
        cutoff_instant, before_season = ma.resolve_cutoff(rows, through_season=2025)
        eligible = ma.eligible_football_rows(rows, cutoff_instant, before_season=before_season)
        weeks = {(r['home'], r['away']) for r in eligible}
        self.assertIn(('NE', 'SEA'), weeks, 'the last game of the declared through_season must be eligible')
        self.assertEqual(len(eligible), 2)

    def test_resolve_cutoff_requires_exactly_one_of_through_date_or_through_season(self):
        rows = _synthetic_multiseason_rows(n_seasons=2, games_per_season=4)
        with self.assertRaises(ValueError):
            ma.resolve_cutoff(rows)
        with self.assertRaises(ValueError):
            ma.resolve_cutoff(rows, through_date='2020-01-01', through_season=2020)


class IdempotencyTests(TempArtifactRootMixin, unittest.TestCase):
    """What guarantee actually holds when fitting again with the same cutoff
    and code.

    Two layers, both confirmed empirically (not merely asserted):

    1. The FIT itself (`fit_ridge_artifact`, independent of saving) is
       byte-identical across repeated calls in this venv (scikit-learn
       1.7.2 / numpy 2.5.3): same joblib-serialized bytes, both in-process
       and across separate process invocations (verified manually while
       building this module; ridge's closed-form solve and
       SimpleImputer/StandardScaler have no randomness or thread-order
       dependence here). This is an environment-dependent guarantee, not an
       absolute one -- a different BLAS backend or sklearn version is not
       guaranteed to reproduce it, which is why `save_artifact`'s identity
       (below) does not rely on it.

    2. SAVING is idempotent by construction, not by luck: `run_id` (and the
       artifact directory) is content-addressed from `config_content_hash`,
       so fitting-and-saving twice with identical inputs returns the SAME
       directory the second time (a no-op), rather than two directories
       that happen to have matching content. This is the guarantee
       `fit_and_save` callers should rely on when inputs and model bytes
       match. Package or training-data changes get a new identity. If the
       same identity produces different bytes, saving refuses to overwrite
       the existing artifact rather than silently returning the old model.
    """

    def test_repeated_fit_produces_byte_identical_model_bytes(self):
        """Layer 1: the fit itself, decoupled from saving."""
        rows_a = _synthetic_multiseason_rows()
        rows_b = _synthetic_multiseason_rows()  # independent, identical-by-construction copy
        model_a, meta_a = ma.fit_ridge_artifact(rows_a)
        model_b, meta_b = ma.fit_ridge_artifact(rows_b)

        buf_a, buf_b = io.BytesIO(), io.BytesIO()
        import joblib
        joblib.dump(model_a, buf_a)
        joblib.dump(model_b, buf_b)
        self.assertEqual(buf_a.getvalue(), buf_b.getvalue())
        self.assertEqual(meta_a['hyperparameters'], meta_b['hyperparameters'])

    def test_repeated_fit_and_save_returns_the_same_artifact_directory(self):
        """Layer 2: the actual guarantee callers of fit_and_save rely on."""
        rows_a = _synthetic_multiseason_rows()
        rows_b = _synthetic_multiseason_rows()

        artifact_dir_a, meta_a = ma.fit_and_save(
            db_path=None, through_season=2003, min_season=2000,
            output_root=self._tmp, rows=rows_a)
        artifact_dir_b, meta_b = ma.fit_and_save(
            db_path=None, through_season=2003, min_season=2000,
            output_root=self._tmp, rows=rows_b)

        self.assertEqual(artifact_dir_a, artifact_dir_b,
                          'a second identical fit-and-save must resolve to the SAME artifact directory')
        self.assertEqual(meta_a, meta_b)
        # Only one artifact directory exists under the output root -- no
        # silent duplication of identical content under a second run_id.
        self.assertEqual(len(list(self._tmp.iterdir())), 1)

    def test_a_genuinely_different_run_id_collision_is_refused_not_silently_overwritten(self):
        """save_artifact must not blindly overwrite a directory whose
        content differs from what this call is about to write -- construct
        that case directly by pre-seeding a directory with different content
        at the exact run_id this call will compute."""
        rows = _synthetic_multiseason_rows()
        model, model_meta = ma.fit_ridge_artifact(rows)
        training_row_ids = [f"{r['season']}-w{r['week']:02d}" for r in rows]
        training_cutoff = {'through_season_arg': 2003, 'fit_through_instant': '2003-01-01T00:00:00+00:00'}

        # Corrupt a real saved directory rather than mirroring the identity
        # formula in the test. A repeat save must refuse to overwrite it.
        collide_dir, _ = ma.save_artifact(
            self._tmp, model=model, model_meta=model_meta,
            feature_names=stage3.FEATURE_NAMES, dataset_version='test-dataset-v1',
            training_cutoff=training_cutoff, training_row_ids=training_row_ids,
            min_season=2000, through_season_query_cap=2003)
        (collide_dir / 'model.joblib').write_bytes(b'not a real model')

        with self.assertRaises(FileExistsError):
            ma.save_artifact(
                self._tmp, model=model, model_meta=model_meta,
                feature_names=stage3.FEATURE_NAMES, dataset_version='test-dataset-v1',
                training_cutoff=training_cutoff, training_row_ids=training_row_ids,
                min_season=2000, through_season_query_cap=2003)

    def test_different_cutoffs_produce_different_config_content_hash_and_directories(self):
        rows = _synthetic_multiseason_rows()
        dir_2002, meta_2002 = ma.fit_and_save(
            db_path=None, through_season=2002, min_season=2000,
            output_root=self._tmp, rows=list(rows))
        dir_2003, meta_2003 = ma.fit_and_save(
            db_path=None, through_season=2003, min_season=2000,
            output_root=self._tmp, rows=list(rows))
        self.assertNotEqual(meta_2002['config_content_hash'], meta_2003['config_content_hash'])
        self.assertNotEqual(meta_2002['training_row_ids'], meta_2003['training_row_ids'])
        self.assertNotEqual(dir_2002, dir_2003)


class FitAndSaveEntryPointTests(TempArtifactRootMixin, unittest.TestCase):
    def test_revised_training_values_get_a_new_identity_without_overwriting(self):
        rows = _synthetic_multiseason_rows()
        first, before = ma.fit_and_save(None, through_season=2003, min_season=2000,
                                       output_root=self._tmp, rows=rows)
        old_bytes = (first / 'model.joblib').read_bytes()
        # Same game IDs and cutoff, different labels/features. The fitter must
        # also ignore stale _features left on reused rows by an earlier fit.
        for r in rows:
            r['actual_margin'] += 1
            r['home_rest'] = (r.get('home_rest') or 0) + 2
        second, after = ma.fit_and_save(None, through_season=2003, min_season=2000,
                                       output_root=self._tmp, rows=rows)
        self.assertEqual(before['training_row_ids'], after['training_row_ids'])
        self.assertNotEqual(before['training_data_hash'], after['training_data_hash'])
        self.assertNotEqual(first, second)
        self.assertEqual((first / 'model.joblib').read_bytes(), old_bytes)

    def test_runtime_packages_change_artifact_identity(self):
        _, meta = ma.fit_and_save(None, through_season=2003, min_season=2000,
                                 output_root=self._tmp, rows=_synthetic_multiseason_rows())
        baseline = ma.compute_config_hash(meta)
        meta['packages'] = {**meta['packages'], 'scikit-learn': 'different-version'}
        self.assertNotEqual(ma.compute_config_hash(meta), baseline)

    def test_unsupported_algorithm_raises_not_implemented(self):
        rows = _synthetic_multiseason_rows(n_seasons=2, games_per_season=4)
        with self.assertRaises(NotImplementedError):
            ma.fit_and_save(
                db_path=None, through_season=2001, min_season=2000,
                output_root=self._tmp, rows=rows, algorithm='lightgbm')

    def test_saved_artifact_directory_uses_run_id_naming_and_is_reloadable(self):
        rows = _synthetic_multiseason_rows()
        artifact_dir, meta = ma.fit_and_save(
            db_path=None, through_season=2003, min_season=2000,
            output_root=self._tmp, rows=rows)
        self.assertEqual(artifact_dir.parent, self._tmp)
        self.assertEqual(artifact_dir.name, meta['run_id'])
        model, reloaded_meta = ma.load_artifact(artifact_dir, expected_feature_names=stage3.FEATURE_NAMES)
        self.assertEqual(reloaded_meta['run_id'], meta['run_id'])


if __name__ == '__main__':
    unittest.main()
