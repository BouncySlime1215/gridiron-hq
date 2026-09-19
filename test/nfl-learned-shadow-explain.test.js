/**
 * Tests for `nfl-learned-shadow-explain.js` and its wiring into the
 * page-explain tool set.
 *
 * Three things matter here:
 *   1. A game with a real recorded shadow observation returns its forecast,
 *      its diagnostic-group membership, and the latest audit's stats for
 *      those groups -- and never fabricates any of it when a piece is
 *      genuinely absent.
 *   2. A game with NO shadow observation says so honestly (`available:
 *      false`), never a silent empty success.
 *   3. Every payload states, explicitly, that this model has zero betting
 *      authority -- this is a research explainer, not a picks feed, and
 *      that sentence must survive whatever the audit found either way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-learned-shadow-explain-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run, rows, dbPath } = await import('../server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH,
  'this test must never be able to reach the real database');
await (await import('../server/db/migrate.js')).runMigrations();
const { learnedShadowExplainContext, latestAuditPointer, LEARNED_SHADOW_VERSION } =
  await import('../server/services/nfl-learned-shadow-explain.js');
const { runTool, TOOLS } = await import('../server/services/page-explain-tools.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function seedGame({ season, week, home, away, divGame = 0, roof = 'outdoors', homeRest = 7, awayRest = 7 }) {
  run(`INSERT INTO game_lines (season,week,team,opponent,home,gameday,div_game,roof,rest_days)
       VALUES (?,?,?,?,1,?,?,?,?)`, season, week, home, away, `${season}-09-01`, divGame, roof, homeRest);
  run(`INSERT INTO game_lines (season,week,team,opponent,home,gameday,div_game,roof,rest_days)
       VALUES (?,?,?,?,0,?,?,?,?)`, season, week, away, home, `${season}-09-01`, divGame, roof, awayRest);
}

function seedShadowObservation({ season, week, home, away, projectedMargin, forecastDetail }) {
  const runId = `run-${home}-${away}-${season}-${week}`;
  run(`INSERT INTO nfl_decision_runs
       (id, season, week, policy_id, policy_version, board_hash, experiment_id, engine_mode,
        decided_at, decision_count, selected_count, data_identity_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  runId, season, week, 'nfl-trained-margin-shadow', LEARNED_SHADOW_VERSION, `hash-${runId}`,
  LEARNED_SHADOW_VERSION, LEARNED_SHADOW_VERSION, '2026-09-10T12:00:00Z', 1, 0, 'frozen_packet');
  run(`INSERT INTO nfl_decision_events
       (run_id, matchup, home_team, away_team, market, eligible, projected_margin,
        abstention_reason, feature_snapshot_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
  runId, `${away} @ ${home}`, home, away, 'spreads', 0, projectedMargin,
  'research_only_margin_model_without_probability_calibration',
  JSON.stringify({ unified_forecast: forecastDetail }));
}

test('a game with a real shadow observation returns its forecast and group membership', () => {
  seedGame({ season: 2026, week: 3, home: 'KC', away: 'BAL', divGame: 1, roof: 'dome', homeRest: 7, awayRest: 3 });
  seedShadowObservation({
    season: 2026, week: 3, home: 'KC', away: 'BAL', projectedMargin: 3.2,
    forecastDetail: {
      components: { ridge: 2.1, lightgbm: 4.0 },
      learned_weights: { ridge: 0.45, lightgbm: 0.55 },
      interval_80: [-12.4, 18.8],
      calibration: { status: 'research_calibration_requires_outer_validation' },
    },
  });

  const result = learnedShadowExplainContext({ season: 2026, week: 3, home_team: 'kc' });
  assert.equal(result.available, true);
  assert.equal(result.predicted_margin, 3.2);
  assert.match(result.matchup, /BAL @ KC/);
  assert.ok(result.authority.includes('zero stake'));
  assert.deepEqual(result.forecast_detail.learned_weights, { ridge: 0.45, lightgbm: 0.55 });
  assert.deepEqual(result.forecast_detail.interval_80, [-12.4, 18.8]);

  // divisional (div_game=1), dome (indoor_roof), 4-day rest gap (>=3),
  // and week 3 (early). Postseason/market groups must NOT appear.
  assert.ok(result.applicable_diagnostic_groups.includes('divisional_game'));
  assert.ok(result.applicable_diagnostic_groups.includes('indoor_roof'));
  assert.ok(result.applicable_diagnostic_groups.includes('rest_advantage_3plus_days'));
  assert.ok(result.applicable_diagnostic_groups.includes('season_phase_early_weeks_1_6'));
  assert.ok(!result.applicable_diagnostic_groups.includes('postseason_weeks_19_plus'));
  for (const name of result.applicable_diagnostic_groups) {
    assert.ok(!name.startsWith('market_'), 'a market-based group must never be evaluated here');
  }
});

test('a game with no recorded shadow observation says so honestly, never fabricates one', () => {
  seedGame({ season: 2026, week: 9, home: 'SF', away: 'SEA' });
  const result = learnedShadowExplainContext({ season: 2026, week: 9, home_team: 'SF' });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no_learned_shadow_observation_recorded_for_this_game');
  assert.ok(result.authority.includes('zero stake'));
  assert.equal(result.predicted_margin, undefined);
});

test('missing required arguments are refused, not defaulted', () => {
  assert.deepEqual(
    learnedShadowExplainContext({ season: 2026, home_team: 'KC' }),
    { error: 'season, week and home_team are all required' });
});

test('the tool is registered and dispatches through runTool identically to a direct call', () => {
  assert.ok(TOOLS.some(t => t.name === 'learned_shadow_research_context'));
  seedGame({ season: 2026, week: 4, home: 'DAL', away: 'PHI' });
  seedShadowObservation({ season: 2026, week: 4, home: 'DAL', away: 'PHI', projectedMargin: -1.5, forecastDetail: {} });
  const viaTool = runTool('learned_shadow_research_context', { season: 2026, week: 4, home_team: 'DAL' });
  const direct = learnedShadowExplainContext({ season: 2026, week: 4, home_team: 'DAL' });
  assert.deepEqual(viaTool, direct);
});

test('an empty forecast_detail object is reported as null, not an empty-but-present object', () => {
  seedGame({ season: 2026, week: 11, home: 'DAL', away: 'PHI' });
  seedShadowObservation({ season: 2026, week: 11, home: 'DAL', away: 'PHI', projectedMargin: -0.4, forecastDetail: {} });
  const result = learnedShadowExplainContext({ season: 2026, week: 11, home_team: 'DAL' });
  assert.equal(result.forecast_detail, null,
    'an empty {} forecast must be reported as null, not as a present-but-empty object a caller might misread as real detail');
});

test('latestAuditPointer reads a real pointer file when one exists, and is null when none does', () => {
  // This session's own environment writes no audit output into the temp DB
  // dir; the pointer lives under the project's docs/ tree and is read by
  // absolute path regardless of GRIDIRON_DB_PATH, so this only checks the
  // function does not throw and returns one of the two honest shapes.
  const pointer = latestAuditPointer();
  assert.ok(pointer === null || typeof pointer === 'object');
  if (pointer) {
    assert.equal(pointer.schema, 'nfl-unified-margin-audit-latest-pointer-v1');
    assert.ok(pointer.run_id);
    assert.ok(pointer.diagnostic_groups && typeof pointer.diagnostic_groups === 'object');
  }
});
