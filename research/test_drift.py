"""Tests for research/drift.py, the distributional-drift scan.

research/test_tree_lab.py proves the leakage scanner by injecting a synthetic
leak and asserting it is caught. This file holds the drift scan to the same
bar, and to one more that matters just as much for a check that runs
automatically on every chronological fold:

  1. A synthetic, deliberately injected BREAK is flagged -- a feature whose
     source changed scale, and an availability feed that went dark.
  2. A synthetic ORDINARY season-over-season shift is NOT flagged. This is the
     harder and more important direction. NFL feature distributions move every
     season; a check that fires on every season boundary is worse than no
     check, because it trains its reader to ignore it.
  3. The calibration is real, not asserted: the analytic sampling-noise
     reference this module uses INSTEAD of PSI's conventional 0.1/0.25
     thresholds is checked against an empirical null built by resampling from
     a single distribution.
  4. Market features and modelling features are treated differently -- an
     identical shift is a `market_regime_shift` on a priced column and an
     `abnormal` on a modelling column.
  5. The joint check catches a change that leaves every marginal intact, which
     is the failure mode PSI structurally cannot see.

Pure synthetic data throughout; nothing here touches the live database, in the
same spirit as research/test_market_lab.py and research/test_tree_lab.py.

Run from research/:  python -m unittest test_drift
"""
import unittest
import numpy as np

from drift import (DRIFT_VERSION, classify_feature_role, choose_bins,
                   population_stability_index, psi_noise_reference, normalized_wasserstein,
                   season_boundary_reference, joint_drift_classifier, detect_distribution_drift)


# The feature set is shaped like tree_lab.py's real one: a few priced/market
# columns, a spread of team-week modelling columns, and the `*_available`
# missingness flag this project attaches to every lagged input.
MARKET_FEATURES = ['opening_line', 'opening_overround', 'near_key_three', 'hours_to_kickoff']
MODEL_FEATURES = [f'home_off_epa_per_play_{i}' for i in range(12)] + \
                 [f'away_def_success_rate_{i}' for i in range(12)]
AVAIL_FEATURES = ['home_off_epa_per_play_available', 'away_pbp_age_days']
FEATURES = MARKET_FEATURES + MODEL_FEATURES + AVAIL_FEATURES


def season_matrix(n, seed, *, drift_scale=0.0, market_shift=0.0, rng=None):
    """One synthetic season.

    `drift_scale` is the ORDINARY league movement: every modelling column's
    mean nudges a little, the way real NFL aggregates move between seasons as
    pace and scoring change. `market_shift` moves the priced columns only.
    """
    rng = rng or np.random.default_rng(seed)
    cols = {}
    cols['opening_line'] = rng.normal(0 + market_shift, 5.5, n)
    cols['opening_overround'] = rng.normal(0.045 + market_shift * 0.001, 0.008, n)
    cols['near_key_three'] = np.abs(rng.normal(2.5 + market_shift * 0.2, 1.6, n))
    cols['hours_to_kickoff'] = rng.uniform(24, 120, n)
    for i in range(12):
        cols[f'home_off_epa_per_play_{i}'] = rng.normal(0.02 + drift_scale * 0.03, 0.11, n)
        cols[f'away_def_success_rate_{i}'] = rng.normal(0.44 + drift_scale * 0.006, 0.05, n)
    cols['home_off_epa_per_play_available'] = (rng.random(n) < 0.93).astype(float)
    cols['away_pbp_age_days'] = np.abs(rng.normal(8.5, 2.0, n))
    return np.column_stack([cols[f] for f in FEATURES])


def training_window(per_season=240, seasons=(2022, 2023, 2024), seed=5):
    """A multi-season training window with ordinary league movement in it.

    This is what supplies the empirical season-boundary reference: the scan
    learns "this is how much a feature of this role normally moves" from these
    seasons, rather than importing a credit-scoring constant.
    """
    rng = np.random.default_rng(seed)
    blocks, season_labels, groups = [], [], []
    for offset, season in enumerate(seasons):
        blocks.append(season_matrix(per_season, seed + offset, drift_scale=offset, rng=rng))
        season_labels += [season] * per_season
        groups += [f'{season}-w{1 + (i // 16)}' for i in range(per_season)]
    return np.vstack(blocks), np.array(season_labels), groups


def scoring_window(n=250, *, drift_scale=3.0, seed=99, season=2025, rng=None):
    rng = rng or np.random.default_rng(seed)
    X = season_matrix(n, seed, drift_scale=drift_scale, rng=rng)
    groups = [f'{season}-w{1 + (i // 16)}' for i in range(n)]
    return X, groups


def verdict_of(report, feature):
    return next(f['verdict'] for f in report['features'] if f['feature'] == feature)


class CalibrationTests(unittest.TestCase):
    """The reason this module does not use PSI's conventional thresholds."""

    def test_analytic_noise_reference_matches_an_empirical_null(self):
        # Draw both windows from the SAME distribution many times. If the
        # analytic reference is right, the empirical 95th percentile of PSI
        # should land close to it. If it is wrong, every verdict built on it is
        # wrong too, so this is the load-bearing test in the file.
        rng = np.random.default_rng(4242)
        n_train, n_score, bins = 474, 250, 10
        observed = [population_stability_index(rng.normal(0, 1, n_train),
                                               rng.normal(0, 1, n_score), bins)
                    for _ in range(400)]
        empirical_p95 = float(np.percentile(observed, 95))
        analytic = psi_noise_reference(n_train, n_score, bins)
        self.assertAlmostEqual(empirical_p95, analytic['p95_under_no_drift'], delta=0.03)
        self.assertAlmostEqual(float(np.mean(observed)), analytic['expected_under_no_drift'], delta=0.015)

    def test_conventional_psi_threshold_would_fire_on_undrifted_data(self):
        # The concrete claim the module docstring makes, asserted rather than
        # argued: at this project's fold sizes, PSI > 0.1 is NOT evidence of
        # drift -- it happens routinely with no drift present at all.
        rng = np.random.default_rng(77)
        n_train, n_score = 474, 250
        observed = [population_stability_index(rng.normal(0, 1, n_train),
                                               rng.normal(0, 1, n_score), 10)
                    for _ in range(300)]
        false_alarm_rate = float(np.mean(np.array(observed) > 0.1))
        self.assertGreater(false_alarm_rate, 0.03,
                           'if this ever drops to ~0 the sample sizes changed and the module '
                           'docstring\'s rejection of the 0.1 threshold needs recomputing')

    def test_bin_count_shrinks_with_the_smaller_window(self):
        self.assertEqual(choose_bins(1000, 900, 10), 10)
        self.assertEqual(choose_bins(1000, 120, 10), 6)
        self.assertEqual(choose_bins(1000, 40, 10), 5)   # never below the floor


class StatisticTests(unittest.TestCase):
    def test_psi_is_near_zero_for_identical_populations_and_grows_with_separation(self):
        rng = np.random.default_rng(3)
        a = rng.normal(0, 1, 4000)
        same = population_stability_index(a, rng.normal(0, 1, 4000), 10)
        moved = population_stability_index(a, rng.normal(1.5, 1, 4000), 10)
        self.assertLess(same, 0.02)
        self.assertGreater(moved, same * 10)

    def test_binary_columns_use_exact_proportions_not_quantile_bins(self):
        a = np.r_[np.ones(950), np.zeros(50)]
        b = np.r_[np.ones(500), np.zeros(500)]
        value = population_stability_index(a, b, 10, binary=True)
        self.assertIsNotNone(value)
        self.assertGreater(value, 0.5)

    def test_normalized_wasserstein_is_in_units_of_the_training_spread(self):
        rng = np.random.default_rng(9)
        a = rng.normal(0, 1, 5000)
        b = a + 1.0
        # A shift of one SD on a standard normal is ~0.74 IQR.
        self.assertAlmostEqual(normalized_wasserstein(a, b), 1.0 / 1.349, delta=0.08)
        self.assertIsNone(normalized_wasserstein(np.ones(100), np.ones(100)),
                          'a constant reference column has no spread to express a shift in')

    def test_feature_roles_put_missingness_flags_before_market_words(self):
        self.assertEqual(classify_feature_role('opening_line'), 'market')
        self.assertEqual(classify_feature_role('opening_overround'), 'market')
        self.assertEqual(classify_feature_role('near_key_seven'), 'market')
        # A flag ABOUT a market quantity is still a statement about our
        # pipeline, not about the market.
        self.assertEqual(classify_feature_role('opening_overround_available'), 'availability')
        self.assertEqual(classify_feature_role('home_pbp_age_days'), 'availability')
        self.assertEqual(classify_feature_role('home_off_epa_per_play'), 'model')
        self.assertEqual(classify_feature_role('int_pace_x_pass_catchers'), 'model')


class NormalSeasonShiftTests(unittest.TestCase):
    """The direction that decides whether this check is usable at all."""

    def test_ordinary_season_over_season_movement_is_not_flagged(self):
        Xa, seasons, groups_a = training_window()
        Xb, groups_b = scoring_window(drift_scale=3.0)
        report = detect_distribution_drift(Xa, Xb, FEATURES, train_seasons=seasons,
                                           score_season=2025, train_groups=groups_a,
                                           score_groups=groups_b, permutations=6, random_state=1)
        self.assertFalse(report['skipped'], report.get('reason'))
        self.assertEqual(report['flagged'], [],
                         'a routine NFL season boundary must not raise a break alarm; a check that '
                         'fires every September is a check nobody will read')
        self.assertFalse(report['calibration_weak'])
        self.assertEqual(report['league_reference']['model']['source'], 'historical_season_pairs')

    def test_a_single_season_training_window_reports_weak_calibration(self):
        # The earliest walk-forward fold has one training season and therefore
        # no season boundary to calibrate against. It must say so rather than
        # borrow confidence it does not have.
        Xa, seasons, groups_a = training_window(per_season=240, seasons=(2022,), seed=5)
        Xb, groups_b = scoring_window(drift_scale=2.0)
        report = detect_distribution_drift(Xa, Xb, FEATURES, train_seasons=seasons,
                                           score_season=2023, train_groups=groups_a,
                                           score_groups=groups_b, permutations=4, random_state=1)
        self.assertTrue(report['calibration_weak'])
        self.assertIn('WEAK', report['summary'])
        self.assertTrue(report['league_reference']['model']['weak'])


class InjectedDriftTests(unittest.TestCase):
    """The leakage scanner's synthetic-leak proof, for drift."""

    def test_injected_source_change_is_flagged_while_its_neighbours_are_not(self):
        Xa, seasons, groups_a = training_window()
        Xb, groups_b = scoring_window(drift_scale=3.0)
        # A provider changes a stat's definition: same column name, different
        # scale and centre. This is the realistic version of the failure --
        # not a missing column (which would crash loudly) but a column that
        # still arrives, still looks numeric, and no longer means what the
        # fitted model learned it meant.
        broken = FEATURES.index('home_off_epa_per_play_0')
        Xb = Xb.copy()
        Xb[:, broken] = Xb[:, broken] * 4.0 + 0.9
        report = detect_distribution_drift(Xa, Xb, FEATURES, train_seasons=seasons,
                                           score_season=2025, train_groups=groups_a,
                                           score_groups=groups_b, permutations=6, random_state=2)
        self.assertIn('home_off_epa_per_play_0', report['flagged'])
        self.assertEqual(verdict_of(report, 'home_off_epa_per_play_0'), 'abnormal')
        # Its untouched siblings, which moved by exactly the ordinary league
        # amount, stay quiet. A scan that flags the whole feature family when
        # one column breaks has not localized anything.
        for sibling in ['home_off_epa_per_play_1', 'home_off_epa_per_play_2', 'away_def_success_rate_0']:
            self.assertNotIn(sibling, report['flagged'])

    def test_a_dark_availability_feed_is_escalated_on_the_rate_itself(self):
        Xa, seasons, groups_a = training_window()
        Xb, groups_b = scoring_window(drift_scale=3.0)
        Xb = Xb.copy()
        col = FEATURES.index('home_off_epa_per_play_available')
        Xb[:, col] = 0.0   # the feed stopped reporting entirely
        report = detect_distribution_drift(Xa, Xb, FEATURES, train_seasons=seasons,
                                           score_season=2025, train_groups=groups_a,
                                           score_groups=groups_b, permutations=6, random_state=3)
        self.assertEqual(verdict_of(report, 'home_off_epa_per_play_available'), 'feed_break_suspected')
        self.assertIn('home_off_epa_per_play_available', report['flagged'])

    def test_a_small_availability_wobble_is_not_a_feed_break(self):
        Xa, seasons, groups_a = training_window()
        Xb, groups_b = scoring_window(drift_scale=3.0)
        Xb = Xb.copy()
        col = FEATURES.index('home_off_epa_per_play_available')
        rng = np.random.default_rng(17)
        Xb[:, col] = (rng.random(Xb.shape[0]) < 0.89).astype(float)   # 93% -> 89%
        report = detect_distribution_drift(Xa, Xb, FEATURES, train_seasons=seasons,
                                           score_season=2025, train_groups=groups_a,
                                           score_groups=groups_b, permutations=4, random_state=4)
        self.assertNotEqual(verdict_of(report, 'home_off_epa_per_play_available'), 'feed_break_suspected')


class RoleTreatmentTests(unittest.TestCase):
    def test_the_same_shift_is_a_regime_shift_on_a_price_and_a_break_on_a_feature(self):
        Xa, seasons, groups_a = training_window()
        Xb, groups_b = scoring_window(drift_scale=3.0)
        Xb = Xb.copy()
        market_col = FEATURES.index('opening_line')
        model_col = FEATURES.index('away_def_success_rate_0')
        # Standardize both columns, apply the identical standardized shift, and
        # put them back -- so the two features genuinely receive the same
        # distributional change and only their ROLE differs.
        for col in (market_col, model_col):
            sd = Xa[:, col].std()
            Xb[:, col] = Xb[:, col] + 1.8 * sd
        report = detect_distribution_drift(Xa, Xb, FEATURES, train_seasons=seasons,
                                           score_season=2025, train_groups=groups_a,
                                           score_groups=groups_b, permutations=6, random_state=5)
        self.assertEqual(verdict_of(report, 'opening_line'), 'market_regime_shift')
        self.assertEqual(verdict_of(report, 'away_def_success_rate_0'), 'abnormal')
        self.assertIn('away_def_success_rate_0', report['flagged'])
        self.assertNotIn('opening_line', report['flagged'],
                         'a repricing market is information; it must never be reported as a fault')
        self.assertIn('opening_line', report['market_regime_shifts'])


class JointCheckTests(unittest.TestCase):
    """PSI's structural blind spot, and the check that covers it."""

    def test_a_marginal_preserving_change_is_invisible_to_psi_and_caught_jointly(self):
        rng = np.random.default_rng(21)
        n_a, n_b = 720, 250
        names = ['a', 'b']
        # Training window: two strongly correlated columns.
        za = rng.normal(0, 1, n_a)
        Xa = np.column_stack([za, 0.9 * za + rng.normal(0, 0.44, n_a)])
        # Scoring window: identical marginals (same means, same SDs) with the
        # correlation destroyed -- exactly what a changed join or a re-keyed
        # provider table looks like from the outside.
        Xb = np.column_stack([rng.normal(0, 1, n_b), rng.normal(0, 1, n_b)])
        for i in range(2):
            Xb[:, i] = (Xb[:, i] - Xb[:, i].mean()) / Xb[:, i].std() * Xa[:, i].std() + Xa[:, i].mean()
        for i in range(2):
            psi = population_stability_index(Xa[:, i], Xb[:, i], 10)
            self.assertLess(psi, 0.05, 'the marginals are meant to be indistinguishable by construction')
        groups_a = [f'a{i // 16}' for i in range(n_a)]
        groups_b = [f'b{i // 16}' for i in range(n_b)]
        joint = joint_drift_classifier(Xa, Xb, names, groups_train=groups_a, groups_score=groups_b,
                                       permutations=6, random_state=6)
        self.assertFalse(joint['skipped'], joint.get('reason'))
        self.assertGreater(joint['auc'], joint['permutation_null_p95'])
        self.assertEqual(joint['verdict'], 'windows_distinguishable')

        # Why the domain classifier is a tree ensemble and not a logistic
        # regression, pinned as a test rather than left as a comment: on this
        # exact case a linear boundary is at chance, because a correlation
        # change is a second-order property with no first-order signature.
        # If someone "simplifies" drift.py back to a linear model, this fails.
        from sklearn.linear_model import LogisticRegression
        from sklearn.model_selection import GroupKFold
        from sklearn.metrics import roc_auc_score
        X = np.vstack([Xa, Xb])
        X = (X - X.mean(axis=0)) / X.std(axis=0)
        y = np.r_[np.zeros(n_a), np.ones(n_b)]
        groups = np.array(groups_a + groups_b, dtype=object)
        oof = np.zeros(len(y))
        for tr, va in GroupKFold(n_splits=3).split(X, y, groups):
            oof[va] = LogisticRegression(C=0.1, max_iter=400).fit(X[tr], y[tr]).predict_proba(X[va])[:, 1]
        self.assertLess(roc_auc_score(y, oof), joint['auc'],
                        'a linear domain classifier must NOT be able to see this change; if it can, '
                        'the synthetic case no longer tests what it claims to test')

    def test_two_samples_of_one_population_are_called_indistinguishable(self):
        rng = np.random.default_rng(31)
        Xa = rng.normal(0, 1, (720, 6))
        Xb = rng.normal(0, 1, (250, 6))
        joint = joint_drift_classifier(Xa, Xb, [f'f{i}' for i in range(6)],
                                       groups_train=[f'a{i // 16}' for i in range(720)],
                                       groups_score=[f'b{i // 16}' for i in range(250)],
                                       permutations=8, random_state=7)
        self.assertFalse(joint['skipped'], joint.get('reason'))
        self.assertIn(joint['verdict'], ('windows_indistinguishable', 'windows_weakly_distinguishable'))


class ReportShapeTests(unittest.TestCase):
    def test_report_is_json_safe_and_never_refuses_to_fit(self):
        import json
        Xa, seasons, groups_a = training_window()
        Xb, groups_b = scoring_window(drift_scale=3.0)
        Xb = Xb.copy()
        Xb[:, FEATURES.index('home_off_epa_per_play_0')] *= 6.0
        report = detect_distribution_drift(Xa, Xb, FEATURES, train_seasons=seasons,
                                           score_season=2025, train_groups=groups_a,
                                           score_groups=groups_b, permutations=4,
                                           random_state=8, label='spreads/2025')
        self.assertEqual(report['version'], DRIFT_VERSION)
        self.assertEqual(report['label'], 'spreads/2025')
        # The whole contract: it reports, it does not halt. There is no
        # "should_not_fit" key and no exception path for a drifted feature.
        self.assertIn('Reported only.', report['summary'])
        self.assertNotIn('halt', json.dumps(report).lower())
        json.dumps(report)   # must survive the manifest writer unchanged

    def test_binning_sensitivity_is_reported_rather_than_hidden(self):
        Xa, seasons, groups_a = training_window()
        Xb, groups_b = scoring_window(drift_scale=3.0)
        report = detect_distribution_drift(Xa, Xb, FEATURES, train_seasons=seasons,
                                           score_season=2025, train_groups=groups_a,
                                           score_groups=groups_b, run_joint=False)
        continuous = next(f for f in report['features'] if f['feature'] == 'opening_line')
        self.assertEqual(set(continuous['psi_by_bin_count']), {'5', '10', '20'})
        self.assertIsNotNone(continuous['psi_binning_spread'])
        self.assertGreaterEqual(continuous['psi_binning_spread'], 0.0)

    def test_too_few_rows_is_a_recorded_skip_not_a_crash(self):
        report = detect_distribution_drift(np.zeros((5, 3)), np.zeros((5, 3)), ['a', 'b', 'c'])
        self.assertTrue(report['skipped'])
        self.assertIn('fewer than', report['reason'])

    def test_season_boundary_reference_falls_back_when_there_is_no_boundary(self):
        Xa, seasons, _ = training_window(per_season=240, seasons=(2022,), seed=5)
        roles = {n: classify_feature_role(n) for n in FEATURES}
        ref = season_boundary_reference(Xa, seasons, FEATURES, roles, 10)
        self.assertEqual(ref['model']['source'], 'noise_floor_fallback')
        self.assertTrue(ref['model']['weak'])


if __name__ == '__main__':
    unittest.main()
