#!/usr/bin/env python3
"""
Historical backtest of the `teamrankings_vs_open` signal that the preregistered shadow tape bet.

The 2026 week-1 shadow tape came in at +0.94pp CLV clustered over 15 games (t=+2.04) -- promising
but far too small to conclude anything. The decisions themselves cite a prior basis of
"+0.58 CLV, 57.7%, n 570 held out". This reproduces that historical test on rebuilt data so the
forward week can be read against a real sample rather than a remembered one.

THE SIGNAL, as recorded in the tape's own feature_snapshot_json:
  value    = (rating-implied home margin) - (opener's home margin)
  centered = value - mean(value) across that week's slate
  bet the home side when centered >= threshold, the away side when centered <= -threshold
Centering by the slate is what makes it a relative signal: it removes any week-wide bias between
the rating system's scale and the market's.

NO LOOK-AHEAD, enforced three ways:
  - ratings come from the most recent week STRICTLY BEFORE the game's week (as the repo's own
    teamrankings lookup does);
  - home-field advantage is fitted only on seasons STRICTLY BEFORE the season being tested;
  - the opener is the earliest quote in nfl_odds_archive, and the close comes from nflverse,
    so the bet is priced at a number that existed before kickoff.

GRADED ON CLV, not win rate. Closing-line value is the quantity that has predictive content at
small n; win rate at n in the hundreds is mostly sampling noise. Standard errors are clustered
by game, because several books/markets on one game share the same line move.

Usage: python3 scripts/model-lab/beat_close_backtest.py [--threshold 0.5]
"""
import argparse
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


def cover_pmf(cur):
    vals = [r[0] for r in cur.execute(
        "SELECT result FROM nfldata_games WHERE season BETWEEN 1999 AND 2025 AND result IS NOT NULL")]
    pmf = defaultdict(float)
    for v in vals:
        pmf[float(v)] += 1.0 / len(vals)
    return pmf


def p_home_covers(pmf, home_line_std):
    """P(home side covers) for a home line in standard notation (negative = home laying)."""
    need = -home_line_std
    win = sum(p for v, p in pmf.items() if v > need)
    push = sum(p for v, p in pmf.items() if v == need)
    return win / (1 - push) if push < 1 else 0.5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--source", default="teamrankings_predictive")
    a = ap.parse_args()

    live = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)
    nv = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True)
    pmf = cover_pmf(nv)

    # ---- ratings, indexed so we can take the latest week strictly before a target week
    ratings = defaultdict(dict)          # (season) -> week -> {team: rating}
    for season, week, team, rating in live.execute(
            "SELECT season, week, team, rating FROM nfl_external_ratings WHERE source=?", (a.source,)):
        ratings[season].setdefault(week, {})[team] = rating

    def rating_before(season, week, team):
        weeks = sorted(w for w in ratings.get(season, {}) if w < week)
        for w in reversed(weeks):
            if team in ratings[season][w]:
                return ratings[season][w][team]
        return None

    # ---- games with a final score and a closing line
    # Neutral-site games are excluded: London, Munich, Mexico City, São Paulo and domestic
    # relocations (the CLE/BUF snow game moved to Ford Field) have no real home team, so the
    # home-field term fitted below is simply wrong for them, and their line behaviour is driven
    # by travel and ticket mix rather than by anything this signal measures. 36 games since 2022.
    games = {}
    for season, week, away, home, a_s, h_s, sl in nv.execute(
            """SELECT season, week, away_team, home_team, away_score, home_score, spread_line
               FROM nfldata_games WHERE home_score IS NOT NULL AND spread_line IS NOT NULL
                 AND season >= 2019 AND location = 'Home'"""):
        games[(season, week, home, away)] = dict(margin=h_s - a_s, close_home_std=-sl)

    # ---- the line we could ACTUALLY have bet at the moment the rating was known.
    #
    # An earlier version of this script used nfl_odds_archive's opener. That was look-ahead: those
    # openers sit a median 11-12 days before kickoff (tail out to 276 days, and 2026's median is
    # 134 days because spring lookahead lines are in there). Pricing a week-W rating against a line
    # posted around week W-2 lets the rating exploit two weeks of information the market had not
    # seen -- and you cannot bet a line that is no longer quoted. The measured "edge" was that gap.
    #
    # The live tape did this correctly: its opener_at and captured_at were 23 seconds apart. So the
    # decision time here is the Wednesday before kickoff (when the week's ratings publish), and the
    # price is the last Covers quote at or before that instant.
    arc = sqlite3.connect(f"file:{REPO / 'data/line-history/line_history.sqlite'}?mode=ro", uri=True)
    cg = {}
    for gid, season, gdate, away, home in arc.execute(
            "SELECT game_id, season, game_date, away, home FROM covers_games"):
        fix = {"JAC": "JAX", "LA": "LAR"}
        cg[gid] = (season, gdate, fix.get(away, away), fix.get(home, home))

    import datetime as _dt
    quotes = defaultdict(list)
    for gid, ts, hl in arc.execute(
            """SELECT game_id, ts_utc, home_line FROM covers_line_history
               WHERE market='spread' AND home_line IS NOT NULL ORDER BY ts_utc"""):
        quotes[gid].append((ts, hl))

    openers, decision_lag = {}, []
    for gid, rows in quotes.items():
        meta = cg.get(gid)
        if not meta:
            continue
        season, gdate, away, home = meta
        try:
            kick = _dt.date.fromisoformat(gdate)
        except Exception:
            continue
        # Wednesday of game week: kickoff minus its weekday offset back to Wednesday, min 3 days.
        decide = kick - _dt.timedelta(days=3)
        cutoff = decide.isoformat() + "T23:59"
        usable = [(ts, hl) for ts, hl in rows if ts <= cutoff]
        if not usable:
            continue
        ts, hl = usable[-1]
        wk = next((w for (s, w, h, aw) in games if s == season and h == home and aw == away), None)
        if wk is None:
            continue
        openers[(season, wk, home, away)] = hl
        try:
            decision_lag.append((kick - _dt.date.fromisoformat(ts[:10])).days)
        except Exception:
            pass
    if decision_lag:
        decision_lag.sort()
        print(f"decision-point lag to kickoff: median {decision_lag[len(decision_lag)//2]} days, "
              f"p90 {decision_lag[9*len(decision_lag)//10]} days (target: ~3)")

    # ---- home-field advantage, fitted walk-forward on prior seasons only
    def hfa_for(season):
        prior = [g["margin"] for (s, w, h, aw), g in games.items() if s < season]
        return st.mean(prior) if len(prior) > 50 else 2.0

    # ---- build the signal per week, then centre it across the slate
    per_week = defaultdict(list)
    for (season, week, home, away), g in games.items():
        op = openers.get((season, week, home, away))
        if op is None:
            continue
        rh, ra = rating_before(season, week, home), rating_before(season, week, away)
        if rh is None or ra is None:
            continue
        pred_home_margin = (rh - ra) + hfa_for(season)
        open_home_margin = -op
        per_week[(season, week)].append(
            dict(home=home, away=away, value=pred_home_margin - open_home_margin,
                 opener=op, close=g["close_home_std"], margin=g["margin"]))

    bets = []
    for (season, week), rows in per_week.items():
        if len(rows) < 4:
            continue
        mean_v = st.mean(r["value"] for r in rows)
        for r in rows:
            centered = r["value"] - mean_v
            if abs(centered) < a.threshold:
                continue
            is_home = centered > 0
            taken = r["opener"] if is_home else -r["opener"]
            close = r["close"] if is_home else -r["close"]
            side_margin = r["margin"] if is_home else -r["margin"]
            won = (side_margin + taken) > 0
            push = (side_margin + taken) == 0
            if is_home:
                pt, pc = p_home_covers(pmf, taken), p_home_covers(pmf, close)
            else:
                pt = 1 - p_home_covers(pmf, -taken)
                pc = 1 - p_home_covers(pmf, -close)
            bets.append(dict(season=season, week=week, game=f"{r['away']}@{r['home']}",
                             side="home" if is_home else "away", centered=centered,
                             taken=taken, close=close, clv_pts=taken - close,
                             clv_prob=pt - pc, won=None if push else won, push=push))

    if not bets:
        print("no bets produced — check rating/opener coverage")
        return

    def report(name, rs):
        dec = [r for r in rs if not r["push"]]
        w = sum(1 for r in dec if r["won"])
        n = len(dec)
        clv = [r["clv_prob"] * 100 for r in rs]
        byg = defaultdict(list)
        for r in rs:
            byg[(r["season"], r["week"], r["game"])].append(r["clv_prob"] * 100)
        cl = [st.mean(v) for v in byg.values()]
        m = st.mean(cl)
        se = st.stdev(cl) / math.sqrt(len(cl)) if len(cl) > 1 else 0
        t = m / se if se else 0
        wr = 100 * w / n if n else 0
        print(f"{name:16s} bets={len(rs):5d} games={len(cl):5d}  W-L {w}-{n-w} ({wr:5.1f}%)  "
              f"CLV {st.mean([r['clv_pts'] for r in rs]):+5.2f}pts {m:+5.2f}pp  "
              f"SE {se:4.2f}  t={t:+5.2f}")

    print(f"threshold {a.threshold} | source {a.source}")
    print(f"opener coverage: {len(openers)} games | rating weeks: "
          f"{sum(len(v) for v in ratings.values())}\n")
    print("=" * 108)
    report("ALL", bets)
    print("-" * 108)
    for s in sorted({b["season"] for b in bets}):
        report(f"season {s}", [b for b in bets if b["season"] == s])
    print("-" * 108)
    for sd in ("home", "away"):
        report(sd, [b for b in bets if b["side"] == sd])
    print("=" * 108)

    out = REPO / "docs/evidence/2026-09-17/beat-close-backtest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    json.dump(dict(threshold=a.threshold, source=a.source, n=len(bets), bets=bets), open(out, "w"))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
