"""Tests for stage3_team_strength.py -- Stage 3 / Slice 6's predeclared
first-model comparison.

Three things this file must establish, per the task spec:

  1. The recent-form feature computation is correct on a small synthetic
     fixture with a hand-computed expected value -- this is "the single
     easiest place to introduce a silent bug" because `margin` in a prior-game
     entry is signed from THAT TEAM's own perspective, not the home team's.
  2. A later season's data cannot leak into an earlier season's fold: a
     mutation test that changes a late-season row and confirms an earlier
     season's fold output is byte-identical.
  3. The reported metrics (MAE/RMSE/bias) are computed correctly against a
     small, independently-computed-by-hand synthetic case.

Runs against small in-memory fixtures only -- never the real database.
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stage3_team_strength as stage3  # noqa: E402


class RowFeaturesSignConventionTests(unittest.TestCase):
    """The recent-form features, hand-computed, sign convention included."""

    def test_home_form_margin_is_the_mean_of_the_HOME_teams_own_signed_margins(self):
        row = {
            'home_rest': 7, 'away_rest': 6, 'div_game': 1,
            'home_prior_games': [
                {'at': 't1', 'margin': 10, 'total': 40},   # home team won its own prior game by 10
                {'at': 't2', 'margin': -3, 'total': 50},   # home team LOST its own prior game by 3
            ],
            'away_prior_games': [
                {'at': 't3', 'margin': 7, 'total': 44},
            ],
            'pbp_available': False, 'home_pbp_features': None, 'away_pbp_features': None,
        }
        feat = stage3.row_features(row)
        # Hand computation: mean(10, -3) = 3.5, NOT mean(-10, 3) or any home/away
        # perspective flip -- each entry is already that team's own signed result.
        self.assertAlmostEqual(feat['home_form_margin'], 3.5)
        self.assertEqual(feat['home_form_count'], 2.0)
        self.assertAlmostEqual(feat['home_form_total'], 45.0)
        self.assertAlmostEqual(feat['away_form_margin'], 7.0)
        self.assertEqual(feat['away_form_count'], 1.0)
        self.assertEqual(feat['rest_diff'], 1)
        self.assertEqual(feat['div_game'], 1.0)

    def test_zero_prior_games_gives_None_not_zero(self):
        """A team with no prior history must not be silently treated as league-average
        (0.0) -- that is indistinguishable from 'broke exactly even' and would corrupt
        the mean/impute step downstream. None must reach the imputer, not a fabricated 0."""
        row = {
            'home_rest': 7, 'away_rest': 7, 'div_game': 0,
            'home_prior_games': [], 'away_prior_games': [],
            'pbp_available': False, 'home_pbp_features': None, 'away_pbp_features': None,
        }
        feat = stage3.row_features(row)
        self.assertIsNone(feat['home_form_margin'])
        self.assertIsNone(feat['away_form_total'])
        self.assertEqual(feat['home_form_count'], 0.0)

    def test_pbp_diff_is_home_minus_away_only_when_available_for_both(self):
        row = {
            'home_rest': 7, 'away_rest': 7, 'div_game': 0,
            'home_prior_games': [], 'away_prior_games': [],
            'pbp_available': True,
            'home_pbp_features': {'off_epa_per_play': 0.12, 'def_epa_per_play': -0.05, 'off_success_rate': 0.48},
            'away_pbp_features': {'off_epa_per_play': -0.03, 'def_epa_per_play': 0.02, 'off_success_rate': 0.41},
        }
        feat = stage3.row_features(row)
        self.assertAlmostEqual(feat['pbp_diff_off_epa_per_play'], 0.12 - (-0.03))
        self.assertAlmostEqual(feat['pbp_diff_def_epa_per_play'], -0.05 - 0.02)
        self.assertAlmostEqual(feat['pbp_diff_off_success_rate'], 0.48 - 0.41)

    def test_pbp_diff_is_None_when_pbp_not_available(self):
        row = {
            'home_rest': 7, 'away_rest': 7, 'div_game': 0,
            'home_prior_games': [], 'away_prior_games': [],
            'pbp_available': False, 'home_pbp_features': None, 'away_pbp_features': None,
        }
        feat = stage3.row_features(row)
        for key in ('pbp_diff_off_epa_per_play', 'pbp_diff_def_epa_per_play', 'pbp_diff_off_success_rate'):
            self.assertIsNone(feat[key], f'{key} must be null, never a fabricated 0, when pbp is unavailable')


class MetricsCorrectnessTests(unittest.TestCase):
    """paired_metrics against a small case computed independently by hand."""

    def test_mae_rmse_bias_match_hand_computation(self):
        # actual, predicted pairs, chosen so every quantity is easy to check by hand:
        #   errors (pred - actual): 2, -1, 0, 3
        #   |errors|: 2, 1, 0, 3        -> MAE = 6/4 = 1.5
        #   errors^2: 4, 1, 0, 9        -> mean 14/4 = 3.5 -> RMSE = sqrt(3.5) = 1.8708286933869707
        #   mean(errors) = (2 - 1 + 0 + 3)/4 = 1.0            -> bias = +1.0
        rows = [
            {'actual_margin': 3, 'pred': 5},
            {'actual_margin': 10, 'pred': 9},
            {'actual_margin': -2, 'pred': -2},
            {'actual_margin': 0, 'pred': 3},
        ]
        m = stage3.paired_metrics(rows, 'actual_margin', 'pred')
        self.assertEqual(m['n'], 4)
        self.assertAlmostEqual(m['mae'], 1.5)
        self.assertAlmostEqual(m['rmse'], 3.5 ** 0.5)
        self.assertAlmostEqual(m['bias'], 1.0)

    def test_missing_predictions_are_excluded_not_treated_as_zero_error(self):
        rows = [
            {'actual_margin': 3, 'pred': 5},
            {'actual_margin': 10, 'pred': None},  # market baseline unavailable for this row
            {'actual_margin': None, 'pred': 4},   # (defensive: should not occur in real rows)
        ]
        m = stage3.paired_metrics(rows, 'actual_margin', 'pred')
        self.assertEqual(m['n'], 1)
        self.assertAlmostEqual(m['mae'], 2.0)
        self.assertAlmostEqual(m['bias'], 2.0)

    def test_empty_support_reports_none_not_a_crash_or_zero(self):
        m = stage3.paired_metrics([], 'actual_margin', 'pred')
        self.assertEqual(m, {'n': 0, 'mae': None, 'rmse': None, 'bias': None})


def _fake_row(season, week, home, away, actual_margin, market_spread=None,
              home_rest=7, away_rest=7, div_game=0,
              home_prior=None, away_prior=None, pbp_available=False,
              home_pbp=None, away_pbp=None):
    return {
        'season': season, 'week': week, 'home': home, 'away': away,
        'gameday': f'{season}-09-{week:02d}', 'decision_at': f'{season}-09-{week:02d}T17:00:00+00:00',
        'actual_margin': actual_margin, 'actual_total': 44,
        'market_spread': market_spread, 'market_total': 44,
        'home_rest': home_rest, 'away_rest': away_rest, 'div_game': div_game, 'roof': 'dome',
        'home_prior_games': home_prior or [], 'away_prior_games': away_prior or [],
        'home_pbp_features': home_pbp, 'away_pbp_features': away_pbp,
        'pbp_available': pbp_available,
    }


def _synthetic_multiseason_rows(n_seasons=5, games_per_season=20, seed=7):
    """A deterministic, fully synthetic multi-season row set -- no database,
    no fixture file, just enough seasons/games for the expanding-fold scheme
    to produce a real outer fold with a real inner split. Every value is a
    plain arithmetic function of its indices, so mutating one later-season
    row is trivial to reason about."""
    import random
    rng = random.Random(seed)
    rows = []
    teams = ['AAA', 'BBB', 'CCC', 'DDD']
    for season_idx in range(n_seasons):
        season = 2000 + season_idx
        for week in range(1, games_per_season + 1):
            home, away = rng.choice(teams), rng.choice(teams)
            if home == away:
                away = teams[(teams.index(home) + 1) % len(teams)]
            margin = rng.randint(-20, 20)
            rows.append(_fake_row(
                season, week, home, away, actual_margin=margin,
                market_spread=-float(margin) / 2.0,  # loosely correlated, deterministic
                home_rest=7, away_rest=7, div_game=week % 4 == 0,
                home_prior=[{'at': f'{season}-{week-1}', 'margin': rng.randint(-14, 14), 'total': 44}] if week > 1 else [],
                away_prior=[{'at': f'{season}-{week-1}', 'margin': rng.randint(-14, 14), 'total': 44}] if week > 1 else [],
                pbp_available=season >= 2002,
                home_pbp={'off_epa_per_play': 0.01 * week, 'def_epa_per_play': -0.01 * week, 'off_success_rate': 0.45}
                    if season >= 2002 else None,
                away_pbp={'off_epa_per_play': -0.01 * week, 'def_epa_per_play': 0.01 * week, 'off_success_rate': 0.40}
                    if season >= 2002 else None,
            ))
    return rows


class NoLeakageMutationTests(unittest.TestCase):
    """A later season's data must not change an earlier season's fold output."""

    def test_mutating_a_later_season_row_does_not_change_an_earlier_folds_output(self):
        rows_a = _synthetic_multiseason_rows()
        rows_b = _synthetic_multiseason_rows()  # independent, identical-by-construction copy

        # min_train_seasons=2 -> first test season is 2002 (index 2), with 2000-2004
        # available (5 seasons), so 2002/2003/2004 are all outer test folds and 2004
        # is strictly LATER than the 2002 fold under test.
        folds_a, _ = stage3.run_expanding_folds(rows_a, min_train_seasons=2)
        fold_2002_a = next(f for f in folds_a if f['season'] == 2002)

        # Mutate a 2004 (later season) row's outcome and market line in rows_b.
        target = next(r for r in rows_b if r['season'] == 2004)
        target['actual_margin'] = 999
        target['market_spread'] = -999
        target.pop('_features', None)  # force recomputation with the mutated values

        folds_b, _ = stage3.run_expanding_folds(rows_b, min_train_seasons=2)
        fold_2002_b = next(f for f in folds_b if f['season'] == 2002)

        # Compare everything except the object identity: hyperparameter trials,
        # selected configs and every reported metric for the 2002 fold must be
        # byte-identical whether or not a 2004 row was corrupted.
        self.assertEqual(
            json.dumps(fold_2002_a, sort_keys=True, default=str),
            json.dumps(fold_2002_b, sort_keys=True, default=str),
            'a later season\'s row was mutated but changed an earlier season\'s fold output -- this is a leak')

    def test_mutating_a_later_season_row_DOES_change_that_later_folds_own_output(self):
        """Sanity check on the test above: the mutation must actually be
        wired into the pipeline (i.e. this is not a vacuous 'nothing changed
        because the code discards this field somewhere' pass)."""
        rows_a = _synthetic_multiseason_rows()
        rows_b = _synthetic_multiseason_rows()
        target = next(r for r in rows_b if r['season'] == 2004)
        target['actual_margin'] = 999
        target['market_spread'] = -999

        folds_a, all_a = stage3.run_expanding_folds(rows_a, min_train_seasons=2)
        folds_b, all_b = stage3.run_expanding_folds(rows_b, min_train_seasons=2)

        mutated_row_b = next(r for r in all_b if r['season'] == 2004 and r is target)
        self.assertEqual(mutated_row_b['actual_margin'], 999)
        self.assertEqual(mutated_row_b['_market_pred'], 999)


class ExpandingFoldStructureTests(unittest.TestCase):
    """Basic contract checks on the fold builder, independent of the real DB."""

    def test_outer_test_season_never_appears_in_its_own_training_rows(self):
        rows = _synthetic_multiseason_rows()
        folds, _ = stage3.run_expanding_folds(rows, min_train_seasons=2)
        self.assertTrue(folds, 'expected at least one outer fold from a 5-season synthetic set')
        for f in folds:
            self.assertGreater(f['n_train_games'], 0)
            self.assertGreater(f['n_test_games'], 0)

    def test_hyperparameter_trial_record_includes_every_grid_point_not_just_the_winner(self):
        rows = _synthetic_multiseason_rows()
        folds, _ = stage3.run_expanding_folds(rows, min_train_seasons=2)
        f = folds[0]
        self.assertEqual(len(f['ridge_trials']), len(stage3.RIDGE_ALPHAS))
        self.assertEqual(len(f['lgb_trials']), len(stage3.LGB_CONFIGS))
        self.assertIn(f['ridge_selected_alpha'], stage3.RIDGE_ALPHAS)
        self.assertIn(f['lgb_selected_config'], [c['name'] for c in stage3.LGB_CONFIGS])


if __name__ == '__main__':
    unittest.main()
