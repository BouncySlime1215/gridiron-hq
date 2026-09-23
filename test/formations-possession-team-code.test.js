/**
 * The participation feed spells the Rams "LA"; the app's canonical code is
 * "LAR" (server/services/team-codes.js). ingestFormations stored
 * possession_team raw, and teamHistory reads formation rows with
 * `possession=?` bound to the game_lines code (nfl-weekly-feature-store.js:150),
 * so the Rams got no formation history at all.
 *
 * Measured on a local copy of the production DB after loading 2025 through
 * scripts/backfill-formations.mjs: 31 of 32 week-3 team vectors gained
 * formation_ keys; the one that did not was LAR, and the only possession code
 * in the 2025 rows that game_lines does not use was LA.
 *
 * reconcileHistoricalTeamCodes (nfl-advanced.js:441) does rewrite
 * nfl_play_formations.possession, but only when a growth cycle reaches it with
 * every core source current, so a backfilled season sits unjoinable until
 * then. The writer uses the one canonical map instead.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-possession-code-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const COLS = ['nflverse_game_id', 'play_id', 'possession_team', 'offense_formation'];
const CSV = [COLS.join(','),
  '2025_01_HOU_LA,55,LA,SHOTGUN',
  '2025_01_HOU_LA,77,HOU,SINGLEBACK',
  '2025_01_KC_LAC,40,KC,EMPTY',
  '2025_01_KC_LAC,41,,',
  ''].join('\n');
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => CSV, body: null });

const { ingestFormations } = await import('../server/services/nfl-formations.js');
const result = await ingestFormations(2025);
const stored = Object.fromEntries(rows('SELECT play_id, possession FROM nfl_play_formations ORDER BY play_id')
  .map(item => [item.play_id, item.possession]));

test('the fixture was ingested, so an empty table cannot pass the checks below', () => {
  assert.equal(result.plays_stored, 4, JSON.stringify(result));
});

test('the feed\'s LA is stored as the canonical LAR', () => {
  assert.equal(stored[55], 'LAR', 'teamHistory binds possession to the game_lines code, which is LAR');
});

test('codes that are already canonical are stored unchanged', () => {
  assert.equal(stored[77], 'HOU');
  assert.equal(stored[40], 'KC');
});

test('a blank possession stays unknown, not an empty-string team', () => {
  assert.equal(stored[41], null);
});
