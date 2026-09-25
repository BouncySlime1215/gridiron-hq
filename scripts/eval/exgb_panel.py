#!/usr/bin/env python3
"""E-XGB phase 1: a lagged-only player-week panel for QB/RB/WR/TE (exploratory).

Reads a COPY of the app database (read-only; the live file is refused) and writes one
.npz panel plus a JSON summary. Python 3 standard library + numpy only.

Target: actual full-PPR points from nflverse weekly finals (player_week_usage):
  0.04/pass yd, 4/pass TD, -2/INT, 0.1/rush+rec yd, 6/rush+rec TD, 1/reception,
  -2/fumble lost (two-point conversions are not in the table: a small known undercount).
A player-week is in the panel when his team plays that week and he either recorded a
stat line that week or recorded one in any of his previous 3 games this season; a
player with no line that week scores 0 (`played` = 0). That keeps availability misses in.

Every feature of week w is built from weeks < w of the same season or from earlier
seasons, except the two pre-game inputs that belong to week w by nature:
  - the team's OPENING spread/total (nfl_odds_archive phase 'open', book_updated_at
    before kickoff; falls back to game_lines' schedule line, flagged line_src = 1,
    whose as-of time is not recorded - M3's caveat);
  - the week's final injury-report designation (nfl_injuries; its modified_at can be
    later than kickoff when revised - the same caveat).
`leakage_check` proves the rest mechanically: it perturbs every outcome table at a
sample of weeks, rebuilds, and requires identical features and a changed target.

Usage:
  python3 scripts/eval/exgb_panel.py --db <copy.sqlite> --out <panel.npz> [--leakage-check 200]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import numpy as np

LIVE_DB = os.path.join(os.path.expanduser('~'), 'gridiron-local', 'data.sqlite')
POSITIONS = ('QB', 'RB', 'WR', 'TE')
INJ_CODE = {'questionable': 1, 'doubtful': 2, 'out': 3}
USAGE_COLS = ('targets', 'carries', 'receptions', 'target_share', 'air_yards_share', 'wopr',
              'receiving_air_yards', 'attempts')
LAGGED = ('ppr',) + USAGE_COLS + ('snap_pct', 'rz_share', 'xfp')
# Outcome inputs: everything recorded FROM a game. leakage_check perturbs exactly these.
OUTCOME_TABLES = ('usage', 'snaps', 'rz', 'xfp')


def ppr_points(u):
    g = lambda k: float(u.get(k) or 0.0)
    return (0.04 * g('passing_yards') + 4 * g('passing_tds') - 2 * g('interceptions')
            + 0.1 * (g('rushing_yards') + g('receiving_yards'))
            + 6 * (g('rushing_tds') + g('receiving_tds')) + g('receptions') - 2 * g('fumbles_lost'))


def _eastern_offset_hours(dt_date):
    """US Eastern UTC offset for a date (DST: 2nd Sunday of March to 1st Sunday of November)."""
    y = dt_date.year
    march = datetime(y, 3, 8)
    dst_start = march + timedelta(days=(6 - march.weekday()) % 7)
    nov = datetime(y, 11, 1)
    dst_end = nov + timedelta(days=(6 - nov.weekday()) % 7)
    return -4 if dst_start <= dt_date < dst_end else -5


def kickoff_utc(gameday, gametime):
    if not gameday:
        return None
    local = datetime.strptime(f"{gameday} {gametime or '23:59'}", '%Y-%m-%d %H:%M')
    return (local - timedelta(hours=_eastern_offset_hours(local))).replace(tzinfo=timezone.utc)


def open_db(path):
    if os.path.realpath(path) == os.path.realpath(LIVE_DB):
        raise SystemExit('refusing the live database; pass a copy')
    con = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    return con


def load_tables(con, first_season, last_season):
    lo = first_season - 1
    t = {}
    t['players'] = {r['id']: dict(r) for r in con.execute(
        'SELECT id, position, espn_id, gsis_id FROM players')}
    gsis_to_pid = {p['gsis_id']: pid for pid, p in t['players'].items() if p['gsis_id']}
    t['usage'] = {}
    for r in con.execute('SELECT * FROM player_week_usage WHERE season BETWEEN ? AND ?', (lo, last_season)):
        t['usage'][(r['player_id'], r['season'], r['week'])] = dict(r)
    t['snaps'] = {(r['player_id'], r['season'], r['week']): r['offense_pct'] for r in con.execute(
        'SELECT player_id, season, week, offense_pct FROM player_week_snaps WHERE season BETWEEN ? AND ?',
        (lo, last_season))}
    t['rz'] = {}
    for r in con.execute("""SELECT player_id, season, week, team,
            COALESCE(json_extract(features, '$.red_zone_targets'), 0) AS rzt,
            COALESCE(json_extract(features, '$.red_zone_carries'), 0) AS rzc
          FROM nfl_player_week_features WHERE season BETWEEN ? AND ?""", (lo, last_season)):
        pid = gsis_to_pid.get(r['player_id'])
        if pid is not None:
            t['rz'][(pid, r['season'], r['week'])] = (r['team'], float(r['rzt'] or 0) + float(r['rzc'] or 0))
    t['xfp'] = {}
    for r in con.execute("""SELECT player_gsis_id, season, week, expected_fantasy_points FROM nfl_ffopportunity_weekly
                            WHERE season BETWEEN ? AND ?""", (lo, last_season)):
        pid = gsis_to_pid.get(r['player_gsis_id'])
        if pid is not None and r['expected_fantasy_points'] is not None:
            t['xfp'][(pid, r['season'], r['week'])] = float(r['expected_fantasy_points'])
    t['games'] = {}
    for r in con.execute("""SELECT season, week, team, opponent, home, spread, total, gameday, gametime
                            FROM game_lines WHERE season BETWEEN ? AND ? AND week BETWEEN 1 AND 18""",
                         (lo, last_season)):
        t['games'][(r['season'], r['week'], r['team'])] = dict(r)
    t['open_lines'] = _open_lines(con, t['games'], lo, last_season)
    t['injuries'] = {}
    for r in con.execute('SELECT season, week, gsis_id, report_status, practice_status FROM nfl_injuries '
                         'WHERE season BETWEEN ? AND ?', (lo, last_season)):
        pid = gsis_to_pid.get(r['gsis_id'])
        if pid is not None:
            code = INJ_CODE.get(str(r['report_status'] or '').strip().lower(), 0)
            dnp = 1 if 'did not' in str(r['practice_status'] or '').lower() else 0
            t['injuries'][(pid, r['season'], r['week'])] = (code, dnp)
    return t


def _open_lines(con, games, lo, hi):
    """(season, week, home team) -> (home spread, total) as the median OPENING line across books."""
    by_game = defaultdict(lambda: {'spreads': [], 'totals': []})
    for r in con.execute("""SELECT season, home, commence_time, book_updated_at, market, side, line
                            FROM nfl_odds_archive WHERE phase = 'open' AND season BETWEEN ? AND ?
                              AND market IN ('spreads', 'totals') AND line IS NOT NULL""", (lo, hi)):
        if r['market'] == 'spreads' and r['side'] != 'home':
            continue
        if r['market'] == 'totals' and r['side'] != 'over':
            continue
        by_game[(r['season'], r['home'], r['commence_time'][:10])][r['market']].append(
            (float(r['line']), r['book_updated_at']))
    out = {}
    for (s, w, team), g in games.items():
        if not g['home']:
            continue
        k = kickoff_utc(g['gameday'], g['gametime'])
        if k is None:
            continue
        for delta in (0, -1, 1):
            day = (k + timedelta(days=delta)).strftime('%Y-%m-%d')
            hit = by_game.get((s, team, day))
            if hit:
                ko = k.strftime('%Y-%m-%dT%H:%M')
                sp = [v for v, at in hit['spreads'] if at and at[:16] < ko]
                to = [v for v, at in hit['totals'] if at and at[:16] < ko]
                if sp and to:
                    out[(s, w, team)] = (float(np.median(sp)), float(np.median(to)))
                break
    return out


def _team_line(t, s, w, team):
    g = t['games'].get((s, w, team))
    if not g:
        return (np.nan, np.nan, np.nan, np.nan)
    home_team = team if g['home'] else g['opponent']
    ol = t['open_lines'].get((s, w, home_team))
    if ol:
        spread = ol[0] if g['home'] else -ol[0]
        total, src = ol[1], 0.0
    elif g['spread'] is not None and g['total'] is not None:
        spread, total, src = float(g['spread']), float(g['total']), 1.0
    else:
        return (np.nan, np.nan, np.nan, np.nan)
    return (total / 2 - spread / 2, spread, total, src)


def _observations(t):
    """pid -> sorted list of per-game observation dicts (played games only)."""
    team_rz = defaultdict(float)
    for (pid, s, w), (team, v) in t['rz'].items():
        team_rz[(team, s, w)] += v
    obs = defaultdict(list)
    for (pid, s, w), u in t['usage'].items():
        rz = t['rz'].get((pid, s, w))
        tot = team_rz.get((rz[0], s, w), 0.0) if rz else 0.0
        o = {'season': s, 'week': w, 'team': u['team'], 'opponent': u['opponent'], 'position': u['position'],
             'ppr': ppr_points(u), 'snap_pct': t['snaps'].get((pid, s, w), np.nan),
             'rz_share': (rz[1] / tot) if rz and tot > 0 else (0.0 if rz else np.nan),
             'xfp': t['xfp'].get((pid, s, w), np.nan)}
        for c in USAGE_COLS:
            v = u.get(c)
            o[c] = float(v) if v is not None else np.nan
        obs[pid].append(o)
    for lst in obs.values():
        lst.sort(key=lambda o: (o['season'], o['week']))
    return obs


def _defense_allowed(obs):
    """(season, week, defense team, position) -> PPR points that position scored against it."""
    d = defaultdict(float)
    for lst in obs.values():
        for o in lst:
            if o['position'] in POSITIONS and o['opponent']:
                d[(o['season'], o['week'], o['opponent'], o['position'])] += o['ppr']
    return d


def feature_names():
    names = []
    for c in LAGGED:
        names += [f'lag1_{c}', f'trail3_{c}', f'trail5_{c}']
    names += ['std_ppr', 'n_games_std', 'prev_season_ppg', 'prev_season_games', 'missed_last_team_game',
              'team_implied', 'team_spread', 'game_total', 'line_src', 'home', 'inj_status', 'inj_dnp',
              'opp_allowed_pos_trail', 'opp_allowed_pos_prev_season', 'week']
    return names


def _mean(vals):
    v = [x for x in vals if x == x]  # drop NaN
    return float(np.mean(v)) if v else np.nan


def build_panel(t, seasons):
    obs = _observations(t)
    allowed = _defense_allowed(obs)
    team_weeks = defaultdict(list)
    for (s, w, team) in t['games']:
        team_weeks[(s, team)].append(w)
    for k in team_weeks:
        team_weeks[k].sort()
    # Only weeks whose finals are in: a future week has no target yet (2026 in season).
    final_weeks = {(s, w) for (_, s, w) in t['usage']}
    names = feature_names()
    X, y, played, meta = [], [], [], []
    for pid, lst in obs.items():
        by_season = defaultdict(list)
        for o in lst:
            by_season[o['season']].append(o)
        for s in seasons:
            cur = by_season.get(s, [])
            prev = by_season.get(s - 1, [])
            played_weeks = {o['week']: o for o in cur}
            candidate = set(played_weeks)
            for o in cur:  # the 3 team-game weeks after each played game
                later = [w for w in team_weeks.get((s, o['team']), []) if w > o['week']][:3]
                candidate.update(later)
            for w in sorted(candidate):
                if (s, w) not in final_weeks:
                    continue
                prior = [o for o in cur if o['week'] < w]
                this = played_weeks.get(w)
                team = this['team'] if this else (prior[-1]['team'] if prior else None)
                pos = (this or (prior[-1] if prior else None) or {}).get('position')
                if pos not in POSITIONS or team is None or (s, w, team) not in t['games']:
                    continue
                if this is None and not prior:
                    continue
                g = t['games'][(s, w, team)]
                row = []
                for c in LAGGED:
                    vals = [o[c] for o in prior]
                    row += [vals[-1] if vals else np.nan, _mean(vals[-3:]), _mean(vals[-5:])]
                tw = [x for x in team_weeks[(s, team)] if x < w]
                missed = 1.0 if tw and tw[-1] not in {o['week'] for o in prior} else 0.0
                implied, spread, total, src = _team_line(t, s, w, team)
                inj = t['injuries'].get((pid, s, w), (0, 0))
                opp = g['opponent']
                opp_hist = [allowed.get((s, x, opp, pos)) for x in team_weeks.get((s, opp), []) if x < w]
                opp_prev = [allowed.get((s - 1, x, opp, pos)) for x in team_weeks.get((s - 1, opp), [])]
                row += [_mean([o['ppr'] for o in prior]), float(len(prior)),
                        _mean([o['ppr'] for o in prev]), float(len(prev)), missed,
                        implied, spread, total, src, float(g['home'] or 0), float(inj[0]), float(inj[1]),
                        _mean([v for v in opp_hist if v is not None]),
                        _mean([v for v in opp_prev if v is not None]), float(w)]
                X.append(row)
                y.append(this['ppr'] if this else 0.0)
                played.append(1 if this else 0)
                k = kickoff_utc(g['gameday'], g['gametime'])
                meta.append((pid, t['players'].get(pid, {}).get('espn_id') or -1, s, w, POSITIONS.index(pos),
                             k.timestamp() if k else np.nan))
    X = np.asarray(X, dtype=np.float64).reshape(-1, len(names))
    meta = np.asarray(meta, dtype=np.float64).reshape(-1, 6)
    order = np.lexsort((meta[:, 0], meta[:, 3], meta[:, 2]))
    return {'X': X[order], 'y': np.asarray(y)[order], 'played': np.asarray(played)[order],
            'meta': meta[order], 'feature_names': np.asarray(names),
            'meta_names': np.asarray(['player_id', 'espn_id', 'season', 'week', 'pos', 'kickoff_ts'])}


def perturb_outcomes(t, at, seed=7):
    """A copy of t with every outcome recorded at or after (season, week) = `at` changed:
    the target game and everything later. A lagged-only feature of week `at` cannot move."""
    rng = random.Random(seed)
    hit = lambda k: (k[1], k[2]) >= at
    out = dict(t)
    num = ('passing_yards', 'rushing_yards', 'receiving_yards', 'receptions', 'targets', 'carries',
           'receiving_tds', 'rushing_tds', 'passing_tds') + USAGE_COLS
    out['usage'] = {}
    for k, u in t['usage'].items():
        if hit(k):
            u = dict(u)
            for c in num:
                if u.get(c) is not None:
                    u[c] = float(u[c]) * rng.uniform(0.3, 1.7) + rng.uniform(0.5, 3.0)
        out['usage'][k] = u
    out['snaps'] = {k: (v * rng.uniform(0.3, 1.7) if hit(k) and v is not None else v) for k, v in t['snaps'].items()}
    out['rz'] = {k: ((v[0], v[1] + rng.uniform(1, 4)) if hit(k) else v) for k, v in t['rz'].items()}
    out['xfp'] = {k: (v + rng.uniform(1, 9) if hit(k) else v) for k, v in t['xfp'].items()}
    return out


def leakage_check(t, seasons, panel, n=200, n_weeks=20, seed=11):
    """For n random rows (n_weeks distinct weeks): perturb every outcome from that week on,
    rebuild, and require identical features (and, for played rows, a changed target)."""
    rng = random.Random(seed)
    meta = panel['meta']
    weeks = sorted({(int(m[2]), int(m[3])) for m in meta})
    chosen = rng.sample(weeks, min(n_weeks, len(weeks)))
    per = max(1, n // len(chosen))
    idx_of = {(int(m[0]), int(m[2]), int(m[3])): i for i, m in enumerate(meta)}
    res = {'rows_checked': 0, 'weeks_perturbed': len(chosen), 'rows_with_changed_features': 0,
           'played_rows_checked': 0, 'played_rows_with_changed_target': 0}
    for (s, w) in chosen:
        rows_here = [i for i, m in enumerate(meta) if int(m[2]) == s and int(m[3]) == w]
        sample = rng.sample(rows_here, min(per, len(rows_here)))
        alt = build_panel(perturb_outcomes(t, (s, w)), [s])
        alt_idx = {(int(m[0]), int(m[2]), int(m[3])): j for j, m in enumerate(alt['meta'])}
        for i in sample:
            k = (int(meta[i, 0]), s, w)
            j = alt_idx.get(k)
            if j is None:
                raise AssertionError(f'row {k} vanished after perturbing outcomes from its own week on')
            a, b = panel['X'][idx_of[k]], alt['X'][j]
            res['rows_checked'] += 1
            if not np.array_equal(np.isnan(a), np.isnan(b)) or not np.allclose(np.nan_to_num(a), np.nan_to_num(b)):
                res['rows_with_changed_features'] += 1
            if panel['played'][i]:
                res['played_rows_checked'] += 1
                if abs(panel['y'][i] - alt['y'][j]) > 1e-9:
                    res['played_rows_with_changed_target'] += 1
    return res


def summarize(panel):
    names = list(panel['feature_names'])
    meta = panel['meta']
    by = defaultdict(lambda: [0, 0])
    for m, p in zip(meta, panel['played']):
        key = f"{POSITIONS[int(m[4])]} {int(m[2])}"
        by[key][0] += 1
        by[key][1] += int(p)
    avail = {n: round(float(np.mean(~np.isnan(panel['X'][:, i]))), 3) for i, n in enumerate(names)}
    return {'rows': int(len(panel['y'])), 'played_rows': int(panel['played'].sum()),
            'by_position_season': {k: {'rows': v[0], 'played': v[1]} for k, v in sorted(by.items())},
            'feature_availability': avail}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--first-season', type=int, default=2022)
    ap.add_argument('--last-season', type=int, default=2026)
    ap.add_argument('--leakage-check', type=int, default=0)
    a = ap.parse_args(argv)
    con = open_db(a.db)
    seasons = list(range(a.first_season, a.last_season + 1))
    t = load_tables(con, a.first_season, a.last_season)
    con.close()
    panel = build_panel(t, seasons)
    np.savez_compressed(a.out, **panel)
    summary = summarize(panel)
    if a.leakage_check:
        summary['leakage_check'] = lk = leakage_check(t, seasons, panel, n=a.leakage_check)
        if lk['rows_with_changed_features']:
            print(json.dumps(summary['leakage_check']))
            raise SystemExit('LEAKAGE: a feature moved when only same-week outcomes changed')
    with open(os.path.splitext(a.out)[0] + '.summary.json', 'w') as f:
        json.dump(summary, f, indent=1)
    print(json.dumps({k: v for k, v in summary.items() if k != 'feature_availability'}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
