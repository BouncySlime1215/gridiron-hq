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

function runSubject(thresholdMs, blockMs, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SUBJECT, String(thresholdMs), String(blockMs)],
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
