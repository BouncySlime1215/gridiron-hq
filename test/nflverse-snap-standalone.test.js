/**
 * S-20 skeptic fix: the scheduled job nflverse_snap_counts
 * (server/services/scheduler.js JOBS.nflverse_snap_counts ->
 * refreshNflverseSnapCounts) calls syncSnapCounts on its own, in a fresh
 * job-worker, without syncCrosswalk first. So the pfr -> gsis map is never
 * warm there and syncSnapCounts fetches players.csv itself. A players.csv
 * failure must not throw the whole snap job (origin/main wrote name-joined
 * rows in that case): it is counted as crosswalk_error and the run falls back
 * to the name join. A later run retries the crosswalk instead of caching the
 * failure. This file runs in its own process, so the module-level map starts
 * cold exactly as in the worker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-snap-standalone-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
delete process.env.NFL_WEEK;

const { db, rows, run } = await import('../server/db/index.js');
const { JOBS } = await import('../server/services/scheduler.js');

const PLAYERS = [
  [4, 'Dale Rivers Jr.', 'WR', '00-0039849'],
  [81, 'Joshua Penn', 'WR', '00-0036973'],
  [82, 'Plain Receiver', 'WR', '00-0036900'],
  [3877, 'Dale Rivers', 'WR', '00-0007024']
];
for (const [id, name, pos, gsis] of PLAYERS) {
  run('INSERT INTO players (id, name, position, gsis_id) VALUES (?,?,?,?)', id, name, pos, gsis);
}
const PLAYERS_CSV = [
  'gsis_id,display_name,position,espn_id,pfr_id',
  '00-0039849,Dale Rivers Jr.,WR,,RiveDa03',
  '00-0036973,Joshua Penn,WR,,PennJo00',
  '00-0036900,Plain Receiver,WR,,PlaiRe00',
  '00-0007024,Dale Rivers,WR,,RiveDa00'
].join('\n');
const SNAPS_CSV = [
  'game_id,season,game_type,week,player,pfr_player_id,position,team,offense_snaps,offense_pct',
  '2026_01_ARI_NO,2026,REG,1,Dale Rivers Jr.,RiveDa03,WR,ARI,59,0.79',
  '2026_01_LAC_KC,2026,REG,1,Josh Penn,PennJo00,WR,BUF,40,0.66',
  '2026_01_CIN_CLE,2026,REG,1,Plain Receiver,PlaiRe00,WR,CIN,64,0.94'
].join('\n');

let playersStatus = 503;
const fetched = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  fetched.push(u.split('/').pop());
  if (u.endsWith('/players/players.csv')) {
    return playersStatus === 200 ? new Response(PLAYERS_CSV, { status: 200 }) : new Response('down', { status: playersStatus });
  }
  if (u.endsWith('/snap_counts_2026.csv')) return new Response(SNAPS_CSV, { status: 200 });
  return new Response('not found', { status: 404 });
};
test.after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const snapsFor = id => rows('SELECT week, offense_snaps FROM player_week_snaps WHERE player_id = ? AND season = 2026 ORDER BY week', id)
  .map(r => [r.week, r.offense_snaps]);

test('scheduled job with players.csv down: no throw, crosswalk_error counted, name fallback only', async () => {
  const out = await JOBS.nflverse_snap_counts.run();
  assert.deepEqual(fetched, ['snap_counts_2026.csv', 'players.csv']);
  assert.match(String(out.crosswalk_error), /players\.csv/);
  assert.equal(out.by_id, 0);
  // The unique names still land by name, as on origin/main.
  assert.deepEqual(snapsFor(82), [[1, 64]]);
  // The Jr. shares a name key with the retired namesake: refused, not guessed.
  assert.deepEqual(snapsFor(3877), []);
  assert.deepEqual(snapsFor(4), []);
  assert.equal(out.ambiguous_name, 1);
});

test('the failure is not cached: the next run fetches players.csv again and joins by id', async () => {
  fetched.length = 0;
  playersStatus = 200;
  const out = await JOBS.nflverse_snap_counts.run();
  assert.deepEqual(fetched, ['snap_counts_2026.csv', 'players.csv']);
  assert.equal(out.crosswalk_error, null);
  assert.equal(out.by_id, 3);
  assert.deepEqual(snapsFor(4), [[1, 59]]);
  assert.deepEqual(snapsFor(81), [[1, 40]]);
});

test('once the map is warm in this process, a further run does not refetch players.csv', async () => {
  fetched.length = 0;
  const out = await JOBS.nflverse_snap_counts.run();
  assert.deepEqual(fetched, ['snap_counts_2026.csv']);
  assert.equal(out.by_id, 3);
});
