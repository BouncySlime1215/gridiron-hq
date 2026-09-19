#!/usr/bin/env python3
"""
Q1/Q2. What fraction of line movement is PERMANENT (information) and what fraction is NOISE?

WHY THIS IS THE MOST USEFUL NUMBER IN THE REPO, whether or not it is bettable. Every strategy
that touches line movement implicitly assumes an answer:

  * "steam" and "follow the sharp money" assume moves PERSIST -- that a move carries information.
  * "fade the public" and "buy the closing-line bounce" assume moves REVERT -- that they overshoot.
  * The graveyard contains dead versions of BOTH, which is suspicious: if moves clearly persisted,
    fading would fail for an obvious reason, and vice versa. Nobody measured which regime we are
    actually in; they just tested rules.

The finance answer is the variance ratio (Lo-MacKinlay). For a random walk, the variance of a
k-period change equals k times the variance of a 1-period change, so VR(k) = 1. VR < 1 means mean
reversion (the series overshoots and comes back -- noise dominates); VR > 1 means momentum
(information arrives in a correlated stream). The deviation from 1 IS the answer.

SAMPLING. covers quotes are irregular and bursty, and a variance ratio on irregular samples
measures the SAMPLING, not the series. So the tape is resampled onto a fixed hourly grid by
last-observation-carried-forward within each game, from 168h before kickoff to kickoff, and games
without adequate coverage are dropped rather than interpolated. The count dropped is reported.

A SECOND, MODEL-FREE VIEW. Regress (close - line_T) on (line_T - line_{T-h}). A coefficient of 0
means the move at T persisted to the close (information); -1 means it fully reverted (noise). This
requires no stationarity assumption and is directly interpretable, so it is the primary result and
the variance ratio is the cross-check.

THE MONEY ARM. If moves revert, fading them is correct on average; if they persist, following is.
Both rules are graded at real posted prices with a bet-everything control, because a reversion
that is real in POINTS can still be worth less than the vig -- which is exactly what happened to
the favourite drift (+0.1005 pts at t=+5.37, worth +0.35pp against the 2.2pp vig demands).

Usage: python3 scripts/model-lab/permanent_transitory.py
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
GRID_H = 168          # hours before kickoff the grid starts
MIN_COVER = 0.60      # fraction of grid points a game must have real quotes before


def parse_ts(s):
    try:
        return datetime.fromisoformat(str(s)[:19].replace(" ", "T")).replace(tzinfo=timezone.utc)
    except Exception:  # noqa: BLE001
        return None


def kickoff_utc(gdate, ket):
    try:
        t = str(ket or "").strip()
        if not t:
            return None
        return datetime.strptime(f"{str(gdate)[:10]} {t}", "%Y-%m-%d %I:%M %p").replace(
            tzinfo=ET).astimezone(timezone.utc)
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


def main():
    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=600)
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True, timeout=600)

    kicks, meta = {}, {}
    for gid, gdate, ket, away, home in arc.execute(
            "SELECT game_id, game_date, kickoff_et, away, home FROM covers_games"):
        k = kickoff_utc(gdate, ket)
        if k:
            kicks[gid] = k
            meta[gid] = (str(gdate)[:10], away, home)

    out = {}
    for home, away, hs, as_, gd, gt in nv.execute(
            """SELECT home_team, away_team, home_score, away_score, gameday, game_type
               FROM nfldata_games WHERE home_score IS NOT NULL"""):
        if gt is not None and str(gt).upper() != "REG":
            continue
        out[(str(gd)[:10], home, away)] = hs - as_

    raw = collections.defaultdict(list)
    for gid, ts, hl, hp, ap in arc.execute(
            """SELECT game_id, ts_utc, home_line, home_price, away_price FROM covers_line_history
               WHERE market='spread' AND home_line IS NOT NULL ORDER BY ts_utc"""):
        t = parse_ts(ts)
        if t and gid in kicks and t <= kicks[gid]:
            raw[gid].append((t, float(hl), hp, ap))
    print(f"games with a pre-kickoff tape: {len(raw):,}")

    # ---- resample onto an hourly grid, LOCF, drop thin games ---------------------------------
    grids = {}
    dropped = 0
    for gid, rows in raw.items():
        k = kicks[gid]
        series, have, j, cur = [], 0, 0, None
        for h in range(GRID_H, -1, -1):
            cut = k - timedelta(hours=h)
            seen = False
            while j < len(rows) and rows[j][0] <= cut:
                cur = rows[j]
                j += 1
                seen = True
            if cur is None:
                series.append(None)
            else:
                series.append(cur[1])
                have += 1 if seen else 0
            if seen:
                pass
        real = sum(1 for v in series if v is not None)
        if real / len(series) < MIN_COVER or series[-1] is None:
            dropped += 1
            continue
        # forward fill leading Nones with the first observation
        first = next(v for v in series if v is not None)
        series = [v if v is not None else first for v in series]
        grids[gid] = series
    print(f"games on the hourly grid: {len(grids):,}  (dropped {dropped:,} for <{MIN_COVER:.0%} coverage)")
    if len(grids) < 200:
        print("too few games gridded.")
        return

    # ---- 1. VARIANCE RATIOS -------------------------------------------------------------------
    print("\n" + "=" * 78)
    print("1. VARIANCE RATIO.  VR(k) = var(k-hour change) / (k * var(1-hour change))")
    print("=" * 78)
    print("   VR = 1 random walk | VR < 1 MEAN REVERSION (noise) | VR > 1 MOMENTUM (information)")
    print(f"\n   {'k (hours)':>10s} {'VR':>8s} {'se':>7s} {'z(VR=1)':>9s}  {'reading':>16s}")
    d1 = []
    for s in grids.values():
        d1 += [s[i + 1] - s[i] for i in range(len(s) - 1)]
    v1 = st.pvariance(d1)
    for k in (2, 3, 6, 12, 24, 48, 72):
        dk = []
        for s in grids.values():
            dk += [s[i + k] - s[i] for i in range(0, len(s) - k, k)]
        if len(dk) < 200 or v1 == 0:
            continue
        vk = st.pvariance(dk)
        vr = vk / (k * v1)
        # Lo-MacKinlay homoskedastic SE
        n = len(dk) * k
        se = math.sqrt(2 * (2 * k - 1) * (k - 1) / (3 * k * n))
        z = (vr - 1) / se if se else 0
        reading = "MEAN REVERSION" if vr < 1 else ("MOMENTUM" if vr > 1 else "random walk")
        print(f"   {k:10d} {vr:8.4f} {se:7.4f} {z:+9.2f}  {reading:>16s}")

    # ---- 2. PERSISTENCE REGRESSION (primary) --------------------------------------------------
    print("\n" + "=" * 78)
    print("2. PERSISTENCE.  regress (close - line_T) on (line_T - line_{T-h})")
    print("=" * 78)
    print("   coef  0 = the move PERSISTED to the close (information)")
    print("   coef -1 = the move FULLY REVERTED (noise)")
    print(f"\n   {'T (h to kick)':>14s} {'h':>4s} {'n':>6s} {'coef':>8s} {'se':>7s} {'t(0)':>8s} {'permanent %':>12s}")
    for T in (72, 48, 24, 12, 6, 3):
        for h in (6, 12, 24):
            xs, ys, gids = [], [], []
            for gid, s in grids.items():
                iT = len(s) - 1 - T
                iTh = iT - h
                if iTh < 0:
                    continue
                move = s[iT] - s[iTh]
                fwd = s[-1] - s[iT]
                if abs(move) < 1e-9:
                    continue
                xs.append(move)
                ys.append(fwd)
                gids.append(gid)
            if len(xs) < 150:
                continue
            mx, my = st.mean(xs), st.mean(ys)
            sxx = sum((x - mx) ** 2 for x in xs)
            if sxx == 0:
                continue
            b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
            resid = [y - (my + b * (x - mx)) for x, y in zip(xs, ys)]
            # game-clustered SE of the slope
            g = collections.defaultdict(float)
            for gid, x, r in zip(gids, xs, resid):
                g[gid] += (x - mx) * r
            meat = sum(v * v for v in g.values())
            se = math.sqrt(meat) / sxx if sxx else 0
            perm = 100 * (1 + b)
            print(f"   {T:14d} {h:4d} {len(xs):6d} {b:+8.4f} {se:7.4f} {b/se if se else 0:+8.2f} "
                  f"{perm:11.1f}%")

    # ---- 3. THE MONEY ARM ----------------------------------------------------------------------
    print("\n" + "=" * 78)
    print("3. MONEY. Fade or follow the last 24h move, graded at real posted prices.")
    print("=" * 78)

    def am_profit(price, won):
        b = price / 100 if price > 0 else 100 / -price
        return b if won else -1.0

    # control
    both = []
    for gid, s in grids.items():
        gd, away, home = meta[gid]
        margin = out.get((gd, home, away))
        last = raw[gid][-1]
        if margin is None or last[2] is None or last[3] is None:
            continue
        d = margin + last[1]
        if abs(d) < 1e-9:
            continue
        both.append((gid, am_profit(float(last[2]), d > 0)))
        both.append((gid, am_profit(float(last[3]), d < 0)))
    r = clustered(both)
    if r:
        m, se, n, G = r
        print(f"   CONTROL both sides at close: {100*m:+.3f}% +/- {100*se:.3f} (n={n:,}, {G} games)")
        print(f"   {'PASS (single-book vig, theory ~-5.49%)' if -6.2 < 100*m < -4.6 else 'FAIL'}")

    for label, sign in (("FOLLOW the move", +1), ("FADE the move", -1)):
        rows = []
        for gid, s in grids.items():
            gd, away, home = meta[gid]
            margin = out.get((gd, home, away))
            if margin is None:
                continue
            iT = len(s) - 1 - 24
            if iT < 0:
                continue
            move = s[-1] - s[iT]          # last 24h of line movement, in home-line terms
            if abs(move) < 0.5:
                continue                   # require a real move
            last = raw[gid][-1]
            # a move making home_line MORE negative = market moved toward HOME
            toward_home = move < 0
            bet_home = toward_home if sign > 0 else (not toward_home)
            price = last[2] if bet_home else last[3]
            if price is None:
                continue
            d = margin + last[1]
            if abs(d) < 1e-9:
                continue
            won = (d > 0) if bet_home else (d < 0)
            rows.append((gid, am_profit(float(price), won)))
        rr = clustered(rows)
        if rr and rr[2] >= 100:
            m, se, n, G = rr
            print(f"   {label:18s}: {100*m:+.3f}% +/- {100*se:.3f}  n={n:,} ({G} games)  "
                  f"t={m/se if se else 0:+.2f}")

    print("\n" + "=" * 78)
    print("READING THIS")
    print("=" * 78)
    print("   A persistence coefficient near 0 means the market is efficient in the strong sense:")
    print("   a move at T is already the best estimate of the close, so neither following nor")
    print("   fading has anything to work with. A coefficient far from 0 in EITHER direction is a")
    print("   predictable component -- and must then be converted to money at ~0.035 cover-")
    print("   probability per point before being compared to a vig of 2.2pp. The favourite drift")
    print("   cleared t=+5.37 and still came to only +0.35pp. Points are not percent.")


if __name__ == "__main__":
    main()
