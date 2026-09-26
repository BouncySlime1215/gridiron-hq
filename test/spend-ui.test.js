/**
 * SPEND-UI, the server half: the display block Settings -> AI & developer draws (the screen
 * computes nothing), GET /dev/spend, PUT /dev/budgets/:key (setDailyBudget), and the budget name a
 * budget-reached error carries so its message can link to the row. No paid call.
 *
 * Pinned here:
 *   - model DISPLAY names and feature labels only: no raw model id, feature key or key text
 *   - the Today meter: amber at 80%, red at 100% (level from the server)
 *   - last 7 days oldest -> newest, bar heights and the dashed average from the server
 *   - Source breakdown hidden when no source rows exist; the anomaly line and tone
 *   - Daily budgets rows: family editable, a league's pot not; anchors for links
 *   - the key is never sent back, not even masked
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-spend-ui-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-one-XYZW';
delete process.env.GRIDIRON_AI_SOURCE;
delete process.env.GRIDIRON_AI_LEDGER;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { spendSummary, dayBefore } = await import('../server/services/ai-spend.js');
const { spendDisplay, modelLabel, featureLabel, budgetAnchor, METER } = await import('../server/services/ai-spend-display.js');
const { setDailyBudget, LlmBudgetError, DEFAULT_DAILY_BUDGETS_USD } = await import('../server/services/llm-budget.js');
const { default: devRouter } = await import('../server/routes/dev.js');

const put = (at, feature, model, cost, source = 'app') => run(`INSERT INTO ai_usage (date, feature, model, input_tokens, output_tokens,
    cache_read_input_tokens, cache_creation_input_tokens, cost_usd, calls, source, error, created_at) VALUES (substr(?, 1, 10), ?, ?, 0, 0, 0, 0, ?, 1, ?, NULL, ?)`,
at, feature, model, cost, source, at);
const now = new Date('2026-09-26T16:00:00Z');
const RAW = /claude-|typesafe|coach:|news:|trade_proposals|numbers_people|_[a-z]+|sk-ant/;

function seed() {
  run('DELETE FROM ai_usage');
  for (let i = 1; i <= 7; i++) put(`${dayBefore('2026-09-26', i)} 15:00:00`, 'coach:chat', 'claude-sonnet-5', 0.10);
  put('2026-09-26 13:00:00', 'coach:chat', 'claude-sonnet-5', 0.30);
  put('2026-09-26 14:00:00', 'coach:route', 'claude-haiku-4-5-20251001', 0.05);
  put('2026-09-26 14:30:00', 'nfl-news-typed-extraction:x', 'claude-haiku-4-5-20251001', 0.05, 'offline');
  put('2026-09-26 15:00:00', 'coach:judge', 'claude-opus-5-5', 0.20, 'test');
}

test('display names only: models, features and sources in words; no raw id or key reaches the screen', () => {
  seed();
  const d = spendSummary(30, { now, ingest: false }).display;
  assert.deepEqual(d.breakdown.model.map(m => m.label), ['Sonnet 5', 'Opus 5.5', 'Haiku 4.5']);
  assert.deepEqual(d.breakdown.feature.map(m => [m.label, m.cost_usd]), [['Coach', 0.55], ['News', 0.05]], 'features group by family label');
  assert.deepEqual(d.breakdown.source.map(m => m.label), ['App', 'Tests & builds', 'Offline jobs']);
  assert.equal(modelLabel('claude-new-model'), 'Other model');
  assert.equal(featureLabel('mystery_feature:x'), 'Other AI features');
  // Every string value on screen (keys and anchors are ids for links, not text).
  const strings = [];
  const walk = (v, k) => { if (typeof v === 'string') { if (k !== 'key' && k !== 'anchor' && k !== 'date' && k !== 'level' && k !== 'tone') strings.push(v); }
    else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, Array.isArray(v) ? k : kk); };
  walk(d);
  assert.ok(strings.length > 10);
  for (const t of strings) assert.doesNotMatch(t, RAW, t);
});

test('Today: "$X of $Y daily budget", the meter amber at 80% and red at 100%, resets at midnight ET', () => {
  seed();
  const total = Object.values(DEFAULT_DAILY_BUDGETS_USD).reduce((a, b) => a + b, 0);
  const d = spendSummary(30, { now, ingest: false }).display;
  assert.equal(d.today.line, `$0.35 of $${total.toFixed(2)} daily budget`, 'app and offline calls on budgeted features (test calls and unbudgeted news do not count)');
  assert.equal(d.today.resets, 'Resets at midnight ET');
  assert.equal(d.today.estimate, true);
  assert.deepEqual([METER.warn, METER.over], [0.8, 1]);
  const at = share => spendDisplay({ ...spendSummary(30, { now, ingest: false }), total_budget: { budget_usd: 1, spent_usd: share, remaining_usd: 0 } }).today.level;
  assert.deepEqual([at(0.5), at(0.79), at(0.8), at(0.99), at(1), at(1.4)], ['ok', 'ok', 'warn', 'warn', 'over', 'over']);
});

test('last 7 days: oldest to newest, heights and the dashed average from the server', () => {
  seed();
  const w = spendSummary(30, { now, ingest: false }).display.last_7;
  assert.equal(w.days.length, 7);
  assert.equal(w.days.at(-1).date, '2026-09-26', 'today is the last bar');
  assert.equal(w.days[0].date, '2026-09-20');
  assert.equal(w.days[0].label, 'Sun');
  assert.equal(w.days.at(-1).height, 1, 'the tallest bar is full height');
  assert.equal(w.avg_usd, +((0.6 + 6 * 0.1) / 7).toFixed(4));
  assert.equal(w.avg_line, '7-day average $0.17');
  assert.ok(w.avg_height > 0 && w.avg_height < 1);
});

test('anomaly line and tone; the brief line; the always-on note; empty when nothing was ever called', () => {
  seed();
  const d = spendSummary(30, { now, ingest: false }).display;
  assert.equal(d.anomaly.line, 'AI spend today is 6.0x the 7-day average ($0.60 vs $0.10), mostly Coach.');
  assert.equal(d.anomaly.tone, 'red');
  assert.equal(d.brief_line, 'Yesterday: $0.10 API, 1 call');
  assert.equal(d.verified_note, "Not yet verified against Anthropic's billing.");
  assert.equal(d.empty, false);
  run('DELETE FROM ai_usage');
  const e = spendSummary(30, { now, ingest: false }).display;
  assert.deepEqual([e.empty, e.anomaly, e.breakdown.source], [true, null, null], 'no calls: the empty state, no anomaly, Source hidden');
});

test('Daily budgets rows: a family is editable, a league pot shares it; anchors link to rows', () => {
  run('DELETE FROM ai_usage');
  put(new Date().toISOString().replace('T', ' ').slice(0, 19), 'trade_proposals:league-4', 'claude-sonnet-5', 0.45);
  setDailyBudget('coach', 0);
  try {
    const rows = spendSummary(30, { ingest: false }).display.budgets;
    const coach = rows.find(r => r.key === 'coach');
    assert.deepEqual([coach.label, coach.editable, coach.off, coach.anchor], ['Coach', true, true, 'budget-coach']);
    const pot = rows.find(r => r.key === 'trade_proposals:league-4');
    assert.deepEqual([pot.label, pot.editable, pot.anchor, pot.level], ['Trade proposals (league 4)', false, 'budget-trade_proposals-league-4', 'warn']);
    assert.equal(budgetAnchor('numbers_people'), 'budget-numbers_people');
  } finally { setDailyBudget('coach', null); }
});

test('routes: GET /dev/spend (display block, key state, never the key), PUT /dev/budgets/:key; /dev/status sends no masked key', async () => {
  seed();
  const app = express();
  app.use(express.json());
  app.use('/api/dev', devRouter);
  app.use((err, req, res, next) => res.status(Number.isInteger(err.status) ? err.status : 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/dev`;
  try {
    const got = await (await fetch(`${base}/spend`)).json();
    assert.equal(got.api_key.configured, true);
    assert.ok(got.spend.today && got.spend.last_7 && got.spend.breakdown && got.spend.budgets);
    const status = await (await fetch(`${base}/status`)).json();
    for (const body of [got, status]) assert.doesNotMatch(JSON.stringify(body), /sk-ant|XYZW/, 'no key text, not even masked');
    let res = await fetch(`${base}/budgets/coach`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usd: 2.5 }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).spend.budgets.find(r => r.key === 'coach').budget_usd, 2.5);
    res = await fetch(`${base}/budgets/coach`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usd: 500 }) });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/budgets/coach`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usd: '3' }) });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/budgets/coach`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usd: null }) });
    assert.equal((await res.json()).spend.budgets.find(r => r.key === 'coach').is_default, true);
  } finally { server.close(); }
});

test('a budget-reached error names its budget: the app error handler and a trade-proposals refusal', async () => {
  const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(src, /err\.code === 'LLM_BUDGET_EXHAUSTED' && err\.feature \? \{ budget_key: err\.feature \}/);
  const err = new LlmBudgetError({ key: 'trade_proposals:league-4', label: 'trade proposals (league 4)', budgetUsd: 0.5, spentUsd: 0.5, reservedUsd: 0, estimateUsd: 0.1, resetsAtIso: null });
  assert.deepEqual([err.code, err.feature], ['LLM_BUDGET_EXHAUSTED', 'trade_proposals:league-4']);
  const { proposalsFor } = await import('../server/services/trade-proposals.js');
  const refused = await proposalsFor(4, { ideas: [{ id: 'idea-1' }], call: async () => { throw err; } });
  assert.deepEqual([refused.refused, refused.budget_key], [true, 'trade_proposals:league-4']);
  const other = await proposalsFor(4, { ideas: [{ id: 'idea-1' }], call: async () => { throw new Error('overloaded'); } });
  assert.equal(other.budget_key, undefined, 'only a budget refusal names a budget');
});
