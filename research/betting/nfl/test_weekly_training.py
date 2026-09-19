import copy
import json
import random
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import dataset
import weekly_training as weekly


def _synthetic_shadow_rows(n_seasons=3, weeks_per_season=20, games_per_week=10, seed=11):
    """Real production fits are `unified_margin`, whose chronological blocks
    require whole real-calendar weeks (>=200 base rows, >=100 combination
    rows across 24 weeks, >=100 calibration rows across 12 weeks). A single
    game per synthetic "week" -- fine for stage3's own fold-count tests --
    can never clear those per-block minimums no matter how many weeks are
    added, since a block's row count is capped at (its week count x rows per
    week). This generates a full synthetic slate per week, spaced by real
    7-day weeks (RESULT_PUBLICATION_LAG is 3 days, so adjacent weeks never
    collide at a block boundary), sized well past every RECIPE minimum.
    """
    rng = random.Random(seed)
    rows = []
    for season_idx in range(n_seasons):
        season = 2000 + season_idx
        season_start = datetime(season, 9, 1, tzinfo=timezone.utc)
        for week in range(1, weeks_per_season + 1):
            decision_at = season_start + timedelta(weeks=week - 1)
            for g in range(games_per_week):
                margin = rng.randint(-20, 20)
                rows.append({
                    'season': season, 'week': week,
                    'home': f'S{season_idx}W{week:02d}G{g:02d}A',
                    'away': f'S{season_idx}W{week:02d}G{g:02d}B',
                    'gameday': decision_at.date().isoformat(), 'decision_at': decision_at.isoformat(),
                    'actual_margin': margin, 'actual_total': 44,
                    'market_spread': -float(margin) / 2.0, 'market_total': 44,
                    'home_rest': 7, 'away_rest': 7, 'div_game': week % 4 == 0, 'roof': 'dome',
                    'home_prior_games': [], 'away_prior_games': [],
                    'pbp_available': season >= 2002,
                    'home_pbp_features': {'off_epa_per_play': 0.01, 'def_epa_per_play': -0.01, 'off_success_rate': 0.45}
                        if season >= 2002 else None,
                    'away_pbp_features': {'off_epa_per_play': -0.01, 'def_epa_per_play': 0.01, 'off_success_rate': 0.40}
                        if season >= 2002 else None,
                })
    return rows


class WeeklyTrainingTests(unittest.TestCase):
    def test_wednesday_noon_schedule_across_dst_and_week_boundary(self):
        for now, expected in [
            ('2026-09-16T16:00:00Z', '2026-09-16T16:00:00+00:00'),
            ('2026-09-16T15:59:59Z', '2026-09-09T16:00:00+00:00'),
            ('2026-01-14T17:00:00Z', '2026-01-14T17:00:00+00:00'),
            ('2026-03-11T15:00:00Z', '2026-03-04T17:00:00+00:00'),
        ]:
            self.assertEqual(weekly.weekly_origin(now).isoformat(), expected)

    def test_same_slot_reuses_snapshot_and_fit_despite_later_source_changes(self):
        rows = _synthetic_shadow_rows()
        built = {'rows': rows, 'dataset_version': 'test', 'quarantine': {}}
        with tempfile.TemporaryDirectory() as temp, patch.object(dataset, 'build_football_dataset', return_value=built) as build:
            first = weekly.fit_week(None, temp, now='2026-09-16T16:00:00Z')
            rows[0]['actual_margin'] = 9999
            again = weekly.fit_week(None, temp, now='2026-09-17T16:00:00Z')
            self.assertEqual(first, again)
            self.assertEqual(build.call_count, 1)
            later = weekly.fit_week(None, temp, now='2026-09-23T16:00:00Z')
            self.assertNotEqual(first['training_data_hash'], later['training_data_hash'])

    def test_interrupted_fit_reuses_frozen_training_values_on_retry(self):
        rows = _synthetic_shadow_rows()
        built = {'rows': rows, 'dataset_version': 'test', 'quarantine': {}}
        with tempfile.TemporaryDirectory() as temp, patch.object(dataset, 'build_football_dataset', return_value=built) as build:
            real = weekly.ma.fit_and_save
            with patch.object(weekly.ma, 'fit_and_save', side_effect=RuntimeError('interrupted')):
                with self.assertRaises(RuntimeError): weekly.fit_week(None, temp, now='2026-09-16T16:00:00Z')
            snapshot = next((Path(temp) / 'fits').glob('*.training.json')).read_bytes()
            rows[0]['actual_margin'] = 9999
            result = weekly.fit_week(None, temp, now='2026-09-17T16:00:00Z')
            self.assertEqual(next((Path(temp) / 'fits').glob('*.training.json')).read_bytes(), snapshot)
            self.assertEqual(build.call_count, 1)
            self.assertEqual(result['fit_cutoff'], '2026-09-16T16:00:00+00:00')

    def test_only_completed_earlier_fits_within_staleness_limit_are_selected(self):
        with tempfile.TemporaryDirectory() as temp:
            fitdir = Path(temp) / 'fits'; fitdir.mkdir()
            for name, fit in {
                'early': {'fit_cutoff': '2026-09-09T16:00:00Z', 'scheduled_origin': '2026-09-09T16:00:00Z', 'available_at': '2026-09-09T16:01:00Z', 'algorithm': 'unified_margin'},
                'future': {'fit_cutoff': '2026-09-16T16:00:00Z', 'scheduled_origin': '2026-09-16T16:00:00Z', 'available_at': '2026-09-16T16:01:00Z', 'algorithm': 'unified_margin'},
            }.items():
                (fitdir / f'{name}.json').write_text(json.dumps({'id': name, **fit}))
            self.assertEqual(weekly.choose_artifact(temp, '2026-09-15T12:00:00Z')['id'], 'early')
            self.assertIsNone(weekly.choose_artifact(temp, '2026-10-01T12:00:00Z'))

    def test_live_and_historical_feature_rows_match_without_outcome_fields(self):
        cutoff = dataset.stamp('2026-09-15T12:00:00Z')
        earlier = cutoff - timedelta(days=1)
        game = {'season': 2026, 'week': 2, 'team': 'KC', 'opponent': 'BAL', 'gameday': '2026-09-20',
                'team_score': 99, 'opp_score': 0, 'spread': -3, 'total': 44}
        setup = {'history': {'KC': [(earlier, 7, 40)], 'BAL': [(earlier, -3, 47)]},
                 'pbp': {}, 'rest_by_team_week': {(2026, 2, 'KC'): 7, (2026, 2, 'BAL'): 10}}
        live = dataset.football_feature_row(game, setup, cutoff)
        historical = dataset.football_feature_row(game, setup, cutoff, include_labels=True)
        for name in ('actual_margin', 'actual_total', 'market_spread', 'market_total',
                     'open_spread', 'open_total', 'market_movement'): historical.pop(name)
        self.assertEqual(live, historical)
        future = copy.deepcopy(setup)
        future['history']['KC'].append((cutoff + timedelta(seconds=1), 999, 999))
        future['pbp']['KC'] = [(cutoff + timedelta(seconds=1), {'off_epa_per_play': 999})]
        self.assertEqual(dataset.football_feature_row(game, future, cutoff), live)


if __name__ == '__main__':
    unittest.main()
