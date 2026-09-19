#!/usr/bin/env python3
"""
Re-grade tonight's opener results against REPAIRED openers (migration 055).

Tonight's opener-CLV edge, confident-pick tables and frozen-rule test were all
graded against game_lines.open_spread as migration 047 left it -- which for
2022-2025 includes Pinnacle placeholder openers (usually home -1.0). A
placeholder opener fakes a huge "line move" toward whichever side the real
market favoured, so any forecaster that simply agrees with the real market
looks like it beat the opener. This script answers: how much of what we
measured was that?

Only MARKET-FREE forecasters are re-graded: the four survivor components and
their average. Verified in nfl-ensemble.js: second_half_eff, epa_net
(diffModel, calibrated to final margins in calibrate()), opp_adjusted
(play-by-play features + schedule) and dynamic_state (scores) never read the
market line, so their saved predictions are unaffected by the bad opener and
only the grading changes. The full ensemble blend and the drive sim DID see
the placeholder through marketOverride / spread, so their saved predictions
for repaired games are themselves contaminated; they are not re-graded here.

Games labeled suspect by migration 055 are excluded. The closing line is
game_lines.spread, unchanged.

Usage: python3 scripts/regrade-repaired-openers.py
"""
import json, math, statistics as st
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
EV = REPO / "docs/evidence/2026-09-16"
SURV = ["second_half_eff", "opp_adjusted", "dynamic_state", "epa_net"]
SUSPECT = "suspect_pinnacle_placeholder_unresolved_2022_2025"

repaired = {(g["season"], g["week"], g["home"]): g for g in
            json.load(open(EV / "opener-repair/repaired-openers.json"))["games"]}


def load(seasons, fixed):
    rows = []
    for s in seasons:
        for line in open(EV / f"opener-clv/games-{s}.jsonl"):
            r = json.loads(line)
            rep = repaired.get((s, r["week"], r["home"]))
            if fixed:
                if rep is None or rep["open_spread_source"] == SUSPECT:
                    continue
                r["open_spread"] = rep["open_spread"]
            r["_s"] = s
            rows.append(r)
    return rows


def cm(r):
    return {c["id"]: c["pred"] for c in (r.get("components") or []) if c["pred"] is not None}


def composite(r):
    m = cm(r)
    v = [m.get(k) for k in SURV]
    return sum(v) / 4 if all(x is not None for x in v) else None


def single(k):
    return lambda r: cm(r).get(k)


def baseline(rows):
    out = {}
    for side in ("home", "away"):
        for role in ("fav", "dog"):
            vals = []
            for r in rows:
                o, c = r["open_spread"], r["close_spread"]
                if o == 0:
                    continue
                bh = side == "home"
                fav = o < 0
                if ("fav" if (bh and fav) or (not bh and not fav) else "dog") != role:
                    continue
                vals.append((o if bh else -o) - (c if bh else -c))
            out[(side, role)] = st.mean(vals) if vals else 0.0
    return out


def clv(rows, fn):
    base = baseline(rows)
    vals, cl = [], {}
    for r in rows:
        p = fn(r)
        if p is None:
            continue
        o, c = r["open_spread"], r["close_spread"]
        if o == 0:
            continue
        lean = p + o
        if abs(lean) < 1e-9:
            continue
        bh = lean > 0
        role = "fav" if (bh and o < 0) or (not bh and o > 0) else "dog"
        a = ((o if bh else -o) - (c if bh else -c)) - base[("home" if bh else "away", role)]
        vals.append(a)
        cl.setdefault((r["_s"], r["week"]), []).append(a)
    means = [st.mean(v) for v in cl.values()]
    se = st.stdev(means) / math.sqrt(len(means))
    m = st.mean(vals)
    return dict(n=len(vals), mean=m, z=m / se, p=math.erfc(abs(m / se) / math.sqrt(2)))


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - h) / d, (c + h) / d


def picks(rows, fn):
    out = []
    for r in rows:
        p = fn(r)
        if p is None:
            continue
        o = r["open_spread"]
        lean = p + o
        m = r["actual_margin"] + o
        if abs(lean) < 1e-9 or m == 0:
            continue
        out.append(dict(e=abs(lean), win=(lean > 0) == (m > 0), s=r["_s"]))
    return out


def main():
    res = {}
    print("=== 1. Opener CLV (double-adjusted, week-clustered), BEFORE vs AFTER repair ===")
    for pool in ((2022, 2023, 2024), (2025,), (2022, 2023, 2024, 2025)):
        for fixed in (False, True):
            rows = load(pool, fixed)
            tag = f"{'-'.join(str(s) for s in pool)} {'repaired' if fixed else 'original'}"
            print(f"\n  {tag}")
            for name, fn in [("4-signal composite", composite)] + [(k, single(k)) for k in SURV]:
                x = clv(rows, fn)
                res[f"clv|{tag}|{name}"] = x
                print(f"    {name:20s} n={x['n']:4d}  mean {x['mean']:+.3f} pts  z={x['z']:+.2f}  p={x['p']:.4f}")

    print("\n=== 2. Bet only the composite's most confident picks, ATS at the opener, 2022-2025 ===")
    for fixed in (False, True):
        ps = sorted(picks(load((2022, 2023, 2024, 2025), fixed), composite), key=lambda x: -x["e"])
        print(f"\n  {'repaired' if fixed else 'original'} openers")
        for label, frac in [("all picks", 1), ("top 25%", .25), ("top 10%", .10), ("top 5%", .05)]:
            sub = ps[:max(1, int(len(ps) * frac))]
            k, n = sum(x["win"] for x in sub), len(sub)
            lo, hi = wilson(k, n)
            prof = (k * (100 / 110) - (n - k)) / n * 100
            by = " ".join(f"{s % 100}:{sum(1 for x in sub if x['s'] == s and x['win'])}/{sum(1 for x in sub if x['s'] == s)}"
                          for s in (2022, 2023, 2024, 2025))
            print(f"    {label:9s} {k:3d}/{n:4d} = {k / n * 100:5.1f}%  CI [{lo * 100:.0f}%, {hi * 100:.0f}%]  {prof:+6.1f}u/100  {by}")
            res[f"conf|{'repaired' if fixed else 'original'}|{label}"] = dict(k=k, n=n, rate=k / n, ci=[lo, hi], units_per_100=prof)
        e = [x["e"] for x in ps]
        w = [1 if x["win"] else 0 for x in ps]
        me, mw = st.mean(e), st.mean(w)
        r = sum((a - me) * (b - mw) for a, b in zip(e, w)) / len(e) / (st.pstdev(e) * st.pstdev(w))
        print(f"    correlation edge size vs win: r = {r:+.3f} (n={len(e)})")
        res[f"corr|{'repaired' if fixed else 'original'}"] = r

    print("\n=== 3. Frozen rule: top-10% edge cutoff learned on 2022-23, applied unchanged ===")
    for fixed in (False, True):
        es = sorted((x["e"] for x in picks(load((2022, 2023), fixed), composite)), reverse=True)
        cut = es[len(es) // 10]
        line = f"  {'repaired' if fixed else 'original'}: cutoff {cut:.2f} pts |"
        for s in (2024, 2025):
            sub = [x for x in picks(load((s,), fixed), composite) if x["e"] >= cut]
            k, n = sum(x["win"] for x in sub), len(sub)
            lo, hi = wilson(k, n)
            line += f" {s}: {k}/{n} = {k / n * 100:.1f}% CI [{lo * 100:.0f}%, {hi * 100:.0f}%] |"
            res[f"frozen|{'repaired' if fixed else 'original'}|{s}"] = dict(cut=cut, k=k, n=n)
        print(line)

    (EV / "opener-repair/regrade-results.json").write_text(json.dumps(res, indent=1))
    print("\nwrote docs/evidence/2026-09-16/opener-repair/regrade-results.json")


if __name__ == "__main__":
    main()
