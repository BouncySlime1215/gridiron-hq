import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';

/**
 * Giant Plan section 3, item 11: GET /football-first/:season/:week/:home/:away
 * must not compute the ~90s coefficient fit synchronously on the request
 * thread on a cache miss. It should behave like the sibling
 * GET /football-first/coefficients endpoint: check the already-computed
 * (peekResidualModel) cache, and on a miss return 202 with a queued-fit
 * pointer instead of blocking.
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-football-first-route-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
delete process.env.ODDS_API_KEY;

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { default: nflBettingRouter } = await import('../server/routes/nfl-betting.js');
const app = express();
app.use(express.json());
app.use('/api/nfl/betting', nflBettingRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));

async function get(url) {
  const req = new Readable({ read() { this.push(null); } });
  req.url = `/api/nfl/betting${url}`; req.method = 'GET'; req.headers = {};
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => { if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, payload: text ? JSON.parse(text) : null }); };
    app.handle(req, res, reject);
  });
}

/*
 * `maxRetries` is load-bearing, not caution.
 *
 * This file imports `server/routes/nfl-betting.js`, which pulls in
 * `report-cache.js` and its worker thread. A worker gets a fresh module
 * registry, so it re-runs `server/db/index.js`, and that module does
 * `mkdirSync(path.dirname(DB_PATH), { recursive: true })` at line 19 and
 * opens a `DatabaseSync` at line 20 — recreating this temp directory AND the
 * database file inside it. The run's second `ExperimentalWarning: SQLite`
 * line is that second connection. When it lands between this `rmSync`'s
 * directory walk and its final `rmdir`, the removal throws ENOTEMPTY and node
 * reports the whole file as a failed `after` hook even though every test in
 * it passed. That is what turned CI red on 2026-09-19 while the same file
 * passed locally and on every earlier commit.
 *
 * `force` does not cover it — that suppresses ENOENT, not ENOTEMPTY — and
 * `maxRetries` is documented to retry exactly this error class with a linear
 * backoff. Stated as documented behaviour rather than measured: the race is
 * between a worker's `mkdirSync` and a synchronous `rmSync` on the main
 * thread, and it could not be forced reliably enough to demonstrate here.
 *
 * It does not stop the directory being recreated after this hook finishes,
 * which leaves an empty temp directory behind. That is untidy and harmless,
 * and repo-wide rather than this file's to fix: 223 test files remove a temp
 * directory this way and 16 other `gridiron-*` prefixes leak identically.
 * Verified pre-existing by running this file unchanged in a worktree at the
 * base of the branch stack, where it behaves the same.
 */
test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('a cold fit cache returns 202 with a queued-fit pointer immediately, instead of computing inline', async () => {
  const started = Date.now();
  const res = await get('/football-first/2026/1/KC/DEN');
  const elapsed = Date.now() - started;
  assert.equal(res.status, 202, 'must not silently 200 with a synchronously-computed fit');
  assert.equal(res.payload.fitted, false);
  assert.equal(res.payload.season, 2026);
  assert.equal(res.payload.week, 1);
  assert.equal(res.payload.home, 'KC');
  assert.equal(res.payload.away, 'DEN');
  assert.match(res.payload.how, /football-first\/fit/);
  // The whole point: this must return fast, not after a ~90s inline refit.
  assert.ok(elapsed < 5000, `expected a fast 202, took ${elapsed}ms`);
});

test('once the fit is warm in this process (peekResidualModel hits), the route answers directly', async () => {
  const { residualModel } = await import('../server/services/football-first.js');
  // Mirrors what the scheduler does on its own tick: computing it once,
  // in-process, off the request path -- exactly what the guard exists to
  // keep a web request from having to do itself.
  residualModel(2026, 'margin');
  const res = await get('/football-first/2026/1/KC/DEN');
  assert.notEqual(res.status, 202, 'a warm cache must not be reported as still pending');
  assert.equal(res.status, 200);
});
