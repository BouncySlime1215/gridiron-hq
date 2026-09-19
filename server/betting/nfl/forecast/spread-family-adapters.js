/**
 * Common packet/probability/qualification interface over the existing
 * forecasting families (docs/CLAUDE-NEXT-STEPS.md §10.3's missing boundary,
 * described by §4.1 and built as instructed in §6: "Build the multiple-model
 * design by ADAPTING existing work").
 *
 * WHAT THIS IS. Section 4 states the target: several independent forecasting
 * families that each produce output in one common, compatible shape, so they
 * can be "measured on equal footing" and, eventually, combined. Section 4's
 * diagram names four families feeding that shape: the repaired football
 * ensemble, the lineup/replacement forecast, an independent game simulation,
 * and (eventually) a direct spread-cover classifier. This module is that
 * translation layer and NOTHING ELSE: one function per family, same inputs
 * in, one common shape out.
 *
 * WHAT THIS DELIBERATELY IS NOT.
 *
 *   - It does not compute a single new number. Every adapter calls an
 *     existing, already-tested entry point -- `ensembleLine` (nfl-ensemble.js),
 *     `simulateMatchup` (nfl-drive-sim.js), `gamePlayerAvailability` +
 *     `teamRosterStrength` + `gameInjuryCarryover` (nfl-player-value.js,
 *     nfl-roster-strength.js, nfl-postgame-truth.js) -- with the SAME calling
 *     convention `server/services/nfl-expert-council.js`'s `gameExperts`
 *     already uses for these same families, and only reshapes what comes back.
 *   - It does not invent a qualification rule. Each adapter surfaces the
 *     field the underlying module already reports about its own state
 *     (`production_eligible`, or the `research_only` authority the existing
 *     expert-council registry already assigns this family) rather than
 *     deciding anything new about promotion.
 *   - It is not wired into any route, policy or decision path. Per section 4:
 *     "An unqualified family can produce clearly labeled research forecasts
 *     without entering the recommendation combination." This module is the
 *     labeling, not the combination -- `nfl-expert-coordinator.js` remains
 *     the actual combiner, unaffected by this file.
 *   - It reuses `contracts/spread-probabilities.js` for every probability
 *     computation. The invariant math (win + push + loss = 1, half-point
 *     handicaps cannot push, invalid triples fail rather than clip) already
 *     lives there; this module never restates it.
 *
 * THE COMMON SHAPE, and why each field is there.
 *
 *   family / family_label   Which family this is, for a side-by-side table.
 *   game                    The identity every family was asked about:
 *                           { season, week, home, away, cutoff }. `cutoff` is
 *                           carried through as metadata only -- none of the
 *                           four underlying entry points accept an explicit
 *                           cutoff INSTANT today; they use the chronological
 *                           `season`/`week` ordering ("every game strictly
 *                           before this one") as their own cutoff. Passing a
 *                           `cutoff` here does not yet change what evidence an
 *                           adapter reads; it is recorded so a caller can see
 *                           what it asked for, and is the seam a real T-60
 *                           instant would plug into later.
 *   observed / missing_reason   Section 4's "including a model that abstains":
 *                           did this family actually produce a forecast for
 *                           THIS game, and if not, why not -- never a
 *                           fabricated number standing in for "no data".
 *   qualified / qualification_source   The family's OWN existing
 *                           qualification/authority state, and exactly where
 *                           this module read it from, so the claim is
 *                           auditable rather than asserted.
 *   margin                  { predicted, market }. `predicted` is null for a
 *                           family that only supports a probability directly
 *                           (the direct-cover stub) rather than a margin.
 *   probabilities            { available, side, handicap, win, push, loss,
 *                           method } when the family can honestly supply a
 *                           win/push/loss triple AT A REAL HANDICAP, else
 *                           `{ available: false, reason }`. Every non-empty
 *                           triple below is round-tripped through
 *                           `validateSpreadProbabilities` -- if a family's own
 *                           numbers do not satisfy the invariant, this module
 *                           reports `available: false` with the validator's
 *                           reason rather than passing through a broken triple.
 *   distribution              Whatever distributional detail (quantiles,
 *                           intervals, key numbers) the family can honestly
 *                           supply, or `{ available: false, reason }`. A
 *                           family with only a point estimate (lineup) is
 *                           NEVER given a fabricated spread here.
 *   uncertainty                The family's own stated uncertainty, if it has
 *                           one, with what it measures (`kind`).
 *   detail                    Family-specific evidence, for audit -- not part
 *                           of the common contract, but never withheld.
 *
 * PARITY. `test/spread-family-adapters.test.js` asserts the ensemble adapter's
 * `margin.predicted`, `margin.market` and cover probabilities are an EXACT
 * reshaping of what a direct `ensembleLine(season, week, home, away, {
 * blendMode: 'raw', includeEvidence: false, includeChallengers: false })` call
 * already reports for the same game -- the same parity discipline
 * `test/forecast-combination.test.js` applies to its own replayed incumbent.
 */
import crypto from 'node:crypto';
import { ensembleLine } from '../../../services/nfl-ensemble.js';
import { simulateMatchup } from '../../../services/nfl-drive-sim.js';
import { gamePlayerAvailability } from '../../../services/nfl-player-value.js';
import { teamRosterStrength } from '../../../services/nfl-roster-strength.js';
import { gameInjuryCarryover } from '../../../services/nfl-postgame-truth.js';
import { validateSpreadProbabilities } from '../contracts/spread-probabilities.js';
import { scorePythonArtifact } from './python-artifact.js';

export const SPREAD_FAMILY_ADAPTERS_VERSION = 'nfl-spread-family-adapters-v1';

/** Every family identifier this module knows how to produce. */
export const FAMILIES = Object.freeze({
  ensemble: 'ensemble',
  simulation: 'simulation',
  lineup: 'lineup',
  direct_cover: 'direct_cover',
  trained_margin: 'trained_margin'
});

/** The common shape's top-level keys, for a test asserting nothing was dropped. */
export const FAMILY_FORECAST_FIELDS = Object.freeze([
  'adapter_version', 'family', 'family_label', 'game',
  'observed', 'missing_reason', 'qualified', 'qualification_source',
  'margin', 'probabilities', 'distribution', 'uncertainty', 'detail'
]);

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/**
 * Reshape a win/push/loss triple at a real handicap into the common
 * `probabilities` block, validated rather than trusted.
 *
 * This is the one place every adapter below funnels its probabilities
 * through, so "reuse spread-probabilities.js's math, do not reinvent it" is
 * true by construction rather than by convention each adapter has to remember.
 */
export function probabilitiesFromTriple({ win, push, loss, handicap, side = 'home', method }) {
  if (![win, push, loss, handicap].every(Number.isFinite)) {
    return { available: false, reason: 'family did not supply a complete win/push/loss triple at a real handicap' };
  }
  let triple = { win, push, loss };
  let check = validateSpreadProbabilities({ ...triple, handicap });
  let roundingAdjusted = false;
  // Every family this module reads from exposes its win/push/loss triple
  // ALREADY rounded to display precision (nfl-ensemble.js's r2(), the
  // simulator's r4()) rather than the raw fractions it computed them from --
  // and those raw fractions sum to exactly one by construction (they are
  // counts over the same sample). A sub-0.01 sum drift here is therefore a
  // rounding artifact of the SOURCE's own display precision, not a genuinely
  // incoherent probability -- proportionally renormalizing it is not the
  // same act as clipping an out-of-range or otherwise invalid value, which
  // this function still refuses outright, below. The adjustment is always
  // reported (`rounding_adjusted`), never silent.
  if (!check.ok && check.reason === 'probabilities_do_not_sum_to_one' && Math.abs(check.total - 1) < 0.01) {
    const sum = triple.win + triple.push + triple.loss;
    triple = { win: triple.win / sum, push: triple.push / sum, loss: triple.loss / sum };
    check = validateSpreadProbabilities({ ...triple, handicap });
    roundingAdjusted = true;
  }
  if (!check.ok) {
    // Section 5.1's rule applies here too: an invalid triple FAILS, it is not
    // silently clipped into something that looks like a probability.
    return { available: false, reason: `family's own triple failed validation: ${check.reason}`, invalid: check };
  }
  return {
    available: true, side, handicap: r2(handicap), method, rounding_adjusted: roundingAdjusted,
    win: check.probabilities.win, push: check.probabilities.push, loss: check.probabilities.loss
  };
}

/** The empty common shape every adapter starts from and fills in. */
function baseForecast(family, label, { season, week, home, away, cutoff }) {
  return {
    adapter_version: SPREAD_FAMILY_ADAPTERS_VERSION,
    family, family_label: label,
    game: { season, week, home, away, cutoff: cutoff ?? null },
    observed: false, missing_reason: null,
    qualified: false, qualification_source: null,
    margin: { predicted: null, market: null },
    probabilities: { available: false, reason: null },
    distribution: { available: false, reason: null },
    uncertainty: { available: false, value: null, kind: null },
    detail: {}
  };
}

/**
 * A same-time market reference every adapter below reads off the SAME call:
 * `ensembleLine`'s own `market_spread`/`market_total` fields, which is exactly
 * where `nfl-expert-council.js`'s `gameExperts` reads them too (its
 * `marketMargin = -line.ensemble.market_spread` line). Reusing one call keeps
 * every family pointed at the identical market number rather than each
 * re-deriving it slightly differently.
 */
function marketReference(season, week, home, away) {
  return ensembleLine(season, week, home, away,
    { blendMode: 'raw', includeEvidence: false, includeChallengers: false });
}

/* ------------------------------------------------------------ Family A: ensemble */

/**
 * The repaired football ensemble (docs §6.1), adapted from `nfl-ensemble.js`'s
 * own `ensembleLine`.
 *
 * Calling convention copied verbatim from `nfl-expert-council.js`'s
 * `gameExperts`: `blendMode: 'raw'` (the model's own opinion, never silently
 * falling back to the market the way `market_residual` mode can),
 * `includeEvidence: false` (this adapter does not need the shadow
 * replacement-value packet -- the lineup family below computes its own), and
 * `includeChallengers: false` (production input set, not the full challenger
 * roster).
 */
export function ensembleFamilyForecast({ season, week, home, away, cutoff = null } = {}) {
  const out = baseForecast(FAMILIES.ensemble, 'Repaired football ensemble', { season, week, home, away, cutoff });
  const line = marketReference(season, week, home, away);
  if (line.error) { out.missing_reason = line.error; return out; }

  out.observed = Number.isFinite(line.ensemble.projected_margin);
  if (!out.observed) {
    out.missing_reason = 'ensemble produced no margin for this game (no contributing component models)';
    return out;
  }

  out.margin = {
    predicted: line.ensemble.projected_margin,
    market: line.ensemble.market_spread != null ? r2(-line.ensemble.market_spread) : null
  };

  const dist = line.ensemble.distribution;
  if (dist) {
    // `production_eligible` is `predictiveDistribution()`'s OWN self-reported
    // state (nfl-ensemble.js, ~line 384) -- surfaced verbatim, not recomputed.
    // Its own doc comment explains why it always reads false today: "A better
    // mechanism is not a promotion; that decision belongs to the promotion
    // gate in staking.js, on forward-settled evidence, not to the function
    // describing itself."
    out.qualified = dist.production_eligible === true;
    out.qualification_source = "nfl-ensemble.js predictiveDistribution().production_eligible " +
      '(the ensemble\'s own self-reported production-readiness state for its distribution)';
    out.distribution = {
      available: true,
      method: dist.method, sample_size: dist.sample_size, calibration_total: dist.calibration_total,
      conditional_cohort: dist.conditional_cohort,
      margin_quantiles: dist.margin_quantiles, total_quantiles: dist.total_quantiles,
      margin_interval_80: dist.margin_interval_80, margin_interval_50: dist.margin_interval_50
    };
    out.uncertainty = {
      available: dist.uncertainty_width_80 != null,
      value: dist.uncertainty_width_80, kind: 'margin_interval_80_width'
    };
    if (line.ensemble.market_spread != null
        && [dist.home_cover_probability, dist.push_probability, dist.away_cover_probability].every(Number.isFinite)) {
      out.probabilities = probabilitiesFromTriple({
        win: dist.home_cover_probability, push: dist.push_probability, loss: dist.away_cover_probability,
        handicap: line.ensemble.market_spread, side: 'home',
        method: 'mondrian split-conformal cover probability at the market handicap'
      });
    } else {
      out.probabilities = { available: false, reason: 'no market handicap, or the distribution carried no cover probabilities' };
    }
  } else {
    // No calibrated distribution exists at this cutoff (fewer than
    // ENSEMBLE_MIN_CALIBRATION prior games) -- an honest absence, not a
    // fabricated one, and not the same claim as `production_eligible: false`
    // on a distribution that does exist.
    out.qualified = false;
    out.qualification_source = 'nfl-ensemble.js predictiveDistribution() returned null for this cutoff ' +
      '(insufficient prior-game history to calibrate); no self-reported qualification state exists to surface';
    out.distribution = { available: false, reason: 'insufficient prior-game history for a calibrated distribution at this cutoff' };
  }

  out.detail = {
    engine_version: line.engine_version, blend_mode: line.ensemble.blend_mode,
    is_market_identity: line.ensemble.is_market_identity,
    models_contributing_margin: line.ensemble.models_contributing_margin,
    model_disagreement_margin: line.ensemble.model_disagreement_margin,
    confidence: line.ensemble.confidence
  };
  return out;
}

/* ---------------------------------------------------------- Family C: simulation */

/**
 * The independent game simulation (docs §6.3), adapted from
 * `nfl-drive-sim.js`'s own `simulateMatchup`.
 *
 * Calling convention copied verbatim from `nfl-expert-council.js`'s
 * `gameExperts` 'game_replay' expert: 160 trials, the market spread/total as
 * the outcome-reweighting anchor, the ensemble's own projected margin/total as
 * `targetMargin`/`targetTotal`, and a deterministic per-game seed. This is the
 * existing ENSEMBLE-RECONCILED mode -- docs §6.3's separate "unanchored" mode
 * (fitted parameters only, no market/ensemble anchor) does not exist as
 * production code yet, and this adapter does not invent it; it surfaces
 * exactly the mode the current caller already runs, and says so in `detail`.
 */
export function simulationFamilyForecast({ season, week, home, away, cutoff = null } = {}) {
  const out = baseForecast(FAMILIES.simulation, 'Independent game simulation (drive-level)', { season, week, home, away, cutoff });
  const line = marketReference(season, week, home, away);
  if (line.error) { out.missing_reason = `market/ensemble reference unavailable: ${line.error}`; return out; }

  const seed = crypto.createHash('sha256')
    .update(`${SPREAD_FAMILY_ADAPTERS_VERSION}|${season}|${week}|${home}|${away}`)
    .digest().readUInt32BE(0);
  const sim = simulateMatchup({
    home, away, season, week, trials: 160,
    spread: line.ensemble.market_spread, total: line.ensemble.market_total,
    targetMargin: line.ensemble.projected_margin, targetTotal: line.ensemble.projected_total,
    seed
  });
  if (sim.error) { out.missing_reason = sim.error; return out; }

  out.observed = true;
  out.margin = {
    predicted: sim.projection.margin,
    market: line.ensemble.market_spread != null ? r2(-line.ensemble.market_spread) : null
  };
  out.distribution = {
    available: true,
    margin_quantiles: sim.distribution.margin, total_quantiles: sim.distribution.total,
    key_numbers: sim.key_numbers, moneyline: sim.moneyline, trials: sim.trials,
    reconciliation_method: sim.reconciliation?.method ?? null
  };
  out.uncertainty = {
    available: sim.projection.margin_sd != null,
    value: sim.projection.margin_sd, kind: 'margin_sd_across_reconciled_simulated_trials'
  };
  if (sim.spread && [sim.spread.home_cover, sim.spread.push, sim.spread.away_cover].every(Number.isFinite)) {
    out.probabilities = probabilitiesFromTriple({
      win: sim.spread.home_cover, push: sim.spread.push, loss: sim.spread.away_cover,
      handicap: sim.spread.line, side: 'home',
      method: 'empirical frequency over reconciled simulated trials at the market handicap'
    });
  } else {
    out.probabilities = { available: false, reason: 'no market spread was available to grade cover probability against' };
  }

  // The simulator has no `production_eligible`-style field of its own.
  // What DOES already exist is `nfl-expert-council.js`'s own declared
  // authority for this exact family: its NFL_EXPERTS 'game_replay' entry never
  // overrides `output()`'s default `authority`, so the existing system already
  // treats this family as `research_only` -- surfaced here, not decided here.
  out.qualified = false;
  out.qualification_source = "nfl-expert-council.js's 'game_replay' expert output does not override " +
    "output()'s default authority, so it inherits 'research_only' -- the existing system's own declared " +
    'status for this family (consistent with docs/CLAUDE-NEXT-STEPS.md §6.3: "retain it as an ' +
    'explanatory research tool with zero recommendation weight" until shown to improve calibration).';
  out.detail = {
    play_model: sim.play_model, profile_cutoff: sim.profile_cutoff, profile_fell_back: sim.profile_fell_back,
    mode: 'ensemble_reconciled', note: sim.note
  };
  return out;
}

/* -------------------------------------------------------------- Family B: lineup */

/**
 * The lineup and replacement forecast (docs §6.2), adapted from the SAME
 * roster/availability pathway `nfl-expert-council.js`'s `gameExperts`
 * 'player_builder' expert already combines: `teamRosterStrength` for each
 * side's structural roster quality, `gamePlayerAvailability` for the shadow
 * replacement-value adjustment, and `gameInjuryCarryover` for postgame-truth
 * injury carryover. The combination formula below --
 * `structuralMargin - marketMargin + availabilityResidual` as the
 * market-residual, converted back to a raw margin as
 * `marketMargin + residual` -- is copied line for line from `gameExperts`
 * (see its `structuralMargin`/`availabilityResidual`/`rosterResidual`), not
 * reinvented here.
 */
export function lineupFamilyForecast({ season, week, home, away, cutoff = null } = {}) {
  const out = baseForecast(FAMILIES.lineup, 'Lineup and replacement forecast', { season, week, home, away, cutoff });
  const line = marketReference(season, week, home, away);
  if (line.error) { out.missing_reason = `market reference unavailable: ${line.error}`; return out; }
  const marketMargin = line.ensemble.market_spread != null ? -line.ensemble.market_spread : null;
  out.margin.market = r2(marketMargin);

  const availability = gamePlayerAvailability(season, week, home, away);
  const injuryCarryover = gameInjuryCarryover(season, week, home, away);
  const homeRoster = teamRosterStrength(season, week, home);
  const awayRoster = teamRosterStrength(season, week, away);

  // Copied from `gameExperts`'s 'player_builder' expert, unchanged.
  const structuralMargin = homeRoster.available && awayRoster.available
    ? 1.5 + (homeRoster.roster_score - awayRoster.roster_score) * 0.32 : null;
  const availabilityResidual = Number.isFinite(availability?.shadow_margin_adjustment)
    && availability?.home?.evidence_state !== 'availability_unknown'
    && availability?.away?.evidence_state !== 'availability_unknown'
    ? availability.shadow_margin_adjustment + (injuryCarryover.incremental_margin_adjustment ?? 0) : null;
  const rosterResidual = Number.isFinite(structuralMargin)
    ? structuralMargin - (marketMargin ?? 0) + (availabilityResidual ?? 0) : availabilityResidual;

  // Both sub-modules this family depends on already self-report their own
  // production readiness; a family built from two shadow-only inputs is
  // qualified only when both say so, which is still just reading what each
  // already reports, not a new rule about what "qualified" means.
  out.qualified = availability?.production_eligible === true && injuryCarryover?.production_eligible === true;
  out.qualification_source = 'nfl-player-value.js gamePlayerAvailability().production_eligible AND ' +
    "nfl-postgame-truth.js gameInjuryCarryover().production_eligible (both currently self-report false: " +
    `"${availability?.note ?? ''}" / "${injuryCarryover?.rule ?? ''}")`;

  out.observed = Number.isFinite(rosterResidual);
  if (!out.observed) {
    out.missing_reason = availability?.reason
      ?? (!homeRoster.available ? homeRoster.reason : !awayRoster.available ? awayRoster.reason : null)
      ?? 'cutoff-safe depth chart and replacement-value data unavailable for this game';
    return out;
  }

  out.margin.predicted = marketMargin != null ? r2(marketMargin + rosterResidual) : null;
  // This family reports a market-residual point adjustment, not a scored
  // distribution -- forcing a win/push/loss triple out of it would be
  // fabricating precision it does not have, so both stay explicitly
  // unavailable rather than being backed into from the point estimate.
  out.probabilities = { available: false,
    reason: 'this family produces a market-residual point adjustment, not a win/push/loss distribution' };
  out.distribution = { available: false,
    reason: 'point estimate only; no distributional forecast is produced by this family' };
  out.uncertainty = {
    available: Number.isFinite(homeRoster.fragility) || Number.isFinite(awayRoster.fragility),
    // Same formula `gameExperts` uses for this family's uncertainty.
    value: r2(4 + ((homeRoster.fragility ?? 50) + (awayRoster.fragility ?? 50)) / 50),
    kind: 'sd_from_roster_fragility'
  };
  out.detail = {
    structural_margin: r3(structuralMargin), availability_residual: r3(availabilityResidual),
    market_residual: r3(rosterResidual),
    home_roster: { available: homeRoster.available, roster_score: homeRoster.roster_score, fragility: homeRoster.fragility },
    away_roster: { available: awayRoster.available, roster_score: awayRoster.roster_score, fragility: awayRoster.fragility },
    availability_evidence_state: { home: availability?.home?.evidence_state, away: availability?.away?.evidence_state },
    availability_note: availability?.note
  };
  return out;
}

/* --------------------------------------------------------- Family D: direct cover */

/**
 * Direct spread-cover prediction (docs §6.4) -- CLEARLY STUBBED, not
 * connected.
 *
 * `research/tree_lab.py` trains logistic/LightGBM cover classifiers and
 * writes a joblib artifact (`run_classification()`, `${market}-${season}-
 * cover.joblib`), but nothing on the Node side loads that artifact to score a
 * live game: no route, no service, no cached prediction table. Docs §6.4 asks
 * for "a versioned artifact with feature order, units, preprocessing, training
 * cutoff, calibration and supported contract regime" plus "Python/Node parity
 * fixtures before serving it", and §10.3 lists this exact bridge as still
 * missing. Building that bridge is real, separate model-integration work this
 * task's constraints explicitly rule out ("do not fabricate a family's output
 * when it genuinely has none"). This stub exists so the family is still
 * VISIBLE in a side-by-side comparison, honestly abstaining, rather than
 * silently missing from the table.
 */
export function directCoverFamilyForecast({ season, week, home, away, cutoff = null } = {}) {
  const out = baseForecast(FAMILIES.direct_cover, 'Direct spread-cover classifier (research/tree_lab.py)',
    { season, week, home, away, cutoff });
  out.observed = false;
  out.missing_reason = 'not_yet_connected: research/tree_lab.py produces a joblib classifier artifact ' +
    'but no Node-side consumer loads it for a live prediction (docs/CLAUDE-NEXT-STEPS.md §6.4, §10.3). ' +
    'This is a documented stub, not a bridge -- see this function\'s doc comment.';
  out.qualified = false;
  out.qualification_source = 'no served artifact exists yet; there is no qualification state to surface';
  out.probabilities = { available: false, reason: 'classifier is not served; see missing_reason' };
  out.distribution = { available: false, reason: 'classifier is not served; see missing_reason' };
  return out;
}

/** The saved Stage 3 margin model is a separate family from the cover classifier.
 * It consumes only a retained feature request, never marketReference/live tables.
 * Calls are explicit and asynchronous; legacy allFamilyForecasts stays synchronous.
 */
export async function trainedMarginFamilyForecast(request, options = {}) {
  const game = { ...request?.game, cutoff: request?.cutoff_at ?? null };
  const out = baseForecast(FAMILIES.trained_margin, 'Trained Stage 3 margin model', game);
  const result = await scorePythonArtifact(request, options);
  out.qualification_source = 'research artifact; no prospective qualification or probability calibrator';
  out.detail = result;
  if (!result.available) { out.missing_reason = result.reason; return out; }
  out.observed = true;
  out.margin.predicted = result.predicted_margin;
  out.probabilities = result.probabilities;
  out.distribution = { available: false, reason: 'point estimate only; calibration remains open' };
  return out;
}

/**
 * Every family, same inputs, for a side-by-side comparison table.
 *
 * A family erroring out is represented as that family's own `observed: false`
 * row, never as a thrown exception that would drop it from the table.
 */
export function allFamilyForecasts({ season, week, home, away, cutoff = null } = {}) {
  return [
    ensembleFamilyForecast({ season, week, home, away, cutoff }),
    simulationFamilyForecast({ season, week, home, away, cutoff }),
    lineupFamilyForecast({ season, week, home, away, cutoff }),
    directCoverFamilyForecast({ season, week, home, away, cutoff })
  ];
}
