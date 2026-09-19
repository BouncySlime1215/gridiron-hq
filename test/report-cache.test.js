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
  db.close();
  // `fs.rmSync(recursive)` walks the directory, and a worker thread still
  // tearing down can recreate SQLite's -wal/-shm beside the database while it
  // walks, which surfaces as ENOTEMPTY from rmdir. `force: true` does not
  // cover that — it suppresses "missing", not "something appeared". Seen in
  // CI and reproduced here roughly 1 run in 20.
  //
  // Retried rather than slept: a fixed delay is the same guess that made the
  // test above flaky, and there is no event to wait on — the worker is
  // detached from the promise by then.
  for (let attempt = 0; ; attempt++) {
    try { fs.rmSync(temp, { recursive: true, force: true }); break; }
    catch (error) {
      if (error.code !== 'ENOTEMPTY' || attempt >= 20) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
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

  // Sample the stored row for the whole of the second run rather than reading
  // it once after a fixed delay. `policy_contract` recomputes in milliseconds,
  // so any single sleep either lands after the second run finished (nothing to
  // see) or races it — a first version of this test slept 60ms, passed here,
  // and failed in CI on exactly that. Sampling catches the corrupt state
  // whenever it appears, without depending on how fast the box is.
  const corrupt = [];
  const sampler = setInterval(() => {
    const r = rows(`SELECT payload_json, error FROM nfl_cached_reports WHERE report='policy_contract'`)[0];
    if (r && (r.error === 'worker exited with code 0' || r.payload_json === null)) corrupt.push(r);
  }, 1);
  try { await second; } finally { clearInterval(sampler); }

  const settled = rows(`SELECT payload_json, error FROM nfl_cached_reports WHERE report='policy_contract'`)[0];
  assert.deepEqual(corrupt, [],
    'a finished worker\'s exit wrote a failure, or blanked the payload, over a report that had already succeeded');
  assert.equal(settled.error, null, 'the report ends successful');
  assert.notEqual(settled.payload_json, null, 'the report ends with a payload');
});
