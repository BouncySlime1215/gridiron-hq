/**
 * GET /api/health must fail loudly to the host and say nothing to the internet
 * (2026-09-19).
 *
 * Two requirements pull in opposite directions and both are real.
 *
 * It has to be able to FAIL. `fly.toml` used to carry a TCP check, which the
 * kernel's listen backlog answers while Node's event loop is blocked, so a
 * wedged process looked healthy forever and was never restarted. A health
 * route that cannot return a non-200 is that bug again in a new place.
 *
 * And it has to DISCLOSE NOTHING. It is unauthenticated on a public host. The
 * start-up probes were moved onto it precisely because they used to poll
 * `GET /api/model/status`, which answers with row counts out of the database.
 * The first version of this handler returned `{ ok: false, error: err.message }`
 * — and a SQLite failure message reads like "unable to open database file:
 * /data/app.sqlite", so the one moment it had something worth disclosing was
 * the one moment it was answering the whole internet about a broken machine.
 * Found while reconciling this route with the one PR #14 invented separately,
 * whose entire stated purpose was an endpoint that says nothing at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';
import { healthHandler } from '../server/platform/health.js';

function appWith(openDb) {
  const app = express();
  app.get('/api/health', healthHandler(openDb));
  return app;
}

async function get(app) {
  const req = new Readable({ read() { this.push(null); } });
  req.url = '/api/health'; req.method = 'GET'; req.headers = {};
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, text, payload: text ? JSON.parse(text) : null });
    };
    app.handle(req, res, reject);
  });
}

const workingDb = async () => ({ db: { prepare: () => ({ get: () => ({ 1: 1 }) }) } });

test('a healthy app answers 200 with ok true', async () => {
  const res = await get(appWith(workingDb));
  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(typeof res.payload.uptime_s, 'number');
});

test('the check actually reads from the database rather than just returning true', async () => {
  // If the handler stopped touching SQLite it would answer 200 on a wedged
  // process, which is the TCP-check bug this endpoint exists to fix.
  let queried = 0;
  await get(appWith(async () => ({ db: { prepare: () => ({ get: () => { queried += 1; return {}; } }) } })));
  assert.equal(queried, 1, 'a health check that never touches the database cannot detect a broken one');
});

test('a broken database answers 503, not 200', async () => {
  const res = await get(appWith(async () => { throw new Error('unable to open database file: /data/app.sqlite'); }));
  assert.equal(res.status, 503, 'a health check that cannot fail is not a health check');
  assert.equal(res.payload.ok, false);
});

test('the failure body carries no error detail at all', async () => {
  const secret = 'unable to open database file: /data/app.sqlite';
  const res = await get(appWith(async () => { throw new Error(secret); }));

  assert.deepEqual(res.payload, { ok: false },
    'the 503 body must be exactly { ok: false } — this endpoint is unauthenticated and public');
  assert.doesNotMatch(res.text, /data|sqlite|unable/i,
    'a database path or error string reached an unauthenticated public response');
});

test('a failure thrown by the query itself is also silent', async () => {
  // The other failure shape: the module loads, the statement does not run.
  const res = await get(appWith(async () => ({
    db: { prepare: () => ({ get: () => { throw new Error('database is locked: /data/app.sqlite-wal'); } }) }
  })));
  assert.equal(res.status, 503);
  assert.deepEqual(res.payload, { ok: false });
  assert.doesNotMatch(res.text, /locked|sqlite|data/i);
});
