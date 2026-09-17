#!/usr/bin/env python3
"""
Does Polymarket's own option chain contradict itself? Three tests that need no forecasting model.

WHY THIS IS DIFFERENT FROM EVERYTHING ELSE TRIED HERE. Every edge this project has hunted so far
asked "can we predict the game better than the market", and the answer has been no, 24 hypotheses
and 5,940 registered correlation tests deep. This asks a question with no forecasting in it at all:
are the prices CONSISTENT WITH EACH OTHER? Polymarket quotes a full-game total ladder, four quarter
ladders, and two half ladders on the same game, as separate independent binary markets. The
underlying random variables satisfy hard arithmetic identities, so the prices must too:

    A. MONOTONICITY.  P(total > 25.5) >= P(total > 27.5). Always. Strict stochastic dominance --
       the event on the left contains the event on the right. A violation is not a mispricing to be
       forecast, it is a box: buy the cheap high strike, sell the dear low strike, and every state
       of the world pays >= 0 with at least one paying strictly positive.
    B. ADDITIVITY.  E[1Q] + E[2Q] + E[3Q] + E[4Q] = E[game], and E[1H] + E[2H] = E[game], and
       E[1Q] + E[2Q] = E[1H]. Expectation is linear regardless of how correlated the quarters are,
       so this holds with NO independence assumption. It is an identity, not an approximation.
    C. WHICH SIDE WAS RIGHT.  When the parts disagree with the whole, the settled score says which
       leg was mispriced. That converts a coherence violation into a directional signal.

Expected means come from integrating the survival function the ladder implies:
    E[X] = integral_0^inf P(X > t) dt      (X >= 0)
which needs no distributional assumption -- only the quoted ladder plus a tail convention.

WHAT THIS CANNOT SHOW. pm_price_history stores one price per market per instant, with NO bid/ask.
That price is a mid or last print, so a violation smaller than the true bid-ask spread is not
tradeable and may not even be real. Quarter markets are thin and their spreads are wide. So the
magnitude distribution is reported in full and nothing is called actionable on size alone: the
honest claim available from this data is about INFORMATION, and the execution question is flagged
as needing the live order book, which this archive does not contain.

Prices are taken at a common instant per game -- the last print at or before a cutoff -- because
comparing strikes quoted hours apart measures the clock, not the chain.

Usage: python3 scripts/model-lab/polymarket_ladder_coherence.py [--cutoff-mins 0] [--min-strikes 5]
"""
import argparse
import collections
import math
import re
import sqlite3
import statistics as st
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"
NFLVERSE = REPO / "data/line-history/nflverse.sqlite"

PERIOD_RE = re.compile(r":\s*(1Q|2Q|3Q|4Q|1H|2H)\s+O/U")
GAME_RE = re.compile(r"^(.+?)\s+vs\.\s+(.+?):")


def parse_period(q):
    m = PERIOD_RE.search(q)
    if m:
        return m.group(1)
    # a bare "TEAMS: O/U 47.5" is the full game; anything else (2-pt conversions, etc) is not a total
    return "GAME" if re.search(r":\s*O/U\s+[\d.]+\s*$", q) else None


def parse_game(q):
    m = GAME_RE.match(q)
    return (m.group(1).strip(), m.group(2).strip()) if m else None


def survival_mean(strikes):
    """E[X] from {strike: P(X > strike)} by integrating the survival function.

    Trapezoid across quoted strikes, S=1 assumed at t=0 (a total is never negative), and an
    exponential tail above the top strike fitted to the last two points. The tail contributes
    little when the top strike is far out; games where it contributes more than 10% of the mass
    are flagged by the caller via tail_frac.
    """
    xs = sorted(strikes)
    pts = [(0.0, 1.0)] + [(x, max(0.0, min(1.0, strikes[x]))) for x in xs]
    area = 0.0
    for (x0, s0), (x1, s1) in zip(pts, pts[1:]):
        area += (x1 - x0) * (s0 + s1) / 2.0
    # exponential tail beyond the highest strike
    tail = 0.0
    if len(pts) >= 3:
        (xa, sa), (xb, sb) = pts[-2], pts[-1]
        if 0 < sb < sa and xb > xa:
            lam = math.log(sa / sb) / (xb - xa)
            if lam > 0:
                tail = sb / lam
        elif sb > 0:
            tail = sb * 3.0          # flat-ish chain: crude, and reported
    return area + tail, (tail / (area + tail) if (area + tail) > 0 else 0.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-strikes", type=int, default=5,
                    help="ladder depth required before a mean is trusted")
    ap.add_argument("--since", default="2026-08-15")
    ap.add_argument("--spread-cents", type=float, default=2.0,
                    help="assumed half-spread in cents; violations below this are not called real")
    a = ap.parse_args()

    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=600)

    mkts = arc.execute(
        """SELECT condition_id, question, line, game_start_time, closed
           FROM pm_markets
           WHERE market_type='total' AND question LIKE '%O/U%' AND line IS NOT NULL
             AND game_start_time >= ?""", (a.since,)).fetchall()

    chain = collections.defaultdict(lambda: collections.defaultdict(dict))   # game -> period -> line -> cid
    meta = {}
    for cid, q, line, gst, closed in mkts:
        per, g = parse_period(q), parse_game(q)
        if not per or not g:
            continue
        chain[(g, gst)][per][float(line)] = cid
        meta[cid] = (g, gst, per, float(line))
    print(f"games with a total chain: {len(chain)}   markets mapped: {len(meta)}")

    # ---- price every mapped market at a genuinely-traded pregame instant ------------------
    # THREE WAYS THE NAIVE "last print at or before kickoff" IS WRONG, all of them observed:
    #   1. NEVER-TRADED MARKETS PARK AT EXACTLY 0.500. Polymarket carries a resting midpoint for
    #      contracts nobody has touched. A phantom 0.500 sitting next to a real 0.90 reads as a
    #      40-cent dominance violation that does not exist. A first pass reported 24% of adjacent
    #      strike pairs "violating" monotonicity, median 11 cents, on exactly this.
    #   2. SETTLED MARKETS PIN TO 1.000 / 0.001. Those are payoffs, not prices.
    #   3. A STALE PRINT FROM DAYS EARLIER still satisfies "t <= kickoff".
    # So: require the print to be inside a window before kickoff, off the settlement rails, and
    # from a market whose price actually MOVED at some point (a flat 0.5 tape never traded).
    RAIL_LO, RAIL_HI = 0.02, 0.98
    WINDOW_H = 48
    MID, MID_EPS = 0.50, 0.002
    MIN_VOLUME = 5000.0

    # THE FILTER THAT ACTUALLY MATTERS, and it is not a tape heuristic. pm_markets carries a
    # volume column, and the census is brutal: of 11,677 NFL total markets since 2026-08-15,
    # 9,957 (85%) have traded EXACTLY ZERO DOLLARS. Median volume is $0, p90 is $28. The median
    # game has ZERO strikes with more than $5k of volume.
    # Every "arbitrage" this script reported came from those. The 2Q O/U 5.5 contracts behind the
    # largest apparent boxes are all $0 volume with tapes drifting 0.490-0.565 -- a market maker's
    # resting quote near the midpoint, never hit. Two consequences:
    #   TEST A is void on them: you cannot arb a price nobody will trade at.
    #   TEST B is worse than void: untraded quotes drift toward 0.50, which pulls the survival
    #     integral toward the middle of the ladder. Since the quarter and half ladders are the
    #     illiquid ones, that mechanically produces a systematic NEGATIVE parts-minus-whole gap --
    #     which is exactly the -2.73pt "inconsistency" (t=-4.55) an earlier run reported as real.
    # So volume is required, and the liquidity census is printed as the primary result, because
    # it is the finding.

    # A "tape moved at some point" filter is NOT enough, and the way it fails is instructive.
    # Every contract eventually settles to 0.001 or 1.0, so a market that never traded still
    # shows MAX-MIN ~= 0.5 once the game ends, and sails through. The Bears/Titans ladder read:
    #     over 51.5 = 0.500   over 53.5 = 0.500   over 55.5 = 0.070   over 57.5 = 0.500
    # and the 0.070 next to the 0.500 above it IS the "43-cent arbitrage" this script first
    # reported. It is a resting midpoint beside a real quote, not a box.
    # So the movement has to be PREGAME movement, and an exact 0.500 is rejected outright.

    vol = {cid: (v or 0.0) for cid, v in arc.execute(
        "SELECT condition_id, volume FROM pm_markets WHERE market_type='total'")}
    mv_all = sorted(vol.get(c, 0.0) for c in meta)
    zero = sum(1 for x in mv_all if x <= 0)
    print(f"\nLIQUIDITY CENSUS of the mapped chain (this is the headline result):")
    print(f"   markets {len(mv_all):,}   zero-volume {zero:,} ({100*zero/max(1,len(mv_all)):.0f}%)"
          f"   median ${mv_all[len(mv_all)//2]:,.0f}   p90 ${mv_all[int(.9*len(mv_all))]:,.0f}"
          f"   max ${max(mv_all):,.0f}")
    print(f"   requiring >${MIN_VOLUME:,.0f} traded leaves "
          f"{sum(1 for x in mv_all if x > MIN_VOLUME):,} markets\n")

    price, rejected = {}, collections.Counter()
    for cid, (g, gst, per, line) in meta.items():
        if vol.get(cid, 0.0) <= MIN_VOLUME:
            rejected["illiquid (<=$%.0fk traded)" % (MIN_VOLUME/1000)] += 1
            continue
        try:
            k = int(datetime.fromisoformat(
                str(gst)[:19].replace(" ", "T")).replace(tzinfo=timezone.utc).timestamp())
        except Exception:  # noqa: BLE001
            rejected["bad kickoff"] += 1
            continue
        mv = arc.execute(
            """SELECT COUNT(*), MIN(p), MAX(p) FROM pm_price_history
               WHERE condition_id=? AND t <= ? AND t >= ?""",
            (cid, k, k - WINDOW_H * 3600)).fetchone()
        if not mv or mv[0] < 5 or (mv[2] - mv[1]) < 0.01:
            rejected["never traded pregame"] += 1
            continue
        r = arc.execute(
            """SELECT p, t FROM pm_price_history
               WHERE condition_id=? AND t <= ? AND t >= ? AND p > ? AND p < ?
                 AND abs(p - ?) > ?
               ORDER BY t DESC LIMIT 1""",
            (cid, k, k - WINDOW_H * 3600, RAIL_LO, RAIL_HI, MID, MID_EPS)).fetchone()
        if not r:
            rejected["no live off-midpoint print"] += 1
            continue
        price[cid] = (r[0], r[1])
    print(f"markets with a tradeable pregame print ({WINDOW_H}h window, off the rails): {len(price)}")
    print(f"   rejected: {dict(rejected)}")

    # ---- TEST A: monotonicity violations inside one ladder ---------------------------------
    print("\n" + "=" * 78)
    print("TEST A  MONOTONICITY.  P(over L) must be non-increasing in L. A violation is a box.")
    print("=" * 78)
    viol, checked, by_per = [], 0, collections.Counter()
    for (g, gst), pers in chain.items():
        for per, lines in pers.items():
            pr = {L: price[c][0] for L, c in lines.items() if c in price}
            ts = {L: price[c][1] for L, c in lines.items() if c in price}
            xs = sorted(pr)
            for lo, hi in zip(xs, xs[1:]):
                checked += 1
                gap = pr[hi] - pr[lo]                  # must be <= 0
                if gap > 0:
                    viol.append(dict(game=g, gst=gst, per=per, lo=lo, hi=hi, gap=gap,
                                     dt=abs(ts[hi] - ts[lo]) / 60.0))
                    by_per[per] += 1
    print(f"adjacent strike pairs checked: {checked:,}")
    print(f"violations (P rises with the strike): {len(viol):,} "
          f"({100*len(viol)/max(1,checked):.2f}%)")
    if viol:
        gaps = sorted(v["gap"] for v in viol)
        print(f"violation size in cents: median {100*st.median(gaps):.2f}  "
              f"p90 {100*gaps[int(.9*len(gaps))]:.2f}  max {100*max(gaps):.2f}")
        big = [v for v in viol if v["gap"] > 2 * a.spread_cents / 100]
        print(f"violations exceeding a {a.spread_cents:.0f}c half-spread on BOTH legs: {len(big):,}")
        stale = [v for v in big if v["dt"] > 60]
        print(f"   of those, {len(stale):,} have legs quoted >60 min apart (stale, not arb)")
        fresh = [v for v in big if v["dt"] <= 60]
        print(f"   SIMULTANEOUS and larger than the spread: {len(fresh):,}")
        print(f"   by period: {dict(by_per)}")
        for v in sorted(fresh, key=lambda v: -v["gap"])[:8]:
            print(f"     {v['game'][0]:>12s} v {v['game'][1]:<12s} {v['per']:4s} "
                  f"over{v['lo']:6.1f}={100*(0):.0f}  gap {100*v['gap']:5.1f}c  "
                  f"legs {v['dt']:.0f}min apart")
    else:
        print("none. the chain is internally monotone -- no dominance arbitrage exists in it.")

    # ---- TEST B: additivity of period expectations -----------------------------------------
    print("\n" + "=" * 78)
    print("TEST B  ADDITIVITY.  E[parts] = E[whole]. Linearity of expectation, no independence")
    print("        assumed, so any gap is a pricing inconsistency rather than a modelling choice.")
    print("=" * 78)
    means = {}
    for (g, gst), pers in chain.items():
        for per, lines in pers.items():
            pr = {L: price[c][0] for L, c in lines.items() if c in price}
            if len(pr) >= a.min_strikes:
                m, tf = survival_mean(pr)
                means[(g, gst, per)] = (m, tf, len(pr))

    def cmp(name, parts, whole):
        rows = []
        for (g, gst, per) in list(means):
            if per != whole:
                continue
            need = [(g, gst, p) for p in parts]
            if not all(k in means for k in need):
                continue
            s = sum(means[k][0] for k in need)
            w = means[(g, gst, whole)][0]
            tf = max([means[k][1] for k in need] + [means[(g, gst, whole)][1]])
            if tf > 0.25:
                continue                       # tail convention dominates; not a real measurement
            rows.append((g, gst, s, w, s - w))
        if len(rows) < 6:
            print(f"\n{name}: only {len(rows)} games with both sides deep enough -- not testable")
            return rows
        d = [r[4] for r in rows]
        mean_d, sd = st.mean(d), (st.stdev(d) if len(d) > 1 else 0.0)
        se = sd / math.sqrt(len(d)) if sd else 0.0
        t = mean_d / se if se else 0.0
        print(f"\n{name}   n={len(rows)} games")
        print(f"   parts - whole:  mean {mean_d:+.2f} pts   sd {sd:.2f}   se {se:.2f}   t {t:+.2f}")
        print(f"   median {st.median(d):+.2f}   |gap|>1pt in {sum(1 for x in d if abs(x)>1)}/{len(d)} games")
        sign = sum(1 for x in d if x > 0)
        print(f"   parts richer than whole in {sign}/{len(d)} games (a coin flip says {len(d)/2:.0f})")
        for r in sorted(rows, key=lambda r: -abs(r[4]))[:6]:
            print(f"     {r[0][0]:>12s} v {r[0][1]:<12s}  parts {r[2]:5.1f}  whole {r[3]:5.1f}  "
                  f"gap {r[4]:+5.2f}")
        return rows

    def depth_control(parts, whole, label):
        """Re-price the WHOLE from a ladder thinned to the parts' depth.

        The parts always carry shallower ladders than the game does (halves run 3-5 strikes, the
        game 21), and a shallow ladder biases the survival integral DOWNWARD because the trapezoid
        misses mass between widely-spaced strikes. That alone would manufacture a negative
        parts-minus-whole gap with no market inconsistency behind it. So: recompute E[whole] using
        only as many strikes as the thinnest part had, and see whether the gap survives. If it
        collapses, the finding was my estimator, not Polymarket.
        """
        keep = []
        for (g, gst, per) in list(means):
            if per != whole:
                continue
            need = [(g, gst, p) for p in parts]
            if not all(k in means for k in need):
                continue
            depth = min(means[k][2] for k in need)
            lines = {L: price[c][0] for L, c in chain[(g, gst)][whole].items() if c in price}
            xs = sorted(lines)
            if len(xs) <= depth:
                continue
            step = len(xs) / depth
            thin = {xs[min(len(xs) - 1, int(i * step))]: lines[xs[min(len(xs) - 1, int(i * step))]]
                    for i in range(depth)}
            wt, _ = survival_mean(thin)
            s_parts = sum(means[k][0] for k in need)
            keep.append((s_parts - wt, s_parts - means[(g, gst, whole)][0], depth, len(xs)))
        if len(keep) < 6:
            print(f"   [depth control {label}: only {len(keep)} games, not testable]")
            return
        thinned = [k[0] for k in keep]
        orig = [k[1] for k in keep]
        mt, mo = st.mean(thinned), st.mean(orig)
        sd = st.stdev(thinned) if len(thinned) > 1 else 0.0
        se = sd / math.sqrt(len(thinned)) if sd else 0.0
        print(f"   DEPTH CONTROL ({label}): whole re-priced on a ladder thinned to the parts'")
        print(f"      depth (median {st.median([k[2] for k in keep]):.0f} strikes, down from "
              f"{st.median([k[3] for k in keep]):.0f})")
        print(f"      gap with full ladder   {mo:+.2f} pts")
        print(f"      gap with thinned ladder {mt:+.2f} pts   se {se:.2f}   "
              f"t {(mt/se if se else 0):+.2f}")
        shrink = (1 - abs(mt) / abs(mo)) * 100 if mo else 0
        print(f"      -> {shrink:.0f}% of the gap was the estimator, not the market")

    q_rows = cmp("1Q+2Q+3Q+4Q  vs  GAME", ["1Q", "2Q", "3Q", "4Q"], "GAME")
    depth_control(["1Q", "2Q", "3Q", "4Q"], "GAME", "quarters")
    h_rows = cmp("1H+2H        vs  GAME", ["1H", "2H"], "GAME")
    depth_control(["1H", "2H"], "GAME", "halves")
    f_rows = cmp("1Q+2Q        vs  1H  ", ["1Q", "2Q"], "1H")

    # ---- TEST C: which leg was right ---------------------------------------------------------
    print("\n" + "=" * 78)
    print("TEST C  WHICH SIDE WAS RIGHT. A gap only matters if the settled score picks a winner.")
    print("=" * 78)
    try:
        nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=600)
        actual = {}
        for season, week, home, away, hs, as_, gd in nv.execute(
                """SELECT season, week, home_team, away_team, home_score, away_score, gameday
                   FROM nfldata_games WHERE season>=2026 AND home_score IS NOT NULL"""):
            actual[(home, away, gd)] = hs + as_
        print(f"settled 2026 games available in nflverse: {len(actual)}")
        if not actual:
            print("no settled 2026 games joined yet -- Test C cannot run on this window.")
        else:
            hits = 0
            for g, gst, s, w, d in (q_rows + h_rows):
                day = str(gst)[:10]
                tot = next((v for (h, aw, gd), v in actual.items() if gd == day), None)
                if tot is None:
                    continue
                hits += 1
            print(f"coherence games joinable to a settled score: {hits}")
            print("(team-name join from Polymarket nicknames to nflverse abbreviations is the")
            print(" remaining work here; reported rather than faked.)")
    except Exception as e:  # noqa: BLE001
        print("nflverse join unavailable:", str(e)[:200])

    print("\n" + "=" * 78)
    print("WHAT THIS RUN ESTABLISHED. Polymarket's NFL derivative chain is almost entirely")
    print("untraded: 85% of total markets have never traded a dollar, and the median game has no")
    print("strike above $5k of volume. Coherence testing needs simultaneous tradeable quotes at")
    print("several strikes, and outside a small liquid core of game-level markets this chain does")
    print("not have them. Both apparent findings from the unfiltered run -- a 23% monotonicity")
    print("violation rate and a -2.73pt half-vs-game additivity gap at t=-4.55 -- were artifacts of")
    print("resting midpoints, and both are withdrawn. The usable surface is the liquid core:")
    print("game spread, game total and moneyline, which is where this should go next.")
    print("=" * 78)


if __name__ == "__main__":
    main()
