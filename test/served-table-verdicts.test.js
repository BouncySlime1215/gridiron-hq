/**
 * The registry's rules have to be RUN, and a rule that cannot be run has to say
 * so rather than pass.
 *
 * `servedTables()` publishes, for each table the app serves, a rule that answers
 * "is this current?" as SQL returning 1 or 0. Publishing it is half the job. The
 * other half is an evaluator, and the reason it lives here rather than in the
 * consumer is a defect measured at the seam on 2026-09-22:
 *
 * The freshness consumer (`services/data-freshness.js`) reads
 * `current_rule.predicate` — a WHERE fragment — and this registry emits
 * `current_rule.sql`, a whole query. Neither field is present in the other's
 * shape, so `predicate` came back undefined, an empty predicate fell through to
 * "count all rows", and its placeholder guard was satisfied because zero
 * placeholders matched zero binds. The result, on a real migrated database with
 * `player_week_usage` holding 2021-2025 and nothing for the season being played:
 * **fresh**. The same database with the registry absent: **stale**. The mismatch
 * failed open, and it restored the exact bug the banner was built to end.
 *
 * Two lessons are pinned as tests here, not as prose:
 *
 *   1. An absent or unrunnable rule is a FAULT, never a pass. A freshness check
 *      that cannot answer must not answer "fine".
 *   2. A rule that cannot be told from a row count is not worth having, so the
 *      two rules that are deliberately stronger than a count are asserted
 *      against data a count would wave through.
 *
 * The evaluator is pure over its inputs — it takes the database and the season
 * and week to bind — so none of this depends on the wall clock or on which
 * database the container happens to have lying around.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-served-verdicts-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
// The full migrated schema, not the legacy one. Six of the seventeen served
// tables are created by numbered migrations (league_roster_snapshots is 058),
// and a harness that skips them measures a database production never has.
await (await import('../server/db/migrate.js')).runMigrations();
const { servedTables, evaluateServedTable, servedTableVerdicts } =
  await import('../server/services/source-registry.js');

const SEASON = 2026, WEEK = 3;
const ctx = { season: SEASON, week: WEEK, database: db };
const entryFor = (table) => servedTables().find(e => e.table === table);

db.prepare(`INSERT INTO players (id, name, position) VALUES (1, 'Test Player', 'WR')`).run();
const usage = (season, week) =>
  db.prepare(`INSERT INTO player_week_usage (player_id, season, week) VALUES (1, ?, ?)`)
    .run(season, week);

/* ------------------------------------------------------- 1. the type specimen */

test('past seasons with nothing for the season being served is NOT current', () => {
  db.prepare(`DELETE FROM player_week_usage`).run();
  for (const s of [2021, 2022, 2023, 2024, 2025]) for (const w of [1, 2, 3]) usage(s, w);

  const before = db.prepare(`SELECT COUNT(*) AS n FROM player_week_usage`).get().n;
  assert.equal(before, 15, 'premise: the table is far from empty');

  const verdict = evaluateServedTable(entryFor('player_week_usage'), ctx);
  assert.equal(verdict.current, false,
    'fifteen rows of history and none for 2026 is the failure this registry exists to name');
});

test('the same table with a row for the week being served IS current', () => {
  usage(SEASON, WEEK);
  assert.equal(evaluateServedTable(entryFor('player_week_usage'), ctx).current, true);
  db.prepare(`DELETE FROM player_week_usage WHERE season = ?`).run(SEASON);
});

/* --------------------------------------- 2. every published rule actually runs */

test('all 17 published rules run and return a boolean, not an error', () => {
  const entries = servedTables();
  assert.equal(entries.length, 17, 'the count is pinned so a dropped entry is visible');

  for (const entry of entries) {
    const verdict = evaluateServedTable(entry, ctx);
    assert.equal(typeof verdict.current, 'boolean',
      `${entry.table}: rule must resolve to a boolean`);
    assert.ok(verdict.rule && verdict.rule.length > 0,
      `${entry.table}: the sentence a reader sees must travel with the verdict`);
  }
});

/* ------------------------------------------- 3. an unrunnable rule is a FAULT */

test('a rule with no SQL throws rather than passing', () => {
  const broken = { ...entryFor('players'), current_rule: { text: 'no sql here', params: [] } };
  assert.throws(() => evaluateServedTable(broken, ctx), /no runnable SQL/i,
    'the seam defect was exactly this case treated as a pass');
});

test('a rule whose placeholders and params disagree throws', () => {
  const entry = entryFor('player_week_usage');
  const broken = { ...entry, current_rule: { ...entry.current_rule, params: ['week'] } };
  assert.throws(() => evaluateServedTable(broken, ctx), /2 placeholders but 1 param/i);
});

test('a rule binding a value the evaluator cannot supply throws, naming it', () => {
  const entry = entryFor('player_week_usage');
  const broken = { ...entry, current_rule: { ...entry.current_rule, params: ['week', 'quarter'] } };
  assert.throws(() => evaluateServedTable(broken, ctx), /quarter/);
});

test('a rule that returns no row at all is a fault, not a quiet "not current"', () => {
  // Added because a mutation survived: turning this guard into `current: false`
  // passed all nine tests. None of the seventeen shipped rules can return zero
  // rows — every one is an aggregate — so the guard is there for the next rule
  // written, which is exactly the kind of guard that gets simplified away by
  // someone who checks the suite first. "No answer" and "not current" are
  // different things and only one of them should reach a user as a verdict.
  const entry = entryFor('players');
  const noRow = { ...entry, current_rule: { text: 'returns nothing',
    sql: 'SELECT 1 AS current FROM players WHERE 1 = 0', params: [] } };
  assert.throws(() => evaluateServedTable(noRow, ctx), /returned no row/i);
});

test('a rule returning something other than 0 or 1 is a fault', () => {
  const entry = entryFor('players');
  const counting = { ...entry, current_rule: { text: 'returns a count',
    sql: 'SELECT COUNT(*) AS current FROM player_week_usage', params: [] } };
  db.prepare(`DELETE FROM player_week_usage`).run();
  for (const w of [1, 2, 3]) usage(2024, w);
  assert.throws(() => evaluateServedTable(counting, ctx), /returned 3/,
    'a rule that answers with a count is the mistake the contract exists to forbid');
});

/* --------------------- 4. a rule that throws is REPORTED, never dropped */

test('one broken rule is reported as unknown with its reason, and the rest still answer', () => {
  const entries = [
    entryFor('players'),
    { ...entryFor('player_week_usage'), current_rule: { text: 'broken', sql: 'SELECT nope FROM nowhere', params: [] } },
    entryFor('schedule_games'),
  ];
  const out = servedTableVerdicts({ entries, ...ctx });

  assert.equal(out.length, 3, 'a rule that threw must not vanish from the panel');
  const broken = out.find(v => v.table === 'player_week_usage');
  assert.equal(broken.current, null, 'null is "we could not tell", distinct from false');
  assert.ok(broken.error && /nowhere|no such/i.test(broken.error),
    'the reason travels to the surface instead of being swallowed');
  assert.equal(out.find(v => v.table === 'players').current, true);
  assert.equal(out.find(v => v.table === 'schedule_games').current, false);
});

/* ------------- 5. the two rules that are stronger than a count, proven so */

test('game script needs BOTH targets fitted, where any row count would pass', () => {
  db.prepare(`INSERT INTO gamescript_model (target, fitted_at) VALUES ('pass_att', '2026-09-01')`).run();
  const count = db.prepare(`SELECT COUNT(*) AS n FROM gamescript_model`).get().n;
  assert.equal(count, 1, 'premise: a row count would call this fitted');

  assert.equal(evaluateServedTable(entryFor('gamescript_model'), ctx).current, false,
    'one fitted target of two is a half-fitted model');

  db.prepare(`INSERT INTO gamescript_model (target, fitted_at) VALUES ('rush_att', '2026-09-01')`).run();
  assert.equal(evaluateServedTable(entryFor('gamescript_model'), ctx).current, true);
});

test('rosters need EVERY team recent, not merely one, which is why it is a MIN', () => {
  // roster_players.team_id references nfl_teams, and a migrated-but-unseeded
  // database has no teams, so the two this needs are made here.
  const team = db.prepare(`INSERT INTO nfl_teams (id, abbr, name, conference, division)
                           VALUES (?, ?, ?, 'AFC', 'East')`);
  team.run(901, 'AAA', 'Team A');
  team.run(902, 'BBB', 'Team B');
  const [a, b] = [901, 902];

  db.prepare(`INSERT INTO roster_players (team_id, name, fetched_at)
              VALUES (?, 'Fresh Guy', datetime('now'))`).run(a);
  assert.equal(evaluateServedTable(entryFor('roster_players'), ctx).current, true,
    'one team, refreshed now');

  db.prepare(`INSERT INTO roster_players (team_id, name, fetched_at)
              VALUES (?, 'Stale Guy', datetime('now', '-9 days'))`).run(b);
  assert.equal(evaluateServedTable(entryFor('roster_players'), ctx).current, false,
    'a second team nine days stale makes the set not current, though one row is fresh');
});
