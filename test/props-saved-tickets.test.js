import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated-DB pattern shared with the other suites (see phone-pairing.test.js,
// prop-clv-free-capture.test.js) — a fresh temp SQLite file with migrations
// run against it, never the real server/data.sqlite.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-props-tickets-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const applied = await runMigrations();
const { default: propsTicketsRouter } = await import('../server/routes/props-tickets.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/props-tickets', propsTicketsRouter);
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api/props-tickets`;

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('018_saved_prop_tickets ran and created the table', () => {
  assert.ok(applied.includes('018_saved_prop_tickets'));
  assert.ok(row(`SELECT name FROM sqlite_master WHERE type='table' AND name='saved_prop_tickets'`));
});

const leg = (overrides = {}) => ({
  id: 'leg-1', slateDate: '2026-06-01', selection: 'Aaron Judge', matchup: 'Yankees at Red Sox',
  gameTime: '2026-06-01T23:05:00Z', market: 'batter_total_bases', marketLabel: 'Batter Total Bases',
  side: 'Over', line: 1.5, recommendation: 'Over 1.5', modelProbability: 0.62, confidence: 0.7,
  odds: '-120', ...overrides
});

test('a fresh install has no saved slips', async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

let firstId;
test('saving a slip persists it and echoes back the Ticket shape the client expects', async () => {
  const ticket = {
    id: 'ticket-1', savedAt: '2026-06-01T12:00:00.000Z', legs: [leg()],
    totalAmericanOdds: '-120', totalDecimalOdds: 1.8333333333333333
  };
  const res = await fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ticket)
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  firstId = body.id;
  assert.equal(body.id, 'ticket-1');
  assert.equal(body.savedAt, ticket.savedAt);
  assert.equal(body.totalAmericanOdds, '-120');
  assert.equal(body.totalDecimalOdds, ticket.totalDecimalOdds);
  assert.deepEqual(body.legs, [leg()]);
});

test('a saved slip shows up in the list, newest first', async () => {
  const second = {
    id: 'ticket-2', savedAt: '2026-06-02T12:00:00.000Z',
    legs: [leg({ id: 'leg-2', selection: 'Mookie Betts' })],
    totalAmericanOdds: '+150', totalDecimalOdds: 2.5
  };
  await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(second) });

  const res = await fetch(base);
  const list = await res.json();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'ticket-2', 'saved_at DESC puts the newer slip first');
  assert.equal(list[1].id, 'ticket-1');
});

test('saving the same id again updates in place instead of duplicating (idempotent for the localStorage migration path)', async () => {
  const updated = {
    id: 'ticket-1', savedAt: '2026-06-01T12:00:00.000Z', legs: [leg({ odds: '-105' })],
    totalAmericanOdds: '-105', totalDecimalOdds: 1.9523809523809523
  };
  await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updated) });

  const res = await fetch(base);
  const list = await res.json();
  assert.equal(list.length, 2, 're-saving the same id must not create a second row');
  const rewritten = list.find(t => t.id === 'ticket-1');
  assert.equal(rewritten.totalAmericanOdds, '-105');
  assert.equal(rewritten.legs[0].odds, '-105');
});

test('rejects a slip with no legs or a missing id', async () => {
  const noLegs = await fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'bad-1', savedAt: '2026-06-01T12:00:00.000Z', legs: [] })
  });
  assert.equal(noLegs.status, 400);

  const noId = await fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ savedAt: '2026-06-01T12:00:00.000Z', legs: [leg()] })
  });
  assert.equal(noId.status, 400);

  const res = await fetch(base);
  assert.equal((await res.json()).length, 2, 'neither invalid request left a row behind');
});

test('deleting a slip removes exactly that one', async () => {
  const del = await fetch(`${base}/${firstId}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });

  const res = await fetch(base);
  const list = await res.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ticket-2');
});

test('deleting an id that does not exist is a harmless no-op', async () => {
  const res = await fetch(`${base}/does-not-exist`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
