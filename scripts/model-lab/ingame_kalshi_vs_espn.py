#!/usr/bin/env python3
"""
In-game: does Kalshi's live price disagree with ESPN's win-probability model, and is either right?

WHY THIS ANGLE IS WORTH A TEST AFTER SIXTEEN FAILURES. Every hypothesis tested so far has been
PREGAME, and the pregame market has been efficient on every dimension measured — no Kalshi lead, no
arbitrage, advanced features at -0.30pp, line shopping a cost reduction only. In-game markets are a
different animal: prices move every snap, liquidity is thinner, and nobody has time to think. That
is where inefficiency is most plausible, and it is the one place we hold both sides of the
comparison:

  * Kalshi per-minute candles run THROUGH the game — ~206-211 in-game minutes per game, with a
    two-sided bid/ask on every one of them, including minutes with no trade.
  * ESPN publishes a win probability per play, and `espn_plays.wallclock` is a real UTC timestamp,
    so the two can be aligned to the minute. (`espn_probabilities.last_modified` is an edit time,
    NOT the play time — using it would misalign everything.)

THE TEST. At each in-game minute, compare Kalshi's implied home win probability (bid/ask midpoint)
against ESPN's home_wp at the most recent play. When they disagree by more than a threshold, bet
the side ESPN favours, at Kalshi's actual ask, including Kalshi's fee. Grade on the realised winner.

WHAT A NULL MEANS HERE. ESPN's win probability is a MODEL, not truth. If this loses, the honest
reading is "ESPN's model is not better than the market", which is itself worth knowing and is the
likely outcome. A positive result would mean the live market misprices relative to a free public
model, which would be genuinely surprising and must clear adversarial review before being believed.

COSTS. Kalshi's trading fee is approximately 0.07 * P * (1-P) per contract — largest at the money
(~1.75c) and smaller on lopsided prices. Taking the ask already pays the spread (mean 1.26c on
KXNFLGAME). Both are charged here; a naive mid-price backtest would look far better and be wrong.

Usage: python3 scripts/model-lab/ingame_kalshi_vs_espn.py [--threshold 0.05]
"""
import argparse
import datetime as dt
import math
import sqlite3
import statistics as st
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"

CODE = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
    "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}


def kalshi_fee(price):
    """~0.07 * P * (1-P) per contract, as a fraction of the $1 payout."""
    return 0.07 * price * (1 - price)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=0.05,
                    help="minimum |ESPN wp - Kalshi mid| to act on")
    ap.add_argument("--min-volume", type=float, default=100,
                    help="skip illiquid tickers")
    a = ap.parse_args()

    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=180)
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=180)

    # ---- winners, from nflverse (ground truth, not a model)
    winners = {}
    for season, week, away, home, a_s, h_s, gd in nv.execute(
            """SELECT season, week, away_team, home_team, away_score, home_score, gameday
               FROM nfldata_games WHERE home_score IS NOT NULL AND season = 2026"""):
        winners[(gd, home, away)] = 1 if h_s > a_s else 0 if h_s < a_s else None

    # ---- ESPN win probability aligned to wall-clock via espn_plays
    wp = defaultdict(list)          # event_id -> [(unix_ts, home_wp)]
    for eid, home_wp, wall in arc.execute(
            """SELECT p.event_id, p.home_wp, pl.wallclock
               FROM espn_probabilities p
               JOIN espn_plays pl ON pl.event_id = p.event_id AND pl.play_id = p.play_id
               WHERE pl.wallclock IS NOT NULL AND p.home_wp IS NOT NULL"""):
        try:
            ts = int(dt.datetime.fromisoformat(wall.replace("Z", "+00:00")).timestamp())
        except Exception:
            continue
        wp[eid].append((ts, home_wp))
    for v in wp.values():
        v.sort()
    print(f"ESPN win-probability series: {len(wp)} events")

    # ---- map espn events to a (date, home, away) key.
    # espn_events.home/.away hold ESPN's numeric team IDs ("2", "8"), not codes, so the matchup is
    # taken from `name`, which is "<Away full name> at <Home full name>".
    # espn `date` is the KICKOFF INSTANT in UTC, which for a Sunday 1pm ET game is already the next
    # calendar day in UTC — so the date key is derived from kickoff minus 12h to land on the
    # American game date that nflverse uses.
    ev = {}
    for eid, date, name in arc.execute("SELECT event_id, date, name FROM espn_events"):
        if not date or not name or " at " not in name:
            continue
        away_name, home_name = name.split(" at ", 1)
        h, aw = CODE.get(home_name.strip()), CODE.get(away_name.strip())
        if not h or not aw:
            continue
        try:
            ko = dt.datetime.fromisoformat(date.replace("Z", "+00:00"))
        except Exception:
            continue
        ev[eid] = ((ko - dt.timedelta(hours=12)).strftime("%Y-%m-%d"), h, aw)

    # ---- Kalshi per-minute, KXNFLGAME (a moneyline on one named team)
    tickers = {}
    for tk, ser, ct in arc.execute(
            "SELECT ticker, series, close_time FROM kalshi_markets WHERE series='KXNFLGAME'"):
        parts = tk.split("-")
        if len(parts) < 3:
            continue
        tickers[tk] = parts[-1]          # the team the contract is ABOUT

    bets = []
    for eid, series in wp.items():
        meta = ev.get(eid)
        if not meta:
            continue
        date, home, away = meta
        won = winners.get((date, home, away))
        if won is None:
            continue
        # Kalshi encodes the date as YYMONDD with the month in letters: KXNFLGAME-26SEP13ARILAC-ARI.
        # The game may also be listed under the adjacent day, so both are tried.
        try:
            d0 = dt.date.fromisoformat(date)
        except Exception:
            continue
        tags = {(d0 + dt.timedelta(days=off)).strftime("%y%b%d").upper() + away + home
                for off in (0, 1, -1)}
        cands = [tk for tk in tickers if any(t in tk.replace("-", "").upper() for t in tags)]
        if not cands:
            continue
        for tk in cands:
            about = tickers[tk]
            if about not in (home, away):
                continue
            rows = arc.execute(
                """SELECT ts, bid_close, ask_close, volume FROM kalshi_candles
                   WHERE ticker=? AND period=1 AND bid_close IS NOT NULL AND ask_close IS NOT NULL
                   ORDER BY ts""", (tk,)).fetchall()
            if not rows:
                continue
            lo, hi = series[0][0], series[-1][0]
            i = 0
            for ts, bid, ask, vol in rows:
                if ts < lo or ts > hi:
                    continue              # pregame / postgame minutes are not this test
                if (vol or 0) < 0:
                    continue
                while i + 1 < len(series) and series[i + 1][0] <= ts:
                    i += 1
                espn_home = series[i][1]
                mid = (bid + ask) / 200.0
                espn_side = espn_home if about == home else 1 - espn_home
                if espn_side - mid < a.threshold:
                    continue              # only act when ESPN thinks this side is UNDERPRICED
                cost = ask / 100.0
                fee = kalshi_fee(cost)
                hit = 1 if ((about == home) == (won == 1)) else 0
                bets.append(dict(eid=eid, ticker=tk, ts=ts, edge=espn_side - mid,
                                 cost=cost, fee=fee, hit=hit,
                                 pnl=(1 - cost - fee) if hit else -(cost + fee)))

    if not bets:
        print("no in-game opportunities found — check ESPN 2026 coverage and ticker matching")
        return

    def block(name, rs):
        byg = defaultdict(list)
        for r in rs:
            byg[r["eid"]].append(r["pnl"] / max(r["cost"], 1e-9))
        per_game = [st.mean(v) for v in byg.values()]
        m = st.mean(per_game)
        se = st.stdev(per_game) / math.sqrt(len(per_game)) if len(per_game) > 1 else 0
        hit = 100 * st.mean([r["hit"] for r in rs])
        print(f"{name:22s} n={len(rs):6d} games={len(byg):3d}  hit {hit:5.1f}%  "
              f"ROI {100*m:+7.2f}% (SE {100*se:5.2f}, t={m/se if se else 0:+5.2f})  "
              f"mean edge {100*st.mean([r['edge'] for r in rs]):5.2f}pp")

    print(f"\nthreshold {a.threshold}  |  {len(bets)} in-game opportunities\n")
    print("=" * 108)
    block("ALL", bets)
    print("-" * 108)
    for lo, hi in ((0.05, 0.10), (0.10, 0.20), (0.20, 1.0)):
        sub = [b for b in bets if lo <= b["edge"] < hi]
        if sub:
            block(f"edge {lo:.2f}-{hi:.2f}", sub)
    print("=" * 108)
    print("\nREMINDER: ESPN win probability is a model, not truth. A loss here means ESPN's model is "
          "not better than the live market — the expected and unremarkable outcome.")


if __name__ == "__main__":
    main()
