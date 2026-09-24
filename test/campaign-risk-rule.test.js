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

function withEnv(v, fn) {
  const prev = process.env[RISK_RULE_ENV];
  if (v == null) delete process.env[RISK_RULE_ENV]; else process.env[RISK_RULE_ENV] = v;
  try { return fn(); } finally { if (prev == null) delete process.env[RISK_RULE_ENV]; else process.env[RISK_RULE_ENV] = prev; }
}

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

test('rule off: rankPlans and compareModes are identical with the flag unset, "0", or rule:false', () => {
  const plans = [
    { steps: [step('2', 0.5, 0.08)] }, { steps: [step('3', 0.95, 0.01)] },
    { steps: [step('4', 0.5, -0.002), step('2', 0.5, 0.30, [2], [8])] }, { steps: [step('3', 0.1, 0.2, [3], [7])] },
  ];
  const ctxFor = () => ({ tol: OPEN, ctx });
  const legacy = withEnv(null, () => ({ r: M.MODES.map(m => rankPlans(plans, m, OPEN, ctx)), c: compareModes(plans, ctxFor) }));
  const zero = withEnv('0', () => ({ r: M.MODES.map(m => rankPlans(plans, m, OPEN, ctx)), c: compareModes(plans, ctxFor) }));
  const explicit = { r: M.MODES.map(m => rankPlans(plans, m, OPEN, ctx, { rule: false })), c: compareModes(plans, ctxFor, { rule: false }) };
  assert.deepEqual(zero, legacy);
  assert.deepEqual(explicit, legacy);
});

test('rule on through the env: the three modes pick three different first steps on one pool', () => {
  const X = { steps: [step('2', 0.3, 0.10)] };                                  // regret winner
  const Y = { steps: [step('3', 0.8, 0.03), step('4', 0.8, 0.06, [2], [8])] }; // best expected
  const W = { steps: [step('4', 1, 0.02, [3], [7])] };                          // best worst case
  const rows = withEnv('1', () => compareModes([X, Y, W], () => ({ tol: OPEN, ctx })));
  assert.deepEqual(rows.map(r => r.first_step.team), ['4', '2', '3']);
});

test('planner end to end: flag off is byte-identical to unset; flag on still validates', () => {
  const plan = mode => {
    const a = makeAdapter();
    const res = planLeague(a, { objective: normaliseObjective({ risk_mode: mode }) });
    return { a, res, json: JSON.stringify(toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' })) };
  };
  for (const mode of M.MODES) {
    const unset = withEnv(null, () => plan(mode));
    const off = withEnv('0', () => plan(mode));
    assert.equal(off.json, unset.json, `${mode}: flag "0" changed the plans entry`);
    const on = withEnv('1', () => plan(mode));
    assert.deepEqual(validateLeague(JSON.parse(on.json)).errors, [], `${mode}: rule-on entry fails the schema`);
    assert.equal(on.res.risk_modes.length, 3);
  }
});
