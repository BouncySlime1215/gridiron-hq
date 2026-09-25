/**
 * RISK-RULE (ONE-PLAN 4d, night 3): one decision rule per risk mode, behind GRIDIRON_RISK_RULE (off).
 *
 *   Safe      worst case: the lowest place the path can end (a declined step included)
 *   Balanced  minimax regret: the smallest worst-scenario shortfall against the best candidate
 *             (or doing nothing) in each "first k offers say yes" scenario
 *   Fuck-it   expected title odds across yes/no outcomes (risk-neutral), still refusing a plan
 *             that almost never lands
 *
 * Off, every function returns exactly what it did before. Made-up plans and the made-up
 * four-team fixture only; no real league data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const M = await import('../server/services/campaign/modes.js');
const { rankPlans, compareModes, scorePlan, riskRuleOn, worstCase, maxRegret, RISK_RULE_ENV } = M;

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const OPEN = Object.freeze({ max_assets: 9, max_offers_per_manager_week: 9, max_downside_per_step: Infinity, max_give_per_step: 9 });
const ctx = { originalIds: [1, 2, 3, 4, 5] };
const step = (team, p, delta, give = [1], get = [9]) => ({ team, give, get, p, delta, se: 0.001 });
const top = (plans, mode, rule) => rankPlans(plans, mode, OPEN, ctx, { rule }).ranked[0].steps[0].team;

const ON = { [RISK_RULE_ENV]: '1' };
const planWith = (mode, env, adapter = makeAdapter()) => {
  const res = planLeague(adapter, { objective: normaliseObjective({ risk_mode: mode }), env });
  return { res, json: JSON.stringify(toEntry(res, { names: adapter.names(), as_of: '2026-09-24T00:00:00Z' })) };
};

test('the flag is off unless GRIDIRON_RISK_RULE=1', () => {
  assert.equal(RISK_RULE_ENV, 'GRIDIRON_RISK_RULE');
  assert.equal(riskRuleOn({}), false);
  assert.equal(riskRuleOn({ GRIDIRON_RISK_RULE: '0' }), false);
  assert.equal(riskRuleOn({ GRIDIRON_RISK_RULE: 'true' }), false);
  assert.equal(riskRuleOn({ GRIDIRON_RISK_RULE: '1' }), true);
});

test('worst case is the lowest reachable ending, a declined first offer (0) included', () => {
  close(worstCase([step('2', 0.5, 0.08)]), 0);
  close(worstCase([step('2', 0.5, -0.02), step('3', 0.5, 0.10)]), -0.02);
  // A certain step cannot be declined, so 0 is not reachable.
  close(worstCase([step('2', 1, 0.03), step('3', 0.5, 0.05)]), 0.03);
  close(worstCase([]), 0);
});

test('max regret is measured against the best candidate or doing nothing in each scenario', () => {
  const X = { steps: [step('2', 0.3, 0.10)] };
  const Y = { steps: [step('3', 0.8, 0.03), step('4', 0.8, 0.06)] };
  // Scenario k = the first k offers say yes. k=1: X .10, Y .03. k=2: X .10, Y .06.
  close(maxRegret(X, [X, Y]), 0);
  close(maxRegret(Y, [X, Y]), 0.07);
  // A lone plan that strands below today regrets against doing nothing.
  const Z = { steps: [step('2', 0.9, -0.02), step('3', 0.9, 0.05)] };
  close(maxRegret(Z, [Z]), 0.02);
  close(maxRegret(X, [X]), 0);
});

test('Safe (rule on) maximises the worst case; ties go to the higher expectation', () => {
  const coin = { steps: [step('2', 0.5, 0.08)] };            // expected .04, worst 0
  const sure = { steps: [step('3', 0.95, 0.01)] };           // expected .0095, worst 0
  const strand = { steps: [step('4', 0.5, -0.02), step('2', 0.5, 0.30, [2], [8])] }; // worst -.02
  assert.equal(top([coin, sure], 'safe', false), '3', 'legacy Safe: expected minus one spread');
  assert.equal(top([coin, sure], 'safe', true), '2');
  assert.equal(top([strand, sure], 'safe', true), '3');
  const s = scorePlan(strand, 'safe', { rule: true });
  close(s.score, -0.02);
  assert.match(s.why, /worst case/i);
});

test('Balanced (rule on) minimises max regret; legacy Balanced maximised the expectation', () => {
  const X = { steps: [step('2', 0.3, 0.10)] };
  const Y = { steps: [step('3', 0.8, 0.03), step('4', 0.8, 0.06, [2], [8])] };
  assert.equal(top([X, Y], 'balanced', false), '3');   // expected .0432 beats .03
  assert.equal(top([X, Y], 'balanced', true), '2');    // regret 0 beats .07
  const r = rankPlans([X, Y], 'balanced', OPEN, ctx, { rule: true }).ranked;
  close(r[0].score, 0);
  close(r[1].score, -0.07);
  assert.match(r[0].why, /regret/i);
  // Still refuses a plan that almost never lands.
  const longShot = { steps: [step('4', 0.02, 0.9)] };
  const out = rankPlans([longShot, Y], 'balanced', OPEN, ctx, { rule: true });
  assert.equal(out.ranked[0].steps[0].team, '3');
  assert.ok(out.dropped.some(d => d.plan === longShot));
});

test('Balanced regret can be scored against a wider pool (the confirmed deck)', () => {
  const X = { steps: [step('2', 0.3, 0.10)] };
  const Y = { steps: [step('3', 0.8, 0.03)] };
  const alone = rankPlans([Y], 'balanced', OPEN, ctx, { rule: true }).ranked[0];
  const pooled = rankPlans([Y], 'balanced', OPEN, { ...ctx, regretPool: [X, Y] }, { rule: true }).ranked[0];
  close(alone.score, 0);
  close(pooled.score, -0.07);
});

test('Fuck-it (rule on) maximises expected title odds, not the landing', () => {
  const shot = { steps: [step('2', 0.1, 0.2)] };   // expected .02, if it lands .2
  const solid = { steps: [step('3', 0.9, 0.05)] }; // expected .045
  assert.equal(top([shot, solid], 'all_in', false), '2');
  assert.equal(top([shot, solid], 'all_in', true), '3');
  const longShot = { steps: [step('4', 0.02, 0.9)] };
  assert.equal(scorePlan(longShot, 'all_in', { rule: true }).eligible, false);
});

test('rule off: rankPlans and compareModes are identical with no option and with rule:false', () => {
  const plans = [
    { steps: [step('2', 0.5, 0.08)] }, { steps: [step('3', 0.95, 0.01)] },
    { steps: [step('4', 0.5, -0.002), step('2', 0.5, 0.30, [2], [8])] }, { steps: [step('3', 0.1, 0.2, [3], [7])] },
  ];
  const ctxFor = () => ({ tol: OPEN, ctx });
  const legacy = { r: M.MODES.map(m => rankPlans(plans, m, OPEN, ctx)), c: compareModes(plans, ctxFor) };
  const explicit = { r: M.MODES.map(m => rankPlans(plans, m, OPEN, ctx, { rule: false })), c: compareModes(plans, ctxFor, null, { rule: false }) };
  assert.deepEqual(explicit, legacy);
});

test('rule on: the three modes pick three different first steps on one pool', () => {
  const X = { steps: [step('2', 0.3, 0.10)] };                                  // regret winner
  const Y = { steps: [step('3', 0.8, 0.03), step('4', 0.8, 0.06, [2], [8])] }; // best expected
  const W = { steps: [step('4', 1, 0.02, [3], [7])] };                          // best worst case
  const rows = compareModes([X, Y, W], () => ({ tol: OPEN, ctx }), null, { rule: true });
  assert.deepEqual(rows.map(r => r.first_step.team), ['4', '2', '3']);
  // Every pick beats doing nothing on its expected gain, whatever its rule score (regret is 0 here).
  for (const r of rows) assert.equal(r.no_trade.pick, 'plan');
});

test('review 1: "beats doing nothing" is its own test (expected > 0), not the rule score', () => {
  const X = { steps: [step('2', 0.3, 0.10)] };
  const lose = { steps: [step('3', 0.9, -0.01)] };
  const r = rankPlans([X], 'balanced', OPEN, ctx, { rule: true }).ranked[0];
  close(r.score, 0);                                  // regret 0: not above 0 ...
  assert.equal(M.beatsNoTrade(r, 'balanced', { rule: true }), true); // ... yet it beats doing nothing
  assert.equal(M.beatsNoTrade(r, 'balanced', { rule: false }), false);
  const s = rankPlans([lose], 'safe', OPEN, ctx, { rule: true }).ranked[0];
  assert.equal(M.beatsNoTrade(s, 'safe', { rule: true }), false);
  // All plans lose title odds: every mode's row is "no trade", rule on.
  const rows = compareModes([lose, { steps: [step('4', 0.5, -0.02)] }], () => ({ tol: OPEN, ctx }), null, { rule: true });
  for (const row of rows) { assert.equal(row.no_trade.pick, 'no_trade'); }
});

test('review 4: the rule reads the planner settings env only, never process.env', () => {
  const prev = process.env[RISK_RULE_ENV];
  process.env[RISK_RULE_ENV] = '1';
  try {
    for (const mode of M.MODES) assert.equal(planWith(mode, {}).json, planWith(mode, undefined).json);
    const X = { steps: [step('2', 0.3, 0.10)] }, Y = { steps: [step('3', 0.8, 0.03), step('4', 0.8, 0.06, [2], [8])] };
    assert.equal(top([X, Y], 'balanced', undefined), '3', 'no option = legacy, even with the process flag set');
  } finally { if (prev == null) delete process.env[RISK_RULE_ENV]; else process.env[RISK_RULE_ENV] = prev; }
});

test('planner: flag "0" is byte-identical to no flag; flag on validates and serves a deck in every mode', () => {
  for (const mode of M.MODES) {
    assert.equal(planWith(mode, { [RISK_RULE_ENV]: '0' }).json, planWith(mode, {}).json, `${mode}: flag "0" changed the entry`);
    const on = planWith(mode, ON);
    assert.deepEqual(validateLeague(JSON.parse(on.json)).errors, [], `${mode}: rule-on entry fails the schema`);
    assert.ok(on.res.deck.length >= 1, `${mode}: rule on serves no card`);
    for (const c of on.res.deck) assert.ok(c.plan.expected > 0, `${mode}: a served card does not beat doing nothing`);
    const row = on.res.risk_modes.find(r => r.mode === mode);
    assert.equal(row.no_trade.pick, 'plan');
  }
});

test('review 1: rule on, every plan loses on the confirm dice -> empty deck and "no trade" in every mode', () => {
  for (const mode of M.MODES) {
    const a = makeAdapter();
    const w0 = a.world;
    a.world = s => {
      const w = w0(s);
      if (s === a.seed) return w;
      return { ...w, rescore(state, x, y) {
        const r = w.rescore(state, x, y);
        const d = -Math.abs(r.me.title_delta) - 0.01;
        return { ...r, me: { ...r.me, title_delta: d, title_after: r.me.title_before + d } };
      } };
    };
    const { res } = planWith(mode, ON, a);
    assert.equal(res.confirm.status, 'ok');
    assert.deepEqual(res.deck, [], `${mode}: a card was served that loses on the confirm dice`);
    for (const row of res.risk_modes) assert.equal(row.no_trade.pick, 'no_trade', `${mode}/${row.mode}`);
  }
});

test('review 2: the confirmed Balanced deck is ordered by regret against the surviving cards', () => {
  const { res } = planWith('balanced', ON);
  const deck = res.deck.map(c => c.plan);
  assert.ok(deck.length >= 2, `the fixture yields a deck of at least two cards (got ${deck.length})`);
  for (let i = 1; i < deck.length; i++) assert.ok(deck[i - 1].score >= deck[i].score, `card ${i} outranks card ${i - 1}`);
  for (const p of deck) {
    assert.ok(p.score <= 0, `a regret score is never positive (got ${p.score})`);
    assert.ok(-p.score >= maxRegret(p, deck) - 1e-12, 'regret is scored against the deck, not the card alone');
  }
  // Not collapsed to the lone-card regret: at least one card regrets against another.
  assert.ok(deck.some(p => p.score < 0), 'every card scored 0: regret was measured against itself alone');
});

test('review 3: compareModes keeps pickFor as its third argument and the rule as the fourth', () => {
  const X = { steps: [step('2', 0.3, 0.10)] };
  const rows = compareModes([X], () => ({ tol: OPEN, ctx }), () => ({ best: null, confirmed: true }), { rule: true });
  for (const r of rows) { assert.equal(r.first_step, null); assert.equal(r.no_trade.pick, 'no_trade'); }
});

test('batch B: Safe (rule on) beats doing nothing only if no ending leaves Nick below today', () => {
  // Expected gain > 0, but a yes on the first offer and a no on the second strands Nick at -0.02.
  const strand = { steps: [step('2', 0.9, -0.02), step('3', 0.9, 0.20)] };
  const sure = { steps: [step('4', 0.4, 0.03)] };
  assert.ok(worstCase(strand.steps) < 0);
  for (const mode of M.MODES) {
    const r = rankPlans([strand], mode, OPEN, ctx, { rule: true }).ranked[0];
    assert.ok(r.expected > 0, mode);
    // Balanced and Fuck-it judge by the expected gain; Safe by the worst case, which doing nothing (0) beats.
    assert.equal(M.beatsNoTrade(r, mode, { rule: true }), mode !== 'safe', mode);
  }
  const s = rankPlans([sure], 'safe', OPEN, ctx, { rule: true }).ranked[0];
  assert.equal(M.beatsNoTrade(s, 'safe', { rule: true }), true);
  // Only the unstrandable plan can be Safe's pick on the sheet.
  const row = compareModes([strand, sure], () => ({ tol: OPEN, ctx }), null, { rule: true }).find(x => x.mode === 'safe');
  assert.equal(row.no_trade.pick, 'plan');
  assert.equal(row.first_step.team, '4');
  const only = compareModes([strand], () => ({ tol: OPEN, ctx }), null, { rule: true }).find(x => x.mode === 'safe');
  assert.equal(only.no_trade.pick, 'no_trade');
});

test('batch B: planner, rule on: every served card beats doing nothing under its own mode on the confirm dice', () => {
  for (const mode of M.MODES) {
    const { res } = planWith(mode, ON);
    for (const c of res.deck) {
      assert.ok(c.plan.expected > 0, `${mode}: served card with expected ${c.plan.expected}`);
      if (mode === 'safe') assert.ok(worstCase(c.plan.steps) >= 0, 'Safe served a card that can strand Nick below today');
    }
  }
});
