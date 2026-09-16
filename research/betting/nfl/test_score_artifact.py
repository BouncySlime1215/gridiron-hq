"""Real pipeline parity and refusal fixtures; all outputs live in temp dirs."""
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

import model_artifact as ma
import score_artifact as scoring
import stage3_team_strength as stage3
from test_stage3_team_strength import _synthetic_multiseason_rows


def make_fixture(root):
    rows = _synthetic_multiseason_rows()
    directory, meta = ma.fit_and_save(None, through_season=2003, min_season=2000,
                                     output_root=root, rows=rows)
    fixture_row = {**rows[0], 'season': 2026, 'week': 2, 'home': 'KC', 'away': 'BUF',
                   'decision_at': '2026-09-15T12:00:00Z'}
    request = scoring.make_score_request(fixture_row, directory)
    model, _ = ma.load_artifact(directory)
    direct = float(model.predict(stage3.feature_matrix([{'_features': request['features']}]))[0])
    return directory, request, direct


class ScoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory, self.request, self.direct = make_fixture(self.temp.name)

    def test_exact_pipeline_parity_with_null_missingness_and_input_unchanged(self):
        before = copy.deepcopy(self.request)
        result = scoring.score_request(self.request, self.directory)
        self.assertEqual(result['predicted_margin'], self.direct)
        self.assertEqual(self.request, before)
        self.assertFalse(result['qualified'])
        self.assertFalse(result['probabilities']['available'])
        self.request['features']['home_rest'] = None
        model, _ = ma.load_artifact(self.directory)
        expected = model.predict(stage3.feature_matrix([{'_features': self.request['features']}]))[0]
        self.assertEqual(scoring.score_request(self.request, self.directory)['predicted_margin'], expected)

    def test_cutoff_at_or_before_training_is_refused(self):
        meta = json.loads((self.directory / 'metadata.json').read_text())
        for cutoff in [meta['training_cutoff']['fit_through_instant'], '1999-01-01T00:00:00Z']:
            self.request['cutoff_at'] = cutoff
            with self.assertRaisesRegex(ValueError, 'training cutoff'):
                scoring.score_request(self.request, self.directory)

    def test_prospective_claim_is_refused(self):
        self.request['evidence_mode'] = 'prospective'
        with self.assertRaisesRegex(ValueError, 'reconstructed'):
            scoring.score_request(self.request, self.directory)

    def test_request_builder_cannot_relabel_a_later_feature_row_as_earlier(self):
        row = _synthetic_multiseason_rows()[0]
        with self.assertRaisesRegex(ValueError, 'cannot re-date'):
            scoring.make_score_request(row, self.directory, cutoff_at='1999-01-01T00:00:00Z')

    def test_feature_order_missing_extra_and_nonfinite_are_refused(self):
        cases = []
        request = copy.deepcopy(self.request); request['feature_names'].reverse(); cases.append(request)
        request = copy.deepcopy(self.request); del request['features']['home_rest']; cases.append(request)
        request = copy.deepcopy(self.request); request['features']['actual_margin'] = 7; cases.append(request)
        for value in [float('nan'), float('inf'), '7', True]:
            request = copy.deepcopy(self.request); request['features']['home_rest'] = value; cases.append(request)
        for request in cases:
            with self.subTest(request=request):
                with self.assertRaises(ValueError): scoring.score_request(request, self.directory)

    def test_mutated_metadata_and_model_are_refused(self):
        p = self.directory / 'metadata.json'
        original = p.read_bytes()
        p.write_bytes(original + b' ')
        with self.assertRaisesRegex(ValueError, 'metadata content hash'):
            scoring.score_request(self.request, self.directory)
        p.write_bytes(original)
        (self.directory / 'model.joblib').write_bytes(b'corrupt')
        with self.assertRaises(ma.ArtifactIntegrityError):
            scoring.score_request(self.request, self.directory)

    def test_package_mismatch_refused_before_deserialization(self):
        p = self.directory / 'metadata.json'
        meta = json.loads(p.read_text()); meta['packages']['scikit-learn'] = '0.invalid'
        p.write_text(json.dumps(meta))
        self.request['artifact']['metadata_content_hash'] = hashlib.sha256(p.read_bytes()).hexdigest()
        (self.directory / 'model.joblib').write_bytes(b'not a pickle')
        with self.assertRaisesRegex(ValueError, 'runtime package mismatch'):
            scoring.score_request(self.request, self.directory)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture-root':
        directory, request, direct = make_fixture(sys.argv[2])
        print(json.dumps({'request': request, 'direct': direct, 'directory': str(directory)}))
    else:
        unittest.main()
