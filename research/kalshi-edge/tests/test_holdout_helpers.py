"""Characterisation tests for the helpers in scripts/run_holdout.py that back headline numbers.

Written AFTER the holdout run (so not RED/GREEN): flow_gap computes the pre-registered A1
test and ingame_calibration the S12 table, and neither had a test of its own when they
ran. These pin what they compute. Had one failed, the holdout numbers would have needed
re-running under a new ledger row.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import run_holdout as rh  # noqa: E402


def games(rows):
    return pd.DataFrame(rows, columns=["milestone_id", "kind", "dollars", "payout"])


def test_flow_gap_is_the_difference_of_two_dollar_weighted_returns():
    g = games([("g1", "IN", 100.0, 110.0), ("g1", "RB", 100.0, 90.0),
               ("g2", "IN", 300.0, 300.0), ("g2", "RB", 100.0, 100.0)])
    r = rh.flow_gap(g, "IN", "RB", n_boot=400)
    assert r["ret_IN"] == pytest.approx(10.0 / 400.0)          # (110-100 + 300-300) / (100+300)
    assert r["ret_RB"] == pytest.approx(-10.0 / 200.0)
    assert r["gap"] == pytest.approx(0.025 + 0.05)
    assert r["games"] == 2 and r["dollars_IN"] == pytest.approx(400.0)


def test_flow_gap_is_zero_when_both_kinds_earn_the_same_in_every_game():
    g = games([(f"g{i}", k, 100.0, 100.0 + i) for i in range(30) for k in ("IN", "RB")])
    r = rh.flow_gap(g, "IN", "RB", n_boot=400)
    assert r["gap"] == pytest.approx(0.0, abs=1e-12)
    assert r["lo"] == pytest.approx(0.0, abs=1e-9) and r["hi"] == pytest.approx(0.0, abs=1e-9)
    assert r["p_one_sided"] == pytest.approx(1.0)              # every draw is <= 0: no evidence of a positive gap


def test_flow_gap_p_value_is_small_only_when_the_gap_is_consistent_across_games():
    rng = np.random.default_rng(2)
    rows = []
    for i in range(400):
        rows += [(f"g{i}", "IN", 100.0, 100.0 + rng.normal(2.0, 10.0)), (f"g{i}", "RB", 100.0, 100.0 + rng.normal(-2.0, 10.0))]
    strong = rh.flow_gap(games(rows), "IN", "RB", n_boot=2000)
    assert strong["gap"] > 0.02 and strong["lo"] > 0 and strong["p_one_sided"] < 0.01
    one_game = [("big", "IN", 1e6, 1.5e6), ("big", "RB", 1e6, 0.5e6)] + [(f"g{i}", k, 100.0, 100.0) for i in range(50) for k in ("IN", "RB")]
    lumpy = rh.flow_gap(games(one_game), "IN", "RB", n_boot=2000)
    assert lumpy["gap"] > 0.5                                   # a huge point estimate...
    assert lumpy["p_one_sided"] > 0.2                           # ...from one game is not evidence: resampling games exposes it


def test_flow_gap_treats_a_game_missing_one_kind_as_zero_dollars_of_it():
    g = games([("g1", "IN", 100.0, 120.0), ("g2", "RB", 100.0, 80.0), ("g2", "IN", 100.0, 100.0), ("g1", "RB", 50.0, 50.0)])
    r = rh.flow_gap(g, "IN", "RB", n_boot=200)
    assert r["ret_IN"] == pytest.approx(20.0 / 200.0) and r["ret_RB"] == pytest.approx(-20.0 / 150.0)


def test_ingame_calibration_uses_the_mid_of_both_prints_and_clusters_by_game():
    rows = []
    for g in range(40):                                          # 40 games, favourite at 96/97, wins 39 of 40
        for m in range(5):
            rows.append({"milestone_id": f"g{g}", "ask_last": 0.97, "bid_last": 0.96, "y": 0.0 if g == 0 else 1.0})
    rows.append({"milestone_id": "wide", "ask_last": 0.99, "bid_last": 0.90, "y": 0.0})      # 9c spread: excluded
    rows.append({"milestone_id": "onesided", "ask_last": 0.99, "bid_last": np.nan, "y": 0.0})  # no bid print: excluded
    out = rh.ingame_calibration(pd.DataFrame(rows))["mid>=0.95"]
    assert out["minutes"] == 200 and out["games"] == 40
    assert out["mean_price"] == pytest.approx(0.965) and out["win_rate"] == pytest.approx(39 / 40)
    assert out["resid_cents"] == pytest.approx(100 * (39 / 40 - 0.965))
    # five identical minutes per game carry one game's worth of information: the standard error must reflect 40 games, not 200 minutes
    per_minute_se = 100 * np.sqrt((39 / 40) * (1 / 40) / 200)
    assert out["se_cents"] > 1.8 * per_minute_se


def test_summ_reports_return_on_capital_and_needs_two_games():
    e = pd.DataFrame({"milestone_id": ["a", "b", "c", "d"], "pnl": [5.0, 5.0, -90.0, 5.0], "cost": [95.0] * 4, "price": [0.95] * 4})
    s = rh.summ(e, n_boot=500)
    assert s["positions"] == 4 and s["games"] == 4 and s["roi"] == pytest.approx(-75.0 / 380.0)
    assert s["win_rate"] == pytest.approx(0.75) and s["lo"] <= s["roi"] <= s["hi"]
    assert rh.summ(e.iloc[:1]) == {"positions": 1}
