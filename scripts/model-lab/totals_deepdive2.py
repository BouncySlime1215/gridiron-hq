#!/usr/bin/env python3
"""TOTALS DEEP DIVE 2 — EXPLORATORY. Digs into the mid-range (42-46.5) totals signal from totals_deepdive.py.
All cuts are post-hoc; 2025 shown beside 2023-24 everywhere. Output: model-lab/totals-deepdive2.json"""
import json, math, os, statistics as st
from collections import defaultdict
os.environ["EXTRA_PREDS"] = "../../docs/evidence/2026-09-16/model-lab/kmulti-preds.jsonl"
import lab, clv_kelly
lab.WITH_WIRED = True
rows = lab.load_table(); mk = lab.Market("totals"); key = lambda r: (r["season"], r["week"], r["home"])
G = clv_kelly.Grader(rows)
def bets_for(name, method="A", seasons=(2023, 2024, 2025)):
    out = {}
    for S in seasons:
        train, test = lab.season_split(rows, S); test = [r for r in test if mk.ok(r)]
        base = mk.baseline([r for r in train if mk.ok(r)])
        for r, pos, a, extra in lab.adjusted(mk, lab.per_forecaster(method, name, mk, train, test)[0], base):
            out[key(r)] = dict(r=r, over=pos, adj=a, lean=extra, pred=mk.preds(r)[name])
    return out
def summ(bs):
    if len(bs) < 20: return dict(n=len(bs))
    cz = lab.clustered_z([(b["r"], b["over"], b["adj"], 0) for b in bs])
    if cz["mean"] is None: return dict(n=len(bs))
    res = [mk.result(b["r"], b["over"]) for b in bs]; res = [x for x in res if x is not None]
    return dict(n=len(bs), adj=round(cz["mean"], 3), z=round(cz["z"], 2), win=round(100 * sum(res) / len(res), 1))
def table(label, cuts, bets):
    print(f"\n## {label}"); out = {}
    for c, fn in cuts:
        d = summ([b for b in bets.values() if b["r"]["season"] < 2025 and fn(b)]); h = summ([b for b in bets.values() if b["r"]["season"] == 2025 and fn(b)])
        out[c] = dict(dev=d, holdout=h); f = lambda x: f"{x:>7}" if x is not None else "      -"
        print(f"  {c:40s} | dev n {d.get('n',0):4d} {f(d.get('adj'))} z {f(d.get('z'))} win {f(d.get('win'))} | 25 n {h.get('n',0):4d} {f(h.get('adj'))} z {f(h.get('z'))} win {f(h.get('win'))}")
    return out
mid = lambda b: 42 <= b["r"]["open_total"] <= 46.5
report = {}
K = bets_for("kmulti_full_total")
# 1. side and lean within mid-range
report["side"] = table("Mid-range 42-46.5, kmulti: by side and by lean size", [
    ("over bets", lambda b: mid(b) and b["over"]), ("under bets", lambda b: mid(b) and not b["over"]),
    ("lean < 1 pt", lambda b: mid(b) and b["lean"] < 1), ("lean 1-2 pts", lambda b: mid(b) and 1 <= b["lean"] < 2), ("lean >= 2 pts", lambda b: mid(b) and b["lean"] >= 2),
    ("opener on .5 (hook)", lambda b: mid(b) and b["r"]["open_total"] % 1 == 0.5), ("opener whole number", lambda b: mid(b) and b["r"]["open_total"] % 1 == 0),
    ("mid AND weeks 1-4", lambda b: mid(b) and b["r"]["week"] <= 4), ("mid AND weeks 5+", lambda b: mid(b) and b["r"]["week"] > 4)], K)
# 2. beat the CLOSE? actual total vs closing total, on the model's side, mid-range
print("\n## Does the model also beat the CLOSING total (actual vs close)?")
for label, fn in (("all totals", lambda b: True), ("mid-range", mid)):
    for per, seas in (("dev", (2023, 2024)), ("2025", (2025,))):
        bs = [b for b in K.values() if b["r"]["season"] in seas and fn(b)]
        res = [((b["r"]["actual_total"] > b["r"]["close_total"]) == b["over"]) for b in bs if b["r"]["actual_total"] != b["r"]["close_total"]]
        x = [b["pred"] - b["r"]["close_total"] for b in bs]; y = [b["r"]["actual_total"] - b["r"]["close_total"] for b in bs]
        mx, my = st.mean(x), st.mean(y); slope = sum((a - mx) * (c - my) for a, c in zip(x, y)) / sum((a - mx) ** 2 for a in x)
        print(f"  {label:10s} {per:5s} n {len(bs):4d}  win vs close {100*sum(res)/len(res):.1f}%  slope of (actual-close) on (pred-close) {slope:+.3f}")
        report[f"close|{label}|{per}"] = dict(n=len(bs), win_vs_close=sum(res) / len(res), slope=slope)
# 3. early-season mechanism: drift by week bucket and the model's over share
print("\n## Market drift and model side by week bucket (all totals)")
for lo, hi in ((1, 4), (5, 9), (10, 13), (14, 22)):
    for per, seas in (("dev", (2023, 2024)), ("2025", (2025,))):
        rs = [r for r in rows if r["season"] in seas and mk.ok(r) and lo <= r["week"] <= hi]
        bs = [b for b in K.values() if b["r"]["season"] in seas and lo <= b["r"]["week"] <= hi]
        print(f"  weeks {lo:2d}-{hi:2d} {per:5s}: mean close-open {st.mean(r['close_total']-r['open_total'] for r in rs):+.2f}  mean opener {st.mean(r['open_total'] for r in rs):.1f}  mean actual {st.mean(r['actual_total'] for r in rs):.1f}  model bets over {100*sum(b['over'] for b in bs)/len(bs):.0f}%  model mean pred-open {st.mean(b['pred']-b['r']['open_total'] for b in bs):+.2f}")
# 4. channel ablations within mid-range
fit = json.load(open("../../docs/evidence/2026-09-16/model-lab/kmulti-fit.json"))
print("\n## Total readout weights (standardized):", {c: round(w, 2) for c, w in zip(fit["total_cols"], fit["readouts"]["full_total"]["w"][1:])})
print("\n## Mid-range only: single channels and leave-one-out (method A)")
abl = {}
for name in [f"kmulti_{c}_total" for c in fit["total_cols"]] + [f"kmulti_minus_{c}_total" for c in fit["total_cols"]]:
    B = bets_for(name); d = summ([b for b in B.values() if b["r"]["season"] < 2025 and mid(b)]); h = summ([b for b in B.values() if b["r"]["season"] == 2025 and mid(b)])
    abl[name] = dict(dev=d, holdout=h); print(f"  {name:32s} dev {d.get('adj')} z {d.get('z')} | 25 {h.get('adj')} z {h.get('z')}")
report["ablation_mid"] = abl
# 5. which books offer the best mid-range totals line most often, and mid-range rule scorecard
print("\n## Proposed rule (kmulti A, openers 42-46.5): scorecard at reference and best book")
for variant in ("reference", "best_book"):
    by = {}
    for S in (2023, 2024, 2025):
        by[S] = [x for x in (G.bet(mk, b["r"], b["over"], variant) for b in K.values() if b["r"]["season"] == S and mid(b)) if x]
    dev, hold = clv_kelly.summarize(by[2023] + by[2024]), clv_kelly.summarize(by[2025]); kel = clv_kelly.kelly(by)
    report[f"rule|{variant}"] = dict(dev=dev, holdout=hold, kelly=kel)
    print(f"  {variant:9s} dev n {dev['n']} CLV {dev['clv']:+.2f} EV {dev['ev_pct']:+.2f}% z {dev['ev_z']:+.2f} win {dev['win_pct']:.1f}% ROI {dev['flat_roi_pct']:+.1f}% | 2025 n {hold['n']} EV {hold['ev_pct']:+.2f}% win {hold['win_pct']:.1f}% ROI {hold['flat_roi_pct']:+.1f}% | Kelly 2024 exp {kel[2024]['expected_growth_pct']:+.2f}% real {kel[2024]['realized_growth_pct']:+.2f}% ({kel[2024]['kelly_bets']} bets); 2025 exp {kel[2025]['expected_growth_pct']:+.2f}% real {kel[2025]['realized_growth_pct']:+.2f}% ({kel[2025]['kelly_bets']} bets)")
books = defaultdict(lambda: [0, 0.0])
for b in K.values():
    if not mid(b): continue
    bk = ((b["r"].get("books") or {}).get("totals") or {}).get("best_over" if b["over"] else "best_under")
    if bk: books[bk["book"]][0] += 1; books[bk["book"]][1] += abs(bk["line"] - b["r"]["open_total"])
print("\n## Which book had the best mid-range totals line for our side (count, mean points better than reference):")
for bk, (n, pts) in sorted(books.items(), key=lambda kv: -kv[1][0])[:8]: print(f"  {bk:14s} {n:4d}  {pts/n:+.2f}")
json.dump(report, open("../../docs/evidence/2026-09-16/model-lab/totals-deepdive2.json", "w"), indent=1, default=float)
