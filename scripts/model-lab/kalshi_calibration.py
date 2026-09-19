#!/usr/bin/env python3
"""
Is Kalshi's NFL price calibrated, and is there a favourite-longshot bias?

WHY THIS IS DIFFERENT FROM THE TWENTY-THREE FAILURES. Every test so far asked whether some
information beats the market. This asks whether the market's own prices are internally honest: when
Kalshi says 20%, does it happen 20% of the time? Prediction markets are famously biased against
longshots — people overpay for lottery tickets — and if that bias exists here it is exploitable
without forecasting anything, because the counter-bet is simply "sell the longshot".

It is also the one question where Kalshi's structure helps rather than hurts. The earlier venue-cost
work established that Kalshi's fee is 0.07*p*(1-p), which is NEAR ZERO at the extremes — exactly
where a longshot bias would live. A favourite-longshot edge at p<=0.15 would face almost no fee,
unlike a pick-em bet where the fee peaks.

METHOD
  Bucket every Kalshi minute-quote by its no-vig mid price, then compare to the realised outcome.
  Calibration error = realised win rate minus mid price. A market with no bias has zero error in
  every bucket; favourite-longshot bias shows as NEGATIVE error at low prices (longshots win less
  often than their price implies) and positive error at high prices.

  Grading uses the ASK for buying and the BID for selling, plus the fee, because the tradable
  question is not "is the mid wrong" but "is it wrong by more than the spread plus the fee".

CLUSTERING. Minutes within a game are almost perfectly dependent — a game that ends up 30-3 has
hundreds of minutes all pointing the same way. Standard errors therefore cluster by GAME, and the
effective sample is the number of games (tens), not the number of minutes (millions). That is the
binding limitation and it is stated in the output.

PRESEASON IS REPORTED SEPARATELY. August games have different lineups, different motivation and
much thinner books; pooling them would flatter or distort any result.

Usage: python3 scripts/model-lab/kalshi_calibration.py
"""
import datetime as dt
import math
import sqlite3
import statistics as st
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"

NV_FIX = {"LA": "LAR", "JAC": "JAX", "OAK": "LV", "SD": "LAC", "STL": "LAR"}
BUCKETS = [(0.02, 0.10), (0.10, 0.20), (0.20, 0.30), (0.30, 0.40), (0.40, 0.50),
           (0.50, 0.60), (0.60, 0.70), (0.70, 0.80), (0.80, 0.90), (0.90, 0.98)]


def fee(p):
    """Kalshi taker fee ~ 0.07*p*(1-p) per contract, as a fraction of the $1 payout."""
    return 0.07 * p * (1 - p)


def main():
    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=300)
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=300)

    winners = {}
    for season, week, away, home, a_s, h_s, gd in nv.execute(
            """SELECT season, week, away_team, home_team, away_score, home_score, gameday
               FROM nfldata_games WHERE home_score IS NOT NULL AND season = 2026"""):
        h, aw = NV_FIX.get(home, home), NV_FIX.get(away, away)
        if h_s == a_s:
            continue                      # ties carry no winner; drop rather than guess
        winners[(gd, h, aw)] = h if h_s > a_s else aw

    # KXNFLGAME tickers resolve to "does TEAM win?", which is exactly a probability we can grade.
    tick = {}
    for tk, close_time in arc.execute(
            "SELECT ticker, close_time FROM kalshi_markets WHERE series='KXNFLGAME'"):
        parts = tk.split("-")
        if len(parts) < 3:
            continue
        stamp, team = parts[1], parts[2]
        tick[tk] = (stamp, team)

    resolved = {}
    for tk, (stamp, team) in tick.items():
        # stamp is YYMONDD + AWAY + HOME, e.g. 26SEP13ARILAC
        for (gd, h, aw), winner in winners.items():
            try:
                d = dt.date.fromisoformat(gd)
            except Exception:
                continue
            for off in (0, 1, -1):
                tag = (d + dt.timedelta(days=off)).strftime("%y%b%d").upper() + aw + h
                if stamp.upper() == tag and team in (h, aw):
                    resolved[tk] = (gd, h, aw, 1 if winner == team else 0)
                    break
    print(f"KXNFLGAME tickers resolved to a completed game: {len(resolved)} "
          f"over {len({v[0:3] for v in resolved.values()})} games")

    rows = defaultdict(list)
    for tk, (gd, h, aw, won) in resolved.items():
        for ts, bid, ask in arc.execute(
                """SELECT ts, bid_close, ask_close FROM kalshi_candles
                   WHERE ticker=? AND period=1 AND bid_close IS NOT NULL AND ask_close IS NOT NULL""",
                (tk,)):
            if ask <= bid:
                continue
            mid = (bid + ask) / 200.0
            if not (0.02 <= mid <= 0.98):
                continue
            pre = gd >= "2026-09-01"
            rows[(gd, h, aw)].append((mid, bid / 100.0, ask / 100.0, won, pre))

    allq = [(g, q) for g, qs in rows.items() for q in qs]
    print(f"minute-quotes graded: {len(allq):,}\n")
    if not allq:
        return

    def table(name, sel):
        q = [(g, x) for g, x in allq if sel(x)]
        if not q:
            return
        print(f"--- {name}: {len(q):,} quotes over {len({g for g, _ in q})} games")
        print(f"{'bucket':14s} {'quotes':>8s} {'games':>6s} {'mid':>7s} {'realised':>9s} "
              f"{'error':>8s} {'t(game)':>8s} {'buy EV':>8s} {'sell EV':>8s}")
        for lo, hi in BUCKETS:
            sub = [(g, x) for g, x in q if lo <= x[0] < hi]
            if len(sub) < 50:
                continue
            byg = defaultdict(list)
            for g, x in sub:
                byg[g].append(x)
            # one observation per game: its mean price and its (single) outcome
            per = [(st.mean([y[0] for y in v]), v[0][3]) for v in byg.values()]
            mid = st.mean([p for p, _ in per])
            real = st.mean([float(w) for _, w in per])
            errs = [float(w) - p for p, w in per]
            m = st.mean(errs)
            se = st.stdev(errs) / math.sqrt(len(errs)) if len(errs) > 1 else 0
            # tradable: buy at ask, sell at bid, each paying the fee
            buy = st.mean([float(x[3]) - x[2] - fee(x[2]) for _, x in sub])
            sell = st.mean([x[1] - float(x[3]) - fee(x[1]) for _, x in sub])
            print(f"{lo:.2f}-{hi:.2f}     {len(sub):8,} {len(byg):6d} {mid:7.3f} {real:9.3f} "
                  f"{m:+8.3f} {m/se if se else 0:+8.2f} {100*buy:+7.2f}% {100*sell:+7.2f}%")
        print()

    table("REGULAR SEASON", lambda x: x[4])
    table("PRESEASON", lambda x: not x[4])
    print("Favourite-longshot bias would appear as NEGATIVE error in the low buckets")
    print("(longshots winning less often than their price implies) and positive error high up.")
    print("NOTE: minutes within a game are near-perfectly dependent, so the effective sample is")
    print("the GAME count in each row, not the quote count. Tens of games cannot settle this.")


if __name__ == "__main__":
    main()
