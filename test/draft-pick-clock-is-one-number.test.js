/**
 * The mock-draft pick clock was the number 90 written out in three places —
 * `store.js#advanceDraftState`'s `?? 90`, the create-draft default in
 * routes/drafts.js, and `DEFAULT 90` on the `drafts.pick_seconds` column — with
 * nothing saying what it was or tying the three together. A hand-set constant
 * standing unlabelled beside modelled numbers is the shape this project keeps
 * finding: a reader cannot tell whether 90 was fitted or picked, and three
 * copies can drift so that a draft created with the default gets a different
 * clock from the one the deadline is computed on.
 *
 * Two of the three now read `DEFAULT_PICK_SECONDS`. The third is a SQL column
 * default and cannot import anything, so this file holds it to the constant
 * instead — that assertion is the only thing keeping the schema in step.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pick-clock-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db, rows } = await import('../server/db/index.js');
const { DEFAULT_PICK_SECONDS } = await import('../server/draft/store.js');

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

test('the constant is a plain number of seconds, not a fraction of something', () => {
  assert.equal(typeof DEFAULT_PICK_SECONDS, 'number');
  assert.ok(Number.isInteger(DEFAULT_PICK_SECONDS) && DEFAULT_PICK_SECONDS > 0);
});

test('the drafts.pick_seconds column default is the same number', () => {
  // The assertion that actually does work here. A column default lives in SQL
  // and cannot import the constant, so the only thing stopping the two from
  // drifting is this test failing when one of them moves.
  const col = rows(`PRAGMA table_info(drafts)`).find(c => c.name === 'pick_seconds');
  assert.ok(col, 'drafts.pick_seconds must exist');
  assert.equal(Number(col.dflt_value), DEFAULT_PICK_SECONDS,
    `the schema default (${col.dflt_value}) and DEFAULT_PICK_SECONDS (${DEFAULT_PICK_SECONDS}) have drifted apart`);
});

test('a draft row that names its own pick clock keeps it', () => {
  // A real ESPN draft carries its own pick_seconds (espn-draft.js:216). The
  // constant is the fallback, never an override.
  db.prepare(`INSERT INTO drafts (id, name, type, team_count, rounds, my_slot, pick_seconds)
              VALUES (7001, 'Real', 'live', 12, 16, 1, 45)`).run();
  const d = rows('SELECT pick_seconds FROM drafts WHERE id = 7001')[0];
  assert.equal(d.pick_seconds, 45);
  assert.notEqual(d.pick_seconds, DEFAULT_PICK_SECONDS);
});

test('a draft row that says nothing gets the constant from the column default', () => {
  db.prepare(`INSERT INTO drafts (id, name, type, team_count, rounds, my_slot)
              VALUES (7002, 'Mock', 'mock', 12, 16, 1)`).run();
  const d = rows('SELECT pick_seconds FROM drafts WHERE id = 7002')[0];
  assert.equal(d.pick_seconds, DEFAULT_PICK_SECONDS);
});

test('the number is not written out anywhere it could drift again', () => {
  // The point of the change: one definition. A bare `90` reappearing next to
  // pick_seconds in either file is the drift this whole file exists to stop.
  for (const f of ['server/draft/store.js', 'server/routes/drafts.js']) {
    const src = fs.readFileSync(f, 'utf8');
    for (const line of src.split('\n')) {
      if (!line.includes('pick_seconds')) continue;
      // Skip the validation range in routes/drafts.js (15 to 600) and comments.
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue;
      assert.ok(!/\bpick_seconds\b[^\n]*(\?\?|=)\s*90\b/.test(line),
        `${f} writes the pick clock out again: ${line.trim()}`);
    }
  }
});
