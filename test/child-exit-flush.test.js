/**
 * The producer half: the three children of refresh-live-data.mjs flush before
 * they exit (2026-09-22).
 *
 * `docs/tdd/2026-09-22-child-report-never-arrived.md` fixed the CONSUMER: the
 * parent no longer reads a lost report as a success. This fixes the producers,
 * so there is less often a lost report to read.
 *
 * All three end in a bare `process.exit(...)` with output still buffered, and
 * all three are captured through a pipe by `refresh-live-data.mjs` (`:99`,
 * `:114`, `:220`, all `spawnSync`). Measured on this container, a script that
 * prints 8,000 lines and then calls `process.exit(0)`, read back through
 * `execFile`:
 *
 *   process.exit(0)          2,812 / 3,311 / 2,435 / 1,433 lines of 8,000
 *   writeThenExit('', {code}) 8,000 / 8,000 / 8,000 / 8,000
 *
 * Note the shape: with many small lines the loss is PARTIAL and varies run to
 * run, where the single-large-payload case measured earlier was total above
 * 200 KB. Same cause, and the same conclusion — never assert a byte or line
 * count as the cliff. Every assertion below is "all of it arrived".
 *
 * These scripts have nothing left to print at the exit, so the fix is a flush
 * with an empty write: stream writes are ordered, so an empty chunk's callback
 * fires only after everything queued before it has drained. That is measured
 * above, not assumed — it is the whole reason `exitWhenFlushed` can be a
 * one-line change at each call site.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exitWhenFlushed } from '../scripts/lib/flush-then-exit.mjs';

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(REPO, 'scripts/lib/flush-then-exit.mjs');
const BIG = 64 * 1024 * 1024;
const LINES = 8000;

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
    },
  };
}
const fakeExit = events => code => events.push(['exit', code]);

test('exitWhenFlushed exits only after the stream has flushed', () => {
  const stream = fakeStream();
  exitWhenFlushed(0, { stream, exit: fakeExit(stream.events) });
  assert.deepEqual(stream.events, [['write', ''], ['exit', 0]]);
});

test('exitWhenFlushed adds nothing to the output', () => {
  // A stray byte would land in the middle of a report another process parses.
  const stream = fakeStream();
  exitWhenFlushed(0, { stream, exit: fakeExit(stream.events) });
  assert.equal(stream.events[0][1], '', 'the flush wrote something of its own');
});

test('exitWhenFlushed carries a non-zero code', () => {
  const stream = fakeStream();
  exitWhenFlushed(1, { stream, exit: fakeExit(stream.events) });
  assert.deepEqual(stream.events.at(-1), ['exit', 1]);
});

test('exitWhenFlushed exits on a stream error rather than hanging', () => {
  const stream = fakeStream({ flush: 'error-event' });
  exitWhenFlushed(2, { stream, exit: fakeExit(stream.events) });
  assert.deepEqual(stream.events.at(-1), ['exit', 2]);
});

/* ---- end to end, through a real pipe ---------------------------------- */

const dir = mkdtempSync(path.join(tmpdir(), 'child-exit-flush-'));
const body = `for (let i = 0; i < ${LINES}; i += 1) console.log(\`line \${i} \${'x'.repeat(120)}\`);\n`;

const FIXED = path.join(dir, 'fixed.mjs');
writeFileSync(FIXED, `import { exitWhenFlushed } from ${JSON.stringify(HELPER)};\n${body}exitWhenFlushed(0);\n`);

const OLD = path.join(dir, 'old.mjs');
writeFileSync(OLD, `${body}process.exit(0);\n`);

const NONZERO = path.join(dir, 'nonzero.mjs');
writeFileSync(NONZERO, `import { exitWhenFlushed } from ${JSON.stringify(HELPER)};\n${body}exitWhenFlushed(1);\n`);

const countLines = s => s.split('\n').filter(Boolean).length;

test('CONTROL: the old shape loses output through a pipe', async () => {
  // If this ever passes cleanly, every assertion below it is vacuous.
  const { stdout } = await run(process.execPath, [OLD], { maxBuffer: BIG });
  assert.notEqual(countLines(stdout), LINES,
    `the old shape delivered all ${LINES} lines; the race was won, so the tests below prove nothing here`);
});

test('every line survives the exit', async () => {
  const { stdout } = await run(process.execPath, [FIXED], { maxBuffer: BIG });
  assert.equal(countLines(stdout), LINES);
  assert.match(stdout, new RegExp(`^line ${LINES - 1} `, 'm'), 'the last line is the one truncation takes first');
});

test('a non-zero exit code still reaches the caller, with all its output', async () => {
  // The code matters as much as the bytes: refresh-live-data.mjs branches on it.
  const err = await run(process.execPath, [NONZERO], { maxBuffer: BIG }).then(() => null, e => e);
  assert.ok(err, 'the fixture exited 0; the code was swallowed');
  assert.equal(err.code, 1);
  assert.equal(countLines(err.stdout), LINES);
});

/* ---- the three scripts must route their exit through the helper -------- */

for (const script of [
  'scripts/collect-league-transactions.mjs',
  'scripts/collect-roster-snapshots.mjs',
  'scripts/build-manager-signals.mjs',
]) {
  test(`${script} flushes before it exits`, () => {
    const src = readFileSync(path.join(REPO, script), 'utf8');
    assert.match(src, /exitWhenFlushed\(/, `${script} does not call exitWhenFlushed`);
    assert.match(src, /lib\/flush-then-exit\.mjs/, `${script} does not load the flush helper`);
    // The shape being removed, in any form: a bare process.exit that ends the
    // script with output still queued behind it.
    assert.doesNotMatch(src, /\n\s*process\.exit\(/,
      `${script} still calls process.exit directly, which does not flush a pipe`);
  });
}
