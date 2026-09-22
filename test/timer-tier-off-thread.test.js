/**
 * The boot path is not the only path (2026-09-19).
 *
 * The change before this one put the boot path off the request thread with a
 * per-call override. That covers the two delayed timers and the boot pass, and
 * it covers nothing else: the background tier calls `runIfStale(j)` with no
 * override at all, every five minutes, so `resolveOffThread` falls back to
 * `job.offThread ?? job.tier === 'heavy'`. For a growth-tier job with no flag
 * that is false.
 *
 * So `nfl_model_growth` — the job measured blocking the loop past the 60s
 * watchdog fuse on seven consecutive boots — would have gone straight back
 * onto the request thread the first time its six-hour cadence came due on a
 * machine that stayed up. Which is exactly the state the rest of this work
 * exists to produce. A fix that only holds until it succeeds is not a fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-timer-tier-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const scheduler = await import('../server/services/scheduler.js');
const SRC = fs.readFileSync(new URL('../server/services/scheduler.js', import.meta.url), 'utf8');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('the measured blocker runs off-thread with no override in sight', () => {
  // resolveOffThread called the way the tier timer calls it: no second argument.
  assert.equal(scheduler.resolveOffThread(scheduler.JOBS.nfl_model_growth), true,
    'the boot override does not reach the background tier; only the job flag does');
});

test('the tier timer passes no override, so the flag is the only thing deciding', () => {
  const tierFn = SRC.slice(SRC.indexOf('const tier = (label, jobs, everyMs)'));
  const pass = tierFn.slice(0, tierFn.indexOf('};'));
  assert.match(pass, /for \(const j of jobs\) await runIfStale\(j\)/,
    'if this call ever grows an override, this test is the place to decide what it should be — ' +
    'and until it does, a job blocks the request thread unless its own offThread flag says otherwise');
});

test('a job cannot be allow-listed as main-thread-only and flagged off-thread at once', () => {
  for (const name of scheduler.MAIN_THREAD_ONLY.keys()) {
    const job = scheduler.JOBS[name];
    assert.ok(job, `${name} is allow-listed but is not a job`);
    assert.notEqual(job.offThread, true,
      `${name} is named as needing the main thread and also flagged off-thread — one of the two is wrong, ` +
      'and the boot path and the tier timer would disagree about which');
    assert.equal(scheduler.resolveOffThread(job), false,
      `${name} must stay on the main thread on every path, not only the boot path`);
  }
});

test('the reason a job is off-thread is written next to the flag, not only in a commit', () => {
  const entry = SRC.indexOf('nfl_model_growth: { run: refreshNflModelGrowth');
  assert.ok(entry > 0);
  const preceding = SRC.slice(Math.max(0, entry - 1400), entry);
  assert.match(preceding, /background tier|BACKGROUND TIER/,
    'the next person to read this entry needs to know the boot override does not cover it');
});
