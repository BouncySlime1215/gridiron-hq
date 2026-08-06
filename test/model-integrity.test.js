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

test('live and replay policy enforces the same eligibility rules and weekly cap', () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    market: 'spread', matchup: `A${i} at B${i}`, selection: `A${i}`,
    line: 3, american_price: -110, edge_points: 8 - i / 2, disagreement: 3
  }));
  candidates.push({ market: 'spread', matchup: 'low at edge', selection: 'low', line: 2,
    american_price: -110, edge_points: 2.9, disagreement: 2 });
  const result = applyNflPolicy(candidates, NFL_PRODUCTION_POLICY);
  assert.equal(result.selected.length, 5);
  assert.deepEqual(result.selected.map(x => x.edge_points), [8, 7.5, 7, 6.5, 6]);
  assert.equal(result.decisions.filter(x => x.abstention_reason === 'weekly_capacity').length, 3);
  assert.equal(result.decisions.find(x => x.selection === 'low').abstention_reason, 'edge_below_threshold');
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
  assert.equal(x.spec.provenance.model_version, 'nfl-spread-v1@1.0.0');
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
