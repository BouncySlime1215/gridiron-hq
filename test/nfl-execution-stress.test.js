import test from 'node:test';
import assert from 'node:assert/strict';

const {
  qbScratchScenario, feedOutageScenario, correlatedSlateShockScenario, modelProbabilityErrorScenario
} = await import('../server/services/nfl-execution-stress.js');

const quote = (snapshot_at, price, line = -3.5) => ({ snapshot_at, type: 'quote', price, line });

test('QB scratch: every delay bucket after the scratch comes back suspended or worse, never a confident fill', () => {
  const timeline = [
    quote('2026-09-10T09:00:00Z', -110), quote('2026-09-10T09:30:00Z', -112), quote('2026-09-10T10:00:00Z', -115)
  ];
  const scenario = qbScratchScenario({
    timeline, scratchAt: '2026-09-10T10:02:00Z', decisionAt: '2026-09-10T10:00:00Z'
  });
  assert.equal(scenario.all_delays_suspended_or_worse, false); // 5s/30s delays land before the scratch
  const longDelays = scenario.results.filter(r => r.delay_seconds >= 600);
  assert.ok(longDelays.every(r => r.outcome === 'suspended'));
});

test('feed outage: without a staleness window a stale pre-outage price is silently reused', () => {
  const timeline = [quote('2026-09-10T09:00:00Z', -110)];
  const scenario = feedOutageScenario({
    timeline, outageStart: '2026-09-10T09:00:01Z', outageEnd: '2026-09-10T11:00:00Z',
    decisionAt: '2026-09-10T09:00:00Z', delays: [600]
  });
  assert.equal(scenario.results_without_staleness_window[0].outcome, 'filled_as_decided');
});

test('feed outage: with a staleness window the same replay honestly reports stale_unknown instead', () => {
  const timeline = [quote('2026-09-10T09:00:00Z', -110)];
  const scenario = feedOutageScenario({
    timeline, outageStart: '2026-09-10T09:00:01Z', outageEnd: '2026-09-10T11:00:00Z',
    decisionAt: '2026-09-10T09:00:00Z', delays: [600], maxStalenessSeconds: 300
  });
  assert.equal(scenario.results_with_staleness_window[0].outcome, 'stale_unknown');
});

test('correlated slate shock: the correlated slate\'s worst case exceeds the independent slate\'s, at the same total stake', () => {
  const scenario = correlatedSlateShockScenario({ totalStakeUnits: 8, positionCount: 4 });
  assert.equal(scenario.correlated_loss_exceeds_independent, true);
  assert.equal(scenario.independent_slate.total_staked, scenario.correlated_slate.total_staked);
  assert.equal(scenario.correlated_slate.worst_shared_shock_loss, 8);
  assert.equal(scenario.independent_slate.worst_shared_shock_loss, 2); // one of four equal positions
});

test('model probability error: a negative true edge loses money faster the more aggressively it is sized', () => {
  // Model believes 60%, truth is 45% at a price that is fair around 50% (-100).
  const scenario = modelProbabilityErrorScenario({
    trueProbability: 0.45, assumedProbability: 0.60, americanPrice: -100, bankrollUnits: 100
  });
  assert.ok(scenario.true_ev_per_unit < 0);
  const byFraction = Object.fromEntries(scenario.kelly_by_fraction.map(r => [r.kelly_fraction, r]));
  // Full Kelly stakes more than quarter Kelly off the same (wrong) assumed probability...
  assert.ok(byFraction[1.0].assumed_stake_units > byFraction[0.25].assumed_stake_units);
  // ...and therefore loses more at the TRUE probability.
  assert.ok(byFraction[1.0].expected_pnl_at_true_probability < byFraction[0.25].expected_pnl_at_true_probability);
  assert.equal(scenario.full_kelly_harms_more_than_fixed_stake, true);
});

test('model probability error: a positive but overstated edge still wins for everyone, full Kelly most exposed to the gap', () => {
  const scenario = modelProbabilityErrorScenario({
    trueProbability: 0.53, assumedProbability: 0.65, americanPrice: -110, bankrollUnits: 100
  });
  assert.ok(scenario.true_ev_per_unit > 0);
  const byFraction = Object.fromEntries(scenario.kelly_by_fraction.map(r => [r.kelly_fraction, r]));
  assert.ok(byFraction[1.0].expected_pnl_at_true_probability > byFraction[0.25].expected_pnl_at_true_probability);
});

test('model probability error is deterministic — no randomness anywhere in the scenario', () => {
  const args = { trueProbability: 0.45, assumedProbability: 0.60, americanPrice: -105 };
  const first = modelProbabilityErrorScenario(args);
  const second = modelProbabilityErrorScenario(args);
  assert.deepEqual(first, second);
});

test('modelProbabilityErrorScenario rejects an invalid probability rather than silently coercing it', () => {
  assert.throws(() => modelProbabilityErrorScenario({ trueProbability: 1.5, assumedProbability: 0.5, americanPrice: -110 }));
});
