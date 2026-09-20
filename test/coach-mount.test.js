/**
 * Coach is mounted on the real application.
 *
 * `test/coach-route.test.js` mounts the router on a bare express app, which
 * proves the router works and proves nothing about whether anything serves it.
 * That is not a hypothetical gap: this router existed, tested and green, for
 * several commits while `server/index.js` did not import it, so every one of
 * those test runs passed with Coach unreachable in the running app.
 *
 * So this boots `server/index.js` the way `scripts/start-smoke.mjs` does — a
 * real child process, a temp database, a real socket — and asks it for Coach.
 * A mount dropped in a merge fails here rather than in production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-mount-'));
const port = Number(process.env.GRIDIRON_COACH_MOUNT_PORT) || (40000 + process.pid % 20000);
const base = `http://127.0.0.1:${port}`;

let child;
let output = '';

test.before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, API_PORT: String(port), GRIDIRON_DB_PATH: path.join(temp, 'mount.sqlite'),
      SCHEDULER_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode != null) throw new Error(`the application exited with ${child.exitCode}\n${output}`);
    try {
      const probe = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
      if (probe.ok && (await probe.json())?.ok === true) return;
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  throw new Error(`the application never reported healthy on ${base}\n${output}`);
});

test.after(() => { child?.kill('SIGKILL'); });

test('the running application serves Coach, and asks who is calling', async () => {
  // No token: 401 from the router's own requireAuthenticated. A 404 here means
  // the mount is gone, which is the failure this file exists to catch, and the
  // two are worth telling apart in the message.
  const anonymous = await fetch(`${base}/api/coach/catalog`, { signal: AbortSignal.timeout(5000) });
  assert.notEqual(anonymous.status, 404,
    'GET /api/coach/catalog is not mounted on the application');
  assert.equal(anonymous.status, 401, await anonymous.text());
});

test('a signed-in caller gets the catalog, so the mount reaches the real service', async () => {
  const session = await (await fetch(`${base}/api/auth/local-session`,
    { method: 'POST', signal: AbortSignal.timeout(5000) })).json();
  assert.ok(session?.token, `could not mint a local session: ${JSON.stringify(session)}`);

  const response = await fetch(`${base}/api/coach/catalog`, {
    headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(10_000) });
  // Read the body once: it is both the failure message and the assertion's
  // subject, and consuming it twice throws before the assertion runs.
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  assert.ok(Array.isArray(body.tables) && body.tables.length > 0, 'the catalog came back empty');
  assert.ok(body.coverage?.catalogued > 0, 'coverage does not say how much Coach can see');
  assert.ok(body.coverage.in_database > body.coverage.catalogued,
    'coverage must state the gap, not just the part Coach reads');
});

test('the ask endpoint is reachable and refuses an empty question, rather than 404', async () => {
  const session = await (await fetch(`${base}/api/auth/local-session`,
    { method: 'POST', signal: AbortSignal.timeout(5000) })).json();
  // An empty question is rejected before any model call, so this exercises the
  // mount and the handler's own validation without spending anything.
  const response = await fetch(`${base}/api/coach/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ question: '   ' }),
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  assert.equal(response.status, 400, text);
  assert.match(JSON.parse(text).error, /question/i);
});
