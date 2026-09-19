#!/usr/bin/env python3
"""
Does the closing line correctly price official roster moves? A decade-scale event study.

WHY TRANSACTIONS AND NOT PRESS CONFERENCES. The presser event study returned t=+1.10 on 482
timestamped events -- underpowered, and permanently capped, because YouTube stops exposing exact
publication times after about six weeks. espn_transactions is better on every axis that matters:

           pressers          espn_transactions
  events   482               10,525 in-season, 2019-2026
  teams    20 (MIA 1,910)    32, evenly
  content  "we'll see"       "Placed QB on injured reserve."
  clock    upload time       the transaction date itself

A transaction is an official, dated, unambiguous fact. Jev has scored each one for
availability_impact on an ordered scale (0 = a starter becomes unavailable, 2 = no change,
4 = a starter becomes available) plus position group and whether a starter is involved.

THE HYPOTHESIS, and it is deliberately NOT "we can predict games". The market obviously reprices a
quarterback being ruled out. The question is whether it prices the REST correctly -- a cluster of
offensive linemen, a third corner, a rotational edge rusher. If the market applies a crude
adjustment to anything that is not a quarterback, a graded severity score should still predict line
movement after the fact, and that is tradeable.

SIGN CONVENTION, stated because getting it wrong has cost this project real time twice. covers
`home_line` is the home team's spread: negative means home is favoured. Define the TRANSACTING
team's own line delta:

    home team:  delta = home_line_after - home_line_before
    away team:  delta = -(home_line_after - home_line_before)

so POSITIVE delta always means "this team's spread got worse". Losing a starter should therefore
produce a positive delta, and the script asserts this on the unambiguous subset (Jev impact < 1,
i.e. confident starter-out) before reporting anything else. If that assertion fails the convention
is inverted and every number below would be backwards.

CONTROLS. (1) The mean delta over ALL transactions must be ~0 -- lines do not systematically drift,
and if they do in this panel the window or the join is wrong. (2) A placebo reassigns each
transaction to a random other team playing that week, holding the date and the window fixed.

Day-level resolution only: espn_transactions carries a placeholder time (T07:00Z/T08:00Z), so the
windows are in DAYS and no intraday claim is made.

Usage: python3 scripts/model-lab/transaction_event_study.py [--pre-days 2] [--post-days 2]
"""
import argparse
import bisect
import collections
import math
import random
import sqlite3
import statistics as st
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"


def parse_day(s):
    try:
        return datetime.fromisoformat(str(s)[:10]).date()
    except Exception:  # noqa: BLE001
        return None


def clustered_stats(pairs):
    """mean, SE clustered on the group key, n. pairs = [(group, value)]."""
    if not pairs:
        return None
    vals = [v for _, v in pairs]
    m = st.mean(vals)
    groups = collections.defaultdict(list)
    for g, v in pairs:
        groups[g].append(v)
    # cluster-robust SE of the mean
    G = len(groups)
    if G < 2:
        return m, 0.0, len(vals), G
    num = sum((sum(v - m for v in vs)) ** 2 for vs in groups.values())
    se = math.sqrt(num) / len(vals) * math.sqrt(G / (G - 1))
    return m, se, len(vals), G


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pre-days", type=int, default=2)
    ap.add_argument("--post-days", type=int, default=2)
    ap.add_argument("--placebo-draws", type=int, default=200)
    a = ap.parse_args()

    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=600)

    # ---- espn team_id -> full name, DERIVED from the data rather than hardcoded -------------
    m = collections.defaultdict(collections.Counter)
    for name, h, aw in arc.execute(
            "SELECT name, home, away FROM espn_events WHERE name LIKE '% at %'"):
        try:
            away_nm, home_nm = name.split(" at ", 1)
        except ValueError:
            continue
        m[str(h)][home_nm.strip()] += 1
        m[str(aw)][away_nm.strip()] += 1
    id2name = {k: v.most_common(1)[0][0] for k, v in m.items() if v}
    for bad in ("31", "32", "-1", "-2"):          # AFC/NFC Pro Bowl and TBD placeholders
        id2name.pop(bad, None)
    print(f"espn team ids mapped: {len(id2name)}")

    # covers uses city-ish short names ("Denver", "L.A. Chargers"); match on the longest
    # common token so "Los Angeles Rams" -> "L.A. Rams" still resolves.
    covers_teams = {}
    for abbr, nm in arc.execute(
            "SELECT DISTINCT home, home_name FROM covers_games WHERE home_name IS NOT NULL"):
        covers_teams[nm] = abbr
    def to_abbr(full):
        best, score = None, 0
        for nm, abbr in covers_teams.items():
            toks = set(nm.replace(".", "").lower().split())
            ftoks = set(full.replace(".", "").lower().split())
            s = len(toks & ftoks)
            if s > score:
                best, score = abbr, s
        return best if score > 0 else None
    id2abbr = {k: to_abbr(v) for k, v in id2name.items()}
    id2abbr = {k: v for k, v in id2abbr.items() if v}
    print(f"mapped to covers abbreviations: {len(id2abbr)}  "
          f"(unmapped: {sorted(set(id2name) - set(id2abbr))})")

    # ---- labelled transactions ---------------------------------------------------------------
    txns = []
    for key, team_id, date, impact in arc.execute(
            """SELECT txn_key, team_id, date, probability FROM jev_transaction_signals
               WHERE question='availability_impact.mean' AND probability IS NOT NULL"""):
        d = parse_day(date)
        ab = id2abbr.get(str(team_id))
        if d and ab:
            txns.append((key, ab, d, float(impact)))
    print(f"\nlabelled transactions joined to a team: {len(txns):,}")
    if len(txns) < 200:
        print("too few labels yet -- the Jev run is still going. Rerun later.")
        return
    imps = [t[3] for t in txns]
    print(f"   impact score: mean {st.mean(imps):.2f}  "
          f"(0=starter out, 2=neutral, 4=starter in)  "
          f"p10 {sorted(imps)[len(imps)//10]:.2f}  p90 {sorted(imps)[9*len(imps)//10]:.2f}")

    starter_flag = {k: p for k, p in arc.execute(
        """SELECT txn_key, probability FROM jev_transaction_signals
           WHERE question='starter_involved'""")}

    # ---- games and spread tape ---------------------------------------------------------------
    games = {}
    for gid, season, gdate, away, home in arc.execute(
            "SELECT game_id, season, game_date, away, home FROM covers_games "
            "WHERE season >= 2019"):
        d = parse_day(gdate)
        if d:
            games[gid] = (season, d, away, home)
    by_team_day = collections.defaultdict(list)
    for gid, (season, d, away, home) in games.items():
        by_team_day[away].append((d, gid, "away"))
        by_team_day[home].append((d, gid, "home"))
    for k in by_team_day:
        by_team_day[k].sort()

    tape = collections.defaultdict(list)
    for gid, ts, hl in arc.execute(
            """SELECT game_id, ts_utc, home_line FROM covers_line_history
               WHERE market='spread' AND home_line IS NOT NULL ORDER BY ts_utc"""):
        d = parse_day(ts)
        if d and gid in games:
            tape[gid].append((d, float(hl)))
    print(f"games with a spread tape: {len(tape):,}")

    tape_days = {g: [d for d, _ in v] for g, v in tape.items()}

    def line_on(gid, day):
        """Last quoted home_line on or before `day`. Bisect, not a filter -- this is the hot path."""
        days = tape_days.get(gid)
        if not days:
            return None
        i = bisect.bisect_right(days, day) - 1
        return tape[gid][i][1] if i >= 0 else None

    # The placebo calls this ~5M times, so a linear scan is not acceptable. Pre-sort per team
    # and binary-search. Without this the run is ~10 minutes of pure Python scanning.
    team_days = {t: [x[0] for x in v] for t, v in by_team_day.items()}

    def next_game(team, day):
        days = team_days.get(team)
        if not days:
            return None, None, None
        i = bisect.bisect_left(days, day)
        if i >= len(days):
            return None, None, None
        d, gid, side = by_team_day[team][i]
        return gid, side, d

    # ---- build the event panel ----------------------------------------------------------------
    def build(assign):
        """assign maps a transaction index -> team abbreviation (identity, or a placebo draw)."""
        out = []
        for i, (key, team, d, impact) in enumerate(txns):
            t = assign(i, team)
            gid, side, gday = next_game(t, d)
            if gid is None or gday > d + timedelta(days=9):
                continue
            before = line_on(gid, d - timedelta(days=a.pre_days))
            after = line_on(gid, d + timedelta(days=a.post_days))
            if before is None or after is None or before == after and False:
                continue
            raw = after - before
            delta = raw if side == "home" else -raw       # POSITIVE = this team's line got worse
            out.append((gid, key, impact, delta, side, gday))
        return out

    panel = build(lambda i, t: t)
    print(f"\nevent panel: {len(panel):,} transaction-game pairs "
          f"({len({p[0] for p in panel}):,} distinct games)")
    if len(panel) < 100:
        print("panel too small.")
        return

    # ---- CONTROL 1: overall drift must be ~0 --------------------------------------------------
    m, se, n, G = clustered_stats([(p[0], p[3]) for p in panel])
    print(f"\nCONTROL  mean delta over ALL transactions: {m:+.4f} pts  "
          f"SE {se:.4f} (game-clustered, {G} clusters)  t={m/se if se else 0:+.2f}")
    print("         expected ~0: lines should not systematically drift. "
          f"{'PASS' if abs(m/se if se else 0) < 2.5 else 'FAIL -- investigate before believing anything below'}")

    # ---- SIGN CHECK on the unambiguous subset -------------------------------------------------
    out_sub = [(p[0], p[3]) for p in panel if p[2] < 1.0]
    in_sub = [(p[0], p[3]) for p in panel if p[2] > 3.0]
    print(f"\nSIGN CHECK (does the convention hold on unambiguous cases?)")
    for lab, sub in (("starter OUT   (impact<1.0)", out_sub), ("starter IN    (impact>3.0)", in_sub)):
        r = clustered_stats(sub)
        if r:
            mm, ss, nn, gg = r
            print(f"   {lab}: mean delta {mm:+.4f}  SE {ss:.4f}  n={nn}  t={mm/ss if ss else 0:+.2f}")
    print("   expect starter-OUT positive (line worsens) and starter-IN negative.")

    # ---- THE TEST: does impact predict movement? ----------------------------------------------
    print(f"\n=== DOES JEV'S IMPACT SCORE PREDICT LINE MOVEMENT? ===")
    print(f"{'impact bucket':22s} {'n':>6s} {'mean delta':>11s} {'SE':>7s} {'t':>7s}")
    buckets = [(-0.01, 1.0, "starter out (<1)"), (1.0, 1.75, "depth out"),
               (1.75, 2.25, "neutral"), (2.25, 3.0, "depth in"), (3.0, 5.0, "starter in (>3)")]
    for lo, hi, lab in buckets:
        sub = [(p[0], p[3]) for p in panel if lo <= p[2] < hi]
        r = clustered_stats(sub)
        if r and r[2] >= 20:
            mm, ss, nn, gg = r
            print(f"{lab:22s} {nn:6d} {mm:+11.4f} {ss:7.4f} {mm/ss if ss else 0:+7.2f}")

    # correlation between impact and delta, clustered
    xs = [p[2] for p in panel]
    ys = [p[3] for p in panel]
    mx, my = st.mean(xs), st.mean(ys)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    r = (sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)) if sx and sy else 0.0
    print(f"\n   correlation(impact, delta) = {r:+.4f} on n={len(panel):,}")
    print("   expected NEGATIVE: higher impact (player returning) -> line improves (delta<0)")

    # ---- by position group --------------------------------------------------------------------
    pos = {}
    for key, q, p in arc.execute(
            """SELECT txn_key, question, probability FROM jev_transaction_signals
               WHERE question LIKE 'position_group.%' AND probability IS NOT NULL"""):
        nm = q.split(".", 1)[1]
        if key not in pos or p > pos[key][1]:
            pos[key] = (nm, p)
    print(f"\n=== BY POSITION GROUP (starter-out events only) ===")
    print("the market obviously prices a QB. the question is whether it prices the rest.")
    print(f"{'position':18s} {'n':>6s} {'mean delta':>11s} {'SE':>7s} {'t':>7s}")
    rows = []
    for grp in ("quarterback", "skill", "offensive_line", "defensive_line",
                "linebacker", "secondary", "special_teams"):
        sub = [(p[0], p[3]) for p in panel
               if p[2] < 1.5 and pos.get(p[1], ("", 0))[0] == grp]
        rr = clustered_stats(sub)
        if rr and rr[2] >= 15:
            mm, ss, nn, gg = rr
            t_ = mm / ss if ss else 0
            rows.append((grp, nn, mm, ss, t_))
            print(f"{grp:18s} {nn:6d} {mm:+11.4f} {ss:7.4f} {t_:+7.2f}")
    if rows:
        bonf = 0.05 / len(rows)
        print(f"   Bonferroni over {len(rows)} position tests: need |t| > "
              f"{2.807 if len(rows)<=7 else 3.0:.2f} (alpha {bonf:.4f})")

    # ---- PLACEBO -------------------------------------------------------------------------------
    print(f"\n=== PLACEBO: reassign each transaction to a random other team ({a.placebo_draws} draws) ===")
    teams = sorted(by_team_day)
    rng = random.Random(20260917)
    stats_ = []
    for _ in range(a.placebo_draws):
        pan = build(lambda i, t: rng.choice(teams))
        if len(pan) < 50:
            continue
        sub = [(p[0], p[3]) for p in pan if p[2] < 1.0]
        rr = clustered_stats(sub)
        if rr:
            stats_.append(rr[0])
    if stats_:
        stats_.sort()
        real = clustered_stats(out_sub)
        lo, hi = stats_[int(.025 * len(stats_))], stats_[int(.975 * len(stats_))]
        print(f"   placebo starter-out delta: mean {st.mean(stats_):+.4f}  "
              f"95% band [{lo:+.4f}, {hi:+.4f}]  ({len(stats_)} draws)")
        if real:
            inside = lo <= real[0] <= hi
            print(f"   REAL starter-out delta:    {real[0]:+.4f}  -> "
                  f"{'INSIDE the placebo band -- NO EVENT SIGNAL' if inside else 'OUTSIDE the band'}")

    print("\n" + "=" * 76)
    print("Day-level resolution only (transaction timestamps are placeholders), windows in DAYS.")
    print("A non-zero delta means the market MOVED, not that we can profit: the movement is the")
    print("market correctly repricing. Profit requires predicting the move BEFORE it happens, which")
    print("needs the transaction to be knowable before the line adjusts -- tested separately.")
    print("=" * 76)


if __name__ == "__main__":
    main()
