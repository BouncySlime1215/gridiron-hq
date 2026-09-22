/**
 * When each pass first fires after boot (2026-09-20).
 *
 * These numbers are the arithmetic behind
 * docs/scheduler-what-actually-fires.md, which says which jobs have never run
 * once on the deployed build and why. That document's whole argument is a
 * comparison between when a pass first fires and how long the process lives,
 * so if any of these constants moves the document becomes wrong without
 * anything failing.
 *
 * Read from the source text rather than by starting a scheduler, because
 * starting one would take the five minutes the last assertion is about.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const SCHEDULER = src('../server/services/scheduler.js');
const INDEX = src('../server/index.js');

test('the server starts the background tier on a five-minute interval', () => {
  // The default in startScheduler's signature is 30; the deployment does not
  // use it. Reading the default instead of the call site is how a document
  // about the live machine ends up describing a different machine.
  assert.match(INDEX, /startScheduler\(\{\s*intervalMinutes:\s*5\b/,
    'server/index.js must still start the scheduler with intervalMinutes: 5; '
    + 'docs/scheduler-what-actually-fires.md is arithmetic on this number');
});

test('the background tier fires on intervalMinutes, not on its own constant', () => {
  assert.match(SCHEDULER,
    /timer = tier\('background', \[\.\.\.growth, \.\.\.metered, \.\.\.heavy\], intervalMinutes \* 60000\)/);
});

test('the live tier fires every 90 seconds', () => {
  assert.match(SCHEDULER, /liveIntervalSeconds = 90\b/);
  assert.match(SCHEDULER, /liveTimer = tier\('live', live, liveIntervalSeconds \* 1000\)/);
});

test('the boot pass, the growth pass and the reports pass keep their delays', () => {
  assert.match(SCHEDULER, /bootDelayMs = 20000\b/, 'boot pass at 20s');
  assert.match(SCHEDULER, /Math\.max\(90000, bootDelayMs \+ 60000\)/, 'nfl_model_growth at 90s');
  assert.match(SCHEDULER, /Math\.max\(150000, bootDelayMs \+ 120000\)/, 'nfl_reports at 150s');
});

test('no tier has a leading call, so nothing in it runs before its first tick', () => {
  // setInterval alone. If a leading call were ever added, every growth and
  // metered job would run at boot instead of at t+300s, and the document's
  // central claim — that they have never run — would stop being true without
  // a word of it changing.
  assert.doesNotMatch(SCHEDULER, /const tier = [\s\S]{0,2000}?runIfStale[\s\S]{0,200}?setInterval/,
    'tier() must remain setInterval-only, with no immediate first pass');
});

test('the heavy tier is still gated on AUTO_HEAVY_SYNC', () => {
  assert.match(SCHEDULER,
    /const heavy = process\.env\.AUTO_HEAVY_SYNC === '1' \? jobsInTier\('heavy'\) : \[\]/,
    'twelve heavy jobs have run zero times because this flag is unset; that is the '
    + 'flag working, and the document says so only while this line says so');
});
