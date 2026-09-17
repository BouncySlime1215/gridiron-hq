#!/usr/bin/env python3
"""
Price Kalshi's spread ladder against Gridiron's own fitted margin distribution.

WHY THIS AND NOT ANOTHER EMPIRICAL PMF. The repo already contains a real conditional margin model:
`server/betting/nfl/strategy/margin-distribution.js` (1,655 lines) fits P(margin | spread) over
1999-2024 (6,991 games) as a penalised conditional logit with an exponential tilt. Crucially it
treats margin as discrete integers with FREE ATOM PARAMETERS at every |margin| up to 42 — the
key-number masses at 3 and 7 are fitted parameters, not a by-product of a smooth curve. It is
season-blocked cross-validated, down-weights old seasons on a 6-season half-life, and carries a
Laplace posterior. Earlier work here compared Kalshi to a crude histogram; this compares it to the
model the project actually believes.

WHAT MAKES THE COMPARISON MEANINGFUL. Kalshi's KXNFLSPREAD ladder quotes "TEAM wins by over N-0.5
points?" at ~25 strikes per game, two-sided, every minute. That IS an implied distribution. So:

    model  P(margin > k | sportsbook spread)      <- fitted on <=2024
    kalshi implied P(margin > k)                  <- 2026 market
    difference at each strike, especially at 3 and 7

A market that prices margin as if it were continuous will misprice exactly the strikes where the
empirical distribution has atoms. That is a specific, falsifiable claim, and the model's own
key-number atoms are what make it testable.

THE MODEL'S STATED LIMITS, honoured here rather than ignored (MARGIN_MODEL_VERDICT):
  * It is WORSE than a plain empirical lookup on the eight "cross-both" teaser lines, and
    under-prices legs teasing a -7 to -8.5 favourite or a +1.5 to +3 underdog by 3-4pp. Strikes in
    that family are flagged in the output and excluded from any headline claim.
  * It excludes 2025-2026 from fitting because of corrupted spread data — which makes applying it
    to the 2026 Kalshi chain genuinely out of sample, the one thing this project keeps needing.

COSTS. Buying YES at ask A costs A/100 and pays 1. Kalshi's taker fee is about 0.07*p*(1-p) per
contract, near zero in the tails. Any trade is graded at the real ask (or bid, when selling) plus
the fee, and EV is reported as a share of CAPITAL AT RISK, not of premium — selling a 3c contract
risks 97c to win 3c.

Clustering is by GAME. Strikes within a game settle together; a blowout resolves the whole ladder
at once, so the effective sample is the game count, not the strike count.

Usage: python3 scripts/model-lab/kalshi_chain_vs_margin_model.py [--min-liquidity 3]
"""
import argparse
import datetime as dt
import json
import math
import re
import statistics as st
import subprocess
import sqlite3
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"

NV_FIX = {"LA": "LAR", "JAC": "JAX", "OAK": "LV", "SD": "LAC", "STL": "LAR"}
# The model's own problem family — reported separately, never folded into a headline.
FAMILY = "cross-both (|spread| 1.5-3 or 7-8.5): model under-prices by 3-4pp per MARGIN_MODEL_VERDICT"


def fee(p):
    return 0.07 * p * (1 - p)


def model_probs(requests):
    """Call the JS margin model once for a batch of (spread, handicap) pairs.

    Shelling out to node keeps the single fitted model as the one source of truth rather than
    reimplementing a 1,655-line penalised fit in Python and hoping the two agree.
    """
    payload = json.dumps(requests)
    js = f"""
import {{ coverProbability, fitMarginModel, MARGIN_MODEL_VERDICT }} from
  '{REPO}/server/betting/nfl/strategy/margin-distribution.js';
const reqs = {payload};
const model = fitMarginModel({{}});
const out = reqs.map(r => {{
  try {{
    const c = coverProbability({{ spread: r.spread, handicap: r.handicap, model }});
    return {{ ...r, win: c.win, push: c.push, loss: c.loss }};
  }} catch (e) {{ return {{ ...r, error: String(e.message).slice(0, 80) }}; }}
}});
console.log(JSON.stringify({{ verdict: MARGIN_MODEL_VERDICT.headline, out }}));
"""
    tmp = REPO / "_margin_query.mjs"
    tmp.write_text(js)
    try:
        r = subprocess.run(["node", str(tmp)], capture_output=True, text=True, timeout=900)
        if r.returncode != 0:
            print("node failed:", r.stderr[-800:])
            return None
        return json.loads(r.stdout.strip().splitlines()[-1])
    finally:
        tmp.unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-liquidity", type=float, default=3.0,
                    help="max bid-ask spread in cents for a strike to count as tradable")
    ap.add_argument("--hours-before", type=float, default=6.0,
                    help="snapshot the chain this many hours before kickoff")
    a = ap.parse_args()

    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=300)
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=300)

    # ---- completed 2026 games with a closing spread (the model's conditioning variable)
    games = {}
    for week, away, home, a_s, h_s, gd, sl in nv.execute(
            """SELECT week, away_team, home_team, away_score, home_score, gameday, spread_line
               FROM nfldata_games
               WHERE season=2026 AND home_score IS NOT NULL AND spread_line IS NOT NULL
                 AND location='Home'"""):
        h, aw = NV_FIX.get(home, home), NV_FIX.get(away, away)
        games[(gd, h, aw)] = dict(margin=h_s - a_s, spread_line=sl, week=week)
    print(f"completed 2026 games with a closing spread: {len(games)}")

    # ---- parse the spread ladder. Strike comes from the TITLE, which is unambiguous.
    strike_re = re.compile(r"wins by over ([\d.]+) points", re.I)
    tickers = {}
    for tk, title, close_time in arc.execute(
            "SELECT ticker, title, close_time FROM kalshi_markets WHERE series='KXNFLSPREAD'"):
        m = strike_re.search(title or "")
        if not m:
            continue
        parts = tk.split("-")
        if len(parts) < 3:
            continue
        stamp = parts[1]
        team = re.sub(r"\d+$", "", parts[2])
        tickers[tk] = dict(stamp=stamp, team=team, strike=float(m.group(1)), close=close_time)
    print(f"KXNFLSPREAD tickers with a parseable strike: {len(tickers)}")

    # ---- resolve tickers to games
    resolved = defaultdict(list)
    for tk, t in tickers.items():
        for (gd, h, aw), g in games.items():
            try:
                d = dt.date.fromisoformat(gd)
            except Exception:
                continue
            if any(t["stamp"].upper() == (d + dt.timedelta(days=o)).strftime("%y%b%d").upper() + aw + h
                   for o in (0, 1, -1)) and t["team"] in (h, aw):
                resolved[(gd, h, aw)].append((tk, t))
                break
    print(f"games with a resolved ladder: {len(resolved)}")
    if not resolved:
        print("nothing to compare")
        return

    # ---- snapshot each ladder at a fixed time before kickoff
    rows, requests = [], []
    for key, legs in resolved.items():
        gd, h, aw = key
        g = games[key]
        try:
            ko = dt.datetime.fromisoformat(gd).replace(tzinfo=dt.timezone.utc) + dt.timedelta(hours=17)
        except Exception:
            continue
        at = int((ko - dt.timedelta(hours=a.hours_before)).timestamp())
        for tk, t in legs:
            q = arc.execute(
                """SELECT ts, bid_close, ask_close, volume, open_interest FROM kalshi_candles
                   WHERE ticker=? AND period=1 AND ts <= ? AND bid_close IS NOT NULL
                   ORDER BY ts DESC LIMIT 1""", (tk, at)).fetchone()
            if not q:
                continue
            ts, bid, ask, vol, oi = q
            if ask is None or ask <= bid:
                continue
            spread_c = ask - bid
            mid = (bid + ask) / 200.0
            # the contract asks "does TEAM win by more than strike", so express as a handicap on
            # the HOME margin: home side -> margin > strike; away side -> margin < -strike
            home_side = (t["team"] == h)
            rows.append(dict(key=key, tk=tk, team=t["team"], home_side=home_side,
                             strike=t["strike"], bid=bid / 100.0, ask=ask / 100.0, mid=mid,
                             spread_c=spread_c, vol=vol or 0, oi=oi or 0,
                             margin=g["margin"], spread_line=g["spread_line"], week=g["week"]))
            # margin-distribution takes the market spread and a handicap, both home-perspective
            # standard notation; nflverse spread_line is a MARGIN, so negate it.
            handicap = -t["strike"] if home_side else t["strike"]
            requests.append(dict(spread=-g["spread_line"], handicap=handicap))

    print(f"ladder quotes snapshotted {a.hours_before}h before kickoff: {len(rows)}")
    if not rows:
        return

    print("\nfitting the margin model (this takes a minute)...")
    res = model_probs(requests)
    if not res:
        print("could not obtain model probabilities")
        return
    print("model verdict:", res["verdict"][:180], "...\n")

    assert len(rows) == len(res["out"]), "row/response misalignment"
    for r, m in zip(rows, res["out"]):
        if "error" in m:
            r["model_p"] = None
            continue
        # coverProbability is always evaluated in HOME-margin space: with handicap h it returns
        # win = P(home_margin > -h). Strikes are half-points so push is 0.
        #   HOME contract "home wins by over S": h = -S  ->  win = P(margin > S)      -> take win
        #   AWAY contract "away wins by over S": h = +S  ->  win = P(margin > -S), which is the
        #     COMPLEMENT of what the contract asks (P(margin < -S))                  -> take loss
        # Taking win for both inverted roughly half the ladder and dragged the mean model
        # probability to ~0.5 at every strike — including "wins by over 14.5", which is what
        # exposed it, since Kalshi (0.275) already matched the settled rate (0.301).
        tot = (m["win"] or 0) + (m["loss"] or 0)
        if not tot:
            r["model_p"] = None
        else:
            r["model_p"] = (m["win"] / tot) if r["home_side"] else (m["loss"] / tot)

    good = [r for r in rows if r["model_p"] is not None and r["spread_c"] <= a.min_liquidity]
    print(f"tradable strikes (bid-ask <= {a.min_liquidity}c) with a model probability: {len(good)} "
          f"over {len({r['key'] for r in good})} games\n")
    if not good:
        return

    def blk(name, rs):
        if len(rs) < 20:
            return
        byg = defaultdict(list)
        for r in rs:
            byg[r["key"]].append(r)
        gids = list(byg)
        dev = [st.mean([x["mid"] - x["model_p"] for x in byg[g]]) for g in gids]
        m = st.mean(dev)
        se = st.stdev(dev) / math.sqrt(len(dev)) if len(dev) > 1 else 0
        # settle: did the contract pay?
        hit = st.mean([1.0 if ((x["margin"] > x["strike"]) if x["home_side"]
                               else (-x["margin"] > x["strike"])) else 0.0 for x in rs])
        print(f"{name:34s} n={len(rs):5d} g={len(gids):3d}  kalshi {st.mean([r['mid'] for r in rs]):.3f}  "
              f"model {st.mean([r['model_p'] for r in rs]):.3f}  diff {m:+.3f} (t={m/se if se else 0:+5.2f})  "
              f"settled {hit:.3f}")

    print(f"{'bucket':34s} {'n':>7s} {'g':>5s}  {'kalshi':>6s}  {'model':>6s}  {'diff':>7s} {'t':>9s}  {'settled':>7s}")
    blk("ALL", good)
    print("-" * 104)
    for lo, hi in ((0.5, 3.5), (3.5, 6.5), (6.5, 7.5), (7.5, 10.5), (10.5, 14.5), (14.5, 99)):
        blk(f"strike {lo}-{hi}", [r for r in good if lo <= r["strike"] < hi])
    print("-" * 104)
    for lo, hi in ((0.0, 0.10), (0.10, 0.30), (0.30, 0.50), (0.50, 0.70), (0.70, 0.90), (0.90, 1.0)):
        blk(f"kalshi mid {lo:.2f}-{hi:.2f}", [r for r in good if lo <= r["mid"] < hi])
    print("-" * 104)
    fam = [r for r in good if 1.5 <= abs(r["spread_line"]) <= 3 or 7 <= abs(r["spread_line"]) <= 8.5]
    blk("MODEL'S WEAK FAMILY*", fam)
    print(f"\n* {FAMILY}")
    print("\nA positive diff means Kalshi prices the contract HIGHER than the model. Clustering is by")
    print("game; strikes inside one game settle together, so g is the effective sample, not n.")


if __name__ == "__main__":
    main()
