/**
 * When the archetype build fails, the sync_log row has to say WHICH failure it
 * was.
 *
 * `refreshManagerArchetypes` runs `scripts/build-manager-archetypes.mjs --json`
 * as a child process and reads the report off its stdout. Every way that can go
 * wrong currently produces one sentence — "the archetype build printed no JSON
 * summary" — and for one of those ways the sentence is simply false, because the
 * script printed a great deal of JSON.
 *
 * The three states, which need three answers:
 *
 *   1. nothing parseable on stdout       — the script died before printing.
 *   2. JSON that will not parse          — it printed, and the output is damaged.
 *   3. JSON with no `summary` key        — it printed fine, and the shape changed.
 *
 * State 2 is not hypothetical and it is the one worth the most. The script ends
 * with `process.exit(0)` immediately after `console.log` of the whole report, and
 * `process.exit` does not flush a pipe. Measured on this container, with stdout a
 * pipe under `execFile`:
 *
 *     payload 1,000 bytes       -> 1,037 bytes through, parse OK
 *     payload 100,000 bytes     -> 100,037 bytes through, parse OK
 *     payload 1,000,000 bytes   -> 146,176 bytes through, "Unterminated string in JSON"
 *     payload 5,000,000 bytes   -> 146,176 bytes through, same
 *
 * A hard cliff just under 146 KB that grows into reach as leagues are added. When
 * it is crossed, today's message sends whoever reads it to look for a script that
 * is not printing, which is the one thing that is definitely not wrong.
 *
 * Also pinned here: the report is found from the END of stdout rather than from
 * the first `{` anywhere in it. `indexOf('{')` happens to work today only because
 * `--json` suppresses the human report, whose second line is
 * `consensus source by season: {...}`. That is a gate one refactor away from
 * turning a successful build into "printed no JSON summary".
 *
 * The parsing is tested as a pure function over a string rather than by spawning
 * the real build, which needs a populated database and several minutes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-archetype-parse-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { parseArchetypeReport } = await import('../server/services/scheduler.js');

const SUMMARY = {
  league_seasons: 7, managers: 12, rows_written: 340,
  draft_manager_seasons: 41, outcome_manager_seasons: 38,
};
const report = (over = {}) => JSON.stringify({ summary: { ...SUMMARY }, repeatability: [], ...over }, null, 2);

/* ------------------------------------------------------------ the happy path */

test('a well-formed report becomes the summary row, with jev marked not run', () => {
  const out = parseArchetypeReport(report());
  assert.equal(out.error, undefined, 'a good report carries no error');
  assert.equal(out.managers, 12);
  assert.equal(out.league_seasons, 7);
  assert.equal(out.rows_written, 340);
  assert.equal(out.draft_manager_seasons, 41);
  assert.equal(out.outcome_manager_seasons, 38);
  assert.match(out.jev, /opt-in/, 'the jev stage is opt-in and the row says so');
});

test('a log line containing a brace before the report does not break the parse', () => {
  // The exact shape the human report prints, and the reason the search runs
  // from the end: `indexOf('{')` would start the slice inside this line.
  const noisy = 'consensus source by season: {"2024":"adp","2025":"adp"}\n' + report();
  const out = parseArchetypeReport(noisy);
  assert.equal(out.error, undefined,
    'a brace earlier in stdout must not be mistaken for the start of the report');
  assert.equal(out.managers, 12);
});

/* ------------------------------------- the three failures, told apart */

test('stdout with nothing parseable says the script printed nothing, and shows the tail', () => {
  const out = parseArchetypeReport('starting build\nreading leagues\nkilled by signal\n');
  assert.ok(out.error, 'this is a failure');
  assert.match(out.error, /printed no JSON/i);
  assert.equal(out.tail, 'killed by signal', 'the last line is what an operator wants first');
  assert.equal(out.parse_error, null, 'nothing was parsed, so there is no parse error to report');
});

test('JSON that will not parse is reported AS malformed, not as nothing printed', () => {
  // The truncation shape measured above: a report cut off mid-string.
  const cut = report().slice(0, 120);
  const out = parseArchetypeReport(cut);
  assert.ok(out.error, 'this is a failure');
  assert.match(out.error, /could not be parsed|malformed/i);
  assert.doesNotMatch(out.error, /printed no JSON/i,
    'it printed a great deal of JSON; saying otherwise sends the reader to the wrong place');
  assert.ok(out.parse_error && out.parse_error.length > 0,
    'the caught error must survive rather than being discarded');
  assert.equal(out.stdout_bytes, cut.length,
    'the byte count is what makes a flush truncation recognisable as one');
});

test('valid JSON with no summary key says the shape changed, not that nothing printed', () => {
  const out = parseArchetypeReport(JSON.stringify({ repeatability: [], reliability: [] }, null, 2));
  assert.ok(out.error, 'this is a failure');
  assert.match(out.error, /no summary/i);
  assert.doesNotMatch(out.error, /printed no JSON/i,
    'JSON was printed and parsed; only the summary was missing');
  assert.equal(out.parse_error, null, 'it parsed, so there is no parse error');
});

/* --------------------------------------------- shape the sync_log row relies on */

test('every failure carries the same three fields, so a reader never meets an undefined', () => {
  const cases = [
    parseArchetypeReport('nothing here'),
    parseArchetypeReport(report().slice(0, 50)),
    parseArchetypeReport(JSON.stringify({ repeatability: [] })),
  ];
  for (const out of cases) {
    for (const field of ['error', 'tail', 'parse_error', 'stdout_bytes']) {
      assert.ok(field in out, `${field} must be present on every failure, not only some`);
    }
  }
});

test('the tail is the last line and is bounded, so one long line cannot flood sync_log', () => {
  const out = parseArchetypeReport('first line\n' + 'z'.repeat(5000));
  assert.equal(out.tail.length, 200, 'bounded at 200 characters, as the original was');
  assert.equal(out.tail, 'z'.repeat(200));
});

test('empty stdout is a failure with a null tail rather than a crash', () => {
  const out = parseArchetypeReport('');
  assert.ok(out.error);
  assert.equal(out.tail, null);
  assert.equal(out.stdout_bytes, 0);
});
