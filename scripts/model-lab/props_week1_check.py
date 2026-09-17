#!/usr/bin/env python3
"""First real-market check of the prop model: nfl_prop_clv, 2026 week 1, Underdog lines.
One row per unique bet (last capture before kickoff), modeled rows only. Output: model-lab/props-week1-check.json"""
import json, sqlite3, statistics as st
from collections import defaultdict
LIVE = "/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/data.sqlite"
con = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)
rows = con.execute("""SELECT event_id, player, market, side, line, american_price, model_probability, implied_probability, edge,
    clv_probability, settled, won, captured_at, commence_time FROM nfl_prop_clv WHERE season=2026 AND week=1 AND model_match_status='modeled' ORDER BY captured_at""").fetchall()
last = {}
for r in rows:
    if r[12] <= r[13]:
        last[r[:5]] = r
bets = [r for r in last.values() if r[10]]
wr = lambda bs: sum(b[11] for b in bs) / len(bs) if bs else None
out = dict(unique_settled=len(bets), win=wr(bets), clv_pp=100 * st.mean(b[9] for b in bets if b[9] is not None), by_market={}, calibration={}, by_edge={})
for m in sorted({b[2] for b in bets}):
    for s in ("Over", "Under"):
        bs = [b for b in bets if b[2] == m and b[3] == s]
        if bs:
            out["by_market"][f"{m}|{s}"] = dict(n=len(bs), model_p=st.mean(b[6] for b in bs), implied_p=st.mean(b[7] for b in bs), win=wr(bs))
bins = defaultdict(list)
for b in bets:
    bins[round(b[6] * 10) / 10].append(b)
out["calibration"] = {str(k): dict(pred=st.mean(b[6] for b in v), real=wr(v), n=len(v)) for k, v in sorted(bins.items())}
for lo, hi in ((-1, 0), (0, .03), (.03, .06), (.06, .1), (.1, 1)):
    bs = [b for b in bets if lo <= b[8] < hi]
    if bs:
        out["by_edge"][f"{lo}..{hi}"] = dict(n=len(bs), win=wr(bs), clv_pp=100 * st.mean(b[9] for b in bs if b[9] is not None))
best = {}
for b in bets:
    k = b[:3] + (b[4],)
    if k not in best or b[8] > best[k][8]:
        best[k] = b
bb = list(best.values()); top = [b for b in bb if b[8] >= .05]
out["best_side_per_line"] = dict(n=len(bb), win=wr(bb), edge_ge_5pct=dict(n=len(top), win=wr(top), clv_pp=100 * st.mean(b[9] for b in top if b[9] is not None)))
json.dump(out, open("docs/evidence/2026-09-16/model-lab/props-week1-check.json", "w"), indent=1)
print(json.dumps({k: out[k] for k in ("unique_settled", "win", "clv_pp", "best_side_per_line")}, indent=1))
