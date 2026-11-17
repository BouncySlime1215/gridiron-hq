"""Inference helpers. Bets inside one game move together, so everything resamples games."""
import numpy as np
import pytest

from kalshi_edge import stats


def test_cluster_bootstrap_of_a_ratio_is_reproducible_and_brackets_the_point_estimate():
    rng = np.random.default_rng(0)
    clusters = np.repeat(np.arange(200), 5)
    stake = np.full(1000, 100.0)
    pnl = rng.normal(2.0, 30.0, 1000)
    a = stats.cluster_bootstrap_ratio(pnl, stake, clusters, n_boot=2000, seed=1)
    b = stats.cluster_bootstrap_ratio(pnl, stake, clusters, n_boot=2000, seed=1)
    assert a == b
    assert a.lo < a.point < a.hi
    assert a.point == pytest.approx(pnl.sum() / stake.sum())
    assert a.n_clusters == 200


def test_clustering_widens_the_interval_when_bets_in_a_game_move_together():
    rng = np.random.default_rng(3)
    game_effect = rng.normal(0, 30, 100)
    clusters = np.repeat(np.arange(100), 10)
    pnl = game_effect[clusters] + rng.normal(0, 1, 1000)     # almost perfectly correlated within a game
    stake = np.full(1000, 100.0)
    by_game = stats.cluster_bootstrap_ratio(pnl, stake, clusters, n_boot=2000, seed=1)
    by_bet = stats.cluster_bootstrap_ratio(pnl, stake, np.arange(1000), n_boot=2000, seed=1)
    assert (by_game.hi - by_game.lo) > 2.5 * (by_bet.hi - by_bet.lo)


def test_one_sided_p_value_counts_draws_at_or_below_zero():
    clusters = np.arange(50)
    stake = np.full(50, 100.0)
    always_up = stats.cluster_bootstrap_ratio(np.full(50, 5.0), stake, clusters, n_boot=500, seed=1)
    assert always_up.p_le_zero == pytest.approx(1 / 501)     # add-one: never exactly zero
    coin = stats.cluster_bootstrap_ratio(np.r_[np.full(25, 5.0), np.full(25, -5.0)], stake, clusters, n_boot=4000, seed=1)
    assert 0.35 < coin.p_le_zero < 0.65


def test_bootstrap_needs_more_than_one_cluster():
    with pytest.raises(ValueError):
        stats.cluster_bootstrap_ratio(np.ones(5), np.ones(5), np.zeros(5), n_boot=10)


def test_calibration_slope_recovers_a_known_favourite_longshot_bias():
    rng = np.random.default_rng(7)
    n = 60000
    p0 = rng.uniform(0.03, 0.97, n)
    true_logit = 1.15 * np.log(p0 / (1 - p0))          # favourites win more often than priced
    y = (rng.uniform(size=n) < 1 / (1 + np.exp(-true_logit))).astype(float)
    fit = stats.calibration_slope(y, p0, clusters=np.arange(n))
    assert fit.slope == pytest.approx(1.15, abs=0.03)
    assert fit.intercept == pytest.approx(0.0, abs=0.03)
    assert fit.p_slope_gt_1 < 1e-6
    fair_y = (rng.uniform(size=n) < p0).astype(float)
    fair = stats.calibration_slope(fair_y, p0, clusters=np.arange(n))
    assert fair.slope == pytest.approx(1.0, abs=0.03)
    assert fair.p_slope_gt_1 > 0.01


def test_holm_adjusts_in_order_and_is_monotone():
    adj = stats.holm([0.01, 0.04, 0.03, 0.20])
    assert adj == pytest.approx([0.04, 0.09, 0.09, 0.20])
    assert stats.holm([0.5]) == pytest.approx([0.5])
    assert max(stats.holm([0.9, 0.9, 0.9])) <= 1.0
