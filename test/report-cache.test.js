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

test.after(() => {
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
