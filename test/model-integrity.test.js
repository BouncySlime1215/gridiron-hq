import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-model-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { __test: sim } = await import('../server/services/season-sim.js');
const { db } = await import('../server/db/index.js');
const { projectBatter, batterTotalBases, pitcherStrikeouts } = await import('../server/services/mlb-projections.js');
const { challengerSignalWeek, fitEnsemble, clearEnsembleCache, ensembleLine,
  withEphemeralEnsembleArtifacts } = await import('../server/services/nfl-ensemble.js');
const { nflDataConsistencyAudit } = await import('../server/services/nfl-data-consistency.js');
const { deriveSignalReliability } = await import('../server/services/nfl-signal-reliability.js');
const { fitNeuralDecisionCalibrator, calibratedNeuralProbability } = await import('../server/services/nfl-neural-replay.js');
const { calibratedCoverProbability } = await import('../server/services/nfl-cover-calibration.js');
const { nflCoordinationAudit } = await import('../server/services/nfl-coordination-audit.js');
const { withRandomSeed, random } = await import('../server/services/stats-util.js');
const { weeklyDecisionBacktest } = await import('../server/services/backtest.js');
await import('../server/services/nflverse.js');
const { gameScriptFor, clearGameScriptCache } = await import('../server/services/gamescript.js');
const { weeklyAvailability } = await import('../server/services/contingency.js');
const { createExperiment } = await import('../server/services/nfl-experiments.js');
const { applyNflPolicy, NFL_PRODUCTION_POLICY } = await import('../server/services/nfl-policy.js');
const { uncertainty } = await import('../server/services/nfl-replay.js');
const { starterFor } = await import('../server/services/mlb.js');
const { createMlbExperiment } = await import('../server/services/mlb-experiments.js');
const { validateEvidenceCutoff, captureEvidenceManifest, featureContracts, recordGateAudit, promoteEligibleAudit } = await import('../server/services/model-governance.js');
const { buildMlbCalibration } = await import('../server/services/mlb-calibration.js');
const { nflMarketMovement } = await import('../server/services/market-movement.js');
const { evidenceDaemonStatus } = await import('../server/services/evidence-daemon.js');
const { allPicks } = await import('../server/services/mlb-auto-picks.js');
const { startAiBlindReplay, normalizeReview, agentLearningMemory } = await import('../server/services/nfl-ai-replay.js');
const { validationFirewall } = await import('../server/services/nfl-evidence.js');
const { decomposePassingError } = await import('../server/services/nfl-passing-diagnostic.js');
const { flattenAllProps } = await import('../server/services/odds-api.js');
const { finalizeClosingSnapshots, noVigPropProbability, duePropCaptureHorizon } = await import('../server/services/nfl-prop-clv.js');
const { teamPlayerAvailability, clearPlayerValueCache } = await import('../server/services/nfl-player-value.js');
const { createNetwork, predictNetwork, trainBatch } = await import('../server/services/nfl-online-neural.js');
const { safeStakeFor } = await import('../server/services/staking.js');
const {
  WEEKLY_ENSEMBLE_HEADS, WEEKLY_ENSEMBLE_WEIGHTS,
  weeklyEnsemblePrediction, weeklyEnsembleContext
} = await import('../server/services/weekly-ensemble.js');
const { activeWeeklyWeightSet, saveWeeklyFit } = await import('../server/services/weekly-weight-store.js');
const { groundPlayerVerdict } = await import('../server/routes/players.js');
const { detectRoleChange } = await import('../server/services/role-changepoint.js');
const {
  playerWeekProjection, playerWeekEventExpectation, sampleTeamWeekEvents
} = await import('../server/services/player-week-engine.js');
const { PLAYER_HEADS } = await import('../server/services/player-head-registry.js');
const { auditPlayerHeads } = await import('../server/services/player-head-validation.js');
const { anytimeTdHit } = await import('../server/services/nfl-props.js');
const { scoreSim } = await import('../server/services/scoring.js');
const { blindAuditProtocol, __test: blindAuditTest } = await import('../server/services/nfl-blind-audit.js');
const { signalQualityCatalog, playerSignalTrace } = await import('../server/services/model-signal-quality.js');
const { reconcileOutcomeWeights } = await import('../server/services/nfl-drive-sim.js');
const { newsSourceVerification } = await import('../server/services/nfl-news-signal.js');
const { activeLearningEpoch, nflEngineComponents, startLearningEpoch } = await import('../server/services/nfl-engine-registry.js');
const { nflBackfillPlan } = await import('../server/services/nfl-engine-backfill.js');
const { RISK_MODELS, predictRiskModel, trainRiskState, __test: riskLab } = await import('../server/services/nfl-risk-lab.js');
const { teamRosterStrength, importLicensedPffGrades, clearRosterStrengthCache } = await import('../server/services/nfl-roster-strength.js');
const { NFL_EXPERTS, persistWeeklyExpertAudit, __test: expertCouncilTest } = await import('../server/services/nfl-expert-council.js');
const { __test: expertCoordinatorTest } = await import('../server/services/nfl-expert-coordinator.js');
const { __test: newsLatencyTest } = await import('../server/services/nfl-news-market-latency.js');
const { __test: postgameTest } = await import('../server/services/nfl-postgame-truth.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('expert council registers every modelling role and missing evidence abstains instead of becoming zero', () => {
  assert.equal(NFL_EXPERTS.length, 12);
  assert.equal(new Set(NFL_EXPERTS.map(expert => expert.id)).size, 12);
  const missing = expertCouncilTest.output('news_reaction', { observed: false, missingReason: 'no verified claims' });
  assert.equal(missing.observed, false);
  assert.equal(missing.forecast_residual, null);
  assert.equal(missing.missing_reason, 'no verified claims');
});

test('expert reporting separates support, forecasts, zero coverage and lifecycle differences', () => {
  const spread = NFL_EXPERTS.find(expert => expert.id === 'rulebook');
  const usage = NFL_EXPERTS.find(expert => expert.id === 'player_opportunity');
  const live = NFL_EXPERTS.find(expert => expert.id === 'live_updater');
  assert.equal(expertCouncilTest.reportingState(spread,
    { examples: 10, observed: 10, forecasts: 10 }).reporting_state, 'forecasting');
  assert.equal(expertCouncilTest.reportingState(usage,
    { examples: 10, observed: 10, forecasts: 0 }).reporting_state, 'different_score');
  assert.equal(expertCouncilTest.reportingState(spread,
    { examples: 10, observed: 0, forecasts: 0 }).reporting_state, 'zero_coverage');
  assert.equal(expertCouncilTest.reportingState(live,
    { examples: 10, observed: 0, forecasts: 0 }).reporting_state, 'different_lifecycle');
});

test('specialist matrix never turns a missing opinion into a zero forecast', () => {
  const registry = NFL_EXPERTS.find(expert => expert.id === 'news_reaction');
  const missing = expertCouncilTest.matrixCell(registry, {
    observed: 0, forecast_residual: null, missing_reason: 'verified news unavailable'
  });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.forecast_residual, null);
  assert.equal(missing.missing_reason, 'verified news unavailable');
  const realZero = expertCouncilTest.matrixCell(registry, {
    observed: 1, forecast_residual: 0, directional_correct: null
  });
  assert.equal(realZero.status, 'forecast');
  assert.equal(realZero.forecast_residual, 0);
});

test('robust expert coordinator caps correlated influence and survives a giant weekly outlier', () => {
  const games = Array.from({ length: 160 }, (_, index) => {
    const signal = (index % 9) - 4;
    const experts = new Map(NFL_EXPERTS.map(expert => [expert.id, null]));
    experts.set('rulebook', signal);
    experts.set('similar_games', signal * 1.02);
    experts.set('boosted_tree', signal * 0.98);
    return { season: 2020 + Math.floor(index / 64), week: 1 + Math.floor(index / 16), home: `T${index}`,
      target: index === 159 ? 150 : signal * 0.7 + ((index % 3) - 1), experts };
  });
  const fit = expertCoordinatorTest.fitRows(games);
  const directionalWeights = fit.coefficients.slice(1, NFL_EXPERTS.length + 1);
  assert.ok(directionalWeights.every(weight => Math.abs(weight) <= 0.350001));
  assert.ok(directionalWeights.reduce((sum, weight) => sum + Math.abs(weight), 0) <= 0.800001);
  assert.ok(Math.abs(fit.coefficients[0]) <= 1);
  assert.ok(Number.isFinite(fit.robustSigma) && fit.robustSigma >= 6);
});

test('expert coordinator carries missingness separately from a real zero forecast', () => {
  const centers = Object.fromEntries(NFL_EXPERTS.map(expert => [expert.id, 0]));
  const scales = Object.fromEntries(NFL_EXPERTS.map(expert => [expert.id, 1]));
  const experts = new Map(NFL_EXPERTS.map(expert => [expert.id, null]));
  experts.set('rulebook', 0);
  const vector = expertCoordinatorTest.design({ experts }, centers, scales);
  const offset = 1 + NFL_EXPERTS.length;
  assert.equal(vector[offset], 0, 'an observed zero is not missing');
  assert.equal(vector[offset + 1], 1, 'an unavailable player builder is explicitly missing');
});

test('combined coordinator trace preserves raw, learned and normalized specialist weights', () => {
  const centers = Object.fromEntries(NFL_EXPERTS.map(expert => [expert.id, 0]));
  const scales = Object.fromEntries(NFL_EXPERTS.map(expert => [expert.id, 1]));
  const coefficients = new Array(1 + NFL_EXPERTS.length * 2).fill(0);
  coefficients[1] = 0.2;
  coefficients[2] = -0.1;
  const experts = NFL_EXPERTS.map(expert => ({ id: expert.id, observed: false,
    forecast_residual: null, missing_reason: 'not observed' }));
  experts[0] = { id: NFL_EXPERTS[0].id, observed: true, forecast_residual: 2, missing_reason: null };
  experts[1] = { id: NFL_EXPERTS[1].id, observed: true, forecast_residual: -1, missing_reason: null };
  const coordinated = expertCoordinatorTest.coordinateWith({ centers, scales, coefficients,
    robustSigma: 6, games: 200, weeks: 20 }, experts);
  const active = coordinated.contributions.filter(item => item.raw != null);
  assert.equal(active.length, 2);
  assert.ok(Math.abs(active.reduce((sum, item) => sum + Math.abs(item.normalized_weight), 0) - 1) < 0.002);
  assert.ok(active.every(item => item.learned_weight != null && item.value != null));
  assert.ok(Number.isFinite(coordinated.disagreement));
});

test('combined decision records an explicit zero-stake abstention and settlement', () => {
  const experts = NFL_EXPERTS.map(expert => ({ id: expert.id, observed: expert.id === 'rulebook',
    forecast_residual: expert.id === 'rulebook' ? 1.5 : null,
    missing_reason: expert.id === 'rulebook' ? null : 'missing input' }));
  const coordinator = { ready: true, forecast_residual: 2, disagreement: 1.25,
    authority: 'historical_candidate_only', contributions: [{ id: 'rulebook', learned_weight: 0.2,
      normalized_weight: 1, value: 0.3 }] };
  const trace = expertCouncilTest.combinedDecisionTrace({ market_margin: 3, actual_margin: 7,
    actual_residual: 4 }, experts, coordinator);
  assert.equal(trace.final_prediction.projected_home_margin, 5);
  assert.equal(trace.selection.side, null);
  assert.equal(trace.selection.price, null);
  assert.equal(trace.selection.stake_units, 0);
  assert.equal(trace.settlement.directional_correct, true);
  assert.equal(trace.contributors.find(item => item.id === 'rulebook').normalized_weight, 1);
});

test('coordinator warmup abstentions persist instead of disappearing from the game record', () => {
  const combinedDecision = expertCouncilTest.combinedDecisionTrace({ market_margin: -2,
    actual_margin: 1, actual_residual: 3 }, [], { ready: false, reason: 'warmup' });
  persistWeeklyExpertAudit(999, { season: 2098, week: 1, version: 'test-council', games: [{
    game: { home: 'AAA', away: 'BBB', engine_version: 'test-engine', evidence_cutoff: '2098-W1', actual_residual: 3 },
    evidence_hash: 'warmup-trace', experts: [], coordinator: { ready: false, reason: 'warmup' },
    combined_decision: combinedDecision
  }] });
  const saved = db.prepare(`SELECT observed,forecast_residual,missing_reason,payload_json
    FROM nfl_weekly_expert_examples WHERE audit_run_id=999 AND expert_id='coordinator'`).get();
  assert.equal(saved.observed, 0);
  assert.equal(saved.forecast_residual, null);
  assert.equal(saved.missing_reason, 'warmup');
  assert.equal(JSON.parse(saved.payload_json).decision_trace.selection.stake_units, 0);
});

test('expert coordinator counts a replayed game once across audit runs', () => {
  const base = { season: 2021, week: 5, home: 'ARI', away: 'SF', actual_residual: 4,
    expert_id: 'rulebook', observed: 1, forecast_residual: 2 };
  const games = expertCoordinatorTest.pivotRows([
    { ...base, audit_run_id: 1 }, { ...base, audit_run_id: 2, forecast_residual: 3 }
  ]);
  assert.equal(games.length, 1);
  assert.equal(games[0].experts.get('rulebook'), 3, 'latest ordered audit copy wins without adding another game');
});

test('news latency pairs only preserved quotes around publication and never uses a post-kickoff market', () => {
  const claim = { published_at: '2026-09-01T12:00:00Z' };
  const base = { event_id: 'g1', commence_time: '2026-09-01T20:00:00Z', home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills',
    book: 'book-a', market: 'spreads', side: 'Kansas City Chiefs' };
  const pairs = newsLatencyTest.quoteReaction(claim, [
    { ...base, captured_at: '2026-09-01T11:00:00Z', line: -2.5, price: -110 },
    { ...base, captured_at: '2026-09-01T12:04:00Z', line: -3, price: -112 },
    { ...base, captured_at: '2026-09-01T20:01:00Z', line: -7, price: -200 }
  ], 'kansascitychiefs');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].publication_to_capture_minutes, 4);
  assert.equal(pairs[0].line_move, -0.5);
  assert.equal(pairs[0].reacted, true);
});

test('news latency team matching does not collide on a two-letter abbreviation substring', () => {
  const claim = { published_at: '2026-09-01T12:00:00Z' };
  // "NE" (New England) must not match Minnesota, Tennessee or New Orleans —
  // the bug this alias scheme used to have.
  const decoys = ['Minnesota Vikings', 'Tennessee Titans', 'New Orleans Saints', 'New York Jets', 'New York Giants']
    .map(home => ({ event_id: 'x', commence_time: '2026-09-01T20:00:00Z', home_team: home, away_team: 'Denver Broncos',
      book: 'book-a', market: 'spreads', side: home, captured_at: '2026-09-01T12:04:00Z', line: -3, price: -110 }));
  assert.equal(newsLatencyTest.quoteReaction(claim, decoys, 'newenglandpatriots').length, 0);
  const real = [{ event_id: 'y', commence_time: '2026-09-01T20:00:00Z', home_team: 'New England Patriots',
    away_team: 'Denver Broncos', book: 'book-a', market: 'spreads', side: 'New England Patriots',
    captured_at: '2026-09-01T12:04:00Z', line: -3, price: -110 }];
  assert.equal(newsLatencyTest.quoteReaction(claim, real, 'newenglandpatriots').length, 1);
});

test('postgame truth reads challenges, turnovers and explosive gameplay from the settled tape', () => {
  const base = { period: 4, clock_seconds: 120, offense: 'KC', defense: 'BUF', down: 2, distance: 8,
    yards_to_endzone: 40, play_type: 'pass', yards_gained: 22, is_turnover: 0, is_scoring: 0,
    is_penalty: 0, home_score: 20, away_score: 20, no_huddle: 0, shotgun: 1, text: 'pass for 22 yards' };
  const tape = [base,
    { ...base, play_type: 'interception', yards_gained: 0, is_turnover: 1, text: 'pass intercepted' },
    { ...base, yards_gained: 0, is_scoring: 1, home_score: 27,
      text: 'Kansas City challenged the touchdown ruling. The ruling was REVERSED.' }];
  const truth = postgameTest.summarizePlayByPlay(tape, 'KC', 'BUF');
  assert.equal(truth.teams.KC.explosives, 1);
  assert.equal(truth.teams.KC.turnovers, 1);
  assert.equal(truth.challenges.length, 1);
  assert.equal(truth.challenges_reversed, 1);
  assert.ok(truth.high_leverage_events.length >= 2);
});

test('postgame filtration keeps chaotic finals and quarantines only incomplete evidence', () => {
  const complete = postgameTest.filtration({ game: { home_score: 31, away_score: 28, spread: -2.5 },
    pbp: { scrimmage_plays: 120, rows: 150, teams: { A: { turnovers: 3, explosives: 6 }, B: { turnovers: 2, explosives: 5 } },
      non_offensive_scores: [{}], challenges_reversed: 2 }, teams: [{}, {}], players: [{}], snaps: Array(30).fill({}) });
  assert.equal(complete.core_training_eligible, true);
  assert.equal(complete.sample_weight, 1);
  assert.ok(complete.variance_markers.length >= 3);
  assert.match(complete.rule, /never justify deleting a loss/i);
  const incomplete = postgameTest.filtration({ game: { home_score: 31, away_score: 28, spread: -2.5 },
    pbp: { scrimmage_plays: 0, rows: 0, teams: {}, non_offensive_scores: [], challenges_reversed: 0 },
    teams: [{}], players: [], snaps: [] });
  assert.equal(incomplete.core_training_eligible, false);
  assert.equal(incomplete.sample_weight, 0);
});

test('postgame injury identity separates multi-letter initials and clears documented returns', () => {
  assert.equal(postgameTest.namesMatch('Ca.Heyward', 'Cameron Heyward'), true);
  assert.equal(postgameTest.namesMatch('Ca.Heyward', 'Connor Heyward'), false);
  const base = { period: 2, clock_seconds: 800, offense: 'BAL', defense: 'PIT', down: 1, distance: 10,
    yards_to_endzone: 60, play_type: 'rush', yards_gained: 4, is_turnover: 0, is_scoring: 0,
    is_penalty: 0, home_score: 7, away_score: 7, no_huddle: 0, shotgun: 0 };
  const tape = [
    { ...base, sequence: 10, text: 'PIT-Ca.Heyward was injured during the play.' },
    { ...base, sequence: 20, offense: 'PIT', defense: 'BAL', text: 'run for four yards' },
    { ...base, sequence: 30, text: '** Injury Update: PIT-Ca.Heyward has returned to the game.' }
  ];
  const injuries = postgameTest.inGameInjuryTruth(tape, [
    { team: 'PIT', player: 'Cameron Heyward', position: 'DT', offense_pct: 0, defense_pct: 0.8, st_pct: 0 },
    { team: 'PIT', player: 'Connor Heyward', position: 'TE', offense_pct: 0.3, defense_pct: 0, st_pct: 0.4 }
  ], { players: [{ team: 'PIT', player: 'Co.Heyward', player_id: null, position: 'TE' }] }, 2025, 1, 'PIT', 'BAL');
  assert.equal(injuries.length, 1);
  assert.equal(injuries[0].player, 'Cameron Heyward');
  assert.equal(injuries[0].position, 'DT');
  assert.equal(injuries[0].returned_in_game, true);
  assert.equal(injuries[0].carry_forward.state, 'cleared_in_game');
});

test('postgame injury carry state follows official availability semantics', () => {
  assert.deepEqual(postgameTest.availabilityFromReport({ report_status: 'Out' }),
    { probability: 1, state: 'confirmed_out' });
  assert.deepEqual(postgameTest.availabilityFromReport({ practice_status: 'Full Participation' }),
    { probability: 0.04, state: 'cleared_by_full_practice' });
});

test('fantasy lineup is selected before outcomes are revealed', () => {
  const roster = [
    { id: 1, position: 'RB' },
    { id: 2, position: 'RB' }
  ];
  const expected = new Map([[1, 12], [2, 6]]);
  const realized = new Map([[1, 3], [2, 35]]);
  assert.equal(sim.lineupPoints(roster, ['RB'], realized, expected), 3,
    'the bench explosion must not be inserted after the game');
});

test('seeded simulations are exactly reproducible', () => {
  const a = withRandomSeed(8675309, () => Array.from({ length: 8 }, random));
  const b = withRandomSeed(8675309, () => Array.from({ length: 8 }, random));
  const c = withRandomSeed(42, () => Array.from({ length: 8 }, random));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('weekly ensemble is convex, position-aware, and uses only supplied prior weeks', () => {
  for (const weights of Object.values(WEEKLY_ENSEMBLE_WEIGHTS)) {
    assert.equal(weights.length, WEEKLY_ENSEMBLE_HEADS.length);
    assert.ok(weights.every(weight => weight >= 0 && weight <= 1));
    assert.ok(Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
  }
  const priorWeeks = [8, 12, 20, 4];
  const context = weeklyEnsembleContext({ structural: 14, priorWeeks, position: 'RB' });
  assert.deepEqual(context, {
    structural: 14, season_to_date: 11, last3: 12, last1: 4, median: 12, position: 'RB'
  });
  assert.ok(Math.abs(weeklyEnsemblePrediction(context) - 11.6) < 1e-12);
  assert.equal(weeklyEnsembleContext({ structural: 14, priorWeeks: [], position: 'RB' }), null);
});

test('shared player engine resolves canonical internal and GSIS identities', () => {
  const projection = { player_id: 7, gsis_id: '00-0031234', name: 'Test Player' };
  const engine = new Map([[7, projection]]);
  assert.equal(playerWeekProjection(engine, 7), projection);
  assert.equal(playerWeekProjection(engine, '7'), projection);
  assert.equal(playerWeekProjection(engine, '00-0031234'), projection);
  assert.equal(playerWeekProjection(engine, 'missing'), null);
});

test('joint player simulation obeys one team opportunity budget on every draw', () => {
  const params = overrides => ({
    attempts: 0, carries: 0, targets: 0, dispersion: 10,
    ypa: 7, pass_td_rate: 0.045, int_rate: 0.025,
    ypc: 4.2, rush_td_rate: 0.03, catch_rate: 0.68,
    ypt: 8, rec_td_rate: 0.05, ...overrides
  });
  const shared = { team: 'TST', volume: { team_pass_att: 34, team_rush_att: 27 } };
  const engine = new Map([
    [1, { ...shared, player_id: 1, position: 'QB', params: params({ attempts: 32, carries: 4 }) }],
    [2, { ...shared, player_id: 2, position: 'QB', params: params({ attempts: 2 }) }],
    [3, { ...shared, player_id: 3, position: 'RB', params: params({ carries: 17, targets: 4 }) }],
    [4, { ...shared, player_id: 4, position: 'RB', params: params({ carries: 8, targets: 3 }) }],
    [5, { ...shared, player_id: 5, position: 'WR', params: params({ targets: 9 }) }],
    [6, { ...shared, player_id: 6, position: 'WR', params: params({ targets: 7 }) }]
  ]);
  const samples = sampleTeamWeekEvents(engine, 'TST', { runs: 80, seed: 19 });
  for (let i = 0; i < 80; i++) {
    const draw = [...samples.values()].map(x => x[i]);
    const qbDraw = [samples.get(1)[i], samples.get(2)[i]];
    const attempts = draw.reduce((sum, x) => sum + x.attempts, 0);
    const carries = draw.reduce((sum, x) => sum + x.carries, 0);
    const targets = draw.reduce((sum, x) => sum + x.targets, 0);
    assert.ok(targets <= attempts, `targets ${targets} cannot exceed attempts ${attempts}`);
    assert.ok(attempts >= 0 && carries >= 0);
    assert.equal(qbDraw.filter(x => x.attempts > 0).length, attempts > 0 ? 1 : 0,
      'quarterback participation is selected once per game, not split attempt by attempt');
  }
});

test('fantasy scoring is a pure translation of the shared event expectation', () => {
  const projection = {
    player_id: 1, name: 'Shared State', team: 'TST', position: 'WR',
    params: { attempts: 0, carries: 1, targets: 8, ypa: 0, pass_td_rate: 0,
      int_rate: 0, ypc: 5, rush_td_rate: 0.02, catch_rate: 0.7,
      ypt: 8.5, rec_td_rate: 0.06 }
  };
  const state = playerWeekEventExpectation(projection);
  assert.ok(Math.abs(state.structural_fantasy_points - scoreSim(state.events)) < 1e-12);
});

test('anytime touchdown market excludes passing touchdowns', () => {
  assert.equal(anytimeTdHit({ passTd: 4, rushTd: 0, recTd: 0 }), 0);
  assert.equal(anytimeTdHit({ passTd: 0, rushTd: 1, recTd: 0 }), 1);
  assert.equal(anytimeTdHit({ passTd: 0, rushTd: 0, recTd: 1 }), 1);
});

test('passing diagnostic exactly separates volume and efficiency error', () => {
  const out = decomposePassingError({ predictedAttempts: 34, predictedYpa: 7.2,
    actualAttempts: 29, actualYpa: 8.1 });
  assert.equal(out.exact, true);
  assert.ok(Math.abs(out.total - (34 * 7.2 - 29 * 8.1)) < 1e-9);
});

test('prop CLV capture preserves every bookmaker instead of collapsing to best price', () => {
  const payload = { id: 'event', home_team: 'Home', away_team: 'Away', commence_time: '2026-09-01T00:00:00Z',
    bookmakers: [
      { key: 'book_a', markets: [{ key: 'player_pass_yds', outcomes: [
        { description: 'Q B', name: 'Over', point: 250.5, price: -110 }
      ] }] },
      { key: 'book_b', markets: [{ key: 'player_pass_yds', outcomes: [
        { description: 'Q B', name: 'Over', point: 250.5, price: -105 }
      ] }] }
    ] };
  const quotes = flattenAllProps(payload);
  assert.equal(quotes.length, 2);
  assert.deepEqual(quotes.map(q => q.book), ['book_a', 'book_b']);
});

test('prop no-vig probabilities remove a two-sided book margin', () => {
  const over = noVigPropProbability(-115, -105);
  const under = noVigPropProbability(-105, -115);
  assert.ok(Math.abs(over + under - 1) < 1e-12);
});

test('prop close is the final quote before kickoff and ignores in-game rows', () => {
  const insert = db.prepare(`INSERT INTO nfl_prop_clv
    (captured_at,event_id,book,market,player,side,line,american_price,implied_probability,
     season,week,commence_time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const base = ['PROP_CLOSE', 'book', 'player_pass_yds', 'Test QB', 'Over'];
  insert.run('2026-08-27T10:00:00Z', ...base, 249.5, -110, 0.50, 2026, 1, '2026-08-27T12:00:00Z');
  insert.run('2026-08-27T11:59:00Z', ...base, 254.5, -120, 0.55, 2026, 1, '2026-08-27T12:00:00Z');
  insert.run('2026-08-27T12:01:00Z', ...base, 270.5, -200, 0.70, 2026, 1, '2026-08-27T12:00:00Z');
  finalizeClosingSnapshots('2026-08-27T13:00:00Z');
  const original = db.prepare(`SELECT * FROM nfl_prop_clv
    WHERE event_id='PROP_CLOSE' AND captured_at='2026-08-27T10:00:00Z'`).get();
  const after = db.prepare(`SELECT * FROM nfl_prop_clv
    WHERE event_id='PROP_CLOSE' AND captured_at='2026-08-27T12:01:00Z'`).get();
  assert.equal(original.closing_line, 254.5);
  assert.equal(original.closing_price, -120);
  assert.ok(Math.abs(original.clv_probability - 0.05) < 1e-12);
  assert.equal(after.closing_price, null, 'a quote captured after kickoff is not evidence');
});

test('scheduled prop capture spends only at T-24h and T-1h windows', () => {
  const kickoff = '2026-09-10T17:00:00Z';
  assert.equal(duePropCaptureHorizon(kickoff, [], '2026-09-09T16:00:00Z'), null);
  assert.equal(duePropCaptureHorizon(kickoff, [], '2026-09-09T18:00:00Z'), 24);
  assert.equal(duePropCaptureHorizon(kickoff, ['2026-09-09T18:00:00Z'], '2026-09-10T15:00:00Z'), null);
  assert.equal(duePropCaptureHorizon(kickoff, ['2026-09-09T18:00:00Z'], '2026-09-10T16:15:00Z'), 1);
  assert.equal(duePropCaptureHorizon(kickoff, ['2026-09-09T18:00:00Z', '2026-09-10T16:15:00Z'],
    '2026-09-10T16:30:00Z'), null);
  assert.equal(duePropCaptureHorizon(kickoff, [], '2026-09-10T17:01:00Z'), null);
});

test('candidate registry contains at least twenty shadow-only hypotheses', () => {
  assert.ok(PLAYER_HEADS.length >= 20);
  assert.ok(PLAYER_HEADS.every(head => head.status === 'candidate'));
  assert.equal(new Set(PLAYER_HEADS.map(head => head.id)).size, PLAYER_HEADS.length);
});

test('signal truth registry exposes hundreds of shadow paths without granting authority', () => {
  const catalog = signalQualityCatalog();
  assert.ok(catalog.paths >= 300);
  assert.ok(catalog.layers.length >= 10);
  assert.ok(catalog.component_targets.length >= 12);
  assert.ok(catalog.truth_gates.includes('placebo_or_permutation_passed'));
  const trace = playerSignalTrace({ projection: {
    player_id: 1, name: 'Trace Player', position: 'WR', evidence_games: 12,
    params: { ypa: 0, ypc: 4.2, ypt: 8.1 }, candidate_heads: { a: 1 },
    player_week_engine: { cutoff: '2026-W1' }
  }, eligibility: { state: 'market_plausible_role' }, eventState: {
    volume: { attempts: 0, carries: 2, targets: 7 }
  } });
  assert.equal(trace.candidate_paths_evaluated_by_registry, catalog.paths);
  assert.ok(trace.layers.every(x => x.truth && x.noise_class));
});

test('player-head validation remains sealed unless explicitly opened', () => {
  const result = auditPlayerHeads({
    developmentSeason: 2097, discoverySeason: 2098, validationSeason: 2099,
    openValidation: false, persist: false, minN: 250
  });
  assert.equal(result.validation_opened, false);
  assert.equal(result.validation, null);
  assert.equal(result.production_eligible, false);
});

test('blind audit preregisters a fixed chronological week sequence and honest classification', () => {
  const protocol = blindAuditProtocol();
  assert.equal(protocol.classification, 'historical_algorithmically_blind_replay');
  assert.deepEqual(protocol.seasons, [2021, 2022, 2023, 2024, 2025]);
  assert.deepEqual(protocol.schedule[0], { season: 2021, week: 5 });
  assert.deepEqual(protocol.schedule.at(-1), { season: 2025, week: 18 });
  assert.equal(protocol.schedule.length, 70);
  assert.equal(protocol.expert_ids.length, 12);
  assert.match(protocol.expert_council, /expert-council/);
  assert.ok(protocol.rules.some(x => /2026 forward shadow/i.test(x)));
});

test('blind audit manifest publishes hashes, per-season results and explicit telemetry gaps', () => {
  const spec = blindAuditProtocol();
  spec.seasons = [2024, 2025];
  spec.schedule = [{ season: 2024, week: 5 }, { season: 2025, week: 5 }];
  spec.provenance = { code: { commit: 'abc123' }, data_coverage: {
    game_lines: { rows: 2, hash: 'data-table-hash', scope: 'all_rows' }
  } };
  const weeks = [
    { season: 2024, week: 5, opened_at: '2026-09-01T12:01:00Z', chain_hash: 'chain-1',
      result: { betting: { metrics: { bets: 2, wins: 1, losses: 1, pushes: 0, units: -0.09 } },
        expert_council: { games: [] }, postgame_truth: [] } },
    { season: 2025, week: 5, opened_at: '2026-09-01T12:02:00Z', chain_hash: 'chain-2',
      result: { betting: { metrics: { bets: 1, wins: 1, losses: 0, pushes: 0, units: 0.91 } },
        expert_council: { games: [] }, postgame_truth: [] } }
  ];
  const manifest = blindAuditTest.runManifest({ id: 8, label: 'audit 8', status: 'complete', spec,
    spec_hash: 'spec-hash', code_hash: 'code-hash', data_hash: 'data-hash',
    created_at: '2026-09-01T12:00:00Z', final: { interpretation: 'diagnostic only' } }, weeks);
  assert.equal(manifest.hashes.commit, 'abc123');
  assert.equal(manifest.hashes.final_chain, 'chain-2');
  assert.equal(manifest.results.overall.bets, 3);
  assert.equal(manifest.results.by_season[0].bets, 2);
  assert.equal(manifest.results.by_season[1].units, 0.91);
  assert.equal(manifest.failures.retries.recorded, false);
  assert.equal(manifest.calibration.available, false);
});

test('blind audit freezes canonical NFL players without coupling to fantasy seed churn', () => {
  const before = blindAuditTest.inputDataState();
  const mutationBefore = blindAuditTest.inputMutationState();
  const fantasyOnly = db.prepare(`INSERT INTO players
    (name,position,slot_code,phase,fantasy_relevant)
    VALUES ('Audit Scope Kicker','K','K','special_teams',1)`).run();
  const afterFantasy = blindAuditTest.inputDataState();
  const mutationAfterFantasy = blindAuditTest.inputMutationState(mutationBefore.latest);
  assert.equal(afterFantasy.coverage.players.hash, before.coverage.players.hash,
    'fantasy-only roster maintenance is outside the historical NFL identity snapshot');
  assert.equal(mutationAfterFantasy.latest, mutationBefore.latest,
    'fantasy-only roster maintenance does not wake the NFL audit guard');
  const nflPlayer = db.prepare(`INSERT INTO players (name,position,gsis_id)
    VALUES ('Audit Scope Receiver','WR','audit-scope-gsis')`).run();
  const afterNfl = blindAuditTest.inputDataState();
  const mutationAfterNfl = blindAuditTest.inputMutationState(mutationBefore.latest);
  assert.notEqual(afterNfl.coverage.players.hash, before.coverage.players.hash,
    'a canonical NFL identity change still invalidates the frozen audit input');
  assert.ok(mutationAfterNfl.latest > mutationBefore.latest);
  assert.deepEqual(mutationAfterNfl.changed.map(item => item.table_name), ['players']);
  db.prepare('DELETE FROM players WHERE id IN (?,?)').run(fantasyOnly.lastInsertRowid, nflPlayer.lastInsertRowid);
});

test('adaptive weekly weights cannot leak into the week they were trained through', () => {
  const candidate = {
    QB: [1, 0, 0, 0, 0], RB: [1, 0, 0, 0, 0],
    WR: [1, 0, 0, 0, 0], TE: [1, 0, 0, 0, 0]
  };
  saveWeeklyFit({
    data_hash: 'cutoff-test', through_season: 2025, through_week: 10,
    weights: candidate, sample_size: 500, validation_size: 100,
    candidate_mae: 4.1, champion_mae: 4.2, candidate_spearman: 0.68,
    champion_spearman: 0.67, coverage_80: 0.8, promoted: true
  });
  assert.equal(activeWeeklyWeightSet({ season: 2025, week: 10 }).source, 'frozen');
  assert.equal(activeWeeklyWeightSet({ season: 2025, week: 11 }).source, 'adaptive');
});

test('AI verdict renderer drops invented evidence and never accepts invented prose', () => {
  const facts = [
    { id: 'market.trend', text: 'Market value fell 8.0%.', source: 'test' },
    { id: 'schedule.rank', text: 'Schedule ranks 4/32.', source: 'test' }
  ];
  const out = groundPlayerVerdict({
    verdict: 'BUY', evidence_ids: ['market.trend', 'invented.injury'],
    reasoning: 'A fabricated player is injured.'
  }, facts);
  assert.equal(out.verdict, 'BUY');
  assert.equal(out.reasoning, 'Market value fell 8.0%.');
  assert.deepEqual(out.evidence.map(x => x.id), ['market.trend']);
  assert.equal(out.grounding.unsupported_claims_allowed, false);
});

test('role changepoint requires two sustained games and corroborating snap movement', () => {
  const games = [
    ...[1, 2, 3, 4].map(week => ({ week, position: 'WR', targets: 4, carries: 0 })),
    { week: 5, position: 'WR', targets: 9, carries: 0 },
    { week: 6, position: 'WR', targets: 10, carries: 0 }
  ];
  const confirmed = detectRoleChange(games, [
    ...[1, 2, 3, 4].map(week => ({ week, offense_pct: 0.42 })),
    { week: 5, offense_pct: 0.69 }, { week: 6, offense_pct: 0.73 }
  ], 7);
  assert.equal(confirmed.status, 'confirmed_role_increase');
  assert.equal(confirmed.extra_multiplier_applied, false);
  assert.equal(detectRoleChange(games, games.map(game => ({ week: game.week, offense_pct: 0.42 })), 7), null,
    'box-score spikes without snap confirmation remain noise');
});

test('AI replay refuses to spend before a Claude key is configured', () => {
  assert.throws(() => startAiBlindReplay(), /No Claude API key configured/);
});

test('AI gate v2 enforces one internally consistent stake decision', () => {
  assert.deepEqual(normalizeReview({ action: 'approve', risk_score: 24, stake_multiplier: 1,
    flags: [], reasons: ['Pregame evidence is coherent.'] }), {
    action: 'approve', risk: 'low', risk_score: 24, stake_multiplier: 1,
    flags: [], reasons: ['Pregame evidence is coherent.']
  });
  const inconsistent = normalizeReview({ action: 'approve', risk_score: 62, stake_multiplier: 0.5,
    flags: [], reasons: ['Contradictory fields.'] });
  assert.equal(inconsistent.action, 'abstain');
  assert.equal(inconsistent.stake_multiplier, 0);
  assert.equal(inconsistent.parser_fallback, true);
  const lockedPress = normalizeReview({ action: 'press', risk_score: 10, stake_multiplier: 2,
    flags: [], reasons: ['Strong strictly-prior evidence.'] });
  assert.equal(lockedPress.action, 'abstain');
  const allowedPress = normalizeReview({ action: 'press', risk_score: 10, stake_multiplier: 2,
    flags: [], reasons: ['Strong strictly-prior evidence.'] }, { pressEligible: true, evidenceStrong: true });
  assert.equal(allowedPress.action, 'press');
  assert.equal(allowedPress.stake_multiplier, 2);
});

test('AI learning memory cannot see same-week or future outcomes', () => {
  const insert = db.prepare(`INSERT INTO nfl_ai_replay_reviews
    (run_id,ordinal,season,week,home,away,selection,packet_json,review_json,outcome,units)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const review = action => JSON.stringify({ action, risk: action === 'reduce' ? 'medium' : 'low',
    risk_score: action === 'reduce' ? 50 : 25, stake_multiplier: action === 'reduce' ? 0.5 : 1,
    flags: [], reasons: ['test'] });
  [
    [99, 1, 2023, 18, 'A', 'B', 'A +3', '{}', review('approve'), 'Won', 0.91],
    [99, 2, 2024, 1, 'C', 'D', 'D +3', '{}', review('reduce'), 'Lost', -1],
    [99, 3, 2024, 9, 'E', 'F', 'E +3', '{}', review('approve'), 'Won', 0.91],
    [99, 4, 2024, 10, 'G', 'H', 'H +3', '{}', review('approve'), 'Won', 0.91],
    [99, 5, 2025, 1, 'I', 'J', 'I +3', '{}', review('approve'), 'Won', 0.91]
  ].forEach(args => insert.run(...args));
  const memory = agentLearningMemory(99, 2024, 10);
  assert.equal(memory.sample_size, 3);
  assert.equal(memory.action_performance.approve.n, 2);
  assert.equal(memory.action_performance.reduce.n, 1);
  assert.match(memory.cutoff, /same-week and future outcomes excluded/);
});

test('live and replay policy enforces the same eligibility rules and weekly cap', () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    market: 'spread', matchup: `A${i} at B${i}`, selection: `A${i}`,
    line: 3, american_price: -110, edge_points: 8 - i / 2, disagreement: 3
  }));
  candidates.push({ market: 'spread', matchup: 'low at edge', selection: 'low', line: 2,
    american_price: -110, edge_points: 2.9, disagreement: 2 });
  // This test isolates the shared edge/ranking/cap mechanics. Calibration is
  // separately gated in production and needs real walk-forward evidence.
  const result = applyNflPolicy(candidates, { ...NFL_PRODUCTION_POLICY, requireCalibratedAdvantage: false });
  assert.equal(result.selected.length, 5);
  assert.deepEqual(result.selected.map(x => x.edge_points), [8, 7.5, 7, 6.5, 6]);
  assert.equal(result.decisions.filter(x => x.abstention_reason === 'weekly_capacity').length, 3);
  assert.equal(result.decisions.find(x => x.selection === 'low').abstention_reason, 'edge_below_threshold');

  const unproven = applyNflPolicy([candidates[0]], NFL_PRODUCTION_POLICY);
  assert.equal(unproven.selected.length, 0);
  assert.equal(unproven.decisions[0].abstention_reason, 'calibration_not_proven');
  const proven = applyNflPolicy([{ ...candidates[0], calibration_eligible: true }], NFL_PRODUCTION_POLICY);
  assert.equal(proven.selected.length, 1);
});

test('NFL replay uncertainty resamples weekly clusters deterministically', () => {
  const bets = [
    { season: 2024, week: 1, result: 'Won', units: 0.91 },
    { season: 2024, week: 1, result: 'Lost', units: -1 },
    { season: 2024, week: 2, result: 'Won', units: 1.05 }
  ];
  const a = uncertainty(bets), b = uncertainty(bets);
  assert.deepEqual(a, b);
  assert.equal(a.clusters, 2);
  assert.equal(a.method, 'deterministic weekly-cluster bootstrap');
});

test('weekly decision report charges missed starts and availability failures as regret', () => {
  const projections = new Map([
    [1, { player_id: 1, position: 'QB', ppg: 20 }],
    [2, { player_id: 2, position: 'QB', ppg: 15 }]
  ]);
  const truth = new Map([
    [1, { weeks: new Map([[1, 0]]) }],
    [2, { weeks: new Map([[1, 30]]) }]
  ]);
  const result = weeklyDecisionBacktest(projections, truth, { weeks: 1, starters: { QB: 1 } });
  assert.equal(result.positions.QB.realized_points_per_start, 0);
  assert.equal(result.positions.QB.regret_per_start, 30);
  assert.equal(result.positions.QB.starter_hit_rate, 0);
});

test('ESPN standings before fromWeek are carried into simulations', () => {
  const teams = [{ roster_id: '1' }, { roster_id: '2' }];
  const lg = {
    platform: 'espn',
    payload: JSON.stringify({ schedule: [
      { matchupPeriodId: 1, home: { teamId: 1, totalPoints: 120 }, away: { teamId: 2, totalPoints: 100 } },
      { matchupPeriodId: 2, home: { teamId: 2, totalPoints: 130 }, away: { teamId: 1, totalPoints: 90 } },
      { matchupPeriodId: 3, home: { teamId: 1, totalPoints: 999 }, away: { teamId: 2, totalPoints: 0 } }
    ] })
  };
  const r = sim.initialRecords(lg, teams, 3);
  assert.deepEqual(r.get('1'), { w: 1, pf: 210 });
  assert.deepEqual(r.get('2'), { w: 1, pf: 230 });
});

test('MLB population priors cannot see games after the projection date', () => {
  const ins = db.prepare(`INSERT INTO mlb_batter_games
    (game_pk, player_id, player_name, season, date, team_id, at_bats, hits, doubles, triples, home_runs, total_bases)
    VALUES (?, ?, ?, 2026, ?, 1, ?, ?, 0, 0, ?, ?)`);
  for (let i = 1; i <= 6; i++) ins.run(i, 10, 'Cutoff Hitter', `2026-04-0${i}`, 4, 1, 0, 1);
  const before = projectBatter(10, 2026, '2026-05-01');

  // Extreme future league environment. It must not alter an April projection.
  for (let i = 1; i <= 20; i++) {
    ins.run(100 + i, 99, 'Future Slugger', `2026-09-${String(i).padStart(2, '0')}`, 4, 4, 4, 16);
  }
  const after = projectBatter(10, 2026, '2026-05-01');
  assert.deepEqual(after, before);
});

test('MLB probability distributions are deterministic and preserve projected means', () => {
  const batter = { expected_ab: 4.1, tb_per_ab: 0.43, hit_per_ab: 0.26, hr_per_hit: 0.14, non_hr_bases: 1.32 };
  const a = batterTotalBases(batter), b = batterTotalBases(batter);
  assert.deepEqual(a, b);
  assert.equal(a.mean_tb, +(4.1 * 0.43).toFixed(4));
  assert.ok(a.probabilities['over_0.5'] > a.probabilities['over_1.5']);
  const pitcher = pitcherStrikeouts({ expected_bf: 24, k_per_bf: 0.25 });
  assert.equal(pitcher.mean_k, 6);
  assert.ok(pitcher.probabilities['over_4.5'] > pitcher.probabilities['over_7.5']);
});

test('MLB historical starter lookup never substitutes the completed box score', () => {
  db.prepare(`INSERT INTO mlb_pitcher_games
    (game_pk,player_id,player_name,season,date,team_id,opponent_id,is_home,games_started,strikeouts,innings_pitched,batters_faced,earned_runs)
    VALUES (9001,7001,'Outcome Era Starter',2025,'2025-06-01',77,88,1,1,12,7,25,0)`).run();
  assert.equal(starterFor(77, '2025-06-01'), null,
    'a completed-game starter is unavailable unless a pregame probable snapshot was preserved');
  db.prepare(`INSERT INTO mlb_probable_starters
    (game_pk,team_id,opponent_id,date,pitcher_id,pitcher_name,fetched_at)
    VALUES (9001,77,88,'2025-06-01',7002,'Pregame Probable','2025-05-31T20:00:00Z')`).run();
  assert.equal(starterFor(77, '2025-06-01').player_id, 7002);
});

test('MLB experiment registry rejects overlapping and non-chronological ranges', () => {
  assert.throws(() => createMlbExperiment({
    market: 'nrfi', name: 'invalid chronology', hypothesis: 'must fail',
    discovery: { from: '2025-04-01', through: '2025-06-01' },
    validation: { from: '2025-05-01', through: '2025-07-01' },
    holdout: { from: '2025-08-01', through: '2025-09-01' }
  }), /chronological and non-overlapping/);
});

test('NFL experiment splits reject overlap and non-chronological holdouts', () => {
  assert.throws(() => createExperiment({
    name: 'bad overlap', hypothesis: 'must fail',
    discovery: [2019, 2020], validation: [2020], holdout: [2021], candidate: { minEdge: 4 }
  }), /cannot overlap/);
  assert.throws(() => createExperiment({
    name: 'bad order', hypothesis: 'must fail',
    discovery: [2020], validation: [2022], holdout: [2021], candidate: { minEdge: 4 }
  }), /chronological/);
});

test('NFL experiments pin code, data snapshot, feature coverage, and model version', () => {
  const x = createExperiment({
    name: 'provenance contract', hypothesis: 'metadata stays immutable',
    discovery: [2019], validation: [2020], holdout: [2021], candidate: { minEdge: 4 }
  });
  assert.match(x.spec.provenance.git_commit, /^(unavailable|[a-f0-9]{40})$/);
  assert.match(x.spec.provenance.data_snapshot_hash, /^[a-f0-9]{64}$/);
  assert.equal(typeof x.spec.provenance.feature_coverage.team_week_rows, 'number');
  assert.equal(x.spec.provenance.model_version, `${NFL_PRODUCTION_POLICY.id}@${NFL_PRODUCTION_POLICY.version}`);
});

test('preseason roster prior ranks full depth and only uses earlier licensed grades', () => {
  db.exec(`INSERT INTO nfl_depth
    (season,week,team,gsis_id,player_name,pos_abb,pos_rank,pos_slot,captured) VALUES
    (2099,1,'TST','p1','Starter One','QB',1,'QB1','2099-08-01T00:00:00Z'),
    (2099,1,'TST','p2','Backup Two','QB',2,'QB2','2099-08-01T00:00:00Z'),
    (2099,1,'TST','p3','Wide Three','WR',1,'WR1','2099-08-01T00:00:00Z');
    INSERT INTO nfl_snaps (season,week,player,team,position,offense_snaps,offense_pct)
      VALUES (2099,1,'Starter One','TST','QB',60,1.0);
    INSERT INTO game_lines (season,week,team,opponent,home,spread,total,gameday)
      VALUES (2099,2,'TST','OPP',1,-3,44,'2099-09-10');
    INSERT INTO nfl_rookie_evidence
      (season,player_id,player_name,position,evidence_type,values_json,available_at,captured_at,source,source_ref,verification_state)
      VALUES (2099,1,'Starter One','QB','draft','{"draft_round":1,"draft_pick":1}',
        '2099-04-30T00:00:00Z','2099-04-30T00:00:00Z','unit','unit-roster-cutoff','verified');`);
  importLicensedPffGrades([{ season: 2099, week: 1, team: 'TST', player_id: 'p1',
    player_name: 'Starter One', position: 'QB', overall_grade: 88 }]);
  clearRosterStrengthCache();
  const result = teamRosterStrength(2099, 2, 'TST');
  assert.equal(result.available, true);
  assert.equal(result.players.length, 3);
  const starter = result.players.find(player => player.player === 'Starter One');
  const backup = result.players.find(player => player.player === 'Backup Two');
  assert.equal(starter.licensed_pff_grade, 88);
  assert.ok(starter.rating > backup.rating);
  assert.ok(result.depth_score < result.starter_score);
});

test('historical ensemble weights exclude the season being predicted and all future seasons', () => {
  const insert = db.prepare(`INSERT INTO game_lines
    (season, week, team, opponent, home, spread, total, team_score, opp_score, rest_days)
    VALUES (?, ?, ?, ?, ?, ?, 44, ?, ?, 7)
    ON CONFLICT(season, week,team) DO UPDATE SET
      opponent=excluded.opponent, home=excluded.home, spread=excluded.spread,
      total=excluded.total, team_score=excluded.team_score, opp_score=excluded.opp_score`);
  for (let season = 2015; season <= 2026; season++) {
    for (let week = 1; week <= 18; week++) {
      const home = week % 2 ? 'AAA' : 'BBB', away = home === 'AAA' ? 'BBB' : 'AAA';
      const hs = 20 + ((season + week) % 10), as = 17 + ((season * week) % 9);
      const homeSpread = -(1 + week % 7), total = 40 + week % 10;
      const insertVaried = db.prepare(`UPDATE game_lines SET spread=?, total=? WHERE season=? AND week=? AND team=?`);
      insert.run(season, week, home, away, 1, homeSpread, hs, as);
      insert.run(season, week, away, home, 0, -homeSpread, as, hs);
      insertVaried.run(homeSpread, total, season, week, home);
      insertVaried.run(-homeSpread, total, season, week, away);
    }
  }
  clearEnsembleCache();
  const at2023 = fitEnsemble({ beforeSeason: 2023, beforeWeek: 1 });
  const live = fitEnsemble();
  assert.deepEqual(at2023.weight_cutoff, { season: 2023, week: 1 });
  assert.equal(at2023.evaluated_weeks, 90,
    'weight fitting uses the predeclared 2018-2022 discovery history before the 2023 prediction');
  assert.ok(live.evaluated_weeks > at2023.evaluated_weeks,
    'future outcomes may affect live weights but not a historical prediction');
  const challengers = live.models.filter(model => model.challenger_only);
  assert.equal(challengers.length, 9);
  assert.ok(challengers.every(model => model.margin_weight === 0 && model.total_weight === 0),
    'newly proposed signals must be measured without silently changing the active blend');
  const allInputs = fitEnsemble({ includeChallengers: true });
  const candidateInputs = allInputs.models.filter(model => model.challenger_only);
  assert.equal(allInputs.input_mode, 'all-inputs');
  assert.equal(candidateInputs.length, 9,
    'the candidate unified engine retains every challenger input even when this fixture has no advanced rows');
  assert.ok(Math.abs(allInputs.models.reduce((sum, model) => sum + model.margin_weight, 0) - 1) < 0.001,
    'candidate margin influence remains a normalized convex blend');
  clearEnsembleCache();
  const beforeEphemeral = db.prepare('SELECT COUNT(*) n FROM nfl_ensemble_fit_artifacts').get().n;
  const ephemeral = withEphemeralEnsembleArtifacts(() => fitEnsemble({ beforeSeason: 2023, beforeWeek: 1 }));
  const afterEphemeral = db.prepare('SELECT COUNT(*) n FROM nfl_ensemble_fit_artifacts').get().n;
  assert.deepEqual(ephemeral.weight_cutoff, { season: 2023, week: 1 });
  assert.equal(beforeEphemeral, 0);
  assert.equal(afterEphemeral, 0,
    'sealed audit computation must not read through or mutate the persistent fit ledger');
  const candidateLine = ensembleLine(2026, 1, 'AAA', 'BBB', { includeChallengers: true });
  assert.equal(candidateLine.input_mode, 'all-inputs');
  assert.equal(candidateLine.models.filter(model => model.challenger_only).length, 9);
  const shadowWeek = challengerSignalWeek(2026, 1);
  assert.equal(shadowWeek.version, 'nfl-challenger-signals-v2');
  assert.ok(shadowWeek.games.every(game => game.signals.length === 9));
  const reliability = { version: 'test-reliability-s2026w0', target: { season: 2026, week: 1 },
    trained_through: { season: 2026, week: 0 }, adjusted: ['early_down_eff'],
    signals: [{ signal_id: 'early_down_eff', multiplier: 0.25 }] };
  db.prepare(`INSERT INTO nfl_signal_reliability_artifacts
    (version,target_season,target_week,trained_through_season,trained_through_week,created_at,examples_hash,result_json)
    VALUES (?,2026,1,2026,0,datetime('now'),'test',?)`).run(reliability.version, JSON.stringify(reliability));
  clearEnsembleCache();
  const champion = ensembleLine(2026, 1, 'AAA', 'BBB');
  const adjusted = ensembleLine(2026, 1, 'AAA', 'BBB', { includeChallengers: true });
  const championSignal = champion.models.find(model => model.id === 'early_down_eff');
  const adjustedSignal = adjusted.models.find(model => model.id === 'early_down_eff');
  assert.equal(champion.reliability_controller.mode, 'off');
  assert.equal(championSignal.reliability_multiplier, 1);
  assert.equal(adjusted.reliability_controller.mode, 'candidate_shrink_only');
  assert.equal(adjustedSignal.reliability_multiplier, 0.25);
  assert.equal(adjustedSignal.margin_weight, adjustedSignal.base_margin_weight * 0.25);
  db.prepare('DELETE FROM nfl_signal_reliability_artifacts WHERE version=?').run(reliability.version);
  clearEnsembleCache();
});

test('NFL feature-family ablations reblend the identical frozen model lines', () => {
  const base = ensembleLine(2026, 1, 'AAA', 'BBB');
  const family = ensembleLine(2026, 1, 'AAA', 'BBB', { families: ['Market'] });
  const models = base.models.filter(x => x.family === 'Market' && x.margin != null);
  const weight = models.reduce((s, x) => s + x.margin_weight, 0);
  const expected = weight > 0
    ? models.reduce((s, x) => s + x.margin * x.margin_weight, 0) / weight
    : models.reduce((s, x) => s + x.margin, 0) / models.length;
  assert.ok(Math.abs(family.ensemble.projected_margin - expected) < 0.002);
  assert.deepEqual(family.models.map(x => x.id), models.map(x => x.id));
});

test('game-script coefficients and neutral baseline cannot see beyond the predicted week', () => {
  db.prepare(`INSERT INTO players (id,name,position,gsis_id) VALUES
    (501,'AAA Passer','QB','aaa-qb'),(502,'AAA Runner','RB','aaa-rb'),
    (503,'BBB Passer','QB','bbb-qb'),(504,'BBB Runner','RB','bbb-rb')
    ON CONFLICT(id) DO NOTHING`).run();
  const usage = db.prepare(`INSERT INTO player_week_usage
    (player_id,season,week,team,position,attempts,carries,targets,receptions)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(player_id,season,week) DO NOTHING`);
  for (let season = 2015; season <= 2022; season++) for (let week = 1; week <= 18; week++) {
    usage.run(501, season, week, 'AAA', 'QB', 28 + week % 8, 0, 0, 0);
    usage.run(502, season, week, 'AAA', 'RB', 0, 18 + week % 6, 2, 1);
    usage.run(503, season, week, 'BBB', 'QB', 30 + week % 7, 0, 0, 0);
    usage.run(504, season, week, 'BBB', 'RB', 0, 16 + week % 5, 2, 1);
  }
  clearGameScriptCache();
  const before = gameScriptFor('AAA', 2023, 1);
  assert.deepEqual(before.fitted_through, { season: 2023, week: 1 });

  // Absurd future workloads would radically move a global fit.
  for (let week = 1; week <= 18; week++) {
    usage.run(501, 2024, week, 'AAA', 'QB', 90, 0, 0, 0);
    usage.run(502, 2024, week, 'AAA', 'RB', 0, 2, 0, 0);
  }
  clearGameScriptCache();
  const after = gameScriptFor('AAA', 2023, 1);
  assert.deepEqual(after, before);
});

test('weekly availability respects exact injury and practice designations', () => {
  db.prepare(`INSERT INTO nfl_injuries
    (season,week,gsis_id,team,full_name,position,report_status,practice_status,injury)
    VALUES (2026,4,'aaa-qb','AAA','AAA Passer','QB','Questionable','Did Not Participate','Hamstring'),
           (2026,4,'aaa-rb','AAA','AAA Runner','RB','Out','Did Not Participate','Knee')`).run();
  const a = weeklyAvailability(2026, 4);
  assert.equal(a.get(502).active_probability, 0.01);
  assert.ok(a.get(501).active_probability >= 0.39 && a.get(501).active_probability <= 0.57);
  assert.equal(a.get(501).source, 'weekly injury report + durability prior');
});

test('NFL validation firewall never relabels opened seasons as untouched', () => {
  const firewall = validationFirewall();
  const development = firewall.windows.find(x => x.window_id === 'nfl-dev-2021-2025');
  const forward = firewall.windows.find(x => x.window_id === 'nfl-forward-2026');
  assert.equal(development.state, 'development_opened');
  assert.equal(forward.state, 'forward_holdout');
  assert.match(firewall.canonical_label, /not an untouched profitability test/);
  assert.equal(firewall.untouched_gate_passed, false);
});

test('replacement-value availability is cutoff-safe and remains shadow-only', () => {
  db.prepare(`INSERT INTO nfl_snaps
    (season,week,player,position,team,offense_snaps,offense_pct)
    VALUES (2026,2,'AAA Passer','QB','AAA',60,0.95),
           (2026,5,'AAA Passer','QB','AAA',1,0.01)`).run();
  db.prepare(`INSERT INTO nfl_injuries
    (season,week,gsis_id,team,full_name,position,report_status,practice_status,injury)
    VALUES (2026,4,'shadow-qb','AAA','AAA Passer','QB','Questionable','Did Not Participate','Hamstring'),
           (2026,4,'shadow-rest','AAA','Resting Lineman','T',NULL,'Did Not Participate','Not injury related — resting player')`).run();
  const a = teamPlayerAvailability(2026, 4, 'AAA');
  const qb = a.material_players.find(x => x.player === 'AAA Passer');
  assert.equal(qb.prior_snap_games, 1, 'the target and future weeks must not enter prior participation');
  assert.equal(qb.prior_snap_share, 0.95);
  assert.equal(a.production_eligible, false);
  assert.equal(a.material_players.some(x => x.player === 'Resting Lineman'), false,
    'non-injury rest should not be treated as a material injury shock');
});

test('defensive injuries use defensive snaps and the observed next man up', () => {
  db.prepare(`INSERT INTO nfl_depth
    (season,week,team,gsis_id,player_name,pos_abb,pos_rank,pos_slot,captured)
    VALUES (2026,4,'DDD','ddd-cb1','DDD Corner One','CB',1,'LCB','2026-08-20'),
           (2026,4,'DDD','ddd-cb2','DDD Corner Two','CB',2,'LCB','2026-08-20')`).run();
  db.prepare(`INSERT INTO nfl_snaps
    (season,week,player,position,team,defense_snaps,defense_pct)
    VALUES (2026,2,'DDD Corner One','CB','DDD',62,0.95),
           (2026,2,'DDD Corner Two','CB','DDD',31,0.48)`).run();
  db.prepare(`INSERT INTO nfl_injuries
    (season,week,gsis_id,team,full_name,position,report_status,practice_status,injury)
    VALUES (2026,4,'ddd-cb1','DDD','DDD Corner One','CB','Out','Did Not Participate','Hamstring')`).run();
  db.prepare(`INSERT INTO nfl_pfr_adv (season,week,player_name,kind,team,opponent,stats)
    VALUES (2026,2,'DDD Corner One','def','DDD','EEE',?)`).run(JSON.stringify({
    def_pressures: 4, def_sacks: 1, def_tackles_combined: 7, def_missed_tackles: 0,
    def_yards_allowed_per_tgt: 4.8, def_passer_rating_allowed: 61
  }));
  clearPlayerValueCache();
  const availability = teamPlayerAvailability(2026, 4, 'DDD');
  const corner = availability.material_players.find(player => player.gsis_id === 'ddd-cb1');
  assert.equal(corner.unit, 'defense');
  assert.equal(corner.participation_source, 'defense_snap_share');
  assert.equal(corner.prior_snap_share, 0.95);
  assert.equal(corner.replacement.player, 'DDD Corner Two');
  assert.equal(corner.prior_advanced_games, 1);
  assert.equal(corner.prior_advanced.def_pressures, 4);
  assert.ok(corner.quality_modifier > 1);
  assert.ok(corner.replacement.coverage > 0);
  assert.ok(corner.full_loss_point_value < 0.75 * Math.sqrt(0.95) * 1.15 * corner.quality_modifier,
    'a demonstrated backup must reduce the unreplaced starter loss');
  assert.ok(availability.points_lost_by_unit.defense > 0);
  assert.equal(availability.coverage.defensive_snap_match_rate, 1);
});

test('online neural updates are deterministic, bounded and improve a learnable weekly batch', () => {
  const initial = createNetwork(3, 2026);
  const examples = [
    { input: [1, 0, 0], target: 2 }, { input: [-1, 0, 0], target: -2 },
    { input: [0.8, 0.2, 0], target: 1.7 }, { input: [-0.8, -0.2, 0], target: -1.7 }
  ];
  const before = examples.reduce((sum, example) => sum + Math.abs(predictNetwork(initial, example.input) - example.target), 0);
  const trained = trainBatch(initial, examples, { epochs: 80 });
  const again = trainBatch(createNetwork(3, 2026), examples, { epochs: 80 });
  const after = examples.reduce((sum, example) => sum + Math.abs(predictNetwork(trained, example.input) - example.target), 0);
  assert.ok(after < before * 0.5);
  assert.deepEqual(trained, again, 'the same frozen weekly batch must create the same artifact');
  assert.ok(examples.every(example => Math.abs(predictNetwork(trained, example.input)) <= 7));
  assert.equal(predictNetwork(initial, [1, 0, 0]), 0, 'cold start must exactly defer to the market');
});

test('blind-audit dashboard projection removes heavyweight traces without changing visible counts', () => {
  const projected = blindAuditTest.dashboardWeekResult({
    expert_council: {
      games: [{ game: { home: 'AAA', away: 'BBB' }, heavyweight_trace: 'x'.repeat(10_000) }],
      coordinator: { ready: true, training_games: 12 },
      experts: [{ id: 'pace', name: 'Pace', observed: 1, games: 1, directional_rate: 1 }]
    },
    postgame_truth: [{
      game: { home: 'AAA', away: 'BBB', week: 4, unused: 'large' },
      filtration: { core_training_eligible: true, deep_postgame_eligible: false, variance_markers: ['turnover'] },
      usage_surprises: [{ full_evidence: 'large' }, { full_evidence: 'large' }],
      structural_trends: [{ full_evidence: 'large' }],
      in_game_injuries: [{ returned_in_game: false, breaking_point: true, full_evidence: 'large' }]
    }]
  });
  assert.equal(projected.expert_council.games.length, 1);
  assert.equal(projected.postgame_truth[0].usage_surprises.length, 2);
  assert.equal(projected.postgame_truth[0].structural_trends.length, 1);
  assert.deepEqual(projected.postgame_truth[0].in_game_injuries, [
    { returned_in_game: false, breaking_point: true }
  ]);
  assert.ok(JSON.stringify(projected).length < 1_000, 'dashboard projection must stay compact');
});

test('safe stake sizing stays at zero until every evidence gate passes', () => {
  const blocked = safeStakeFor({ winProb: 0.62, americanOdds: -110, bankroll: 1000,
    calibrationPassed: false, forwardSettled: 20, uncertaintyWidth: 18 });
  assert.equal(blocked.execution_eligible, false);
  assert.equal(blocked.stake, 0);
  assert.ok(blocked.blockers.length >= 2);
  const malformed = safeStakeFor({ winProb: 0.62, americanOdds: -110, bankroll: 1000,
    calibrationPassed: true, forwardSettled: 250, uncertaintyWidth: Number.NaN });
  assert.equal(malformed.execution_eligible, false, 'invalid uncertainty cannot bypass the interval gate');
  const eligible = safeStakeFor({ winProb: 0.62, americanOdds: -110, bankroll: 1000,
    calibrationPassed: true, forwardSettled: 250, uncertaintyWidth: 18, openPortfolioFraction: 0.07 });
  assert.equal(eligible.execution_eligible, true);
  assert.ok(eligible.stake_fraction <= 0.01, 'remaining weekly exposure must cap the stake');
  assert.ok(eligible.portfolio_fraction_after <= 0.08);
});

test('evidence manifests reject timestamps after their immutable cutoff', () => {
  assert.equal(validateEvidenceCutoff({ quote_at: '2026-08-05T12:00:00Z' }, '2026-08-05T12:00:00Z'), true);
  assert.throws(() => validateEvidenceCutoff({ nested: { fetched_at: '2026-08-05T12:00:01Z' } }, '2026-08-05T12:00:00Z'),
    /occurs after the evidence cutoff/);
});

test('evidence manifests are content-addressed and cannot duplicate silently', () => {
  const input = { sport: 'NFL', market: 'spread', modelVersion: 'test-v1', cutoffAt: '2026-08-05T12:00:00Z',
    manifest: { quote_at: '2026-08-05T11:59:00Z', rows: 32 } };
  const a = captureEvidenceManifest(input), b = captureEvidenceManifest(input);
  assert.equal(a.manifest_hash, b.manifest_hash);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM model_evidence_manifests WHERE manifest_hash=?').get(a.manifest_hash).n, 1);
});

test('feature contracts make critical missing inputs abstain and gate audits stay blocked', () => {
  const contracts = featureContracts('MLB');
  assert.ok(contracts.some(x => x.feature_key === 'confirmed_lineup' && x.missing_behavior === 'abstain' && x.leakage_risk === 'critical'));
  const audit = recordGateAudit({ sport: 'MLB', market: 'nrfi', modelVersion: 'test-v1',
    gates: [{ id: 'prices', label: 'Real prices', passed: false, actual: 0, target: '>= 150' }], evidence: { priced: 0 } });
  assert.equal(audit.verdict, 'blocked');
});

test('MLB calibration refuses to fit without forward real-price evidence', () => {
  const result = buildMlbCalibration('pitcher_strikeouts', '2026-08-05');
  assert.equal(result.status, 'insufficient');
  assert.equal(result.gate_passed, false);
  assert.equal(result.sample_size, 0);
});

test('champion registry cannot promote a blocked audit', () => {
  const audit = recordGateAudit({ sport: 'NFL', market: 'spread', modelVersion: 'unsafe-v1',
    gates: [{ id: 'holdout', label: 'Holdout', passed: false, actual: -0.1, target: '> 0' }], evidence: {} });
  assert.throws(() => promoteEligibleAudit(audit.id, 'NFL'), /cannot be promoted/);
});

test('market movement requires preserved multi-timepoint quotes and does not invent a close', () => {
  const insert = db.prepare(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insert.run('2026-09-01T10:00:00Z', 'test-event', '2026-09-08T17:00:00Z', 'AAA', 'BBB', 'book', 'spreads', 'AAA', -3, -110);
  insert.run('2026-09-01T12:00:00Z', 'test-event', '2026-09-08T17:00:00Z', 'AAA', 'BBB', 'book', 'spreads', 'AAA', -3.5, -105);
  const movement = nflMarketMovement();
  const row = movement.moves.find(x => x.event_id === 'test-event');
  assert.equal(movement.available, true);
  assert.equal(row.line_change, -0.5);
  assert.equal(typeof row.projected_close_line, 'number');
  assert.match(row.label, /not a betting signal/);
});

test('evidence daemon status exposes feed gaps without faking price evidence', () => {
  const status = evidenceDaemonStatus();
  assert.equal(status.odds_feed, false);
  assert.ok(status.alerts.some(x => x.code === 'odds_feed_missing'));
});

test('missing MLB boxscore data stays pending until a final participant list confirms a void', () => {
  db.prepare(`INSERT INTO mlb_games (game_pk,season,date,home_team,away_team,status)
    VALUES (991001,2026,'2026-09-01','Home','Away','Final')`).run();
  db.prepare(`INSERT INTO mlb_first_party_picks
    (pick_date,rank,market,selection,player_id,game_pk,side,line,selected_at,tracking_mode)
    VALUES ('2026-09-01',99,'batter_total_bases','Missing Boxscore Player',800001,991001,'Under',1.5,'2026-09-01T10:00:00Z','forward')`).run();
  assert.equal(allPicks().find(x => x.rank === 99)?.status, 'Pending');
  db.prepare(`INSERT INTO mlb_boxscore_sync (game_pk,fetched_at,status) VALUES (991001,'2026-09-02T00:00:00Z','hydrated')`).run();
  assert.equal(allPicks().find(x => x.rank === 99)?.status, 'Void');
});

/* ------------------------------------------------------------------- CLV */

const { recordBet, gradeClosingLineValue, listBets, clvReport, noVigProbability, fairProbabilityOfOurBet } =
  await import('../server/services/nfl-clv.js');

const KICKOFF = '2020-01-01T00:00:00Z';
function stageClose(eventId, market, side, other, line, otherLine, price = -110, otherPrice = -110) {
  const ins = db.prepare(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price)
    VALUES (?,?,?,'HOME','AWAY','dk',?,?,?,?)`);
  ins.run('2019-12-31T23:00:00Z', eventId, KICKOFF, market, side, line, price);
  ins.run('2019-12-31T23:00:00Z', eventId, KICKOFF, market, other, otherLine, otherPrice);
}
function clvFor(eventId, bet) {
  recordBet({ event_id: eventId, commence_time: KICKOFF, home_team: 'HOME', away_team: 'AWAY', ...bet });
  gradeClosingLineValue();
  return listBets({ limit: 500 }).find(b => b.event_id === eventId);
}

test('de-vigging removes the margin and leaves a fair pair of probabilities', () => {
  assert.equal(noVigProbability(-110, -110), 0.5);
  const a = noVigProbability(-200, +170), b = noVigProbability(+170, -200);
  assert.ok(Math.abs(a + b - 1) < 1e-9, 'de-vigged two-way probabilities must sum to exactly one');
});

test('closing line value prices the number taken, not the number the market closed on', () => {
  stageClose('CLV_BEAT', 'spreads', 'HOME', 'AWAY', 1.5, -1.5);
  const beat = clvFor('CLV_BEAT', { market: 'spreads', side: 'HOME', line: 3, price: -110, source: 'unit' });
  assert.equal(beat.clv_points, 1.5);
  assert.ok(beat.clv_pct > 0, 'taking +3 into a +1.5 close is positive value, not negative');

  stageClose('CLV_WORSE', 'spreads', 'HOME', 'AWAY', 3, -3);
  const worse = clvFor('CLV_WORSE', { market: 'spreads', side: 'HOME', line: 1.5, price: -110, source: 'unit' });
  assert.equal(worse.clv_points, -1.5);
  assert.ok(worse.clv_pct < 0);
});

test('betting the closing number at standard juice costs exactly the vig', () => {
  stageClose('CLV_FLAT', 'spreads', 'HOME', 'AWAY', 3, -3);
  const flat = clvFor('CLV_FLAT', { market: 'spreads', side: 'HOME', line: 3, price: -110, source: 'unit' });
  assert.equal(flat.clv_points, 0);
  assert.ok(Math.abs(flat.clv_pct - (-0.0455)) < 0.002,
    `no line value at -110 should score about -4.55%, got ${flat.clv_pct}`);
});

test('a better price on the same number is worth exactly the price difference', () => {
  stageClose('CLV_PRICE', 'spreads', 'HOME', 'AWAY', 3, -3);
  const better = clvFor('CLV_PRICE', { market: 'spreads', side: 'HOME', line: 3, price: -105, source: 'unit' });
  assert.equal(better.clv_points, 0);
  assert.ok(better.clv_pct > -0.03 && better.clv_pct < 0,
    'shopping -110 to -105 recovers part of the vig but does not by itself create edge');
});

test('totals value is symmetric: the over wants a lower number and the under a higher one', () => {
  stageClose('CLV_OVER', 'totals', 'Over', 'Under', 47, 47);
  const over = clvFor('CLV_OVER', { market: 'totals', side: 'Over', line: 44, price: -110, source: 'unit' });
  stageClose('CLV_UNDER', 'totals', 'Under', 'Over', 44, 44);
  const under = clvFor('CLV_UNDER', { market: 'totals', side: 'Under', line: 47, price: -110, source: 'unit' });
  assert.equal(over.clv_points, 3);
  assert.equal(under.clv_points, 3);
  assert.ok(Math.abs(over.clv_pct - under.clv_pct) < 1e-6,
    'three points of the same value must price identically on either side');
});

test('CLV refuses to report a verdict on too few bets', () => {
  const r = clvReport({ source: 'unit' });
  assert.equal(r.available, true);
  assert.match(r.verdict, /Too few graded bets/);
  assert.ok(r.significant === false);
});

test('a bet without a real price is rejected rather than logged unpriceable', () => {
  assert.ok(recordBet({ event_id: 'X', market: 'spreads', side: 'HOME', line: 3 }).error);
  assert.ok(recordBet({ event_id: 'X', market: 'spreads', side: 'HOME', line: 3, price: null }).error);
});

test('the close is the last capture before kickoff, never one taken after it', () => {
  db.prepare(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price)
    VALUES (?,?,?,'HOME','AWAY','dk','spreads',?,?,?)`)
    .run('2019-12-31T23:00:00Z', 'CLV_AFTER', KICKOFF, 'HOME', 6, -110);
  db.prepare(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price)
    VALUES (?,?,?,'HOME','AWAY','dk','spreads',?,?,?)`)
    .run('2019-12-31T23:00:00Z', 'CLV_AFTER', KICKOFF, 'AWAY', -6, -110);
  // An in-game number, which must never be treated as the close.
  db.prepare(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price)
    VALUES (?,?,?,'HOME','AWAY','dk','spreads',?,?,?)`)
    .run('2020-01-01T01:00:00Z', 'CLV_AFTER', KICKOFF, 'HOME', 20, -110);
  const b = clvFor('CLV_AFTER', { market: 'spreads', side: 'HOME', line: 6, price: -110, source: 'unit' });
  assert.equal(b.closing_line, 6, 'a line captured after kickoff must not be used as the close');
});

test('joint simulation reconciliation reaches forecast means without breaking one outcome distribution', () => {
  const margins = [-14, -7, -3, 0, 3, 7, 14, 21];
  const totals = [44, 31, 58, 41, 65, 38, 51, 47];
  const out = reconcileOutcomeWeights(margins, totals, { targetMargin: 5, targetTotal: 49 });
  assert.equal(out.applied, true);
  assert.ok(Math.abs(out.achieved.margin - 5) <= 0.02, JSON.stringify(out));
  assert.ok(Math.abs(out.achieved.total - 49) <= 0.02, JSON.stringify(out));
  assert.ok(out.effective_sample_ratio > 0 && out.effective_sample_ratio <= 1);
  assert.ok(Math.abs(out.weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-9);
});

test('news source firewall verifies primary publishers and quarantines arbitrary domains', () => {
  assert.equal(newsSourceVerification({ source_url: 'https://www.espn.com/nfl/story/_/id/1/x' }).state, 'verified');
  const fake = newsSourceVerification({ source_url: 'https://totally-real-nfl-news.example/player-out' });
  assert.equal(fake.state, 'quarantined');
  assert.match(fake.reason, /not in the verified source registry/);
});

test('unified engine inventory binds authority, data cutoff, and one learning epoch', () => {
  const components = nflEngineComponents(2026, 1);
  assert.ok(components.learning_epoch?.id);
  assert.ok(components.heads.team_spread_total);
  assert.ok(components.capability_authority.restricted_research_pool);
  assert.equal(components.cutoff.predicts_week, 1);
  const plan = nflBackfillPlan({ startSeason: 2024, endSeason: 2025 });
  assert.equal(plan.classification, 'historical_development_only');
  assert.equal(plan.seasons.length, 2);
});

test('learning reset is explicit, reversible by lineage, and deletes no evidence', () => {
  const before = activeLearningEpoch();
  assert.throws(() => startLearningEpoch({ reason: 'test gate failed' }), /confirmed=true/);
  const reset = startLearningEpoch({ reason: 'test preregistered profitability gate failed', confirmed: true });
  assert.equal(reset.prior_epoch.id, before.id);
  assert.equal(reset.active_epoch.parent_epoch_id, before.id);
  assert.equal(reset.deleted_rows, 0);
});

test('restricted ML lab contains uncertainty-aware and regime-aware challengers', () => {
  assert.deepEqual(Object.keys(RISK_MODELS), ['deep_ensemble', 'bayesian_online', 'contextual_moe', 'multitask_encoder']);
  const deep = riskLab.coldState('deep_ensemble', 2);
  const prediction = predictRiskModel('deep_ensemble', deep, { names: ['a', 'b'], values: [1, -1] });
  assert.equal(prediction.residual, 0, 'cold residual must equal the market');
  assert.ok(prediction.uncertainty >= 1);
  const examples = Array.from({ length: 20 }, () => ({ payload: { names: ['a', 'b'], values: [1, -1] }, target: 3 }));
  const trained = trainRiskState('deep_ensemble', deep, examples);
  assert.ok(predictRiskModel('deep_ensemble', trained, examples[0].payload).residual > 1);
});

test('multi-task neural encoder learns masked spread and total heads from one frozen representation', () => {
  const payload = { names: ['signal', 'context'], values: [1, 0.25] };
  const cold = riskLab.coldState('multitask_encoder', payload.values.length);
  const before = predictRiskModel('multitask_encoder', cold, payload);
  assert.equal(before.residual, 0);
  assert.equal(before.total_residual, 0);
  const examples = [
    ...Array.from({ length: 30 }, () => ({ payload, target: 3, total_target: 6 })),
    ...Array.from({ length: 10 }, () => ({ payload, target: 3, total_target: null }))
  ];
  const trained = trainRiskState('multitask_encoder', cold, examples);
  const after = predictRiskModel('multitask_encoder', trained, payload);
  assert.ok(Math.abs(3 - after.residual) < Math.abs(3 - before.residual));
  assert.ok(Math.abs(6 - after.total_residual) < Math.abs(6 - before.total_residual));
  assert.equal(trained.examples_seen, examples.length);
});

test('Bayesian risk challenger adapts online while retaining predictive uncertainty', () => {
  const source = riskLab.coldState('bayesian_online', 2);
  const examples = Array.from({ length: 40 }, () => ({ payload: { names: ['a', 'b'], values: [1, 0.5] }, target: 4 }));
  const trained = trainRiskState('bayesian_online', source, examples);
  const before = predictRiskModel('bayesian_online', source, examples[0].payload);
  const after = predictRiskModel('bayesian_online', trained, examples[0].payload);
  assert.ok(Math.abs(4 - after.residual) < Math.abs(4 - before.residual));
  assert.ok(after.uncertainty > 0);
});

test('contextual mixture learns when a restricted expert is useful', () => {
  const payload = { names: ['market_margin_scaled', 'market_total_scaled', 'ensemble_edge_scaled',
    'model_disagreement_scaled', 'rating_systems_mean_residual', 'roster_margin_adjustment'],
  values: [0.2, 0, 1, 0.3, -1, 0] };
  const source = riskLab.coldState('contextual_moe', payload.values.length);
  const before = predictRiskModel('contextual_moe', source, payload);
  const trained = trainRiskState('contextual_moe', source,
    Array.from({ length: 80 }, () => ({ payload, target: 6 })));
  const after = predictRiskModel('contextual_moe', trained, payload);
  assert.ok(after.residual > before.residual + 1, `${before.residual} -> ${after.residual}`);
  assert.ok(after.detail.weights.some(weight => weight > 0.5));
});

test('cross-season data audit blocks incomplete coverage instead of filling missing inputs with zero', () => {
  const audit = nflDataConsistencyAudit();
  assert.equal(audit.comparable_2021_core, false);
  assert.match(audit.verdict, /not coverage-consistent/);
  assert.ok(audit.guardrails.some(rule => /never converted to numeric zero/.test(rule)));
  assert.deepEqual(audit.seasons, [2021, 2022, 2023, 2024, 2025]);
});

test('signal reliability controller is shrink-only, evidence-gated, and ignores apparent winners', () => {
  const examples = [];
  for (let index = 0; index < 40; index++) {
    examples.push({ signal_id: 'harmful', season: 2026, week: 1 + index % 5,
      signal_residual: 2, actual_residual: -2 });
    examples.push({ signal_id: 'helpful', season: 2026, week: 1 + index % 5,
      signal_residual: 2, actual_residual: 2 });
    if (index < 20) examples.push({ signal_id: 'too_early', season: 2026, week: 1 + index % 5,
      signal_residual: 2, actual_residual: -2 });
  }
  const result = new Map(deriveSignalReliability(examples).map(signal => [signal.signal_id, signal]));
  assert.equal(result.get('harmful').multiplier, 0.25);
  assert.match(result.get('harmful').state, /strong_harm/);
  assert.equal(result.get('helpful').multiplier, 1, 'success cannot auto-increase authority');
  assert.equal(result.get('too_early').multiplier, 1, 'small samples remain neutral');
  assert.equal(result.get('too_early').state, 'warming');
});

test('neural decision calibration learns both cover directions without seeing the target week', () => {
  const examples = Array.from({ length: 240 }, (_, index) => ({
    week: index % 18 + 1, prediction_residual: index % 2 === 0 ? 3 : -3,
    disagreement: 3, home_underdog: false, home_cover: index % 2 === 0
  }));
  const fit = fitNeuralDecisionCalibrator(examples);
  assert.equal(fit.examples, 240);
  const positive = calibratedNeuralProbability(fit, { week: 8, prediction_residual: 3,
    disagreement: 3, home_underdog: false });
  const negative = calibratedNeuralProbability(fit, { week: 8, prediction_residual: -3,
    disagreement: 3, home_underdog: false });
  assert.ok(positive > negative, 'positive residual evidence must raise home-cover probability');
  assert.ok(negative >= 0 && positive <= 1);
});

test('coordinated decision head rejects calibration fitted for a different model', () => {
  const mismatch = calibratedCoverProbability({ season: 2026, marketProbability: 0.5,
    edgePoints: 4, modelVersion: 'definitely-not-the-fitted-model' });
  assert.equal(mismatch.probability, null);
  assert.equal(mismatch.calibration, null);
  const audit = nflCoordinationAudit();
  assert.equal(audit.production_state, 'abstain_no_proven_edge');
  assert.ok(audit.blockers.some(item => item.id === 'cover_calibration'));
  assert.ok(audit.hard_truths.some(item => /registry coordinated version labels/.test(item)));
});
