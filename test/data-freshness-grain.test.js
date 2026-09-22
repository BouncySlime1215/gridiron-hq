/**
 * One vocabulary for grain, and it is the registry's, not this file's.
 *
 * `source-registry.js` emits `grain` as `'week' | 'season' | 'static' | 'fit'`
 * (verified on `claude/project-thread-o3wt2p-freshness-evaluator` @ e3a8676,
 * `evaluateServedTable` line 623). `data-freshness.js` had invented its own
 * two-value set, `'feed' | 'fit'`, before that contract existed. Two vocabularies
 * for the same field is the same fault as the rule-shape mismatch one layer up,
 * and it fails the same way: `'week'` arrives, nothing matches `'fit'`, and the
 * panel tells a weekly feed it is a generic feed that "has not been updated for
 * the current week" — which is right by accident for `'week'` and wrong for the
 * other two.
 *
 * The producer is the source of truth. This file adopts its four values.
 *
 * Grain is not decoration: it decides what the sentence under a behind row says,
 * and those are four different failures. A weekly feed that is behind missed a
 * week. A season-grained table that is behind has nothing for the season being
 * played. A static table that is behind stopped being refreshed at all. A fit
 * store that is behind means a named model is answering on a fallback right now.
 *
 * The fifth case is the one that matters most and has no word: an entry that
 * states no grain. It gets `null`, not a guessed default — the old code defaulted
 * to `'feed'`, which reads on the panel as a positive claim about a table nobody
 * classified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-freshness-grain-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { tableFreshness, GRAINS, FALLBACK_REGISTRY } =
  await import('../server/services/data-freshness.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026, WEEK = 3;
db.prepare(`INSERT INTO players (id, name, position) VALUES (1, 'Test Player', 'WR')`).run();
db.prepare(`INSERT INTO player_week_usage (player_id, season, week) VALUES (1, 2021, 1)`).run();

const RULE = {
  sql: 'SELECT CASE WHEN EXISTS (SELECT 1 FROM player_week_usage WHERE season = ? AND week <= ?) '
    + 'THEN 1 ELSE 0 END AS ok',
  params: ['season', 'week'],
  text: 'Has weekly usage rows for the season being played.'
};

const check = over => tableFreshness(
  { table: 'player_week_usage', label: 'Weekly player usage', current_rule: RULE, ...over },
  { currentSeason: SEASON, currentWeek: WEEK, database: db }
);

test('the registry\'s four grain values are the ones this module knows', () => {
  assert.deepEqual(GRAINS, ['week', 'season', 'static', 'fit'],
    'the grain vocabulary has drifted from source-registry.js\'s');
});

test('each of the four is carried through to the row untouched', () => {
  for (const grain of GRAINS) assert.equal(check({ grain }).grain, grain);
});

test('an entry that states no grain gets null, not a guessed one', () => {
  const f = check({});
  assert.notEqual(f.grain, 'feed',
    'an unclassified table is still being labelled a feed, which is a claim nobody made');
  assert.equal(f.grain, null);
  assert.equal(f.reader, null);
});

test('the fallback registry states its own grain rather than relying on a default', () => {
  const entry = FALLBACK_REGISTRY[0];
  assert.equal(entry.grain, 'week',
    'the one shipped entry is weekly-grained and should say so, not inherit it');
});

/**
 * The banner is where grain earns its place, so the sentence has to differ.
 * A source-text check, because there is no DOM harness here — anchored on the
 * four branches existing, which is what a fifth grain arriving would break.
 */
test('the banner says something different for each grain it is given', () => {
  const c = fs.readFileSync('client/src/components/DataFreshnessBanner.tsx', 'utf8');
  assert.match(c, /'week' \| 'season' \| 'static' \| 'fit'/,
    'the banner\'s grain type still carries the old two-value vocabulary');
  for (const grain of ['season', 'static', 'fit']) {
    assert.match(c, new RegExp(`grain === '${grain}'`), `no branch for grain "${grain}"`);
  }
  assert.doesNotMatch(c, /grain\?: 'feed'/,
    'the retired "feed" grain is still in the banner\'s type');
});
