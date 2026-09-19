import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// LLM plumbing (WA item llm-plumbing, 2026-09-18): prices for every model the
// app calls, cost and prompt-cache tokens logged per call, prompt caching on
// the system prompt and a caller-supplied prefix, and per-feature daily
// budgets enforced BEFORE a call is paid for. Every test drives callClaude
// through an injected fake client — no network, no key, no spend.
process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-llm-plumbing-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db } = await import('../server/db/index.js');
const claude = await import('../server/services/claude.js');
const budget = await import('../server/services/llm-budget.js');

const originalApiKey = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

test.after(() => {
  claude.setAnthropicClientForTesting(null);
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test.beforeEach(() => {
  db.exec('DELETE FROM ai_usage');
  db.exec("DELETE FROM app_settings WHERE key LIKE 'llm_daily_budget_usd:%'");
  claude.setAnthropicClientForTesting(null);
});

const SONNET = 'claude-sonnet-5';
const HAIKU = 'claude-haiku-4-5-20251001';

/** A stand-in for the SDK client: records each request body and answers with `respond`. */
function fakeClient(respond = () => reply({ input_tokens: 100, output_tokens: 10 })) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async body => {
        calls.push(structuredClone(body));
        return respond(body, calls.length);
      }
    }
  };
}

function reply(usage, model = SONNET) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage
  };
}

function seedSpend({ feature, cost, model = SONNET, daysAgo = 0 }) {
  db.prepare(`INSERT INTO ai_usage (date, feature, model, input_tokens, output_tokens, calls, cost_usd, created_at)
              VALUES (date('now', ?), ?, ?, 0, 0, 1, ?, datetime('now', ?))`)
    .run(`-${daysAgo} days`, feature, model, cost, `-${daysAgo} days`);
}

const near = (actual, expected, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);

// ---------------------------------------------------------------- pricing

test('PRICING carries the published Sonnet 5 and Haiku 4.5 rates, cache writes and reads included', () => {
  assert.deepEqual(claude.PRICING[SONNET], { in: 2.00, out: 10.00, cache_write_5m: 2.50, cache_write_1h: 4.00, cache_read: 0.20 });
  assert.deepEqual(claude.PRICING[HAIKU], { in: 1.00, out: 5.00, cache_write_5m: 1.25, cache_write_1h: 2.00, cache_read: 0.10 });
  assert.deepEqual(claude.PRICING['claude-haiku-4-5'], claude.PRICING[HAIKU]);
  // One table: claude.js re-exports the budget module's prices instead of keeping a second copy.
  assert.equal(claude.PRICING, budget.PRICING);
});

test('costOfUsage prices input, output, cache reads and 5-minute cache writes at the model\'s own rates', () => {
  const cost = budget.costOfUsage(SONNET, {
    input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 4_000
  });
  // 10k x $2 + 2k x $10 + 5k x $0.20 + 4k x $2.50, per million
  near(cost, 0.051);
});

test('costOfUsage prices 1-hour cache writes at 2x input when the API reports the TTL split', () => {
  const cost = budget.costOfUsage(SONNET, {
    input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 4_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 3_000 }
  });
  // 0.02 + 0.02 + 0.001 + (1k x $2.50 + 3k x $4) / 1M
  near(cost, 0.0555);
});

test('costOf keeps its (model, in, out) signature and no longer prices Sonnet at Haiku rates', () => {
  near(claude.costOf(SONNET, 1e6, 1e6), 12);
  near(claude.costOf(HAIKU, 1e6, 1e6), 6);
});

test('an unpriced model throws instead of silently falling back to Haiku rates', () => {
  assert.throws(() => claude.costOf('claude-opus-9', 1000, 1000), /no price/i);
  assert.throws(() => budget.costOfUsage('claude-opus-9', { input_tokens: 1, output_tokens: 1 }), /no price/i);
});

// ---------------------------------------------------------------- logging

test('every call logs cost_usd and the cache read/write tokens, and the message carries its cost', async () => {
  const fake = fakeClient(() => reply({
    input_tokens: 1_200, output_tokens: 300, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0
  }));
  claude.setAnthropicClientForTesting(fake);

  const msg = await claude.callClaude({ feature: 'unit-test', model: SONNET, prompt: 'hello', maxTokens: 400 });

  const logged = db.prepare('SELECT * FROM ai_usage').all();
  assert.equal(logged.length, 1);
  assert.equal(logged[0].feature, 'unit-test');
  assert.equal(logged[0].model, SONNET);
  assert.equal(logged[0].input_tokens, 1_200);
  assert.equal(logged[0].output_tokens, 300);
  assert.equal(logged[0].cache_read_input_tokens, 2_000);
  assert.equal(logged[0].cache_creation_input_tokens, 0);
  near(logged[0].cost_usd, 0.0058); // 1.2k x $2 + 300 x $10 + 2k x $0.20, per million
  near(msg.cost_usd, 0.0058);
  assert.equal(msg.content[0].text, 'ok');
});

test('an unpriced model is refused before the client is called', async () => {
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await assert.rejects(claude.callClaude({ feature: 'unit-test', model: 'claude-opus-9', prompt: 'x' }), /no price/i);
  assert.equal(fake.calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n, 0);
});

// ---------------------------------------------------------------- prompt caching

test('default calls send the system prompt as the same plain string as before (existing callers unchanged)', async () => {
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await claude.callClaude({ feature: 'unit-test', prompt: 'q' });
  assert.equal(fake.calls[0].system, claude.GROUNDING_SYSTEM);
  assert.deepEqual(fake.calls[0].messages, [{ role: 'user', content: 'q' }]);
  assert.equal(fake.calls[0].model, HAIKU);
});

test('cacheSystem sends the system prompt as a text block marked cache_control ephemeral', async () => {
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await claude.callClaude({ feature: 'unit-test', model: SONNET, prompt: 'q', system: 'SYS', cacheSystem: true });
  assert.deepEqual(fake.calls[0].system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
});

test('cachedPrefix goes first in the user turn with cache_control, the varying prompt after it', async () => {
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await claude.callClaude({ feature: 'unit-test', model: SONNET, prompt: 'what now?', cachedPrefix: 'BRIEF' });
  assert.deepEqual(fake.calls[0].messages, [{ role: 'user', content: [
    { type: 'text', text: 'BRIEF', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'what now?' }
  ] }]);
});

test('cachedPrefix on a multi-turn history goes into the first user turn only, without mutating the caller\'s array', async () => {
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  const messages = [
    { role: 'user', content: 'first q' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: [{ type: 'text', text: 'second q' }] }
  ];
  const before = structuredClone(messages);
  await claude.callClaude({ feature: 'unit-test', model: SONNET, messages, cachedPrefix: 'BRIEF' });
  assert.deepEqual(fake.calls[0].messages, [
    { role: 'user', content: [
      { type: 'text', text: 'BRIEF', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'first q' }
    ] },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: [{ type: 'text', text: 'second q' }] }
  ]);
  assert.deepEqual(messages, before);
});

test('cacheTtl 1h is passed through on both breakpoints', async () => {
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await claude.callClaude({ feature: 'unit-test', model: SONNET, prompt: 'q', system: 'SYS',
    cacheSystem: true, cachedPrefix: 'BRIEF', cacheTtl: '1h' });
  assert.deepEqual(fake.calls[0].system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(fake.calls[0].messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('bad caching requests fail before the client is called', async () => {
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await assert.rejects(claude.callClaude({ feature: 'unit-test', model: SONNET, prompt: 'q', cacheSystem: true, cacheTtl: '2h' }),
    /cacheTtl/);
  await assert.rejects(claude.callClaude({ feature: 'unit-test', model: SONNET, cachedPrefix: 'BRIEF',
    messages: [{ role: 'assistant', content: 'hi' }] }), /first message/i);
  await assert.rejects(claude.callClaude({ feature: 'unit-test', model: SONNET, prompt: 'q', cachedPrefix: '' }),
    /cachedPrefix/);
  const marked = name => ({ name, description: 'd', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } });
  await assert.rejects(claude.callClaude({ feature: 'unit-test', model: SONNET, prompt: 'q', cacheSystem: true,
    cachedPrefix: 'BRIEF', tools: [marked('a'), marked('b'), marked('c')] }), /breakpoints/i);
  assert.equal(fake.calls.length, 0);
});

// ---------------------------------------------------------------- budgets

test('defaults: Coach $1/day, trade proposals $0.50/day, every other feature unlimited', () => {
  assert.deepEqual(budget.getDailyBudget('coach'), { key: 'coach', label: 'Coach', budget_usd: 1.00, source: 'default' });
  assert.deepEqual(budget.getDailyBudget('trade_proposals'),
    { key: 'trade_proposals', label: 'trade proposals', budget_usd: 0.50, source: 'default' });
  assert.equal(budget.getDailyBudget('negotiation_profile').budget_usd, null);
  assert.equal(budget.getDailyBudget('negotiation_profile').source, 'none');
});

test('a feature\'s budget key is the part before the first colon', () => {
  assert.equal(budget.budgetKeyFor('coach'), 'coach');
  assert.equal(budget.budgetKeyFor('coach:answer'), 'coach');
  assert.equal(budget.budgetKeyFor('trade_proposals:league-4'), 'trade_proposals');
  assert.equal(budget.budgetKeyFor('nfl-news-typed-extraction'), 'nfl-news-typed-extraction');
});

test('spent today counts coach and coach:* on this local day only, not look-alike features or yesterday', () => {
  seedSpend({ feature: 'coach', cost: 0.10 });
  seedSpend({ feature: 'coach:answer', cost: 0.20 });
  seedSpend({ feature: 'coach:route', cost: 0.05, model: HAIKU });
  seedSpend({ feature: 'coaching-notes', cost: 5.00 });
  seedSpend({ feature: 'trade_proposals', cost: 0.40 });
  seedSpend({ feature: 'coach:answer', cost: 3.00, daysAgo: 1 });
  const status = budget.budgetStatus('coach');
  near(status.spent_usd, 0.35);
  near(status.remaining_usd, 0.65);
  assert.equal(status.budget_usd, 1.00);
  assert.match(status.resets_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Date.parse(status.resets_at) > Date.now());
});

test('a spent Coach budget refuses the call before it is paid for, with a message the page can show', async () => {
  seedSpend({ feature: 'coach:answer', cost: 1.00 });
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await assert.rejects(
    claude.callClaude({ feature: 'coach:answer', model: SONNET, prompt: 'should I start Waddle?', maxTokens: 200 }),
    err => {
      assert.ok(err instanceof budget.LlmBudgetError);
      assert.equal(err.status, 429);
      assert.equal(err.code, 'LLM_BUDGET_EXHAUSTED');
      assert.equal(err.feature, 'coach');
      assert.match(err.message, /Today's Coach budget is used/);
      return true;
    });
  assert.equal(fake.calls.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE feature = 'coach:answer'").get().n, 1);
});

test('the pending call\'s worst-case cost counts: $0.95 spent + up to $0.08 of output is refused, a short answer is not', async () => {
  seedSpend({ feature: 'coach', cost: 0.95 });
  const fake = fakeClient(() => reply({ input_tokens: 50, output_tokens: 20 }));
  claude.setAnthropicClientForTesting(fake);
  await assert.rejects(claude.callClaude({ feature: 'coach', model: SONNET, prompt: 'q', maxTokens: 8_000 }),
    budget.LlmBudgetError);
  assert.equal(fake.calls.length, 0);
  await claude.callClaude({ feature: 'coach', model: SONNET, prompt: 'q', maxTokens: 1_000 });
  assert.equal(fake.calls.length, 1);
});

test('the trade-proposal budget is its own $0.50 pot', async () => {
  seedSpend({ feature: 'coach', cost: 0.99 });
  seedSpend({ feature: 'trade_proposals:league-1', cost: 0.50 });
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await assert.rejects(claude.callClaude({ feature: 'trade_proposals:league-4', model: SONNET, prompt: 'q', maxTokens: 100 }),
    /Today's trade proposals budget is used/);
  assert.equal(fake.calls.length, 0);
});

test('features without a budget are not limited by one', async () => {
  seedSpend({ feature: 'negotiation_profile', cost: 50 });
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await claude.callClaude({ feature: 'negotiation_profile', model: SONNET, prompt: 'q', maxTokens: 8_000 });
  assert.equal(fake.calls.length, 1);
});

test('calls in flight hold their share: two concurrent answers that would overrun together are not both sent', async () => {
  seedSpend({ feature: 'coach', cost: 0.90 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fake = fakeClient(async () => { await gate; return reply({ input_tokens: 1_000, output_tokens: 1_000 }); });
  claude.setAnthropicClientForTesting(fake);

  const first = claude.callClaude({ feature: 'coach', model: SONNET, prompt: 'q1', maxTokens: 6_000 }); // up to ~$0.06
  await assert.rejects(claude.callClaude({ feature: 'coach', model: SONNET, prompt: 'q2', maxTokens: 6_000 }),
    budget.LlmBudgetError);
  release();
  await first;
  assert.equal(fake.calls.length, 1);
  const status = budget.budgetStatus('coach');
  near(status.spent_usd, 0.912, 1e-9); // 0.90 + (1k x $2 + 1k x $10) / 1M
  assert.equal(status.reserved_usd, 0);
});

test('a failed call releases its hold and logs no spend', async () => {
  seedSpend({ feature: 'coach', cost: 0.90 });
  let n = 0;
  const fake = fakeClient(() => {
    n++;
    if (n === 1) throw Object.assign(new Error('overloaded'), { status: 529 });
    return reply({ input_tokens: 100, output_tokens: 100 });
  });
  claude.setAnthropicClientForTesting(fake);
  await assert.rejects(claude.callClaude({ feature: 'coach', model: SONNET, prompt: 'q', maxTokens: 6_000 }), /overloaded/);
  assert.equal(budget.budgetStatus('coach').reserved_usd, 0);
  await claude.callClaude({ feature: 'coach', model: SONNET, prompt: 'q', maxTokens: 6_000 });
  assert.equal(fake.calls.length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE feature = 'coach'").get().n, 2);
});

test('the pre-call estimate does not undershoot a number-dense brief (measured live on Sonnet 5, 2026-09-18)', () => {
  // The exact request of the G4 live cache check: this synthetic brief plus the
  // grounding system prompt billed 5,444 input tokens (12 uncached + 5,432
  // cache write) — about 2.2 characters per token, denser than prose. Situation
  // briefs and trade contexts are mostly numbers, so the gate must hold here.
  const lines = [];
  for (let i = 1; i <= 160; i++) lines.push(`Row ${i}: synthetic player P${i} (team T${i % 32}) projects ${(5 + (i * 7) % 20).toFixed(1)} points, role code R${i % 5}.`);
  const brief = `SYNTHETIC CACHE CHECK BRIEF — not real data.\n${lines.join('\n')}`;
  const request = { model: SONNET, max_tokens: 64, system: claude.GROUNDING_SYSTEM, messages: [{ role: 'user', content: [
    { type: 'text', text: brief, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Reply with the single word: ok' }
  ] }] };
  const inputOnly = budget.estimateCallCostUsd({ model: SONNET, maxTokens: 0, request, cacheTtl: '5m' });
  assert.ok(inputOnly >= 5_444 * 2.50 / 1e6, `estimate $${inputOnly} is below the billed $${5_444 * 2.5 / 1e6}`);
});

// ---------------------------------------------------------------- settings hook

test('Nick can raise, zero and reset a budget; the setting persists in app_settings', async () => {
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  seedSpend({ feature: 'coach', cost: 1.20 });

  assert.deepEqual(budget.setDailyBudget('coach', 2.5), { key: 'coach', label: 'Coach', budget_usd: 2.5, source: 'setting' });
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'llm_daily_budget_usd:coach'").get().value, '2.5');
  await claude.callClaude({ feature: 'coach', model: SONNET, prompt: 'q', maxTokens: 100 });
  assert.equal(fake.calls.length, 1);

  budget.setDailyBudget('coach', 0);
  await assert.rejects(claude.callClaude({ feature: 'coach', model: SONNET, prompt: 'q', maxTokens: 100 }),
    /Today's Coach budget is used/);

  assert.deepEqual(budget.setDailyBudget('coach', null), { key: 'coach', label: 'Coach', budget_usd: 1.00, source: 'default' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'llm_daily_budget_usd:coach'").get().n, 0);
});

test('a budget can be put on a feature that has none by default', async () => {
  budget.setDailyBudget('negotiation_profile', 0.25);
  seedSpend({ feature: 'negotiation_profile', cost: 0.25 });
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await assert.rejects(claude.callClaude({ feature: 'negotiation_profile', model: SONNET, prompt: 'q', maxTokens: 100 }),
    /Today's negotiation_profile budget is used/);
  assert.equal(fake.calls.length, 0);
});

test('bad budget settings are rejected with a 400', () => {
  for (const bad of [-1, Number.NaN, Infinity, 'abc', 101, {}]) {
    assert.throws(() => budget.setDailyBudget('coach', bad), err => err.status === 400, `accepted ${String(bad)}`);
  }
  for (const badKey of ['', 'Bad Key!', 'coach:answer', 'x'.repeat(65), null]) {
    assert.throws(() => budget.setDailyBudget(badKey, 1), err => err.status === 400, `accepted key ${badKey}`);
  }
  assert.equal(budget.getDailyBudget('coach').budget_usd, 1.00);
});

test('listBudgets shows every default and every override with today\'s spend', () => {
  budget.setDailyBudget('negotiation_profile', 0.25);
  seedSpend({ feature: 'coach:answer', cost: 0.30 });
  const list = budget.listBudgets();
  const byKey = Object.fromEntries(list.map(b => [b.key, b]));
  assert.deepEqual(Object.keys(byKey).sort(), ['coach', 'negotiation_profile', 'trade_proposals']);
  near(byKey.coach.spent_usd, 0.30);
  assert.equal(byKey.negotiation_profile.budget_usd, 0.25);
  assert.equal(byKey.trade_proposals.budget_usd, 0.50);
});

// ---------------------------------------------------------------- reporting and correction

test('usageSummary prices each model at its own rate, including legacy rows written without a cost', () => {
  const insert = db.prepare(`INSERT INTO ai_usage (date, feature, model, input_tokens, output_tokens, calls, cost_usd)
                             VALUES (date('now'), ?, ?, ?, ?, 1, ?)`);
  insert.run('negotiation_profile', SONNET, 10_000, 1_000, null);   // legacy writer: no cost stored
  insert.run('nfl-news-typed-extraction', HAIKU, 1_000, 100, null);
  insert.run('coach:answer', SONNET, 0, 0, 0.25);                  // new writer: stored cost is authoritative
  const summary = claude.usageSummary(30);
  const sonnetDay = summary.daily.find(d => d.model === SONNET);
  const haikuDay = summary.daily.find(d => d.model === HAIKU);
  near(sonnetDay.cost, 0.28);   // 10k x $2 + 1k x $10 per million = 0.03, + 0.25 stored
  near(haikuDay.cost, 0.0015);  // 1k x $1 + 100 x $5 per million
  const neg = summary.by_feature.find(f => f.feature === 'negotiation_profile');
  near(neg.cost, 0.03);          // was 0.015 at Haiku rates
  near(summary.today.cost, 0.2815);
  near(summary.period_cost, 0.2815);
  assert.equal(summary.today.calls, 3);
  assert.ok(Array.isArray(summary.budgets));
});

test('usageSummary "today" is Nick\'s local day — the same day the budgets in the same payload count', () => {
  // Verifier (2026-09-18): today was the UTC date while budgets use the local
  // day, so from 8 PM to midnight ET (game nights) the Dev Hub's Today and the
  // Coach budget's spent-today disagreed. A call 1 s before local midnight is
  // yesterday for both, even when it shares the UTC date.
  const start = db.prepare(`SELECT datetime('now', 'localtime', 'start of day', 'utc') AS t`).get().t;
  const add = (offset, cost) => db.prepare(`INSERT INTO ai_usage (date, feature, model, input_tokens, output_tokens, calls, cost_usd, created_at)
                                            VALUES (date(datetime(?, ?)), 'coach:answer', ?, 0, 0, 1, ?, datetime(?, ?))`)
    .run(start, offset, SONNET, cost, start, offset);
  add('+1 second', 0.30);
  add('-1 second', 0.20);
  const summary = claude.usageSummary(30);
  assert.equal(summary.today.calls, 1);
  near(summary.today.cost, 0.30);
  near(summary.budgets.find(b => b.key === 'coach').spent_usd, summary.today.cost);
});

test('recomputeUsageCosts backs the table up first, corrects every priced row, and never overwrites the backup', () => {
  const insert = db.prepare(`INSERT INTO ai_usage (date, feature, model, input_tokens, output_tokens, calls, cost_usd)
                             VALUES ('2026-09-17', ?, ?, ?, ?, 1, ?)`);
  insert.run('negotiation_profile', SONNET, 10_000, 1_000, 0.015);   // costed at Haiku rates
  insert.run('negotiation_profile', SONNET, 20_000, 2_000, null);
  insert.run('player-verdict', HAIKU, 1_000, 100, null);
  insert.run('mystery', 'claude-opus-9', 1_000, 100, null);
  const original = db.prepare('SELECT * FROM ai_usage ORDER BY id').all();

  const result = budget.recomputeUsageCosts({ backupTable: 'ai_usage_backup_test' });
  assert.equal(result.backup.table, 'ai_usage_backup_test');
  assert.equal(result.backup.created, true);
  assert.equal(result.backup.rows, 4);
  assert.deepEqual(db.prepare('SELECT * FROM ai_usage_backup_test ORDER BY id').all(), original);

  const after = Object.fromEntries(db.prepare('SELECT id, cost_usd FROM ai_usage').all().map(r => [r.id, r.cost_usd]));
  near(after[original[0].id], 0.03);
  near(after[original[1].id], 0.06);
  near(after[original[2].id], 0.0015);
  assert.equal(after[original[3].id], null);                       // unpriced: reported, never guessed
  assert.deepEqual(result.unpriced, [{ model: 'claude-opus-9', rows: 1 }]);
  assert.equal(result.rows_updated, 3);
  near(result.total_after_usd, 0.0915);
  near(result.by_model[SONNET].cost_usd, 0.09);

  // A second run must not replace the backup with already-corrected rows.
  db.prepare("UPDATE ai_usage SET cost_usd = 99 WHERE model = ?").run(HAIKU);
  const again = budget.recomputeUsageCosts({ backupTable: 'ai_usage_backup_test' });
  assert.equal(again.backup.created, false);
  assert.deepEqual(db.prepare('SELECT * FROM ai_usage_backup_test ORDER BY id').all(), original);
  near(db.prepare('SELECT cost_usd FROM ai_usage WHERE model = ?').get(HAIKU).cost_usd, 0.0015);
  assert.throws(() => budget.recomputeUsageCosts({ backupTable: 'x; DROP TABLE ai_usage' }), /backup table/i);
});

// A Claude Code cloud box refuses to forward a variable named
// ANTHROPIC_API_KEY to the process — it claims that name for its own session
// auth — so the key is simply absent there and the app looks unconfigured.
// getApiKey() therefore accepts GRIDIRON_ANTHROPIC_API_KEY first, keeps
// ANTHROPIC_API_KEY for every other host, and falls back to app_settings last.
test('getApiKey prefers the host-safe name, then the standard one, then app_settings', () => {
  const saved = { gridiron: process.env.GRIDIRON_ANTHROPIC_API_KEY, standard: process.env.ANTHROPIC_API_KEY };
  const restore = () => {
    for (const [name, value] of [['GRIDIRON_ANTHROPIC_API_KEY', saved.gridiron], ['ANTHROPIC_API_KEY', saved.standard]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    db.exec("DELETE FROM app_settings WHERE key = 'anthropic_api_key'");
  };

  try {
    delete process.env.GRIDIRON_ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'standard-name';
    assert.equal(claude.getApiKey(), 'standard-name');

    // Set together, the host-safe name wins — a cloud box may carry both.
    process.env.GRIDIRON_ANTHROPIC_API_KEY = 'host-safe-name';
    assert.equal(claude.getApiKey(), 'host-safe-name');

    // With neither variable present, the stored setting is still honoured.
    delete process.env.GRIDIRON_ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('anthropic_api_key', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run('from-settings');
    assert.equal(claude.getApiKey(), 'from-settings');

    db.exec("DELETE FROM app_settings WHERE key = 'anthropic_api_key'");
    assert.equal(claude.getApiKey(), null);
  } finally {
    restore();
  }
});
