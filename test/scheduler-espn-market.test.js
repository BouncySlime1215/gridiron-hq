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

process.env.NFL_SEASON = '2026';

function addLeague({ platform, leagueId, season, name, espnS2 = null, swid = null }) {
  db.prepare('INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid) VALUES (?,?,?,?,?,?)')
    .run(platform, leagueId, season, name, espnS2, swid);
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

function mockSync(t, calls) {
  t.mock.module('../server/services/espn-market.js', {
    namedExports: {
      syncEspnMarket: async (leagueRowId, options) => { calls.push([leagueRowId, options]); return { synced: 300 }; }
    }
  });
}

test('it fetches for exactly one league, the newest ESPN season', async (t) => {
  // espn_id is the table's PRIMARY KEY (core-and-fantasy.js:595), so there is
  // one global row per player rather than one per league. A loop would leave
  // whichever league ran last in the table.
  db.exec('DELETE FROM leagues');
  addLeague({ platform: 'espn', leagueId: 'e-old', season: 2025, name: 'Last year' });
  addLeague({ platform: 'espn', leagueId: 'e-new', season: 2026, name: 'This year' });
  addLeague({ platform: 'sleeper', leagueId: 's1', season: 2026, name: 'Sleeper' });
  const current = db.prepare(`SELECT id FROM leagues WHERE league_id = 'e-new'`).get();

  const calls = [];
  mockSync(t, calls);
  const result = await scheduler.JOBS.espn_market.run();

  assert.equal(calls.length, 1, 'one call, not one per league');
  assert.equal(calls[0][0], current.id);
  assert.equal(result.league, 'This year');
  assert.equal(result.season, 2026);
});

test('it writes nothing when the newest ESPN league is a past season', async (t) => {
  // The dangerous reader is routes/aggregates.js:226: it joins on espn_id with
  // NO season filter and reads adp, ppr_rank and injury_status. Since the
  // upsert overwrites the season column too, a run against a 2025 league puts
  // last year's ADP and last year's injury status on the live consensus board
  // with nothing marking them stale. The two season-filtered readers would
  // merely go blank; this one goes quietly wrong, so the run is skipped.
  db.exec('DELETE FROM leagues');
  addLeague({ platform: 'espn', leagueId: 'e-old', season: 2025, name: 'Last year' });

  const calls = [];
  mockSync(t, calls);
  const result = await scheduler.JOBS.espn_market.run();

  assert.deepEqual(calls, [], 'a stale-season write is worse than no write');
  assert.equal(result.skipped, true);
  assert.match(result.reason, /2025/);
});

test('within the current season it prefers a league that carries both cookies', async (t) => {
  // espn-market.js:31 attaches the Cookie header only when espn_s2 AND swid
  // are both present, so a private league missing either throws on the fetch.
  db.exec('DELETE FROM leagues');
  addLeague({ platform: 'espn', leagueId: 'e-bare', season: 2026, name: 'No cookies' });
  addLeague({ platform: 'espn', leagueId: 'e-auth', season: 2026, name: 'With cookies',
    espnS2: 's2-value', swid: '{swid}' });
  const authed = db.prepare(`SELECT id FROM leagues WHERE league_id = 'e-auth'`).get();

  const calls = [];
  mockSync(t, calls);
  await scheduler.JOBS.espn_market.run();

  assert.equal(calls[0][0], authed.id,
    'the cookie-bearing league wins the tie even though it was inserted second');
});

test('it asks for more of the pool than the default', async (t) => {
  // syncEspnMarket defaults to limit 400 (espn-market.js:18) and we hold ~800
  // ESPN ids, so the tail of the player pool was definitionally unfetched.
  db.exec('DELETE FROM leagues');
  addLeague({ platform: 'espn', leagueId: 'e1', season: 2026, name: 'This year' });

  const calls = [];
  mockSync(t, calls);
  await scheduler.JOBS.espn_market.run();

  assert.equal(calls[0][1]?.limit, 1000);
});
