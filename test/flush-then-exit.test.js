/**
 * `process.exit()` does not flush a pipe (2026-09-22).
 *
 * A script that prints a machine-readable report with `console.log` and then
 * calls `process.exit()` loses the tail of that report whenever its stdout is
 * *captured* rather than inherited. On a TTY, stdout flushes synchronously and
 * the script is fine; the moment a parent process reads it through a pipe —
 * which both `execFile` and `execFileSync` do by default — the exit races the
 * flush and wins.
 *
 * Measured on this container with a script that logs a payload of a given size
 * and then exits, read back through `execFile` with a 32 MB `maxBuffer`:
 *
 *   payload      trials   whole   bytes through
 *   1,000        1        1/1     1,037
 *   100,000      1        1/1     100,037
 *   200,000      6        0/6     146,176 x6
 *   500,000      6        0/6     146,176 x6
 *   1,000,000    6        0/6     146,176 x5, 182,720 x1
 *   5,000,000    6        0/6     146,176 x6
 *
 * The loss is total and reproducible above 200 KB. Where it cuts is NOT fixed:
 * 146,176 is only the modal value, and 182,720, 657,792 and 730,880 have all
 * been observed from the same probe. So nothing here asserts a byte count —
 * every end-to-end assertion below is "the whole report arrived and parsed",
 * with a payload comfortably past any cut point yet seen.
 *
 * TWO scripts in this repository are actually captured by a parent today:
 *
 *   scripts/build-manager-archetypes.mjs  <- server/services/scheduler.js:637, execFile
 *   scripts/luck-panel.mjs                <- scripts/build-manager-archetypes.mjs:50, execFileSync
 *
 * and both print an unbounded report (it grows with the number of leagues)
 * immediately before `process.exit(0)`. Those two are what this unit fixes.
 * `promote-weekly-ensemble.mjs`, `availability-decision-calibration.mjs` and
 * `import-alt-spreads.mjs` also end in `process.exit`, but no parent captures
 * any of them and none prints an unbounded report to stdout before exiting;
 * the evidence file records the reading rather than changing them.
 *
 * The control test is the load-bearing one: it spawns the OLD shape and
 * asserts the payload arrives damaged. Without it, every assertion here would
 * still pass on a machine where the race happened to be won.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeThenExit, printJsonThenExit } from '../scripts/lib/flush-then-exit.mjs';

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(REPO, 'scripts/lib/flush-then-exit.mjs');
const BIG = 32 * 1024 * 1024;

/** A report far past any cut point observed, so "whole" is a real claim. */
function bigReport() {
  return { summary: { managers: 12 }, rows: Array.from({ length: 4000 }, (_, i) => ({ i, pad: 'x'.repeat(240) })) };
}

/** A fake writable that records what it was handed and when it "flushed". */
function fakeStream({ flush = 'callback' } = {}) {
  const events = [];
  const handlers = new Map();
  return {
    events,
    once(name, fn) { handlers.set(name, fn); },
    emit(name, arg) { handlers.get(name)?.(arg); },
    write(text, cb) {
      events.push(['write', text]);
      if (flush === 'callback') cb();
      else if (flush === 'error-event') this.emit('error', new Error('EPIPE'));
      // flush === 'never' deliberately does nothing, to catch a hang.
    },
  };
}

function fakeExit(events) {
  return code => events.push(['exit', code]);
}

test('writeThenExit writes the text and only then exits', () => {
  const stream = fakeStream();
  writeThenExit('hello\n', { code: 0, stream, exit: fakeExit(stream.events) });
  assert.deepEqual(stream.events, [['write', 'hello\n'], ['exit', 0]]);
});

test('writeThenExit passes a non-zero code through', () => {
  const stream = fakeStream();
  writeThenExit('nope\n', { code: 1, stream, exit: fakeExit(stream.events) });
  assert.deepEqual(stream.events.at(-1), ['exit', 1]);
});

test('writeThenExit writes exactly once', () => {
  const stream = fakeStream();
  writeThenExit('once\n', { stream, exit: fakeExit(stream.events) });
  assert.equal(stream.events.filter(([kind]) => kind === 'write').length, 1);
});

test('writeThenExit exits on a stream error rather than hanging', () => {
  // A closed pipe must not leave the process alive forever waiting to flush.
  const stream = fakeStream({ flush: 'error-event' });
  writeThenExit('gone\n', { code: 3, stream, exit: fakeExit(stream.events) });
  assert.deepEqual(stream.events.at(-1), ['exit', 3]);
});

test('writeThenExit exits exactly once when a flush and an error both arrive', () => {
  const stream = fakeStream();
  writeThenExit('twice\n', { stream, exit: fakeExit(stream.events) });
  stream.emit('error', new Error('late EPIPE'));
  assert.equal(stream.events.filter(([kind]) => kind === 'exit').length, 1);
});

test('printJsonThenExit is byte-identical to console.log(JSON.stringify(v, null, 2))', () => {
  // The output is read by parsers that already exist, so the bytes must not move.
  const value = { summary: { managers: 12 }, jev: null };
  const stream = fakeStream();
  printJsonThenExit(value, { stream, exit: fakeExit(stream.events) });
  assert.equal(stream.events[0][1], `${JSON.stringify(value, null, 2)}\n`);
});

test('printJsonThenExit passes a non-zero code through', () => {
  const stream = fakeStream();
  printJsonThenExit({ ok: false }, { code: 2, stream, exit: fakeExit(stream.events) });
  assert.deepEqual(stream.events.at(-1), ['exit', 2]);
});

/* ---- end to end, through a real pipe ---------------------------------- */

const dir = mkdtempSync(path.join(tmpdir(), 'flush-then-exit-'));

const FIXED = path.join(dir, 'fixed.mjs');
writeFileSync(FIXED, `
import { printJsonThenExit } from ${JSON.stringify(HELPER)};
const rows = Array.from({ length: 4000 }, (_, i) => ({ i, pad: 'x'.repeat(240) }));
printJsonThenExit({ summary: { managers: 12 }, rows });
`);

const OLD = path.join(dir, 'old.mjs');
writeFileSync(OLD, `
const rows = Array.from({ length: 4000 }, (_, i) => ({ i, pad: 'x'.repeat(240) }));
console.log(JSON.stringify({ summary: { managers: 12 }, rows }, null, 2));
process.exit(0);
`);

test('CONTROL: the old shape loses its tail through execFile', async () => {
  // If this ever passes cleanly, every assertion below it is vacuous.
  const { stdout } = await run(process.execPath, [OLD], { maxBuffer: BIG });
  assert.throws(() => JSON.parse(stdout), SyntaxError,
    `the old shape delivered ${stdout.length} parseable bytes; the race was won, so the tests below prove nothing on this machine`);
});

test('the whole report survives execFile', async () => {
  const { stdout } = await run(process.execPath, [FIXED], { maxBuffer: BIG });
  const report = JSON.parse(stdout);
  assert.equal(report.rows.length, 4000);
  assert.equal(report.summary.managers, 12);
  assert.equal(stdout, `${JSON.stringify(bigReport(), null, 2)}\n`);
});

test('the whole report survives execFileSync, which is how luck-panel is read', () => {
  const stdout = execFileSync(process.execPath, [FIXED], { maxBuffer: BIG, encoding: 'utf8' });
  assert.equal(JSON.parse(stdout).rows.length, 4000);
});

test('the fixed shape still exits 0, so a caller reading the status sees success', async () => {
  const { stdout } = await run(process.execPath, [FIXED], { maxBuffer: BIG });
  assert.ok(stdout.length > 1_000_000, `report was only ${stdout.length} bytes`);
});

/* ---- the two captured scripts must route through the helper ----------- */

for (const script of ['scripts/luck-panel.mjs', 'scripts/build-manager-archetypes.mjs']) {
  test(`${script} prints its captured report through the helper, not console.log then exit`, () => {
    const src = readFileSync(path.join(REPO, script), 'utf8');
    // The CALL, not the import. An earlier version of this test asserted only
    // that the module path appeared in the source, and a mutation that put
    // console.log(JSON.stringify(...)) back while leaving the now-unused import
    // in place went undetected — which is exactly the regression a later edit
    // would make. The import alone proves nothing about what the script prints.
    assert.match(src, /printJsonThenExit\(/,
      `${script} does not call printJsonThenExit`);
    assert.match(src, /lib\/flush-then-exit\.mjs/,
      `${script} does not load the flush helper`);
    // The shape that caused this, in any form: a JSON report handed straight to
    // console.log. Neither script has another such call, so this is an absolute
    // rather than a proximity rule — proximity was the hole M8 walked through.
    assert.doesNotMatch(src, /console\.log\(JSON\.stringify\(/,
      `${script} still logs a JSON report through console.log, which does not flush before exit`);
  });
}
