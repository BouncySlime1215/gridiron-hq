/**
 * The scheduler must tell the watchdog which jobs are running, for exactly as
 * long as each job's own code runs (2026-09-22).
 *
 * The kill-line tests in loop-watchdog.test.js mark jobs by hand, so they show
 * that the watchdog PRINTS what it is told. These show that the scheduler tells
 * it the truth. Each test runs synthetic jobs through the real runIfStale ->
 * runJobNow path in a child process (fixtures/watchdog-scheduler-subject.mjs),
 * and the real watchdog then kills that child.
 *
 * They replace four tests that read scheduler.js as text. Those tests checked
 * where the calls sat, and two real defects passed them. The first was a clear
 * that never ran for inline jobs: `if (offThread) clearJobRunning(name)` passed
 * 4 of 4. The second was a clear in runJobNow's `finally` that erased a job
 * after its budget had abandoned it while its code was still running. One of
 * the text tests required that second defect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUBJECT = fileURLToPath(new URL('./fixtures/watchdog-scheduler-subject.mjs', import.meta.url));

/** Runs one scenario in a child process with its own throwaway database. */
function runScenario(scenario) {
  // Its own database, not the suite's: a child killed mid-job leaves a
  // 'running' sync_log row behind, and the next boot's reaper would find it.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gridiron-watchdog-marker-'));
  const env = { ...process.env, SCHEDULER_DISABLED: '1', GRIDIRON_DB_INTEGRITY_CHECK: 'off',
    GRIDIRON_DB_PATH: path.join(dir, 'marker.sqlite') };
  delete env.LOOP_WATCHDOG_DISABLED;
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SUBJECT, scenario], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', (code, signal) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const NO_JOB = /No job was marked as running on this thread/;
const killed = r => `expected a kill, got exit ${r.code}; stdout: ${r.stdout}; stderr: ${r.stderr}`;

/* ------------------------------------------- a finished job is not named */

test('an inline job that returned is not named when the loop later blocks', async () => {
  const r = await runScenario('returned-then-block');
  assert.equal(r.signal, 'SIGKILL', killed(r));
  assert.match(r.stdout, /returned: \{"job":"synthetic_returned","ran":true,"detail":\{"ok":true\}/,
    `the job must have run and returned first; got: ${r.stdout}`);
  assert.match(r.stderr, NO_JOB, `got: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /synthetic_returned/,
    'a job that returned must not be named: a stale marker blames the wrong job');
});

test('an inline job that threw is not named when the loop later blocks', async () => {
  const r = await runScenario('threw-then-block');
  assert.equal(r.signal, 'SIGKILL', killed(r));
  assert.match(r.stdout, /threw: \{"job":"synthetic_threw","ran":true,"error":"synthetic failure"/,
    `the job must have run and thrown first; got: ${r.stdout}`);
  assert.match(r.stderr, NO_JOB, `got: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /synthetic_threw/, 'a job that threw is as finished as one that returned');
});

/* ------------------------------------------ a job that blocks is named */

test('an inline job that blocks the loop after an await is named', async () => {
  const r = await runScenario('blocks-after-await');
  assert.equal(r.signal, 'SIGKILL', killed(r));
  assert.match(r.stderr, /The job running when it stopped was 'synthetic_blocks'\. /, `got: ${r.stderr}`);
});

test('an inline job that blocks the loop before its first await is named', async () => {
  // The marker has to be written BEFORE the job is called. A job that blocks
  // at once never gives the thread back to write one afterwards.
  const r = await runScenario('blocks-at-once');
  assert.equal(r.signal, 'SIGKILL', killed(r));
  assert.match(r.stderr, /The job running when it stopped was 'synthetic_blocks'\. /, `got: ${r.stderr}`);
});

/* ------------------------------ a job the budget abandoned is still named */

/*
 * withJobTimeout is a Promise.race. When the budget runs out it stops WAITING
 * for the job. It does not stop the job, whose code carries on on this thread.
 * A marker cleared when the race settled therefore erased a job that was still
 * running. When that job then blocked the loop, the kill line said no job was
 * running and pointed at a request path, or it named whichever innocent job
 * the tier had moved on to.
 *
 * This path is real. scheduler.js records evidence_daemon on the deployed app
 * with 29 runs, every one abandoned at its 120s budget, and nfl_reports with
 * the same error. Both have since moved off-thread. nfl_decision_ledger, the
 * job behind the 2026-09-22 kills that started F-03, still runs inline on the
 * default 120s budget. Timing out and blocking the loop happen to the same
 * heavy jobs.
 */
test('a job abandoned at its budget is named when its own code blocks, and a finished job is not', async () => {
  const r = await runScenario('abandoned-then-next-returned');
  assert.equal(r.signal, 'SIGKILL', killed(r));
  assert.match(r.stdout, /culprit: .*"error":"job 'synthetic_culprit' exceeded its \d+s budget and was abandoned/,
    `the budget must have abandoned the job first; got: ${r.stdout}`);
  assert.match(r.stdout, /next: \{"job":"synthetic_next","ran":true,"detail":\{"ok":true\}/,
    `the tier must have run the next job to completion; got: ${r.stdout}`);
  assert.match(r.stderr,
    /The job running when it stopped was 'synthetic_culprit' \(abandoned at its budget \d+s ago, still running\)\. /,
    `the abandoned job's code is what blocked, and it must be named as abandoned; got: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /synthetic_next/, 'the job that finished must not be named');
});

test('a job abandoned at its budget is named beside the job the tier moved on to', async () => {
  // The marker cannot tell which of two in-flight jobs holds the thread, and
  // the kill line does not pretend to. It names both, and it says which one
  // the budget abandoned. Before the fix it named only the bystander.
  const r = await runScenario('abandoned-while-next-awaits');
  assert.equal(r.signal, 'SIGKILL', killed(r));
  assert.match(r.stdout, /culprit: .*exceeded its \d+s budget and was abandoned/, `got: ${r.stdout}`);
  assert.match(r.stderr, /The jobs running when it stopped were /, `got: ${r.stderr}`);
  assert.match(r.stderr, /'synthetic_culprit' \(abandoned at its budget \d+s ago, still running\)/,
    `the job that blocked must be named; got: ${r.stderr}`);
  assert.match(r.stderr, /'synthetic_bystander'/, `the job still awaiting I/O is running too; got: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /'synthetic_bystander' \(abandoned/,
    'only the job the budget gave up on is marked abandoned');
});

test('a re-run of an abandoned job does not erase the copy that is still running', async () => {
  // runIfStale's in-flight guard ends when the budget gives up, so the same
  // job can start again while its abandoned copy still runs. A marker kept per
  // NAME is cleared by whichever copy finishes first. It has to be per run.
  const r = await runScenario('abandoned-then-rerun');
  assert.equal(r.signal, 'SIGKILL', killed(r));
  assert.match(r.stdout, /first: .*exceeded its \d+s budget and was abandoned/, `got: ${r.stdout}`);
  assert.match(r.stdout, /second: \{"job":"synthetic_culprit","ran":true,"detail":\{"call":2\}/,
    `the second copy must have run and returned; got: ${r.stdout}`);
  assert.match(r.stderr,
    /The job running when it stopped was 'synthetic_culprit' \(abandoned at its budget \d+s ago, still running\)\. /,
    `got: ${r.stderr}`);
});

/* ---------------------------------------- an off-thread job is never named */

test('an off-thread job in flight is not named when something else blocks the loop', async () => {
  // A worker-thread job cannot block this thread. Naming it would point the
  // stall at the wrong suspect, which is the misdirection the marker exists to
  // end.
  const r = await runScenario('off-thread-while-main-blocks');
  assert.equal(r.signal, 'SIGKILL', killed(r));
  assert.match(r.stdout, /worker job status: running/,
    `the off-thread job must be in flight in its worker when the loop blocks; got: ${r.stdout}`);
  assert.match(r.stderr, NO_JOB, `got: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /synthetic_worker/, 'an off-thread job must not be named');
});
