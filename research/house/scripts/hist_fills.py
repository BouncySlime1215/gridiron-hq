"""History step B: what did fills cost the makers in rewarded windows, next to the reward they were paid?

For every trade inside a paid reward window, in a market whose settlement is known:
  taker bought YES at p -> the maker sold YES:  maker gets p - V per contract
  taker bought NO       -> the maker bought YES: maker gets V - p per contract
V is the settlement value of YES. Fees are not included (most rewarded series charge makers none).
Uncertainty: bootstrap over events.   python scripts/hist_fills.py [--sports-results DIR] [--boot 2000]
"""
import argparse
import glob
import json
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
H = ROOT / "data" / "hist"
ap = argparse.ArgumentParser()
ap.add_argument("--sports-results", default=str(ROOT.parent / "kalshi-edge" / "data" / "meta" / "markets"))
ap.add_argument("--boot", type=int, default=2000)
a = ap.parse_args()

con = duckdb.connect()
con.execute("set threads=4")
con.execute(f"""create table res as
    select ticker, any_value(v) v from (
      select ticker, coalesce(try_cast(value as double), case result when 'yes' then 1.0 when 'no' then 0.0 end) v
      from read_json_auto('{H}/results.jsonl') where found and result in ('yes','no','scalar')
      {"union all select ticker, coalesce(settlement_value_dollars, case result when 'yes' then 1.0 when 'no' then 0.0 end) v from read_parquet('" + a.sports_results + "/*/*.parquet') where result in ('yes','no','scalar')" if glob.glob(a.sports_results + "/*/*.parquet") else ""}
    ) where v is not null group by 1""")
con.execute(f"""create table prog as
    select id, market_ticker ticker, event_ticker event, series_ticker series, sport, usd, start::timestamptz t0, "end"::timestamptz t1
    from read_parquet('{H}/programs_2026-11-17.parquet') where status='paid_out' and incentive_type='liquidity'""")
con.execute(f"""create table w as
    select p.id, p.event, p.series, p.sport, p.usd, r.v is not null as known,
           coalesce(sum(t.contracts * case when t.taker_yes then t.yes_px/1e4 else 1 - t.yes_px/1e4 end), 0) taker_usd,
           coalesce(sum(t.contracts * case when t.taker_yes then t.yes_px/1e4 - r.v else r.v - t.yes_px/1e4 end), 0) maker_pnl
    from prog p left join res r on r.ticker = p.ticker
    left join read_parquet('{H}/trades/*.parquet') t on t.ticker = p.ticker and t.minute >= p.t0 and t.minute < p.t1
    group by all""")
tot = con.execute("select count(*), sum(usd), sum(taker_usd), sum(case when known or taker_usd=0 then usd end), sum(case when known then taker_usd end) from w").fetchall()[0]
print(f"windows {tot[0]:,}  reward ${tot[1]:,.0f}  traded ${tot[2]:,.0f}  | settlement known for ${tot[4]:,.0f} of the traded dollars ({100*tot[4]/tot[2]:.1f}%)")


def table(where: str, label: str) -> dict:
    df = con.execute(f"select event, sum(usd) reward, sum(taker_usd) vol, sum(maker_pnl) pnl, count(*) n from w where (known or taker_usd = 0) and {where} group by 1").df()
    if df.empty:
        return {}
    rng = np.random.default_rng(7)
    idx = rng.integers(0, len(df), size=(a.boot, len(df)))
    r, v, p = df.reward.values[idx].sum(1), df.vol.values[idx].sum(1), df.pnl.values[idx].sum(1)
    lo, hi = np.percentile(p / v * 100, [2.5, 97.5]) if df.vol.sum() > 0 else (float("nan"),) * 2
    nlo, nhi = np.percentile((p + r) / r, [2.5, 97.5])
    out = dict(label=label, windows=int(df.n.sum()), events=len(df), reward=float(df.reward.sum()), traded=float(df.vol.sum()),
               maker_fill_pnl=float(df.pnl.sum()), fill_pnl_pct_of_traded=float(100 * df.pnl.sum() / df.vol.sum()) if df.vol.sum() else None,
               fill_pct_ci=[float(lo), float(hi)], net_per_reward_dollar=float((df.pnl.sum() + df.reward.sum()) / df.reward.sum()),
               net_ci=[float(nlo), float(nhi)])
    print(f"{label:<22} windows {out['windows']:>7,} events {out['events']:>6,}  reward ${out['reward']:>11,.0f}  traded ${out['traded']:>13,.0f}  "
          f"maker fills ${out['maker_fill_pnl']:>12,.0f} ({(out['fill_pnl_pct_of_traded'] or 0):+.2f}% [{lo:+.2f}, {hi:+.2f}])  "
          f"net per $1 reward {out['net_per_reward_dollar']:+.2f} [{nlo:+.2f}, {nhi:+.2f}]")
    return out


rows = [table("true", "all with known result"), table("sport", "sports"), table("not sport", "not sports")]
for lo, hi, name in ((0, 1e3, "traded < $1k"), (1e3, 1e4, "$1k-$10k"), (1e4, 1e5, "$10k-$100k"), (1e5, 1e18, "$100k+")):
    rows.append(table(f"taker_usd >= {lo} and taker_usd < {hi}", name))
json.dump(dict(as_of="2026-11-17", reward_total=tot[1], traded_total=tot[2], traded_with_known_result=tot[4], rows=[r for r in rows if r]),
          open(ROOT / "results" / "history_step_b.partial.json", "w"), indent=1)
