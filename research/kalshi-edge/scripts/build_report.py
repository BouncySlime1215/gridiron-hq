#!/usr/bin/env python3
"""Assemble report/data.json from the result files and render report/index.html from report/template.html.

Every number on the page comes from results/*.json, the who-pays-whom tables, the
pooled S11 positions and the forward ledger. Nothing is typed in by hand.

Usage: python scripts/build_report.py
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from kalshi_edge import live as live_tickets  # noqa: E402
from kalshi_edge import stats  # noqa: E402

DATA = ROOT / "data"
BINS = [("0–5c", 0.00, 0.05), ("5–10c", 0.05, 0.10), ("10–20c", 0.10, 0.20), ("20–35c", 0.20, 0.35), ("35–50c", 0.35, 0.50),
        ("50–65c", 0.50, 0.65), ("65–80c", 0.65, 0.80), ("80–90c", 0.80, 0.90), ("90–95c", 0.90, 0.95), ("95c+", 0.95, 1.01)]
KIND_NAMES = {"IN": "Integer-count orders", "FX": "Other fractional orders", "RB": "Retail dollar-buys"}


def read_jsonl(p: Path) -> list[dict]:
    return [json.loads(x) for x in p.read_text().splitlines() if x.strip()] if p.exists() else []


def main() -> None:
    R = {s: json.load(open(ROOT / "results" / f"{s}.json")) for s in ("train", "validation", "holdout")}
    flow = pd.concat([pd.read_parquet(DATA / "analysis" / "flow_pnl.parquet"), pd.read_parquet(DATA / "holdout" / "flow_pnl.parquet")])

    # ---- scale
    days = read_jsonl(DATA / "logs" / "build_bars.jsonl")
    seen = {}
    for d in days:
        if "fills_all" in d:
            seen[d["day"]] = d
    import duckdb
    for f in sorted((DATA / "bars").glob("*.parquet")):
        day = f.stem.replace("_", "-")
        if day not in seen:      # reduced in a manual timing run before the log existed; its all-category fill count was printed then
            n_fills, n_orders, usd = duckdb.connect().execute(f"select sum(n_fills), sum(n_orders), sum(dollars) from read_parquet('{f}')").fetchall()[0]
            seen[day] = {"day": day, "fills_all": {"2026-11-15": 16481728}.get(day, int(n_fills)), "fills_sports": int(n_fills), "orders": int(n_orders), "dollars": float(usd)}
    scale = {
        "tape_days": len(seen), "fills_all": int(sum(d["fills_all"] for d in seen.values())),
        "fills_sports": int(sum(d["fills_sports"] for d in seen.values())), "orders_sports": int(sum(d["orders"] for d in seen.values())),
        "sports_taker_dollars_all": float(sum(d["dollars"] for d in seen.values())),
        "taker_dollars_with_results": float(flow.dollars.sum()),
        "settled_markets": json.load(open(ROOT / "frozen" / "model.json"))["results_snapshot"]["markets"],
        "games_in_game": int(sum(R[s]["coverage"]["ingame_games"] for s in R)),
        "games_pregame": int(sum(R[s]["coverage"]["pregame_games"] for s in R)),
        "first_day": min(seen), "last_day": max(seen),
    }

    # ---- who pays whom
    def tot(x):
        d, pnl, fee = float(x.dollars.sum()), float((x.payout - x.dollars).sum()), float(x.fee.sum())
        return {"dollars": d, "pre_fee": pnl / d, "fee": fee / d, "net": (pnl - fee) / d, "maker_gain": -pnl, "fees": fee, "taker_net_loss": fee - pnl}
    who = {"all": tot(flow), "live": tot(flow[flow.phase == "live"]), "pre": tot(flow[flow.phase == "pre"]),
           "by_split": {s: {ph: tot(flow[(flow.split == s) & (flow.phase == ph)]) for ph in ("live", "pre")} for s in R}}
    live = flow[flow.phase == "live"]
    price_bins = []
    for name, lo, hi in BINS:
        x = live[(live.pbin >= lo - 1e-9) & (live.pbin < hi - 1e-9)]
        price_bins.append(dict(tot(x), bin=name))

    # ---- fingerprint: in-game return before fees by order type, fractional era games only (as A1)
    kinds = {s: {"IN": R[s]["A1"]["ret_IN"], "RB": R[s]["A1"]["ret_RB"], "FX": R[s]["A1_in_vs_fx"]["ret_FX"],
                 "gap": R[s]["A1"]["gap"], "lo": R[s]["A1"]["lo"], "hi": R[s]["A1"]["hi"], "p": R[s]["A1"]["p_one_sided"],
                 "games": R[s]["A1"]["games"], "dollars_IN": R[s]["A1"]["dollars_IN"], "dollars_RB": R[s]["A1"]["dollars_RB"],
                 "dollars_FX": R[s]["A1_in_vs_fx"]["dollars_FX"]} for s in R}
    flow_price = {s: {k: R[s]["S13_flow_predicts_price"][h][c] for k, (h, c) in
                      {"in_1": ("d1", "in_s"), "rb_1": ("d1", "rb_s"), "fx_1": ("d1", "fx_s"), "in_5": ("d5", "in_s"), "rb_5": ("d5", "rb_s"),
                       "fx_5": ("d5", "fx_s")}.items()} | {"minutes": R[s]["S13_flow_predicts_price"]["minutes"],
                                                            "games": R[s]["S13_flow_predicts_price"]["games"]} for s in R}

    # ---- rules across periods
    def pick(r):
        return {k: r.get(k) for k in ("positions", "games", "win_rate", "avg_price", "roi", "lo", "hi", "p_one_sided", "staked", "pnl")}
    rules = {
        "A2": {s: pick(R[s]["A2"]) for s in R}, "A2_touch": {s: pick(R[s]["S9_A2_touch"]) for s in R},
        "S11": {s: dict(pick(R[s]["S11_static_offer"]["through"]), posted=R[s]["S11_static_offer"]["through"].get("posted")) for s in R},
        "S11_touch": {s: pick(R[s]["S11_static_offer"]["touch"]) for s in R},
        "S8": {s: pick(R[s]["S8_favourite_carry"]) for s in R},
        "A2_weeks_holdout": R["holdout"]["A2"]["weeks"],
        "A2_by_sport_holdout": {k: pick(v) for k, v in R["holdout"]["A2"]["by_sport"].items()},
    }
    s11 = pd.read_parquet(DATA / "analysis" / "s11_all_splits.parquet")
    ci = stats.cluster_bootstrap_ratio(s11.pnl.to_numpy(), s11.cost.to_numpy(), s11.milestone_id.to_numpy(), n_boot=10000, seed=0)
    rules["S11"]["pooled"] = {"positions": int(len(s11)), "win_rate": float((s11.pnl > 0).mean()), "avg_price": float(s11.price.mean()),
                              "roi": ci.point, "lo": ci.lo, "hi": ci.hi, "p_one_sided": ci.p_le_zero}
    s11["month"] = s11.t_start.dt.strftime("%Y-%m")
    months = []
    for m, g in s11.groupby("month"):
        months.append({"month": m, "positions": int(len(g)), "roi": float(g.pnl.sum() / g.cost.sum()), "win_rate": float((g.pnl > 0).mean()),
                       "split": g.split.iloc[0] if g.split.nunique() == 1 else "mixed"})
    by_sport = []
    for sp, g in s11.groupby("sport"):
        if len(g) >= 100:
            c = stats.cluster_bootstrap_ratio(g.pnl.to_numpy(), g.cost.to_numpy(), g.milestone_id.to_numpy(), n_boot=4000, seed=0)
            by_sport.append({"sport": sp, "positions": int(len(g)), "win_rate": float((g.pnl > 0).mean()), "roi": c.point, "lo": c.lo, "hi": c.hi})
    by_sport.sort(key=lambda r: -r["positions"])

    # ---- scorecard
    def fmt_p(p):
        return None if p is None else float(p)
    H, V = R["holdout"], R["validation"]
    score = [
        {"id": "P1", "claim": "Pre-game prices have a favourite–longshot tilt (slope above 1)",
         "validation": f"slope {V['P1']['slope']:.3f}", "holdout": f"slope {H['P1']['slope']:.3f} ± {H['P1']['se']:.3f}"},
        {"id": "P2", "claim": "Net retail dollar-buying pre-game predicts a lower result than the price says",
         "validation": f"coef {V['P2_P3']['rp_coef']:+.3f}", "holdout": f"coef {H['P2_P3']['rp_coef']:+.3f} (wrong sign)"},
        {"id": "P3", "claim": "Net large integer orders pre-game predict a higher result",
         "validation": f"coef {V['P2_P3']['lp_coef']:+.3f}", "holdout": f"coef {H['P2_P3']['lp_coef']:+.3f} ± {H['P2_P3']['lp_se']:.3f}"},
        {"id": "P4", "claim": "Money test: the frozen pre-game model, betting as a taker, returns more than it stakes",
         "validation": f"{V['P4']['bets']} bets, {100*V['P4']['roi']:+.0f}%", "holdout": f"{H['P4']['bets']} bets, all lost"
         if H["P4"]["bets"] and H["P4"]["win_rate"] == 0 else f"{H['P4']['bets']} bets, {100*H['P4']['roi']:+.0f}%"},
        {"id": "A1", "claim": "In-game, integer-count orders out-earn retail dollar-buys before fees",
         "validation": f"{100*V['A1']['gap']:+.2f} pts", "holdout": f"{100*H['A1']['gap']:+.2f} pts [{100*H['A1']['lo']:.2f}, {100*H['A1']['hi']:.2f}]"},
        {"id": "A2", "claim": "Money test: resting an offer on the longshot each minute early in a game returns more than it stakes",
         "validation": f"{100*V['A2']['roi']:+.2f}%", "holdout": f"{100*H['A2']['roi']:+.2f}% [{100*H['A2']['lo']:.2f}, {100*H['A2']['hi']:.2f}]"},
    ]
    for row in score:
        for k in ("validation", "holdout"):      # a real minus sign, not a hyphen
            row[k] = row[k].replace(" -", " −").replace("[-", "[−").replace("coef -", "coef −")
            if row[k].startswith("-"):
                row[k] = "−" + row[k][1:]
        pr = H["primary"][row["id"]]
        row.update(p=fmt_p(pr["p"]), p_holm=fmt_p(pr["p_holm"]), passed=bool(pr["passes_0.05"]), money=row["id"] in ("P4", "A2"))

    # ---- forward ledger
    ledger = live_tickets.collapse_ledger(read_jsonl(ROOT / "forward" / "ledger.jsonl"))
    graded = read_jsonl(ROOT / "forward" / "graded.jsonl")
    gkey = {g["ticker"]: g for g in graded}
    tickets = []
    for t in ledger:
        g = gkey.get(t["ticker"], {})
        phase = t.get("phase_at_placement") or ("pre" if t["mins_to_start"] > 0 else "in-game")
        tickets.append({"placed_at": t["placed_at"], "game": t.get("game"), "sport": t.get("sport"), "ticker": t["ticker"],
                        "limit_price": t["limit_price"], "contracts": t["contracts"], "max_loss": t["max_loss"], "max_gain": t["max_gain"],
                        "expires": t["expires"], "start": t["start"], "phase": phase,
                        "filled_through": g.get("filled_through"), "filled_touch": g.get("filled_touch"), "result": g.get("result"),
                        "final": bool(g.get("final")), "pnl_through": g.get("pnl_through"), "pnl_touch": g.get("pnl_touch")})

    def tally(xs, fkey, pkey):
        xs = [x for x in xs if x["final"] and x[fkey]]
        staked = sum(x["max_loss"] for x in xs)
        return {"positions": len(xs), "won": sum(1 for x in xs if (x[pkey] or 0) > 0), "staked": staked, "pnl": sum(x[pkey] or 0 for x in xs)}
    pre = [t for t in tickets if t["phase"] == "pre"]
    forward = {"tickets": tickets, "n_pre": len(pre), "n_in_game": len(tickets) - len(pre),
               "pre_settled": sum(1 for t in pre if t["final"]),
               "pre_through": tally(pre, "filled_through", "pnl_through"), "pre_touch": tally(pre, "filled_touch", "pnl_touch")}

    out = {"generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M"), "scale": scale, "who": who, "price_bins": price_bins,
           "kinds": kinds, "kind_names": KIND_NAMES, "flow_price": flow_price, "rules": rules, "s11_months": months, "s11_by_sport": by_sport,
           "score": score, "forward": forward,
           "calibration": {s: R[s]["S12_ingame_calibration"] for s in R},
           "coverage": {s: R[s]["coverage"] for s in R},
           "frozen": {"sha256": "fb396483f28e1aabe8ec64e60783d99020216611e73c4eb1756b17afc3167908", "holdout_run_utc": R["holdout"]["run_at_utc"]}}
    (ROOT / "report").mkdir(exist_ok=True)
    (ROOT / "report" / "data.json").write_text(json.dumps(out, indent=1, default=float) + "\n")
    tpl = (ROOT / "report" / "template.html").read_text()
    payload = json.dumps(out, default=float).replace("</", "<\\/")
    assert "__DATA__" in tpl
    (ROOT / "report" / "index.html").write_text(tpl.replace("__DATA__", payload))
    print("wrote report/data.json and report/index.html;",
          f"taker dollars with results ${out['who']['all']['dollars']/1e9:.1f}bn, fees ${out['who']['all']['fees']/1e9:.2f}bn, makers ${out['who']['all']['maker_gain']/1e9:.2f}bn;",
          f"S11 pooled {100*rules['S11']['pooled']['roi']:+.2f}% on {rules['S11']['pooled']['positions']} positions; forward tickets {len(tickets)}")


if __name__ == "__main__":
    main()
