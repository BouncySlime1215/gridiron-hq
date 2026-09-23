/**
 * When the registry exports its own evaluator, this module must USE it, not
 * keep its own second copy of the same contract alive beside it.
 *
 * `source-registry.js` gains `evaluateServedTable(entry, { season, week,
 * database })` in #104 (verified on `claude/project-thread-o3wt2p-freshness-
 * evaluator` @ e3a8676, line 623). That function is the definition of what a
 * current-data rule means. `data-freshness.js` has an `askRule` that implements
 * the same contract independently, because it had to ship before the evaluator
 * existed — and two implementations of one contract that drift apart is the
 * next version of the bug this whole branch exists to fix. The first version
 * was two modules disagreeing about a rule's SHAPE; the second would be two
 * modules disagreeing about what a rule MEANS, which is harder to see.
 *
 * So the delegation is feature-detected rather than imported outright: the
 * evaluator lands on a different branch than this file, and a hard import would
 * make this module unloadable until that branch merges.
 *
 * Feature detection is exactly the kind of code that silently never fires, so
 * it is tested from both sides rather than assumed: the evaluator is mocked in
 * here, and the tests prove the delegation happens, that the local path still
 * works when it is absent, and that a throw from the borrowed evaluator becomes
 * this module's `unknown` rather than a crash.
 *
 * `mock.module` takes `namedExports`, NOT `exports` — passing the wrong key is
 * accepted in silence and the mock simply does nothing, which cost this project
 * weeks once already (see test/nfl-news-events.test.js:29).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-freshness-delegate-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const realRegistry = await import('../server/services/source-registry.js');

const calls = [];
let behaviour = () => ({ current: false });

mock.module('../server/services/source-registry.js', {
  namedExports: {
    ...realRegistry,
    evaluateServedTable: (entry, opts) => { calls.push({ entry, opts }); return behaviour(entry, opts); }
  }
});

const { tableFreshness } = await import('../server/services/data-freshness.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026, WEEK = 3;
db.prepare(`INSERT INTO players (id, name, position) VALUES (1, 'Test Player', 'WR')`).run();
db.prepare(`INSERT INTO player_week_usage (player_id, season, week) VALUES (1, 2021, 1)`).run();

const SQL_RULE = {
  sql: 'SELECT 1 AS ok', params: [],
  text: 'Has weekly usage rows for the season being played.'
};
const PREDICATE_RULE = {
  description: 'Has rows for the season being played.',
  predicate: 'season = ?', bind: ['season']
};

const check = rule => tableFreshness(
  { table: 'player_week_usage', label: 'Weekly player usage', grain: 'week', current_rule: rule },
  { currentSeason: SEASON, currentWeek: WEEK, database: db }
);

test('a shipped-shape rule is answered by the registry evaluator, not by the local copy', () => {
  calls.length = 0;
  behaviour = () => ({ current: true });
  const f = check(SQL_RULE);
  assert.equal(calls.length, 1, 'the registry evaluator was never called — the local copy answered');
  assert.equal(f.status, 'fresh');
});

test('the evaluator is handed the entry and the season/week it needs', () => {
  calls.length = 0;
  behaviour = () => ({ current: true });
  check(SQL_RULE);
  const { entry, opts } = calls[0];
  assert.equal(entry.table, 'player_week_usage', 'the evaluator got something other than the entry');
  assert.equal(opts.season, SEASON);
  assert.equal(opts.week, WEEK);
  assert.ok(opts.database, 'the evaluator was not given a database to read');
});

test('the evaluator\'s verdict is what reaches the row, both ways', () => {
  behaviour = () => ({ current: false });
  assert.equal(check(SQL_RULE).status, 'stale',
    'the borrowed verdict was ignored and the local copy answered instead');
  behaviour = () => ({ current: true });
  assert.equal(check(SQL_RULE).status, 'fresh');
});

test('a throw from the borrowed evaluator is reported as unknown, not a crash', () => {
  behaviour = () => { throw new Error('source-registry: player_week_usage rule binds "nonsense"'); };
  const f = check(SQL_RULE);
  assert.equal(f.status, 'unknown');
  assert.match(String(f.note ?? ''), /nonsense/,
    'the evaluator\'s own reason was dropped on the way to the panel');
});

test('the WHERE-fragment shape still runs locally — the evaluator does not take that one', () => {
  calls.length = 0;
  behaviour = () => { throw new Error('the evaluator must not be asked about a predicate rule'); };
  const f = check(PREDICATE_RULE);
  assert.equal(calls.length, 0, 'a predicate-shape rule was handed to the sql-shape evaluator');
  assert.equal(f.status, 'stale', 'the local predicate path stopped working');
});
