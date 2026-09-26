/**
 * SPEND-SERVER: every AI call tagged with its source, calls made on DB copies reach the live
 * ledger, and the spend summary served in New York days with today's breakdowns, the total
 * budget, the anomaly fields and credit errors. A stand-in client throughout; no paid call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-spend-server-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
delete process.env.GRIDIRON_AI_SOURCE;
delete process.env.GRIDIRON_AI_LEDGER;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { run, rows, row } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { callClaude, setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { writeUsage, ingestShared, aiSource } = await import('../server/services/ai-ledger.js');
const { spendSummary, etDay, dayBefore } = await import('../server/services/ai-spend.js');
const { spentTodayUsd, setDailyBudget } = await import('../server/services/llm-budget.js');
const { spendClaims } = await import('../server/services/coach/brief-claims.js');
const { checkClaim } = await import('../server/services/coach/brief.js');
const { newLedger } = await import('../server/services/coach/ledger.js');

const reply = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 } };
let sent = 0;
setAnthropicClientForTesting({ messages: { create: async () => { sent += 1; return reply; } } });
test.after(() => setAnthropicClientForTesting(null));
const last = () => row('SELECT feature, source, call_id, cost_usd, error FROM ai_usage ORDER BY id DESC LIMIT 1');
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test('every call is tagged at the one call site: app by default, offline and test from the env; a bad tag spends nothing', async () => {
  await callClaude({ feature: 'coach:answer', prompt: 'hi' });
  assert.equal(last().source, 'app');
  assert.match(last().call_id, /^[0-9a-f-]{36}$/);
  await withEnv({ GRIDIRON_AI_SOURCE: 'offline' }, () => callClaude({ feature: 'news:typed', prompt: 'hi' }));
  assert.equal(last().source, 'offline');
  await withEnv({ GRIDIRON_AI_SOURCE: 'test' }, () => callClaude({ feature: 'coach:judge', prompt: 'hi' }));
  assert.equal(last().source, 'test');
  const before = sent;
  await withEnv({ GRIDIRON_AI_SOURCE: 'staging' }, () => assert.rejects(callClaude({ feature: 'coach:answer', prompt: 'hi' }), /must be one of app, offline, test/));
  assert.equal(sent, before, 'refused before the call');
  assert.equal(aiSource({}), 'app');
});

test('a stand-in client never writes to the shared ledger, even tagged test', async () => {
  const file = path.join(temp, 'shared-standin.jsonl');
  await withEnv({ GRIDIRON_AI_SOURCE: 'test', GRIDIRON_AI_LEDGER: file }, () => callClaude({ feature: 'coach:judge', prompt: 'hi' }));
  assert.equal(fs.existsSync(file), false);
});

test('a real call on a DB copy appends one line; the app ingests it once by call_id; bad lines are skipped and counted', () => {
  const file = path.join(temp, 'shared.jsonl');
  const env = { GRIDIRON_AI_SOURCE: 'test', GRIDIRON_AI_LEDGER: file };
  const w = writeUsage({ feature: 'coach:judge', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 500, output_tokens: 50 }, cost: 0.00075, env });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].call_id, w.call_id);
  assert.equal(lines[0].source, 'test');
  // As the live app sees it: a line from another database (a new call id), plus junk.
  const foreign = { ...lines[0], call_id: 'copy-call-1', cost_usd: 0.25, feature: 'coach:chat' };
  fs.appendFileSync(file, `${JSON.stringify(foreign)}\nnot json\n${JSON.stringify({ ...foreign, call_id: 'x2', source: 'app' })}\n`);
  const a = ingestShared({ file, env: {} });
  assert.deepEqual([a.status, a.read, a.inserted, a.skipped], ['ok', 4, 1, 2], 'the copy line in; its own line already there; junk and an app-tagged line skipped');
  const b = ingestShared({ file, env: {} });
  assert.equal(b.inserted, 0, 'idempotent by call_id');
  assert.equal(row(`SELECT source FROM ai_usage WHERE call_id = 'copy-call-1'`).source, 'test');
  assert.equal(ingestShared({ file, env: { GRIDIRON_AI_SOURCE: 'test' } }).status, 'not_app', 'only the app ingests');
  assert.equal(ingestShared({ file: path.join(temp, 'none.jsonl'), env: {} }).status, 'no_file');
});

test('New York days, today by model / feature / source, total budget, anomaly, credit errors', async () => {
  run('DELETE FROM ai_usage');
  const now = new Date('2026-09-26T16:00:00Z'); // noon in New York, 9/26
  const put = (at, feature, model, cost, source = 'app', error = null) => run(`INSERT INTO ai_usage (date, feature, model, input_tokens, output_tokens,
      cache_read_input_tokens, cache_creation_input_tokens, cost_usd, calls, source, error, created_at) VALUES (substr(?, 1, 10), ?, ?, 0, 0, 0, 0, ?, 1, ?, ?, ?)`,
  at, feature, model, cost, source, error, at);
  // 23:30 New York on 9/25 is 03:30 UTC on 9/26: yesterday in New York, "today" in UTC.
  put('2026-09-26 03:30:00', 'coach:chat', 'claude-sonnet-5', 0.10);
  // The prior 7 full days (9/19-9/25): $0.10 a day.
  for (let i = 1; i <= 7; i++) if (i !== 1) put(`${dayBefore('2026-09-26', i)} 15:00:00`, 'coach:chat', 'claude-sonnet-5', 0.10);
  // Today (9/26 New York): $0.60 across models, features and sources, plus a credit failure.
  put('2026-09-26 13:00:00', 'coach:chat', 'claude-sonnet-5', 0.30);
  put('2026-09-26 14:00:00', 'coach:route', 'claude-haiku-4-5-20251001', 0.05);
  put('2026-09-26 14:30:00', 'news:typed', 'claude-haiku-4-5-20251001', 0.05, 'offline');
  put('2026-09-26 15:00:00', 'coach:judge', 'claude-haiku-4-5-20251001', 0.20, 'test');
  put('2026-09-26 15:30:00', 'coach:chat', 'claude-sonnet-5', 0, 'app', 'credit');
  const s = spendSummary(30, { now, ingest: false });
  assert.equal(s.timezone, 'America/New_York');
  assert.equal(s.today.date, '2026-09-26');
  assert.equal(s.today.cost, 0.6);
  assert.equal(s.yesterday.date, '2026-09-25');
  assert.equal(s.yesterday.cost, 0.1, 'the 23:30 call is yesterday in New York');
  assert.deepEqual(s.today_by_model.map(m => [m.model, m.cost]).sort(), [['claude-haiku-4-5-20251001', 0.3], ['claude-sonnet-5', 0.3]]);
  assert.deepEqual(s.today_by_source.map(m => [m.source, m.cost]), [['app', 0.35], ['test', 0.2], ['offline', 0.05]]);
  assert.equal(s.today_by_feature[0].feature, 'coach:chat');
  assert.equal(s.anomaly.avg_7d_usd, 0.1);
  assert.equal(s.anomaly.ratio, 6);
  assert.equal(s.anomaly.anomaly, true);
  assert.deepEqual(s.anomaly.top_driver, { feature: 'coach:chat', cost_usd: 0.3, share: 0.5 });
  assert.deepEqual(s.credit_errors, { today: 1, period: 1 });
  const { DEFAULT_DAILY_BUDGETS_USD } = await import('../server/services/llm-budget.js');
  const expectedTotal = Object.values(DEFAULT_DAILY_BUDGETS_USD).reduce((a, b) => a + b, 0);
  assert.equal(s.total_budget.budget_usd, +expectedTotal.toFixed(4), 'the sum of every default daily budget (coach, trade proposals, Numbers & People)');
  assert.equal(s.total_budget.spent_usd, 0.35, 'app and offline calls on budgeted features; test calls do not count');
  assert.equal(s.day_totals.length, 30);
  assert.equal(s.day_totals.find(d => d.date === '2026-09-20').cost, 0.1);
  // The anomaly rule's two halves.
  const quiet = spendSummary(30, { now: new Date('2026-09-25T20:00:00Z'), ingest: false });
  assert.equal(quiet.anomaly.anomaly, false, 'an ordinary day is not an anomaly');
  run(`DELETE FROM ai_usage WHERE created_at >= '2026-09-26 13:00:00'`);
  put('2026-09-26 13:00:00', 'coach:chat', 'claude-sonnet-5', 0.22);
  assert.equal(spendSummary(30, { now, ingest: false }).anomaly.anomaly, false, 'over 2x but under $0.25');
  assert.equal(etDay('2026-09-26 03:59:59'), '2026-09-25');
  assert.equal(etDay('2026-09-26 04:00:00'), '2026-09-26');
});

test('test calls never count against a budget', () => {
  run('DELETE FROM ai_usage');
  setDailyBudget('coach', 1);
  run(`INSERT INTO ai_usage (date, feature, model, input_tokens, output_tokens, cost_usd, calls, source) VALUES (date('now'), 'coach:judge', 'claude-sonnet-5', 0, 0, 0.9, 1, 'test')`);
  run(`INSERT INTO ai_usage (date, feature, model, input_tokens, output_tokens, cost_usd, calls, source) VALUES (date('now'), 'coach:chat', 'claude-sonnet-5', 0, 0, 0.1, 1, 'app')`);
  assert.equal(+spentTodayUsd('coach').toFixed(4), 0.1);
});

test('the morning brief line: "Yesterday: $X API, N calls", cited and grounded', () => {
  const ledger = newLedger();
  const [c] = spendClaims({ status: 'ok', rows: [{ date: '2026-09-25', cost_usd: 0.4312, calls: 12 }] }, ledger);
  assert.equal(c.text, 'Yesterday: $0.43 API, 12 calls.');
  assert.equal(checkClaim(c, ledger).ok, true);
  const [f] = spendClaims({ status: 'failed', reason: 'the summary could not be read', rows: [] }, newLedger());
  assert.match(f.text, /not read/);
  assert.deepEqual(spendClaims(undefined, newLedger()), [], 'the weekly check-in has no spend input: no line');
});

test("the brief's reader counts yesterday by the New York day, through the brief's own database handle", async () => {
  const { readYesterdaySpendSync } = await import('../server/services/coach/brief-inputs.js');
  const { db } = await import('../server/db/index.js');
  run('DELETE FROM ai_usage');
  const put = (at, cost) => run(`INSERT INTO ai_usage (date, feature, model, input_tokens, output_tokens, cost_usd, calls, created_at)
    VALUES (substr(?, 1, 10), 'coach:chat', 'claude-sonnet-5', 0, 0, ?, 1, ?)`, at, cost, at);
  put('2026-09-26 03:30:00', 0.10); // 23:30 New York, 9/25: yesterday
  put('2026-09-25 12:00:00', 0.20); // 08:00 New York, 9/25: yesterday
  put('2026-09-25 03:30:00', 0.40); // 23:30 New York, 9/24: not
  put('2026-09-26 13:00:00', 0.80); // today
  const r = readYesterdaySpendSync(db, { now: new Date('2026-09-26T16:00:00Z') });
  assert.deepEqual(r.rows, [{ date: '2026-09-25', cost_usd: 0.3, calls: 2 }]);
});

test('the Dev Hub summary keeps its old fields and serves the new ones', async () => {
  const { usageSummary } = await import('../server/services/claude.js');
  const s = usageSummary(30);
  for (const k of ['today', 'period_days', 'period_cost', 'daily', 'by_feature', 'budgets']) assert.ok(k in s, `kept ${k}`);
  for (const k of ['timezone', 'yesterday', 'today_by_model', 'today_by_feature', 'today_by_source', 'total_budget', 'anomaly', 'credit_errors', 'shared_ledger', 'day_totals', 'by_source']) {
    assert.ok(k in s, `new ${k}`);
  }
});
