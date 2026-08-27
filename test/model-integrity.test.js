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
const { fitEnsemble, clearEnsembleCache, ensembleLine } = await import('../server/services/nfl-ensemble.js');
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
const { teamPlayerAvailability } = await import('../server/services/nfl-player-value.js');
const { safeStakeFor } = await import('../server/services/staking.js');
const {
  WEEKLY_ENSEMBLE_HEADS, WEEKLY_ENSEMBLE_WEIGHTS,
  weeklyEnsemblePrediction, weeklyEnsembleContext
} = await import('../server/services/weekly-ensemble.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
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
  assert.equal(at2023.evaluated_weeks, 18, 'only the completed 2022 evaluation weeks are eligible');
  assert.ok(live.evaluated_weeks > at2023.evaluated_weeks,
    'future outcomes may affect live weights but not a historical prediction');
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
