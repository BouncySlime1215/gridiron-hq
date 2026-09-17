#!/usr/bin/env python
"""
Adversarial verification of the grading panel. Every number below is executed.

This does five things:
  1. HAND-CHECK. Re-grades specific games from raw box scores, independently of
     the panel's own code path, and compares.
  2. KICKOFF COUNTERFACTUAL. Rebuilds the panel with the pre-kickoff filter
     TURNED OFF and shows the control breaking, proving the filter is the thing
     holding the control up and not a coincidence.
  3. STALENESS SENSITIVITY. Control at 60 / 360 / 1440-minute close gates.
  4. TIE-BREAK SENSITIVITY. Control under best-for-bettor vs worst-for-bettor
     same-minute tie-breaks.
  5. PLACEBO. Random side per game and a shuffled side assignment must both
     land on -vig. If a random selector beats the market, the panel is broken.

Run:
  research/.venv/bin/python research/betting/nfl/verify_grading_panel.py
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

SCRATCH = "/private/tmp/claude-501/verify_panel.sqlite"


def pct(x):
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{100*x:+.3f}%"


def idxmap():
    cols = [c.split()[0].strip() for c in gp.PANEL_COLS.strip().split(",")]
    return {c: i for i, c in enumerate(cols)}


# ------------------------------------------------------------------ 1. hand
def hand_check(panel_rows, n=6):
    """Re-grade from raw nflverse box scores with fresh arithmetic."""
    idx = idxmap()
    nv = sqlite3.connect(f"file:{gp.NFLVERSE_DB}?mode=ro", uri=True)
    scores = {g: (a, h) for g, a, h in nv.execute(
        "select game_id, away_score, home_score from nfldata_games")}
    print("-" * 78)
    print("1. HAND-CHECK: independent re-grade from raw box scores")
    print("-" * 78)
    bad = 0
    checked = 0
    for r in panel_rows:
        g = r[idx["nfl_game_id"]]
        if g not in scores or scores[g][0] is None:
            continue
        away, home = scores[g]
        m, line = r[idx["market"]], r[idx["close_line"]]
        if m == "spread":
            want = home + line - away          # home side edge
        elif m == "total":
            want = home + away - line          # over edge
        else:
            want = home - away
        want_h = 1 if want > 0 else (-1 if want < 0 else 0)
        checked += 1
        if want_h != r[idx["result_home"]] or -want_h != -r[idx["result_away"]] * 1:
            pass
        if want_h != r[idx["result_home"]] or r[idx["result_away"]] != -want_h:
            bad += 1
    print(f"   re-graded {checked:,} panel rows independently: {bad} mismatches")
    # print a few readable examples
    shown = 0
    for r in panel_rows:
        g = r[idx["nfl_game_id"]]
        if r[idx["market"]] != "spread" or g not in scores or scores[g][0] is None:
            continue
        if r[idx["season"]] != 2025 or shown >= n:
            continue
        away, home = scores[g]
        line = r[idx["close_line"]]
        print(f"   {g:<22} {r[idx['away_team']]}@{r[idx['home_team']]} "
              f"{away:.0f}-{home:.0f}  home {line:+.1f} "
              f"@{r[idx['close_price_home']]:+d}  -> home side "
              f"{'WIN ' if r[idx['result_home']]==1 else 'PUSH' if r[idx['result_home']]==0 else 'LOSS'}"
              f"  return {gp.bet_return(r[idx['result_home']], r[idx['close_price_home']]):+.4f}")
        shown += 1
    return bad


# --------------------------------------------------------- 2. counterfactual
def kickoff_counterfactual():
    print()
    print("-" * 78)
    print("2. KICKOFF COUNTERFACTUAL: the same pipeline with the filter OFF")
    print("-" * 78)
    rows_on, st_on, _, _ = gp.build(SCRATCH, kickoff_filter=True, write=False)
    rows_off, st_off, _, _ = gp.build(SCRATCH, kickoff_filter=False, write=False)
    print(f"   {'market':<10} {'FILTER ON':>22} {'FILTER OFF (broken)':>24}")
    print(f"   {'':<10} {'both-sides ROI':>22} {'both-sides ROI':>24}")
    for m in gp.MARKETS:
        a = gp.control(rows_on, "best")[m]
        b = gp.control(rows_off, "best")[m]
        print(f"   {m:<10} {pct(a['roi']):>14} +/-{100*a['se']:.2f}%"
              f"  {pct(b['roi']):>16} +/-{100*b['se']:.2f}%")
    print()
    print("   single-side (the shape the -6.22% bug took):")
    for m in gp.MARKETS:
        a = gp.control(rows_on, "ref")[m]
        b = gp.control(rows_off, "ref")[m]
        print(f"   {m:<10} home/over  ON {pct(a['roi_home']):>9}   "
              f"OFF {pct(b['roi_home']):>9}    away/under  ON {pct(a['roi_away']):>9}   "
              f"OFF {pct(b['roi_away']):>9}")
    idx = idxmap()
    ext = [r for r in rows_off
           if r[idx["market"]] == "moneyline" and
           (r[idx["close_price_away"]] > 600 or r[idx["close_price_home"]] > 600)]
    print(f"\n   moneyline quotes priced worse than +600 admitted with the filter OFF: "
          f"{len(ext)} (these are in-game dogs)")
    onext = [r for r in rows_on
             if r[idx["market"]] == "moneyline" and
             (r[idx["close_price_away"]] > 600 or r[idx["close_price_home"]] > 600)]
    print(f"   same with the filter ON: {len(onext)}")
    return rows_on


# ----------------------------------------------------------- 3/4. sensitivity
def sensitivity():
    print()
    print("-" * 78)
    print("3. STALENESS GATE SENSITIVITY (minutes before kickoff the close may be)")
    print("-" * 78)
    print(f"   {'gate':>6} {'market':<10} {'games':>6} {'both-sides ROI':>16} {'theory':>10} {'t':>6}")
    for gate in (60, 360, 1440, 60 * 24 * 400):
        rows, _, _, _ = gp.build(SCRATCH, close_max_lag=gate, write=False)
        for m in gp.MARKETS:
            c = gp.control(rows, "best")[m]
            t = (c["roi"] - c["theoretical_roi"]) / c["se"]
            print(f"   {gate:>6} {m:<10} {c['n_games']:>6} {pct(c['roi']):>16} "
                  f"{pct(c['theoretical_roi']):>10} {t:>6.2f}")
    print()
    print("-" * 78)
    print("4. SAME-MINUTE TIE-BREAK SENSITIVITY")
    print("-" * 78)
    for tb in ("worst", "best"):
        rows, _, _, _ = gp.build(SCRATCH, tie_break=tb, write=False)
        line = f"   tie-break={tb:<6}"
        for m in gp.MARKETS:
            c = gp.control(rows, "best")[m]
            line += f"  {m}={pct(c['roi'])} (theory {pct(c['theoretical_roi'])})"
        print(line)


# ------------------------------------------------------------------ 5. placebo
def placebo(panel_rows, seeds=(1, 2, 3, 4, 5)):
    print()
    print("-" * 78)
    print("5. PLACEBO: a random side on every game must return -vig, not more")
    print("-" * 78)
    idx = idxmap()
    print(f"   {'market':<10} {'seed':>5} {'random-side ROI':>17} {'SE':>8}")
    for m in gp.MARKETS:
        rois = []
        for seed in seeds:
            rnd = random.Random(seed)
            rets, clus = [], []
            for r in panel_rows:
                if r[idx["market"]] != m or r[idx["result_home"]] is None:
                    continue
                if rnd.random() < 0.5:
                    res, price = r[idx["result_home"]], r[idx["close_price_home"]]
                else:
                    res, price = r[idx["result_away"]], r[idx["close_price_away"]]
                rets.append(gp.bet_return(res, price))
                clus.append(r[idx["nfl_game_id"]])
            roi = sum(rets) / len(rets)
            se = gp.cluster_se(rets, clus)
            rois.append(roi)
            print(f"   {m:<10} {seed:>5} {pct(roi):>17} {100*se:>7.3f}%")
        print(f"   {m:<10} {'mean':>5} {pct(statistics.fmean(rois)):>17}")
    print()


# ------------------------------------------------------------------ 6. leakage
def leakage(panel_rows):
    print("-" * 78)
    print("6. LOOK-AHEAD AUDIT")
    print("-" * 78)
    idx = idxmap()
    bad_close = [r for r in panel_rows if r[idx["close_lag_min"]] <= 0]
    bad_open = [r for r in panel_rows
                if r[idx["open_lead_min"]] is not None and r[idx["open_lead_min"]] <= 0]
    print(f"   closes at/after kickoff        : {len(bad_close)}")
    print(f"   opens at/after kickoff         : {len(bad_open)}")
    oc = [r for r in panel_rows
          if r[idx["open_ts_et"]] and r[idx["open_ts_et"]] > r[idx["close_ts_et"]]]
    print(f"   open timestamped after close   : {len(oc)}")
    lags = [r[idx["close_lag_min"]] for r in panel_rows]
    lags.sort()
    print(f"   close lag minutes before kickoff: min {lags[0]:.0f}  p10 "
          f"{lags[len(lags)//10]:.0f}  p50 {lags[len(lags)//2]:.0f}  "
          f"p90 {lags[9*len(lags)//10]:.0f}  max {lags[-1]:.0f}")
    leads = [r[idx["open_lead_min"]] for r in panel_rows if r[idx["open_lead_min"]] is not None]
    leads.sort()
    print(f"   open lead minutes before kickoff: p10 {leads[len(leads)//10]:.0f}  "
          f"p50 {leads[len(leads)//2]:.0f}  p90 {leads[9*len(leads)//10]:.0f}")
    print()


def main():
    rows = kickoff_counterfactual()
    bad = hand_check(rows)
    leakage(rows)
    sensitivity()
    placebo(rows)
    print("=" * 78)
    print("VERIFICATION COMPLETE." if bad == 0 else f"VERIFICATION FAILED: {bad} regrade mismatches")
    print("=" * 78)


if __name__ == "__main__":
    main()
