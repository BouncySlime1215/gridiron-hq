"""Score pinned NFL margin artifacts from retained feature values; never read a DB.

stdin is one JSON request, stdout one JSON result. The Node adapter invokes this
same entry point used by replay. This is research scoring, not betting authority.
Only locally produced, trusted joblib artifacts belong in the artifact root.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import model_artifact as artifacts
import stage3_team_strength as stage3

REQUEST_SCHEMA = 'nfl-margin-score-request-v1'
RESULT_SCHEMA = 'nfl-margin-score-result-v1'
TARGET = 'actual_margin (home score - away score)'


def instant(value):
    if not isinstance(value, str):
        raise ValueError('timestamp must be a timezone-qualified ISO string')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamp must include a timezone')
    return parsed.astimezone(timezone.utc)


def make_score_request(row, artifact_dir, *, cutoff_at=None):
    """Freeze Stage 3's existing transformation for a reconstructed dataset row.

    Dataset rows are historical reconstructions, not receipts at T-60. Keep
    that classification even if the game is recent. No labels enter the request.
    """
    if cutoff_at is not None and instant(cutoff_at) != instant(row['decision_at']):
        raise ValueError('cannot re-date a feature row; rebuild its features at the requested cutoff')
    metadata_bytes = (Path(artifact_dir) / 'metadata.json').read_bytes()
    meta = json.loads(metadata_bytes)
    return {
        'schema': REQUEST_SCHEMA,
        'evidence_mode': 'reconstructed',
        'game': {key: row[key] for key in ('season', 'week', 'home', 'away')},
        'cutoff_at': cutoff_at or row['decision_at'],
        'artifact': {
            'run_id': meta['run_id'],
            'model_content_hash': meta['model_content_hash'],
            'metadata_content_hash': hashlib.sha256(metadata_bytes).hexdigest(),
        },
        'feature_names': list(stage3.FEATURE_NAMES),
        'features': stage3.row_features(row),
        'transformation_hash': hashlib.sha256(Path(stage3.__file__).read_bytes()).hexdigest(),
    }


def score_request(request, artifact_dir):
    if request.get('schema') != REQUEST_SCHEMA:
        raise ValueError('unsupported scoring request schema')
    if request.get('evidence_mode') not in ('reconstructed', 'observed_shadow'):
        raise ValueError('only reconstructed or observed_shadow research scoring is supported')
    game = request.get('game', {})
    if (type(game.get('season')) is not int or type(game.get('week')) is not int
            or game['season'] < 1900 or not 1 <= game['week'] <= 25
            or not all(isinstance(game.get(k), str) and game[k] for k in ('home', 'away'))
            or game['home'] == game['away']):
        raise ValueError('invalid game identity')
    cutoff = instant(request.get('cutoff_at'))
    metadata_bytes = (Path(artifact_dir) / 'metadata.json').read_bytes()
    meta = json.loads(metadata_bytes)
    pin = request.get('artifact', {})
    if hashlib.sha256(metadata_bytes).hexdigest() != pin.get('metadata_content_hash'):
        raise ValueError('metadata content hash differs from frozen request')
    if meta.get('run_id') != pin.get('run_id') or meta.get('model_content_hash') != pin.get('model_content_hash'):
        raise ValueError('model identity differs from frozen request')
    if meta.get('schema') != artifacts.SCHEMA or meta.get('algorithm') not in ('ridge', 'unified_margin') or meta.get('target') != TARGET:
        raise ValueError('unsupported artifact schema, algorithm or target')
    if instant(meta.get('training_cutoff', {}).get('fit_through_instant')) >= cutoff:
        raise ValueError('model training cutoff must precede the scoring cutoff')
    if request['evidence_mode'] == 'observed_shadow':
        lineage = request.get('source_lineage', {})
        if instant(lineage.get('captured_at')) != cutoff:
            raise ValueError('observed snapshot must use its actual capture cutoff')
        if instant(meta.get('created_at')) > cutoff:
            raise ValueError('model was not available at observed snapshot cutoff')
        if instant(request.get('kickoff_at')) <= cutoff:
            raise ValueError('observed shadow prediction must precede kickoff')
        raw = lineage.get('feature_row')
        if not isinstance(raw, dict) or any(k in raw for k in ('actual_margin', 'actual_total')):
            raise ValueError('observed snapshot requires label-free retained feature inputs')
        if instant(raw.get('decision_at')) != cutoff or any(raw.get(k) != game[k] for k in game):
            raise ValueError('retained feature inputs do not match the game/cutoff')
        if stage3.row_features(raw) != request.get('features'):
            raise ValueError('retained raw inputs do not reproduce the frozen features')
        for key in ('home_prior_games', 'away_prior_games'):
            if any(instant(r['at']) >= cutoff for r in raw.get(key, [])):
                raise ValueError('history was not available before cutoff')
    # A mismatched sklearn unpickle can succeed with changed behavior. Refuse
    # before deserialization, rather than treating a warning as compatibility.
    required_packages = ['scikit-learn', 'numpy', 'joblib']
    if meta['algorithm'] == 'unified_margin':
        required_packages += ['lightgbm', 'scipy']
    for name in required_packages:
        expected = meta.get('packages', {}).get(name)
        actual = importlib.metadata.version(name)
        if expected != actual:
            raise ValueError(f'runtime package mismatch: {name}, expected {expected}, installed {actual}')
    names = request.get('feature_names')
    if names != stage3.FEATURE_NAMES:
        raise ValueError('feature names/order differs from the Stage 3 contract')
    features = request.get('features')
    if not isinstance(features, dict) or set(features) != set(names):
        raise ValueError('feature values must contain exactly the declared feature names')
    for name, value in features.items():
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
            raise ValueError(f'feature {name} must be finite numeric data or explicit null')
    transform_hash = request.get('transformation_hash')
    if not isinstance(transform_hash, str) or len(transform_hash) != 64 or any(c not in '0123456789abcdef' for c in transform_hash):
        raise ValueError('missing feature transformation identity')
    model, _ = artifacts.load_artifact(artifact_dir, expected_feature_names=names)
    matrix = stage3.feature_matrix([{'_features': features}])
    predictions = np.asarray(model.predict(matrix))
    if predictions.shape != (1,) or not np.isfinite(predictions[0]):
        raise ValueError('model did not return exactly one finite margin')
    detail = model.describe(matrix) if meta['algorithm'] == 'unified_margin' else {}
    return {
        'schema': RESULT_SCHEMA, 'available': True,
        'authority': 'research_only', 'qualified': False,
        'evidence_mode': request['evidence_mode'], 'game': game,
        'cutoff_at': request['cutoff_at'], 'artifact': pin,
        'target': TARGET, 'predicted_margin': float(predictions[0]),
        'probabilities': {'available': False, 'reason': 'margin artifact has no probability calibrator'},
        'feature_names': names, 'transformation_hash': transform_hash,
        'runtime_packages': meta['packages'],
        'algorithm': meta['algorithm'], 'unified_forecast': detail,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-dir', required=True)
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin)
        result = score_request(request, args.artifact_dir)
    except Exception as exc:
        result = {'schema': RESULT_SCHEMA, 'available': False, 'qualified': False,
                  'authority': 'research_only', 'reason': f'{type(exc).__name__}: {exc}'}
    print(json.dumps(result, allow_nan=False))


if __name__ == '__main__':
    main()
