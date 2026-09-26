/**
 * INT-163-1 (after #163). test/scoring-call-sites.test.js proves the model,
 * simulate and trade-impact routes plus assetUniverse hand scoringFor's real
 * league weights on. Two more production callers of scoringFor were never
 * exercised by any test:
 *
 *   - trade-engine.js's myPlayoffOdds (~:1420-1421) hands scoringFor(lg) to
 *     the horizon season simulation that backs every trade's playoff-odds
 *     split. A call site that swapped in a default bucket, or hard-coded a
 *     `{ slot }`, would pass every existing suite.
 *   - scripts/weekly-construction-grade.mjs's consumerParity (:350) checks
 *     scoringFor(SYNTHETIC_PPR_LEAGUE) against the PPR bucket at runtime, but
 *     nothing asserts that check itself ever runs or that it is checking the
 *     real function.
 *
 * Same style as scoring-call-sites.test.js: a fixture league that pays
 * different, deliberately non-default weights, captured at the call site.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-scoring-call-site-followups-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// trade-engine.js myPlayoffOdds -> simulateSeason's `scoring` option
// ---------------------------------------------------------------------------

test('myPlayoffOdds (the league world, ONE-NUMBER-FIX) hands the world build the league\'s real scoring, not a default', async () => {
  const seen = [];
  mock.module('../server/services/season-sim.js', {
    namedExports: {
      __test: {},
      simulateSeason: (_lg, opts = {}) => { seen.push(opts.scoring); return { teams: [], runs: opts.runs, from_week: opts.fromWeek }; },
      simStartWeek: () => 1,
      tradeImpact: () => ({ ok: true }),
      // EA-07 (league-world.js, trade-engine.js) imports these; the one world is off here.
      worldPoolFor: () => null, rosBasisFlag: () => ({ on: false, preview: false }),
      // myPlayoffOdds reads the league world (league-world.js), which is built here.
      tradeImpactWorld: (_lg, opts = {}) => { seen.push(opts.scoring); return { fail: { error: 'not simulated in this test' } }; }
    }
  });
  const { myPlayoffOdds } = await import('../server/services/trade-engine.js');

  // Rushing yards pay 0.3, receiving yards pay 0.2 — different on purpose, and
  // different from the PPR default (0.1/0.1) so a swapped-in default bucket
  // is visible.
  const scoringItems = [
    { statId: 3, points: 0.04 }, { statId: 4, points: 4 }, { statId: 20, points: -2 },
    // statId 24 also carries a D/ST-slot override, so a call site that
    // hard-coded `{ slot: 16 }` would read 0.9 instead of the base 0.3.
    { statId: 24, points: 0.3, pointsOverrides: { 16: 0.9 } }, { statId: 25, points: 6 },
    { statId: 42, points: 0.2 }, { statId: 43, points: 6 },
    { statId: 53, points: 1 }, { statId: 72, points: -2 }
  ];
  const payload = JSON.stringify({ settings: { scoringSettings: { scoringItems } }, teams: [] });
  run(`INSERT INTO leagues (platform, league_id, season, name, ppr, payload, my_team_id)
       VALUES ('espn','playoff-odds-league',2026,'Playoff Odds League',1,?,'1')`, payload);
  const lg = row(`SELECT * FROM leagues WHERE league_id = 'playoff-odds-league'`);

  myPlayoffOdds(lg, '1');
  assert.equal(seen.length, 1, 'the league world must have been built for myPlayoffOdds');
  assert.equal(seen[0].rush_yd, 0.3, 'rush_yd must come from this league\'s own statId 24, not the PPR default (0.1) and not the slot-16 override (0.9)');
  assert.equal(seen[0].rec_yd, 0.2, 'rec_yd must come from this league\'s own statId 42, not the PPR default (0.1)');
});

// ---------------------------------------------------------------------------
// scripts/weekly-construction-grade.mjs consumerParity's scoringFor check
// ---------------------------------------------------------------------------

test('consumerParity (weekly-construction-grade.mjs:350) calls the real scoringFor on the synthetic PPR league', async () => {
  const seen = [];
  mock.module('../server/services/scoring.js', {
    namedExports: {
      PPR: { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6, pass_yd: 0.04, pass_td: 4, pass_int: -2, fumble_lost: -2, first_down: 0 },
      HALF_PPR: {}, STANDARD: {},
      scoringFor: lg => { seen.push(lg); return { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6, pass_yd: 0.04, pass_td: 4, pass_int: -2, fumble_lost: -2, first_down: 0 }; },
      scoreLine: () => 0, scoreEspnStats: () => 0, ESPN_DST_SLOT: 16
    }
  });
  mock.module('../server/services/trade-engine.js', {
    namedExports: {
      assetUniverse: () => new Map(), // empty universe: the loop body never runs
      tradeWeekContext: () => ({ season: 2026, week: 3 })
    }
  });
  mock.module('../server/services/format.js', {
    namedExports: { deriveFormat: () => ({ formatKey: 'rd_1qb_ppr1' }) }
  });
  mock.module('../server/services/contingency.js', {
    namedExports: { weeklyAvailability: () => new Map() }
  });

  const mod = await import('../scripts/weekly-construction-grade.mjs');
  assert.equal(typeof mod.consumerParity, 'function',
    'consumerParity must be exported so its scoringFor call site can be captured directly, ' +
    'the way test/scoring-call-sites.test.js captures buildProjections/simulateSeason/tradeImpact');

  const logged = [];
  const result = await mod.consumerParity({
    lib: { SKILL_POSITIONS: new Set(), constructArms: () => ({}), consumerDecomposition: () => ({}), summarizeConsumerParity: () => ({}) },
    PPR: { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6, pass_yd: 0.04, pass_td: 4, pass_int: -2, fumble_lost: -2, first_down: 0 },
    buildPlayerWeekEngine: () => new Map(),
    activeFantasyCoordinatorFit: () => ({ ready: true }),
    startSitWeekPoints: () => ({ week_points: 0 }),
    log: msg => logged.push(msg)
  });

  assert.equal(seen.length, 1, 'the real scoringFor export must have been called exactly once');
  assert.equal(seen[0].platform, 'sleeper');
  assert.equal(seen[0].id, 0, 'consumerParity must call scoringFor on SYNTHETIC_PPR_LEAGUE, not a leagues-table row');
  assert.equal(result.league, 'synthetic 12-team PPR (no leagues row read)');
});
