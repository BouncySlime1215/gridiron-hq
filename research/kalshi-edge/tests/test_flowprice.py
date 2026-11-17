"""Does a group's net buying predict where the price goes next? And the trap in measuring it.

A minute's average trade price sits near the ask when takers were buying and near the bid
when they were selling. Compare it with the next minute's average and any net buying looks
like it was "followed by a fall", with no information in it at all. That is bid-ask bounce.
The first version of this study's S13 table made exactly that mistake for retail flow.
Quote midpoints do not have the problem; these tests pin both facts.
"""
import numpy as np
import pandas as pd
import pytest

from kalshi_edge import flowprice


def minutes(n=40000, half_spread=0.005, inform_in=0.0, inform_rb=0.0, seed=0):
    """Simulated minutes: three groups trade against a book with a fixed half spread.

    The true midpoint moves next minute by inform_in * (integer net share) + inform_rb * (retail net share) + noise.
    """
    rng = np.random.default_rng(seed)
    g = rng.integers(0, n // 20, n)
    in_s, rb_s, fx_s = (rng.uniform(-0.4, 0.4, n) for _ in range(3))
    net = in_s + rb_s + fx_s                                   # share of the minute's dollars that was net buying
    mid = rng.uniform(0.3, 0.7, n)
    d_mid = inform_in * in_s + inform_rb * rb_s + rng.normal(0, 0.004, n)
    vwap = mid + half_spread * net                             # buying prints at the ask, selling at the bid
    nxt_net = rng.uniform(-1, 1, n) * 0.5
    vwap_next = mid + d_mid + half_spread * nxt_net
    return pd.DataFrame({"milestone_id": g, "in_s": in_s, "rb_s": rb_s, "fx_s": fx_s, "dm1": rng.normal(0, 0.004, n),
                         "d_vwap": vwap_next - vwap, "d_mid": d_mid})


def test_bounce_alone_makes_average_trade_prices_look_like_reversal():
    f = flowprice.fit(minutes(), "d_vwap")
    for k in ("in_s", "rb_s", "fx_s"):                         # no group is informed, yet every coefficient is clearly negative
        assert f[k]["coef_cents"] == pytest.approx(-0.5, abs=0.05)
        assert f[k]["t"] < -20


def test_midpoints_report_nothing_when_there_is_nothing():
    f = flowprice.fit(minutes(), "d_mid")
    for k in ("in_s", "rb_s", "fx_s"):
        assert abs(f[k]["coef_cents"]) < 0.03 and abs(f[k]["t"]) < 3.5


def test_midpoints_recover_which_group_is_informed_and_by_how_much():
    f = flowprice.fit(minutes(inform_in=0.003), "d_mid")       # integer net buying moves the true price 0.3c per unit
    assert f["in_s"]["coef_cents"] == pytest.approx(0.30, abs=0.03) and f["in_s"]["t"] > 15
    assert abs(f["rb_s"]["coef_cents"]) < 0.03
    # the average-price measure gets the informed group's sign wrong here: 0.3c of information minus 0.5c of bounce
    assert flowprice.fit(minutes(inform_in=0.003), "d_vwap")["in_s"]["coef_cents"] < 0


def test_fit_reports_sample_size_and_clusters_by_game():
    d = minutes(n=4000)
    f = flowprice.fit(d, "d_mid")
    assert f["minutes"] == 4000 and f["games"] == d.milestone_id.nunique()
    with pytest.raises(ValueError):
        flowprice.fit(d.iloc[:50], "d_mid")
