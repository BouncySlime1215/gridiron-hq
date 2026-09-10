/**
 * Does each feature family earn its influence? (Codex plan section 8.6.)
 *
 * `runNflFeatureAblations` already refits the ensemble with one family left
 * out and reports the resulting ROI. That answers ONE of the three questions
 * section 8.6 asks, and it answers it on the wrong universe:
 *
 *   "Report three separate answers for each group: did it improve the
 *    game-margin forecast; did it improve cover/push probabilities around
 *    offered spread thresholds; and did it improve the economic policy after
 *    prices and costs? Better margin error does not automatically improve
 *    cover calibration, and a better probability does not automatically make
 *    a bad offered price profitable."
 *
 *   "Use identical candidate universes, quote cutoffs, folds, score
 *    definitions, and missing-data rules."
 *
 * The ROI-only comparison violates the second requirement in a way that
 * quietly invalidates it. Each configuration SELECTS ITS OWN BETS, and the
 * selections differ enormously — the five-season run this module was written
 * to replace produced 204 bets for the full ensemble, 112 without efficiency,
 * and 432 for ratings-only. Comparing those ROIs compares three different
 * cohorts of games. A variant can "win" purely by betting less often on a
 * luckier subset, which is not evidence that removing a family improved the
 * forecast.
 *
 * So this module scores every configuration on the INTERSECTION of games all
 * of them produced a forecast for, and reports:
 *
 *   1. MARGIN     mean absolute error of the projected margin, against the
 *                 closing market's own error on the same games.
 *   2. COVER/PUSH Brier score of the cover probability at the offered spread,
 *                 plus whether predicted push mass matches realized pushes.
 *   3. ECONOMIC   units and ROI, restricted to that same common universe.
 *
 * Uncertainty on each is a PAIRED weekly-cluster bootstrap of the DIFFERENCE
 * from the full ensemble: the same resampled weeks are scored under both
 * configurations, so week-to-week noise cancels instead of being counted
 * twice. An unpaired comparison of two wide intervals would call almost
 * everything inconclusive; that is a property of the statistic, not of the
 * data.
 *
 * Nothing here promotes anything. Section 8.6's own words: "this opened
 * period cannot promote a tuned family set."
 */
import { replaySeason } from './nfl-replay.js';
import { featureContracts as ensembleFeatureContracts } from './nfl-ensemble.js';
import { mean, quantile, random, withRandomSeed } from './stats-util.js';

export const FAMILY_CONTRIBUTION_VERSION = 'nfl-family-contribution-v1';
const BOOTSTRAP_TRIALS = 4000;
const BOOTSTRAP_SEED = 20260910;

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
export const gameKey = d => `${d.season}|${d.week}|${d.home}|${d.away}`;

/** The ensemble's real family list, read from the model catalog. */
export function contributionFamilies() {
  return [...new Set(ensembleFeatureContracts().map(m => m.family))].filter(Boolean).sort();
}

/**
 * Which models actually consume a family, and whether anything downstream
 * reads it at all. Section 8.6: "Where a family is not actually consumed,
 * report 'no numerical consumer' instead of manufacturing a zero-effect
 * scientific result."
 */
export function familyConsumers() {
  const contracts = ensembleFeatureContracts();
  const byFamily = new Map();
  for (const model of contracts) {
    if (!model.family) continue;
    const entry = byFamily.get(model.family) ?? { family: model.family, models: [], challenger_only: 0 };
    entry.models.push(model.id);
    if (model.challenger_only) entry.challenger_only++;
    byFamily.set(model.family, entry);
  }
  return [...byFamily.values()].map(e => ({
    ...e,
    model_count: e.models.length,
    // A family whose every model is challenger-only never reaches a production
    // forecast, so its ablation would measure nothing. That is a "no numerical
    // consumer" answer, not a zero effect.
    numerical_consumer: e.models.length === 0 ? 'none'
      : e.challenger_only === e.models.length ? 'challenger_only'
        : 'production_ensemble'
  })).sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * Score one configuration's decisions over a fixed set of game keys.
 *
 * `keys` is the common universe; every configuration is scored over exactly
 * the same one. Games a configuration could not forecast are already excluded
 * from that set, for every configuration, so no variant is credited or
 * penalised for a differing denominator.
 */
export function scoreOver(decisionsByKey, keys) {
  const marginErrors = [], marketErrors = [], coverBrier = [];
  const legacyCoverBrier = [], threeStateBrier = [];
  let pushPredicted = 0, pushActual = 0, coverScored = 0;
  const units = [];
  for (const key of keys) {
    const d = decisionsByKey.get(key);
    if (!d) continue;

    // 1. MARGIN. The market's error on the same game is carried alongside,
    // because "better than the previous configuration" and "better than the
    // number you have to beat" are different claims.
    if (d.model_margin != null && d.actual_margin != null) {
      marginErrors.push(Math.abs(d.actual_margin - d.model_margin));
      if (d.market_margin != null) marketErrors.push(Math.abs(d.actual_margin - d.market_margin));
    }

    // 2. COVER / PUSH at the offered spread. `line` is expressed from the
    // backed side; `home_cover_probability` is expressed from the home side.
    // They are reconciled here rather than assumed to agree.
    const pd = d.feature_snapshot?.predictive_distribution;
    if (pd?.home_cover_probability != null && d.actual_margin != null && d.market_margin != null) {
      const homeSpread = -d.market_margin;
      const homeMargin = d.actual_margin + homeSpread;
      pushPredicted += pd.push_probability ?? 0;
      const scores = spreadProperScores({ homeCoverProbability: pd.home_cover_probability,
        pushProbability: pd.push_probability ?? 0, homeMargin });
      if (homeMargin === 0) pushActual += 1;
      if (scores?.three_state != null) threeStateBrier.push(scores.three_state);
      if (scores?.conditional != null) {
        // Conditional on the game being DECIDED, which is the question this
        // denominator asks. Scoring the unconditional probability against a
        // decided label -- what this did before -- penalises a model for the
        // push mass it correctly predicted.
        coverBrier.push(scores.conditional);
        legacyCoverBrier.push(scores.legacy_unconditional_vs_decided);
        coverScored++;
      }
    }

    // 3. ECONOMIC, restricted to this same universe.
    if (d.eligible && d.units != null) units.push(d.units);
  }
  const n = keys.length;
  // `mean([])` is 0 in stats-util, and 0 is a MEANINGFUL value for every one of
  // these metrics -- a Brier of 0 is a perfect forecast, an MAE of 0 is a
  // perfect prediction. Reporting "nothing was scored" as either would be the
  // most flattering possible misreading, so an empty set returns null.
  const avgOrNull = values => (values.length ? r3(mean(values)) : null);
  return {
    games: n,
    margin_mae: avgOrNull(marginErrors),
    market_margin_mae: avgOrNull(marketErrors),
    margin_beats_market: marginErrors.length && marketErrors.length
      ? mean(marginErrors) < mean(marketErrors) : null,
    // Conditional on a decided game. The corrected score.
    cover_brier: avgOrNull(coverBrier),
    // The whole distribution, pushes included. Null when no forecast in this
    // universe claimed push mass to be scored on.
    cover_brier_three_state: avgOrNull(threeStateBrier),
    // Exactly what the previous report computed, retained so an earlier
    // published number can be reconciled instead of silently reinterpreted.
    cover_brier_legacy_unconditional_vs_decided: avgOrNull(legacyCoverBrier),
    cover_scored: coverScored,
    // A Brier of 0.25 is what a constant 0.5 forecast scores. Anything at or
    // above it carries no information about which side covers.
    cover_beats_coin_flip: coverBrier.length ? mean(coverBrier) < 0.25 : null,
    predicted_pushes: r3(pushPredicted),
    actual_pushes: pushActual,
    bets: units.length,
    units: r3(units.reduce((s, v) => s + v, 0)),
    roi: units.length ? r3(mean(units)) : null
  };
}


/**
 * Proper scores for one three-state spread forecast (Codex correction C16).
 *
 * The defect: both scoring paths discarded pushes from the DENOMINATOR but
 * then scored the UNCONDITIONAL win probability against the decided binary
 * label. Those two choices are inconsistent. A 0.45 win / 0.10 push / 0.45
 * loss forecast on a decided win scored (0.45 - 1)^2 = 0.3025, when the
 * forecast it is actually being asked about -- "given this game was decided,
 * did the home side cover?" -- is 0.45 / 0.90 = 0.50, which scores 0.25.
 *
 * The model was being penalised for the push mass it separately and correctly
 * assigned. Worse, the penalty scales with how much push mass a model
 * predicts, so a model that gets key numbers RIGHT looks worse than one that
 * ignores them.
 *
 * Both scores are returned, because they answer different questions:
 *
 *   conditional  -- among decided games, was the cover call good? Comparable
 *                   with any classifier that excludes pushes, which is what
 *                   this project's cover calibrator produces.
 *   three_state  -- was the whole distribution good, pushes included? The
 *                   proper score when a forecast actually claims push mass.
 *
 * `legacy_unconditional_vs_decided` preserves exactly what the previous
 * report computed, so an earlier number can be reconciled rather than
 * silently reinterpreted.
 */
export function spreadProperScores({ homeCoverProbability, pushProbability = 0, homeMargin }) {
  if (homeCoverProbability == null || homeMargin == null) return null;
  const push = Number.isFinite(pushProbability) ? Math.min(Math.max(pushProbability, 0), 1) : 0;
  const decidedMass = 1 - push;
  const pushed = homeMargin === 0;
  const covered = homeMargin > 0 ? 1 : 0;

  // Three-state Brier: the sum of squared errors across all three outcomes.
  const loss = Math.max(1 - homeCoverProbability - push, 0);
  const threeState = (homeCoverProbability - (pushed ? 0 : covered)) ** 2
    + (push - (pushed ? 1 : 0)) ** 2
    + (loss - (pushed || covered ? 0 : 1)) ** 2;

  if (pushed) {
    // A pushed game has no conditional cover question to answer.
    return { conditional: null, three_state: threeState,
      legacy_unconditional_vs_decided: null, pushed: true };
  }
  const conditionalWin = decidedMass > 1e-9 ? homeCoverProbability / decidedMass : null;
  return {
    conditional: conditionalWin == null ? null : (conditionalWin - covered) ** 2,
    three_state: threeState,
    legacy_unconditional_vs_decided: (homeCoverProbability - covered) ** 2,
    pushed: false
  };
}

/** Metric values needed by the paired bootstrap, per game, so a resample is cheap. */
export function perGameMetrics(decisionsByKey, keys) {
  return keys.map(key => {
    const d = decisionsByKey.get(key);
    if (!d) return null;
    const pd = d.feature_snapshot?.predictive_distribution;
    let brier = null;
    if (pd?.home_cover_probability != null && d.actual_margin != null && d.market_margin != null) {
      const homeMargin = d.actual_margin + (-d.market_margin);
      // The SAME conditional score the summary uses. Two independently written
      // copies of a proper score is how a bootstrap comes to resample a
      // different metric from the one it reports.
      brier = spreadProperScores({ homeCoverProbability: pd.home_cover_probability,
        pushProbability: pd.push_probability ?? 0, homeMargin })?.conditional ?? null;
    }
    return {
      week: `${d.season}-${d.week}`,
      abs_error: d.model_margin != null && d.actual_margin != null
        ? Math.abs(d.actual_margin - d.model_margin) : null,
      brier,
      units: d.eligible && d.units != null ? d.units : null
    };
  }).filter(Boolean);
}

/**
 * Paired weekly-cluster bootstrap of (variant − baseline) on the common
 * universe. The SAME resampled weeks are scored under both configurations,
 * which is the whole point: the question is whether removing a family changed
 * the forecast, not whether two independently noisy runs happen to differ.
 */
export function pairedDelta(baselineGames, variantGames) {
  const weeks = [...new Set(baselineGames.map(g => g.week))];
  const byWeek = new Map(weeks.map(w => [w, {
    base: baselineGames.filter(g => g.week === w),
    variant: variantGames.filter(g => g.week === w)
  }]));
  const deltas = { margin: [], brier: [], roi: [] };
  if (weeks.length) withRandomSeed(BOOTSTRAP_SEED, () => {
    for (let trial = 0; trial < BOOTSTRAP_TRIALS; trial++) {
      const base = [], variant = [];
      for (let i = 0; i < weeks.length; i++) {
        const pick = byWeek.get(weeks[Math.floor(random() * weeks.length)]);
        base.push(...pick.base); variant.push(...pick.variant);
      }
      const stat = (rowsIn, field) => {
        const vals = rowsIn.map(g => g[field]).filter(v => v != null);
        return vals.length ? mean(vals) : null;
      };
      for (const [name, field] of [['margin', 'abs_error'], ['brier', 'brier'], ['roi', 'units']]) {
        const b = stat(base, field), v = stat(variant, field);
        if (b != null && v != null) deltas[name].push(v - b);
      }
    }
  });
  const summarize = (values, lowerIsBetter) => {
    if (!values.length) return { delta_95: [null, null], probability_variant_better: null };
    return {
      delta_95: [r3(quantile(values, 0.025)), r3(quantile(values, 0.975))],
      probability_variant_better: r3(
        values.filter(v => (lowerIsBetter ? v < 0 : v > 0)).length / values.length)
    };
  };
  return {
    method: 'paired deterministic weekly-cluster bootstrap of (variant - full ensemble) on the common universe',
    trials: BOOTSTRAP_TRIALS,
    margin_mae: summarize(deltas.margin, true),
    cover_brier: summarize(deltas.brier, true),
    roi: summarize(deltas.roi, false)
  };
}

/**
 * The full section 8.6 comparison.
 *
 * Runs the full ensemble and one leave-one-family-out variant per family,
 * scores all of them on the common candidate universe, and returns the
 * compact table section 8.6 asks Claude to produce.
 */
export function familyContributionReport(seasons = [2021, 2022, 2023, 2024, 2025], { markets = ['spread'] } = {}) {
  const families = contributionFamilies();
  const consumers = familyConsumers();
  const configs = [
    { id: 'all', family: null, families: null },
    ...families.map(f => ({ id: `without:${f}`, family: f, families: families.filter(x => x !== f) }))
  ];

  // Every configuration's decisions, keyed by game.
  const runs = configs.map(config => {
    const byKey = new Map();
    for (const season of seasons) {
      const replay = replaySeason(season, { markets, modelOptions: { weighting: 'exponential', families: config.families } });
      if (replay.error) continue;
      // A selected bet carries `units`; an unselected candidate does not.
      // Both are needed: the universe is every candidate, the economics are
      // only the selected ones.
      const unitsByKey = new Map(replay.bets.map(b => [gameKey(b), b.units]));
      for (const d of replay.decisions) {
        if (d.market !== 'spread') continue;
        const key = gameKey(d);
        byKey.set(key, { ...d, units: unitsByKey.get(key) ?? null });
      }
    }
    return { ...config, byKey };
  });

  // THE COMMON UNIVERSE: games every configuration forecast. Section 8.6's
  // "identical candidate universes" requirement, enforced structurally rather
  // than assumed.
  const keySets = runs.map(r => new Set(r.byKey.keys()));
  const commonKeys = [...keySets[0]].filter(k => keySets.every(s => s.has(k))).sort();
  const universe = {
    common_games: commonKeys.length,
    per_configuration_games: Object.fromEntries(runs.map(r => [r.id, r.byKey.size])),
    dropped_from_universe: Object.fromEntries(runs.map(r => [r.id, r.byKey.size - commonKeys.length])),
    note: 'Every configuration is scored on exactly these games. A variant that forecasts more or fewer games ' +
      'than the full ensemble has the difference EXCLUDED from all three answers, so no comparison is between ' +
      'different cohorts.'
  };

  const baseline = runs[0];
  const baselineScore = scoreOver(baseline.byKey, commonKeys);
  const baselineGames = perGameMetrics(baseline.byKey, commonKeys);

  const table = runs.slice(1).map(run => {
    const score = scoreOver(run.byKey, commonKeys);
    const uncertaintyOfDelta = pairedDelta(baselineGames, perGameMetrics(run.byKey, commonKeys));
    const consumer = consumers.find(c => c.family === run.family);
    return {
      family: run.family,
      // "actual consumer"
      numerical_consumer: consumer?.numerical_consumer ?? 'none',
      model_count: consumer?.model_count ?? 0,
      // "paired later-block change" — three separate answers, per section 8.6
      margin: { variant_mae: score.margin_mae, baseline_mae: baselineScore.margin_mae,
        delta: r3((score.margin_mae ?? 0) - (baselineScore.margin_mae ?? 0)),
        market_mae: baselineScore.market_margin_mae },
      cover: { variant_brier: score.cover_brier, baseline_brier: baselineScore.cover_brier,
        delta: r3((score.cover_brier ?? 0) - (baselineScore.cover_brier ?? 0)),
        predicted_pushes: score.predicted_pushes, actual_pushes: score.actual_pushes },
      economic: { variant_roi: score.roi, baseline_roi: baselineScore.roi,
        delta: score.roi != null && baselineScore.roi != null ? r3(score.roi - baselineScore.roi) : null,
        variant_bets: score.bets, baseline_bets: baselineScore.bets },
      // "uncertainty"
      uncertainty: uncertaintyOfDelta,
      // "cost"
      cost: { models_removed: consumer?.model_count ?? 0,
        share_of_ensemble: r3((consumer?.model_count ?? 0) / ensembleFeatureContracts().length) },
      decision: decideFamily({ family: run.family, consumer, score, baselineScore, uncertaintyOfDelta })
    };
  });

  return {
    version: FAMILY_CONTRIBUTION_VERSION,
    seasons, markets,
    scope: 'ordinary NFL full-game pregame point spreads only',
    universe,
    baseline: { id: 'all', ...baselineScore },
    families: table,
    consumers,
    policy: {
      kind: 'diagnostic_only',
      ablation_kind: 'refit_leave_one_family_out',
      note: 'Section 8.6: this opened development period explains contribution. It cannot promote a tuned ' +
        'family set, and nothing in this module changes any live configuration.'
    }
  };
}

/**
 * keep / simplify / test-connection, decided from the evidence rather than
 * narrated after it.
 *
 * The bar is deliberately asymmetric. KEEP is the default for a family that
 * is genuinely consumed, because removing a real input on inconclusive
 * evidence is the more expensive mistake. SIMPLIFY requires the paired
 * interval on at least one of the three answers to actually exclude zero in
 * the direction of "the model is better without it" — not merely a favourable
 * point estimate.
 */
export function decideFamily({ family, consumer, score, baselineScore, uncertaintyOfDelta }) {
  if (!consumer || consumer.model_count === 0) {
    return { verdict: 'test-connection',
      because: `${family} has no numerical consumer in the production ensemble, so its ablation measures ` +
        'nothing. Section 8.6 asks for that answer rather than a manufactured zero effect.' };
  }
  if (consumer.numerical_consumer === 'challenger_only') {
    return { verdict: 'test-connection',
      because: `every ${family} model is challenger-only, so it never reaches a production forecast. ` +
        'Connect one before asking whether the family earns its weight.' };
  }
  const conclusive = [
    ['margin error', uncertaintyOfDelta.margin_mae.delta_95],
    ['cover Brier', uncertaintyOfDelta.cover_brier.delta_95],
    ['ROI', uncertaintyOfDelta.roi.delta_95]
  ].filter(([, ci]) => ci[0] != null && ci[1] != null && (ci[0] > 0 || ci[1] < 0));

  if (!conclusive.length) {
    return { verdict: 'keep',
      because: `removing ${family} moved no answer by a margin the paired interval can distinguish from zero. ` +
        'Inconclusive is not evidence of no contribution, and it is not grounds for removal either.' };
  }
  // A conclusive interval in the direction of the variant being better on
  // margin or cover is a real simplification signal. A conclusive ROI-only
  // signal is not: selection differs game to game even inside a common
  // universe, and ROI is the noisiest of the three.
  const forecastSignal = conclusive.filter(([name]) => name !== 'ROI');
  if (forecastSignal.length && (score.margin_mae ?? Infinity) < (baselineScore.margin_mae ?? Infinity)) {
    return { verdict: 'simplify',
      because: `the ensemble forecasts the same games better WITHOUT ${family}, and the paired interval on ` +
        `${forecastSignal.map(([n]) => n).join(' and ')} excludes zero. Removing it is a real candidate, ` +
        'to be confirmed on later observations before anything changes.' };
  }
  return { verdict: 'keep',
    because: `${conclusive.map(([n]) => n).join(' and ')} moved conclusively, but not in a direction that ` +
      `argues the forecast improves without ${family}.` };
}
