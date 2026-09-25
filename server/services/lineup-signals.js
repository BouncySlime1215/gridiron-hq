/**
 * LS-01: what each manager's lineups say about him, week by week.
 *
 * THE ONE PRODUCER of lineup signals. Read by GET /api/trades/:leagueId/brain/managers
 * (server/routes/trades.js), computed on read: no table of its own.
 *
 * Source: `league_roster_snapshots` (migration 058), written by `writePeriod` in
 * scripts/collect-roster-snapshots.mjs:109 on every refresh tick: every team's
 * lineup slot per ESPN scoring period, `final` from the boxscore once a period is
 * over, `live` while it is current. Joined to:
 *   - snap share `player_week_snaps.offense_pct` (writer `syncSnapCounts`,
 *     server/services/nflverse.js:287). Route share is not stored anywhere in the
 *     app, so "usage" here is snap share only.
 *   - byes from `schedule_games` (writer `syncSchedules`, server/routes/nfldata.js:117),
 *     keyed by nfl_teams id, reached through players.team_id (the snapshot's
 *     pro_team_id is ESPN's numbering and does not match nfl_teams).
 *   - last week's points for a free agent from `player_week_usage` through the
 *     existing `pprPoints` (server/services/offseason-data.js:544), not a new formula.
 *   - the trade block, `teams[].tradeBlock.players` in the stored ESPN payload.
 *
 * Signals (LINEUP_SIGNAL_TYPES is the contract):
 *   benched_intact_usage       a player he had been starting, benched while his snaps held
 *   benched_and_shopped        on his bench and ON_THE_BLOCK
 *   started_bad_matchup        started on a projection well below his own earlier ones
 *                              while a benched player at the position was projected higher
 *   dead_starter_left_in       started, his NFL team played, he did not (no snaps, no stat line, no points)
 *   bye_unfilled               started while his NFL team was on bye
 *   injured_not_on_ir          INJURY_RESERVE status sitting in a bench slot
 *   added_last_week_top_scorer picked up off the wire right after a top-5 week at his position
 *   flex_choice                who he put in FLEX/OP over which benched options (revealed ranking)
 *
 * THE LINEUP FACTS ARE MEASURED; THE READING OF THEM IS A GUESS. "Benched with intact
 * usage means he undervalues the player" was pre-registered
 * (docs/evidence/2026-09-23/ls-01-bwiu-trade-prereg.md) and FAILED on 2021-2024: the
 * benched players scored less than what their manager next accepted in a trade
 * (docs/tdd/2026-09-23-ls-01-lineup-signals.tdd.md section 5). Every response says
 * `inference: 'guess'` and why, in plain words.
 *
 * `manager-signals.js` `rosterSignals` has a different number with a similar name,
 * `lineup_dead_starters`: starters whose CURRENT status is OUT/IR/DOUBTFUL in the
 * live payload. This file's `dead_starter_left_in` is a completed week in which a
 * started player did not play. Different questions; both are served under their
 * own names.
 */
import { row, rows } from '../db/index.js';
import { pprPoints } from './offseason-data.js';
import { tradeBlocks } from './espn-trade-block.js';

export const LINEUP_SIGNAL_TYPES = Object.freeze({
  benched_intact_usage: 'benched a player he had been starting while that player\'s snap share held',
  benched_and_shopped: 'player on his bench and on his trade block',
  started_bad_matchup: 'started a player on a projection well below his own earlier ones over a better-projected bench option',
  dead_starter_left_in: 'started a player whose NFL team played and who did not',
  bye_unfilled: 'started a player whose NFL team was on bye',
  injured_not_on_ir: 'an INJURY_RESERVE player sitting in a bench slot instead of IR',
  added_last_week_top_scorer: 'added a free agent right after a top week at his position',
  flex_choice: 'who he started in FLEX/OP over which benched options',
});

/** Benched-with-intact-usage rule; the pre-registration uses these same numbers. */
export const BWIU_RULE = Object.freeze({
  lookback: 3,          // look at the last 3 weeks the player was on this roster
  minWeeksOnRoster: 2,  // of which at least 2 must exist
  minStarts: 2,         // and he started at least 2
  usageRatio: 0.9,      // snap share this week >= 0.9 x his mean in those starts
  minMeanShare: 0.4,    // and that mean is a real role
});
export const BAD_MATCHUP_RATIO = 0.8;   // projection <= 0.8 x his own earlier mean
export const TOP_SCORER_RANK = 5;       // top 5 at his position the week before the add

export const INFERENCE_REASON = 'The lineup facts are measured from stored weekly lineups. What they mean for a ' +
  'trade (buy low, distressed seller, attached, checked out) is a guess. The one reading that was tested failed ' +
  'its pre-registered test: across 2021-2024 Sleeper leagues, players benched while their snaps held scored ' +
  'less over the next four weeks than what the same manager accepted in his next trade, not more ' +
  '(docs/evidence/2026-09-23/ls-01-bwiu-trade-prereg.md). Do not read a benching as a buy-low.';

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const BENCH_SLOT = 20;   // IR is slot 21: a player there is not on the bench
const FLEX_SLOTS = { 23: new Set(['RB', 'WR', 'TE']), 7: SKILL };   // FLEX, OP (superflex)
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const isBench = r => r.lineup_slot_id === BENCH_SLOT;
const isStarter = r => r.is_starter === 1;

const NO_SNAPSHOTS_REASON = 'no rows in league_roster_snapshots for this league and season — ' +
  'scripts/collect-roster-snapshots.mjs has not captured it';

function snapIndex(season, playerIds) {
  const idx = new Map();
  const weeksWithSnaps = new Set(rows('SELECT DISTINCT week FROM player_week_snaps WHERE season = ?', season)
    .map(r => r.week));
  const ids = [...playerIds];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of rows(`SELECT player_id, week, offense_pct FROM player_week_snaps
        WHERE season = ? AND player_id IN (${chunk.map(() => '?').join(', ')})`, season, ...chunk)) {
      idx.set(`${r.player_id}|${r.week}`, r.offense_pct);
    }
  }
  return { share: (pid, w) => idx.get(`${pid}|${w}`) ?? null, weeksWithSnaps };
}

/** Rank of each player among his position by PPR in one week (1 = best). */
function weeklyRanks(season, week) {
  const byPos = new Map();
  for (const u of rows('SELECT * FROM player_week_usage WHERE season = ? AND week = ?', season, week)) {
    const list = byPos.get(u.position) ?? [];
    list.push({ player_id: u.player_id, points: pprPoints(u) });
    byPos.set(u.position, list);
  }
  const rank = new Map();
  for (const list of byPos.values()) {
    list.sort((a, b) => b.points - a.points);
    list.forEach((p, i) => rank.set(p.player_id, { rank: i + 1, points: r2(p.points) }));
  }
  return rank;
}

export function lineupSignals(leagueId, { season = null } = {}) {
  const lg = row('SELECT id, season, payload FROM leagues WHERE id = ?', leagueId);
  if (!lg) return { league_id: Number(leagueId), available: false, reason: 'league not found', signals: [], by_manager: {} };
  const yr = Number(season ?? lg.season);
  const base = {
    league_id: lg.id, season: yr, inference: 'guess', inference_reason: INFERENCE_REASON,
    types: LINEUP_SIGNAL_TYPES, rules: { bwiu: BWIU_RULE, bad_matchup_ratio: BAD_MATCHUP_RATIO, top_scorer_rank: TOP_SCORER_RANK },
  };
  // The NFL team comes from players.team_id (an nfl_teams id, the key schedule_games
  // uses), not the snapshot's pro_team_id: ESPN numbers teams its own way (33 = BAL).
  const snap = rows(`SELECT s.scoring_period_id AS week, s.team_id, s.espn_player_id, s.player_id, s.player_name,
      s.position, p.team_id AS nfl_team_id, s.lineup_slot_id, s.is_starter, s.injury_status,
      s.pregame_injury_status, s.projected_points, s.actual_points, s.source
    FROM league_roster_snapshots s LEFT JOIN players p ON p.id = s.player_id
    WHERE s.league_id = ? AND s.season = ? AND s.on_roster = 1
    ORDER BY s.scoring_period_id, s.team_id, s.espn_player_id`, lg.id, yr);
  if (!snap.length) return { ...base, available: false, reason: NO_SNAPSHOTS_REASON, periods: [], signals: [], by_manager: {}, unavailable: {} };

  const weeks = new Map();                 // week -> { source, rows }
  const hist = new Map();                  // team|espn -> Map(week -> row)
  const projHist = new Map();              // espn -> Map(week -> projection), league-wide
  for (const r of snap) {
    const wk = weeks.get(r.week) ?? { source: r.source, rows: [] };
    wk.rows.push(r); weeks.set(r.week, wk);
    const k = `${r.team_id}|${r.espn_player_id}`;
    (hist.get(k) ?? hist.set(k, new Map()).get(k)).set(r.week, r);
    if (r.projected_points != null) {
      (projHist.get(r.espn_player_id) ?? projHist.set(r.espn_player_id, new Map()).get(r.espn_player_id))
        .set(r.week, r.projected_points);
    }
  }
  const weekList = [...weeks.keys()].sort((a, b) => a - b);
  const finals = weekList.filter(w => weeks.get(w).source === 'final');
  const latest = weekList[weekList.length - 1];
  const snaps = snapIndex(yr, new Set(snap.map(r => r.player_id).filter(x => x != null)));
  const sched = new Set(rows('SELECT team_id, week FROM schedule_games WHERE season = ?', yr).map(r => `${r.team_id}|${r.week}`));
  const { blocks, error: blockError } = tradeBlocks(lg.payload);
  // Who has a stat line in a week: the snap feed misses some players who played (on the
  // local copy, 11 of 13 "no snap row" starters had points), so no snaps alone is not
  // proof he sat.
  const statLine = new Set(rows('SELECT player_id, week FROM player_week_usage WHERE season = ?', yr)
    .map(r => `${r.player_id}|${r.week}`));

  const signals = [];
  const emit = (signal, r, evidence) => signals.push({
    roster_id: String(r.team_id), signal, week: r.week, player_id: r.player_id, espn_player_id: r.espn_player_id,
    player_name: r.player_name, position: r.position, evidence,
  });

  for (const w of finals) {
    const wkRows = weeks.get(w).rows;
    const snapsKnown = snaps.weeksWithSnaps.has(w);
    const byTeam = new Map();
    for (const r of wkRows) (byTeam.get(r.team_id) ?? byTeam.set(r.team_id, []).get(r.team_id)).push(r);

    for (const r of wkRows) {
      const skill = SKILL.has(r.position) && r.player_id != null;

      // benched with intact usage
      if (isBench(r) && skill && snapsKnown) {
        const before = [...hist.get(`${r.team_id}|${r.espn_player_id}`).entries()]
          .filter(([wk]) => wk < w).sort((a, b) => b[0] - a[0]).slice(0, BWIU_RULE.lookback).map(([, x]) => x);
        const started = before.filter(isStarter);
        const shares = started.map(x => snaps.share(r.player_id, x.week)).filter(x => x != null);
        const priorMean = mean(shares);
        const now = snaps.share(r.player_id, w);
        if (before.length >= BWIU_RULE.minWeeksOnRoster && started.length >= BWIU_RULE.minStarts
            && priorMean != null && priorMean >= BWIU_RULE.minMeanShare
            && now != null && now > 0 && now >= BWIU_RULE.usageRatio * priorMean) {
          emit('benched_intact_usage', r, { starts_before: started.length, weeks_looked: before.length,
            prior_mean_snap_share: r2(priorMean), snap_share: now });
        }
      }

      if (isStarter(r)) {
        const hasGame = r.nfl_team_id != null && sched.has(`${r.nfl_team_id}|${w}`);
        // bye unfilled: needs a schedule for the season to tell a bye from missing data
        if (sched.size && r.nfl_team_id != null && !hasGame) emit('bye_unfilled', r, { nfl_team_id: r.nfl_team_id });
        // dead starter left in: his team played and he did not — no snaps (in a week whose
        // snaps are loaded), no stat line, and no points
        if (skill && hasGame && snapsKnown) {
          const s = snaps.share(r.player_id, w);
          if ((s == null || s === 0) && !statLine.has(`${r.player_id}|${w}`) && !(r.actual_points > 0)) {
            emit('dead_starter_left_in', r, { nfl_team_played: true, snap_share: s, actual_points: r.actual_points });
          }
        }
        // started through a bad matchup
        // (a projection of 0 means ESPN has him ruled out: that is not a matchup read)
        if (skill && r.projected_points > 0) {
          const prior = [...(projHist.get(r.espn_player_id) ?? new Map()).entries()].filter(([wk]) => wk < w).map(([, p]) => p);
          const priorMean = mean(prior);
          if (priorMean != null && priorMean > 0 && r.projected_points <= BAD_MATCHUP_RATIO * priorMean) {
            const better = byTeam.get(r.team_id).filter(b => isBench(b) && b.position === r.position
              && b.projected_points != null && b.projected_points > r.projected_points)
              .sort((a, b) => b.projected_points - a.projected_points)[0];
            if (better) {
              emit('started_bad_matchup', r, { projected: r.projected_points, own_prior_mean: r2(priorMean),
                prior_weeks: prior.length, better_bench_player_id: better.player_id,
                better_bench_projected: better.projected_points });
            }
          }
        }
        // flex choice: the revealed ranking
        const eligible = FLEX_SLOTS[r.lineup_slot_id];
        if (eligible && r.player_id != null) {
          const over = byTeam.get(r.team_id).filter(b => isBench(b) && eligible.has(b.position) && b.player_id != null
            && (!snapsKnown || (snaps.share(b.player_id, w) ?? 0) > 0));
          if (over.length) {
            const bestBench = Math.max(...over.map(b => b.projected_points ?? -Infinity));
            emit('flex_choice', r, {
              slot: r.lineup_slot_id === 7 ? 'OP' : 'FLEX',
              over_player_ids: over.map(b => b.player_id).sort((a, b) => a - b),
              chosen_projected: r.projected_points,
              best_bench_projected: Number.isFinite(bestBench) ? bestBench : null,
              chose_lower_projection: r.projected_points != null && Number.isFinite(bestBench)
                ? bestBench > r.projected_points : null,
            });
          }
        }
      }
    }
  }

  // adds of last week's top scorer: on nobody's roster the week before, top 5 at his position that week
  for (const w of weekList) {
    if (!weeks.has(w - 1)) continue;
    const rosteredBefore = new Set(weeks.get(w - 1).rows.map(r => r.espn_player_id));
    // QB/RB/WR/TE only: pprPoints does not score kicks or defenses, so their rank means nothing
    const adds = weeks.get(w).rows.filter(r => !rosteredBefore.has(r.espn_player_id) && r.player_id != null
      && SKILL.has(r.position));
    if (!adds.length) continue;
    const ranks = weeklyRanks(yr, w - 1);
    for (const r of adds) {
      const rk = ranks.get(r.player_id);
      if (rk && rk.rank <= TOP_SCORER_RANK) {
        emit('added_last_week_top_scorer', r, { prior_week: w - 1, prior_week_rank: rk.rank, prior_week_points: rk.points });
      }
    }
  }

  // the latest period: trade block and IR discipline, as the lineup stands now
  for (const r of weeks.get(latest).rows) {
    if (isBench(r) && blocks.get(String(r.team_id))?.get(r.espn_player_id) === 'ON_THE_BLOCK') {
      emit('benched_and_shopped', r, { trade_block: 'ON_THE_BLOCK' });
    }
    const status = r.injury_status ?? r.pregame_injury_status;
    if (isBench(r) && status === 'INJURY_RESERVE') {
      emit('injured_not_on_ir', r, { status });
    }
  }

  const byManager = {};
  for (const s of signals) {
    const m = byManager[s.roster_id] ?? (byManager[s.roster_id] = {});
    m[s.signal] = (m[s.signal] ?? 0) + 1;
  }
  const unavailable = {};
  if (!sched.size) unavailable.bye_unfilled = `no schedule_games rows for ${yr}`;
  if (!finals.some(w => snaps.weeksWithSnaps.has(w))) {
    unavailable.benched_intact_usage = unavailable.dead_starter_left_in = 'no completed week with snap counts loaded';
  }
  if (blockError) unavailable.benched_and_shopped = blockError;
  return {
    ...base, available: true, reason: null,
    periods: weekList.map(w => ({ week: w, source: weeks.get(w).source })),
    latest_period: latest, signals, by_manager: byManager, unavailable,
  };
}
