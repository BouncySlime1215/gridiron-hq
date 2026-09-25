"""ML-TESTBENCH sections C and D: the 2026 lineup-weeks, their starters and as-of projections.

Sources (all read from a DB COPY):
  league_roster_snapshots   starters (is_starter = 1), actual_points, projected_points (ESPN RETRO:
                            weeks 1-2 were backfilled on 2026-09-22, after the games)
  espn_player_market_weekly ESPN week-2 projection captured 2026-09-17 22:08Z, before kickoff (FROZEN)
  weekly_prediction_snapshots  our week-2 per-player prediction, lower_80, upper_80 (as of 2026-09-17)
  league_week_scores        official team scores and opponents
Constants of the served formula are read from server/services/lineup-posture.js itself.
"""
from __future__ import annotations

import os
import re
from collections import defaultdict

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
WEEK2_FIRST_KICKOFF = '2026-09-18T00:15:00Z'


def posture_constants():
    src = open(os.path.join(REPO, 'server', 'services', 'lineup-posture.js')).read()
    cv = re.search(r'export const POSITION_CV = \{([^}]*)\}', src).group(1)
    cvs = {k: float(v) for k, v in re.findall(r'(\w+):\s*([0-9.]+)', cv)}
    scale = float(re.search(r'export const SPREAD_SCALE = ([0-9.]+)', src).group(1))
    default = float(re.search(r'POSITION_CV\[p\.position\] \?\? ([0-9.]+)', src).group(1))
    return cvs, scale, default


def load(con, weeks=(1, 2, 3)):
    frozen = {int(e): float(p) for e, p in con.execute(
        """SELECT espn_id, week_proj FROM espn_player_market_weekly WHERE season = 2026 AND week = 2
           AND is_live_capture = 1 AND week_proj IS NOT NULL AND captured_at < ?""", (WEEK2_FIRST_KICKOFF,))}
    ours = {}
    rank = {'position_ensemble': 0}
    for pid, mode, pred, lo, hi in con.execute(
            """SELECT player_id, mode, prediction, lower_80, upper_80 FROM weekly_prediction_snapshots
               WHERE season = 2026 AND week = 2 AND as_of < ?""", (WEEK2_FIRST_KICKOFF,)):
        k = int(pid)
        if k not in ours or rank.get(mode, 1) < rank.get(ours[k][0], 1):
            ours[k] = (mode, float(pred), float(lo), float(hi))
    teams = defaultdict(list)
    q = f"""SELECT league_id, scoring_period_id, team_id, player_id, espn_player_id, position, projected_points, actual_points
            FROM league_roster_snapshots WHERE season = 2026 AND is_starter = 1
            AND scoring_period_id IN ({','.join('?' * len(weeks))})"""
    for lg, wk, team, pid, eid, pos, proj, act in con.execute(q, weeks):
        o = ours.get(int(pid)) if pid is not None else None
        teams[(str(lg), int(wk), str(team))].append({
            'position': pos, 'retro': proj, 'actual': act,
            'frozen': frozen.get(int(eid)) if int(wk) == 2 and eid is not None else None,
            'ours': o[1:] if (o and int(wk) == 2) else None})
    scores = {}
    for lg, wk, rid, pts, opp in con.execute(
            """SELECT league_id, week, roster_id, points, opponent_roster_id FROM league_week_scores
               WHERE season = 2026 AND COALESCE(is_playoff, 0) = 0"""):
        scores[(str(lg), int(wk), str(rid))] = (pts, None if opp is None else str(opp))
    return teams, scores


def complete(starters):
    return bool(starters) and all(s['actual'] is not None for s in starters)
