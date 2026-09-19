#!/usr/bin/env python3
"""
Find qualifying Wong teaser legs on the live board, and price the ticket at a real teaser price.

WHY THERE IS NO SCRAPER HERE. The repo already ingests The Odds API, which carries DraftKings
(589k rows) and FanDuel (83k rows) alongside nine other US books, updating continuously. That is
better than scraping a sportsbook: no terms-of-service problem, no breakage when their markup
changes, and it is already historical. What no odds feed exposes is the TEASER PRICE itself --
that is computed at bet-slip time -- which is why nfl_teaser_price_ledger exists and why the price
has to be read off the slip by hand once and recorded.

WHAT QUALIFIES. A 6-point teaser crosses BOTH key numbers (3 and 7) only from these eight lines,
and the window is structural, not fitted:
    favourites  -8.5  -8  -7.5  -7      ->  -2.5  -2  -1.5  -1
    underdogs   +1.5  +2  +2.5  +3      ->  +7.5  +8  +8.5  +9

MEASURED RATES, 1999-2026 regular season, graded on the settled margin (n = decided legs):
    pooled all   73.77%  (n=2,882)      dogs 73.72% (n=1,967)   favs 73.88% (n=915)
    modern 2020+ 73.53%  (n=748)        modern dogs 74.76% (n=523)
    by dog line: +1.5 78.17% (197) | +2.5 75.25% (505) | +3.0 72.77% (1,109)
                 +2.0 69.87% (156)  <-- NO EDGE, excluded by default
Break-even is (1/(1+b))^(1/legs): -110 needs 72.375%, +100 needs 70.711%, +106 needs 69.673%.

THE CONSISTENCY CHECK THAT MAKES THIS CREDIBLE. Pinnacle's devigged price for a RANDOM teased leg
is 69.13%. Break-even at +106 is 69.67%. The book is pricing the product at fair value for the
population that buys it -- people who tease whatever games they like. The edge is not a generous
price; it is that legs crossing both 3 and 7 run ~73.8% rather than ~69%.

HONEST LIMITS, stated here so they are not lost:
  * The rate is measured at the CLOSING line. A game qualifying on Wednesday may not qualify at
    close. Scan late.
  * 2025-26 ran 69.08% on n=152 -- the weakest of five eras. Small, but it is the wrong direction.
  * Push rules matter and vary. Confirm before staking.
  * This is a correlated-product mispricing, not a forecast. It does not depend on predicting
    games, which is why it survived a night in which every forecasting approach died.

Usage:
  python3 scripts/model-lab/wong_scanner.py                      # scan, assume +106
  python3 scripts/model-lab/wong_scanner.py --price -110         # scan at another price
  python3 scripts/model-lab/wong_scanner.py --books draftkings,fanduel
  python3 scripts/model-lab/wong_scanner.py --record-price 106 --book draftkings \
      --push-rule stake_back --notes "2-team 6pt, read off the slip"
"""
import argparse
import collections
import math
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"
LIVE = REPO / "server/data.sqlite"

FAV_LINES = [-8.5, -8.0, -7.5, -7.0]
DOG_LINES = [1.5, 2.0, 2.5, 3.0]
NO_EDGE_LINES = {2.0}          # +2.0 measured 69.87%, edge +0.20pp at 0.05 SE

LEG_RATE = {          # pooled 1999-2026, decided legs
    -8.5: (0.7396, 96), -8.0: (0.6782, 87), -7.5: (0.7382, 275), -7.0: (0.7505, 457),
    1.5: (0.7817, 197), 2.0: (0.6987, 156), 2.5: (0.7525, 505), 3.0: (0.7277, 1109),
}
POOLED_RATE, POOLED_N = 0.7377, 2882
RHO = -0.04405        # module's measured same-week pair correlation (bootstrap CI includes 0)


def breakeven(price, legs=2):
    b = price / 100 if price > 0 else 100 / -price
    return (1 / (1 + b)) ** (1 / legs), b


def ticket_ev(p1, p2, b, rho=RHO):
    """EV per unit staked on a 2-leg ticket with correlated legs."""
    s1 = math.sqrt(p1 * (1 - p1))
    s2 = math.sqrt(p2 * (1 - p2))
    p_both = p1 * p2 + rho * s1 * s2
    p_both = max(0.0, min(1.0, p_both))
    return p_both * (1 + b) - 1, p_both


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--price", type=int, default=106, help="american price for the 2-team 6-pt teaser")
    ap.add_argument("--books", default="draftkings,fanduel")
    ap.add_argument("--include-plus2", action="store_true", help="include the +2.0 line (no edge)")
    ap.add_argument("--days", type=int, default=8, help="only games kicking off within N days")
    ap.add_argument("--per-line-rates", action="store_true",
                    help="price with PER-LINE historical rates instead of the pooled rate. OFF by "
                         "default because selecting the best of eight lines after seeing their "
                         "rates is a multiplicity trap: it ranks +1.5 top on n=197 and inflates "
                         "EV from +10%% to +24%%.")
    ap.add_argument("--record-price", type=int, help="write a price to nfl_teaser_price_ledger")
    ap.add_argument("--book", default="draftkings")
    ap.add_argument("--push-rule", default="stake_back",
                    choices=["stake_back", "same_price", "graded_loss"])
    ap.add_argument("--notes", default="")
    a = ap.parse_args()

    # ---- optionally record the observed price -------------------------------------------------
    if a.record_price is not None:
        con = sqlite3.connect(LIVE, timeout=120)
        con.execute("PRAGMA busy_timeout=120000")
        cols = [r[1] for r in con.execute("PRAGMA table_info(nfl_teaser_price_ledger)")]
        if not cols:
            print("nfl_teaser_price_ledger does not exist in server/data.sqlite")
            return
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        con.execute(
            """INSERT INTO nfl_teaser_price_ledger
               (captured_at, book, teaser_points, legs, american_price,
                different_games_required, push_rule, reachable, notes)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (now, a.book, 6.0, 2, a.record_price, 1, a.push_rule, 1, a.notes))
        con.commit()
        need, b = breakeven(a.record_price, 2)
        print(f"recorded: {a.book} 2-team 6-point teaser at {a.record_price:+d}, "
              f"push_rule={a.push_rule}, reachable=1")
        print(f"   break-even per leg {100*need:.3f}%  |  pooled Wong rate {100*POOLED_RATE:.2f}% "
              f"-> edge {100*(POOLED_RATE-need):+.2f}pp")
        print("   server/betting/nfl/strategy/teaser-scan.js is gated on reachable=1 and should "
              "now produce output.")
        return

    need, b = breakeven(a.price, 2)
    books = [x.strip() for x in a.books.split(",") if x.strip()]
    allowed_dogs = [L for L in DOG_LINES if a.include_plus2 or L not in NO_EDGE_LINES]

    print("=" * 78)
    print(f"WONG SCANNER — 2-team 6-point teaser at {a.price:+d}")
    print("=" * 78)
    print(f"   break-even per leg: {100*need:.3f}%")
    print(f"   pooled Wong rate:   {100*POOLED_RATE:.2f}% (n={POOLED_N:,})  "
          f"-> edge {100*(POOLED_RATE-need):+.2f}pp")
    print(f"   qualifying favourite lines: {FAV_LINES}")
    print(f"   qualifying underdog lines:  {allowed_dogs}"
          + ("" if a.include_plus2 else "   (+2.0 excluded: 69.87%, no edge)"))

    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=600)
    latest = arc.execute("SELECT MAX(snapshot_at) FROM oddsapi_snapshots").fetchone()[0]
    print(f"\n   latest odds snapshot: {latest}")

    # most recent quote per (event, book, side) at or before the latest snapshot
    rows = arc.execute(
        """SELECT o.event_id, o.commence_time, o.home, o.away, o.book, o.side, o.line, o.price
           FROM oddsapi_snapshots o
           JOIN (SELECT event_id, book, side, MAX(snapshot_at) mx
                 FROM oddsapi_snapshots WHERE market='spreads' GROUP BY event_id, book, side) z
             ON z.event_id=o.event_id AND z.book=o.book AND z.side=o.side
            AND z.mx=o.snapshot_at
           WHERE o.market='spreads'""").fetchall()

    board = collections.defaultdict(dict)
    meta = {}
    for eid, ct, home, away, book, side, line, price in rows:
        if book not in books or line is None:
            continue
        board[(eid, book)][side] = (float(line), price)
        meta[eid] = (ct, home, away)

    now_iso = datetime.now(timezone.utc).isoformat()
    horizon = (datetime.now(timezone.utc) + timedelta(days=a.days)).isoformat()
    legs = []
    for (eid, book), sides in board.items():
        ct, home, away = meta[eid]
        if ct and (str(ct) < now_iso or str(ct) > horizon):
            continue                      # already started, or too far out to be this slate
        for side, (line, price) in sides.items():
            team = home if side == "home" else away
            opp = away if side == "home" else home
            qual = None
            if line in FAV_LINES:
                qual = "fav"
            elif line in allowed_dogs:
                qual = "dog"
            if not qual:
                continue
            # POOLED rate by default. The per-line rates are reported for information, but
            # pricing with them means choosing the best of eight lines after seeing all eight --
            # the same selection error that makes a 5,940-test harness produce fake winners.
            hist, n = LEG_RATE.get(line, (POOLED_RATE, 0))
            rate = hist if a.per_line_rates else POOLED_RATE
            legs.append(dict(eid=eid, book=book, team=team, opp=opp, side=side, line=line,
                             teased=line + 6.0, price=price, kind=qual, rate=rate, hist=hist,
                             n=n, commence=ct))

    if not legs:
        print("\n   NO QUALIFYING LEGS on the current board.")
        print("   The window is narrow by design — it needs a spread exactly on one of the eight")
        print("   lines. Rerun closer to kickoff; the measured rate is a CLOSING-line rate.")
        return

    # One leg per (game, side): the same bet offered by two books is ONE opportunity, not two.
    # Keep the best posted price, and note who else has it.
    def am_val(pr):
        try:
            v = int(pr)
        except (TypeError, ValueError):
            return -1e9
        return v if v > 0 else 100.0 / abs(v) * 100 - 200   # monotone in favourability
    best = {}
    alt = collections.defaultdict(set)
    for L in legs:
        k = (L["eid"], L["side"], L["line"])
        alt[k].add(L["book"])
        if k not in best or am_val(L["price"]) > am_val(best[k]["price"]):
            best[k] = L
    legs = list(best.values())
    for L in legs:
        L["books"] = sorted(alt[(L["eid"], L["side"], L["line"])])

    legs.sort(key=lambda x: (x["line"], x["team"]))
    print(f"\n   QUALIFYING LEGS (deduped by game+side, best price kept): {len(legs)}")
    print(f"\n   {'team':<22s} {'opp':<18s} {'line':>6s} {'->':>5s} {'price':>6s} "
          f"{'best book':<12s} {'hist(info)':>10s}")
    for L in legs:
        print(f"   {L['team'][:22]:<22s} {L['opp'][:18]:<18s} {L['line']:+6.1f} "
              f"{L['teased']:+5.1f} {str(L['price']):>6s} {L['book']:<12s} "
              f"{100*L['hist']:9.2f}% (n={L['n']})")
    print(f"\n   pricing with: {'PER-LINE rates (SELECTION BIAS — see --help)' if a.per_line_rates else 'POOLED 73.77%% (honest)'}")

    # ---- best pairs, different games ----------------------------------------------------------
    print("\n" + "=" * 78)
    print(f"BEST 2-LEG TICKETS AT {a.price:+d}  (different games; rho={RHO:+.3f})")
    print("=" * 78)
    seen, pairs = set(), []
    for i in range(len(legs)):
        for j in range(i + 1, len(legs)):
            A, B = legs[i], legs[j]
            if A["eid"] == B["eid"]:
                continue
            key = tuple(sorted([(A["eid"], A["line"]), (B["eid"], B["line"])]))
            if key in seen:
                continue
            seen.add(key)
            ev, pboth = ticket_ev(A["rate"], B["rate"], b)
            pairs.append((ev, pboth, A, B))
    pairs.sort(key=lambda x: -x[0])
    for ev, pboth, A, B in pairs[:12]:
        print(f"   EV {100*ev:+6.2f}%  P(both) {100*pboth:5.2f}%   "
              f"{A['team'][:18]:<18s} {A['line']:+.1f}->{A['teased']:+.1f}  +  "
              f"{B['team'][:18]:<18s} {B['line']:+.1f}->{B['teased']:+.1f}")
    if pairs:
        print(f"\n   ({len(pairs)} distinct pairs available)")
        best_ev = pairs[0][0]
        kelly = best_ev / b if b else 0
        print(f"\n   Quarter-Kelly stake on the best pair: {25*kelly:.2f}% of bankroll "
              f"(full Kelly {100*kelly:.2f}%)")
        print("   Quarter-Kelly is already aggressive for a ~4 SE estimate measured on history.")

    print("\n" + "=" * 78)
    print("BEFORE YOU STAKE")
    print("=" * 78)
    print("   1. The rate is a CLOSING-line rate. Scan late; a Wednesday qualifier may move off")
    print("      the window by Sunday.")
    print("   2. Confirm the push rule on the slip. stake_back is standard and assumed here;")
    print("      graded_loss would cut the edge materially.")
    print("   3. Confirm the price applies to THESE lines — some books vary teaser pricing by")
    print("      spread or exclude certain numbers.")
    print("   4. 2025-26 ran 69.08% on n=152, the weakest of five eras. Watch it.")
    print("   5. Record the price once with --record-price so teaser-scan.js unblocks.")


if __name__ == "__main__":
    main()
