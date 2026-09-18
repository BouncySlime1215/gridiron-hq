/**
 * seasonEndingEspnIds: same answer, a fraction of the work.
 *
 * It was the most expensive part of a warm asset build (~0.93 s of each 1.2-1.3 s
 * league build on the 2026-W2 snapshot): for every (roster player x severe story) pair
 * it re-normalised the WHOLE story text (2,483 x 108 = 268,164 normalisations), and it
 * re-parsed 11.9 MB of league payloads on every call — once per league, although the
 * answer does not depend on the league. Now each story is normalised once, and the
 * result is memoised on the exact inputs (the in-window severe stories' text and time,
 * the roster, and each league's fetched_at), so an in-place edit of a story is never
 * served stale.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-season-ending-cost-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await import('../server/routes/nfldata.js');
await runMigrations();

const identity = await import('../server/services/player-identity.js');
let normalizations = 0;
mock.module('../server/services/player-identity.js', {
  namedExports: { ...identity, normalizePlayerName: text => { normalizations++; return identity.normalizePlayerName(text); } }
});
const { seasonEndingEspnIds } = await import('../server/services/player-availability.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (1,'TST','Test Team','NFC','North')`);
const ROSTER = 60, STORIES = 30;
for (let i = 0; i < ROSTER; i++) {
  run(`INSERT INTO roster_players (espn_id, name, team_id) VALUES (?,?,1)`, 1000 + i, `Rostered Player${String.fromCharCode(65 + (i % 26))}${i}`);
}
const story = (headline, body = '') =>
  run(`INSERT INTO news_items (headline, body, date, published_at) VALUES (?, ?, datetime('now'), datetime('now'))`, headline, body);
for (let i = 0; i < STORIES - 1; i++) story(`Released WR Someone Else${i}.`, 'A long paragraph of unrelated roster notes. '.repeat(20));
story('Rostered PlayerA0 tore his ACL and is out for the season.');

test('the answer is unchanged: the one named player is flagged', () => {
  assert.deepEqual([...seasonEndingEspnIds()], [1000]);
});

test('each story is normalised once, not once per rostered player', () => {
  normalizations = 0;
  seasonEndingEspnIds({ days: 44 });   // a different window: not served from the memo
  assert.ok(normalizations < ROSTER + STORIES + 50,
    `${normalizations} normalisations for ${ROSTER} players x ${STORIES} stories (per-pair would be ${ROSTER * STORIES}+)`);
});

test('an unchanged input is not recomputed; a new or edited story is', () => {
  seasonEndingEspnIds();
  normalizations = 0;
  seasonEndingEspnIds();
  assert.equal(normalizations, 0, 'same inputs, same answer, no work');
  story('Released WR Rostered PlayerB1.');
  assert.deepEqual([...seasonEndingEspnIds()].sort(), [1000, 1001]);
  // An in-place edit that changes no row count or max id must still be seen.
  run(`UPDATE news_items SET headline = 'Rostered PlayerB1 had a quiet practice.' WHERE headline = 'Released WR Rostered PlayerB1.'`);
  assert.deepEqual([...seasonEndingEspnIds()], [1000]);
});
