#!/usr/bin/env python3
"""
Opener lab LEVEL 1 — where is the opener most wrong (move magnitude).
Executes LATEST-PLAN "PREREGISTERED — OPENER LAB", level 1, exactly:
each condition level's mean |close - open| vs its complement, week-cluster
bootstrap p; discover on 2022-23 (Holm, larger move), confirm on 2024-25 (Holm
over the frozen list, same direction). Quantile cut points come from discovery.
Output: docs/evidence/2026-09-16/opener-lab/level1.json
"""
import json, math, random, statistics as st, sys
from collections import defaultdict
from pathlib import Path
import numpy as np

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "docs/evidence/2026-09-16/opener-lab"
AT_OPEN = "--at-open" in sys.argv
DISP, GAP = ("dispersion_pre", "cons_gap_pre") if AT_OPEN else ("dispersion", "cons_gap")
RNG = random.Random(20260916)
DISC, CONF = (2022, 2023), (2024, 2025)


def holm(p):
    live = sorted(p.items(), key=lambda kv: kv[1]); m = len(live); out = {}; blocked = False
    for i, (k, v) in enumerate(live):
        a = 0.05 / (m - i); ok = v <= a and not blocked; blocked = blocked or not ok
        out[k] = dict(p=v, alpha=a, passes=ok)
    return out


def boot(inside, outside, reps=2000):
    if len(inside) < 30 or len(outside) < 30:
        return None, None
    wi, wo = defaultdict(list), defaultdict(list)
    for w, v in inside: wi[w].append(v)
    for w, v in outside: wo[w].append(v)
    weeks = sorted(set(wi) | set(wo))
    obs = st.mean(v for _, v in inside) - st.mean(v for _, v in outside)
    draws = []
    for _ in range(reps):
        smp = [RNG.choice(weeks) for _ in weeks]
        a = [v for w in smp for v in wi[w]]; b = [v for w in smp for v in wo[w]]
        if a and b:
            draws.append(st.mean(a) - st.mean(b))
    sd = st.pstdev(draws)
    return obs, (math.erfc(abs(obs / sd) / math.sqrt(2)) if sd else None)


def conditions(market, disc_rows):
    q = lambda f, qs: [float(x) for x in np.quantile([r[f] for r in disc_rows if r[f] is not None], qs)]
    lead = q("lead_hours", [0.25, 0.5, 0.75]); disp = q(DISP, [1 / 3, 2 / 3])
    C = {}
    if market == "spreads":
        for name, lo, hi in (("size<=2.5", -1, 2.5), ("size=3", 3, 3), ("size3.5-6.5", 3.5, 6.5), ("size=7", 7, 7), ("size7.5-9.5", 7.5, 9.5), ("size>=10", 10, 99)):
            C[name] = lambda r, lo=lo, hi=hi: lo <= r["size"] <= hi
        C["home_favourite"] = lambda r: r["home_fav"]
    else:
        for name, lo, hi in (("total<40", 0, 39.5), ("total40-43.5", 40, 43.5), ("total44-47.5", 44, 47.5), ("total>=48", 48, 99)):
            C[name] = lambda r, lo=lo, hi=hi: lo <= r["size"] <= hi
    C["key_number"] = lambda r: r["key_number"]
    for name, lo, hi in (("week1-4", 1, 4), ("week5-9", 5, 9), ("week10-14", 10, 14), ("week15-18", 15, 18), ("playoffs", 19, 99)):
        C[name] = lambda r, lo=lo, hi=hi: lo <= r["week"] <= hi
    edges = [-1e9] + lead + [1e9]
    for i in range(4):
        C[f"lead_q{i + 1}"] = lambda r, a=edges[i], b=edges[i + 1]: None if r["lead_hours"] is None else a < r["lead_hours"] <= b
    C["lookahead"] = lambda r: r["lookahead"]
    dedges = [-1e9] + disp + [1e9]
    for i in range(3):
        C[f"dispersion_t{i + 1}"] = lambda r, a=dedges[i], b=dedges[i + 1]: None if r[DISP] is None else a < r[DISP] <= b
    C["pinnacle_vs_books_gap>=0.5"] = lambda r: None if r[GAP] is None else abs(r[GAP]) >= 0.5
    C["price_skew>=0.02"] = lambda r: None if r["skew"] is None else abs(r["skew"]) >= 0.02
    C["divisional"] = lambda r: r["div"]
    C["primetime"] = lambda r: r["primetime"]
    C["short_week"] = lambda r: r["short_week"]
    return C, dict(lead_quartile_cuts=lead, dispersion_tercile_cuts=disp)


def run(rows, cond):
    res = {}
    for name, fn in cond.items():
        tagged = [(fn(r), r) for r in rows]
        inside = [((r["season"], r["week"]), r["abs_move"]) for t, r in tagged if t is True]
        outside = [((r["season"], r["week"]), r["abs_move"]) for t, r in tagged if t is False]
        d, p = boot(inside, outside)
        res[name] = dict(n=len(inside), mean_in=st.mean(v for _, v in inside) if inside else None,
                         mean_out=st.mean(v for _, v in outside) if outside else None, diff=d, p=p,
                         share_moved_1pt=sum(v >= 1 for _, v in inside) / len(inside) if inside else None)
    return res


def main():
    rows = [json.loads(l) for l in open(OUT / "table.jsonl")]
    report = {}
    for market in ("spreads", "totals"):
        mrows = [r for r in rows if r["market"] == market]
        disc = [r for r in mrows if r["season"] in DISC]
        conf = [r for r in mrows if r["season"] in CONF]
        cond, cuts = conditions(market, disc)
        d = run(disc, cond)
        hd = holm({k: v["p"] for k, v in d.items() if v["p"] is not None})
        frozen = [k for k, v in hd.items() if v["passes"] and d[k]["diff"] > 0]
        c = run(conf, {k: cond[k] for k in cond})
        hc = holm({k: c[k]["p"] for k in frozen if c[k]["p"] is not None}) if frozen else {}
        confirmed = [k for k in frozen if hc.get(k, {}).get("passes") and c[k]["diff"] > 0]
        report[market] = dict(cuts=cuts, overall_disc=st.mean(r["abs_move"] for r in disc), overall_conf=st.mean(r["abs_move"] for r in conf),
                              discovery=d, frozen=frozen, confirmation={k: c[k] for k in cond}, holm_conf=hc, confirmed=confirmed)
        print(f"\n=== {market}: mean |move| discovery {report[market]['overall_disc']:.2f}, confirmation {report[market]['overall_conf']:.2f}")
        print(f"{'condition':28s} {'disc n':>6s} {'in':>5s} {'out':>5s} {'diff':>6s} {'p':>6s} | {'conf n':>6s} {'in':>5s} {'out':>5s} {'diff':>6s} {'p':>6s}")
        for k in cond:
            a, b = d[k], c[k]
            f = lambda x, n=2: "  -" if x is None else f"{x:.{n}f}"
            mark = (" FROZEN" if k in frozen else "") + (" CONFIRMED" if k in confirmed else "")
            print(f"{k:28s} {a['n']:6d} {f(a['mean_in'])} {f(a['mean_out'])} {f(a['diff'])} {f(a['p'],3)} | {b['n']:6d} {f(b['mean_in'])} {f(b['mean_out'])} {f(b['diff'])} {f(b['p'],3)}{mark}")
        print("frozen:", frozen, "| confirmed:", confirmed)
    (OUT / ("level1-atopen.json" if AT_OPEN else "level1.json")).write_text(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
