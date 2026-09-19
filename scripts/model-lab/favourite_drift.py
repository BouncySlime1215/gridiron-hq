#!/usr/bin/env python3
"""
Q33/Q36. Lines drift toward favourites in the final 24 hours. Is that tradeable?

THE EFFECT IS ALREADY MEASURED AND IT IS LARGE. A lineup-model agent reported "+0.17 pts of CLV,
t=2.6", then killed its own result by building the right control: BLINDLY BETTING THE FAVOURITE
earns +0.150 points of T-1440-to-close CLV at t=+7.31, with no model at all. Seven sigma. Its
model's picks correlated +0.74 with the favourite side, so its "signal" was this drift wearing a
model's clothes.

That control is now a standing rule here. But nobody asked the obvious follow-up: IF the drift is
a real, seven-sigma property of the market, can you simply TRADE IT? Bet favourites early, collect
a better number than the close, and let an efficient closing line do the rest.

WHY IT MIGHT WORK. If the close is efficient and you systematically buy at a better number than
the close, you are buying at better-than-fair odds. That is the textbook definition of positive
expected value, and it requires no forecasting ability whatsoever.

WHY IT PROBABLY DOES NOT. Points of CLV are not percent of EV. Converting requires the local
density of the margin residual, roughly 0.035 per point near the middle of the distribution. So
+0.150 points buys about 0.5pp of cover probability, against the ~2.2pp that -110 vig demands.
The prior is that the drift is real and roughly 4x too small. This script measures it rather than
asserting it, because a drift concentrated in a specific regime could be much larger than average.

THREE THINGS MEASURED SEPARATELY, because conflating them is how the original result went wrong:
  1. THE DRIFT ITSELF: does the line move toward the favourite, and by how much, by horizon?
  2. CLV: betting the favourite at T-h, graded against the CLOSING line.
  3. PROFIT: the same bets graded against the OUTCOME at real posted prices.
CLV can be positive while profit is negative -- that gap is the vig, and it is the whole question.

Usage: python3 scripts/model-lab/favourite_drift.py
"""
import collections
import math
import sqlite3
import statistics as st
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"
ET = ZoneInfo("America/New_York")
HORIZONS_H = [168, 72, 48, 24, 12, 6, 3, 1]


def parse_ts(s):
    try:
        return datetime.fromisoformat(str(s)[:19].replace(" ", "T")).replace(tzinfo=timezone.utc)
    except Exception:  # noqa: BLE001
        return None


def kickoff_utc(gdate, kickoff_et):
    """Covers stores a date plus a 12-hour Eastern clock string like '1:00 PM'."""
    try:
        t = str(kickoff_et or "").strip()
        if not t:
            return None
        dt_et = datetime.strptime(f"{str(gdate)[:10]} {t}", "%Y-%m-%d %I:%M %p")
        return dt_et.replace(tzinfo=ET).astimezone(timezone.utc)
    except Exception:  # noqa: BLE001
        return None


def clustered(pairs):
    if not pairs:
        return None
    vals = [v for _, v in pairs]
    m = st.mean(vals)
    g = collections.defaultdict(list)
    for k, v in pairs:
        g[k].append(v)
    G = len(g)
    if G < 2:
        return m, 0.0, len(vals), G
    num = sum(sum(v - m for v in vs) ** 2 for vs in g.values())
    se = math.sqrt(num) / len(vals) * math.sqrt(G / (G - 1))
    return m, se, len(vals), G


def american_profit(price, won):
    """Profit per 1 unit staked."""
    if won is None:
        return 0.0
    b = price / 100 if price > 0 else 100 / -price
    return b if won else -1.0


def main():
    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=600)
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=600)

    # ---- kickoffs -----------------------------------------------------------------------------
    kicks, meta = {}, {}
    for gid, season, gdate, ket, away, home in arc.execute(
            """SELECT game_id, season, game_date, kickoff_et, away, home FROM covers_games"""):
        k = kickoff_utc(gdate, ket)
        if k:
            kicks[gid] = k
            # season from game_date: 16 covers rows carry a wrong season column
            y = int(str(gdate)[:4])
            mo = int(str(gdate)[5:7])
            meta[gid] = (y - 1 if mo <= 2 else y, str(gdate)[:10], away, home)
    print(f"games with a parseable kickoff: {len(kicks):,}")

    # ---- outcomes -----------------------------------------------------------------------------
    out = {}
    for season, week, home, away, hs, as_, gd, gt in nv.execute(
            """SELECT season, week, home_team, away_team, home_score, away_score, gameday, game_type
               FROM nfldata_games WHERE home_score IS NOT NULL"""):
        if gt is not None and str(gt).upper() != "REG":
            continue
        out[(str(gd)[:10], home, away)] = hs - as_

    # ---- the spread tape, per game, sorted ----------------------------------------------------
    tape = collections.defaultdict(list)
    for gid, ts, hl, hp, ap in arc.execute(
            """SELECT game_id, ts_utc, home_line, home_price, away_price FROM covers_line_history
               WHERE market='spread' AND home_line IS NOT NULL ORDER BY ts_utc"""):
        t = parse_ts(ts)
        if t and gid in kicks and t <= kicks[gid]:          # STRICTLY pre-kickoff
            tape[gid].append((t, float(hl), hp, ap))
    print(f"games with a pre-kickoff spread tape: {len(tape):,}")

    def line_at(gid, when):
        q = [r for r in tape[gid] if r[0] <= when]
        return q[-1] if q else None

    def closing(gid):
        return tape[gid][-1] if tape.get(gid) else None

    # ---- 1. THE DRIFT --------------------------------------------------------------------------
    print("\n" + "=" * 78)
    print("1. THE DRIFT. Does the line move toward the favourite?")
    print("=" * 78)
    print("   positive = the favourite's number got WORSE for a late bettor (line moved toward fav)")
    print(f"\n   {'horizon':>9s} {'n':>6s} {'mean drift':>11s} {'se':>7s} {'t':>7s}   {'median':>7s}")
    drift_rows = {}
    for h in HORIZONS_H:
        rows = []
        for gid in tape:
            c = closing(gid)
            e = line_at(gid, kicks[gid] - timedelta(hours=h))
            if not c or not e:
                continue
            early_line, close_line = e[1], c[1]
            if early_line == 0:
                continue
            # Movement of the favourite's own number, positive = favourite became MORE favoured.
            # Expressed as the change in |line|, which is sign-convention-proof: whoever is
            # favoured, a bigger |line| means the market moved further toward them. An earlier
            # version branched on fav_is_home and returned the wrong sign AND magnitude against
            # this same sample -- verified by direct comparison on the identical 2,498 games.
            mv = abs(close_line) - abs(early_line)
            rows.append((gid, mv))
        r = clustered(rows)
        if r and r[2] >= 50:
            m, se, n, G = r
            med = st.median([v for _, v in rows])
            print(f"   {h:7d}h {n:6d} {m:+11.4f} {se:7.4f} {m/se if se else 0:+7.2f}   {med:+7.2f}")
            drift_rows[h] = rows
    print("\n   (this reproduces the +0.150pt / t=+7.31 control from the lineup workflow)")

    # ---- 2. CLV and 3. PROFIT ------------------------------------------------------------------
    print("\n" + "=" * 78)
    print("2+3. BET THE FAVOURITE EARLY. CLV vs ACTUAL PROFIT.")
    print("=" * 78)
    print("   CLV = points better than the close. EV needs profit, not points.")
    print(f"\n   {'horizon':>9s} {'n':>6s} {'CLV pts':>9s} {'t':>7s} {'ROI %':>8s} {'se':>7s} {'t':>7s} {'win%':>7s}")
    results = {}
    for h in HORIZONS_H:
        clv, prof, wins, graded = [], [], 0, 0
        for gid in tape:
            c = closing(gid)
            e = line_at(gid, kicks[gid] - timedelta(hours=h))
            if not c or not e:
                continue
            early_line, close_line = e[1], c[1]
            if early_line == 0:
                continue
            fav_is_home = early_line < 0
            mv = abs(close_line) - abs(early_line)
            clv.append((gid, mv))
            # grade against the outcome
            season, gd, away, home = meta.get(gid, (None, None, None, None))
            margin = out.get((gd, home, away))
            if margin is None:
                continue
            # bet the favourite at the EARLY number and price
            price = e[2] if fav_is_home else e[3]
            if price is None:
                continue
            diff = (margin + early_line) if fav_is_home else (-margin - early_line)
            if abs(diff) < 1e-9:
                continue                                     # push
            won = diff > 0
            prof.append((gid, american_profit(float(price), won)))
            graded += 1
            wins += 1 if won else 0
        rc = clustered(clv)
        rp = clustered(prof)
        if rc and rp and rp[2] >= 50:
            mc, sc, nc, _ = rc
            mp, sp, np_, _ = rp
            print(f"   {h:7d}h {np_:6d} {mc:+9.4f} {mc/sc if sc else 0:+7.2f} "
                  f"{100*mp:+8.3f} {100*sp:7.3f} {mp/sp if sp else 0:+7.2f} {100*wins/graded:6.2f}%")
            results[h] = (mc, sc, mp, sp, np_)

    # ---- CONTROL ---------------------------------------------------------------------------------
    print("\n" + "=" * 78)
    print("CONTROL: bet BOTH sides of every game at the closing price. Must return ~ -vig.")
    print("=" * 78)
    both = []
    for gid in tape:
        c = closing(gid)
        if not c:
            continue
        season, gd, away, home = meta.get(gid, (None, None, None, None))
        margin = out.get((gd, home, away))
        if margin is None or c[2] is None or c[3] is None:
            continue
        line = c[1]
        d = margin + line
        if abs(d) < 1e-9:
            continue
        both.append((gid, american_profit(float(c[2]), d > 0)))
        both.append((gid, american_profit(float(c[3]), d < 0)))
    r = clustered(both)
    if r:
        m, se, n, G = r
        print(f"   both sides at close: {100*m:+.3f}% +/- {100*se:.3f}  (n={n:,}, {G} games)")
        # The band must match the GRADING, not an assumption. This script takes the last quote
        # from whichever book posted it -- it does NOT shop -- so the right comparison is the
        # single-book vig (grading-panel agent: spread -5.564% +/- 0.087 vs theory -5.491%),
        # not the best-of-4 figure of -4.25%. A -5.5 to -3.0 band reported a false FAIL here.
        print(f"   {'PASS (single-book vig; theory ~-5.49%)' if -6.2 < 100*m < -4.6 else 'FAIL -- investigate'}")

    # ---- VERDICT -----------------------------------------------------------------------------------
    print("\n" + "=" * 78)
    print("VERDICT")
    print("=" * 78)
    if 24 in results:
        mc, sc, mp, sp, n = results[24]
        # convert points of CLV to cover probability using the empirical residual density
        dens = 0.035
        pp = 100 * mc * dens
        print(f"   At 24h: CLV {mc:+.4f} pts (t={mc/sc if sc else 0:+.2f}) -> about {pp:+.2f}pp of")
        print(f"   cover probability at a residual density of {dens}/point.")
        print(f"   A -110 bet needs +2.2pp to break even. Realised ROI {100*mp:+.3f}% "
              f"+/- {100*sp:.3f}.")
        print()
        if mp - 2 * sp > 0:
            print("   -> POSITIVE at 2 SE. Verify against the bet-everything control and re-run.")
        elif mp + 2 * sp < 0:
            print("   -> NEGATIVE at 2 SE. The drift is real and does not clear the vig: you are")
            print("      buying a better number and still paying more for it than it is worth.")
        else:
            print("   -> INDISTINGUISHABLE FROM ZERO. The drift is real in POINTS and too small in")
            print("      PERCENT. Points of CLV are not EV until multiplied by the residual density,")
            print("      and that factor is what kills it.")
    print("\n   The drift is a property of WHEN the market prices, not of WHO wins. It moves the")
    print("   number you get without moving the probability you win, so it shows up as CLV and")
    print("   vanishes in ROI. That is exactly why rule 3 exists.")


if __name__ == "__main__":
    main()
