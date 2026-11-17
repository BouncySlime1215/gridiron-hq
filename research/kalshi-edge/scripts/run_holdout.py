#!/usr/bin/env python3
"""Evaluate the frozen model and rules on one split.

    python scripts/run_holdout.py --split validation      dry run, same code path, no guard
    python scripts/run_holdout.py --split train           the same tables on the discovery set (in-sample)
    python scripts/run_holdout.py --split holdout         THE look: needs frozen/model.json, writes a ledger row

Writes results/<split>.json. Primary tests: P1-P4 (PREREGISTRATION.md section 6) and
A1-A2 (Amendment 1), Holm-adjusted together. Everything else is labelled secondary.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from kalshi_edge import features, guard, hypotheses, ingame, rules, stats, strategy  # noqa: E402
import flow_pnl  # noqa: E402
import freeze  # noqa: E402
import ingame_lib  # noqa: E402

DATA = ROOT / "data"
N_BOOT = 10000
EXT_COLS = ("b.ticker, b.series, b.event_ticker, b.milestone_id, b.milestone_type, b.league, b.bucket, b.t_start, b.mins_in, "
            "b.ask_last, b.bid_last, b.px_high, b.px_low, b.vwap, b.dollars, b.nx_ask_first, b.nx_bid_first, b.nx_gap_min, b.nx_usd, "
            "b.nx_low, b.nx_high, b.pre_close, b.in_net_5m, b.rb_net_5m, b.fx_net_5m")
EXT_WHERE = "(b.ask_last >= 0.80 or b.bid_last <= 0.20)"


def maker_fee_series() -> set[str]:
    series = json.load(open(DATA / "meta" / "series_sports.json"))["series"]
    return {s["ticker"] for s in series if s["fee_type"] == "quadratic_with_maker_fees"}


def summ(e: pd.DataFrame, n_boot: int = N_BOOT) -> dict:
    if len(e) == 0 or e.milestone_id.nunique() < 2:
        return {"positions": int(len(e))}
    ci = stats.cluster_bootstrap_ratio(e.pnl.to_numpy(), e.cost.to_numpy(), e.milestone_id.to_numpy(), n_boot=n_boot, seed=0)
    return {"positions": int(len(e)), "games": ci.n_clusters, "win_rate": float((e.pnl > 0).mean()), "avg_price": float(e.price.mean()),
            "staked": float(e.cost.sum()), "pnl": float(e.pnl.sum()), "roi": ci.point, "lo": ci.lo, "hi": ci.hi, "p_one_sided": ci.p_le_zero}


def flow_gap(g: pd.DataFrame, a: str = "IN", b: str = "RB", n_boot: int = N_BOOT, seed: int = 0) -> dict:
    """Pre-fee taker return of kind a minus kind b over the same games, bootstrapping games."""
    p = g.pivot_table(index="milestone_id", columns="kind", values=["dollars", "payout"], aggfunc="sum").fillna(0.0)
    d = {k: p[("dollars", k)].to_numpy() for k in (a, b)}
    w = {k: (p[("payout", k)] - p[("dollars", k)]).to_numpy() for k in (a, b)}
    n = len(p)
    rng = np.random.default_rng(seed)
    out = np.empty(n_boot)
    for i in range(0, n_boot, 200):
        m = rng.multinomial(n, np.full(n, 1 / n), size=min(200, n_boot - i))
        out[i:i + len(m)] = (m @ w[a]) / (m @ d[a]) - (m @ w[b]) / (m @ d[b])
    return {"games": int(n), "ret_" + a: float(w[a].sum() / d[a].sum()), "ret_" + b: float(w[b].sum() / d[b].sum()),
            "dollars_" + a: float(d[a].sum()), "dollars_" + b: float(d[b].sum()),
            "gap": float(w[a].sum() / d[a].sum() - w[b].sum() / d[b].sum()),
            "lo": float(np.quantile(out, 0.025)), "hi": float(np.quantile(out, 0.975)),
            "p_one_sided": float((np.sum(out <= 0) + 1) / (n_boot + 1))}


def ingame_calibration(ig: pd.DataFrame) -> dict:
    """S12: in-game price against outcome at the extremes (both prints present, sane spread)."""
    d = ig[ig.ask_last.notna() & ig.bid_last.notna() & ((ig.ask_last - ig.bid_last).between(0, 0.05))]
    mid = (d.ask_last + d.bid_last) / 2
    out = {}
    for name, mask in (("mid>=0.95", mid >= 0.95), ("mid<=0.05", mid <= 0.05), ("0.90<=mid<0.95", (mid >= 0.90) & (mid < 0.95)),
                       ("0.05<mid<=0.10", (mid > 0.05) & (mid <= 0.10))):
        x = d[mask]
        r = (x.y - mid[mask])
        c = r.groupby(x.milestone_id).sum()
        se = float(np.sqrt((c ** 2).sum()) / len(x)) if len(c) > 1 else float("nan")
        out[name] = {"minutes": int(len(x)), "games": int(len(c)), "mean_price": float(mid[mask].mean()), "win_rate": float(x.y.mean()),
                     "resid_cents": float(100 * r.mean()), "se_cents": 100 * se, "t": float(r.mean() / se) if se and se == se else None}
    return out


def static_offer(h10: pd.DataFrame, fill: str = "through") -> pd.DataFrame:
    """S11: one resting offer set ten minutes before the start and left until 45 minutes in.

    This wrapper only looks up how high each market traded early in the game; the rule
    itself is kalshi_edge.rules.static_longshot_offer.
    """
    import duckdb

    if len(h10) == 0:
        return rules.static_longshot_offer(h10.assign(hi_in=np.nan), fill=fill)
    con = duckdb.connect()
    con.execute("set threads=3")
    lo_t, hi_t = h10.t_start.min(), h10.t_start.max()
    minutes = rules.STATIC_LONGSHOT_OFFER["minutes"]
    highs = con.execute(f"""select ticker, max(px_high) filter (where mins_in < {minutes}) as hi_in
                            from read_parquet('{DATA}/ingame_min/*.parquet')
                            where t_start >= timestamptz '{lo_t.isoformat()}' and t_start <= timestamptz '{hi_t.isoformat()}'
                            group by ticker""").df()
    return rules.static_longshot_offer(h10.merge(highs, on="ticker", how="left"), fill=fill)


def flow_price_regression(lo: str, hi: str) -> dict:
    """S13: next-minute and next-5-minute price change on this minute's signed flow share by class (prices 15-85c)."""
    import duckdb
    import statsmodels.api as sm

    con = duckdb.connect()
    con.execute("set threads=3")
    con.execute("set memory_limit='6GB'")
    df = con.execute(f"""
        with b as (
          select ticker, milestone_id, bucket, vwap, dollars,
                 usd_in_yes - usd_in_no as in_net, usd_rb_yes - usd_rb_no as rb_net, usd_fx_yes - usd_fx_no as fx_net,
                 lead(vwap, 1) over w as v1, lead(vwap, 5) over w as v5, lead(bucket, 5) over w as b5, lag(vwap, 1) over w as vm1
          from read_parquet('{DATA}/ingame_min/*.parquet')
          where t_start >= timestamptz '{lo}' and t_start < timestamptz '{hi}' and t_start >= timestamptz '2026-04-20 00:00:00+00'
          window w as (partition by ticker order by bucket))
        select milestone_id, v1 - vwap as d1, v5 - vwap as d5, vwap - vm1 as dm1, in_net / dollars as in_s, rb_net / dollars as rb_s,
               fx_net / dollars as fx_s
        from b where vwap between 0.15 and 0.85 and v5 is not null and vm1 is not null
          and date_diff('minute', bucket, b5) <= 8 and dollars >= 200""").df()
    if len(df) < 1000:
        return {"minutes": int(len(df))}
    X = sm.add_constant(df[["in_s", "rb_s", "fx_s", "dm1"]].astype(float))
    grp = pd.factorize(df.milestone_id)[0]
    out = {"minutes": int(len(df)), "games": int(df.milestone_id.nunique())}
    for tgt in ("d1", "d5"):
        r = sm.OLS((df[tgt] * 100).astype(float), X).fit(cov_type="cluster", cov_kwds={"groups": grp})
        out[tgt] = {k: {"coef_cents": float(r.params[k]), "se": float(r.bse[k]), "t": float(r.tvalues[k])} for k in ("in_s", "rb_s", "fx_s")}
    return out


def evaluate(split: str, token=None) -> dict:
    frozen = json.load(open(ROOT / "frozen" / "model.json"))
    res: dict = {"split": split, "frozen_at_utc": frozen["frozen_at_utc"], "frozen_code_commit": frozen["code_commit"]}
    mf = maker_fee_series()

    # ---------------- pre-game, h = 10 ----------------
    if split == "holdout":
        h10 = pd.read_parquet(guard.holdout_path(DATA, 10, token))
    else:
        h10 = pd.read_parquet(DATA / "analysis" / "h10.parquet")
        h10 = h10[h10.split == split]
    assert set(h10.split.unique()) == {split}
    h10 = h10.copy()
    h10["maker_rate"] = np.where(h10.series.isin(mf), 0.0175, 0.0)
    res["coverage"] = {"pregame_markets_with_result": int(len(h10)), "pregame_games": int(h10.milestone_id.nunique()),
                       "first_start": str(h10.t_start.min()), "last_start": str(h10.t_start.max())}
    res["P1"] = hypotheses.p1_slope(h10)
    res["P2_P3"] = hypotheses.p2_p3_flow(h10)
    p4 = frozen["p4"]
    ok = ((h10.ask0_age_min <= p4["max_quote_age"]) & (h10.bid0_age_min <= p4["max_quote_age"])
          & ((h10.ask0 - h10.bid0).between(0, p4["max_spread"])) & h10.p0.between(0.005, 0.995))
    dq = h10[ok]
    q = freeze.predict(frozen, features.build(dq))
    bets = strategy.simulate(dq, q, tau=p4["tau"], stake=p4["stake"], max_quote_age=p4["max_quote_age"], max_spread=p4["max_spread"])
    res["P4"] = strategy.summarize(bets, n_boot=N_BOOT)
    res["P4"]["p_one_sided"] = res["P4"].pop("p_le_zero", float("nan"))
    res["S11_static_offer"] = {}
    for fill in ("through", "touch"):
        e = static_offer(h10, fill=fill)
        res["S11_static_offer"][fill] = dict(summ(e), posted=e.attrs.get("posted", 0))

    # ---------------- who pays whom ----------------
    if split == "holdout":
        gpath = DATA / "holdout" / "flow_pnl_games.parquet"
        if not gpath.exists():
            flow_pnl.run(("holdout",), DATA / "holdout" / "flow_pnl.parquet", files_from="2026_09_20")
        games = pd.read_parquet(gpath)
        table = pd.read_parquet(DATA / "holdout" / "flow_pnl.parquet")
    else:
        games = pd.read_parquet(DATA / "analysis" / "flow_pnl_games.parquet")
        table = pd.read_parquet(DATA / "analysis" / "flow_pnl.parquet")
    games, table = games[games.split == split], table[table.split == split]
    live = games[games.phase == "live"]
    live = live[live.milestone_id.isin(live[live.kind == "RB"].milestone_id.unique())]
    res["A1"] = flow_gap(live, "IN", "RB")
    res["A1_in_vs_fx"] = flow_gap(live, "IN", "FX")
    who = {}
    for (phase, kind), x in table.groupby(["phase", "kind"]):
        d, pnl, fee = x.dollars.sum(), (x.payout - x.dollars).sum(), x.fee.sum()
        who[f"{phase}/{kind}"] = {"taker_dollars": float(d), "pre_fee_return": float(pnl / d), "fee_rate": float(fee / d),
                                  "net_return": float((pnl - fee) / d)}
    for phase, x in table.groupby("phase"):
        d, pnl, fee = x.dollars.sum(), (x.payout - x.dollars).sum(), x.fee.sum()
        who[f"{phase}/ALL"] = {"taker_dollars": float(d), "pre_fee_return": float(pnl / d), "fee_rate": float(fee / d),
                               "net_return": float((pnl - fee) / d), "maker_gain_dollars": float(-pnl), "fees_dollars": float(fee)}
    res["S4_who_pays_whom"] = who

    # ---------------- in-game ----------------
    ig = ingame_lib.load(split, where=EXT_WHERE, columns=EXT_COLS, token=token)
    ig = ig[ig.result.isin(["yes", "no"])].copy()
    ig["maker_rate"] = np.where(ig.series.isin(mf), 0.0175, 0.0)
    res["coverage"].update(ingame_games=int(ig.milestone_id.nunique()), ingame_extreme_minutes=int(len(ig)))
    a2 = rules.early_longshot_offer(ig)
    res["A2"] = summ(a2)
    wk = a2.assign(week=a2.bucket.dt.strftime("%G-W%V")).groupby("week").agg(positions=("pnl", "size"), pnl=("pnl", "sum"), staked=("cost", "sum"))
    wk["roi"] = wk.pnl / wk.staked
    res["A2"]["weeks"] = {k: {"positions": int(v.positions), "roi": float(v.roi)} for k, v in wk.iterrows()}
    res["A2"]["share_of_weeks_positive"] = float((wk.roi > 0).mean())
    res["A2"]["by_sport"] = {sp: summ(x, n_boot=2000) for sp, x in a2.groupby("sport") if x.milestone_id.nunique() >= 50}
    res["S9_A2_touch"] = summ(rules.early_longshot_offer(ig, fill="touch"))
    res["S9_A2_every_minute"] = summ(rules.early_longshot_offer(ig, every_minute=True))
    no_int = ig[~(ig.in_net_5m > 0)]
    res["S10_A2_integer_not_buying"] = summ(rules.early_longshot_offer(no_int))
    res["S10_A2_integer_buying"] = summ(rules.early_longshot_offer(ig[ig.in_net_5m > 0]))
    res["S8_favourite_carry"] = summ(rules.favourite_carry(ig))
    res["S12_ingame_calibration"] = ingame_calibration(ig)
    lo, hi = ingame_lib.RANGES[split]
    res["S13_flow_predicts_price"] = flow_price_regression(lo, hi)

    # ---------------- Holm over the primary family ----------------
    prim = {"P1": res["P1"]["p_one_sided"], "P2": res["P2_P3"]["p2_one_sided"], "P3": res["P2_P3"]["p3_one_sided"],
            "P4": res["P4"].get("p_one_sided", float("nan")), "A1": res["A1"]["p_one_sided"], "A2": res["A2"].get("p_one_sided", float("nan"))}
    keys = [k for k, v in prim.items() if v == v]
    adj = stats.holm([prim[k] for k in keys])
    res["primary"] = {k: {"p": prim[k], "p_holm": a, "passes_0.05": bool(a <= 0.05)} for k, a in zip(keys, adj)}
    for k, v in prim.items():
        if v != v:
            res["primary"][k] = {"p": None, "p_holm": None, "passes_0.05": False, "note": "no bets, so no test"}
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True, choices=["train", "validation", "holdout"])
    a = ap.parse_args()
    token = None
    out = ROOT / "results" / f"{a.split}.json"
    if a.split == "holdout":
        token = guard.open_holdout(frozen_model=ROOT / "frozen" / "model.json", ledger=ROOT / "HOLDOUT-LEDGER.md",
                                   script="scripts/run_holdout.py", what="primary P1-P4, A1-A2 and all secondaries",
                                   result_file="results/holdout.json")
        print("holdout opened: ledger row", token.row_number, "model sha256", token.model_sha256, flush=True)
    res = evaluate(a.split, token)
    res["run_at_utc"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(res, indent=1, default=float) + "\n")
    print(json.dumps({k: res[k] for k in ("primary", "P1", "P2_P3", "P4", "A1", "A2", "S8_favourite_carry", "S9_A2_touch")}, indent=1, default=float))
    print("wrote", out)


if __name__ == "__main__":
    main()
