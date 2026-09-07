import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_FORECAST_BASE, SOURCE_OF_KIND, SLATE_POLICY, SLATE_STATUS,
  shoppedLineOpportunity, teaserOpportunity, gateOpportunities,
  opportunityCorrelation, simulateSlate, applyAllocation,
  simulationBriefing, reasonAboutSlate, proposalPrompt, nullComparison
} from '../server/services/execution-slate-reasoning.js';

/* ------------------------------------------------------------------ fixtures */

const shopRow = (over = {}) => ({
  event_id: 'ev1', market: 'spreads', side: 'Jets', matchup: 'Jets at Bills',
  best_book: 'pinnacle', best_price: -110, best_line: 3.5, median_line: 2.5,
  line_edge: 0.075, price_edge: 0.01, books_compared: 6, ...over
});

const teaserCandidate = (over = {}) => ({
  candidate_id: 'abc123', book: 'draftkings', american_price: -110,
  expected_ticket_probability: 0.5579, expected_ev: 0.065, eligible: true,
  legs: [
    { event_id: 'ev1', team: 'Jets', opponent: 'Bills', matchup: 'Jets at Bills', market_line: 2, teased_line: 8 },
    { event_id: 'ev2', team: 'Rams', opponent: 'Niners', matchup: 'Rams at Niners', market_line: -8, teased_line: -2 }
  ],
  ...over
});

/* --------------------------------------------------- the anti-laundering gate */

test('an unrecognised opportunity kind maps to the model source and stakes zero', () => {
  const { offered, blocked } = gateOpportunities([{
    id: 'x', kind: 'spread_pick', american_price: -110, win_probability: 0.62, games: []
  }]);
  assert.equal(offered.length, 0);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].staking_source, 'model');
  assert.equal(blocked[0].ceiling_units, 0);
  assert.match(blocked[0].gate_reason, /closing-line value/i);
});

test('a candidate cannot smuggle an execution source past the kind lookup', () => {
  // The shape a laundering attempt would take: claim the source on the object.
  const { blocked } = gateOpportunities([{
    id: 'sneaky', kind: 'model_edge', staking_source: 'execution', source: 'execution',
    american_price: -110, win_probability: 0.70, games: []
  }]);
  assert.equal(blocked[0].staking_source, 'model', 'source is derived from kind, never read off the candidate');
  assert.equal(blocked[0].ceiling_units, 0);
});

test('the source enum is closed to exactly the two proven edges', () => {
  assert.deepEqual(Object.keys(SOURCE_OF_KIND).sort(), ['shopped_line', 'teaser']);
  assert.ok(Object.values(SOURCE_OF_KIND).every(s => s === 'execution'));
});

/* ------------------------------------------------------- honest shopped sizing */

test('a shopped line with only a price advantage stakes zero — best price does not beat the vig', () => {
  const opp = shoppedLineOpportunity(shopRow({ line_edge: 0, price_edge: 0.023, best_price: -105 }));
  assert.equal(opp.win_probability, NO_FORECAST_BASE);
  const { offered, blocked } = gateOpportunities([opp]);
  assert.equal(offered.length, 0, 'a coin flip at -105 is still a losing bet');
  assert.equal(blocked[0].ceiling_units, 0);
});

test('a shopped line crossing a key number does size', () => {
  const { offered } = gateOpportunities([shoppedLineOpportunity(shopRow({ line_edge: 0.075 }))]);
  assert.equal(offered.length, 1);
  assert.ok(offered[0].ceiling_units > 0);
  assert.ok(offered[0].ceiling_units <= SLATE_POLICY.max_units_per_bet);
  assert.ok(offered[0].edge > 0);
});

test('the shopped win probability is the no-forecast base plus the measured line edge and nothing else', () => {
  const opp = shoppedLineOpportunity(shopRow({ line_edge: 0.04, price_edge: 0.5 }));
  assert.equal(opp.win_probability, 0.54, 'price edge lives in the payout, never in the probability');
});

/* --------------------------------------------------------------- teaser gating */

test('an ineligible teaser candidate is refused outright', () => {
  assert.equal(teaserOpportunity(teaserCandidate({ eligible: false })), null);
});

test('a teaser whose legs share a game is refused — p^n needs different games', () => {
  const same = teaserCandidate({
    legs: [
      { event_id: 'ev1', team: 'Jets', opponent: 'Bills', matchup: 'Jets at Bills', market_line: 2, teased_line: 8 },
      { event_id: 'ev1', team: 'Bills', opponent: 'Jets', matchup: 'Jets at Bills', market_line: -8, teased_line: -2 }
    ]
  });
  assert.equal(teaserOpportunity(same), null);
});

test('an eligible teaser sizes off its own measured ticket probability', () => {
  const opp = teaserOpportunity(teaserCandidate(), { legRate: 0.7469, standardError: 0.0117 });
  assert.equal(opp.kind, 'teaser');
  assert.equal(opp.win_probability, 0.5579);
  const { offered } = gateOpportunities([opp]);
  assert.equal(offered.length, 1);
  assert.ok(offered[0].ceiling_units > 0);
});

/* ------------------------------------------------------------------ correlation */

test('two bets on the same game are strongly correlated; different games are not', () => {
  const a = { id: 'a', games: [{ event_id: 'ev1', team: 'Jets', opponent: 'Bills' }] };
  const b = { id: 'b', games: [{ event_id: 'ev1', team: 'Jets', opponent: 'Bills' }] };
  const c = { id: 'c', games: [{ event_id: 'ev9', team: 'Rams', opponent: 'Niners' }] };
  assert.equal(opportunityCorrelation(a, b), 0.8);
  assert.equal(opportunityCorrelation(a, c), 0);
  assert.equal(opportunityCorrelation(a, a), 1);
});

test('a teaser is scored at its most correlated leg', () => {
  const teaser = { id: 't', games: [{ event_id: 'ev1' }, { event_id: 'ev2' }] };
  const shop = { id: 's', games: [{ event_id: 'ev2' }] };
  assert.equal(opportunityCorrelation(teaser, shop), 0.8, 'one shared game dominates');
});

/* ------------------------------------------------------------------ simulation */

const bet = (id, over = {}) => ({
  id, label: id, units: 2, win_probability: 0.5579, american_price: -110,
  games: [{ event_id: id }], ...over
});

test('the simulation reports a bankroll path, not a single expectation', () => {
  const sim = simulateSlate([bet('a'), bet('b')]);
  assert.equal(sim.simulated, true);
  assert.equal(sim.sims, SLATE_POLICY.sims);
  assert.equal(sim.weeks, SLATE_POLICY.weeks);
  assert.equal(sim.mean_bankroll_path.length, SLATE_POLICY.weeks + 1);
  assert.equal(sim.mean_bankroll_path[0], SLATE_POLICY.bankroll_units);
  for (const k of ['p5', 'p25', 'p50', 'p75', 'p95']) assert.ok(Number.isFinite(sim.final_bankroll_percentiles[k]));
  assert.ok(sim.max_drawdown.p95 >= sim.max_drawdown.p50);
  assert.ok(sim.probability_losing_month >= 0 && sim.probability_losing_month <= 1);
});

test('the simulation is deterministic under its seed', () => {
  const a = simulateSlate([bet('a'), bet('b')], { seed: 99 });
  const c = simulateSlate([bet('a'), bet('b')], { seed: 99 });
  assert.deepEqual(a.final_bankroll_percentiles, c.final_bankroll_percentiles);
  assert.equal(a.max_drawdown.worst, c.max_drawdown.worst);
});

test('a correlated slate has a worse tail than an independent one at the same total stake', () => {
  const opts = { seed: 7, sims: 3000 };
  const independent = simulateSlate(
    [bet('a', { games: [{ event_id: 'e1' }] }), bet('b', { games: [{ event_id: 'e2' }] })], opts);
  const correlated = simulateSlate(
    [bet('a', { games: [{ event_id: 'e1' }] }), bet('b', { games: [{ event_id: 'e1' }] })], opts);
  assert.equal(independent.weekly_stake_units, correlated.weekly_stake_units);
  assert.ok(correlated.max_drawdown.p95 > independent.max_drawdown.p95,
    'bets that lose together produce deeper drawdowns');
  assert.ok(correlated.final_bankroll_percentiles.p5 < independent.final_bankroll_percentiles.p5);
});

test('the correlation note describes THIS slate, not the rule in the abstract', () => {
  const independent = simulateSlate(
    [bet('a', { games: [{ event_id: 'e1' }] }), bet('b', { games: [{ event_id: 'e2' }] })]);
  assert.match(independent.correlation_note, /THIS SLATE IS UNCORRELATED/);
  assert.ok(!independent.correlation_note.includes('0.80'),
    'a slate with no shared game must not be told about an 0.80 correlation');

  const correlated = simulateSlate(
    [bet('a', { games: [{ event_id: 'e1' }] }), bet('b', { games: [{ event_id: 'e1' }] })]);
  assert.match(correlated.correlation_note, /a × b at 0\.80/);

  assert.equal(simulateSlate([bet('solo')]).correlation_note,
    'Single bet — correlation has nothing to act on.');
});

test('an empty slate simulates to a refusal rather than a fake number', () => {
  const sim = simulateSlate([]);
  assert.equal(sim.simulated, false);
  assert.match(sim.reason, /no staked bets/);
});

/* ------------------------------------------------------------------ clamping */

test('an allocation above the gate ceiling is clamped down', () => {
  const { offered } = gateOpportunities([shoppedLineOpportunity(shopRow())]);
  const ceiling = offered[0].ceiling_units;
  const out = applyAllocation(offered, [{ id: offered[0].id, units: ceiling + 50 }]);
  assert.equal(out.bets[0].units, ceiling);
  assert.match(out.adjustments.join(' '), /clamped/);
});

test('an allocation naming an id that was never offered is dropped', () => {
  const { offered } = gateOpportunities([shoppedLineOpportunity(shopRow())]);
  const out = applyAllocation(offered, [{ id: 'invented:bet', units: 3 }]);
  assert.equal(out.bets.length, 0);
  assert.match(out.adjustments.join(' '), /not among the offered/);
});

test('the slate total is scaled to the portfolio cap', () => {
  const offered = Array.from({ length: 6 }, (_, i) => ({
    id: `o${i}`, label: `o${i}`, ceiling_units: 3, win_probability: 0.6,
    american_price: -110, games: [{ event_id: `e${i}` }]
  }));
  const out = applyAllocation(offered, offered.map(o => ({ id: o.id, units: 3 })));
  assert.ok(out.total_units <= SLATE_POLICY.max_slate_units + 0.05);
  assert.match(out.adjustments.join(' '), /portfolio cap/);
});

/* ------------------------------------------------------------- the bounded loop */

function harness({ reviewDecision = 'hold', reviewSlate = null } = {}) {
  const calls = [];
  const { offered } = gateOpportunities([
    shoppedLineOpportunity(shopRow()),
    teaserOpportunity(teaserCandidate(), { legRate: 0.7469, standardError: 0.0117 })
  ]);
  return {
    offered, calls,
    propose: async o => {
      calls.push('propose');
      return { allocation: o.map(x => ({ id: x.id, units: x.ceiling_units, why: 'max' })), reasoning: 'took the ceilings' };
    },
    review: async (briefing, ctx) => {
      calls.push('review');
      return {
        decision: reviewDecision, assessment: 'read the drawdown', changed_my_mind: 'the p95 drawdown',
        slate: reviewSlate ?? ctx.slate.bets.map(b => ({ id: b.id, units: b.units, why: 'unchanged' }))
      };
    }
  };
}

test('a hold commits the first allocation in exactly two calls', async () => {
  const h = harness({ reviewDecision: 'hold' });
  const out = await reasonAboutSlate({ offered: h.offered, propose: h.propose, review: h.review });
  assert.equal(out.status, SLATE_STATUS.CONFIRMED);
  assert.equal(out.claude_calls, 2);
  assert.deepEqual(h.calls, ['propose', 'review']);
  assert.equal(out.exposure_change_units, 0);
  assert.equal(out.simulation.simulated, true);
  assert.equal(out.human_approval_required, true);
});

test('a revise commits the revised slate and re-simulates it without a third call', async () => {
  const h = harness({ reviewDecision: 'hold' });
  const first = await reasonAboutSlate({ offered: h.offered, propose: h.propose, review: h.review });

  const h2 = harness({
    reviewDecision: 'revise',
    reviewSlate: [{ id: h.offered[0].id, units: 0.5, why: 'cut exposure after seeing the drawdown' }]
  });
  const out = await reasonAboutSlate({ offered: h2.offered, propose: h2.propose, review: h2.review });

  assert.equal(out.status, SLATE_STATUS.REVISED);
  assert.equal(out.claude_calls, 2);
  assert.deepEqual(h2.calls, ['propose', 'review'], 'no third call');
  assert.equal(out.slate.total_units, 0.5);
  assert.ok(out.exposure_change_units < 0);
  assert.ok(out.simulation_of_proposal, 'the abandoned slate\'s simulation is kept for the record');
  assert.notEqual(out.simulation.weekly_stake_units, out.simulation_of_proposal.weekly_stake_units,
    'what ships is the simulation of the committed slate');
  assert.ok(first.slate.total_units > out.slate.total_units);
});

test('the review cannot raise a stake above the gate ceiling', async () => {
  const h = harness({ reviewDecision: 'revise' });
  const ceiling = h.offered[0].ceiling_units;
  const h2 = harness({ reviewDecision: 'revise', reviewSlate: [{ id: h.offered[0].id, units: 999 }] });
  const out = await reasonAboutSlate({ offered: h2.offered, propose: h2.propose, review: h2.review });
  assert.equal(out.slate.bets[0].units, ceiling, 'the reasoning layer may only be more conservative');
});

test('no opportunities means no Claude calls at all', async () => {
  let called = 0;
  const out = await reasonAboutSlate({
    offered: [], propose: async () => { called++; return {}; }, review: async () => { called++; return {}; }
  });
  assert.equal(out.status, SLATE_STATUS.EMPTY);
  assert.equal(out.claude_calls, 0);
  assert.equal(called, 0);
  assert.equal(out.slate.bets.length, 0);
});

test('the loop never exceeds the policy call cap', async () => {
  const h = harness({ reviewDecision: 'revise' });
  const out = await reasonAboutSlate({ offered: h.offered, propose: h.propose, review: h.review });
  assert.ok(out.claude_calls <= SLATE_POLICY.max_claude_calls);
});

/* ------------------------------------------------------------ revision effect */

test('a revision that swaps a ticket for an identically-correlated one is called hollow', async () => {
  // The exact shape the first live run produced: two teasers sharing a game,
  // swapped for each other. Different tickets, identical risk.
  const shared = ev => ({ event_id: ev, matchup: ev });
  const offered = [
    { id: 'T1', label: 'T1', ceiling_units: 1.79, win_probability: 0.5579, american_price: -110,
      games: [shared('ev1'), shared('ev2')] },
    { id: 'T2', label: 'T2', ceiling_units: 1.79, win_probability: 0.5579, american_price: -110,
      games: [shared('ev2'), shared('ev3')] }
  ];
  const out = await reasonAboutSlate({
    offered,
    propose: async () => ({ allocation: [{ id: 'T1', units: 1.79 }], reasoning: 'took T1' }),
    review: async () => ({ decision: 'revise', assessment: 'cutting tail risk',
      changed_my_mind: 'the drawdown', slate: [{ id: 'T2', units: 1.79 }] })
  });
  assert.equal(out.status, SLATE_STATUS.REVISED);
  assert.equal(out.revision_effect.composition_changed, true);
  assert.equal(out.revision_effect.material, false, 'the tickets changed and the risk did not');
  assert.equal(out.revision_effect.exposure_change_units, 0);
  assert.match(out.revision_effect.summary, /did not change the simulated risk/);
  assert.match(out.note, /suspicion/);
});

test('a revision that genuinely cuts exposure is reported as material', async () => {
  const offered = [
    { id: 'A', label: 'A', ceiling_units: 3, win_probability: 0.5756, american_price: -105, games: [{ event_id: 'e1' }] },
    { id: 'B', label: 'B', ceiling_units: 3, win_probability: 0.5756, american_price: -105, games: [{ event_id: 'e1' }] }
  ];
  const out = await reasonAboutSlate({
    offered,
    propose: async () => ({ allocation: offered.map(o => ({ id: o.id, units: 3 })) }),
    review: async () => ({ decision: 'revise', slate: [{ id: 'A', units: 1 }] })
  });
  assert.equal(out.revision_effect.material, true);
  assert.ok(out.revision_effect.exposure_change_units < -0.25);
  assert.ok(out.revision_effect.p95_drawdown_change < 0, 'cutting a correlated slate lowers the drawdown');
  assert.match(out.revision_effect.summary, /moved the simulated risk/);
});

test('a hold reports no revision effect at all', async () => {
  const h = harness({ reviewDecision: 'hold' });
  const out = await reasonAboutSlate({ offered: h.offered, propose: h.propose, review: h.review });
  assert.equal(out.revision_effect, null);
});

/* --------------------------------------------------------------------- prompts */

test('the null-edge comparison strips the edge and keeps everything else identical', () => {
  const { offered } = gateOpportunities([shoppedLineOpportunity(shopRow())]);
  const slate = applyAllocation(offered, [{ id: offered[0].id, units: 2 }]);
  const real = simulateSlate(slate.bets);
  const none = nullComparison(slate.bets);
  assert.equal(none.weekly_stake_units, real.weekly_stake_units, 'same stakes');
  assert.equal(none.bets, real.bets);
  assert.ok(none.expected_profit_units < real.expected_profit_units,
    'removing the measured edge must lower the expectation');
  assert.ok(none.probability_losing_month > real.probability_losing_month);
});

test('the briefing shows the no-edge reference so a 50% losing-month rate is legible', () => {
  const { offered } = gateOpportunities([shoppedLineOpportunity(shopRow())]);
  const slate = applyAllocation(offered, [{ id: offered[0].id, units: 2 }]);
  const text = simulationBriefing(simulateSlate(slate.bets), slate, nullComparison(slate.bets));
  assert.match(text, /NO EDGE AT ALL/);
  assert.match(text, /HOLDING IS A REAL ANSWER/);
  assert.match(text, /GAP between the two columns/);
});

test('the briefing hands over the actual simulation numbers, not a verdict', () => {
  const { offered } = gateOpportunities([shoppedLineOpportunity(shopRow())]);
  const slate = applyAllocation(offered, [{ id: offered[0].id, units: 1 }]);
  const text = simulationBriefing(simulateSlate(slate.bets), slate);
  for (const needle of ['Max drawdown', 'Chance of a losing month', 'Mean bankroll by week',
    'Final bankroll spread', 'ROI on turnover']) {
    assert.ok(text.includes(needle), `briefing should carry "${needle}"`);
  }
  assert.ok(text.includes('You may only lower stakes or drop bets'));
  assert.ok(!/threshold|pass\/fail/i.test(text), 'the briefing must not encode a gate');
});

test('the proposal prompt forbids forecasting and shows every ceiling', () => {
  const { offered } = gateOpportunities([
    shoppedLineOpportunity(shopRow()),
    teaserOpportunity(teaserCandidate(), { legRate: 0.7469 })
  ]);
  const text = proposalPrompt(offered);
  assert.ok(/not being asked to predict/i.test(text));
  for (const o of offered) {
    assert.ok(text.includes(o.id));
    assert.ok(text.includes(String(o.ceiling_units)));
  }
});
