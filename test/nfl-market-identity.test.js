/**
 * u2-market-identity (2026-09-12 sweep, Step 0 item 3).
 *
 * Checked read-only against real production history before writing this fix:
 * 0 of 848 stored `nfl_ensemble_fit_artifacts` (26,288 component-cutoff rows)
 * have ever had a component pass the residual promotion gate -- 6,358 of
 * those rows failed on sample size (residual_n < 250) and 25,528 failed on
 * gain (residual_rmse_gain < 0.03), which between them account for nearly
 * every row -- and all 16 decisions ever written to `nfl_pick_decisions`
 * carry `market_residual` with zero components at nonzero residual weight:
 * 100% market identity in production so far. `spread_edge` was silently 0 at
 * every one of those cutoffs; nothing said so out loud.
 *
 * This file's fixture reproduces the dominant real failure mode honestly --
 * too little history to clear the n>=250 floor -- rather than contriving it,
 * and checks that `is_market_identity` says so in exactly the case it
 * describes. nfl-market-identity-rich.test.js checks the other side: that the
 * flag reads false the moment a component genuinely clears the gate, so
 * neither value is hard-coded.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-market-identity-sparse-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

mock.module('../server/services/nfl-roster-strength.js', { namedExports: { rosterStrengthWeek: () => new Map() } });
mock.module('../server/services/nfl-availability.js', { namedExports: { availabilityDeficit: () => new Map() } });
mock.module('../server/services/nfl-pbp.js', { namedExports: { teamWeeks: () => [] } });
mock.module('../server/services/nfl-player-value.js', { namedExports: { gamePlayerAvailability: () => null } });
mock.module('../server/services/nfl-engine-registry.js', { namedExports: { nflEngineVersionFor: () => 'fixture-engine' } });
mock.module('../server/services/nfl-signal-reliability.js', { namedExports: {
  signalReliabilityFor: () => ({ version: 'fixture', multipliers: {}, adjusted: [] })
} });

// nfl-ensemble.js refuses to fit at all under 200 total games (`games()`,
// which itself only ever looks at season >= MIN_SEASON = 2015) and under 100
// games of any-era history (`hist.length`), so this fixture pads with games
// from 2015-2016 purely to clear those two floors. Those two seasons are
// excluded from both the raw-weight window (WEIGHT_FIT_FROM = 2018) and the
// residual window (MIN_SEASON + 2 = 2017) by the service's own filters, so
// they cannot help any component pass the gate — only the real, in-window
// games below can, and there are far too few of those (24, well under the
// n>=250 floor) for that to happen. This is the single most common real
// failure mode measured above (6,358 of 26,288 stored component-cutoff rows
// failed on sample size alone).
const padTeams = ['KC', 'BAL', 'BUF', 'MIA', 'DAL', 'PHI', 'SF', 'SEA', 'NYJ', 'NE', 'DEN', 'LAC'];
for (let season = 2015; season <= 2016; season++) {
  for (let week = 1; week <= 17; week++) {
    for (let pair = 0; pair < 6; pair++) {
      run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
        VALUES (?,?,?,?,1,-2,44,24,20)`, season, week, padTeams[pair * 2], padTeams[pair * 2 + 1]);
    }
  }
}
for (let season = 2021; season <= 2023; season++) {
  for (let week = 1; week <= 4; week++) {
    run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
      VALUES (?,?,'KC','BAL',1,-2,44,24,20)`, season, week);
    run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
      VALUES (?,?,'BUF','MIA',1,-3,44,27,17)`, season, week);
  }
}
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total) VALUES (2024,1,'KC','BAL',1,-2,44)`);

const { fitEnsemble, ensembleLine } = await import('../server/services/nfl-ensemble.js');
const fitOptions = { beforeSeason: 2024, beforeWeek: 1 };

test('sparse history: nothing can clear the residual gate, and the served line is honestly flagged as market identity', () => {
  const fit = fitEnsemble(fitOptions);
  assert.equal(fit.residual_gate_pass_count, 0, 'fixture must have too little history for any component to pass');
  assert.equal(fit.zero_residual_components_at_cutoff, true);

  const result = ensembleLine(2024, 1, 'KC', 'BAL', { includeEvidence: false, blendMode: 'market_residual' });
  assert.equal(result.ensemble.is_market_identity, true);
  assert.equal(result.ensemble.spread_edge, 0, 'market identity means the served line IS the market by arithmetic');
  assert.equal(result.ensemble.residual_models_contributing, 0);
  assert.equal(result.ensemble.projected_spread, result.ensemble.market_spread);
});

test('raw blend mode never reports market identity, even with the same zero-signal history', () => {
  const result = ensembleLine(2024, 1, 'KC', 'BAL', { includeEvidence: false, blendMode: 'raw' });
  assert.equal(result.ensemble.is_market_identity, false);
});

test('no market line means no market to be identical to, regardless of the gate', () => {
  // No game_lines row exists for this matchup: home_spread (and so
  // marketMargin) is null, so the forecast cannot BE "the market line" —
  // there is no market line here for it to be.
  const result = ensembleLine(2024, 1, 'ZZ', 'YY', { includeEvidence: false, blendMode: 'market_residual' });
  assert.equal(result.error, undefined);
  assert.equal(result.ensemble.market_spread, null);
  assert.equal(result.ensemble.is_market_identity, false);
});
