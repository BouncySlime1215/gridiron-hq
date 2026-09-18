/**
 * FTN charting ingest — the live 2026 source for scheme and pressure (blitzers, pass
 * rushers, box counts) and target quality (catchable, contested, created, drops) that the
 * opportunity model needs (plan section 00, C: O1). Man/zone participation data stops at
 * 2025; FTN is published weekly for 2026.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ftn-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { ingestCharting } = await import('../server/services/nfl-formations.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const HEADER = 'ftn_game_id,nflverse_game_id,season,week,ftn_play_id,nflverse_play_id,starting_hash,qb_location,n_offense_backfield,n_defense_box,is_no_huddle,is_motion,is_play_action,is_screen_pass,is_rpo,is_trick_play,is_qb_out_of_pocket,is_interception_worthy,is_throw_away,read_thrown,is_catchable_ball,is_contested_ball,is_created_reception,is_drop,is_qb_sneak,n_blitzers,n_pass_rushers,is_qb_fault_sack,date_pulled';
const row = (playId, over = {}) => {
  const v = { box: '7', blitz: '2', rush: '5', catchable: 'TRUE', contested: 'FALSE', created: 'FALSE', drop: 'FALSE', read: '1', iw: 'FALSE', sackfault: 'FALSE', ...over };
  return `1,2025_01_AAA_BBB,2025,1,${playId},${playId},M,S,1,${v.box},FALSE,TRUE,FALSE,FALSE,FALSE,FALSE,FALSE,${v.iw},FALSE,${v.read},${v.catchable},${v.contested},${v.created},${v.drop},FALSE,${v.blitz},${v.rush},${v.sackfault},2025-09-10`;
};
function mockFetch(csv) {
  globalThis.fetch = async () => ({ ok: true, text: async () => csv });
}

test('stores the pressure and target-quality columns, and an empty cell stays unknown (never 0)', async () => {
  mockFetch([HEADER, row(10), row(11, { box: '', blitz: '', rush: '', catchable: '' })].join('\n'));
  const r = await ingestCharting(2025);
  assert.equal(r.plays_stored, 2);
  const a = rows('SELECT * FROM nfl_play_charting WHERE game_id = ? AND play_id = 10', '2025_01_AAA_BBB')[0];
  assert.equal(a.defense_box, 7);
  assert.equal(a.n_blitzers, 2);
  assert.equal(a.n_pass_rushers, 5);
  assert.equal(a.catchable, 1);
  assert.equal(a.contested, 0);
  assert.equal(a.created_reception, 0);
  assert.equal(a.drop_, 0);
  assert.equal(a.read_thrown, 1);
  assert.equal(a.interception_worthy, 0);
  assert.equal(a.qb_fault_sack, 0);
  const b = rows('SELECT * FROM nfl_play_charting WHERE play_id = 11')[0];
  assert.equal(b.defense_box, null, 'an empty box count is unknown, not an empty box');
  assert.equal(b.n_blitzers, null);
  assert.equal(b.n_pass_rushers, null);
  assert.equal(b.catchable, null);
});

test('re-ingesting a season fills the new columns on rows stored before they existed', async () => {
  db.exec("INSERT INTO nfl_play_charting (game_id, play_id, season, week, defense_box) VALUES ('2025_01_AAA_BBB', 12, 2025, 1, 6)");
  mockFetch([HEADER, row(12, { blitz: '4', rush: '6' })].join('\n'));
  await ingestCharting(2025);
  const c = rows('SELECT * FROM nfl_play_charting WHERE play_id = 12')[0];
  assert.equal(c.n_blitzers, 4);
  assert.equal(c.n_pass_rushers, 6);
  assert.equal(c.defense_box, 7, 'a corrected value from FTN replaces the stale one');
});
