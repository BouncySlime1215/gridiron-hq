/**
 * Four stress tests, built by reusing the same replay/exposure/staking
 * machinery the rest of Package H uses for an ordinary decision — not four
 * separate one-off simulations. Each one constructs a deliberately adverse
 * input and runs it through code that has already been tested to behave
 * correctly on the ordinary case, which is what lets these tests prove
 * "degrades sensibly" rather than "produces a number."
 *
 *   QB scratch              a market gets suspended mid-timeline; a decision
 *                           executed after that point must come back
 *                           `suspended`, never a stale confident fill.
 *   Feed outage             a stretch of the timeline goes dark; a decision
 *                           whose execution instant falls past the trust
 *                           window comes back `stale_unknown`, distinct from
 *                           the book actually pulling the line.
 *   Correlated slate shock  many positions sharing one factor (weather,
 *                           kickoff window, a single game) are exposure that
 *                           moves together — `correlatedSlateShockLoss`
 *                           reports the worst-case loss if that factor breaks
 *                           against all of them at once, and it grows toward
 *                           the total staked as the slate gets more
 *                           correlated.
 *   Model probability error a model's assumed win probability differs from
 *                           the true one; sizing off the assumed probability
 *                           at increasing Kelly fractions amplifies that gap
 *                           into P&L faster than a fixed stake does.
 */
import { replayDelayLadder, replayDelayedExecution, DEFAULT_DELAY_LADDER_SECONDS } from './nfl-execution-replay.js';
import { correlatedSlateShockLoss } from './nfl-execution-exposure.js';
import { kellyFraction } from './nfl-execution-edge.js';
import { payoutPerUnit } from './nfl-execution.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * Insert a suspension into an otherwise-normal timeline at `scratchAt` (e.g.
 * the instant a beat reporter breaks a starting QB is out) and replay a
 * decision made at `decisionAt` across the standard delay ladder.
 */
export function qbScratchScenario({ timeline, scratchAt, decisionAt, delays } = {}) {
  const shocked = [...(timeline ?? []), { snapshot_at: new Date(scratchAt).toISOString(), type: 'suspended' }];
  const results = replayDelayLadder({ timeline: shocked, decisionAt, delays });
  return {
    scratch_at: new Date(scratchAt).toISOString(), decision_at: new Date(decisionAt).toISOString(),
    results,
    all_delays_suspended_or_worse: results.every(r => ['suspended', 'disappeared', 'no_decision_quote'].includes(r.outcome)),
    note: 'A decided-on price that is executed after a scratch must never come back as a confident ' +
      'fill — every delay bucket here should land on suspended (or worse), not on filled_as_decided.'
  };
}

/**
 * Remove every timeline sample inside [outageStart, outageEnd) — modeling OUR
 * own visibility going dark, not the book pulling anything — and replay a
 * decision across the standard delay ladder with a staleness trust window.
 * A decision whose execution instant lands inside or soon after the outage
 * should come back `stale_unknown`, never a silently reused pre-outage price.
 */
export function feedOutageScenario({ timeline, outageStart, outageEnd, decisionAt, delays = DEFAULT_DELAY_LADDER_SECONDS,
  maxStalenessSeconds = 900 } = {}) {
  const start = new Date(outageStart).getTime(), end = new Date(outageEnd).getTime();
  const darkened = (timeline ?? []).filter(sample => {
    const at = new Date(sample.snapshot_at).getTime();
    return !(at >= start && at < end);
  });

  // Run the ladder twice on purpose: without a staleness window, an outage
  // can look identical to "the price never moved," because the last known
  // pre-outage sample silently gets reused as if it were still current. With
  // one, an execution instant that falls past the trust window is reported
  // as stale_unknown instead — the contrast is the point of the scenario.
  const withoutStalenessWindow = replayDelayLadder({ timeline: darkened, decisionAt, delays });
  const withStalenessWindow = delays.map(delaySeconds => ({
    delay_seconds: delaySeconds,
    ...replayDelayedExecution({ timeline: darkened, decisionAt, delaySeconds, maxStalenessSeconds })
  }));

  return {
    outage_start: new Date(outageStart).toISOString(), outage_end: new Date(outageEnd).toISOString(),
    decision_at: new Date(decisionAt).toISOString(), max_staleness_seconds: maxStalenessSeconds,
    results_without_staleness_window: withoutStalenessWindow,
    results_with_staleness_window: withStalenessWindow,
    note: 'Without a staleness window an outage can look identical to "the price never moved" — the ' +
      'last known price before the outage silently gets reused. With one, an execution instant that ' +
      'falls past the trust window is reported as stale_unknown instead.'
  };
}

/**
 * Many positions sharing one shock factor are exposure that moves together.
 * Compares the SAME total stake split two ways — spread across independent
 * factors vs. concentrated on one shared factor — to show the aggregate
 * worst case is not the same number just because the total is.
 */
export function correlatedSlateShockScenario({ totalStakeUnits, positionCount = 4 } = {}) {
  const perPosition = totalStakeUnits / positionCount;
  const independent = correlatedSlateShockLoss(
    Array.from({ length: positionCount }, (_, i) => ({ event_key: `game_${i}`, stake_units: perPosition, shock_factor: `game_${i}` }))
  );
  const correlated = correlatedSlateShockLoss(
    Array.from({ length: positionCount }, (_, i) => ({ event_key: `game_${i}`, stake_units: perPosition, shock_factor: 'shared_weather_system' }))
  );
  return {
    total_stake_units: r4(totalStakeUnits), position_count: positionCount,
    independent_slate: independent, correlated_slate: correlated,
    correlated_loss_exceeds_independent: correlated.worst_shared_shock_loss > independent.worst_shared_shock_loss,
    note: 'Same total stake, same position count. The independent slate\'s worst case is bounded by its ' +
      'single largest position; the correlated slate\'s worst case is the whole book, because one factor ' +
      'can break every position in it at once.'
  };
}

/**
 * A model believes the win probability is `assumedProbability`; the true
 * probability is `trueProbability`. Sizing off the assumed number at
 * increasing Kelly fractions is compared against a fixed stake, evaluated
 * at the TRUE probability — the only honest way to price the cost of being
 * wrong about your own edge.
 */
export function modelProbabilityErrorScenario({ trueProbability, assumedProbability, americanPrice,
  bankrollUnits = 100, fractions = [0.25, 0.5, 1.0], fixedStakeUnits = 0.5 } = {}) {
  if (![trueProbability, assumedProbability].every(p => Number.isFinite(p) && p > 0 && p < 1)) {
    throw new Error('trueProbability and assumedProbability must both be probabilities strictly between 0 and 1');
  }
  const payout = payoutPerUnit(americanPrice);
  const trueEvPerUnit = trueProbability * payout - (1 - trueProbability);

  const byFraction = fractions.map(fraction => {
    const sized = kellyFraction({ winProbability: assumedProbability, americanPrice, fraction });
    const stakeUnits = Math.min((sized.stake_fraction ?? 0) * bankrollUnits, bankrollUnits);
    return {
      kelly_fraction: fraction, assumed_stake_units: r4(stakeUnits),
      expected_pnl_at_true_probability: r4(stakeUnits * trueEvPerUnit)
    };
  });

  const fixed = {
    policy: 'fixed_stake', stake_units: fixedStakeUnits,
    expected_pnl_at_true_probability: r4(fixedStakeUnits * trueEvPerUnit)
  };

  const worstKelly = byFraction.reduce((worst, cur) =>
    cur.expected_pnl_at_true_probability < worst.expected_pnl_at_true_probability ? cur : worst, byFraction[0]);

  return {
    true_probability: trueProbability, assumed_probability: assumedProbability,
    probability_error: r4(assumedProbability - trueProbability), true_ev_per_unit: r4(trueEvPerUnit),
    kelly_by_fraction: byFraction, fixed_stake: fixed,
    full_kelly_harms_more_than_fixed_stake: trueEvPerUnit < 0
      && Math.abs(worstKelly.expected_pnl_at_true_probability) > Math.abs(fixed.expected_pnl_at_true_probability),
    note: trueEvPerUnit < 0
      ? 'The true edge is negative here — every sizing scheme loses money in expectation, and the ' +
        'higher the Kelly fraction, the faster it loses, exactly because it is amplifying a wrong ' +
        'probability rather than a real edge.'
      : 'The true edge is positive but smaller than assumed — everything still wins in expectation, but ' +
        'full Kelly is the most exposed to the gap between the assumed and true probability.'
  };
}
