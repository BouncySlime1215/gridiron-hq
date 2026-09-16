#!/usr/bin/env python3
"""
Walk-forward point conversion for the four survivor signals.

WHY (2026-09-16, Nick: "ok do that"). Checked against real final margins,
opp_adjusted's predictions are about twice too large in every season (slope
0.41-0.58, 6-7 standard errors from 1.0): its x65 multiplier was hand-picked
and never fitted. epa_net and second_half_eff use a conversion fitted once on
pre-2022 seasons and never updated. dynamic_state is in points natively.

RULE, FIXED BEFORE ANY RESULT WAS SEEN:
  For every game, using ONLY games from earlier weeks (from 2021 on, the
  first season in the saved predictions), fit
      actual_margin = a + b * saved_prediction
  by least squares with a prior pulling a -> 0 and b -> 1 worth 100 games
  (i.e. "no change" until the data says otherwise). The recalibrated
  prediction is a + b * prediction. Composite = mean of the four.
  Because every saved prediction is already a linear function of its raw
  differential, refitting a line on the saved prediction is equivalent to
  refitting it on the raw input (up to the week-varying home-field term).

WHAT COUNTS AS BETTER (judged out of sample, 2022-2025, each game scored
only by a fit that never saw it):
  1. calibration slope of actual on recalibrated prediction closer to 1.0
  2. mean absolute error not worse
The opener-CLV, confident-pick and frozen-rule re-tests are reported on
REPAIRED openers (migration 055) with suspect games excluded. 2025 is the
holdout: the four signals were selected on 2022-24.

Usage: python3 scripts/walk-forward-recalibration.py
"""
import json, math, statistics as st
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
EV = REPO / "docs/evidence/2026-09-16"
SIG = ["epa_net", "second_half_eff", "opp_adjusted", "dynamic_state"]
PRIOR_GAMES = 100
SUSPECT = "suspect_pinnacle_placeholder_unresolved_2022_2025"
repaired = {(g["season"], g["week"], g["home"]): g for g in
            json.load(open(EV / "opener-repair/repaired-openers.json"))["games"]}


def load():
    rows = []
    for s in (2021, 2022, 2023, 2024, 2025):
        for line in open(EV / f"opener-clv/games-{s}.jsonl"):
            r = json.loads(line)
            r["_s"] = s
            r["_c"] = {c["id"]: c["pred"] for c in (r.get("components") or []) if c["pred"] is not None}
            rows.append(r)
    rows.sort(key=lambda r: (r["_s"], r["week"]))
    return rows


def shrunk_line(xs, ys, k=PRIOR_GAMES):
    """Least squares a + b x with pseudo-observations pulling toward a=0, b=1.
    Implemented as ridge on (a, b-1): minimise sum (y - x - a - c x)^2
    + k*var(x)*c^2 + k*a^2 / n-scale, solved in closed form."""
    n = len(xs)
    if n == 0:
        return 0.0, 1.0
    r = [y - x for x, y in zip(xs, ys)]          # residual vs identity
    sx, sxx = sum(xs), sum(x * x for x in xs)
    sr, sxr = sum(r), sum(x * y for x, y in zip(xs, r))
    vx = max(sxx / n - (sx / n) ** 2, 1e-9)
    la, lc = float(k), float(k) * vx             # prior worth k games on each
    # normal equations for [a, c]
    A11, A12, A22 = n + la, sx, sxx + lc
    det = A11 * A22 - A12 * A12
    a = (A22 * sr - A12 * sxr) / det
    c = (A11 * sxr - A12 * sr) / det
    return a, 1.0 + c


def recalibrate(rows):
    """Adds r['_rc'][signal] for 2022+ games, each fit on earlier weeks only."""
    weeks = sorted({(r["_s"], r["week"]) for r in rows})
    fits = {}
    for (s, w) in weeks:
        if s < 2022:
            continue
        prior = [r for r in rows if (r["_s"], r["week"]) < (s, w)]
        f = {}
        for k in SIG:
            xs = [r["_c"][k] for r in prior if k in r["_c"]]
            ys = [r["actual_margin"] for r in prior if k in r["_c"]]
            f[k] = shrunk_line(xs, ys)
        fits[(s, w)] = f
        for r in rows:
            if (r["_s"], r["week"]) == (s, w):
                r["_rc"] = {k: f[k][0] + f[k][1] * r["_c"][k] for k in SIG if k in r["_c"]}
    return fits


def composite(d):
    return sum(d[k] for k in SIG) / 4 if all(k in d for k in SIG) else None


def slope(xs, ys):
    mx, my = st.mean(xs), st.mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    se = (sum((y - (my + b * (x - mx))) ** 2 for x, y in zip(xs, ys)) / (len(xs) - 2) / sxx) ** .5
    return b, se


def wilson(k, n, z=1.96):
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - h) / d, (c + h) / d


def graded(rows, seasons):
    out = []
    for r in rows:
        if r["_s"] not in seasons or "_rc" not in r:
            continue
        rep = repaired.get((r["_s"], r["week"], r["home"]))
        if rep is None or rep["open_spread_source"] == SUSPECT:
            continue
        out.append(dict(r, open_spread=rep["open_spread"]))
    return out


def clv(rows, fn):
    base = {}
    for side in ("home", "away"):
        for role in ("fav", "dog"):
            v = []
            for r in rows:
                o, c = r["open_spread"], r["close_spread"]
                if o == 0:
                    continue
                bh = side == "home"
                if ("fav" if (bh and o < 0) or (not bh and o > 0) else "dog") != role:
                    continue
                v.append((o if bh else -o) - (c if bh else -c))
            base[(side, role)] = st.mean(v)
    vals, cl = [], {}
    for r in rows:
        p = fn(r)
        if p is None or r["open_spread"] == 0:
            continue
        o, c = r["open_spread"], r["close_spread"]
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
    return m, m / se


def picks(rows, fn):
    out = []
    for r in rows:
        p = fn(r)
        if p is None:
            continue
        o = r["open_spread"]; lean = p + o; mm = r["actual_margin"] + o
        if abs(lean) < 1e-9 or mm == 0:
            continue
        out.append(dict(e=abs(lean), win=(lean > 0) == (mm > 0), s=r["_s"]))
    return out


def main():
    rows = load()
    fits = recalibrate(rows)
    res = {"rule": f"walk-forward shrunk line, prior {PRIOR_GAMES} games", "fits_sample": {}}
    for key in [(2022, 1), (2023, 1), (2024, 1), (2025, 1), (2025, 18)]:
        if key in fits:
            res["fits_sample"][f"{key[0]}|{key[1]}"] = {k: [round(v[0], 3), round(v[1], 3)] for k, v in fits[key].items()}
    print("fitted conversion before selected weeks  (a = points added, b = multiplier):")
    for k, v in res["fits_sample"].items():
        print("  ", k, v)

    ev = [r for r in rows if "_rc" in r]
    print("\n1. OUT-OF-SAMPLE calibration slope (want 1.0) and mean absolute error, frozen -> walk-forward")
    for name in SIG + ["composite"]:
        line = f"   {name:16s}"
        for s in (2022, 2023, 2024, 2025):
            sub = [r for r in ev if r["_s"] == s]
            if name == "composite":
                pairs_f = [(composite(r["_c"]), r["actual_margin"]) for r in sub if composite(r["_c"]) is not None]
                pairs_r = [(composite(r["_rc"]), r["actual_margin"]) for r in sub if composite(r["_rc"]) is not None]
            else:
                pairs_f = [(r["_c"][name], r["actual_margin"]) for r in sub if name in r["_c"]]
                pairs_r = [(r["_rc"][name], r["actual_margin"]) for r in sub if name in r["_rc"]]
            bf, _ = slope(*zip(*pairs_f)); br, se = slope(*zip(*pairs_r))
            mf = st.mean(abs(x - y) for x, y in pairs_f); mr = st.mean(abs(x - y) for x, y in pairs_r)
            line += f" | {s}: b {bf:.2f}->{br:.2f}  MAE {mf:.2f}->{mr:.2f}"
            res[f"calib|{name}|{s}"] = dict(slope_frozen=bf, slope_wf=br, se=se, mae_frozen=mf, mae_wf=mr)
        print(line)

    print("\n2. Opener CLV on REPAIRED openers (double-adjusted, week-clustered z), frozen -> walk-forward")
    for pool in ((2022, 2023, 2024), (2025,), (2022, 2023, 2024, 2025)):
        g = graded(rows, pool)
        tag = "-".join(str(s) for s in pool)
        for name in ["composite"] + SIG:
            ff = (lambda r: composite(r["_c"])) if name == "composite" else (lambda r, n=name: r["_c"].get(n))
            fr = (lambda r: composite(r["_rc"])) if name == "composite" else (lambda r, n=name: r["_rc"].get(n))
            mf, zf = clv(g, ff); mr, zr = clv(g, fr)
            print(f"   {tag:19s} {name:16s} {mf:+.3f} z{zf:+.2f}  ->  {mr:+.3f} z{zr:+.2f}")
            res[f"clv|{tag}|{name}"] = dict(frozen=[mf, zf], wf=[mr, zr])

    print("\n3. Composite's most confident picks, ATS at repaired opener, 2022-2025")
    g = graded(rows, (2022, 2023, 2024, 2025))
    for label, fn in (("frozen", lambda r: composite(r["_c"])), ("walk-forward", lambda r: composite(r["_rc"]))):
        ps = sorted(picks(g, fn), key=lambda x: -x["e"])
        out = []
        for lab, frac in (("all", 1), ("top 25%", .25), ("top 10%", .10)):
            sub = ps[:int(len(ps) * frac)]
            k, n = sum(x["win"] for x in sub), len(sub)
            lo, hi = wilson(k, n)
            out.append(f"{lab} {k}/{n}={k / n * 100:.1f}% [{lo * 100:.0f},{hi * 100:.0f}]")
            res[f"picks|{label}|{lab}"] = dict(k=k, n=n)
        e = [x["e"] for x in ps]; w = [1 if x["win"] else 0 for x in ps]
        me, mw = st.mean(e), st.mean(w)
        rr = sum((a - me) * (b - mw) for a, b in zip(e, w)) / len(e) / (st.pstdev(e) * st.pstdev(w))
        print(f"   {label:12s} " + " | ".join(out) + f" | r(edge,win)={rr:+.3f}")
        res[f"corr|{label}"] = rr

    print("\n4. Frozen top-10% cutoff learned on 2022-23, applied unchanged to 2024 and 2025")
    for label, fn in (("frozen", lambda r: composite(r["_c"])), ("walk-forward", lambda r: composite(r["_rc"]))):
        es = sorted((x["e"] for x in picks(graded(rows, (2022, 2023)), fn)), reverse=True)
        cut = es[len(es) // 10]
        line = f"   {label:12s} cutoff {cut:.2f}"
        for s in (2024, 2025):
            sub = [x for x in picks(graded(rows, (s,)), fn) if x["e"] >= cut]
            k, n = sum(x["win"] for x in sub), len(sub)
            lo, hi = wilson(k, n)
            line += f" | {s}: {k}/{n}={k / n * 100:.1f}% [{lo * 100:.0f},{hi * 100:.0f}]"
            res[f"frozen_rule|{label}|{s}"] = dict(cut=cut, k=k, n=n)
        print(line)

    out = EV / "opener-repair/walk-forward-recalibration.json"
    out.write_text(json.dumps(res, indent=1))
    print(f"\nwrote {out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
