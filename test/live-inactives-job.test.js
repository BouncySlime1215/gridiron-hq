/**
 * FIX-184-5a: the `live_inactives` scheduler job, run the way the worker runs it
 * (job-worker.js calls `scheduler.JOBS[job].run()`).
 *
 * The claim's season/week is the only thing that joins the writer to the Start/Sit
 * reader, and both are meant to use tradeWeekContext(). This pins the writer side: the
 * job hands tradeWeekContext()'s season and week to pollJetstream, and the row lands in
 * that week. Jetstream is a fake WebSocket (globalThis.WebSocket, pollJetstream's
 * default); everything from JOBS.live_inactives.run to the stored row is real code.
 * trade-engine.js is mocked with namedExports only (no default export is involved; see
 * CLAUDE.md on `defaultExport`).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-live-inactives-job-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// A week no other default would produce, so a hard-coded or NFL_WEEK-derived week fails.
const CONTEXT = { season: 2031, week: 13 };
const realTradeEngine = await import('../server/services/trade-engine.js');
let contextCalls = 0;
mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, tradeWeekContext: () => { contextCalls++; return CONTEXT; } }
});

const { JOBS } = await import('../server/services/scheduler.js');

run(`INSERT OR IGNORE INTO nfl_teams (id, abbr, name, conference, division) VALUES (941, 'FXJ', 'Fixture Jets', 'AFC', 'East')`);
run(`INSERT INTO players (id, name, position, team_id) VALUES (8201, 'Fixture Jobrunner', 'WR', 941)`);

const opened = [];
class FakeJetstream {
  constructor(url) {
    opened.push(url);
    this.listeners = {};
    setTimeout(() => {
      this.emit('open');
      this.emit('message', { data: JSON.stringify({ payload: {
        did: 'did:plc:lbe3b7ce6n7oa6cbl5jwoifo', time: '2031-11-30T15:00:00Z', operation: 'create',
        collection: 'app.bsky.feed.post', rkey: 'job1',
        record: { text: 'Jets WR Fixture Jobrunner is inactive.', createdAt: '2031-11-30T15:00:00Z' } } }) });
      // The server closing the stream ends the poll without waiting out the idle timer.
      this.emit('close');
    }, 5);
  }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  emit(t, e = {}) { for (const f of this.listeners[t] ?? []) f(e); }
  close() { this.closed = true; }
}
const savedWS = globalThis.WebSocket;
globalThis.WebSocket = FakeJetstream;

test.after(() => {
  globalThis.WebSocket = savedWS;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('JOBS.live_inactives.run() polls Jetstream with tradeWeekContext() season/week and stores the claim in that week', async () => {
  assert.ok(JOBS.live_inactives, 'the job is registered');
  const out = await JOBS.live_inactives.run();
  assert.equal(opened.length, 1, 'one Jetstream connection');
  assert.ok(contextCalls >= 1, 'the job read tradeWeekContext()');
  assert.equal(out.recorded, 1, `one claim recorded; poll said ${JSON.stringify(out)}`);
  const stored = rows('SELECT player_id, season, week, status FROM live_inactive_claims');
  assert.deepEqual(stored.map(r => ({ ...r })), [{ player_id: 8201, season: CONTEXT.season, week: CONTEXT.week, status: 'inactive' }]);
});
