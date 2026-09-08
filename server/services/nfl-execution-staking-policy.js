/**
 * Fixed paper stakes vs. uncertainty-shrunk fractional Kelly — gated on
 * calibration, never on a raw historical hit rate.
 *
 * `nfl-execution-edge.js#stakeFor` already draws this line for the execution
 * edge: a model-derived probability sizes zero units until it has proven
 * closing-line value, "because Kelly will cheerfully bankrupt a bettor whose
 * edge estimate is optimistic." This module reuses that Kelly math (never
 * re-derives it) and adds the specific shape the plan asks for: instead of a
 * binary proven/not-proven gate, a market that HAS cleared its calibration
 * gates (see `nfl-prop-clv.js#propMarketScorecards` — sample size, mean/
 * median/week-clustered CLV, ECE, calibration slope) still gets its model
 * probability shrunk toward the independent fair price by how much evidence
 * actually backs it, before Kelly ever sees it.
 *
 * `marketScorecard` is expected to look like one entry from
 * `propMarketScorecards()`: `{ settled, gates: {...every gate true/false},
 * status, staking_authority }`. This module does not import nfl-prop-clv.js
 * directly — that module's import chain touches the live odds API, player
 * identity and projection pipeline, none of which this deterministic sizing
 * comparison needs, and importing it here would make a unit test of sizing
 * arithmetic depend on all of that being wired up. The caller (a route, or a
 * future scheduled job) passes in the real scorecard when this is used live.
 */
import { kellyFraction } from './nfl-execution-edge.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/** Matches nfl-prop-clv.js's PROP_DECISION_POLICY.minimum_settled_overall — the same bar this
 * project already requires before trusting a market's calibration at all is reused here as the
 * shrinkage prior strength, rather than inventing a second number for the same idea. */
export const CALIBRATION_PRIOR_STRENGTH = 200;

export const FIXED_PAPER_STAKE_UNITS = 0.5;

/** Has this market cleared every calibration gate nfl-prop-clv.js already checks? */
export function isCalibrated(marketScorecard) {
  return Boolean(marketScorecard?.gates && Object.values(marketScorecard.gates).length
    && Object.values(marketScorecard.gates).every(Boolean));
}

/**
 * Shrink a model probability toward the independent fair price by an amount
 * that depends on how much settled evidence backs it — a small sample is
 * pulled almost all the way back to "no opinion"; only a genuinely large
 * sample is trusted near its raw value. Standard empirical-Bayes/James-Stein
 * shrinkage: weight = n / (n + k).
 */
export function shrinkProbability({ modelProbability, fairProbability, settledSamples,
  priorStrength = CALIBRATION_PRIOR_STRENGTH }) {
  if (!Number.isFinite(modelProbability) || !Number.isFinite(fairProbability)) return null;
  if (modelProbability <= 0 || modelProbability >= 1 || fairProbability <= 0 || fairProbability >= 1) return null;
  const n = Math.max(0, Number(settledSamples) || 0);
  const weight = n / (n + priorStrength);
  return r4(fairProbability + (modelProbability - fairProbability) * weight);
}

/** Fractional Kelly on a probability that has already been shrunk toward the fair price. */
export function uncertaintyShrunkKelly({ modelProbability, fairProbability, settledSamples, americanPrice,
  fraction = 0.25, priorStrength = CALIBRATION_PRIOR_STRENGTH }) {
  const shrunk = shrinkProbability({ modelProbability, fairProbability, settledSamples, priorStrength });
  if (shrunk == null) return { stake_fraction: 0, reason: 'insufficient inputs to shrink a probability' };
  return {
    shrunk_probability: shrunk, raw_model_probability: r4(modelProbability), fair_probability: r4(fairProbability),
    settled_samples: settledSamples, shrink_weight: r4(Math.max(0, settledSamples || 0)
      / (Math.max(0, settledSamples || 0) + priorStrength)),
    ...kellyFraction({ winProbability: shrunk, americanPrice, fraction })
  };
}

/**
 * The comparison the plan asks for, side by side. A fixed paper stake is
 * always available — it needs no probability estimate at all, which is the
 * entire point of using it as the pre-calibration baseline. Kelly of any
 * kind is blocked outright until the market's own calibration gates pass;
 * sizing off a raw historical hit rate is exactly the mistake this refuses.
 */
export function compareStakingPolicies({ marketScorecard, modelProbability, fairProbability, settledSamples,
  americanPrice, bankrollUnits = 100, fraction = 0.25, maxUnitsPerBet = 3, priorStrength } = {}) {
  const fixed = {
    policy: 'fixed_paper_stake', units: FIXED_PAPER_STAKE_UNITS,
    note: 'A flat paper stake needs no probability estimate and is always available, calibrated or not.'
  };

  if (!isCalibrated(marketScorecard)) {
    return {
      calibrated: false, fixed,
      kelly: {
        policy: 'uncertainty_shrunk_fractional_kelly', units: 0, blocked: true,
        reason: `market has not cleared its calibration gates yet (status: ` +
          `${marketScorecard?.status ?? 'no scorecard supplied'}) — sizing off an uncalibrated ` +
          'probability, or off a raw historical hit rate, is how Kelly ruins a bankroll.'
      }
    };
  }

  const kelly = uncertaintyShrunkKelly({ modelProbability, fairProbability, settledSamples, americanPrice,
    fraction, priorStrength });
  const rawUnits = (kelly.stake_fraction ?? 0) * bankrollUnits;
  const units = Math.min(rawUnits, maxUnitsPerBet);
  return {
    calibrated: true, fixed,
    kelly: { policy: 'uncertainty_shrunk_fractional_kelly', ...kelly, units: r4(units), capped: units < rawUnits }
  };
}
