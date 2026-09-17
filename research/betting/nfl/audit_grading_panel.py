#!/usr/bin/env python
"""
Post-build audit of data/grading_panel.sqlite. Reads the built panel only, so
it is fast and can be re-run after any rebuild.

  A. PLACEBO -- a random side on every game must return -vig, not more.
  B. EXTREME PRICES -- any surviving in-game-looking price would be a leak.
  C. CLV SANITY -- T-minus snapshots must move TOWARD the close, and
     betting the snapshot price blind must still return -vig.
  D. PER-SEASON CONTROL -- the control must hold in every season, not on average.
"""
import collections
import math
import os
import random
import sqlite3
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import grading_panel as gp

PANEL = gp.DEFAULT_OUT


def pct(x):
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{100*x:+.3f}%"


def rows(db, market):
    return db.execute(
        "select nfl_game_id, season, close_line, close_price_home, close_price_away,"
        "       result_home, result_away, hold_best "
        "from grading_panel where market=? and result_home is not null", (market,)
    ).fetchall()


def placebo(db):
    print("-" * 78)
    print("A. PLACEBO: random side, every game. Must land on -vig.")
    print("-" * 78)
    print(f"   {'market':<10} {'seeds 1-10 mean ROI':>21} {'min':>10} {'max':>10} {'typical SE':>12}")
    for m in gp.MARKETS:
        rs = rows(db, m)
        out, ses = [], []
        for seed in range(1, 11):
            rnd = random.Random(seed)
            rets, clus = [], []
            for g, _s, _l, ph, pa, rh, ra, _h in rs:
                if rnd.random() < 0.5:
                    res, p = rh, ph
                else:
                    res, p = ra, pa
                rets.append(gp.bet_return(res, p))
                clus.append(g)
            out.append(sum(rets) / len(rets))
            ses.append(gp.cluster_se(rets, clus))
        print(f"   {m:<10} {pct(statistics.fmean(out)):>21} {pct(min(out)):>10} "
              f"{pct(max(out)):>10} {100*statistics.fmean(ses):>11.3f}%")
    print()


def extreme(db):
    print("-" * 78)
    print("B. EXTREME PRICES: any in-game-looking price still in the panel?")
    print("-" * 78)
    for m in gp.MARKETS:
        r = db.execute(
            "select min(close_price_home), max(close_price_home),"
            "       min(close_price_away), max(close_price_away) "
            "from grading_panel where market=?", (m,)).fetchone()
        n_big = db.execute(
            "select count(*) from grading_panel where market=? and "
            "(close_price_home > 1500 or close_price_away > 1500 or "
            " close_price_home < -3000 or close_price_away < -3000)", (m,)).fetchone()[0]
        print(f"   {m:<10} home price [{r[0]:>7},{r[1]:>6}]  away price [{r[2]:>7},{r[3]:>6}]"
              f"   beyond +1500/-3000: {n_big}")
    worst = db.execute(
        "select nfl_game_id, close_line, close_price_home, close_price_away, close_lag_min "
        "from grading_panel where market='moneyline' "
        "order by max(close_price_home, close_price_away) desc limit 5").fetchall()
    print("   longest moneyline dogs surviving the filter (should be real big underdogs):")
    for g, l, ph, pa, lag in worst:
        sp = db.execute("select close_line from grading_panel where nfl_game_id=? and market='spread'",
                        (g,)).fetchone()
        print(f"     {g:<22} ML {ph:+6d}/{pa:+6d}  spread {sp[0] if sp else None:+5.1f}  "
              f"close {lag:.0f} min pre-kick")
    print("   (a real +900 dog is a 14-17 point underdog; an in-game leak would show")
    print("    a huge price next to a small spread)")
    print()


def clv(db):
    print("-" * 78)
    print("C. CLV SANITY: T-minus snapshots vs the close")
    print("-" * 78)
    hs = [r[0] for r in db.execute(
        "select distinct horizon_min from panel_snapshots order by horizon_min")]
    print(f"   {'market':<10} {'T-minus':>8} {'games':>6} {'|close-snap| line':>18} "
          f"{'blind-both-sides ROI':>22}")
    for m in gp.MARKETS:
        for h in hs:
            rs = db.execute(
                "select s.nfl_game_id, s.price_home, s.price_away, s.result_home,"
                "       s.result_away, s.close_minus_snap_line "
                "from panel_snapshots s join grading_panel p "
                "  on p.nfl_game_id=s.nfl_game_id and p.market=s.market "
                "where s.market=? and s.horizon_min=? and s.result_home is not null",
                (m, h)).fetchall()
            if not rs:
                continue
            rets, clus = [], []
            for g, ph, pa, rh, ra, _d in rs:
                rets += [gp.bet_return(rh, ph), gp.bet_return(ra, pa)]
                clus += [g, g]
            moves = [abs(r[5]) for r in rs if r[5] is not None]
            mv = f"{statistics.fmean(moves):.3f}" if moves else "  n/a"
            print(f"   {m:<10} {h:>8} {len(rs):>6} {mv:>18} "
                  f"{pct(sum(rets)/len(rets)):>22}")
    print("   line movement must GROW with horizon (T-4320 further from the close than")
    print("   T-60); blind both-sides at every horizon must still be -vig.")
    print()


def per_season(db):
    print("-" * 78)
    print("D. PER-SEASON CONTROL (bet everything, best price). No season may be odd.")
    print("-" * 78)
    seasons = [r[0] for r in db.execute("select distinct season from grading_panel order by season")]
    print(f"   {'season':>6} " + "".join(f"{m:>26}" for m in gp.MARKETS))
    for s in seasons:
        line = f"   {s:>6} "
        for m in gp.MARKETS:
            rs = db.execute(
                "select nfl_game_id, close_price_home, close_price_away, result_home, result_away "
                "from grading_panel where market=? and season=? and result_home is not null",
                (m, s)).fetchall()
            if not rs:
                line += f"{'-':>26}"
                continue
            rets, clus, theo = [], [], []
            for g, ph, pa, rh, ra in rs:
                rets += [gp.bet_return(rh, ph), gp.bet_return(ra, pa)]
                clus += [g, g]
                theo.append(gp.theoretical_two_way_roi(ph, pa))
            roi = sum(rets) / len(rets)
            line += f"{pct(roi)+' (th '+pct(statistics.fmean(theo))+')':>26}"
        print(line)
    print()


def main():
    db = sqlite3.connect(f"file:{PANEL}?mode=ro", uri=True)
    print("=" * 78)
    print(f"AUDIT of {PANEL}")
    print("=" * 78)
    placebo(db)
    extreme(db)
    clv(db)
    per_season(db)


if __name__ == "__main__":
    main()
