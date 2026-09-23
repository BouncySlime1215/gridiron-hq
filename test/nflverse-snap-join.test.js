/**
 * S-20: syncSnapCounts (server/services/nflverse.js) must store each nflverse
 * snap row on the player its pfr_player_id resolves to (pfr -> gsis via
 * players.csv -> players.gsis_id), and use the name only when the id does not
 * resolve. The fixture reproduces the three failure shapes the R&D round 7
 * package found on the real table: a namesake pair (an active "Jr." and a
 * retired player of the same name and position), nflverse's `HB` label for a
 * local `RB`, and a nickname. It also holds the backfill contract: a row the
 * old name join wrote onto the namesake is moved (UPDATE), never deleted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-snap-join-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
delete process.env.NFL_WEEK;

const { db, rows, row, run } = await import('../server/db/index.js');
const nflverse = await import('../server/services/nflverse.js');

// Ids: 4 = active Jr., 3877 = retired namesake inserted after him (so the old
// last-row-wins name map points at the retired row, as on the real table).
const PLAYERS = [
  [4, 'Dale Rivers Jr.', 'WR', '00-0039849'],
  [80, 'Case Back', 'RB', '00-0038542'],
  [81, 'Joshua Penn', 'WR', '00-0036973'],
  [82, "Ty'Ron Steady", 'WR', '00-0036900'],
  [83, 'Fallback Tightend', 'TE', null],
  [84, 'Other Namesake', 'WR', '00-0030001'],
  [85, 'Other Namesake', 'WR', '00-0030002'],
  [86, 'Twin Same', 'WR', '00-0030003'],
  [87, 'Twin Same', 'WR', '00-0030004'],
  [3877, 'Dale Rivers', 'WR', '00-0007024']
];
for (const [id, name, pos, gsis] of PLAYERS) {
  run('INSERT INTO players (id, name, position, gsis_id) VALUES (?,?,?,?)', id, name, pos, gsis);
}

const PLAYERS_CSV = [
  'gsis_id,display_name,position,espn_id,pfr_id',
  '00-0039849,Dale Rivers Jr.,WR,,RiveDa03',
  '00-0038542,Case Back,RB,,BackCa01',
  '00-0036973,Joshua Penn,WR,,PennJo00',
  '00-0036900,Ty\'Ron Steady,WR,,SteaTy00',
  '00-0030001,Other Namesake,WR,,NameOt01',
  '00-0030003,Twin Same,WR,,TwinSa01',
  '00-0030004,Twin Same,WR,,TwinSa02',
  '00-0007024,Dale Rivers,WR,,RiveDa00'
].join('\n');

const SNAP_HEADER = 'game_id,season,game_type,week,player,pfr_player_id,position,team,offense_snaps,offense_pct';
const SNAPS_CSV = [
  SNAP_HEADER,
  '2026_01_ARI_NO,2026,REG,1,Dale Rivers Jr.,RiveDa03,WR,ARI,59,0.79',
  '2026_02_ARI_CAR,2026,REG,2,Dale Rivers Jr.,RiveDa03,WR,ARI,37,0.74',
  '2026_01_CIN_CLE,2026,REG,1,Case Back,BackCa01,HB,CIN,48,0.71',
  '2026_01_LAC_KC,2026,REG,1,Josh Penn,PennJo00,WR,BUF,40,0.66',
  '2026_01_CIN_CLE,2026,REG,1,Ty\'Ron Steady,SteaTy00,WR,CIN,64,0.94',
  // pfr id unknown to players.csv: the name fallback is the only way in.
  '2026_01_XXX_YYY,2026,REG,1,Fallback Tightend,UnknTi00,TE,XXX,30,0.50',
  // pfr id resolves to 84; the namesake 85 holds a row with DIFFERENT numbers,
  // which is his own row and must not be moved.
  '2026_01_AAA_BBB,2026,REG,1,Other Namesake,NameOt01,WR,AAA,20,0.30',
  // Unknown pfr id and a name|position two local players share: refused, counted.
  '2026_02_AAA_BBB,2026,REG,2,Other Namesake,UnknOt09,WR,AAA,18,0.28',
  // Same-name pair who both resolve by id in the same week with identical
  // numbers: neither is a stale copy of the other, so nothing is moved.
  '2026_01_CCC_DDD,2026,REG,1,Twin Same,TwinSa01,WR,CCC,25,0.40',
  '2026_01_EEE_FFF,2026,REG,1,Twin Same,TwinSa02,WR,EEE,25,0.40',
  // Postseason rows are skipped as before.
  '2026_19_ARI_NO,2026,POST,19,Dale Rivers Jr.,RiveDa03,WR,ARI,60,0.80'
].join('\n');

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  const body = u.endsWith('/players/players.csv') ? PLAYERS_CSV
    : u.endsWith('/snap_counts_2026.csv') ? SNAPS_CSV
      : null;
  if (body == null) return new Response('not found', { status: 404 });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/csv' } });
};

test.after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const snapsFor = id => rows('SELECT week, offense_snaps, offense_pct FROM player_week_snaps WHERE player_id = ? AND season = 2026 ORDER BY week', id);

// State the old name join left behind: the Jr.'s two weeks sit on the retired
// namesake (3877); 85 has his own, different, week-1 row.
run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (3877,2026,1,59,0.79)');
run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (3877,2026,2,37,0.74)');
run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (85,2026,1,11,0.15)');
run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (87,2026,1,25,0.40)');
const rowsBefore = row('SELECT COUNT(*) AS n FROM player_week_snaps').n;

const result = await nflverse.syncSnapCounts(2026);

test('namesake pair: the active Jr. gets his snaps, the retired namesake keeps none', () => {
  assert.deepEqual(snapsFor(4).map(r => [r.week, r.offense_snaps]), [[1, 59], [2, 37]]);
  assert.equal(snapsFor(3877).length, 0, 'retired namesake holds no 2026 snap rows');
});

test('nflverse HB label: Case Back (RB locally) gets his snaps through his pfr id', () => {
  assert.deepEqual(snapsFor(80).map(r => [r.week, r.offense_snaps]), [[1, 48]]);
});

test('nickname: "Josh Penn" lands on Joshua Penn through his pfr id', () => {
  assert.deepEqual(snapsFor(81).map(r => [r.week, r.offense_snaps]), [[1, 40]]);
});

test('null control: a player with no name issue is unchanged', () => {
  assert.deepEqual(snapsFor(82).map(r => [r.week, r.offense_snaps, r.offense_pct]), [[1, 64, 0.94]]);
});

test('name fallback is used only when the pfr id does not resolve, and is counted', () => {
  assert.deepEqual(snapsFor(83).map(r => [r.week, r.offense_snaps]), [[1, 30]]);
  assert.equal(result.name_fallback, 1);
  assert.equal(result.by_id, 8, 'eight REG rows resolve by pfr id');
});

test('a namesake row with different numbers is his own and is not moved', () => {
  assert.deepEqual(snapsFor(85).map(r => [r.week, r.offense_snaps]), [[1, 11]]);
  assert.deepEqual(snapsFor(84).map(r => [r.week, r.offense_snaps]), [[1, 20]]);
});

test('backfill is updates only: no row is deleted, and moved rows are counted', () => {
  assert.equal(result.reassigned, 2, 'both of the Jr.\'s rows moved off the retired namesake');
  const rowsAfter = row('SELECT COUNT(*) AS n FROM player_week_snaps').n;
  // 4 pre-existing rows; 9 stored REG rows, of which 2 are the Jr.'s moved rows
  // and 1 (Twin Same, 87) already existed: 6 new keys.
  assert.equal(rowsAfter, rowsBefore + 6);
  assert.equal(result.unmatched, 0);
  assert.equal(result.inserted, 9);
});

test('a name key two players share is refused, not guessed', () => {
  assert.equal(result.ambiguous_name, 1);
  assert.deepEqual(snapsFor(85).map(r => r.week), [1], 'no week-2 row guessed onto a namesake');
  assert.deepEqual(snapsFor(84).map(r => r.week), [1]);
});

test('same-name players who both resolve by id keep their own rows', () => {
  assert.deepEqual(snapsFor(86).map(r => [r.week, r.offense_snaps]), [[1, 25]]);
  assert.deepEqual(snapsFor(87).map(r => [r.week, r.offense_snaps]), [[1, 25]]);
  assert.equal(result.reassigned, 2, 'the twins are not counted as moved rows');
});

test('a second run is idempotent: nothing more to move', async () => {
  const again = await nflverse.syncSnapCounts(2026);
  assert.equal(again.reassigned, 0);
  assert.equal(snapsFor(3877).length, 0);
});

test('syncAll reaches the id join through the crosswalk it runs first, and logs the counts', async () => {
  const out = await nflverse.syncAll([2026]);
  assert.equal(out.snaps[0].by_id, 8);
  assert.equal(out.snaps[0].reassigned, 0);
  const log = row("SELECT last_status, last_detail FROM sync_log WHERE job = 'nflverse_snap_counts'");
  assert.equal(log?.last_status, 'ok');
  assert.match(String(log.last_detail), /"by_id":8/);
});
