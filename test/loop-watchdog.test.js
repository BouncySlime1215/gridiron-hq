/**
 * The process must kill itself when the event loop stops turning (2026-09-19).
 *
 * The app was wedged for over three hours and nothing recovered it. An HTTP
 * health check makes that visible, but visibility is not recovery: on Fly,
 * health checks and the restart policy are independent — a failing check stops
 * traffic being routed to a machine and never restarts it. Only a process exit
 * does, under the default `on-failure` policy. So the exit has to come from
 * inside.
 *
 * These tests run a real child process, because the thing being tested is a
 * process dying, and because a watchdog that fired in-process would take the
 * test runner with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const SUBJECT = path.join(process.cwd(), 'test/fixtures/watchdog-subject.mjs');

function runSubject(thresholdMs, blockMs, env = {}, mode = 'served', jobName = null) {
  return new Promise(resolve => {
    const child = spawn(process.execPath,
      [SUBJECT, String(thresholdMs), String(blockMs), mode, ...(jobName ? [jobName] : [])],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('a blocked event loop gets the process killed, during the block', async () => {
  // Blocks for 4s against a 1s threshold. The kill has to land while the main
  // thread is still blocked -- that is the whole point, and a watchdog on the
  // main thread could not do it.
  const { signal, stdout, stderr } = await runSubject(1000, 4000);

  assert.equal(signal, 'SIGKILL', `expected the process to be killed, got ${signal}; stdout: ${stdout}`);
  assert.equal(stdout.includes('survived'), false,
    'the process finished its block, so the kill came too late to be useful');
  assert.match(stderr, /event loop has not turned/,
    'the restart must be explained in the logs, or nobody will know why it happened');
});

test('a pause well inside the threshold is left alone', async () => {
  const { code, signal, stdout } = await runSubject(5000, 500);

  assert.equal(signal, null, 'a short synchronous pause is normal and must not restart the app');
  assert.equal(code, 0);
  assert.match(stdout, /survived/);
});

test('LOOP_WATCHDOG_DISABLED turns it off completely', async () => {
  const { code, signal, stdout } = await runSubject(1000, 3000, { LOOP_WATCHDOG_DISABLED: '1' });

  assert.equal(signal, null, 'the escape hatch has to actually work, or it is not an escape hatch');
  assert.equal(code, 0);
  assert.match(stdout, /survived/);
});

test('the watchdog does not hold the process open', async () => {
  // Nothing to block and nothing else running: if the worker or the heartbeat
  // were ref'd, this would hang until the test timeout instead of exiting.
  const { code, signal } = await runSubject(60000, 0);
  assert.equal(signal, null);
  assert.equal(code, 0);
});

test('an arm that arrives before the watchdog starts is not lost', async () => {
  // THE ORDER ON THE DEPLOYED MACHINE. startScheduler calls onBootComplete
  // synchronously when SCHEDULER_DISABLED=1, and that is before app.listen,
  // where the watchdog starts. If an arm that lands in that window is dropped,
  // the process is unwatched for good -- and on an app nobody visits, nothing
  // ever arms it again, so a wedge is permanent.
  //
  // This is the observable proof for it. The source-level test in
  // watchdog-arming-sources.test.js cannot see internal arming state; this
  // child process either dies or does not.
  const { signal, stdout } = await runSubject(1000, 4000, {}, 'armed-early');

  assert.equal(signal, 'SIGKILL',
    `an arm before startLoopWatchdog must still count; got ${signal}; stdout: ${stdout}`);
  assert.equal(stdout.includes('survived'), false);
});

test('a process that has never served a response is never killed, however long it blocks', async () => {
  // THE MOST IMPORTANT CASE. This app's boot continues well past app.listen --
  // the scheduler fires twenty boot jobs twenty seconds in, on the main thread
  // -- and a cold start on the deployed machine was measured at about three
  // minutes to first byte. A watchdog armed by a timer would kill a process
  // that is still starting, and one slow boot would become an endless restart
  // loop: strictly worse than the wedge being guarded against. So arming is
  // proof (a completed HTTP response), never an assumption.
  const { code, signal, stdout } = await runSubject(1000, 3000, {}, 'never-served');

  assert.equal(signal, null, 'killing a process that has never served anything turns a slow boot into a restart loop');
  assert.equal(code, 0);
  assert.match(stdout, /survived/);
});

/* --------------------------------------------- the kill line names the job */

/*
 * Why this matters enough to spawn a real process for it: this project spent
 * days arguing from timing about which of two dozen live-tier jobs was blocking
 * the loop, because the kill line said only that the loop had stopped. The
 * marker is written into shared memory before each job so the watching thread
 * can read it while the main thread is wedged and unable to answer anything.
 *
 * Asserted against a real SIGKILL rather than by calling the worker's
 * formatter, because the thing that has failed here before was not the
 * wording -- it was the line never reaching the logs at all.
 */
test('the kill line names the job that was running', async () => {
  const { signal, stderr } = await runSubject(1000, 4000, {}, 'served', 'nfl_model_growth');
  assert.equal(signal, 'SIGKILL', `expected a kill, got stderr: ${stderr}`);
  assert.match(stderr, /event loop has not turned/);
  assert.match(stderr, /The job running when it stopped was 'nfl_model_growth'/,
    `the kill line must name the marked job; got: ${stderr}`);
});

test('the kill line says so plainly when no job was marked', async () => {
  // The honest alternative to naming a job is saying that none was marked --
  // not silence, and not the previous job's name. A stall with no job running
  // is a different and equally real finding: it means something outside the
  // scheduler blocked the thread.
  const { signal, stderr } = await runSubject(1000, 4000);
  assert.equal(signal, 'SIGKILL', `expected a kill, got stderr: ${stderr}`);
  assert.match(stderr, /No job was marked as running/,
    `expected the no-job wording; got: ${stderr}`);
  // And it says what that means, so the reader goes to the request path
  // rather than the scheduler.
  assert.match(stderr, /outside the scheduler/,
    `the no-job line must point away from the scheduler; got: ${stderr}`);
  assert.doesNotMatch(stderr, /The job running when it stopped was/);
});

/*
 * 2026-09-22: the live tier and the background tier run on separate timers,
 * so jobs overlap. With a single marker slot, the job that finished first
 * cleared the name of the job still running, and the kill line then said "no
 * job" while a job held the thread -- sending the reader to the request path,
 * which is the wrong suspect.
 */
test('a job that finishes does not erase the name of one still running', async () => {
  const { signal, stderr } = await runSubject(1000, 4000, {}, 'served',
    '+nfl_decision_ledger,+player_rosters,-player_rosters');
  assert.equal(signal, 'SIGKILL', `expected a kill, got stderr: ${stderr}`);
  assert.match(stderr, /The job running when it stopped was 'nfl_decision_ledger'/,
    `the still-running job must be named; got: ${stderr}`);
  assert.doesNotMatch(stderr, /player_rosters/, 'a finished job must not be named');
});

/*
 * The mirror image of the test above, and the order the slots exist for: the
 * job marked FIRST finishes first. A clear that ignored which job it was given
 * and freed the most recently marked slot passed every other test in this file
 * (skeptic mutant U7, 2026-09-22). It erased the running job and left the
 * finished one's name in the kill line.
 */
test('a job that finishes first leaves the name of the job marked after it', async () => {
  const { signal, stderr } = await runSubject(1000, 4000, {}, 'served',
    '+nfl_decision_ledger,+player_rosters,-nfl_decision_ledger');
  assert.equal(signal, 'SIGKILL', `expected a kill, got stderr: ${stderr}`);
  assert.match(stderr, /The job running when it stopped was 'player_rosters'\. /,
    `the still-running job must be named; got: ${stderr}`);
  assert.doesNotMatch(stderr, /nfl_decision_ledger/, 'a finished job must not be named');
});

test('the kill line names every job running at once, not only the last one marked', async () => {
  const { signal, stderr } = await runSubject(1000, 4000, {}, 'served',
    '+nfl_decision_ledger,+player_rosters');
  assert.equal(signal, 'SIGKILL', `expected a kill, got stderr: ${stderr}`);
  assert.match(stderr, /The jobs running when it stopped were /,
    `expected the plural wording; got: ${stderr}`);
  assert.match(stderr, /'nfl_decision_ledger'/, `got: ${stderr}`);
  assert.match(stderr, /'player_rosters'/, `got: ${stderr}`);
});

/*
 * More runs than slots. A run abandoned at its budget keeps its slot until its
 * own code returns, so running out of slots is likelier than it was. Runs with
 * no slot must still be counted, and a cleared one must stop being counted.
 * Written without the slot count, so resizing the table does not break it.
 */
test('runs beyond the last slot are counted rather than dropped', async () => {
  const names = Array.from({ length: 40 }, (_, i) => `job_${String(i + 1).padStart(2, '0')}`);
  // Mark 40, then clear the last, which is certainly one of the runs with no slot.
  const steps = [...names.map(n => `+${n}`), `-${names[39]}`].join(',');
  const { signal, stderr } = await runSubject(1000, 4000, {}, 'served', steps);
  assert.equal(signal, 'SIGKILL', `expected a kill, got stderr: ${stderr}`);
  const m = stderr.match(/The jobs running when it stopped were (.*?), (\d+) more the marker had no slot for\. /);
  assert.ok(m, `expected named runs followed by a count; got: ${stderr}`);
  const named = m[1].split(', ');
  assert.equal(named.length + Number(m[2]), 39, `39 runs are still marked; got: ${stderr}`);
  assert.deepEqual(named, names.slice(0, named.length).map(n => `'${n}'`),
    'the first runs marked hold the slots, in the order they were marked');
});
