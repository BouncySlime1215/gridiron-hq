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

/*
 * ONE WORD PER ASSERTION, AND BEFORE THE SHAPE CHECK.
 *
 * These two tests used to end with `assert.doesNotMatch(res.text, /data|sqlite|unable/i)`
 * placed AFTER `assert.deepEqual(res.payload, { ok: false })`. Both lines were dead. A
 * body that deep-equals `{ ok: false }` is the string `{"ok":false}` and contains none
 * of those words, so the alternation could never fail — and when the handler really did
 * leak (measured: put `error: error.message` back in the 503), the deepEqual reported
 * first and the run read as a shape mismatch. The most serious failure this file can
 * detect — a database path answered to the whole internet — was reported as "expected
 * values to be deeply equal".
 *
 * So the disclosure check goes first, one word at a time with its own sentence. Three
 * branches in one regex is one message for three different leaks, and the message that
 * matters names the word that got out. The list is shared by both tests because the
 * prohibition is the same one: the second test used `/locked|sqlite|data/i` and so
 * never checked for "unable" at all.
 */
const NEVER_DISCLOSED = ['unable', 'locked', 'sqlite', 'database', '/data', '.wal'];
const saysNothing = (text) => {
  for (const word of NEVER_DISCLOSED) {
    assert.doesNotMatch(text, new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      `the word "${word}" reached an unauthenticated public response: ${JSON.stringify(text)}`);
  }
};

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

  saysNothing(res.text);
  assert.deepEqual(res.payload, { ok: false },
    'the 503 body must be exactly { ok: false } — this endpoint is unauthenticated and public');
});

test('a failure thrown by the query itself is also silent', async () => {
  // The other failure shape: the module loads, the statement does not run.
  const res = await get(appWith(async () => ({
    db: { prepare: () => ({ get: () => { throw new Error('database is locked: /data/app.sqlite-wal'); } }) }
  })));
  assert.equal(res.status, 503);
  saysNothing(res.text);
  assert.deepEqual(res.payload, { ok: false });
});
