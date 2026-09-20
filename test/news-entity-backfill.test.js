import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * backfillNewsEntities() — the repair for news_items rows written before the
 * ESPN pull started calling extractEntities.
 *
 * Until scripts/backfill-news-entities.mjs existed, this function was
 * exported and called by nothing at all: no route, no scheduler job, no
 * script, no test. That is worth stating plainly, because an untested
 * function with no caller and a confident docstring is indistinguishable
 * from a function that does not work. These cases are the first thing that
 * has ever executed it.
 *
 * What the docstring claims, and therefore what is asserted here:
 *   - it only touches rows still missing entities_json or published_at;
 *   - it is safe to re-run, i.e. it converges to checked: 0;
 *   - it backdates published_at to the story's own `date` rather than to
 *     now, so an old story does not read as having just published;
 *   - a story naming nobody we track still gets a real (empty) answer
 *     rather than being left NULL and re-examined forever.
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-news-backfill-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// Seeded before the first call on purpose: routes/espn.js caches the player
// identity list on first use, so a player inserted later would be invisible
// to every subsequent call and the test would silently assert nothing.
run(`INSERT INTO nfl_teams (name, abbr, conference, division) VALUES ('Carolina Panthers', 'CAR', 'NFC', 'South')`);
const teamId = row(`SELECT id FROM nfl_teams WHERE abbr='CAR'`).id;
run(`INSERT INTO players (name, position, fantasy_relevant) VALUES ('Bryce Young', 'QB', 1)`);
const playerId = row(`SELECT id FROM players WHERE name='Bryce Young'`).id;

const { backfillNewsEntities } = await import('../server/routes/espn.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function insertStory({ headline, body = null, date = null, entitiesJson = null, publishedAt = null }) {
  run(`INSERT INTO news_items (date, team_id, headline, body, importance, source, entities_json, published_at)
       VALUES (?,?,?,?,2,'ESPN',?,?)`, date, teamId, headline, body, entitiesJson, publishedAt);
  return row(`SELECT id FROM news_items WHERE headline=?`, headline).id;
}

test('a story left without entities gets them, and names the player it mentions', () => {
  const id = insertStory({ headline: 'Bryce Young cleared to play', date: '2026-09-01' });
  const result = backfillNewsEntities();

  assert.equal(result.checked, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.resolved_a_player, 1);

  const after = row(`SELECT entities_json, published_at FROM news_items WHERE id=?`, id);
  assert.notEqual(after.entities_json, null);
  assert.deepEqual(JSON.parse(after.entities_json).players.map(p => p.id), [playerId]);
  assert.notEqual(after.published_at, null);
});

test('published_at is backdated to the story date, not to now', () => {
  const id = insertStory({ headline: 'Panthers sign a kicker', date: '2026-08-14' });
  backfillNewsEntities();

  const { published_at: publishedAt } = row(`SELECT published_at FROM news_items WHERE id=?`, id);
  assert.equal(publishedAt.slice(0, 10), '2026-08-14',
    'a story from weeks ago must not be stamped with the time the backfill happened');
});

test('a second run finds nothing left to do', () => {
  insertStory({ headline: 'Panthers waive a lineman', date: '2026-08-20' });
  backfillNewsEntities();

  const again = backfillNewsEntities();
  assert.equal(again.checked, 0, 'the repair must converge, or it will re-write every row on every run');
  assert.equal(again.updated, 0);
});

test('a story that names nobody we track is answered, not left NULL', () => {
  const id = insertStory({ headline: 'League announces schedule release date', date: '2026-07-02' });
  const result = backfillNewsEntities();

  assert.equal(result.updated, 1);
  assert.equal(result.resolved_a_player, 0, 'no tracked player is named, so none should be claimed');

  const { entities_json: entitiesJson } = row(`SELECT entities_json FROM news_items WHERE id=?`, id);
  assert.notEqual(entitiesJson, null,
    '"nobody we track" is a real answer; leaving it NULL means this row is re-examined on every future run');
  assert.deepEqual(JSON.parse(entitiesJson).players, []);
});

test('a story that already has a publish time keeps it while its entities are filled in', () => {
  const id = insertStory({
    headline: 'Bryce Young named starter for the opener', date: '2026-09-07',
    publishedAt: '2026-09-07T18:30:00.000Z'
  });

  const result = backfillNewsEntities();
  assert.equal(result.checked, 1, 'entities_json is still NULL, so the row is in scope');

  const after = row(`SELECT entities_json, published_at FROM news_items WHERE id=?`, id);
  assert.deepEqual(JSON.parse(after.entities_json).players.map(p => p.id), [playerId]);
  assert.equal(after.published_at, '2026-09-07T18:30:00.000Z',
    'the story already knew when it published; the backfill must not overwrite that with a guess');
});

test('a row that already has both columns is left alone', () => {
  const settled = JSON.stringify({ players: [], teams: [] });
  const id = insertStory({
    headline: 'Bryce Young throws for three hundred yards', date: '2026-09-05',
    entitiesJson: settled, publishedAt: '2026-09-05T12:00:00.000Z'
  });

  const result = backfillNewsEntities();
  assert.equal(result.checked, 0, 'a settled row must not be re-examined');

  const after = row(`SELECT entities_json, published_at FROM news_items WHERE id=?`, id);
  assert.equal(after.entities_json, settled,
    'the row already had an answer; overwriting it would discard whatever produced it');
  assert.equal(after.published_at, '2026-09-05T12:00:00.000Z');
});

test('every story in the table ends up with both columns filled', () => {
  assert.equal(rows(`SELECT id FROM news_items WHERE entities_json IS NULL OR published_at IS NULL`).length, 0);
});
