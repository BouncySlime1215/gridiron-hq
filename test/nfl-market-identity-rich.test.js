/**
 * u2-market-identity (2026-09-12 sweep, Step 0 item 3) — the other side of the
 * check in nfl-market-identity.test.js.
 *
 * That file proves `is_market_identity` reads true in the dominant real
 * failure mode (too little history). This file proves the flag is not simply
 * hard-coded true: reusing the large, structurally correlated dataset from
 * nfl-ensemble-authority.test.js — where several components genuinely clear
 * the residual gate — `is_market_identity` must read false, `spread_edge`
 * must be nonzero, and `residual_models_contributing` must be positive.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-market-identity-rich-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const teams = ['KC', 'BAL', 'BUF', 'MIA', 'DAL', 'PHI', 'SF', 'SEA'];
mock.module('../server/services/nfl-roster-strength.js', { namedExports: { rosterStrengthWeek: () => new Map() } });
mock.module('../server/services/nfl-availability.js', { namedExports: { availabilityDeficit: () => new Map() } });
mock.module('../server/services/nfl-pbp.js', { namedExports: { teamWeeks: () => [] } });
mock.module('../server/services/nfl-player-value.js', { namedExports: { gamePlayerAvailability: () => null } });
mock.module('../server/services/nfl-engine-registry.js', { namedExports: { nflEngineVersionFor: () => 'fixture-engine' } });
mock.module('../server/services/nfl-signal-reliability.js', { namedExports: {
  signalReliabilityFor: () => ({ version: 'fixture', multipliers: {}, adjusted: [] })
} });

// Margin is a near-deterministic function of team strength while the market
// spread is held flat at -2, so several rating-based components genuinely
// explain the market's residual and clear the gate — the fixture
// nfl-ensemble-authority.test.js uses to prove the opposite property
// (challenger authority). Here it proves `is_market_identity` is not just
// always true: with real signal in the fit, it must read false.
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

const { fitEnsemble, ensembleLine } = await import('../server/services/nfl-ensemble.js');
const fitOptions = { beforeSeason: 2024, beforeWeek: 1 };

test('rich history where components DO clear the gate: is_market_identity reads false, not hard-coded', () => {
  const fit = fitEnsemble(fitOptions);
  assert.ok(fit.residual_gate_pass_count > 0, 'fixture must reproduce at least one real passing component');
  assert.equal(fit.zero_residual_components_at_cutoff, false);

  const result = ensembleLine(2024, 1, 'KC', 'BAL', { includeEvidence: false, blendMode: 'market_residual' });
  assert.equal(result.ensemble.is_market_identity, false);
  assert.ok(result.ensemble.residual_models_contributing > 0);
  assert.notEqual(result.ensemble.spread_edge, 0);

  // raw mode never falls back to the market by construction, so it is always
  // reported as false — even here, where market_residual is not.
  const raw = ensembleLine(2024, 1, 'KC', 'BAL', { includeEvidence: false, blendMode: 'raw' });
  assert.equal(raw.ensemble.is_market_identity, false);
});
