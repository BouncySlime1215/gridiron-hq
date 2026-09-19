/**
 * `espn_player_market` had a writer nobody called (2026-09-19).
 *
 * `syncEspnMarket` in server/services/espn-market.js is the only code that
 * writes that table, and grep found no caller at all — no route, no script, no
 * scheduler entry. Four surfaces read it directly: routes/aggregates.js on the
 * fantasy board, preseason-model.js, manager-archetypes.js and
 * consensus-weights.js. Each has been serving whatever the last manual run
 * left behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-market-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db } = await import('../server/db/index.js');
const scheduler = await import('../server/services/scheduler.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

function addLeague({ platform, leagueId, season, name }) {
  db.prepare('INSERT INTO leagues (platform, league_id, season, name) VALUES (?,?,?,?)')
    .run(platform, leagueId, season, name);
}

test('the market feed is on a timer at all', () => {
  // The whole defect: a writer with no caller. If this entry goes away the
  // four reading surfaces go stale in silence, which is exactly how it sat.
  assert.ok(scheduler.JOBS.espn_market, 'espn_player_market needs a scheduled writer');
  assert.equal(scheduler.JOBS.espn_market.tier, 'growth');
  assert.equal(scheduler.JOBS.espn_market.maxAgeMinutes, 12 * 60);
});

test('it runs off the request thread', () => {
  // kona_player_info is the largest ESPN payload the app fetches (17.6 MB
  // measured before the 400-player filter). node:sqlite is synchronous, so
  // parsing that inline is an outage, not a slow job.
  assert.equal(scheduler.JOBS.espn_market.offThread, true);
});

test('with no ESPN league connected it skips rather than throwing', async () => {
  db.exec('DELETE FROM leagues');
  addLeague({ platform: 'sleeper', leagueId: 's1', season: 2026, name: 'Sleeper only' });

  const result = await scheduler.JOBS.espn_market.run();
  assert.equal(result.skipped, true);
  assert.match(result.reason, /no ESPN league/);
});

test('it fetches for exactly one league, the newest ESPN season', async (t) => {
  // The table's upsert is ON CONFLICT(espn_id) — one global row per player,
  // not one per league — and season_proj/week1_proj are appliedTotal in the
  // fetching league's own scoring. A loop over every league would leave
  // whichever ran last in the table and make the column mean something
  // different each pass.
  db.exec('DELETE FROM leagues');
  addLeague({ platform: 'espn', leagueId: 'e-old', season: 2025, name: 'Last year' });
  addLeague({ platform: 'espn', leagueId: 'e-new', season: 2026, name: 'This year' });
  addLeague({ platform: 'sleeper', leagueId: 's1', season: 2026, name: 'Sleeper' });
  const current = db.prepare(`SELECT id FROM leagues WHERE league_id = 'e-new'`).get();

  const calls = [];
  t.mock.module('../server/services/espn-market.js', {
    namedExports: {
      syncEspnMarket: async (leagueRowId) => { calls.push(leagueRowId); return { synced: 300 }; }
    }
  });

  const result = await scheduler.JOBS.espn_market.run();

  assert.deepEqual(calls, [current.id], 'one call, for the current-season ESPN league');
  assert.equal(result.synced, 300);
  assert.equal(result.league, 'This year');
  assert.equal(result.season, 2026);
});
