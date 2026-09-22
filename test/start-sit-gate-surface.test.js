/**
 * The start/sit gate's result has to be stored, served and shown, and its job has to
 * run off the request thread (plan item C12, unit C-01).
 *
 * - Store: model_gate_audits, written by model-governance.js#recordGateAudit, with
 *   sport 'FANTASY' so no betting reader of that table ever counts it.
 * - Serve: GET /api/gates/start-sit reads the latest row; before any run it says
 *   not_run, which is an absence with a name rather than an empty number.
 * - Job: start_sit_gate, weekly, growth tier, offThread (B-17 maps it to a day).
 * - Page: a panel on the Lineup page (nav stays 8 tabs) that shows the verdict with
 *   its basis and every failing week.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { ServerResponse } from 'node:http';
import { Readable, PassThrough } from 'node:stream';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-start-sit-gate-surface-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const S = await import('../server/services/gates/start-sit-gate.js').catch(error => ({ __importError: error }));
const R = await import('../server/routes/gates.js').catch(error => ({ __importError: error }));
const { gateAudits } = await import('../server/services/model-governance.js');
const { JOBS, resolveOffThread, statusFromDetail } = await import('../server/services/scheduler.js');
const { scan, moduleEdges, schedulerJobs } = await import('../scripts/wiring-map.mjs');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** A finished run, in the shape runStartSitGate returns (the numbers are fixture). */
const fixtureResult = (verdict = 'not_distinguishable') => ({
  gate: 'start_sit', verdict,
  policy: 'our weekly projection', baseline: 'season-to-date PPR average', universe: 'both >= 8.0 PPR',
  scoring: 'PPR', sign_convention: 'points = our pick minus the dumb pick; positive favours our projection',
  configuration: { role_recency: { seasonDecay: 0.05, weekHalfLife: 5 }, k_override: 'omitted',
    k_control: [{ season: 2025, target_share_k: 0.2 }], champions: { 2025: { 5: 'frozen-2023' } } },
  model_version: 'configB|shrinkage-fit-1|frozen-2023',
  past: { seasons: [2024, 2025], weeks: [5, 18], n: 120, win_rate: 0.53, points_per_decision: 0.4,
    ci90: { player: { points: [-0.2, 1.0], win_rate: [0.48, 0.58] }, week: { points: [-0.4, 1.2] } },
    failing_weeks: [{ season: 2025, week: 9, n: 7, points_per_decision: -2.1, win_rate: 0.29, failing: true }] },
  forward: { season: 2026, weeks: [2, 2], n: 11, points_per_decision: 0.9 },
  gates: [{ id: 'G1', passed: false }, { id: 'G2', passed: false }, { id: 'G3', passed: false }, { id: 'G4', passed: true }],
  controls: { passed: verdict !== 'instrument_fault' },
});

async function request(app, url) {
  const req = new Readable({ read() { this.push(null); } });
  req.url = url; req.method = 'GET'; req.headers = {};
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
    };
    app.handle(req, res, reject);
  });
}

test('the gate service and its route load', () => {
  assert.ifError(S.__importError);
  assert.ifError(R.__importError);
});

test('before any run the served answer is not_run, not an empty number', async () => {
  assert.equal(S.latestStartSitGate().status, 'not_run');
  const app = express();
  app.use('/api/gates', R.default);
  const res = await request(app, '/api/gates/start-sit');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'not_run');
  assert.equal(res.body.win_rate, undefined);
});

test('a run is stored in model_gate_audits by recordGateAudit, as FANTASY / start_sit', async () => {
  const detail = await S.refreshStartSitGate({ run: () => fixtureResult() });
  const stored = rows(`SELECT sport, market, model_version, verdict, evidence_json FROM model_gate_audits`);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].sport, 'FANTASY');
  assert.equal(stored[0].market, 'start_sit');
  assert.equal(stored[0].model_version, 'configB|shrinkage-fit-1|frozen-2023');
  assert.equal(stored[0].verdict, 'blocked');               // recordGateAudit's word for "not every gate passed"
  assert.equal(JSON.parse(stored[0].evidence_json).verdict, 'not_distinguishable');
  assert.equal(detail.verdict, 'not_distinguishable');
  assert.ok(Number.isInteger(detail.audit_id));
  assert.equal(statusFromDetail(detail), 'ok');
});

test('the betting readers of that table never see a fantasy gate row', () => {
  assert.equal(gateAudits('NFL').length, 0);
  assert.equal(gateAudits('FANTASY').length, 1);
});

test('GET /api/gates/start-sit serves the latest stored result with its basis', async () => {
  const app = express();
  app.use('/api/gates', R.default);
  const res = await request(app, '/api/gates/start-sit');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'measured');
  assert.equal(res.body.verdict, 'not_distinguishable');
  assert.equal(res.body.past.win_rate, 0.53);
  assert.match(res.body.baseline, /season-to-date/);
  assert.match(res.body.sign_convention, /positive favours/);
  assert.deepEqual(res.body.past.failing_weeks.map(w => w.week), [9]);
  assert.ok(res.body.stored_at);
});

test('an instrument fault is recorded as a job error, and still stored so it can be read', async () => {
  const detail = await S.refreshStartSitGate({ run: () => fixtureResult('instrument_fault') });
  assert.equal(statusFromDetail(detail), 'error');
  assert.equal(S.latestStartSitGate().verdict, 'instrument_fault');
});

test('the job is registered weekly, in the growth tier, off the request thread', () => {
  const job = JOBS.start_sit_gate;
  assert.ok(job, 'JOBS.start_sit_gate is not registered');
  assert.equal(job.tier, 'growth');
  assert.equal(job.maxAgeMinutes, 7 * 24 * 60);
  assert.equal(job.offThread, true);
  assert.equal(resolveOffThread(job), true);
  assert.match(job.label, /start\/sit gate/i);
});

test("the job's run resolves to the gate module (the wiring map's own resolver)", () => {
  const { text } = scan(read('server/services/scheduler.js'));
  const jobs = schedulerJobs(text, 'server/services/scheduler.js', moduleEdges(text).imports);
  const j = jobs.find(x => x.name === 'start_sit_gate');
  assert.ok(j, 'the wiring map does not see start_sit_gate');
  assert.equal(j.runModule, 'server/services/gates/start-sit-gate.js');
});

test('the route is mounted behind the same auth as every other fantasy route', () => {
  const index = read('server/index.js');
  // After runMigrations, like every router (index.js: routes prepare statements at import time).
  assert.match(index, /const \{ default: gatesRouter \} = await import\('\.\/routes\/gates\.js'\);/);
  assert.match(index, /app\.use\('\/api\/gates', \.\.\.legacyAuthenticated, gatesRouter\)/);
});

test('the Lineup page shows the gate panel, and the panel reads the route', () => {
  const page = read('client/src/pages/Lineup.tsx');
  assert.match(page, /import StartSitGate from '\.\.\/components\/lineup\/StartSitGate'/);
  assert.match(page, /<StartSitGate\s*\/>/);
  const panel = read('client/src/components/lineup/StartSitGate.tsx');
  assert.match(panel, /useApi<[^>]+>\('\/gates\/start-sit'\)/);
});

test('the panel names every verdict, the basis and the sign convention, and hides no failing week', () => {
  const panel = read('client/src/components/lineup/StartSitGate.tsx');
  for (const v of ['beats_dumb', 'beats_dumb_unconfirmed_forward', 'not_distinguishable', 'loses_to_dumb',
    'no_disagreements', 'instrument_fault', 'not_run']) {
    assert.ok(panel.includes(`${v}:`) || panel.includes(`'${v}'`), `the panel has no wording for ${v}`);
  }
  for (const field of ['baseline', 'policy', 'universe', 'sign_convention', 'scoring', 'failing_weeks', 'mde80', 'forward']) {
    assert.ok(panel.includes(field), `the panel does not render ${field}`);
  }
  assert.doesNotMatch(panel, /\.slice\(/, 'the panel trims nothing: every failing week is shown');
});
