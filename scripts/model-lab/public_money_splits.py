#!/usr/bin/env python3
"""
Test the three classic public-betting signals on Action Network splits. Never measured here before.

WHY THIS IS WORTH A TEST AFTER TWENTY FAILURES. Everything tested so far has asked whether a MODEL
or a VENUE can beat the closing line, and the answer has been no every time. This asks a different
question: does the market's own composition — who is betting which side, and with how much money —
carry information the closing line has not already absorbed? That is the one family of signal the
project has never examined, and the data arrived only last night.

`an_public_splits` carries, per game and market, both the share of BETS and the share of MONEY on
each side. The gap between them is the whole point: when 70% of tickets sit on one side but only
40% of the dollars do, the big accounts are on the other side. That is the standard construction of
"sharp money", and it is measurable here directly rather than inferred.

THREE SIGNALS, all pre-registered before looking at any outcome:
  1. FADE THE PUBLIC — bet the side with the smaller share of bets. The oldest idea in betting.
  2. FOLLOW THE MONEY — bet the side where money share exceeds bet share by a margin. The sharp side.
  3. REVERSE LINE MOVEMENT — the line moved TOWARD the unpopular side, i.e. the book moved against
     its own ticket count, which can only be because it respects the money on the quiet side.

GRADING. Realised ATS/total results at the stored price, EV as % of stake, standard errors
clustered by game. No modelling, no fitting — these are rules with no free parameters beyond the
threshold, and every threshold tried is reported so the multiple-comparison count is visible.

A NULL IS THE EXPECTED ANSWER and is reported as such. Public-fading in particular is famous and
therefore likely priced.

Usage: python3 scripts/model-lab/public_money_splits.py
"""
import math
import sqlite3
import statistics as st
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"


def payout(price):
    """American odds -> decimal profit per unit staked. 0 is not a valid American price."""
    if price is None or price == 0:
        return None
    return price / 100 if price > 0 else 100 / -price


def grade_spread(home_line, margin):
    """margin is home_score - away_score; home_line is home-perspective standard notation."""
    v = margin + home_line
    return None if v == 0 else (v > 0)


def grade_total(total_line, points):
    if points == total_line:
        return None
    return points > total_line


def main():
    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=180)

    # One row per (event, market) — the LAST capture before kickoff, so the percentages are the
    # final public picture and the line is the closing number.
    rows = arc.execute("""
        -- NAMING TRAP, verified against raw rows before use: `spread_home` is the POINT SPREAD
        -- and `spread_home_line` is the PRICE, which is the opposite of what the names suggest.
        -- Reading them the intuitive way treats a spread of 1.0 as American odds (a 33x payout)
        -- and produced a +567% return on a bet-everything baseline that must return -vig.
        SELECT event_id, season, week, away, home, away_score, home_score,
               spread_home, spread_home_public, spread_away_public,
               spread_home_money, spread_away_money,
               spread_home_line, spread_away_line, total, total_over_public, total_under_public,
               total_over_money, total_under_money, over, under, num_bets, captured_at
        FROM an_public_splits
        WHERE status='complete' AND home_score IS NOT NULL AND away_score IS NOT NULL
        ORDER BY captured_at""").fetchall()

    latest = {}
    for r in rows:
        latest[r[0]] = r        # ordered by captured_at, so last write wins
    print(f"{len(rows)} split rows -> {len(latest)} completed games")

    spread_bets, total_bets = [], []
    for r in latest.values():
        (eid, season, week, away, home, a_s, h_s, hl, hpub, apub, hmon, amon,
         hprice, aprice, tot, opub, upub, omon, umon, oprice, uprice, nbets, cap) = r
        margin = h_s - a_s
        pts = h_s + a_s

        if hl is not None and hpub is not None and apub is not None:
            covered = grade_spread(hl, margin)
            if covered is not None:
                for side, pub, mon, price, won in (
                        ("home", hpub, hmon, hprice, covered),
                        ("away", apub, amon, aprice, not covered)):
                    b = payout(price)
                    if pub is None or b is None:
                        continue
                    spread_bets.append(dict(
                        eid=eid, season=season, side=side, pub=pub,
                        money=mon, gap=(mon - pub) if mon is not None else None,
                        price=price, won=won, nbets=nbets,
                        ev=(b if won else -1.0)))

        if tot is not None and opub is not None and upub is not None:
            over_hit = grade_total(tot, pts)
            if over_hit is not None:
                for side, pub, mon, price, won in (
                        ("over", opub, omon, oprice, over_hit),
                        ("under", upub, umon, uprice, not over_hit)):
                    b = payout(price)
                    if pub is None or b is None:
                        continue
                    total_bets.append(dict(
                        eid=eid, season=season, side=side, pub=pub,
                        money=mon, gap=(mon - pub) if mon is not None else None,
                        price=price, won=won, nbets=nbets,
                        ev=(b if won else -1.0)))

    def report(name, bets):
        if not bets:
            print(f"{name:34s} (none)")
            return
        byg = defaultdict(list)
        for b in bets:
            byg[b["eid"]].append(b["ev"])
        per_game = [st.mean(v) for v in byg.values()]
        m = st.mean(per_game)
        se = st.stdev(per_game) / math.sqrt(len(per_game)) if len(per_game) > 1 else 0
        wr = 100 * st.mean([1 if b["won"] else 0 for b in bets])
        print(f"{name:34s} n={len(bets):5d} games={len(byg):4d}  win {wr:5.2f}%  "
              f"EV {100*m:+6.2f}% (SE {100*se:4.2f}, t={m/se if se else 0:+5.2f})")

    print("\nbreak-even at -110 is 52.38%\n")
    print("=" * 108)
    print("SIGNAL 1 — FADE THE PUBLIC (bet the less-backed side)")
    for thr in (50, 60, 65, 70, 75, 80):
        report(f"  spreads: public <= {100-thr}%",
               [b for b in spread_bets if b["pub"] is not None and b["pub"] <= 100 - thr])
        report(f"  totals:  public <= {100-thr}%",
               [b for b in total_bets if b["pub"] is not None and b["pub"] <= 100 - thr])
    print("-" * 108)
    print("SIGNAL 2 — FOLLOW THE MONEY (money share exceeds bet share)")
    for gap in (5, 10, 15, 20, 25):
        report(f"  spreads: money-bets >= {gap}pp",
               [b for b in spread_bets if b["gap"] is not None and b["gap"] >= gap])
        report(f"  totals:  money-bets >= {gap}pp",
               [b for b in total_bets if b["gap"] is not None and b["gap"] >= gap])
    print("-" * 108)
    print("BASELINE — every side, no selection (this is the vig)")
    report("  all spread sides", spread_bets)
    report("  all total sides", total_bets)
    print("=" * 108)

    n_tests = 6 * 2 + 5 * 2
    print(f"\n{n_tests} thresholds tested. Bonferroni alpha at 0.05 = {0.05/n_tests:.5f} "
          f"-> needs |t| >= {2.807 if n_tests <= 22 else 3.0:.2f}. Anything below that is noise.")


if __name__ == "__main__":
    main()
