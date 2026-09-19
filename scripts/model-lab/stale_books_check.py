#!/usr/bin/env python3
"""
Post-hoc check of the one development-family survivor (C2 stale-book totals)
and its spreads sibling: does it make MONEY at the actual prices, and does it
hold on 2025? The 2025 check was NOT preregistered for C2 (only the two
champions were); it is labeled post-hoc wherever it is reported.
Win/loss graded at the stale book's own line; ROI at the stale book's own
American price, flat 1-unit stakes, pushes returned.
"""
import json, math, statistics as st
from collections import defaultdict
from pathlib import Path
import lab

def payout(price):
    return price / 100 if price > 0 else 100 / -price

def main():
    rows = lab.load_table()
    out = {}
    for mname in ("totals", "spreads"):
        mk = lab.Market(mname)
        pmf = lab.keynumber_pmf(mname)
        for label, seasons in (("dev 2023-24", (2023, 2024)), ("holdout 2025 (post-hoc)", (2025,))):
            scored, results, pnl, prices = [], [], [], []
            for S in seasons:
                train, test = lab.season_split(rows, S)
                base = mk.baseline([r for r in train if mk.ok(r)])
                for r in test:
                    if not mk.ok(r):
                        continue
                    stale = ((r.get("books") or {}).get(mname) or {}).get("stale") or []
                    if not stale:
                        continue
                    ref = r["open_spread"] if mk.spread else r["open_total"]
                    b = max(stale, key=lambda x: abs(x["line"] - ref))
                    pos = (b["line"] > ref) if mk.spread else (b["line"] < ref)
                    raw = mk.raw_clv(r, pos, our=b["line"])
                    scored.append((r, pos, raw - base[mk.role(r, pos)], raw))
                    if mk.spread:
                        d = r["actual_margin"] + b["line"]
                    else:
                        d = r["actual_total"] - b["line"]
                    if d == 0:
                        pnl.append(0.0); continue
                    won = (d > 0) == pos
                    results.append(won); prices.append(b["price"])
                    pnl.append(payout(b["price"]) if won else -1.0)
            cz = lab.clustered_z(scored)
            win = sum(results) / len(results) if results else None
            be = st.mean(1 / (1 + payout(p)) for p in prices) if prices else None
            out[f"{mname} | {label}"] = dict(n=cz["n"], adj_clv=cz["mean"], z=cz["z"], p=cz["p"],
                prob_clv=lab.prob_clv(pmf, [x[3] for x in scored]), win_rate=win, graded=len(results),
                breakeven=be, roi=st.mean(pnl) if pnl else None, mean_price=st.mean(prices) if prices else None)
    for k, v in out.items():
        print(f"{k:34s} n={v['n']:3d} adjCLV={v['adj_clv']:+.3f} z={v['z']:+.2f} winprob+={v['prob_clv']*100:+.2f}pp "
              f"won={v['win_rate']*100:.1f}% of {v['graded']} breakeven={v['breakeven']*100:.1f}% ROI={v['roi']*100:+.1f}% price={v['mean_price']:.0f}")
    (lab.LAB / "stale-books-check.json").write_text(json.dumps(out, indent=1))

if __name__ == "__main__":
    main()
