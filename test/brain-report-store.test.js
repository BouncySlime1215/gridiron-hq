/**
 * EVAL-01 storage and wiring: migration 078's contract, the graders run over a
 * real (temp) database, the runner script, the read-only route and its flag.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-brain-report-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_E4_REPLAY_JSON = path.join(temp, 'no-such-replay.json');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const EVAL = await import('../server/services/eval/index.js');
const E1 = await import('../server/services/eval/e1.js');
const { default: brainReportRouter, BRAIN_REPORT_FLAG } = await import('../server/routes/brain-report.js');
const RULE = await import('../server/services/eval/brain-rule.js');
const RUNNER = await import('../scripts/eval/run-graders.mjs');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

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
const app = express();
app.use('/api/brain-report', brainReportRouter);

test('migration 078 is applied and its CHECKs are the contract', () => {
  const cols = db.prepare(`SELECT name FROM pragma_table_info('brain_report')`).all().map(c => c.name);
  for (const c of ['run_id', 'check_id', 'status', 'metric', 'ci_low', 'ci_high', 'n', 'needs_n', 'needs_unit', 'needs_text', 'source']) {
    assert.ok(cols.includes(c), c);
  }
  const ins = db.prepare(`INSERT INTO brain_report (run_id, computed_at, check_id, status, metric_name, pass_bar, needs_n, needs_unit, needs_text)
    VALUES ('t', 'now', ?, ?, 'm', 'bar', ?, ?, ?)`);
  assert.throws(() => ins.run('X1', 'not_enough_data', null, null, null), /CHECK/, 'not_enough_data must say what it needs');
  assert.throws(() => ins.run('X2', 'passing', 3, 'offers', 'needs 3 more offers'), /CHECK/, 'a passing row needs nothing');
  assert.throws(() => ins.run('X3', 'maybe', null, null, null), /CHECK/);
  db.exec(`DELETE FROM brain_report WHERE run_id = 't'`);
});

test('on an empty database every check runs: E3 historical passes, everything live says what it needs', () => {
  const { results, errors } = EVAL.runAll(db);
  assert.deepEqual(errors, []);
  assert.deepEqual(results.map(r => r.check), ['E1', 'E2', 'E3', 'E3-live', 'E4', 'E5', 'E6', 'E7']);
  const byCheck = Object.fromEntries(results.map(r => [r.check, r]));
  assert.equal(byCheck.E3.status, 'passing');
  assert.equal(byCheck.E3.source, 'historical_fixed');
  for (const c of ['E1', 'E2', 'E3-live', 'E4', 'E5', 'E6', 'E7']) {
    assert.equal(byCheck[c].status, 'not_enough_data', c);
    assert.match(byCheck[c].needs_text, /^needs \d+ more /, c);
  }
  assert.match(byCheck.E1.needs_text, new RegExp(`^needs ${E1.minOffersToDecide()} more offers`));
  assert.match(byCheck.E2.needs_text, /trade_outcomes lacks column\(s\) sent_at/);
  assert.match(byCheck.E7.needs_text, /PROJ-04-a/);
  assert.match(byCheck.E7.needs_text, /needs 4 more weeks/);
});

test('E1 reads the real trade_outcomes ledger: sent app_proposed rows only; offer_log is never read', () => {
  // sent_at arrives with 080 (CLONE-01b, #239); added here so this file does not
  // depend on that PR's merge order.
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('trade_outcomes') WHERE name = 'sent_at'`).get()) {
    db.exec('ALTER TABLE trade_outcomes ADD COLUMN sent_at TEXT; ALTER TABLE trade_outcomes ADD COLUMN matched_tx_id TEXT');
  }
  const ins = db.prepare(`INSERT INTO trade_outcomes (league_id, season, source, counterparty_team_id, proposed_at,
    model_p_accept, model_basis, status, idea_id, sent_at, created_at) VALUES (1, 2026, ?, ?, ?, ?, 'heuristic_anchored', ?, ?, ?, '2026-09-23')`);
  for (let i = 0; i < 12; i += 1) ins.run('app_proposed', String(i % 3), `2026-09-${10 + i}`, 0.3, i % 2 ? 'accepted' : 'declined', `idea${i}`, `2026-09-${10 + i}`);
  ins.run('app_proposed', '1', '2026-09-30', 0.3, 'proposed', 'idea-open', '2026-09-30');
  ins.run('app_proposed', '2', '2026-09-29', 0.3, 'declined', 'idea-unsent', null);
  db.exec(`INSERT INTO trade_outcomes (league_id, season, source, status, not_proposed_reason, created_at)
    VALUES (1, 2026, 'considered_only', 'not_proposed', 'edge', '2026-09-23')`);
  db.exec(`CREATE TABLE offer_log (league_id INTEGER, counterparty_team_id TEXT, proposed_at TEXT, model_p_accept REAL, status TEXT, idea_id TEXT)`);
  db.exec(`INSERT INTO offer_log VALUES (1, '9', '2026-09-11', 0.6, 'accepted', 'fresh')`);
  const { offers, sources } = E1.load(db);
  assert.deepEqual(sources, ['trade_outcomes']);
  assert.equal(offers.length, 12, '12 sent, resolved app_proposed rows; the open, the unsent and the offer_log row are not outcomes');
  const r = E1.run(db);
  assert.equal(r.n, 12);
  assert.equal(r.detail.offers_by_basis.recorded, 12, 'every one carried the prediction recorded when it was sent');
  assert.equal(r.status, 'not_enough_data');
  assert.match(r.needs_text, /^needs \d+ more offers/);
  db.exec('DROP TABLE offer_log');
});

test('E1 reads every manager\'s offers: observed trade_outcomes plus unsettled league_transactions_raw, withdrawn excluded', () => {
  db.exec(`CREATE TABLE league_transactions_raw (league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
    type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT, team_id INTEGER, member_id TEXT,
    related_tx_id TEXT, scoring_period INTEGER, bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`);
  const raw = db.prepare(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, execution_type, team_id,
    related_tx_id, proposed_at, items_json, first_seen_at, last_seen_at) VALUES (2, 2026, ?, ?, ?, ?, ?, ?, ?, 'x', 'x')`);
  const items = (a, b) => JSON.stringify([{ fromTeamId: a, toTeamId: b }, { fromTeamId: b, toTeamId: a }]);
  raw.run('p1', 'TRADE_PROPOSAL', 'EXECUTE', 4, null, '2026-09-05T00:00:00Z', items(4, 6));
  raw.run('a1', 'TRADE_DECLINE', 'EXECUTE', 6, 'p1', '2026-09-05T03:00:00Z', null);
  raw.run('p2', 'TRADE_PROPOSAL', 'EXECUTE', 8, null, '2026-09-06T00:00:00Z', items(8, 9));
  raw.run('a2', 'TRADE_ACCEPT', 'EXECUTE', 9, 'p2', '2026-09-06T03:00:00Z', null);
  raw.run('p3', 'TRADE_PROPOSAL', 'EXECUTE', 9, null, '2026-09-07T00:00:00Z', items(9, 4));
  raw.run('c3', 'TRADE_PROPOSAL', 'CANCEL', 9, 'p3', '2026-09-07T01:00:00Z', null);
  db.exec(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, proposed_at,
    status, espn_tx_id, resolved_at, created_at) VALUES
    (2, 2026, 'observed', '6', '8', '2026-09-04T00:00:00Z', 'accepted', 'p0', '2026-09-04T02:00:00Z', 'x'),
    (2, 2026, 'observed', '4', '6', '2026-09-05T00:00:00Z', 'declined', 'p1', '2026-09-05T03:00:00Z', 'x')`);
  const { offers, excluded, sources } = E1.load(db);
  assert.deepEqual(sources, ['trade_outcomes', 'league_transactions_raw']);
  const league2 = offers.filter(o => o.league_id === 2);
  assert.equal(league2.length, 3, 'p0 and p1 from the ledger (p1 once), p2 from raw; p3 was withdrawn');
  assert.equal(new Set(league2.map(o => o.proposer_team_id)).size, 3, 'three different proposers, none of them the app');
  assert.equal(excluded.withdrawn, 1);
  const r = E1.run(db);
  assert.equal(r.n, 15, '12 sent app offers in league 1 plus 3 league-2 offers from other managers');
  assert.equal(r.detail.offers_by_basis.replay_anchor_only, 3);
  db.exec("DROP TABLE league_transactions_raw; DELETE FROM trade_outcomes WHERE league_id = 2");
});

test('a grader that throws is written, not hidden, and the rule treats it as blocking', async () => {
  const bad = path.join(temp, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  const { results, errors } = EVAL.runAll(db, { E4: { filePath: bad } });
  assert.equal(errors.length, 1);
  const e4 = results.find(r => r.check === 'E4');
  assert.equal(e4.status, 'not_enough_data');
  assert.ok(e4.detail.grader_error);
  assert.match(e4.needs_text, /grader could not run/);
  const rule = RULE.brainReportRule({ requestedMode: 'all_in', now: new Date(), report: { computed_at: new Date().toISOString(), checks: results } });
  assert.deepEqual([rule.mode, rule.testing_tier_enabled], ['balanced', false]);
  assert.deepEqual(rule.blocking.map(b => b.check), ['E4']);
});

test('runner stores one run; the latest run is read back with its summary', async () => {
  const lines = [];
  const { ok, stored } = await RUNNER.main({ now: new Date('2020-01-01T00:00:00Z'), log: l => lines.push(l) });
  assert.equal(ok, true);
  assert.match(lines.at(-1), /^brain_report: 1 passing, 7 not_enough_data, 0 failing \(run /);
  const rep = EVAL.latestReport(db);
  assert.equal(rep.run_id, stored.run_id);
  assert.equal(rep.checks.length, 8);
  assert.deepEqual(rep.summary, { passing: 1, not_enough_data: 7, failing: 0 });
  assert.equal(rep.checks.find(c => c.check === 'E3').detail.league_seasons, 906);
});

test('GET /api/brain-report is default-off, and on it serves the stored run and the fallback', async () => {
  delete process.env[BRAIN_REPORT_FLAG];
  const off = await request(app, '/api/brain-report');
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  process.env[BRAIN_REPORT_FLAG] = '1';
  try {
    const on = await request(app, '/api/brain-report');
    assert.equal(on.body.enabled, true);
    assert.equal(on.body.report.checks.length, 8);
    assert.equal(on.body.fallback_if_all_in.testing_tier_enabled, false, 'the stored run is dated 2020: stale fails closed');
  } finally {
    delete process.env[BRAIN_REPORT_FLAG];
  }
});
