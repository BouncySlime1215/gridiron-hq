import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// REASON-01 reasoning panels, read from the War Room contract (FIX-08):
// test/fixtures/reasoning/plans.json is the #238 contract fixture plus a full
// deck and a thin league, and it validates against plans-schema.js. Every call goes to a stand-in: either an
// injected callClaude (pure checks) or the real callClaude over a fake client
// (the cost guard, so the real per-league budget does the refusing). No
// network, no key, no spend.
process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-reasoning-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db } = await import('../server/db/index.js');
const claude = await import('../server/services/claude.js');
const budget = await import('../server/services/llm-budget.js');
const { produceReasoning, budgetFeatureFor } = await import('../server/services/reasoning/produce.js');
const { cardsForLeague, MAX_CARDS_PER_LEAGUE } = await import('../server/services/reasoning/cards.js');
const { panelErrors } = await import('../server/services/reasoning/schema.js');

const { validatePlans, MAX_ALTERNATIVES } = await import('../server/services/campaign/plans-schema.js');

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/reasoning/plans.json', import.meta.url), 'utf8'));
const NEWS = JSON.parse(fs.readFileSync(new URL('./fixtures/reasoning/news.json', import.meta.url), 'utf8'));
/** produce.js input: the contract leagues, windowed at the plans file's generated_at. */
const plans = () => ({ as_of: FIXTURE.generated_at, leagues: structuredClone(FIXTURE.leagues) });
const news = () => structuredClone(NEWS);
const deckOf = (p, i = 0) => p.leagues[i].alternatives.value;
const ok = (p, i = 0) => p.leagues[i].panels;

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

/** The cards a prompt carries, read back out of it. */
function promptCards(prompt) {
  return JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
}

/** A well-behaved writer: every number it states is in a fact it cites. */
function honestPanel(card, overrides = {}) {
  const has = s => !card.omit.includes(s);
  return {
    card_id: card.card_id,
    case_for: { claims: [{ text: `Chance he says yes is ${Math.round(card.facts['card.p_yes'] * 100)}%.`, cites: ['card.p_yes'] }] },
    ...(has('his_side') ? { his_side: { claims: [{ text: 'His WR hole is 4.5 points.', cites: ['his.hole.0.gap', 'his.hole.0.pos'] }] } } : {}),
    devils_advocate: {
      claims: [{ text: 'The title-odds gain is only a few points.', cites: ['card.title_delta'] }],
      would_change: [{ text: 'Missing the send window would change it.', cites: ['card.send_when'] }]
    },
    ...(has('news_check') ? { news_check: { contradictions: card.news.map(n => ({ quote_id: n.quote_id,
      claim: { text: 'The back he sends was limited in practice.', cites: [`news.${n.quote_id}.headline`] } })) } } : {}),
    ...(has('counter') ? { counter: {
      likely: { text: 'He asks for the tight end instead.', cites: ['reply.counter.counter'] },
      answer: { text: 'Answer by the counter rules.', cites: ['reply.counter.action'] } } } : {}),
    ...overrides
  };
}

function injectedWriter(edit = (c, p) => p) {
  const prompts = [];
  const callClaude = async req => {
    prompts.push(req);
    const panels = promptCards(req.prompt).map(c => edit(c, honestPanel(c)));
    return { content: [{ type: 'text', text: JSON.stringify({ panels }) }], usage: { input_tokens: 1000, output_tokens: 500 }, cost_usd: 0.0105 };
  };
  return { prompts, callClaude };
}

test('the fixture is the contract: it validates against plans-schema.js', () => {
  assert.deepEqual(validatePlans(FIXTURE).errors, []);
});

test('only the deck (head + four) reaches the prompt, one call per league with a deck', async () => {
  const over = plans();
  const deck = deckOf(over);
  for (const id of ['L1-m6', 'L1-m7']) deck.push({ ...structuredClone(deck[1]), move_id: id, rank: deck.length + 1 });
  const { cards, dropped } = cardsForLeague(over.leagues[0]);
  assert.equal(MAX_CARDS_PER_LEAGUE, MAX_ALTERNATIVES);
  assert.equal(cards.length, 5);
  assert.equal(dropped, 2, 'an over-long deck is cut before any prompt');

  const w = injectedWriter();
  const out = await produceReasoning({ plans: plans(), news: news(), callClaude: w.callClaude });
  assert.equal(w.prompts.length, 2, 'league 1 and league 4; the failed league and the empty deck cost nothing');
  const ids = promptCards(w.prompts[0].prompt).map(c => c.card_id);
  assert.deepEqual(ids, ['L1-m1', 'L1-m2', 'L1-m3', 'L1-m4', 'L1-m5'], 'card ids are the contract move_ids');
  assert.equal(ok(out).length, 5);
  assert.deepEqual(out.leagues.map(l => l.league_id), [1, 2, 3, 4]);
  assert.equal(w.prompts[0].feature, 'trade_proposals:league-1:reasoning');
});

test('every panel is schema valid', async () => {
  const out = await produceReasoning({ plans: plans(), news: news(), callClaude: injectedWriter().callClaude });
  const panels = out.leagues.flatMap(l => l.panels);
  assert.equal(panels.length, 6);
  for (const p of panels) assert.deepEqual(panelErrors(p), [], p.card_id);
  const top = panels[0];
  assert.equal(top.sections.case_for.status, 'ok');
  assert.equal(top.sections.his_side.status, 'ok');
  assert.equal(top.sections.counter.status, 'ok');
  // League 4 has no reply table and no partner row: said, not faked.
  const l4 = ok(out, 3)[0];
  assert.equal(l4.sections.counter.status, 'unknown');
  assert.equal(l4.sections.his_side.status, 'unknown');
  assert.ok(!('value' in l4.sections.counter));
});

test('schema check catches a failed section that still carries a value', async () => {
  const out = await produceReasoning({ plans: plans(), news: news(), callClaude: injectedWriter().callClaude });
  const p = structuredClone(ok(out)[0]);
  p.sections.case_for = { ...p.sections.case_for, status: 'failed', reason: 'hidden' };
  assert.ok(panelErrors(p).some(e => /failed but carries a value/.test(e)));
});

test('grounding rejects an invented number and hides only that section', async () => {
  const w = injectedWriter((c, p) => (c.card_id === 'L1-m1'
    ? { ...p, case_for: { claims: [{ text: 'Chance he says yes is 64%.', cites: ['card.p_yes'] }] } } : p));
  const out = await produceReasoning({ plans: plans(), news: news(), callClaude: w.callClaude });
  const top = ok(out)[0];
  assert.equal(top.sections.case_for.status, 'failed');
  assert.ok(!('value' in top.sections.case_for), 'failed section carries no words');
  assert.doesNotMatch(top.sections.case_for.reason, /\d/, 'failed reason has no digits');
  const v = top.grounding.case_for.violations;
  assert.equal(v[0].kind, 'ungrounded_number');
  assert.equal(v[0].number, '64');
  assert.equal(top.sections.devils_advocate.status, 'ok', 'the rest of the panel still ships');
  assert.equal(ok(out)[1].sections.case_for.status, 'ok');
});

test('a cite to a fact that is not in the plan fails the section', async () => {
  const w = injectedWriter((c, p) => ({ ...p, case_for: { claims: [{ text: 'He needs this.', cites: ['his.secret'] }] } }));
  const out = await produceReasoning({ plans: plans(), news: news(), callClaude: w.callClaude });
  assert.equal(ok(out)[0].grounding.case_for.violations[0].kind, 'bad_cite');
});

test('his side: partners.value[] labels only, never chat quotes', async () => {
  const w = injectedWriter();
  await produceReasoning({ plans: plans(), news: news(), callClaude: w.callClaude });
  const top = promptCards(w.prompts[0].prompt)[0];
  assert.equal(top.facts['his.label.0'], 'rebuilding');
  assert.equal(top.facts['his.label.1'], 'hates wide receivers');
  assert.equal(top.facts['his.p_responds'], 0.62);
  assert.equal(top.facts['his.offers_logged'], 3);
  assert.ok(!Object.values(top.facts).some(v => String(v).includes('never trading')), 'a quote-shaped label never reaches the model');

  const quoting = injectedWriter((c, p) => (p.his_side
    ? { ...p, his_side: { claims: [{ text: 'He said "I am rebuilding for sure".', cites: ['his.label.0'] }] } } : p));
  const out = await produceReasoning({ plans: plans(), news: news(), callClaude: quoting.callClaude });
  const his = ok(out)[0];
  assert.equal(his.sections.his_side.status, 'failed');
  assert.equal(his.grounding.his_side.violations[0].kind, 'quote_in_his_side');
});

test('news check: 48 h news on a card player marks it check first with the quote id', async () => {
  const w = injectedWriter();
  const out = await produceReasoning({ plans: plans(), news: news(), callClaude: w.callClaude });
  const sent = promptCards(w.prompts[0].prompt)[0].news.map(n => n.quote_id);
  assert.deepEqual(sent, ['n-recent'], 'old and unrelated news are not sent');
  const top = ok(out)[0];
  assert.equal(top.check_first, true);
  assert.deepEqual(top.check_first_quote_ids, ['n-recent']);
  assert.equal(top.sections.news_check.value.checked, 1);
  const other = ok(out)[1];
  assert.equal(other.check_first, false);
  assert.equal(other.sections.news_check.status, 'ok');
  assert.equal(other.sections.news_check.value.checked, 0);
});

test('news check: a story the model was not given is rejected', async () => {
  const w = injectedWriter((c, p) => (p.news_check ? { ...p, news_check: { contradictions: [
    { quote_id: 'n-old', claim: { text: 'Old note.', cites: ['news.n-recent.headline'] } }] } } : p));
  const out = await produceReasoning({ plans: plans(), news: news(), callClaude: w.callClaude });
  const top = ok(out)[0];
  assert.equal(top.sections.news_check.status, 'failed');
  assert.equal(top.grounding.news_check.violations.at(-1).kind, 'unknown_news_id');
  assert.equal(top.check_first, true, 'unchecked news still says check first');
});

test('confidence is built from the fields: p_yes.n and the brain report E1 status', async () => {
  const out = await produceReasoning({ plans: plans(), news: news(), callClaude: injectedWriter().callClaude });
  const [top, second] = ok(out);
  assert.equal(top.sections.confidence.status, 'thin');
  assert.equal(top.sections.confidence.n, 4, 'p_yes.n, not his offers_logged (3)');
  assert.equal(top.sections.confidence.value.calibrated, false);
  assert.equal(top.sections.confidence.value.calibration_status, 'E1 not_enough_data');
  assert.equal(top.sections.confidence.value.p_yes_basis, 'market+activity');
  assert.equal(second.sections.confidence.status, 'ok');
  assert.equal(second.sections.confidence.source, 'clone.accept');
  assert.equal(ok(out, 3)[0].sections.confidence.value.calibration_status, 'brain report not available');
});

test('an unchanged move_id reuses its panel and costs nothing', async () => {
  const first = await produceReasoning({ plans: plans(), news: news(), callClaude: injectedWriter().callClaude });
  const w = injectedWriter();
  const again = await produceReasoning({ plans: plans(), news: news(), previous: first, callClaude: w.callClaude });
  assert.equal(w.prompts.length, 0);
  assert.equal(again.total_cost_usd, 0);
  assert.ok(ok(again).every(p => p.cost.reused));

  const changed = plans();
  deckOf(changed)[2].steps[0].p_yes.value = 0.41;
  const w2 = injectedWriter();
  await produceReasoning({ plans: changed, news: news(), previous: first, callClaude: w2.callClaude });
  assert.equal(w2.prompts.length, 1);
  assert.deepEqual(promptCards(w2.prompts[0].prompt).map(c => c.card_id), ['L1-m3']);
});

test('dry run makes no call and says so', async () => {
  const w = injectedWriter();
  const out = await produceReasoning({ plans: plans(), news: news(), dryRun: true, callClaude: w.callClaude });
  assert.equal(w.prompts.length, 0);
  assert.equal(ok(out)[0].sections.case_for.status, 'unknown');
  assert.match(ok(out)[0].sections.case_for.reason, /Dry run/);
});

// ---------------------------------------------------------------- cost guard, real callClaude

function fakeClient({ outputTokens = 500 } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async body => {
        calls.push(body);
        const text = body.messages[0].content;
        const panels = promptCards(text).map(c => honestPanel(c));
        return { id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: JSON.stringify({ panels }) }], stop_reason: 'end_turn',
          usage: { input_tokens: 4000, output_tokens: outputTokens } };
      }
    }
  };
}

test('cost guard: every call is logged with its cost against the league pot', async () => {
  const client = fakeClient();
  claude.setAnthropicClientForTesting(client);
  const logged = [];
  const out = await produceReasoning({ plans: plans(), news: news(), log: c => logged.push(c) });
  assert.equal(client.calls.length, 2);
  assert.equal(logged.length, 2);
  assert.ok(logged.every(c => c.cost_usd > 0 && c.outcome === 'ok'));
  const rows = db.prepare('SELECT feature, cost_usd FROM ai_usage ORDER BY feature').all();
  assert.deepEqual(rows.map(r => r.feature), [budgetFeatureFor(1), budgetFeatureFor(4)]);
  assert.ok(Math.abs(out.total_cost_usd - rows.reduce((s, r) => s + r.cost_usd, 0)) < 1e-9);
});

test('cost guard: stops at the daily cap without calling, and says so on the card', async () => {
  const client = fakeClient({ outputTokens: 40000 });
  claude.setAnthropicClientForTesting(client);
  // First refresh spends league 1's whole pot in one call.
  const first = await produceReasoning({ plans: plans(), news: news() });
  assert.equal(client.calls.length, 2);
  assert.ok(budget.budgetStatus('trade_proposals:league-1').remaining_usd < 0.2);

  // Next refresh, league 1's cards changed: the pot is spent, so no call.
  const changed = plans();
  for (const m of deckOf(changed)) m.steps[0].p_yes.value = 0.4;
  const logged = [];
  const second = await produceReasoning({ plans: changed, news: news(), previous: first, log: c => logged.push(c) });
  assert.equal(client.calls.length, 2, 'no further call once the cap is reached');
  assert.deepEqual(logged.map(c => c.outcome), ['capped']);
  const top = ok(second)[0];
  assert.equal(top.sections.case_for.status, 'unknown');
  assert.match(top.sections.case_for.reason, /allowance for this league is spent/);
  assert.deepEqual(panelErrors(top), []);
  assert.equal(ok(second, 3)[0].cost.reused, true, 'unchanged league is untouched');
});

test('cost guard: a zero budget refuses before any call', async () => {
  budget.setDailyBudget('trade_proposals', 0);
  const client = fakeClient();
  claude.setAnthropicClientForTesting(client);
  const out = await produceReasoning({ plans: plans(), news: news() });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(out.calls.map(c => c.outcome), ['capped', 'capped']);
  assert.equal(out.total_cost_usd, 0);
});
