#!/usr/bin/env python3
"""
Grade one opener-measurement run directory (games-<season>.jsonl).

Built to grade the v15 rerun (2026-09-16): walk-forward point conversion in
nfl-ensemble.js, graded on repaired openers (migration 055) already written
into game_lines. Suspect openers are excluded by name via
docs/evidence/2026-09-16/opener-repair/repaired-openers.json.

Reports, per season: each survivor's calibration slope (actual margin on
prediction; 1.0 = correct points scale) and mean absolute error; opener CLV
(double-adjusted, week-clustered) for the survivors, their composite, the
full blend and the drive sim; the composite's confident-pick win rates; and
the frozen top-10% rule learned on 2022-23.

Usage: python3 scripts/grade-opener-run.py docs/evidence/2026-09-16/opener-clv-v15
"""
import json, math, statistics as st, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RUN = REPO / sys.argv[1]
SIG = ["epa_net", "second_half_eff", "opp_adjusted", "dynamic_state"]
SUSPECT = "suspect_pinnacle_placeholder_unresolved_2022_2025"
src = {(g["season"], g["week"], g["home"]): g for g in
       json.load(open(REPO / "docs/evidence/2026-09-16/opener-repair/repaired-openers.json"))["games"]}


def load(seasons):
    rows = []
    for s in seasons:
        for line in open(RUN / f"games-{s}.jsonl"):
            r = json.loads(line)
            g = src.get((s, r["week"], r["home"]))
            if s >= 2022 and (g is None or g["open_spread_source"] == SUSPECT):
                continue
            r["_s"] = s
            r["_c"] = {c["id"]: c["pred"] for c in (r.get("components") or []) if c["pred"] is not None}
            rows.append(r)
    return rows


def pred_fn(name):
    if name == "composite":
        return lambda r: sum(r["_c"][k] for k in SIG) / 4 if all(k in r["_c"] for k in SIG) else None
    if name == "blend":
        return lambda r: (r.get("ensemble") or {}).get("pred")
    if name == "sim":
        return lambda r: (r.get("sim") or {}).get("pred")
    return lambda r: r["_c"].get(name)


def slope(pairs):
    xs, ys = zip(*pairs)
    mx, my = st.mean(xs), st.mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    b = sum((x - mx) * (y - my) for x, y in pairs) / sxx
    return b, st.mean(abs(x - y) for x, y in pairs)


def clv(rows, fn):
    base = {}
    for side in ("home", "away"):
        for role in ("fav", "dog"):
            v = [((r["open_spread"] if side == "home" else -r["open_spread"]) -
                  (r["close_spread"] if side == "home" else -r["close_spread"]))
                 for r in rows if r["open_spread"] != 0 and
                 ("fav" if (side == "home" and r["open_spread"] < 0) or (side == "away" and r["open_spread"] > 0) else "dog") == role]
            base[(side, role)] = st.mean(v)
    vals, cl = [], {}
    for r in rows:
        p = fn(r); o, c = r["open_spread"], r["close_spread"]
        if p is None or o == 0 or abs(p + o) < 1e-9:
            continue
        bh = p + o > 0
        role = "fav" if (bh and o < 0) or (not bh and o > 0) else "dog"
        a = ((o if bh else -o) - (c if bh else -c)) - base[("home" if bh else "away", role)]
        vals.append(a); cl.setdefault((r["_s"], r["week"]), []).append(a)
    means = [st.mean(v) for v in cl.values()]
    se = st.stdev(means) / math.sqrt(len(means)); m = st.mean(vals)
    return dict(n=len(vals), mean=m, z=m / se)


def wilson(k, n, z=1.96):
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - h) / d, (c + h) / d


def picks(rows, fn):
    out = []
    for r in rows:
        p = fn(r); o = r["open_spread"]
        if p is None:
            continue
        lean = p + o; m = r["actual_margin"] + o
        if abs(lean) < 1e-9 or m == 0:
            continue
        out.append(dict(e=abs(lean), win=(lean > 0) == (m > 0), s=r["_s"]))
    return out


def main():
    res = {}
    print("1. calibration slope (want 1.0) | mean absolute error, by season")
    for name in SIG + ["composite", "blend"]:
        line = f"   {name:16s}"
        for s in (2022, 2023, 2024, 2025):
            pairs = [(pred_fn(name)(r), r["actual_margin"]) for r in load((s,)) if pred_fn(name)(r) is not None]
            b, mae = slope(pairs)
            res[f"calib|{name}|{s}"] = dict(slope=b, mae=mae, n=len(pairs))
            line += f" | {s}: b {b:.2f} MAE {mae:.2f}"
        print(line)
    print("\n2. opener CLV, double-adjusted, week-clustered")
    for pool in ((2022, 2023, 2024), (2025,), (2022, 2023, 2024, 2025)):
        rows = load(pool); tag = "-".join(map(str, pool))
        for name in ["composite"] + SIG + ["blend", "sim"]:
            x = clv(rows, pred_fn(name)); res[f"clv|{tag}|{name}"] = x
            print(f"   {tag:19s} {name:16s} n={x['n']:4d} {x['mean']:+.3f} z{x['z']:+.2f}")
    print("\n3. composite confident picks, ATS at repaired opener, 2022-2025")
    ps = sorted(picks(load((2022, 2023, 2024, 2025)), pred_fn("composite")), key=lambda x: -x["e"])
    for lab, frac in (("all", 1), ("top 25%", .25), ("top 10%", .10), ("top 5%", .05)):
        sub = ps[:int(len(ps) * frac)]; k, n = sum(x["win"] for x in sub), len(sub); lo, hi = wilson(k, n)
        res[f"picks|{lab}"] = dict(k=k, n=n); print(f"   {lab:8s} {k}/{n} = {k / n * 100:.1f}% [{lo * 100:.0f}, {hi * 100:.0f}]")
    e = [x["e"] for x in ps]; w = [1 if x["win"] else 0 for x in ps]; me, mw = st.mean(e), st.mean(w)
    r_ = sum((a - me) * (b - mw) for a, b in zip(e, w)) / len(e) / (st.pstdev(e) * st.pstdev(w))
    res["corr"] = r_; print(f"   r(edge size, win) = {r_:+.3f}")
    es = sorted((x["e"] for x in picks(load((2022, 2023)), pred_fn("composite"))), reverse=True); cut = es[len(es) // 10]
    line = f"\n4. frozen top-10% rule from 2022-23, cutoff {cut:.2f}"
    for s in (2024, 2025):
        sub = [x for x in picks(load((s,)), pred_fn("composite")) if x["e"] >= cut]
        k, n = sum(x["win"] for x in sub), len(sub); lo, hi = wilson(k, n)
        res[f"frozen|{s}"] = dict(cut=cut, k=k, n=n); line += f" | {s}: {k}/{n} = {k / n * 100:.1f}% [{lo * 100:.0f}, {hi * 100:.0f}]"
    print(line)
    (RUN / "grade.json").write_text(json.dumps(res, indent=1))
    print(f"\nwrote {(RUN / 'grade.json').relative_to(REPO)}")


if __name__ == "__main__":
    main()
