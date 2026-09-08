import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-role-scenario-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// Minimal schema this module's read paths touch that no import in the chain
// otherwise creates in a fresh test database (player_week_usage is normally
// created by nflverse.js, which nothing here imports).
db.exec(`
  CREATE TABLE IF NOT EXISTS player_week_usage (
    player_id INTEGER, season INTEGER, week INTEGER, team TEXT, opponent TEXT, position TEXT,
    attempts REAL, carries REAL, targets REAL, receptions REAL, target_share REAL,
    receiving_yards REAL, rushing_yards REAL, passing_yards REAL,
    passing_tds REAL, rushing_tds REAL, receiving_tds REAL, interceptions REAL
  );
  CREATE TABLE IF NOT EXISTS player_week_snaps (
    player_id INTEGER, season INTEGER, week INTEGER, offense_pct REAL
  );
`);

const {
  scanChangepoint, conservedTeamVolume, auditCascadeConservation, buildPlayerScenarios,
  ROLE_SCENARIO_ENGINE_VERSION
} = await import('../server/services/role-scenario-engine.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('scanChangepoint finds an obvious mid-series shift and reports its direction', () => {
  // Eight weeks flat around 0.10 share, then eight weeks flat around 0.35 share.
  const series = [
    0.09, 0.11, 0.10, 0.10, 0.11, 0.09, 0.10, 0.10,
    0.34, 0.36, 0.35, 0.33, 0.36, 0.35, 0.34, 0.35
  ];
  const result = scanChangepoint(series, { minSegment: 3 });
  assert.ok(result, 'expected a result');
  assert.equal(result.split, 8, `expected the split at index 8, got ${result.split}`);
  assert.ok(result.right_mean_share > result.left_mean_share, 'expected an increase');
  assert.ok(result.stat > 5, `expected a large separation statistic, got ${result.stat}`);
});

test('scanChangepoint returns null on too little history', () => {
  assert.equal(scanChangepoint([0.1, 0.2], { minSegment: 3 }), null);
});

test('scanChangepoint on a flat series finds no strong separation anywhere', () => {
  const flat = Array.from({ length: 12 }, (_, i) => 0.2 + (i % 2 === 0 ? 0.01 : -0.01));
  const result = scanChangepoint(flat, { minSegment: 3 });
  assert.ok(result.stat < 5, `expected a small statistic on a flat series, got ${result.stat}`);
});

/** A minimal, fully synthetic player-week-engine-shaped Map for one team. */
function syntheticEngine() {
  const engine = new Map();
  const mk = (id, name, position, { targets = 0, carries = 0, attempts = 0 } = {}) => ({
    player_id: id, name, team: 'AAA', position,
    volume: { team_pass_att: 34, team_rush_att: 27 },
    params: {
      position, targets, carries, attempts, dispersion: 8,
      ypt: 8, catch_rate: 0.65, rec_td_rate: 0.05,
      ypc: 4.3, rush_td_rate: 0.03,
      ypa: 7.1, pass_td_rate: 0.045, int_rate: 0.02
    }
  });
  engine.set(1, mk(1, 'WR Alpha', 'WR', { targets: 9 }));
  engine.set(2, mk(2, 'WR Beta', 'WR', { targets: 4 }));
  engine.set(3, mk(3, 'RB Gamma', 'RB', { targets: 2, carries: 16 }));
  return engine;
}

test('conservedTeamVolume conserves total team targets and carries when a player is scaled down', () => {
  const engine = syntheticEngine();
  const overrides = new Map([[1, 0.2]]); // WR Alpha drops to 20% of his normal role
  const { baseline, scenario, conservation_factors } = conservedTeamVolume(engine, 'AAA', overrides);

  const sum = (map, key) => [...map.values()].reduce((s, p) => s + p.volume[key], 0);
  const baseTargets = sum(baseline, 'targets'), scenarioTargets = sum(scenario, 'targets');
  const baseCarries = sum(baseline, 'carries'), scenarioCarries = sum(scenario, 'carries');

  assert.ok(Math.abs(baseTargets - scenarioTargets) < 1e-6,
    `targets should conserve: baseline=${baseTargets} scenario=${scenarioTargets}`);
  assert.ok(Math.abs(baseCarries - scenarioCarries) < 1e-6,
    `carries should conserve: baseline=${baseCarries} scenario=${scenarioCarries}`);

  // Alpha's own targets should have fallen relative to baseline...
  assert.ok(scenario.get(1).volume.targets < baseline.get(1).volume.targets);
  // ...and Beta (the other eligible receiver) should have picked up the slack.
  assert.ok(scenario.get(2).volume.targets > baseline.get(2).volume.targets,
    'the teammate should absorb the reduced share, not have it vanish');
  assert.ok(conservation_factors.targetFactor > 1, 'the target pool needed to be scaled back up after the naive shrink');
});

test('conservedTeamVolume with a multiplier of 0 removes a player from the target pool entirely, conserved to teammates', () => {
  const engine = syntheticEngine();
  const { baseline, scenario } = conservedTeamVolume(engine, 'AAA', new Map([[1, 0]]));
  assert.ok(scenario.get(1).volume.targets < 1e-6, 'an inactive player should draw ~0 targets');
  const sum = map => [...map.values()].reduce((s, p) => s + p.volume.targets, 0);
  assert.ok(Math.abs(sum(baseline) - sum(scenario)) < 1e-6, 'total targets still conserve at multiplier 0');
});

test('conservedTeamVolume is a no-op when no overrides are given', () => {
  const engine = syntheticEngine();
  const { baseline, scenario } = conservedTeamVolume(engine, 'AAA', new Map());
  for (const [pid, base] of baseline) {
    assert.ok(Math.abs(base.volume.targets - scenario.get(pid).volume.targets) < 1e-6);
  }
});

test('auditCascadeConservation runs against an empty cascade set without crashing', () => {
  const result = auditCascadeConservation({});
  assert.equal(result.version, ROLE_SCENARIO_ENGINE_VERSION);
  assert.equal(result.n_starters_checked, 0);
  assert.equal(result.violations, 0);
});

test('buildPlayerScenarios returns null for a player with no team/params', () => {
  const engine = new Map([[9, { player_id: 9, name: 'Nobody', team: null, params: null }]]);
  const result = buildPlayerScenarios({ engine, season: 2025, week: 5, playerId: 9 });
  assert.equal(result, null);
});

test('buildPlayerScenarios probabilities always sum to 1 and include an inactive scenario', () => {
  const engine = syntheticEngine();
  // No injury/availability fixtures exist in this database, so weeklyAvailability
  // falls back to its own defaults — this checks the scenario set stays well-formed
  // even with a fully sparse database, not just in the happy path.
  const result = buildPlayerScenarios({ engine, season: 2025, week: 5, playerId: 1 });
  assert.ok(result, 'expected a scenario set');
  const total = result.scenarios.reduce((s, x) => s + x.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `probabilities should sum to 1, got ${total}`);
  const inactive = result.scenarios.find(s => s.id === 'inactive');
  assert.ok(inactive, 'expected an inactive scenario');
  assert.equal(inactive.multiplier, 0);
  const full = result.scenarios.find(s => s.id === 'full_role');
  assert.ok(full, 'expected a full-role scenario');
  assert.equal(full.multiplier, 1);
});
