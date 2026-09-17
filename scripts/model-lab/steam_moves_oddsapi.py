#!/usr/bin/env python3
"""
Independent replication of the steam-move result on the 11-book Odds API tape.

WHY A SEPARATE SCRIPT RATHER THAN A FLAG. The Covers result (+3.67% EV, t=+2.63) is the only
positive finding of the night, and the single most useful thing that can be done to it is to try it
on data that shares none of its weaknesses:

  Covers                                  Odds API
  4 books, mostly UK                      11 US books
  change-triggered rows, minute-resolution regular 15-minute grid, second-resolution
  2019-2026, early seasons corrupt        2026-09-01 onward, verified clean
  quote age unknown                       max quote age 884s, ZERO rows older than 1h

If steam is real, it should appear in both. If it is an artifact of Covers' change-triggered
sampling — where "a book has not posted a new row" is inferred rather than observed — it will not
survive a regular grid where every book's number is observed at every tick.

This also directly addresses the open contradiction: the oddsapi stale-book test found a real,
large lag (DraftKings a median 2,302 minutes behind consensus) but made only +0.71% betting the
laggard on results. That test bet the laggard whenever it was behind. This one bets it only in the
minutes right after a coordinated move, which is a much narrower and more specific claim.

The sample is small — 2026 has only ~16 completed games — so this cannot confirm the effect. It can
only fail to reproduce it, which would be informative.

Usage: python3 scripts/model-lab/steam_moves_oddsapi.py [--min-books 3]
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


def payout(price):
    if price is None or price == 0:
        return None
    return price / 100 if price > 0 else 100 / -price


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-books", type=int, default=3)
    ap.add_argument("--min-move", type=float, default=0.5)
    ap.add_argument("--cutoff", default="2026-09-17T05:00:00Z")
    a = ap.parse_args()

    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=180)
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=180)

    # nflverse writes the Rams as "LA" and Jacksonville as "JAC" in some feeds; the full-name map
    # above yields LAR/JAX. Normalise BOTH sides or the join silently returns zero games.
    NV_FIX = {"LA": "LAR", "JAC": "JAX", "OAK": "LV", "SD": "LAC", "STL": "LAR"}
    outcome = {}
    for away, home, a_s, h_s in nv.execute(
            """SELECT away_team, home_team, away_score, home_score FROM nfldata_games
               WHERE season=2026 AND home_score IS NOT NULL AND location='Home'"""):
        outcome[(NV_FIX.get(home, home), NV_FIX.get(away, away))] = h_s - a_s
    print(f"completed 2026 games from nflverse: {len(outcome)}")

    # home-side quotes per (event, snapshot, book) — the grid makes "who has moved" observable
    grid = defaultdict(lambda: defaultdict(dict))     # event -> snapshot -> book -> (line, price)
    meta = {}
    for snap, eid, home, away, book, side, line, price in arc.execute(
            """SELECT snapshot_at, event_id, home, away, book, side, line, price
               FROM oddsapi_snapshots
               WHERE market='spreads' AND line IS NOT NULL AND snapshot_at <= ?
               ORDER BY snapshot_at""", (a.cutoff,)):
        h, aw = CODE.get(home), CODE.get(away)
        if not h or not aw or (h, aw) not in outcome:
            continue
        meta[eid] = (h, aw)
        # NOTE: oddsapi_snapshots.side is literally 'home'/'away', NOT the team name —
        # unlike nfl_line_snapshots, which stores the full team name in `side`.
        if side == 'home':
            grid[eid][snap][book] = (line, price)

    print(f"events with completed outcomes and spread quotes: {len(grid)}")

    bets = []
    for eid, snaps in grid.items():
        home, away = meta[eid]
        margin = outcome[(home, away)]
        times = sorted(snaps)
        if len(times) < 3:
            continue
        # the close: last snapshot's median home line
        closing_home = st.median([v[0] for v in snaps[times[-1]].values()])
        for i in range(1, len(times)):
            prev, cur = snaps[times[i - 1]], snaps[times[i]]
            moves = {b: cur[b][0] - prev[b][0] for b in cur if b in prev and cur[b][0] != prev[b][0]}
            if len(moves) < a.min_books:
                continue
            up = sum(1 for d in moves.values() if d > 0)
            down = sum(1 for d in moves.values() if d < 0)
            if max(up, down) < a.min_books:
                continue
            direction = 1 if up > down else -1
            agg = sum(d for d in moves.values() if d * direction > 0)
            if abs(agg) < a.min_move:
                continue
            mover_line = st.median([cur[b][0] for b in moves if moves[b] * direction > 0])
            # a rising home line means money on the AWAY side (home lays fewer points)
            is_home = direction < 0
            for b, (line, price) in cur.items():
                if b in moves:
                    continue
                if direction > 0 and line >= mover_line:
                    continue
                if direction < 0 and line <= mover_line:
                    continue
                taken = line if is_home else -line
                # the laggard's own price for the side actually bet
                if not is_home:
                    row = arc.execute(
                        """SELECT price FROM oddsapi_snapshots
                           WHERE event_id=? AND snapshot_at=? AND book=? AND market='spreads'
                             AND side='away' LIMIT 1""", (eid, times[i], b)).fetchone()
                    price = row[0] if row else None
                bpay = payout(price)
                if bpay is None:
                    continue
                closing = closing_home if is_home else -closing_home
                side_margin = margin if is_home else -margin
                v = side_margin + taken
                if v == 0:
                    continue
                bets.append(dict(eid=eid, book=b, taken=taken, close=closing,
                                 clv=taken - closing, won=v > 0,
                                 ev=(bpay if v > 0 else -1.0), agg=abs(agg), nmov=len(moves)))
                break

    if not bets:
        print("no steam events found on the oddsapi grid")
        return

    def rep(name, rs):
        byg = defaultdict(list)
        for r in rs:
            byg[r["eid"]].append(r)
        gids = list(byg)
        clv = [st.mean([x["clv"] for x in byg[g]]) for g in gids]
        ev = [st.mean([x["ev"] for x in byg[g]]) for g in gids]
        wr = 100 * st.mean([1 if x["won"] else 0 for x in rs])
        m, se = st.mean(clv), (st.stdev(clv) / math.sqrt(len(clv)) if len(clv) > 1 else 0)
        me = st.mean(ev)
        see = st.stdev(ev) / math.sqrt(len(ev)) if len(ev) > 1 else 0
        print(f"{name:22s} n={len(rs):5d} games={len(gids):3d}  win {wr:5.2f}%  "
              f"CLV {m:+5.2f}pts (t={m/se if se else 0:+5.2f})  "
              f"EV {100*me:+6.2f}% (t={me/see if see else 0:+5.2f})")

    print(f"min_books={a.min_books}  cutoff={a.cutoff}\n")
    print("=" * 104)
    rep("ALL STEAM (oddsapi)", bets)
    print("-" * 104)
    for lo, hi in ((0.5, 1.0), (1.0, 99)):
        sub = [b for b in bets if lo <= b["agg"] < hi]
        if sub:
            rep(f"move {lo}-{hi}pts", sub)
    print("=" * 104)
    print("\nCovers comparison (2019-2026, 4 books): win 54.19%, CLV +0.93pts, EV +3.45%")
    print("NOTE: 2026 has only ~16 completed games, so this cannot CONFIRM the effect — only fail to")
    print("reproduce it, which would be the informative outcome.")


if __name__ == "__main__":
    main()
