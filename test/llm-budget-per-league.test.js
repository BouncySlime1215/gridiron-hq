import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The per-league budget fix (2026-09-19). `reserveBudget` held every call
// against `budgetKeyFor(feature)` — the feature name up to the first colon — so
// `trade_proposals:league-1` … `league-5` all drew on ONE $0.50 a day. Whichever
// league Nick opened first could spend the lot, and the other four got a budget
// refusal they had done nothing to earn.
//
// Every test here drives callClaude through an injected fake client: no network,
// no key, no spend. The guarantees are (a) five leagues, five allowances, and
// (b) every other feature behaves exactly as it did.
process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-per-league-budget-'));
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
const LEAGUES = [1, 2, 3, 4, 5];

function fakeClient() {
  const calls = [];
  return {
    calls,
    messages: {
      create: async body => {
        calls.push(body.metadata ?? body.model);
        return { id: 'msg_test', type: 'message', role: 'assistant', model: SONNET,
          content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 } };
      }
    }
  };
}

function seedSpend({ feature, cost, model = SONNET }) {
  db.prepare(`INSERT INTO ai_usage (date, feature, model, input_tokens, output_tokens, calls, cost_usd, created_at)
              VALUES (date('now'), ?, ?, 0, 0, 1, ?, datetime('now'))`).run(feature, model, cost);
}

const near = (actual, expected, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);

/* ------------------------------------------------- the pot a call is held against */

test('the budget SETTING key is still the family; the POT is the league', () => {
  // budgetKeyFor is unchanged on purpose: it answers "which setting is this?",
  // and the setting is still `trade_proposals`. budgetScopeFor answers "whose
  // money is this?", which is what reserveBudget needed all along.
  assert.equal(budget.budgetKeyFor('trade_proposals:league-4'), 'trade_proposals');
  assert.equal(budget.budgetScopeFor('trade_proposals:league-4'), 'trade_proposals:league-4');
  assert.equal(budget.budgetScopeFor('trade_proposals'), 'trade_proposals');
  // Nothing deeper than the league: a retry shares league 4's allowance.
  assert.equal(budget.budgetScopeFor('trade_proposals:league-4:retry'), 'trade_proposals:league-4');
});

test('each of five leagues gets its own $0.50, and one league spending its own blocks only itself', async () => {
  for (const id of LEAGUES) seedSpend({ feature: `trade_proposals:league-${id}`, cost: 0.49 });
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);

  // $0.49 spent of $0.50 each: a small call still fits in every one of them.
  for (const id of LEAGUES) {
    await claude.callClaude({ feature: `trade_proposals:league-${id}`, model: SONNET, prompt: 'q', maxTokens: 100 });
  }
  assert.equal(fake.calls.length, 5, 'five leagues, five allowances — this is the bug this fixes');

  for (const id of LEAGUES) {
    const status = budget.budgetStatus(`trade_proposals:league-${id}`);
    assert.equal(status.budget_usd, 0.50, `league ${id} has its own $0.50`);
    near(status.spent_usd, 0.49 + (100 * 2 + 10 * 10) / 1e6);
  }
});

test('league 1 spending all of its $0.50 does not touch the other four', async () => {
  seedSpend({ feature: 'trade_proposals:league-1', cost: 0.50 });
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);

  await assert.rejects(
    claude.callClaude({ feature: 'trade_proposals:league-1', model: SONNET, prompt: 'q', maxTokens: 100 }),
    err => {
      assert.ok(err instanceof budget.LlmBudgetError);
      assert.equal(err.status, 429);
      assert.equal(err.feature, 'trade_proposals:league-1', 'the refusal names the league that ran out');
      assert.match(err.message, /trade proposals \(league 1\) budget is used/);
      return true;
    });
  assert.equal(fake.calls.length, 0);

  for (const id of [2, 3, 4, 5]) {
    await claude.callClaude({ feature: `trade_proposals:league-${id}`, model: SONNET, prompt: 'q', maxTokens: 100 });
  }
  assert.equal(fake.calls.length, 4, 'four leagues whose own allowance is untouched');
});

test('a league is still capped: its own $0.50 is enforced before the call is paid for', async () => {
  seedSpend({ feature: 'trade_proposals:league-3', cost: 0.45 });
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  // A real proposals call asks for 4,000 output tokens: up to $0.04 of output
  // plus the prompt, which no longer fits in the $0.05 league 3 has left.
  await assert.rejects(
    claude.callClaude({ feature: 'trade_proposals:league-3', model: SONNET, prompt: 'x'.repeat(20_000), maxTokens: 4_000 }),
    budget.LlmBudgetError);
  assert.equal(fake.calls.length, 0, 'per-league is not the same as uncapped');
});

test('calls in flight are held per league, not per family', async () => {
  seedSpend({ feature: 'trade_proposals:league-2', cost: 0.45 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const held = {
    messages: {
      create: async () => {
        await gate;
        return { id: 'm', type: 'message', role: 'assistant', model: SONNET,
          content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 } };
      }
    }
  };
  claude.setAnthropicClientForTesting(held);
  const inFlight = claude.callClaude({ feature: 'trade_proposals:league-2', model: SONNET, prompt: 'q', maxTokens: 4_000 });
  assert.ok(budget.budgetStatus('trade_proposals:league-2').reserved_usd > 0, 'league 2 is holding its share');
  assert.equal(budget.budgetStatus('trade_proposals:league-5').reserved_usd, 0, 'league 5 is holding nothing');
  release();
  await inFlight;
  assert.equal(budget.budgetStatus('trade_proposals:league-2').reserved_usd, 0);
});

/* --------------------------------------------- the settings hook and the reporting */

test('raising the trade-proposals setting raises every league to that amount', () => {
  budget.setDailyBudget('trade_proposals', 0.75);
  for (const id of LEAGUES) {
    const b = budget.getDailyBudget(`trade_proposals:league-${id}`);
    assert.equal(b.budget_usd, 0.75, `league ${id} inherits the setting`);
    assert.equal(b.source, 'setting');
    assert.equal(b.key, `trade_proposals:league-${id}`);
  }
  budget.setDailyBudget('trade_proposals', 0);
  assert.equal(budget.getDailyBudget('trade_proposals:league-4').budget_usd, 0, 'zero turns every league off');
  budget.setDailyBudget('trade_proposals', null);
  assert.equal(budget.getDailyBudget('trade_proposals:league-4').budget_usd, 0.50, 'and null goes back to the default');
});

test('the settings hook still takes family names only, so there is one dial, not five', () => {
  assert.throws(() => budget.setDailyBudget('trade_proposals:league-4', 1), err => err.status === 400);
});

test('listBudgets shows each league that spent today, so the Dev Hub is not read as overdrawn', () => {
  for (const id of [1, 2]) seedSpend({ feature: `trade_proposals:league-${id}`, cost: 0.30 });
  const byKey = Object.fromEntries(budget.listBudgets().map(b => [b.key, b]));
  near(byKey['trade_proposals:league-1'].spent_usd, 0.30);
  near(byKey['trade_proposals:league-2'].spent_usd, 0.30);
  assert.equal(byKey['trade_proposals:league-1'].budget_usd, 0.50);
  assert.equal(byKey['trade_proposals:league-1'].label, 'trade proposals (league 1)');
  assert.ok(!Object.hasOwn(byKey, 'trade_proposals:league-3'), 'a league that spent nothing needs no row');
});

/* --------------------------------------- every other feature, exactly as before */

test('coach and coach:* still share one $1 a day — one family, one pot', async () => {
  seedSpend({ feature: 'coach:answer', cost: 0.60 });
  seedSpend({ feature: 'coach:route', cost: 0.40 });
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await assert.rejects(
    claude.callClaude({ feature: 'coach:answer', model: SONNET, prompt: 'q', maxTokens: 100 }),
    err => {
      assert.equal(err.feature, 'coach', 'the pot is the family, not the sub-feature');
      assert.match(err.message, /Today's Coach budget is used/);
      return true;
    });
  assert.equal(fake.calls.length, 0);
  near(budget.budgetStatus('coach').spent_usd, 1.00);
});

test('a non-league feature key resolves to itself and keeps its own limit', () => {
  assert.equal(budget.budgetScopeFor('nfl-news-typed-extraction'), 'nfl-news-typed-extraction');
  assert.equal(budget.budgetScopeFor('coach:answer'), 'coach');
  assert.deepEqual(budget.getDailyBudget('coach'),
    { key: 'coach', label: 'Coach', budget_usd: 1.00, source: 'default' });
  assert.deepEqual(budget.getDailyBudget('trade_proposals'),
    { key: 'trade_proposals', label: 'trade proposals', budget_usd: 0.50, source: 'default' });
  // An unbudgeted feature is still unbudgeted, colon or no colon.
  assert.equal(budget.getDailyBudget('negotiation_profile').budget_usd, null);
  assert.equal(budget.getDailyBudget('negotiation_profile').source, 'none');
  assert.equal(budget.getDailyBudget('news-analyze:league-4').budget_usd, null);
  assert.equal(budget.getDailyBudget('news-analyze:league-4').source, 'none',
    'only trade_proposals is per scope — nothing else silently gained a budget');
});

test('an unbudgeted feature is still not limited, however many colons it has', async () => {
  seedSpend({ feature: 'negotiation_profile', cost: 50 });
  const fake = fakeClient();
  claude.setAnthropicClientForTesting(fake);
  await claude.callClaude({ feature: 'negotiation_profile', model: SONNET, prompt: 'q', maxTokens: 8_000 });
  assert.equal(fake.calls.length, 1);
});
