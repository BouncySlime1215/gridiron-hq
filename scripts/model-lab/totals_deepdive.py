#!/usr/bin/env python3
"""
TOTALS DEEP DIVE — EXPLORATORY (not preregistered). Nick: "look into totals".
Every cut is shown for discovery seasons 2023-24 (nested fits on earlier
seasons) and for 2025 side by side. Many cuts are examined, so a single
cut that looks good is NOT a finding; consistency across 2025 and across
independent models is the bar. Output: model-lab/totals-deepdive.json
"""
import json, math, os, statistics as st, sqlite3
from collections import defaultdict
os.environ["EXTRA_PREDS"] = "../../docs/evidence/2026-09-16/model-lab/kmulti-preds.jsonl"
import lab, wired
lab.WITH_WIRED = True

MODELS = ["kmulti_full_total", "kalman_total", "pace_total", "dynamic_state", "blend_total", "weather_total", "sim_total", "wired_W7_total"]
rows = lab.load_table()
mk = lab.Market("totals")
key = lambda r: (r["season"], r["week"], r["home"])
ol = {(r["season"], r["week"], r["home"]): r for r in map(json.loads, open("../../docs/evidence/2026-09-16/opener-lab/table.jsonl")) if r["market"] == "totals"}
gs = wired.games(); venue = wired.w3_venue(gs); weather = wired.w5_weather()
con = sqlite3.connect(f"file:{lab.LIVE}?mode=ro", uri=True)
roof = {(s, w, t): (r or "").lower() for s, w, t, r in con.execute("SELECT season, week, team, roof FROM game_lines WHERE home=1 AND season BETWEEN 2022 AND 2025")}

def bets_for(name, method="A"):
    out = {}
    for S in (2023, 2024, 2025):
        train, test = lab.season_split(rows, S); test = [r for r in test if mk.ok(r)]
        base = mk.baseline([r for r in train if mk.ok(r)])
        for r, pos, a, extra in lab.adjusted(mk, lab.per_forecaster(method, name, mk, train, test)[0], base):
            out[key(r)] = dict(r=r, over=pos, adj=a, raw=mk.raw_clv(r, pos), lean=extra)
    return out

def summ(bs):
    if len(bs) < 20: return dict(n=len(bs))
    cz = lab.clustered_z([(b["r"], b["over"], b["adj"], 0) for b in bs])
    if cz["mean"] is None: return dict(n=len(bs))
    res = [mk.result(b["r"], b["over"]) for b in bs]; res = [x for x in res if x is not None]
    return dict(n=len(bs), adj=round(cz["mean"], 3), z=round(cz["z"], 2) if cz["z"] else None, win=round(100 * sum(res) / len(res), 1), under_share=round(100 * sum(not b["over"] for b in bs) / len(bs)))

def show(label, cuts, bets):
    print(f"\n## {label}")
    print(f"{'cut':34s} | {'dev n':>5s} {'adjCLV':>7s} {'z':>6s} {'win%':>5s} {'%under':>6s} | {'25 n':>5s} {'adjCLV':>7s} {'z':>6s} {'win%':>5s}")
    out = {}
    for cname, fn in cuts:
        d = summ([b for k, b in bets.items() if b["r"]["season"] in (2023, 2024) and fn(k, b)])
        h = summ([b for k, b in bets.items() if b["r"]["season"] == 2025 and fn(k, b)])
        out[cname] = dict(dev=d, holdout=h)
        f = lambda x: f"{x:>7}" if x is not None else "      -"
        print(f"{cname:34s} | {d.get('n',0):5d} {f(d.get('adj'))} {f(d.get('z'))} {f(d.get('win'))} {f(d.get('under_share'))} | {h.get('n',0):5d} {f(h.get('adj'))} {f(h.get('z'))} {f(h.get('win'))}")
    return out

report = {}
# 0. market drift by season
print("## Totals open->close drift by season (mean close - open; negative = totals fall)")
for S in (2022, 2023, 2024, 2025):
    v = [r["close_total"] - r["open_total"] for r in rows if r["season"] == S and mk.ok(r)]
    print(f"  {S}: mean {st.mean(v):+.3f}  share down {100*sum(x<0 for x in v)/len(v):.0f}%  share up {100*sum(x>0 for x in v)/len(v):.0f}%  n {len(v)}")
    report[f"drift_{S}"] = st.mean(v)

B = {m: bets_for(m) for m in MODELS}
# 1. per model, by side
print("\n## Per model, method A, by side bet (adjusted CLV already removes the under drift)")
for m in MODELS:
    show(m, [("all", lambda k, b: True), ("over bets", lambda k, b: b["over"]), ("under bets", lambda k, b: not b["over"])], B[m])
# 2. agreement across independent prior-week models (exclude blend, weather, sim)
IND = ["kmulti_full_total", "kalman_total", "pace_total", "dynamic_state", "wired_W7_total"]
agree = {}
for k in B["kmulti_full_total"]:
    sides = [B[m][k]["over"] for m in IND if k in B[m]]
    if len(sides) >= 4:
        agree[k] = (sum(sides), len(sides))
def agree_cut(n_needed):
    return lambda k, b: k in agree and max(agree[k][0], agree[k][1] - agree[k][0]) >= n_needed and (b["over"] == (agree[k][0] * 2 >= agree[k][1]))
report["agreement"] = show("kmulti bets by how many of 5 independent models agree with the side", [(f">= {n} of 5 agree", agree_cut(n)) for n in (3, 4, 5)], B["kmulti_full_total"])
# 3. segments on the kmulti and K2 bets
def seg(bets, label):
    c = lambda f: (lambda k, b: ol.get(k) is not None and f(ol[k], b))
    cuts = [("total < 42", c(lambda o, b: o["size"] < 42)), ("total 42-46.5", c(lambda o, b: 42 <= o["size"] <= 46.5)), ("total >= 47", c(lambda o, b: o["size"] >= 47)),
            ("opener on key (41/44/47/51)", c(lambda o, b: o["key_number"])),
            ("weeks 1-4", c(lambda o, b: o["week"] <= 4)), ("weeks 5-13", c(lambda o, b: 5 <= o["week"] <= 13)), ("weeks 14+", c(lambda o, b: o["week"] >= 14)),
            ("divisional", c(lambda o, b: o["div"])), ("primetime", c(lambda o, b: o["primetime"])),
            ("dome/closed roof", lambda k, b: roof.get(k) in ("dome", "closed")), ("outdoors", lambda k, b: roof.get(k) in ("outdoors", "open")),
            ("wind fcst >= 20 km/h (IN-WEEK info)", lambda k, b: (weather.get(k) or {}).get("wind_kmh", 0) >= 20),
            ("|lean| top quartile", None), ("|lean| bottom half", None),
            ("pre-open book dispersion top third", c(lambda o, b: o["dispersion_pre"] is not None and o["dispersion_pre"] >= 0.75))]
    leans = sorted(b["lean"] for b in bets.values() if b["r"]["season"] < 2025)
    q75, q50 = leans[int(0.75 * len(leans))], leans[len(leans) // 2]
    cuts = [(n, (lambda k, b: b["lean"] >= q75) if n.startswith("|lean| top") else (lambda k, b: b["lean"] < q50) if n.startswith("|lean| bottom") else f) for n, f in cuts]
    return show(label, cuts, bets)
report["seg_kmulti"] = seg(B["kmulti_full_total"], "Segments — kmulti_full_total bets")
report["seg_k2"] = seg(B["kalman_total"], "Segments — kalman_total (K2) bets")
# 4. book pricing on totals vs spreads: dispersion and best-line gain
print("\n## Cross-book opener dispersion (pre-open books), totals vs spreads")
for mkt in ("totals", "spreads"):
    v = [r["dispersion_pre"] for r in map(json.loads, open("../../docs/evidence/2026-09-16/opener-lab/table.jsonl")) if r["market"] == mkt and r["dispersion_pre"] is not None]
    print(f"  {mkt}: median {st.median(v):.2f} pts, mean {st.mean(v):.2f}, n {len(v)}")
json.dump(report, open("../../docs/evidence/2026-09-16/model-lab/totals-deepdive.json", "w"), indent=1, default=float)
