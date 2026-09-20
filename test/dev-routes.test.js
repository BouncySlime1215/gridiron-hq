/**
 * The diagnostic surface, and the things it was recording and never showing
 * (2026-09-20).
 *
 * The wiring map's sweep found four uncalled routes on `/api/dev` and a set of
 * fields attached and never read. Those two look like the same finding and are
 * not, so the tests below hold the distinction rather than the count:
 *
 *   - `GET /dev/usage` was a genuine duplicate. `/dev/status` already answers
 *     `usageSummary(30)`; the only thing `/dev/usage` added was a `?days=`
 *     parameter no caller ever passed. It is gone.
 *   - The three player-identity dry-runs are uncalled on purpose. Deleting a
 *     read-only diagnostic because nothing calls it today is how an install
 *     loses the tool in the hour it needs it. They are pinned here instead, so
 *     "uncalled" stops meaning "unwatched".
 *   - `platform/jobs.js` maintained status, lastRunAt, lastError and runCount
 *     on every tick and had no reader at all. Its two registrations are the
 *     draft auto-pick clock and the finalize watch, so the field that mattered
 *     was `lastError`: a draft clock could fail every tick, during a live
 *     draft, and say so to nobody. `/dev/status` serves it now.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ServerResponse } from 'node:http';
import { Readable, PassThrough } from 'node:stream';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-dev-routes-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { default: devRouter } = await import('../server/routes/dev.js');
const { registerJob, cancelJob, jobStatus, listJobs } = await import('../server/platform/jobs.js');
const paths = await import('../server/platform/paths.js');

const app = express();
app.use(express.json());
app.use('/api/dev', devRouter);

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

async function get(url) {
  const req = new Readable({ read() { this.push(null); } });
  req.url = url; req.method = 'GET'; req.headers = {};
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      let json = null; try { json = JSON.parse(body); } catch { /* not JSON */ }
      resolve({ status: res.statusCode, body, json });
    };
    // The app mounts one router and no 404 handler, so an unmatched path calls
    // `next()` with no argument rather than answering. That IS the 404 — read
    // it as one instead of rejecting, or "the route is gone" arrives as an
    // unhandled `undefined`.
    app.handle(req, res, err => (err ? reject(err) : resolve({ status: 404, body: '', json: null })));
  });
}

test('the duplicate usage route is gone and its data is still on /dev/status', async () => {
  assert.equal((await get('/api/dev/usage')).status, 404,
    '/dev/usage duplicated /dev/status and had a ?days= parameter no caller passed');
  const status = await get('/api/dev/status');
  assert.equal(status.status, 200);
  assert.ok(status.json.usage, 'deleting the duplicate must not delete the data — '
    + '/dev/status has always carried the same usageSummary(30)');
});

test('the uncalled diagnostics still answer, which is why they are kept', async () => {
  // Pinned rather than deleted. If one of these ever stops answering, this
  // fails — which is the only real risk of a route nothing calls.
  for (const p of ['/api/dev/player-identity/repair-plan',
    '/api/dev/player-identity/gsis-conflicts',
    '/api/dev/player-identity/team-position-duplicates',
    '/api/dev/sources']) {
    const r = await get(p);
    assert.equal(r.status, 200, `${p} must answer`);
    assert.notEqual(r.json, null, `${p} must answer with JSON`);
  }
});

test('/dev/sources is the only inventory of every source and its staleness', async () => {
  // Uncalled by the client, and the one endpoint that already answers the
  // question this project keeps asking: which sources are stale right now.
  const r = await get('/api/dev/sources');
  assert.ok(Number.isInteger(r.json.count) && r.json.count > 0);
  assert.ok(Array.isArray(r.json.sources));
  assert.ok(Number.isInteger(r.json.stale), 'it must report how many are stale, not just list them');
});

test('/dev/status serves the background job status that nothing used to read', async () => {
  const before = await get('/api/dev/status');
  assert.ok(Array.isArray(before.json.background_jobs),
    'platform/jobs.js maintained this on every tick with no reader anywhere');

  // An interval long enough that it never fires during this test — the point
  // is the registration being visible, not the job running.
  registerJob('__test_visible_job', { intervalMs: 60_000, run: async () => {} });
  try {
    const during = await get('/api/dev/status');
    const seen = during.json.background_jobs.find(j => j.name === '__test_visible_job');
    assert.ok(seen, 'a registered job must be visible on the diagnostic surface');
    assert.equal(seen.status, 'running');
    // lastError is the field that mattered: the two real registrations are the
    // draft auto-pick clock and the finalize watch.
    assert.ok('lastError' in seen, 'lastError must reach a reader, or a failing draft clock is silent');
    assert.ok('lastRunAt' in seen && 'runCount' in seen);
    assert.ok(!('timer' in seen) && !('run' in seen),
      'the timer handle and the closure must not be serialized into an HTTP response');
  } finally {
    cancelJob('__test_visible_job');
  }
});

test('a cancelled job is visible by absence, not by a status nobody can observe', () => {
  registerJob('__test_cancel_job', { intervalMs: 60_000, run: async () => {} });
  assert.equal(jobStatus('__test_cancel_job').status, 'running');

  assert.equal(cancelJob('__test_cancel_job'), true);
  // `state.status = 'cancelled'` used to be written here, onto an object
  // dropped from the map on the very next line. Nothing could ever read it, so
  // the value existed only to be believed later.
  assert.equal(jobStatus('__test_cancel_job'), null,
    'a cancelled job must not be reportable as anything but gone');
  assert.equal(listJobs().some(j => j?.name === '__test_cancel_job'), false);
  assert.equal(cancelJob('__test_cancel_job'), false, 'and cancelling twice must be honest about it');
});

test('paths.js exports the roots it can be asked about, and no unused join helpers', () => {
  // The module's header says it exists so a packaging test can ASK where
  // things resolved to. resolvedRoots() is where that promise is kept, so an
  // unused ROOT is defensible and an unused wrapper around path.join is not.
  const roots = paths.resolvedRoots();
  for (const name of ['project', 'server', 'data', 'docs', 'evidence', 'research',
    'migrations', 'canonical_plan']) {
    assert.ok(roots[name], `${name} must be answerable through resolvedRoots()`);
  }
  assert.equal(paths.dataPath, undefined,
    'dataPath had no caller anywhere and answered nothing DATA_ROOT does not');
  assert.equal(paths.docsPath, undefined,
    'docsPath had no caller anywhere and answered nothing DOCS_ROOT does not');
  assert.ok(paths.DATA_ROOT && paths.DOCS_ROOT,
    'and both roots must still be exported, since that is what the helpers wrapped');
});
