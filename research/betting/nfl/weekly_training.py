"""Fixed weekly ridge recipe and frozen pregame features for the shadow runner.

Wednesday noon America/New_York defines the fit slot. Actual capture/training
times are retained: a late fit never masquerades as a completed Wednesday fit.
The DB is read-only. Outputs are local research artifacts, not promotions.
"""
import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import dataset
import model_artifact as ma
import score_artifact as scoring

VERSION = 'nfl-unified-margin-shadow-v1'
EASTERN = ZoneInfo('America/New_York')


def weekly_origin(now):
    local = scoring.instant(now).astimezone(EASTERN)
    origin = (local - timedelta(days=(local.weekday() - 2) % 7)).replace(hour=12, minute=0, second=0, microsecond=0)
    if origin > local:
        origin -= timedelta(days=7)
    return origin.astimezone(timezone.utc)


def save_once(path, value):
    """Publish a complete file without replacing a concurrent/earlier winner."""
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    temp.write_text(json.dumps(value, sort_keys=True, allow_nan=False, indent=2) + '\n')
    try:
        os.link(temp, path)
    except FileExistsError:
        pass
    finally:
        temp.unlink(missing_ok=True)
    return json.loads(path.read_text())


def fit_week(db_path, output_root, now=None):
    started = scoring.instant(now) if now else datetime.now(timezone.utc)
    origin = weekly_origin(started.isoformat())
    root = Path(output_root)
    slot = root / 'fits' / (origin.strftime('%Y%m%dT%H%M%SZ') + '-unified_margin.json')
    if slot.exists():
        return json.loads(slot.read_text())
    # Freeze the source rows before fitting. Training-data corrections within
    # this slot cannot silently retrain its chosen recipe on a retry.
    snapshot_path = slot.with_suffix('.training.json')
    if snapshot_path.exists():
        snapshot = json.loads(snapshot_path.read_text())
    else:
        built = dataset.build_football_dataset(db_path, through_season=started.year)
        captured = datetime.now(timezone.utc) if now is None else started
        eligible = ma.eligible_football_rows(built['rows'], captured)
        if len(eligible) < 200 or len({r['season'] for r in eligible}) < 3:
            raise ValueError('weekly fit requires at least 200 settled games across three seasons')
        snapshot = save_once(snapshot_path, {
            'schema': VERSION, 'scheduled_origin': origin.isoformat(),
            'fit_cutoff': captured.isoformat(), 'dataset_version': built['dataset_version'],
            'provenance': 'reconstructed football history; three-day result publication proxy',
            'rows': eligible, 'quarantine': built['quarantine'],
        })
    from unified_model import RECIPE
    recipe_hash = hashlib.sha256(json.dumps(RECIPE, sort_keys=True).encode()).hexdigest()
    save_once(root / 'protocols' / (recipe_hash + '.json'), {
        'recipe': RECIPE, 'declared_at': datetime.now(timezone.utc).isoformat(),
        'classification': 'development recipe; no outer audit results used in this run'})
    directory, meta = ma.fit_and_save(None, through_date=snapshot['fit_cutoff'],
        min_season=1999, output_root=root / 'artifacts', rows=snapshot['rows'], algorithm='unified_margin')
    result = {
        'schema': VERSION, 'scheduled_origin': origin.isoformat(),
        'fit_cutoff': snapshot['fit_cutoff'], 'artifact_dir': str(directory.resolve()),
        'artifact_id': meta['run_id'], 'training_rows': meta['n_training_rows'],
        'training_data_hash': meta['training_data_hash'],
        'training_snapshot_hash': hashlib.sha256(snapshot_path.read_bytes()).hexdigest(),
        'available_at': meta['created_at'], 'authority': 'research_only', 'qualified': False,
        'algorithm': 'unified_margin', 'recipe_hash': recipe_hash,
    }
    return save_once(slot, result)


def choose_artifact(output_root, cutoff):
    """Latest completed eligible fit, with a bounded stale fallback."""
    legal = []
    cutoff = scoring.instant(cutoff)
    for file in (Path(output_root) / 'fits').glob('*.json'):
        if file.name.endswith('.training.json'):
            continue
        fit = json.loads(file.read_text())
        if fit.get('algorithm') != 'unified_margin':
            continue
        if (scoring.instant(fit['available_at']) <= cutoff
                and scoring.instant(fit['fit_cutoff']) < cutoff
                and timedelta(0) <= cutoff - scoring.instant(fit['scheduled_origin']) <= timedelta(days=14)):
            legal.append(fit)
    return max(legal, key=lambda f: f['fit_cutoff']) if legal else None


def capture_games(db_path, output_root, games):
    # One consistent read-only source snapshot per slate. cutoff_at is the real
    # completion instant, not a passed historical date or a guessed T-60 time.
    setup = dataset.shared_setup(db_path, max(g['season'] for g in games))
    captured = datetime.now(timezone.utc).isoformat()
    fit = choose_artifact(output_root, captured)
    observations = []
    for game in games:
        item = {'game': game, 'captured_at': captured, 'request': None, 'reason': None}
        if scoring.instant(game['kickoff_at']) <= scoring.instant(captured):
            item['reason'] = 'capture_after_kickoff'
        elif fit is None:
            item['reason'] = 'no_eligible_completed_artifact_within_14_days'
        else:
            source = setup['game_map'].get((game['season'], game['week'], game['home']))
            if not source or source['opponent'] != game['away']:
                item['reason'] = 'schedule_identity_missing_or_changed'
            else:
                feature_row = dataset.football_feature_row(source, setup, captured)
                request = scoring.make_score_request(feature_row, fit['artifact_dir'])
                request.update(evidence_mode='observed_shadow', kickoff_at=game['kickoff_at'],
                    source_lineage={'captured_at': captured, 'feature_row': feature_row,
                        'availability_policy': 'three-day publication proxy; current DB snapshot',
                        'historical_revision_completeness': 'not established'})
                item['request'] = request
                item['fit'] = fit
        observations.append(item)
    return {'schema': VERSION, 'captured_at': captured, 'observations': observations}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['fit', 'capture'])
    parser.add_argument('--db', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        result = fit_week(args.db, args.output) if args.action == 'fit' else capture_games(args.db, args.output, json.load(sys.stdin)['games'])
        print(json.dumps({'ok': True, **result}, allow_nan=False))
    except Exception as exc:
        print(json.dumps({'ok': False, 'reason': f'{type(exc).__name__}: {exc}'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
