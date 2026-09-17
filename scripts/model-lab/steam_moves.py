#!/usr/bin/env python3
"""
Steam moves: when books move together, does the line keep going — and can you get there first?

THE LAST CLASSIC SIGNAL UNTESTED HERE. Twenty-two hypotheses have now failed, but every one asked
whether some outside information (a model, a rating, news, public sentiment, another venue) beats
the closing line. Steam asks something narrower and more mechanical: given that the market ITSELF
has just moved, does it keep moving? If it does, a book that has not yet moved is briefly offering
a number the rest of the market has already abandoned, and taking it is positive CLV by
construction — no forecast required.

This is also the one hypothesis where the earlier stale-book finding is encouraging rather than
discouraging. That test established the lag is real and large: DraftKings sits a median 2,302
minutes behind consensus, and the stale number stays on the board a median of 675 minutes. So if
steam predicts continuation at all, there is ample time to act on it. The earlier test bet the
laggard on RESULTS and got +0.71%; this one grades on CLV, which is the leading indicator and the
quantity the project's own scorecard says to use.

DEFINITION (fixed before looking at any outcome):
  A steam event at time t = at least `--min-books` of the quoting books move the home line in the
  SAME direction within `--window` minutes, by at least half a point in aggregate.
  The bet is placed at the book that has NOT yet moved, on the side the movers moved toward.
  CLV is measured against that game's final consensus close; the result is graded against the score.

WHAT WOULD MAKE THIS REAL. Positive CLV alone is not enough — the stale-book test had a real lag
and still lost money. It needs CLV large enough to cover the ~4.3% vig measured as this dataset's
own bet-everything baseline.

Usage: python3 scripts/model-lab/steam_moves.py [--min-books 3] [--window 60]
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
FIX = {"JAC": "JAX", "LA": "LAR"}


def payout(price):
    """American odds -> decimal profit per unit staked. 0 and None are not valid prices."""
    if price is None or price == 0:
        return None
    return price / 100 if price > 0 else 100 / -price


def ts(x):
    try:
        return dt.datetime.fromisoformat(x + ":00" if len(x) == 16 else x).replace(
            tzinfo=dt.timezone.utc).timestamp()
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-books", type=int, default=3)
    ap.add_argument("--window", type=int, default=60, help="minutes")
    ap.add_argument("--min-move", type=float, default=0.5)
    ap.add_argument("--market", choices=["spread", "total"], default="spread",
                    help="totals are a REPLICATION of the same mechanism on a different\nmarket, not a new hypothesis: if a coordinated move leaves a laggard offering a stale\nnumber, that should hold for totals as well as spreads")
    a = ap.parse_args()

    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=180)
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=180)

    outcome = {}
    for season, away, home, a_s, h_s in nv.execute(
            """SELECT season, away_team, home_team, away_score, home_score FROM nfldata_games
               WHERE home_score IS NOT NULL AND season BETWEEN 2019 AND 2026 AND location='Home'"""):
        outcome[(season, home, away)] = (h_s - a_s, h_s + a_s)

    games = {}
    for gid, season, gdate, away, home in arc.execute(
            "SELECT game_id, season, game_date, away, home FROM covers_games"):
        games[gid] = (season, FIX.get(home, home), FIX.get(away, away))

    # BOTH prices are needed, not just the primary side's: the bet lands on the away team (or the
    # under) about half the time, and pricing those at the home/over number understates the cost.
    line_col = "home_line" if a.market == "spread" else "total_line"
    p_primary = "home_price" if a.market == "spread" else "over_price"
    p_other = "away_price" if a.market == "spread" else "under_price"
    series = defaultdict(list)
    for gid, book, t, hl, pp, po in arc.execute(
            f"""SELECT game_id, book, ts_utc, {line_col}, {p_primary}, {p_other}
                FROM covers_line_history
                WHERE market=? AND {line_col} IS NOT NULL ORDER BY ts_utc""", (a.market,)):
        u = ts(t)
        if u is not None:
            series[gid].append((u, book, hl, (pp, po)))

    bets = []
    for gid, rows in series.items():
        meta = games.get(gid)
        if not meta:
            continue
        season, home, away = meta
        res = outcome.get((season, home, away))
        if res is None or len(rows) < 8:
            continue
        margin, points = res
        quantity = margin if a.market == "spread" else points
        # final consensus close = median of each book's last line
        last = {}
        for u, book, hl, hp in rows:
            last[book] = hl
        if len(last) < 2:
            continue
        close = st.median(last.values())

        cur = {}
        moved_at = {}
        for i, (u, book, hl, hp) in enumerate(rows):
            prev = cur.get(book, (None, None))[0]
            cur[book] = (hl, hp)
            if prev is None or hl == prev:
                continue
            moved_at[book] = (u, hl - prev)
            # who else moved the same way inside the window?
            recent = [(b, d) for b, (tt, d) in moved_at.items()
                      if u - tt <= a.window * 60 and d * (hl - prev) > 0]
            if len(recent) < a.min_books:
                continue
            agg = sum(d for _, d in recent)
            if abs(agg) < a.min_move:
                continue
            # the laggard: a book quoting a line still on the wrong side of the movers
            movers = {b for b, _ in recent}
            direction = 1 if agg > 0 else -1
            for b, (line, lag_price) in cur.items():
                if b in movers or line is None:
                    continue
                # is this book still offering a better number than the movers now show?
                mover_line = st.median([cur[m][0] for m in movers if cur.get(m) is not None])
                if direction > 0 and line >= mover_line:
                    continue
                if direction < 0 and line <= mover_line:
                    continue
                # Bet the side the market moved TOWARD, at the laggard's number.
                #
                # DIRECTION differs by market and neither is the intuitive reading:
                #   SPREAD — home_line is standard notation, so a RISING home line (-3 -> -2.5)
                #     means the home team lays FEWER points, which happens when money arrives on
                #     the AWAY side. So direction > 0 is a move toward AWAY, and the side to take
                #     when direction < 0 is HOME. Betting the other way returned CLV -0.93 at
                #     t=-24.86 on the first run, which is what exposed it.
                #   TOTAL — a RISING total line means money on the OVER, so direction > 0 is a move
                #     toward OVER. Opposite of the spread case.
                #
                # GRADING and CLV also differ, and this is where the totals extension first went
                # wrong (it reported CLV -0.98 at t=-40.53, a mirror image of the spread result,
                # which is a bug signature rather than a finding):
                #   spread, side S at line L : wins when signed_margin + L > 0; a HIGHER L is better
                #   total OVER  at line L    : wins when points > L;            a LOWER  L is better
                #   total UNDER at line L    : wins when points < L;            a HIGHER L is better
                # so CLV, defined as "how much better than the close", flips sign for the over.
                if a.market == "spread":
                    take_primary = direction < 0          # primary side = home
                    taken = line if take_primary else -line
                    closing = close if take_primary else -close
                    signed = quantity if take_primary else -quantity
                    v = signed + taken
                    clv = taken - closing
                else:
                    take_primary = direction > 0          # primary side = over
                    taken, closing = line, close
                    v = (quantity - taken) if take_primary else (taken - quantity)
                    clv = (closing - taken) if take_primary else (taken - closing)
                is_home = take_primary
                if v == 0:
                    continue
                # THE PRICE MATTERS AND WAS ORIGINALLY DISCARDED. This script used to select
                # home_price, bind it, and never use it — EV was hardcoded at 100/110. That single
                # omission was the difference between an apparent +3.67% edge and +0.33%: a book
                # that has not moved its LINE defends the stale number with JUICE instead. The
                # laggard's posted price averages -112.4 and is worse than -110 almost half the
                # time, and the juice scales with the apparent free points.
                # price the side ACTUALLY bet, not always the primary side's price
                bpay = payout(lag_price[0] if take_primary else lag_price[1])
                if bpay is None:
                    continue
                bets.append(dict(gid=gid, season=season, book=b, is_home=is_home,
                                 taken=taken, close=closing, clv=clv,
                                 price=(lag_price[0] if take_primary else lag_price[1]),
                                 ev=(bpay if v > 0 else -1.0),
                                 won=v > 0, agg=abs(agg), nmovers=len(recent)))
                break   # one bet per steam event

    if not bets:
        print("no steam events found")
        return

    def rep(name, rs):
        byg = defaultdict(list)
        for r in rs:
            byg[r["gid"]].append(r)
        gids = list(byg)
        clv = [st.mean([x["clv"] for x in byg[g]]) for g in gids]
        wins = [st.mean([1.0 if x["won"] else 0.0 for x in byg[g]]) for g in gids]
        ev = [st.mean([x["ev"] for x in byg[g]]) for g in gids]
        m, se = st.mean(clv), (st.stdev(clv) / math.sqrt(len(clv)) if len(clv) > 1 else 0)
        me = st.mean(ev)
        see = st.stdev(ev) / math.sqrt(len(ev)) if len(ev) > 1 else 0
        print(f"{name:20s} n={len(rs):5d} games={len(gids):4d}  win {100*st.mean(wins):5.2f}%  "
              f"CLV {m:+5.2f}pts (t={m/se if se else 0:+5.2f})  "
              f"EV@real {100*me:+6.2f}% (t={me/see if see else 0:+5.2f})")

    print(f"min_books={a.min_books} window={a.window}m min_move={a.min_move}\n")
    print("=" * 112)
    rep("ALL STEAM", bets)
    print("-" * 112)
    for s in sorted({b["season"] for b in bets}):
        rep(f"season {s}", [b for b in bets if b["season"] == s])
    print("-" * 112)
    for lo, hi in ((0.5, 1.0), (1.0, 2.0), (2.0, 99)):
        sub = [b for b in bets if lo <= b["agg"] < hi]
        if sub:
            rep(f"move {lo}-{hi}pts", sub)
    print("=" * 112)
    print("\nEV is at the laggard's OWN posted price for the side bet, not an assumed -110.")


if __name__ == "__main__":
    main()
