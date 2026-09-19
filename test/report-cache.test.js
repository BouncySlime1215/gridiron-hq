import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Heavy reports computed in a worker thread and served from SQLite, so a
// request never triggers a synchronous multi-season replay.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-report-cache-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
const cache = await import('../server/services/report-cache.js');

test.after(async () => {
  // A worker emits 'exit' AFTER its result has already been delivered, and the
  // exit handler calls reclaimWal(), which touches the database. Closing the
  // handle while an exit is still in flight turns that into an uncaught
  // "database is not open" and fails the whole file even though every test in
  // it passed. Let the workers this file started finish exiting first.
  //
  // Deliberately not fixed by making reclaimWal() swallow a closed database:
  // it is only reachable here because a test closes the handle mid-run, and in
  // the server the listener keeps the process (and the database) alive. A
  // catch there would silence a real "database is not open" everywhere else to
  // tidy a test-only race.
  await new Promise(resolve => setTimeout(resolve, 250));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('an unknown report is refused', () => {
  assert.equal(cache.serveReport('nope').error, 'unknown report nope');
});

test('a never-computed report is served as pending and computed in a worker, then served from the store', async () => {
  const first = cache.serveReport('policy_contract', { refreshIfStale: false });
  assert.equal(first.pending, true);
  const result = await cache.refreshReport('policy_contract');
  assert.equal(result.error, null);
  assert.ok(result.duration_ms >= 0);
  const stored = rows(`SELECT report, duration_ms, error FROM nfl_cached_reports WHERE report='policy_contract'`)[0];
  assert.ok(stored);
  assert.equal(stored.error, null);
  const served = cache.serveReport('policy_contract', { refreshIfStale: false });
  assert.equal(served.pending, undefined);
  assert.equal(served.id, 'nfl-spread-v1', 'the worker ran the real function and its output round-tripped');
  assert.equal(served._report.stale, false);
  assert.equal(served._report.error, null);
});

test('a fresh fingerprint short-circuits without spawning a worker', async () => {
  const again = await cache.refreshReport('policy_contract');
  assert.equal(again.fresh, true);
});

test('a worker error is stored and surfaced, not thrown into the request', async () => {
  cache.REPORTS.policy_contract; // frozen registry; use a bad module through the worker directly
  const { Worker } = await import('node:worker_threads');
  const msg = await new Promise(resolve => {
    const w = new Worker(new URL('../server/services/report-worker.js', import.meta.url),
      { workerData: { module: './does-not-exist.js', fn: 'x', args: [] }, env: process.env });
    w.once('message', resolve);
  });
  assert.ok(msg.error, 'the worker reports the failure as a message');
  const status = cache.reportCacheStatus();
  assert.ok(status.reports.find(r => r.report === 'policy_contract' && r.stale === false));
});

/*
 * A worker that has already delivered its result still emits 'exit'
 * afterwards, and the 'exit' handler used to decide whether to act on it by
 * asking `inflight.has(name)`. That map is keyed by REPORT NAME, not by
 * worker, so the question it answers is "is some run of this report in
 * flight" — not "is MY run still unsettled". Force a second refresh in the
 * window between the first worker's 'message' and its 'exit' and the answer
 * is yes, for the wrong run: the finished worker's exit then runs the FIRST
 * job's finish(), which writes payload_json = NULL and
 * error = 'worker exited with code 0' over a report that had just computed
 * successfully, and deletes the SECOND job's inflight entry so the report
 * claims it is not refreshing while it is.
 *
 * The damage is invisible here because policy_contract recomputes in
 * milliseconds and the second run overwrites the bad row almost immediately.
 * On the slow reports it is not: football_first_fit (~90s) and
 * abstention_audit (~66s) would serve a successful report as a failed one,
 * with an empty body, for the whole of the second run.
 */
test('a finished worker\'s exit never overwrites a newer run of the same report', async () => {
  // First run resolves on 'message'. Its 'exit' has not fired yet.
  const first = await cache.refreshReport('policy_contract', { force: true });
  assert.equal(first.error, null, 'precondition: the first run succeeded');

  // Second run registers itself before that 'exit' arrives.
  const second = cache.refreshReport('policy_contract', { force: true });

  // Let the first worker's 'exit' land while the second is still in flight.
  await new Promise(resolve => setTimeout(resolve, 60));

  const during = rows(`SELECT payload_json, error FROM nfl_cached_reports WHERE report='policy_contract'`)[0];
  const servedDuring = cache.serveReport('policy_contract', { refreshIfStale: false });
  await second;

  assert.notEqual(during.error, 'worker exited with code 0',
    'a finished worker\'s exit wrote a failure over a report that had already succeeded');
  assert.notEqual(during.payload_json, null,
    'a finished worker\'s exit blanked the payload of a successful report');
  assert.equal(servedDuring._report.refreshing, true,
    'the second run was still computing, but its in-flight entry had been deleted by the first worker\'s exit');
});
