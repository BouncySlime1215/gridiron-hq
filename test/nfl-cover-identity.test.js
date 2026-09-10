import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-cover-identity-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, dbPath, run } = await import('../server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH);
await (await import('../server/db/migrate.js')).runMigrations();
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const replayCalls = [];
mock.module('../server/services/nfl-replay.js', { namedExports: { replaySeason: (season, options) => {
  replayCalls.push({ season, options });
  return { bets: Array.from({ length: 120 }, (_, i) => ({ result: i % 3 ? 'Won' : 'Lost',
    week: Math.floor(i / 8) + 1, american_price: -110, opposite_price: -110, edge_points: (i % 7) + 1 })) };
} } });
let neural = { production_eligible: false, predicted_margin: null, version: 'neural-fixture-v1' };
mock.module('../server/services/nfl-ensemble.js', { namedExports: { ensembleWeek: (_s, _w, options) => [{
  home: 'KC', away: 'BAL', input_mode: options.includeChallengers ? 'all-inputs' : 'champion-inputs',
  reliability_controller: { version: 'fixture-controller' }, models: [
    { id: 'raw-only', margin: 4, margin_weight: 1, residual_weight: 0 },
    { id: 'residual-only', margin: 5, margin_weight: 0, residual_weight: 1, residual_slope: 0.5 },
    { id: 'excluded-challenger', challenger_only: true, margin: 99, margin_weight: 1, residual_weight: 1, residual_slope: 1 }
  ], ensemble: {
    market_spread: -3, projected_margin: 5, model_disagreement_margin: 1, blend_mode: options.blendMode,
    distribution: { calibration_state: 'research_distribution_only', production_eligible: false }
  }
}] } });
mock.module('../server/services/nfl-online-neural.js', { namedExports: { onlineNeuralPrediction: () => neural } });
mock.module('../server/services/nfl-candidate-findings.js', { namedExports: { promotedFindingVeto: () => ({ vetoed: false }) } });
mock.module('../server/services/nfl-pregame.js', { namedExports: { pregameSnapshotFor: () => null } });
// Preserve actual board/calibration wiring; the policy's separate economic gates
// are tested elsewhere. This transparent selector exposes the input decisions.
mock.module('../server/services/nfl-policy.js', { namedExports: {
  NFL_PRODUCTION_POLICY: { id: 'fixture', version: 'v1' },
  applyNflPolicy: (decisions, policy) => ({ policy, decisions, selected: decisions.filter(d => d.calibration_eligible) })
} });
const { spreadForecastIdentity, coverCalibrationVersion } = await import('../server/services/nfl-forecast-identity.js');
const { buildCoverCalibration, calibratedCoverProbability, latestCoverCalibration } = await import('../server/services/nfl-cover-calibration.js');
const { autoPickDecisionBoard, clearAutoPickBoardCache } = await import('../server/services/nfl-auto-picks.js');
const live = options => spreadForecastIdentity({ informationRegime: 'live_weekly_unfrozen', ...options });
function insertFit(identity, { gate = true, trainedThrough = 2025, metricsIdentity = identity, version = null } = {}) {
  run(`INSERT INTO nfl_cover_calibrations
    (model_version,trained_from,trained_through,created_at,sample_size,intercept,edge_slope,metrics_json,reliability_json)
    VALUES (?,2021,?,datetime('now'),400,0,0.3,?,'[]')
    ON CONFLICT(model_version,trained_from,trained_through) DO UPDATE SET metrics_json=excluded.metrics_json`,
    version ?? coverCalibrationVersion(identity), trainedThrough,
    JSON.stringify({ forward_gate_passed: gate, forecast_identity: metricsIdentity }));
}
const probability = (identity, extra = {}) => calibratedCoverProbability({ season: 2026,
  marketProbability: 0.5, edgePoints: 3, forecastIdentity: identity, ...extra });

test('forecast identities normalize equivalent configuration and distinguish every implemented forecast choice', () => {
  assert.deepEqual(live({ modelOptions: { families: ['Market', 'Context', 'Market'] } }),
    live({ modelOptions: { families: ['Context', 'Market'] } }));
  const base = live();
  for (const options of [
    { modelOptions: { blendMode: 'raw' } }, { modelOptions: { weighting: 'equal' } },
    { modelOptions: { excludeModels: ['market_anchor'] } }, { modelOptions: { families: ['Market'] } },
    { modelOptions: { includeChallengers: true }, reliabilityVersion: 'v1' },
    { neuralVersion: 'neural-v1' }, { informationRegime: 'historical_weekly_closing' }
  ]) assert.notEqual(live(options).id, base.id);
  assert.throws(() => spreadForecastIdentity({ informationRegime: 'T-60' }), /implemented/);
  assert.throws(() => coverCalibrationVersion({ ...base, descriptor: { ...base.descriptor, blend_mode: 'raw' } }), /valid forecast/);
});

test('historical builder defaults to residual forecasts and stamps closing research without claiming live qualification', () => {
  const fit = buildCoverCalibration({ fromSeason: 2021, throughSeason: 2023 });
  assert.equal(replayCalls.length, 3);
  assert.ok(replayCalls.every(c => c.options.modelOptions.blendMode === 'market_residual'));
  assert.equal(fit.metrics.forecast_identity.descriptor.blend_mode, 'market_residual');
  assert.equal(fit.metrics.forecast_identity.descriptor.information_regime, 'historical_weekly_closing');
  assert.equal(fit.metrics.evidence_class, 'historical_closing_research');
  assert.equal(fit.metrics.prospective_qualified, false);
  assert.equal(probability(live()).probability, null);
  assert.equal(probability(live()).reason, 'matching_calibration_missing');
  assert.throws(() => buildCoverCalibration({ modelOptions: { includeChallengers: true } }), /controller provenance/);
});

test('raw and residual calibration fits coexist and the builder returns its own exact graph', () => {
  const raw = buildCoverCalibration({ fromSeason: 2021, throughSeason: 2023, modelOptions: { blendMode: 'raw' } });
  const residual = buildCoverCalibration({ fromSeason: 2021, throughSeason: 2023 });
  assert.notEqual(raw.model_version, residual.model_version);
  assert.equal(raw.metrics.forecast_identity.descriptor.blend_mode, 'raw');
  assert.equal(latestCoverCalibration(2024, raw.model_version).id, raw.id);
  assert.equal(residual.metrics.forecast_identity.descriptor.blend_mode, 'market_residual');
});

test('legacy passed-gate fits do not authorize an unidentified or changed forecast', () => {
  insertFit(live(), { version: 'cover-logit-v2', metricsIdentity: undefined });
  assert.equal(probability(null).reason, 'forecast_identity_missing');
  assert.equal(probability(live()).reason, 'matching_calibration_missing');
  insertFit(live());
  assert.ok(probability(live()).probability > 0.5);
  for (const changed of [live({ modelOptions: { blendMode: 'raw' } }), live({ neuralVersion: 'different-neural' }),
    live({ modelOptions: { families: ['Market'] } }), live({ informationRegime: 'historical_weekly_closing' })]) {
    assert.equal(probability(changed).probability, null);
  }
});

test('matching identity still requires earlier training, its gate and valid numerical inputs', () => {
  const identity = live({ modelOptions: { weighting: 'equal' } });
  insertFit(identity, { trainedThrough: 2026 });
  assert.equal(probability(identity).probability, null);
  insertFit(identity, { gate: false });
  assert.equal(probability(identity).reason, 'calibration_not_proven');
  insertFit(identity, { metricsIdentity: live() });
  assert.equal(probability(identity).reason, 'calibration_identity_mismatch');
  insertFit(identity);
  for (const extra of [{ marketProbability: NaN }, { marketProbability: 0 }, { marketProbability: 1 },
    { edgePoints: Infinity }, { edgePoints: -1 }]) assert.equal(probability(identity, extra).reason, 'invalid_calibration_input');
});

run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,spread_odds,source,fetched_at)
  VALUES (2026,1,'KC','BAL',1,-3,-110,'fixture','2026-09-10T01:00:00Z'),
         (2026,1,'BAL','KC',0,3,-110,'fixture','2026-09-10T01:00:00Z')`);

test('real decision-board wiring uses exact live identity and preserves raw forecasts when neural calibration is missing', () => {
  clearAutoPickBoardCache();
  const base = autoPickDecisionBoard(2026, 1).decisions[0];
  assert.deepEqual(base.feature_snapshot.forecast_identity, live());
  assert.ok(base.model_probability > 0.5);
  assert.deepEqual(base.feature_snapshot.active_model_ids, ['residual-only']);
  assert.equal(base.feature_snapshot.model_trace.find(m => m.id === 'residual-only').residual_weight, 1);
  assert.equal(base.feature_snapshot.model_trace.find(m => m.id === 'excluded-challenger').contributes_to_base_margin, false);
  neural = { production_eligible: true, predicted_margin: 9, version: 'neural-fixture-v1' };
  clearAutoPickBoardCache();
  const board = autoPickDecisionBoard(2026, 1);
  const changed = board.decisions[0];
  assert.equal(changed.model_probability, null);
  assert.equal(changed.calibration_status, 'matching_calibration_missing');
  assert.equal(changed.edge_points, 6);
  assert.deepEqual(changed.feature_snapshot.raw_forecast, { base_projected_margin: 5, projected_margin: 9,
    market_margin: 3, signed_edge_points: 6 });
  assert.equal(changed.feature_snapshot.predictive_distribution_scope, 'base_ensemble_research_only');
  assert.equal(changed.feature_snapshot.coordinated_decision_head.neural.used, true);
  assert.equal(changed.feature_snapshot.forecast_identity.descriptor.neural_version, 'neural-fixture-v1');
  assert.equal(board.selected.length, 0);
});

test('missing neural forecast is recorded as unused even if its own eligibility flag is set', () => {
  neural = { production_eligible: true, predicted_margin: null, version: 'neural-fixture-v1' };
  clearAutoPickBoardCache();
  const board = autoPickDecisionBoard(2026, 1).decisions[0];
  assert.equal(board.feature_snapshot.coordinated_decision_head.neural.used, false);
  assert.deepEqual(board.feature_snapshot.forecast_identity, live());
  assert.equal(board.edge_points, 2);
});
