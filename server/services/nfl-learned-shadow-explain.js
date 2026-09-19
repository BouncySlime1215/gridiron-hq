/**
 * Read-only context for the learned-shadow (Python `unified_margin`) research
 * model, built for the page-explain assistant. Two things this hands back:
 * the frozen shadow prediction for one specific game, if one exists, and the
 * measured historical performance -- from the latest COMPLETED walk-forward
 * audit -- for whichever predeclared diagnostic groups that game falls into.
 *
 * TIMING, which is what this module is actually for. The audit
 * (`research/betting/nfl/unified_margin_audit.py`) does not run every week
 * and must not: it is a full historical refit-and-score pass, and running it
 * on a schedule tied to live decisions would let the model implicitly peek
 * at whichever window makes it look best -- the exact anytime-monitoring
 * problem the master plan's Stage 5/6 process exists to prevent. So the
 * audit runs at deliberate checkpoints (after a real model/feature change,
 * or on a predeclared review schedule) and, on completion, atomically
 * updates one pointer file (`.../unified_margin_audit/LATEST.json`). This
 * module reads that pointer. An upcoming game's explanation therefore
 * reflects whatever the last COMPLETED audit found -- unchanged between
 * audits, and changing all at once exactly when a new one finishes -- never
 * synthesized fresh per request and never drifting continuously.
 *
 * AUTHORITY. This model has zero betting authority regardless of what any
 * audit finds -- see `learned-shadow-runner.js`'s own decision-tape note,
 * "Unqualified trained margin candidate; zero stake; not an exact T-60 or
 * priced forecast." Nothing here can change a gate, a stake, or which model
 * is live. This module only makes the research trail visible on request;
 * the audit informs an explanation, never an action.
 */
import fs from 'node:fs';
import path from 'node:path';
import { rows } from '../db/index.js';
import { PROJECT_ROOT } from '../platform/paths.js';

export const LEARNED_SHADOW_VERSION = 'nfl-unified-margin-shadow-v1';

const AUDIT_OUTPUT_ROOT = path.join(
  PROJECT_ROOT, 'docs/betting-model/research/experiment-results/unified_margin_audit');

/** The latest COMPLETED audit's pointer, or null if none has ever finished. */
export function latestAuditPointer() {
  const file = path.join(AUDIT_OUTPUT_ROOT, 'LATEST.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

/**
 * Mirrors `unified_margin_audit.py`'s `DIAGNOSTIC_GROUPS` predicate NAMES
 * exactly, restricted to the four that use only schedule/venue/rest facts --
 * knowable well before kickoff regardless of market state. The audit's other
 * five groups are market-based (e.g. `market_near_pick_em_under_3`) and need
 * a live quote at decision time; this model is football-only and never sees
 * one (see the market-correction-head gap the plan already records), so
 * those groups are not evaluated here rather than faked from a number the
 * model itself was never given.
 */
const SCHEDULE_GROUPS = {
  season_phase_early_weeks_1_6: g => g.week <= 6,
  season_phase_mid_weeks_7_13: g => g.week >= 7 && g.week <= 13,
  season_phase_late_weeks_14_18: g => g.week >= 14 && g.week <= 18,
  postseason_weeks_19_plus: g => g.week >= 19,
  divisional_game: g => !!g.div_game,
  indoor_roof: g => g.roof === 'dome' || g.roof === 'closed',
  rest_advantage_3plus_days: g => Math.abs((g.home_rest ?? 0) - (g.away_rest ?? 0)) >= 3,
};

function applicableGroups(game) {
  return Object.keys(SCHEDULE_GROUPS).filter(name => SCHEDULE_GROUPS[name](game));
}

/**
 * @param {object} args
 * @param {number} args.season
 * @param {number} args.week
 * @param {string} args.home_team
 * @returns The frozen shadow prediction for this game (if one has been
 *   recorded) plus whatever the latest completed audit measured for the
 *   groups this game falls into. `available: false` when no shadow
 *   observation exists for this game -- never a fabricated one.
 */
export function learnedShadowExplainContext({ season, week, home_team } = {}) {
  const s = Number(season), w = Number(week), home = String(home_team ?? '').trim().toUpperCase();
  if (!Number.isFinite(s) || !Number.isFinite(w) || !home) {
    return { error: 'season, week and home_team are all required' };
  }

  const found = rows(`
    SELECT e.matchup, e.away_team, e.projected_margin, e.abstention_reason, e.feature_snapshot_json,
           r.decided_at, r.data_identity_status
    FROM nfl_decision_events e JOIN nfl_decision_runs r ON r.id = e.run_id
    WHERE r.experiment_id = ? AND r.season = ? AND r.week = ? AND e.home_team = ?
    ORDER BY r.decided_at DESC LIMIT 1`, LEARNED_SHADOW_VERSION, s, w, home);

  const audit = latestAuditPointer();
  const auditSummary = audit ? {
    run_id: audit.run_id, completed_at: audit.completed_at,
    weeks_fitted: audit.weeks_fitted, games_scored: audit.games_scored,
    overall: audit.overall_common_support, paired_comparison: audit.paired_comparison,
    verdict: audit.verdict,
  } : null;

  if (!found.length) {
    return {
      available: false,
      reason: 'no_learned_shadow_observation_recorded_for_this_game',
      model: LEARNED_SHADOW_VERSION,
      authority: 'research_only; zero stake; this model has never had betting authority',
      latest_audit: auditSummary,
    };
  }

  const event = found[0];
  let snapshot = {};
  try { snapshot = JSON.parse(event.feature_snapshot_json ?? '{}'); } catch { snapshot = {}; }
  const forecast = snapshot.unified_forecast ?? null;

  // Group membership needs div_game/roof/rest, which the frozen request
  // itself may not carry every field of depending on capture path -- fall
  // back to the same game's row in game_lines rather than guessing.
  const gameRow = rows(
    `SELECT div_game, roof, rest_days FROM game_lines
     WHERE season=? AND week=? AND team=? AND home=1 LIMIT 1`, s, w, home)[0] ?? {};
  const awayRow = event.away_team ? rows(
    `SELECT rest_days FROM game_lines
     WHERE season=? AND week=? AND team=? AND home=0 LIMIT 1`, s, w, event.away_team)[0] ?? {} : {};
  const game = { week: w, div_game: gameRow.div_game, roof: gameRow.roof,
    home_rest: gameRow.rest_days, away_rest: awayRow.rest_days };
  const groups = applicableGroups(game);

  const auditGroupStats = {};
  if (audit?.diagnostic_groups) {
    for (const name of groups) {
      const stat = audit.diagnostic_groups[name];
      if (stat) auditGroupStats[name] = {
        n_games: stat.n_games, inconclusive_small_sample: stat.inconclusive_small_sample,
        unified_mae: stat.unified?.mae ?? null, market_mae: stat.market?.mae ?? null,
      };
    }
  }

  return {
    available: true,
    model: LEARNED_SHADOW_VERSION,
    authority: 'research_only; zero stake; this model has never had betting authority',
    matchup: event.matchup,
    decided_at: event.decided_at,
    data_identity_status: event.data_identity_status,
    predicted_margin: event.projected_margin,
    abstention_reason: event.abstention_reason,
    forecast_detail: forecast && Object.keys(forecast).length ? {
      components: forecast.components ?? null,
      learned_weights: forecast.learned_weights ?? null,
      interval_80: forecast.interval_80 ?? null,
      calibration_status: forecast.calibration?.status ?? null,
    } : null,
    applicable_diagnostic_groups: groups,
    latest_audit: auditSummary,
    audit_stats_for_this_games_groups: auditGroupStats,
    note: 'This is a research-only shadow forecast with no betting authority. Group-level '
      + 'stats are FROM THE LATEST COMPLETED AUDIT, not recomputed for this request -- they '
      + 'describe historical performance in games sharing this game\'s schedule/venue/rest '
      + 'profile, not a claim about this specific game\'s outcome.',
  };
}
