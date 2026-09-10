import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ensemble-authority-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, dbPath, run, rows } = await import('../server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH);
await (await import('../server/db/migrate.js')).runMigrations();
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Synthetic prior seasons with a deliberately strong roster challenger. Only
// external feature producers are substituted; fitting, caches, model formulas,
// family selection, blending and predictive distributions run unchanged.
const teams = ['KC', 'BAL', 'BUF', 'MIA', 'DAL', 'PHI', 'SF', 'SEA'];
let targetRosterScore = 12;
mock.module('../server/services/nfl-roster-strength.js', { namedExports: {
  rosterStrengthWeek: (season) => new Map(teams.map((team, i) => [team,
    { available: true, roster_score: season === 2024 && i === 0 ? targetRosterScore : (4 - i) * 12 }]))
} });
mock.module('../server/services/nfl-availability.js', { namedExports: { availabilityDeficit: () => new Map() } });
mock.module('../server/services/nfl-pbp.js', { namedExports: { teamWeeks: () => [] } });
mock.module('../server/services/nfl-player-value.js', { namedExports: { gamePlayerAvailability: () => null } });
mock.module('../server/services/nfl-engine-registry.js', { namedExports: { nflEngineVersionFor: () => 'fixture-engine' } });
mock.module('../server/services/nfl-signal-reliability.js', { namedExports: {
  signalReliabilityFor: () => ({ version: 'fixture', multipliers: {}, adjusted: [] })
} });
// Weeks run 1-36 (double a real NFL season) purely to give the residual-skill
// gate's chronological fit/score split (M05 fix, nfl-ensemble.js) enough
// out-of-fold games in its scored (later 30%) block to clear its 250-game
// floor -- the gate now genuinely holds out data rather than grading on the
// same rows it fit on, so this synthetic fixture needs proportionally more
// history than the old same-rows version required to prove the same point
// (a deliberately overwhelming challenger signal DOES clear the gate).
for (let season = 2015; season <= 2023; season++) {
  for (let week = 1; week <= 36; week++) {
    const order = teams.map((_, i) => (i + week) % teams.length);
    for (let pair = 0; pair < 4; pair++) {
      const h = order[pair], a = order[7 - pair];
      const margin = 2 + Math.round((a - h) * 3.84) + ((week + season) % 3 - 1);
      run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
        VALUES (?,?,?,?,1,-2,60,?,30)`, season, week, teams[h], teams[a], 30 + margin);
    }
  }
}
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total) VALUES (2024,1,'KC','BAL',1,-2,60)`);
const { fitEnsemble, ensembleLine, invalidateEnsembleCaches, modelCatalog } = await import('../server/services/nfl-ensemble.js');
const fitOptions = { beforeSeason: 2024, beforeWeek: 1 };
const line = options => ensembleLine(2024, 1, 'KC', 'BAL', { includeEvidence: false, blendMode: 'market_residual', ...options });

test('strong challenger diagnostics remain visible but cannot enter champion weight normalization', () => {
  const candidate = fitEnsemble({ ...fitOptions, includeChallengers: true });
  const roster = candidate.models.find(m => m.id === 'roster_strength');
  assert.ok(roster.residual_weight > 0, JSON.stringify(roster));
  const champion = fitEnsemble(fitOptions);
  const excluded = champion.models.find(m => m.id === 'roster_strength');
  assert.equal(excluded.residual_diagnostic_passed, true);
  for (const m of champion.models.filter(m => m.challenger_only)) {
    assert.equal(m.residual_gate_passed, false);
    assert.equal(m.residual_weight, 0);
    assert.equal(m.margin_weight, 0);
    assert.equal(m.total_weight, 0);
  }
  assert.ok(Math.abs(champion.models.reduce((s, m) => s + m.residual_weight, 0) - 1) < 0.002);
});

test('v7 persisted weights cannot be reused after the authority repair', () => {
  const artifact = rows('SELECT * FROM nfl_ensemble_fit_artifacts WHERE artifact_key LIKE ?', '%champion-inputs%')[0];
  // Codex corrections C04 and C07 are both methodology changes, so the fit
  // version moved to v10. An artifact fitted under any earlier version
  // describes a different estimator and must not be reusable, which is exactly
  // what this test checks -- only the version string it checks against moves.
  assert.match(artifact.model_version, /^nfl-ensemble-fit-v10-/);
  const poisoned = JSON.parse(artifact.result_json);
  poisoned.models.forEach(m => { m.residual_weight = m.challenger_only ? 1 : 0; });
  run('UPDATE nfl_ensemble_fit_artifacts SET artifact_key=?, model_version=?, result_json=? WHERE artifact_key=?',
    artifact.artifact_key.replace('v10-aligned-opponent-window-week-split', 'v8-challenger-authority'),
    'nfl-ensemble-fit-v8-challenger-authority', JSON.stringify(poisoned), artifact.artifact_key);
  invalidateEnsembleCaches();
  assert.equal(fitEnsemble(fitOptions).models.find(m => m.id === 'roster_strength').residual_weight, 0);
});

test('serving refuses excluded challenger authority even if a loaded artifact has a nonzero weight', () => {
  const fit = fitEnsemble(fitOptions);
  const roster = fit.models.find(m => m.id === 'roster_strength');
  const saved = { ...roster };
  roster.residual_weight = 100; roster.residual_slope = 10;
  const forecast = line();
  const allowed = forecast.models.filter(m => !m.challenger_only && m.margin != null && m.residual_weight > 0 && m.residual_slope != null);
  const sum = allowed.reduce((s, m) => s + m.residual_weight, 0);
  const expected = 2 + allowed.reduce((s, m) => s + m.residual_weight * m.residual_slope * (m.margin - 2), 0) / sum;
  assert.equal(forecast.ensemble.projected_margin, +expected.toFixed(3));
  assert.equal(forecast.ensemble.residual_models_contributing, allowed.length);
  Object.assign(roster, saved);
  invalidateEnsembleCaches();
});

test('changing an excluded challenger cannot change champion forecast, confidence or distribution', () => {
  const reference = line().ensemble;
  const referenceShadow = line().models.find(m => m.id === 'roster_strength').margin;
  fc.assert(fc.property(fc.integer({ min: -100000, max: 100000 }), score => {
    targetRosterScore = score;
    invalidateEnsembleCaches();
    assert.deepEqual(line().ensemble, reference);
  }), { seed: 9021026, numRuns: 40 });
  assert.notEqual(line().models.find(m => m.id === 'roster_strength').margin, referenceShadow);
  targetRosterScore = 12; invalidateEnsembleCaches();
});

test('explicit candidate mode can hear the roster challenger, while champion roster-only falls back to market', () => {
  const options = { families: ['Roster availability'], includeChallengers: true };
  const a = line(options).ensemble;
  targetRosterScore = 90; invalidateEnsembleCaches();
  const b = line(options).ensemble;
  assert.notEqual(a.projected_margin, b.projected_margin);
  assert.equal(b.residual_models_contributing, 1);
  assert.equal(line({ families: ['Roster availability'] }).ensemble.projected_margin, 2);
  assert.equal(line({ families: ['Roster availability'] }).ensemble.residual_models_contributing, 0);
  targetRosterScore = 12; invalidateEnsembleCaches();
});

test('family ablations match equivalent model exclusions including distribution, for both blend modes', () => {
  const catalog = modelCatalog().models;
  for (const blendMode of ['raw', 'market_residual']) {
    for (const includeChallengers of [false, true]) {
      for (const family of ['Market', 'Rating systems', 'Roster availability']) {
        const a = line({ blendMode, includeChallengers, families: [family] });
        const b = line({ blendMode, includeChallengers,
          excludeModels: catalog.filter(m => m.family !== family).map(m => m.id) });
        assert.deepEqual(a, b, `${blendMode}/${includeChallengers}/${family}`);
      }
    }
  }
});

test('family and full-model caches cannot contaminate one another', () => {
  const full = line();
  const market = line({ families: ['Market'] });
  assert.ok(market.models.every(m => m.family === 'Market'));
  assert.ok(full.models.length > market.models.length);
  assert.deepEqual(line(), full);
  assert.deepEqual(line({ families: ['Market', 'Market'] }), market);
  assert.equal(line({ blendMode: 'unsupported', families: ['Market'] }).error, 'unsupported ensemble blend mode');
});
