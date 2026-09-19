#!/usr/bin/env python3
"""
Grade the preregistered shadow-decision tape for 2026 week 1.

WHY THIS TAPE IS THE BEST EVIDENCE WE HAVE. 56 decisions were written to shadow_decisions at
2026-09-03T21:01Z -- days before week 1 kicked off -- each carrying the side, the book, the exact
line and price taken, the opener, the signal that produced it, and a stated prior basis. They were
recorded as 'observe' at zero units, explicitly "graded by CLV". Then the live database was deleted
on 09-16 and they were never graded. Nothing about them can be tuned after the fact: the
timestamps predate the games, so this is a genuine out-of-sample forward test, which is exactly
what every retrospective backtest in this project has failed to be.

n=56 is small. That is stated everywhere below rather than hidden, and the confidence intervals
are wide enough that this cannot on its own establish an edge. What it CAN do is tell us whether
the four signals beat the closing line in the one live week we have, without hindsight.

SIGN CONVENTIONS — THE TWO SOURCES DISAGREE, AND GETTING THIS WRONG PRODUCES NONSENSE.
  shadow_decisions.line : home-perspective, STANDARD BETTING NOTATION. Negative = home favoured.
                          (id 43 LAC home is stored -10.0 and LAC were favoured.)
  nflverse spread_line  : home-perspective MARGIN. Positive = home favoured.
                          (the same LAC game is stored +8.5.)
  They are negatives of one another. A first pass here treated them as the same convention and
  produced CLV of +18.5 points on an NFL spread, which is impossible -- the tell that caught it.
  Verified against all 38 spread rows before this version was used.

  Everything below is normalised to the BET SIDE's own line in standard notation, where a higher
  number is always better for the bettor (more points received, or fewer laid):
    taken  = shadow_line          if the selection is the home team, else -shadow_line
    close  = -nflverse_spread_line if the selection is the home team, else +nflverse_spread_line
    win    = (side_margin + taken) > 0
    CLV    = taken - close        (positive means we got a better number than the close)
  Totals use the same convention in both sources, so an over wants a lower number and an under
  wants a higher one:
    over:  CLV = close - taken
    under: CLV = taken - close

CLV in probability converts points through the empirical margin/total distribution (key numbers
are not uniform: 3 and 7 are worth far more than 4 or 5), not a normal approximation.

Usage: python3 scripts/model-lab/grade_shadow_tape.py
"""
import json
import math
import os
import sqlite3
import statistics as st
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LIVE = os.environ.get("GRIDIRON_DB") or str(REPO / "server/data.sqlite")
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"


def payout(price):
    return price / 100 if price > 0 else 100 / -price


def novig_prob(price):
    """Implied probability with the vig still in it."""
    return 1 / (1 + payout(price))


def key_number_pmf(cur, kind):
    """Empirical distribution of margins (or totals) from every completed game 1999-2025.

    Half-point value is wildly non-uniform in the NFL -- moving a spread across 3 is worth
    several times moving it across 4 -- so CLV in probability has to come from the real
    histogram rather than a normal curve.
    """
    col = "result" if kind == "spread" else "total"
    vals = [r[0] for r in cur.execute(
        f"SELECT {col} FROM nfldata_games WHERE season BETWEEN 1999 AND 2025 AND {col} IS NOT NULL")]
    pmf = defaultdict(float)
    for v in vals:
        pmf[float(v)] += 1.0 / len(vals)
    return pmf


def cover_prob(pmf, line, side):
    """P(bet wins) for a line, from the empirical pmf. Pushes excluded from the denominator."""
    win = sum(p for v, p in pmf.items() if (v > line if side == "over" else v < line))
    push = sum(p for v, p in pmf.items() if v == line)
    return win / (1 - push) if push < 1 else 0.5


def main():
    live = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True)

    games = {}
    for season, week, away, home, a_s, h_s, sl, tl in nv.execute(
            """SELECT season, week, away_team, home_team, away_score, home_score, spread_line, total_line
               FROM nfldata_games WHERE season=2026 AND home_score IS NOT NULL"""):
        games[(home, away)] = dict(week=week, home_score=h_s, away_score=a_s,
                                   close_spread=sl, close_total=tl, margin=h_s - a_s,
                                   total=h_s + a_s)
    print(f"completed 2026 games available: {len(games)}")

    margin_pmf = key_number_pmf(nv, "spread")
    total_pmf = key_number_pmf(nv, "total")

    rows = live.execute(
        """SELECT id, market, selection, season, week, home_team, away_team, line, american_price,
                  captured_at, feature_snapshot_json
           FROM shadow_decisions WHERE sport='NFL' ORDER BY id""").fetchall()

    graded, skipped = [], 0
    for (rid, market, selection, season, week, home, away, line, price, cap, snap) in rows:
        g = games.get((home, away))
        if not g or line is None or price is None:
            skipped += 1
            continue
        f = json.loads(snap) if snap else {}
        signal = f.get("signal", "?")

        if market == "spread":
            is_home = (selection == home)
            if g["close_spread"] is None:
                skipped += 1
                continue
            # Normalise both sources onto the BET SIDE's own line, standard notation.
            taken = line if is_home else -line
            close = (-g["close_spread"]) if is_home else g["close_spread"]
            side_margin = g["margin"] if is_home else -g["margin"]
            won = (side_margin + taken) > 0
            push = (side_margin + taken) == 0
            clv_pts = taken - close
            # Probability is evaluated in HOME-MARGIN space for both sides, because the empirical
            # pmf is a distribution of home margins and home-field advantage makes it asymmetric --
            # mirroring it for away sides would quietly bias every away number.
            #   home side at L covers when home_margin > -L
            #   away side at L covers when home_margin <  L
            if is_home:
                p_taken = cover_prob(margin_pmf, -taken, "over")
                p_close = cover_prob(margin_pmf, -close, "over")
            else:
                p_taken = cover_prob(margin_pmf, taken, "under")
                p_close = cover_prob(margin_pmf, close, "under")
            line, close = taken, close
        else:
            is_over = str(selection).lower() == "over"
            close = g["close_total"]
            outcome = g["total"]
            won = (outcome > line) if is_over else (outcome < line)
            push = (outcome == line)
            clv_pts = (close - line) if is_over else (line - close)
            side = "over" if is_over else "under"
            p_taken = cover_prob(total_pmf, line, side)
            p_close = cover_prob(total_pmf, close, side)

        if close is None:
            skipped += 1
            continue

        b = payout(price)
        graded.append(dict(
            id=rid, signal=signal, market=market, selection=selection, game=f"{away}@{home}",
            line=line, close=close, price=price, clv_pts=clv_pts,
            clv_prob=p_taken - p_close,          # probability points gained versus the close
            won=None if push else bool(won), push=push,
            unit_pnl=0.0 if push else (b if won else -1.0),
            edge_at_close=p_close - novig_prob(price),
        ))

    print(f"graded: {len(graded)}   skipped (no completed game / no close): {skipped}\n")
    if not graded:
        print("nothing to grade")
        return

    def block(name, rs):
        dec = [r for r in rs if not r["push"]]
        w = sum(1 for r in dec if r["won"])
        n = len(dec)
        clv_pts = st.mean([r["clv_pts"] for r in rs])
        clv_prob = st.mean([r["clv_prob"] for r in rs]) * 100
        beat = sum(1 for r in rs if r["clv_pts"] > 0)
        tie = sum(1 for r in rs if r["clv_pts"] == 0)
        pnl = sum(r["unit_pnl"] for r in rs)
        roi = 100 * pnl / len(rs)
        se_clv = (st.stdev([r["clv_prob"] for r in rs]) * 100 / math.sqrt(len(rs))) if len(rs) > 1 else 0
        t = clv_prob / se_clv if se_clv else 0
        wr = 100 * w / n if n else 0
        print(f"{name:26s} n={len(rs):3d}  W-L {w}-{n-w} ({wr:5.1f}%)  "
              f"CLV {clv_pts:+5.2f}pts {clv_prob:+5.2f}pp (t={t:+5.2f})  "
              f"beat close {beat}/{len(rs)} (tie {tie})  P&L {pnl:+6.2f}u ({roi:+6.1f}%)")

    print("=" * 118)
    block("ALL", graded)
    print("-" * 118)
    for s in sorted({r["signal"] for r in graded}):
        block(s, [r for r in graded if r["signal"] == s])
    print("-" * 118)
    for m in sorted({r["market"] for r in graded}):
        block(m, [r for r in graded if r["market"] == m])
    print("=" * 118)

    print("\nper-decision detail:")
    print(f"{'id':>3} {'signal':24s} {'mkt':6s} {'sel':6s} {'game':10s} {'took':>7s} {'close':>7s} "
          f"{'CLVpts':>7s} {'CLVpp':>7s} {'res':>5s}")
    for r in sorted(graded, key=lambda r: -r["clv_pts"]):
        res = "push" if r["push"] else ("W" if r["won"] else "L")
        print(f"{r['id']:>3} {r['signal'][:24]:24s} {r['market']:6s} {str(r['selection'])[:6]:6s} "
              f"{r['game']:10s} {r['line']:>7.1f} {r['close']:>7.1f} {r['clv_pts']:>+7.2f} "
              f"{100*r['clv_prob']:>+7.2f} {res:>5s}")

    out = REPO / "docs/evidence/2026-09-17/shadow-tape-week1.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    json.dump(dict(graded=graded, n=len(graded), skipped=skipped), open(out, "w"), indent=1)
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
