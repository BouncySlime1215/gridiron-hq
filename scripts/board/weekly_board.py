#!/usr/bin/env python3
"""
WEEKLY BOARD — every candidate bet for the next slate with an honest win probability.

Confidence is NOT the model's own conviction (shown to carry no information).
For each bet:  p = no-vig probability of our side at the best available book
                 + key-number value of the best line versus the cross-book consensus
                 + the strategy's measured out-of-sample CLV gain (2023-2025), in probability
EV and quarter-Kelly stake follow from p and the price. Spreads carry a measured
model gain of zero; the mid-range totals rule carries its measured gain; props
carry none (week-1 calibration failed) and no week-2 prop lines are captured.
Timing section: Kalshi-implied margin vs sportsbook consensus (descriptive).
Usage: python3 scripts/board/weekly_board.py   -> docs/board/<season>-week<N>.md/.json
"""
import json, math, os, sqlite3, statistics as st, sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import NormalDist
REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts/model-lab")); sys.path.insert(0, str(REPO / "scripts/opener-lab"))
os.environ["EXTRA_PREDS"] = str(REPO / "docs/evidence/2026-09-16/model-lab/kmulti-preds.jsonl")
import lab, clv_kelly
from level3 import CODE
LAB = REPO / "docs/evidence/2026-09-16/model-lab"
KELLY_MULT, KELLY_CAP = 0.25, 0.05
MID = (42.0, 46.5)

def payout(p): return p / 100 if p > 0 else 100 / -p
def novig(pa, pb):
    ia, ib = 1 / (1 + payout(pa)), 1 / (1 + payout(pb)); return ia / (ia + ib)
def ts(x): return datetime.fromisoformat(x.replace("Z", "+00:00"))

con = sqlite3.connect(f"file:{lab.LIVE}?mode=ro", uri=True)
season, week = con.execute("SELECT season, MIN(week) FROM game_lines WHERE team_score IS NULL AND spread IS NOT NULL AND season=(SELECT MAX(season) FROM game_lines WHERE team_score IS NOT NULL)").fetchone()
slate = {(h, a): dict(home=h, away=a, gameday=gd, gametime=gt, ko=ko) for h, a, gd, gt, ko in con.execute(
    "SELECT team, opponent, gameday, gametime, gameday || 'T' || COALESCE(gametime,'13:00') FROM game_lines WHERE season=? AND week=? AND home=1", (season, week))}
days = sorted({g["gameday"] for g in slate.values()})
# latest quote per (game, book, market, side) from the intraday snapshot table
q = defaultdict(dict)
latest_cap = con.execute("SELECT MAX(captured_at) FROM nfl_line_snapshots").fetchone()[0]
FRESH_H = 36   # a quote older than this is a stale line, not a bettable one (a May opener still sat on one book)
fresh_after = (ts(latest_cap).timestamp() - FRESH_H * 3600)
for cap, ko, hn, an, book, market, side, line, price in con.execute(
        """SELECT captured_at, commence_time, home_team, away_team, book, market, side, line, price FROM nfl_line_snapshots
           WHERE market IN ('spreads','totals') AND line IS NOT NULL AND price IS NOT NULL AND substr(commence_time,1,10) BETWEEN ? AND ? ORDER BY captured_at""", (days[0], days[-1])):
    if hn not in CODE or an not in CODE or ts(cap).timestamp() < fresh_after: continue
    k = (CODE[hn], CODE[an])
    if k not in slate: continue
    s = ("home" if side == hn else "away") if market == "spreads" else side.lower()
    q[k][(book, market, s)] = dict(line=line, price=price, t=cap)
# Kalshi latest per game
kal = {}
for cap, ticker, yes, no, ek in con.execute("SELECT captured_at, ticker, yes_price, no_price, event_key FROM prediction_market_quotes WHERE ticker LIKE 'KXNFLGAME-%' AND yes_price IS NOT NULL ORDER BY captured_at"):
    a, h = (ek or "@").split("@")
    if (h, a) in slate and ticker.endswith("-" + h):
        p = min(max((yes + (1 - no)) / 2 if no is not None else yes, 0.02), 0.98)
        kal[(h, a)] = dict(p=p, margin=13.45 * NormalDist().inv_cdf(p), t=cap)
# model predictions for the slate
km = {(r["home"], r["away"]): r for r in map(json.loads, open(LAB / "kmulti-preds.jsonl")) if r.get("upcoming") and r["season"] == season and r["week"] == week}
ka = {(r["home"], r["away"]): r for r in map(json.loads, open(LAB / "kalman-upcoming.jsonl")) if r["season"] == season and r["week"] == week}
# method-A conversions and the totals rule's measured gain, from 2022-2025
rows = lab.load_table(); mk_t, mk_s = lab.Market("totals"), lab.Market("spreads")
fitA = {}
for name, mk in (("kmulti_full_total", mk_t), ("kmulti_full", mk_s)):
    tr = [r for r in rows if r["season"] >= 2022 and name in mk.preds(r)]
    fitA[name] = lab.ols([mk.preds(r)[name] for r in tr], [mk.actual(r) for r in tr])
G = clv_kelly.Grader(rows)
gains = {}
for label, mk, name, keep in (("totals_mid", mk_t, "kmulti_full_total", lambda r: MID[0] <= r["open_total"] <= MID[1]),
                              ("totals_all", mk_t, "kmulti_full_total", lambda r: True), ("spreads", mk_s, "kmulti_full", lambda r: True)):
    recs = []
    for S in (2023, 2024, 2025):
        train, test = lab.season_split(rows, S); test = [r for r in test if mk.ok(r) and keep(r)]
        for r, pos, _ in lab.per_forecaster("A", name, mk, train, test)[0]:
            x = G.bet(mk, r, pos, "reference")
            if x: recs.append(x["clv_prob"])
    gains[label] = dict(n=len(recs), gain_pp=100 * st.mean(recs))
gain_total = max(0.0, gains["totals_mid"]["gain_pp"] / 100)      # only the measured, nested, 2023-25 record
pmf = {m: lab.keynumber_pmf(m) for m in ("spreads", "totals")}
base = {m: lab.cover_prob(pmf[m], 0.0) for m in pmf}

bets, watch = [], []
for k, g in sorted(slate.items(), key=lambda kv: (kv[1]["gameday"], kv[1]["gametime"] or "")):
    h, a = k; quotes = q.get(k, {}); books = {b for (b, m, s) in quotes}
    row = dict(game=f"{a} @ {h}", kickoff=g["ko"], books=len(books))
    # consensus lines (median across books of latest quotes)
    hs = [v["line"] for (b, m, s), v in quotes.items() if m == "spreads" and s == "home"]
    tt = [v["line"] for (b, m, s), v in quotes.items() if m == "totals" and s == "over"]
    cons_spread = st.median(hs) if hs else None; cons_total = st.median(tt) if tt else None
    # a quote more than 3 pts from the consensus is a mislabeled or dead line, not a bettable one
    quotes = {kk: v for kk, v in quotes.items() if abs(v["line"] - ((cons_spread if kk[2] == "home" else -cons_spread) if kk[1] == "spreads" else cons_total)) <= 3}
    # ---- totals
    if k in km and tt:
        f = fitA["kmulti_full_total"]; pred = f["a"] + f["b"] * km[k]["kmulti_full_total"]
        over = pred > cons_total
        side = "over" if over else "under"
        cands = [(b, v) for (b, m, s), v in quotes.items() if m == "totals" and s == side]
        best = (min if over else max)(cands, key=lambda bv: (bv[1]["line"], -bv[1]["price"] if over else bv[1]["price"]))
        b, v = best
        p0 = 0.5   # at the consensus line the two sides are even by construction; the price we pay enters through EV
        shop = (cons_total - v["line"]) if over else (v["line"] - cons_total)
        p = min(max(p0 + (lab.cover_prob(pmf["totals"], -round(shop * 2) / 2) - base["totals"]) + (gain_total if MID[0] <= v["line"] <= MID[1] else 0.0), 0.01), 0.99)
        bb = payout(v["price"]); ev = p * bb - (1 - p); f_k = min(KELLY_CAP, KELLY_MULT * max(0.0, ev / bb))
        bets.append(dict(market="total", game=row["game"], kickoff=g["ko"], pick=f"{side} {v['line']}", book=b, price=v["price"], model=round(pred, 1), consensus=cons_total,
                         in_rule=MID[0] <= v["line"] <= MID[1], p=round(100 * p, 1), ev_pct=round(100 * ev, 2), kelly_pct=round(100 * f_k, 2)))
    # ---- spreads (model gain measured at zero; shown for shopping only)
    if k in km and hs:
        f = fitA["kmulti_full"]; pred = f["a"] + f["b"] * km[k]["kmulti_full_margin"]; k1 = ka.get(k, {}).get("kalman_score")
        home = pred > -cons_spread
        side = "home" if home else "away"
        cands = [(b, v) for (b, m, s), v in quotes.items() if m == "spreads" and s == side]
        best = max(cands, key=lambda bv: (bv[1]["line"], bv[1]["price"]))
        b, v = best
        p0 = 0.5
        shop = v["line"] - (cons_spread if home else -cons_spread)
        p = min(max(p0 + (lab.cover_prob(pmf["spreads"], -round(shop * 2) / 2) - base["spreads"]), 0.01), 0.99)
        bb = payout(v["price"]); ev = p * bb - (1 - p); f_k = min(KELLY_CAP, KELLY_MULT * max(0.0, ev / bb))
        bets.append(dict(market="spread", game=row["game"], kickoff=g["ko"], pick=f"{h if home else a} {v['line']:+g}", book=b, price=v["price"], model=round(pred, 1),
                         model_k1=None if k1 is None else round(k1, 1), consensus=-cons_spread, in_rule=False, p=round(100 * p, 1), ev_pct=round(100 * ev, 2), kelly_pct=round(100 * f_k, 2)))
    # ---- timing watch
    if k in kal and cons_spread is not None:
        gap = kal[k]["margin"] - (-cons_spread)
        watch.append(dict(game=row["game"], kalshi_home_p=round(kal[k]["p"], 3), kalshi_margin=round(kal[k]["margin"], 1), consensus_margin=-cons_spread, gap=round(gap, 1), flag=abs(gap) >= 1.0, kalshi_at=kal[k]["t"]))

now = datetime.now(timezone.utc).isoformat(timespec="minutes")
out = dict(generated=now, season=season, week=week, measured_gains_pp=gains, totals_rule_gain_pp=round(100 * gain_total, 2), bets=bets, timing=watch,
           props="No week-%d prop lines captured (last Underdog capture 2026-09-07). Week-1 real-market check: 1,149 settled bets, 50.0%% wins, 0 CLV, model probabilities uncalibrated. No prop bets." % week)
(REPO / "docs/board").mkdir(exist_ok=True)
json.dump(out, open(REPO / f"docs/board/{season}-week{week}.json", "w"), indent=1)
L = [f"# Gridiron HQ board — {season} week {week}", f"Generated {now}. Quotes captured within {FRESH_H} h of {latest_cap[:16]}Z. Confidence = 50% at the consensus line + key-number value of the best line vs consensus + measured model gain only; the price paid enters EV.",
     f"Measured model gains (2023-25, nested, at the reference opener): totals mid-range {gains['totals_mid']['gain_pp']:+.2f} pp (n {gains['totals_mid']['n']}), totals all {gains['totals_all']['gain_pp']:+.2f} pp, spreads {gains['spreads']['gain_pp']:+.2f} pp (spreads gain applied as 0).", ""]
for mkt, title in (("total", "Totals"), ("spread", "Spreads (no measured model edge; shopping only)")):
    L += [f"## {title}", "| Game | Kick | Pick | Book | Price | Model | Consensus | In rule | Win % | EV % | Kelly % |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for b in sorted([b for b in bets if b["market"] == mkt], key=lambda b: -b["ev_pct"]):
        L.append(f"| {b['game']} | {b['kickoff'][5:16]} | {b['pick']} | {b['book']} | {b['price']:+d} | {b['model']} | {b['consensus']} | {'yes' if b['in_rule'] else ''} | {b['p']} | {b['ev_pct']:+.2f} | {b['kelly_pct']:.2f} |")
    L.append("")
L += ["## Props", out["props"], "", "## Timing watch — Kalshi vs sportsbook consensus (descriptive; 2-3 h lead seen on 36 games)", "| Game | Kalshi home win % | Kalshi-implied margin | Consensus margin | Gap | Flag |", "|---|---|---|---|---|---|"]
for w in sorted(watch, key=lambda w: -abs(w["gap"])):
    L.append(f"| {w['game']} | {100*w['kalshi_home_p']:.0f} | {w['kalshi_margin']:+.1f} | {w['consensus_margin']:+.1f} | {w['gap']:+.1f} | {'WATCH' if w['flag'] else ''} |")
(REPO / f"docs/board/{season}-week{week}.md").write_text("\n".join(L) + "\n")
print("\n".join(L))
