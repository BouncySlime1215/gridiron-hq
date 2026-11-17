"""Does a group's net buying predict where the price goes next?

Each in-game minute has, for integer-count orders, retail dollar-buys and other
fractional orders, net buying as a signed share of the minute's taker dollars. The
question is what the price does afterwards.

How the price is measured decides the answer. A minute's average trade price sits near
the ask when takers were buying and near the bid when they were selling, so comparing it
with the next minute's average makes any net buying look like it was followed by a fall.
That is bid-ask bounce, not information. Use the change in the quote midpoint (d_mid);
the average-price change (d_vwap) is kept only because the study registered it first.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

GROUPS = ("in_s", "rb_s", "fx_s")
MIN_ROWS = 100


def minute_sql(parquet_glob: str, lo: str, hi: str, max_spread: float = 0.03) -> str:
    """SQL for the regression frame over games starting in [lo, hi).

    Keeps minutes priced 15c-85c with at least $200 traded and a two-sided quote (last
    YES-taker and NO-taker prints no more than `max_spread` apart) both now and at the
    two later points the midpoint change is measured to.
    """
    return f"""
    with b as (
      select ticker, milestone_id, bucket, vwap, dollars, ask_last, bid_last,
             usd_in_yes - usd_in_no as in_net, usd_rb_yes - usd_rb_no as rb_net, usd_fx_yes - usd_fx_no as fx_net,
             lead(vwap, 1) over w as v1, lead(bucket, 1) over w as b1,
             lead(ask_last, 1) over w as a1, lead(bid_last, 1) over w as bd1,
             lead(ask_last, 5) over w as a5, lead(bid_last, 5) over w as bd5, lead(bucket, 5) over w as b5,
             lag(vwap, 1) over w as vm1
      from read_parquet('{parquet_glob}')
      where t_start >= timestamptz '{lo}' and t_start < timestamptz '{hi}'
      window w as (partition by ticker order by bucket))
    select milestone_id, v1 - vwap as d_vwap,
           (a1 + bd1) / 2 - (ask_last + bid_last) / 2 as d_mid,
           (a5 + bd5) / 2 - (ask_last + bid_last) / 2 as d_mid5,
           vwap - vm1 as dm1, in_net / dollars as in_s, rb_net / dollars as rb_s, fx_net / dollars as fx_s
    from b
    where vwap between 0.15 and 0.85 and dollars >= 200 and vm1 is not null
      and ask_last is not null and bid_last is not null and ask_last - bid_last between 0 and {max_spread}
      and a1 is not null and bd1 is not null and a1 - bd1 between 0 and {max_spread} and date_diff('minute', bucket, b1) <= 2
      and a5 is not null and bd5 is not null and a5 - bd5 between 0 and {max_spread} and date_diff('minute', bucket, b5) <= 8
    """


def fit(df: pd.DataFrame, target: str) -> dict:
    """Regress the later price change (in cents) on each group's signed flow share, clustered by game.

    Controls for the minute's own price change (dm1). Returns, per group, the coefficient
    in cents per unit of flow share (one unit = the group was the whole minute, all one way).
    """
    import statsmodels.api as sm

    if len(df) < MIN_ROWS:
        raise ValueError(f"only {len(df)} minutes: too few to fit")
    X = sm.add_constant(df[list(GROUPS) + ["dm1"]].astype(float))
    groups = pd.factorize(df.milestone_id)[0]
    r = sm.OLS((df[target] * 100.0).astype(float), X).fit(cov_type="cluster", cov_kwds={"groups": groups})
    out = {k: {"coef_cents": float(r.params[k]), "se": float(r.bse[k]), "t": float(r.tvalues[k])} for k in GROUPS}
    out.update(minutes=int(len(df)), games=int(np.max(groups)) + 1)
    return out
