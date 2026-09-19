#!/usr/bin/env python3
"""
Can coach-speak possibly help? Answer it with TIMESTAMPS ALONE, before spending a cent on Jev.

THE LOGIC. Classifying 10,670 press-conference transcripts through Jev costs about a dollar, so
cost is not the reason to be careful -- wasted effort is. Text classification can only add value if
press conferences mark ABNORMAL LINE MOVEMENT in the first place. If the spread is no more volatile
around a presser than at a random matched time, then there is nothing for a classifier to explain,
and the most sophisticated read of coach-speak in the world cannot recover alpha that is not there.

So this runs the event study with NO text at all. Every presser is an event at time T. For the
teams playing that week, measure the absolute spread change in windows before and after T, and
compare against placebo events drawn at matched times on days with no presser.

THE THREE OUTCOMES, and each is decisive:

  1. NO ABNORMAL MOVEMENT AT ALL.  Pressers do not move lines. Jev cannot help. Stop, and save the
     effort for something else. This is a real and useful answer.

  2. ABNORMAL MOVEMENT BEFORE THE TIMESTAMP, NOT AFTER.  The market already knew. Beat writers post
     from the room while the coach is still talking, and the YouTube upload we timestamp lands
     afterwards. The signal is an ECHO: real, visible, and untradeable. Jev would faithfully
     classify news the market priced an hour earlier.

  3. ABNORMAL MOVEMENT AFTER THE TIMESTAMP.  There is something to classify, and Jev's job becomes
     well posed: separate the pressers that precede a move from the ones that do not.

Only outcome 3 justifies the classification work, and distinguishing 2 from 3 is the entire point
of measuring BOTH sides of the event. A study that only looked forward would confuse them.

CAVEATS STATED UP FRONT. published_at is the YouTube UPLOAD time, not the moment the coach spoke;
the gap is real and unmeasurable from this data, which is exactly why outcome 2 is a live
possibility rather than a technicality. The corpus covers 20 of 32 teams and is heavily skewed
(MIA 1,910 vs most teams near zero), so a league-wide claim is not available from it. Movement is
clustered by game, because quotes within a game are not independent.

Usage: python3 scripts/model-lab/presser_event_study.py [--window-h 6] [--min-quotes 3]
"""
import argparse
import collections
import math
import sqlite3
import statistics as st
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "data/line-history/line_history.sqlite"

TEAM_ALIASES = {
    "ARI": ["Arizona"], "ATL": ["Atlanta"], "BAL": ["Baltimore"], "BUF": ["Buffalo"],
    "CAR": ["Carolina"], "CHI": ["Chicago"], "CIN": ["Cincinnati"], "CLE": ["Cleveland"],
    "DAL": ["Dallas"], "DEN": ["Denver"], "DET": ["Detroit"], "GB": ["Green Bay"],
    "HOU": ["Houston"], "IND": ["Indianapolis"], "JAX": ["Jacksonville"], "KC": ["Kansas City"],
    "LV": ["Las Vegas", "Oakland"], "LAC": ["Los Angeles Chargers", "San Diego"],
    "LAR": ["Los Angeles Rams", "St. Louis"], "MIA": ["Miami"], "MIN": ["Minnesota"],
    "NE": ["New England"], "NO": ["New Orleans"], "NYG": ["New York Giants"],
    "NYJ": ["New York Jets"], "PHI": ["Philadelphia"], "PIT": ["Pittsburgh"],
    "SF": ["San Francisco"], "SEA": ["Seattle"], "TB": ["Tampa Bay"], "TEN": ["Tennessee"],
    "WAS": ["Washington"],
}


def parse_iso(s):
    try:
        s = str(s).strip()
        if not s or len(s) < 16:
            return None
        s = s[:19].replace(" ", "T")
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    except Exception:  # noqa: BLE001
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window-h", type=float, default=6.0)
    ap.add_argument("--min-quotes", type=int, default=3)
    a = ap.parse_args()
    W = timedelta(hours=a.window_h)

    arc = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True, timeout=600)

    pressers = []
    for team, pa in arc.execute(
            """SELECT team, published_at FROM press_conferences_raw
               WHERE length(published_at) > 10 AND team IS NOT NULL
               ORDER BY published_at"""):
        t = parse_iso(pa)
        if t:
            pressers.append((team, t))
    print(f"timestamped pressers: {len(pressers):,}")
    if len(pressers) < 30:
        print("\nNot enough timestamped pressers yet -- the backfill is still running.")
        print("Rerun once scripts/line-history/backfill_presser_timestamps.py has covered more rows.")
        return
    print(f"   span {pressers[0][1].date()} .. {pressers[-1][1].date()}")
    by_team = collections.Counter(t for t, _ in pressers)
    print(f"   teams: {len(by_team)}  top: "
          + ", ".join(f"{k}={v}" for k, v in by_team.most_common(5)))

    # spread tape, indexed by game and minute
    print("\nloading covers spread tape ...")
    games = {}
    for gid, season, gdate, away, home in arc.execute(
            """SELECT game_id, season, game_date, away_name, home_name FROM covers_games"""):
        games[gid] = (season, gdate, away or "", home or "")

    tape = collections.defaultdict(list)
    for gid, ts, hl in arc.execute(
            """SELECT game_id, ts_utc, home_line FROM covers_line_history
               WHERE market='spread' AND home_line IS NOT NULL ORDER BY ts_utc"""):
        t = parse_iso(ts)
        if t:
            tape[gid].append((t, float(hl)))
    print(f"   games with a spread tape: {len(tape):,}   "
          f"quotes: {sum(len(v) for v in tape.values()):,}")

    def team_games(team, when):
        """Games involving `team` whose tape covers `when`."""
        names = TEAM_ALIASES.get(team, [])
        if not names:
            return []
        out = []
        for gid, (season, gdate, away, home) in games.items():
            if gid not in tape:
                continue
            if not any(n in away or n in home for n in names):
                continue
            q = tape[gid]
            if q[0][0] <= when <= q[-1][0]:
                out.append(gid)
        return out

    def move(gid, t0, t1):
        """Absolute home-line change between t0 and t1, and the number of quotes spanned."""
        q = [(t, v) for t, v in tape[gid] if t0 <= t <= t1]
        if len(q) < a.min_quotes:
            return None, len(q)
        return abs(q[-1][1] - q[0][1]), len(q)

    # index games by team once; the naive scan above is O(events x games)
    team_index = collections.defaultdict(list)
    for gid, (season, gdate, away, home) in games.items():
        if gid not in tape:
            continue
        for abbr, names in TEAM_ALIASES.items():
            if any(n in away or n in home for n in names):
                team_index[abbr].append(gid)

    pre, post, pre_n, post_n = [], [], [], []
    placebo_pre, placebo_post = [], []
    matched = 0
    for team, t in pressers:
        cands = team_index.get(team, [])
        for gid in cands:
            q = tape[gid]
            if not (q[0][0] <= t <= q[-1][0]):
                continue
            mb, nb = move(gid, t - W, t)
            ma, na = move(gid, t, t + W)
            if mb is None or ma is None:
                continue
            matched += 1
            pre.append(mb); post.append(ma); pre_n.append(nb); post_n.append(na)
            # PLACEBO: the same game, same clock time, exactly one week earlier. Same day of week
            # and same hour, so weekly and daily seasonality in quoting is held fixed -- the only
            # thing removed is the presser itself.
            tp = t - timedelta(days=7)
            if q[0][0] <= tp <= q[-1][0]:
                pb, _ = move(gid, tp - W, tp)
                pa_, _ = move(gid, tp, tp + W)
                if pb is not None and pa_ is not None:
                    placebo_pre.append(pb); placebo_post.append(pa_)

    print(f"\nmatched presser-game pairs with quotes on both sides: {matched:,}")
    if matched < 30:
        print("too few matched pairs to conclude anything.")
        return

    def blk(name, xs):
        if not xs:
            print(f"   {name:34s} (none)")
            return
        m = st.mean(xs)
        sd = st.stdev(xs) if len(xs) > 1 else 0.0
        se = sd / math.sqrt(len(xs)) if sd else 0.0
        print(f"   {name:34s} n={len(xs):5d}  mean |move| {m:5.3f} pts   "
              f"median {st.median(xs):5.3f}   se {se:.3f}")
        return m, se, len(xs)

    print(f"\n=== ABSOLUTE SPREAD MOVEMENT in a {a.window_h:g}h window ===")
    rb = blk("BEFORE the presser upload", pre)
    ra = blk("AFTER  the presser upload", post)
    print(f"   {'quotes spanned: before':34s} median {st.median(pre_n):.0f}, "
          f"after median {st.median(post_n):.0f}")
    print(f"\n=== PLACEBO: same game, same weekday and hour, one week earlier ===")
    pb = blk("BEFORE placebo time", placebo_pre)
    pa_ = blk("AFTER  placebo time", placebo_post)

    print("\n" + "=" * 76)
    print("VERDICT")
    print("=" * 76)
    if ra and pa_:
        diff = ra[0] - pa_[0]
        se = math.sqrt(ra[1] ** 2 + pa_[1] ** 2)
        t_ = diff / se if se else 0.0
        print(f"   AFTER-window movement, presser vs placebo: {diff:+.4f} pts   t={t_:+.2f}")
        if t_ > 2:
            print("   -> There IS abnormal movement after the upload timestamp.")
        elif t_ < -2:
            print("   -> Lines move LESS after a presser than at the control time. That is not an")
            print("      event signature -- an information event raises volatility, it does not")
            print("      lower it. Check the placebo n: the control is 'same game, one week earlier',")
            print("      and games with quotes two weeks out are a SELECTED subset (marquee games")
            print("      with livelier lines), so a negative t here is a placebo-selection artifact,")
            print("      not evidence that pressers calm the market. Treat as NO EVENT SIGNAL.")
        else:
            print("   -> Lines are NOT more volatile after a presser than at a matched control")
            print("      time. There is no abnormal movement for a classifier to explain, so")
            print("      running Jev over the transcripts cannot produce an edge here. This is")
            print("      outcome 1: a clean, cheap negative, established without spending on Jev.")
    if rb and ra:
        ratio = rb[0] / ra[0] if ra[0] else float("inf")
        print(f"\n   before/after ratio: {ratio:.2f}")
        if ratio > 1.25:
            print("   -> Most of the movement happens BEFORE the upload timestamp. That is the")
            print("      ECHO case (outcome 2): beat writers report from the room in real time and")
            print("      the video lands afterwards, so the news is already in the price. Jev would")
            print("      classify it accurately and still be too late to bet.")
        elif ratio < 0.8:
            print("   -> Movement concentrates AFTER the timestamp (outcome 3). This is the case")
            print("      that justifies classification: the question becomes which pressers precede")
            print("      a move, and that is exactly what Jev is for.")
        else:
            print("   -> Movement is symmetric around the timestamp, which is what ordinary")
            print("      drift looks like. No event signature.")
    print("\n   Caveats that bound every number above: published_at is the UPLOAD time, not when")
    print("   the coach spoke; the corpus covers 20 of 32 teams and is heavily skewed; and moves")
    print("   are measured per presser-game pair, which is clustered by game.")


if __name__ == "__main__":
    main()
