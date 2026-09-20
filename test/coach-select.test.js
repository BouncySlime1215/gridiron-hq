/**
 * The one place Coach runs a query it composed itself.
 *
 * Coach has to be able to answer a question nobody wrote a tool for — Nick's
 * ask is "any question should be able to be asked". The honest way to do that
 * over 215 tables is to let the model write a SELECT, and the only way to let a
 * model write SQL against the live database is to make the unsafe cases
 * impossible rather than discouraged.
 *
 * Three independent guards, because a prompt rule is not a guard:
 *  1. the connection is opened read-only, so SQLite itself rejects a write even
 *     if every check above it were bypassed;
 *  2. the statement is refused unless it is a single SELECT (or WITH) over
 *     tables the catalog describes — a table Coach may not read is named in the
 *     refusal rather than silently returning nothing;
 *  3. values are bound parameters, never interpolated (CLAUDE.md), so a value
 *     that looks like SQL is a value.
 *
 * A refusal and a broken query are different things and must stay different: a
 * refusal is policy and the model should not retry it, a SQLite error is
 * feedback the model can act on. Neither is swallowed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-select-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { run, row } = await import('../server/db/index.js');
const { safeSelect, coachDb, CoachQueryRefused, CoachQueryFailed } =
  await import('../server/services/coach/select.js');

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division, head_coach, off_scheme)
     VALUES (1, 'PHI', 'Philadelphia Eagles', 'NFC', 'East', 'Nick Sirianni', 'wide zone')`);
run(`INSERT INTO players (id, name, position, team_id, depth_rank) VALUES (1, 'A Player', 'WR', 1, 1)`);
run(`INSERT INTO players (id, name, position, team_id, depth_rank) VALUES (2, 'B Player', 'WR', 1, 2)`);

test('a SELECT over catalogued tables returns rows, their columns and where they came from', () => {
  const result = safeSelect(`SELECT name, position FROM players ORDER BY id`);
  assert.deepEqual(result.rows, [
    { name: 'A Player', position: 'WR' },
    { name: 'B Player', position: 'WR' }
  ]);
  assert.deepEqual(result.columns, ['name', 'position']);
  assert.deepEqual(result.tables, ['players']);
  assert.equal(result.row_count, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.provenance.players.collection, 'auto');
  assert.ok(result.provenance.players.freshness);
});

test('an aliased table is still resolved to the real table it reads', () => {
  const result = safeSelect(`SELECT p.name FROM players p JOIN nfl_teams t ON t.id = p.team_id`);
  assert.deepEqual(result.tables, ['nfl_teams', 'players']);
  assert.equal(result.row_count, 2);
});

test('values are bound, so a value that looks like SQL stays a value', () => {
  const result = safeSelect(`SELECT id FROM players WHERE name = ?`, [`'; DROP TABLE players; --`]);
  assert.equal(result.row_count, 0);
  assert.ok(row(`SELECT count(*) AS n FROM players`).n === 2, 'players survived');
});

test('a write is refused by policy, and the row count is untouched', () => {
  for (const sql of [
    `INSERT INTO players (name, position) VALUES ('X', 'WR')`,
    `UPDATE players SET name = 'X' WHERE id = 1`,
    `DELETE FROM players WHERE id = 1`,
    `DROP TABLE players`,
    `CREATE TABLE evil (a)`,
    `ALTER TABLE players ADD COLUMN evil TEXT`,
    `REPLACE INTO players (id, name, position) VALUES (1, 'X', 'WR')`
  ]) {
    assert.throws(() => safeSelect(sql), CoachQueryRefused, `not refused: ${sql}`);
  }
  assert.equal(row(`SELECT count(*) AS n FROM players`).n, 2);
  assert.equal(row(`SELECT name FROM players WHERE id = 1`).name, 'A Player');
});

test('the connection itself is read-only, so the policy check is not the only thing standing there', () => {
  assert.throws(() => coachDb().exec(`INSERT INTO players (name, position) VALUES ('X', 'WR')`),
    /readonly/i);
  assert.equal(row(`SELECT count(*) AS n FROM players`).n, 2);
});

test('a table the catalog does not describe is refused, and the refusal names it', () => {
  assert.throws(() => safeSelect(`SELECT * FROM nfl_bet_log`), err => {
    assert.ok(err instanceof CoachQueryRefused);
    assert.match(err.message, /nfl_bet_log/);
    return true;
  });
});

test('one catalogued table does not license an uncatalogued one beside it', () => {
  assert.throws(() => safeSelect(
    `SELECT p.name FROM players p JOIN nfl_bet_log b ON b.id = p.id`), /nfl_bet_log/);
});

test('a WITH query is allowed when every table it reads is catalogued', () => {
  const result = safeSelect(
    `WITH wrs AS (SELECT name FROM players WHERE position = ?) SELECT count(*) AS n FROM wrs`, ['WR']);
  assert.equal(result.rows[0].n, 2);
  assert.ok(result.tables.includes('players'));
});

test('a second statement, an ATTACH and a PRAGMA are all refused', () => {
  assert.throws(() => safeSelect(`SELECT 1; DROP TABLE players`), CoachQueryRefused);
  assert.throws(() => safeSelect(`ATTACH DATABASE '/tmp/x.sqlite' AS x`), CoachQueryRefused);
  assert.throws(() => safeSelect(`PRAGMA table_info(players)`), CoachQueryRefused);
  assert.equal(row(`SELECT count(*) AS n FROM players`).n, 2);
});

test('a trailing semicolon on a single statement is fine', () => {
  assert.equal(safeSelect(`SELECT count(*) AS n FROM players;`).rows[0].n, 2);
});

test('more rows than the cap are truncated and say so, rather than being quietly cut', () => {
  const result = safeSelect(`SELECT name FROM players ORDER BY id`, [], { maxRows: 1 });
  assert.equal(result.row_count, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.max_rows, 1);
});

test('a broken query fails as a SQL error the model can act on, not as a refusal', () => {
  assert.throws(() => safeSelect(`SELECT no_such_column FROM players`), err => {
    assert.ok(err instanceof CoachQueryFailed, 'a syntax/binding error must not masquerade as policy');
    assert.ok(!(err instanceof CoachQueryRefused));
    assert.match(err.message, /no_such_column/);
    return true;
  });
});

test('an empty or non-string query is refused rather than reaching SQLite', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.throws(() => safeSelect(bad), CoachQueryRefused);
  }
});

test('a redacted column cannot be selected, and the refusal names it', () => {
  run(`INSERT INTO leagues (id, platform, league_id, name, espn_s2, swid)
       VALUES (1, 'espn', '123', 'Matta - Kodsi Annual', 'SECRET-COOKIE', 'SECRET-SWID')`);
  for (const sql of [
    `SELECT espn_s2 FROM leagues`,
    `SELECT * FROM leagues`,
    `SELECT l.swid AS x FROM leagues l`
  ]) {
    assert.throws(() => safeSelect(sql), err => {
      assert.ok(err instanceof CoachQueryRefused, `not refused: ${sql}`);
      assert.match(err.message, /espn_s2|swid/);
      return true;
    });
  }
});

test('a redacted column cannot be filtered on either, so it cannot be read a character at a time', () => {
  assert.throws(() => safeSelect(`SELECT name FROM leagues WHERE espn_s2 LIKE ?`, ['a%']),
    CoachQueryRefused);
});

test('the rest of a table with a redacted column is still readable', () => {
  const result = safeSelect(`SELECT name, platform FROM leagues`);
  assert.equal(result.rows[0].name, 'Matta - Kodsi Annual');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

/*
 * Added because mutation M4 survived: deleting the forbidden-keyword scan
 * changed no test result, since every write the suite tried also failed the
 * "first token must be SELECT or WITH" check. A guard nothing tests is a guard
 * nobody knows is gone. These two pin it: a forbidden keyword in the body of a
 * WITH query is policy, not a SQLite error, and a forbidden word inside a
 * string literal is a value like any other.
 */
test('a forbidden keyword in the body of a WITH query is refused as policy, not left to SQLite', () => {
  assert.throws(() => safeSelect(`WITH x AS (SELECT 1 AS a) DELETE FROM players`), err => {
    assert.ok(err instanceof CoachQueryRefused, 'must be refused before SQLite ever sees it');
    assert.match(err.message, /DELETE/);
    return true;
  });
  assert.equal(row(`SELECT count(*) AS n FROM players`).n, 2);
});

test('a forbidden word inside a string literal is a value, not a keyword', () => {
  const result = safeSelect(`SELECT id FROM players WHERE name = ?`, ['drop table players']);
  assert.equal(result.row_count, 0);
  const inline = safeSelect(`SELECT count(*) AS n FROM players WHERE name = 'delete from players'`);
  assert.equal(inline.rows[0].n, 0);
});

/*
 * Added because mutation M5 survived: deleting the one-statement check changed
 * no result, because every multi-statement case the suite tried had a
 * forbidden keyword in its second statement and was caught by that scan
 * instead. A second statement that is itself an innocent SELECT pins the check
 * on its own.
 */
test('a second statement is refused even when it is itself only a SELECT', () => {
  assert.throws(() => safeSelect(`SELECT count(*) AS n FROM players; SELECT 1`), err => {
    assert.ok(err instanceof CoachQueryRefused, 'must be refused as policy, not left to SQLite');
    assert.match(err.message, /one statement/i);
    return true;
  });
});
