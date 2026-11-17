"""Features may only read what was knowable at the decision time."""
import numpy as np
import pandas as pd
import pytest

from kalshi_edge import features


def frame(n=6, **over):
    base = dict(
        p0=np.linspace(0.2, 0.8, n), ask0=np.linspace(0.21, 0.81, n), bid0=np.linspace(0.19, 0.79, n),
        usd=np.full(n, 1000.0), usd_60=np.full(n, 100.0), period=[False] * n,
        usd_rb_yes=np.full(n, 300.0), usd_rb_no=np.full(n, 100.0), usd_inl_yes=np.full(n, 50.0), usd_inl_no=np.full(n, 150.0),
        usd_fx_yes=np.full(n, 10.0), usd_fx_no=np.full(n, 20.0), usd_ins_yes=np.full(n, 5.0), usd_ins_no=np.full(n, 5.0),
        usd_rb_yes_60=np.full(n, 30.0), usd_rb_no_60=np.full(n, 10.0), usd_inl_yes_60=np.zeros(n), usd_inl_no_60=np.zeros(n),
        p_m60=np.linspace(0.2, 0.8, n) - 0.02, p_m360=[np.nan] * n, p_m1440=[np.nan] * n,
        n_rb_yes=np.full(n, 30), n_rb_no=np.full(n, 10),
        event_ticker=[f"E{i // 2}" for i in range(n)], family=["winner"] * n, sport=["basketball"] * n,
    )
    base.update(over)
    return pd.DataFrame(base)


def test_pressure_terms_are_signed_shares_of_all_taker_dollars():
    f = features.build(frame())
    assert f.rp.iloc[0] == pytest.approx((300 - 100) / 1000)
    assert f.lp.iloc[0] == pytest.approx((50 - 150) / 1000)
    assert f.retail_share.iloc[0] == pytest.approx(0.4)
    assert f.mom_60.iloc[0] == pytest.approx(0.02)
    assert f.mom_360.iloc[0] == 0.0 and f.mom_360_na.iloc[0] == 1.0


def test_market_with_no_flow_gets_zero_pressure_not_nan():
    f = features.build(frame(usd=np.zeros(6), usd_60=np.zeros(6)))
    assert not f.isna().any().any()
    assert (f.rp == 0).all() and (f.retail_share == 0).all()


def test_retail_overweight_compares_retail_dollar_share_with_price_share_inside_the_event():
    df = frame(n=2, p0=np.array([0.7, 0.3]), ask0=np.array([0.71, 0.31]), bid0=np.array([0.69, 0.29]),
               usd_rb_yes=np.array([900.0, 100.0]), event_ticker=["E", "E"])
    f = features.build(df)
    assert f.retail_overweight.tolist() == pytest.approx([0.9 - 0.7, 0.1 - 0.3])
    assert f.ev_overround.tolist() == pytest.approx([0.0, 0.0])
    solo = features.build(frame(n=1, event_ticker=["S"]))
    assert solo.retail_overweight.iloc[0] == 0.0          # nothing to compare with


def test_features_do_not_depend_on_anything_after_the_decision():
    df = frame()
    a = features.build(df)
    later = df.assign(y=1.0, w_high=0.99, w_low=0.01, w_close=0.5, e1_ask=0.9, e2_ask=0.9, e1_bid=0.1, e2_bid=0.1, result="yes")
    b = features.build(later)
    pd.testing.assert_frame_equal(a, b)
    assert not [c for c in a.columns if c.startswith(("w_", "e1_", "e2_")) or c in ("y", "result")]


def test_linear_feature_lists_exist_in_the_built_frame():
    f = features.build(frame())
    assert set(features.LINEAR_BASE) <= set(f.columns)
    assert set(features.LINEAR_FLOW) <= set(f.columns)
