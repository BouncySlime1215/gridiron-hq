#!/usr/bin/env python3
"""
Opener lab LEVEL 3 — when does the move happen, and do Kalshi / Polymarket
move first? Forward-only on 2026 (no intraday history exists before it).
Per LATEST-PLAN "PREREGISTERED — OPENER LAB", level 3. Re-run weekly; the
forward success test applies once >= 150 games have kicked off.

Consensus line: for every game, each book's latest home spread carried
forward hour by hour; consensus = median across books. Home-margin terms
(margin = -spread). Kalshi: home-team winner market, mid of yes and 1 - no,
implied margin = 13.45 x inverse-normal(p). Polymarket: its home spread.
M1 timing (games already kicked off), M2 hourly-change cross-correlation at
lags -6..+6 h (positive lag = the prediction market moved FIRST), M3 when
|Kalshi - consensus| >= 1 pt, how often consensus moves toward Kalshi within
24 h (first hour of each non-overlapping 24 h episode per game).
Read-only. Output: docs/evidence/2026-09-16/opener-lab/level3.json
"""
import json, math, sqlite3, statistics as st
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import NormalDist

REPO = Path(__file__).resolve().parents[2]
LIVE = "/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/data.sqlite"
import sys
TOTALS = "--totals" in sys.argv
OUT = REPO / ("docs/evidence/2026-09-16/opener-lab/level3-totals.json" if TOTALS else "docs/evidence/2026-09-16/opener-lab/level3.json")
SD = 13.45
CODE = {"Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF", "Carolina Panthers": "CAR",
        "Chicago Bears": "CHI", "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL", "Denver Broncos": "DEN",
        "Detroit Lions": "DET", "Green Bay Packers": "GB", "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
        "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC", "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA",
        "Minnesota Vikings": "MIN", "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG", "New York Jets": "NYJ",
        "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT", "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA",
        "Tampa Bay Buccaneers": "TB", "Tennessee Titans": "TEN", "Washington Commanders": "WAS"}


def ts(x):
    return datetime.fromisoformat(x.replace("Z", "+00:00"))


def hour(t):
    return t.replace(minute=0, second=0, microsecond=0)


def carry(points, grid):
    """points: sorted [(t, v)]; returns value at each grid hour (latest at or before), None before first."""
    times = [p[0] for p in points]
    out = []
    for g in grid:
        i = bisect_right(times, g + timedelta(minutes=59, seconds=59)) - 1
        out.append(points[i][1] if i >= 0 else None)
    return out


def main():
    con = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)
    now = datetime.now(timezone.utc)
    books = defaultdict(lambda: defaultdict(list))
    kick = {}
    for cap, ko, home, away, book, side, line in con.execute(
            """SELECT captured_at, commence_time, home_team, away_team, book, side, line FROM nfl_line_snapshots
               WHERE market=? AND commence_time >= '2026-09-01' AND line IS NOT NULL AND side = ?""", ("totals", "Over") if TOTALS else ("spreads", None)) if False else con.execute(
            f"""SELECT captured_at, commence_time, home_team, away_team, book, side, line FROM nfl_line_snapshots
               WHERE market='{'totals' if TOTALS else 'spreads'}' AND commence_time >= '2026-09-01' AND line IS NOT NULL AND side = {"'Over'" if TOTALS else 'home_team'}"""):
        if home not in CODE or away not in CODE:
            continue
        k = (CODE[home], CODE[away], ko[:13])
        kick[k] = ts(ko)
        books[k][book].append((ts(cap), line if TOTALS else -line))
    games = {}
    for k in books:
        per_book = {b: sorted(v) for b, v in books[k].items()}
        start = hour(min(v[0][0] for v in per_book.values()))
        end = min(kick[k], hour(now))
        grid = [start + timedelta(hours=i) for i in range(int((end - start).total_seconds() // 3600) + 1)]
        cols = [carry(v, grid) for v in per_book.values()]
        cons = [st.median([c[i] for c in cols if c[i] is not None]) if any(c[i] is not None for c in cols) else None for i in range(len(grid))]
        games[k] = dict(grid=grid, cons=cons, n_books=len(per_book))

    kal = defaultdict(list)
    for cap, ticker, yes, no, ek in con.execute(
            "SELECT captured_at, ticker, yes_price, no_price, event_key FROM prediction_market_quotes WHERE ticker LIKE 'KXNFLGAME-%' AND yes_price IS NOT NULL"):
        away, home = (ek or "@").split("@")
        if not ticker.endswith("-" + home):
            continue
        p = yes if no is None else (yes + (1 - no)) / 2
        p = min(max(p, 0.02), 0.98)
        kal[(home, away, ticker.split("-")[1][:7])].append((ts(cap), SD * NormalDist().inv_cdf(p)))
    poly = defaultdict(list)
    col = "total" if TOTALS else "home_spread"
    for cap, home, away, ko, v in con.execute(f"SELECT captured_at, home_team, away_team, commence_time, {col} FROM polymarket_line_moves WHERE {col} IS NOT NULL"):
        poly[(home, away, ko[:13])].append((ts(cap), v if TOTALS else -v))

    def kalshi_for(k):
        home, away, ko = k
        kd = kick[k]
        for dd in (0, -1, 1):
            d = (kd + timedelta(days=dd)).strftime("%y%b%d").upper()
            if (home, away, d) in kal:
                return sorted(kal[(home, away, d)])
        return None

    report = dict(generated=now.isoformat(), games=len(games), kicked_off=sum(kick[k] <= now for k in games))

    # ---- M1 timing, games already kicked off
    fr = defaultdict(list); first_move = []; pre = defaultdict(list); m1_games = 0
    for k, g in games.items():
        if kick[k] > now:
            continue
        vals = [(t, v) for t, v in zip(g["grid"], g["cons"]) if v is not None]
        if len(vals) < 2:
            continue
        t0, v0 = vals[0]; vc = vals[-1][1]; total = vc - v0
        if abs(total) < 0.5:
            continue
        m1_games += 1
        at = lambda T: [v for t, v in vals if t <= T][-1]
        for h in (1, 6, 24, 72):
            fr[f"+{h}h"].append((at(t0 + timedelta(hours=h)) - v0) / total)
        for h in (72, 24, 3):
            pre[f"kickoff-{h}h"].append((at(kick[k] - timedelta(hours=h)) - v0) / total)
        mv = next((t for t, v in vals if abs(v - v0) >= 0.5), None)
        if mv:
            first_move.append((mv - t0).total_seconds() / 3600)
    report["M1"] = dict(games_with_move=m1_games,
                        share_of_move_done_after_open={k: st.median(v) for k, v in fr.items()},
                        share_of_move_done_before_kickoff={k: st.median(v) for k, v in pre.items()},
                        median_hours_until_first_half_point_move=st.median(first_move) if first_move else None)

    # ---- M2 lead-lag, M3 follow-the-prediction-market
    for name, source in ([("polymarket", lambda k: sorted(poly.get(k, [])) or None)] if TOTALS else [("kalshi", kalshi_for), ("polymarket", lambda k: sorted(poly.get(k, [])) or None)]):
        pairs, diffs, episodes = defaultdict(list), [], []
        matched = 0
        for k, g in games.items():
            pts = source(k)
            if not pts:
                continue
            pm = carry(pts, g["grid"])
            both = [(t, c, p) for t, c, p in zip(g["grid"], g["cons"], pm) if c is not None and p is not None]
            if len(both) < 30:
                continue
            matched += 1
            dc = [both[i + 1][1] - both[i][1] for i in range(len(both) - 1)]
            dp = [both[i + 1][2] - both[i][2] for i in range(len(both) - 1)]
            for lag in range(-6, 7):
                for i in range(len(dp)):
                    j = i + lag
                    if 0 <= j < len(dc):
                        pairs[lag].append((dp[i], dc[j]))
            diffs += [p - c for _, c, p in both]
            last_ep = None
            for i, (t, c, p) in enumerate(both):
                if abs(p - c) >= 1 and (last_ep is None or t >= last_ep + timedelta(hours=24)):
                    later = [x for x in both[i:] if x[0] <= t + timedelta(hours=24)]
                    if later[-1][0] < t + timedelta(hours=23):
                        continue
                    last_ep = t
                    moved = later[-1][1] - c
                    episodes.append(dict(gap=p - c, consensus_move=moved, toward=(moved != 0 and (moved > 0) == (p - c > 0))))
        def corr(xy):
            xs, ys = zip(*xy)
            if st.pstdev(xs) == 0 or st.pstdev(ys) == 0:
                return None
            return st.correlation(xs, ys)
        cc = {lag: corr(v) for lag, v in pairs.items() if len(v) > 50}
        moved_eps = [e for e in episodes if e["consensus_move"] != 0]
        rate = sum(e["toward"] for e in moved_eps) / len(moved_eps) if moved_eps else None
        n = len(moved_eps); kk = sum(e["toward"] for e in moved_eps)
        pval = sum(math.comb(n, i) for i in range(kk, n + 1)) / 2 ** n if n else None
        report[name] = dict(games_matched=matched, mean_gap_vs_consensus=st.mean(diffs) if diffs else None,
                            M2_cross_correlation={str(k): v for k, v in sorted(cc.items())},
                            M3=dict(episodes=len(episodes), episodes_where_consensus_moved=n, rate_toward=rate,
                                    one_sided_binomial_p=pval,
                                    mean_move_toward_gap=st.mean(e["consensus_move"] * (1 if e["gap"] > 0 else -1) for e in episodes) if episodes else None))
    OUT.write_text(json.dumps(report, indent=1, default=str))
    print(json.dumps(report, indent=1, default=str))


if __name__ == "__main__":
    main()
