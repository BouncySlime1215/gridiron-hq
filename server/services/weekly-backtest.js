/**
 * Week-by-week walk-forward replay — the way the model actually runs.
 *
 * Everything in the Stage 1 gates was originally measured on season totals:
 * build a projection at the season boundary, compare to the full-season result,
 * 382 player-seasons. That measurement has three problems, and they are the
 * reason the shrinkage fit came back inconclusive:
 *
 *   1. Underpowered. ~380 paired observations per season, three seasons. A
 *      bootstrap over that cannot separate a 1% CRPS difference from noise.
 *   2. Survivorship-filtered. Grading only players with >=4 games conditions
 *      the truth on an outcome, while the model's prediction is unconditional.
 *   3. Not the decision. The product answers "start him this week?" every
 *      week; a season total is a draft-day question that gets asked once.
 *
 * This replays the season the way production sees it: at week W the model may
 * use prior seasons plus weeks 1..W-1 of the current one, and is graded on
 * week W alone. That yields thousands of player-weeks per season instead of
 * hundreds of player-seasons, needs no survivorship filter, and grades the
 * decision the app makes. It is also exactly the shape Stage 6.3 requires
 * ("week 15 is graded using only data through week 14"), so the audit can
 * replay production rather than approximating it.
 */
import { PPR } from './scoring.js';
import { buildProjections, sampleWeeks } from './projections.js';
import { actuals, spearman } from './backtest.js';
import { random, withRandomSeed } from './stats-util.js';

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/**
 * Randomized PIT.
 *
 * Weekly fantasy scores have real atoms — a receiver who is targeted twice and
 * catches nothing scores exactly 0, and a good fraction of simulated weeks land
 * there too. The plain `P(X <= y)` transform maps every one of those ties to
 * 1.0 and piles them into the top PIT bin, which reads as "the model is wildly
 * under-forecasting" when it is really just discreteness. Spreading ties
 * uniformly across the probability they actually occupy is the standard
 * correction and restores uniformity under a correct forecast.
 */
function randomizedPit(samples, y) {
  let below = 0, equal = 0;
  for (const s of samples) { if (s < y) below++; else if (s === y) equal++; }
  const n = samples.length;
  return (below + random() * equal) / n;
}

/** CRPS from samples (same estimator as backtest.js, kept local to avoid a rounding round-trip). */
function crpsRaw(samples, y) {
  const n = samples.length;
  if (!n) return null;
  const s = [...samples].sort((a, b) => a - b);
  let term1 = 0;
  for (const x of s) term1 += Math.abs(x - y);
  term1 /= n;
  let term2 = 0;
  for (let i = 0; i < n; i++) term2 += s[i] * (2 * i - n + 1);
  term2 = (2 * term2) / (n * n);
  return term1 - 0.5 * term2;
}

/**
 * Replays one season week by week.
 *
 * @param season        season to replay
 * @param startWeek     first week to grade (needs some in-season history; week 1
 *                      is projected purely off prior seasons, which is a
 *                      different and much harder problem)
 * @param endWeek       last week to grade
 * @param distributions whether to sample weekly distributions (the expensive part)
 * @param runs          simulation draws per player-week
 * @param level         level-uncertainty override passed through to the sampler
 * @param kOverride     shrinkage vector override (null = hardcoded constants)
 *
 * @returns per-week rows plus pooled metrics for the model and each baseline.
 */
export function replaySeasonWeekly(season, opts = {}) {
  // One seed for the whole replay: reproducible end to end, and every model
  // variant compared against the same simulation draws.
  return withRandomSeed(opts.seed ?? 20260826, () => replayImpl(season, opts));
}

function replayImpl(season, {
  startWeek = 5, endWeek = 18, scoring = PPR, distributions = true,
  runs = 200, level, kOverride = null, recency, roleRecency,
  predictionHead = null
} = {}) {
  const truth = actuals(season, scoring);

  // Per-model pooled accumulators. `predicted` vs `actual` pairs are kept so
  // the paired bootstrap can run over player-weeks afterwards.
  const models = {
    model: { absErr: [], pairs: [] },
    season_to_date: { absErr: [], pairs: [] },
    last3: { absErr: [], pairs: [] },
    blend: { absErr: [], pairs: [] }
  };
  const pits = [], crpsVals = [], perWeek = [], predictionRows = [];
  // Decision-relevant variant: players active LAST week (known at forecast time),
  // graded including a zero when they don't play this week.
  const withZeros = { model: [], season_to_date: [], blend: [] };

  for (let week = startWeek; week <= endWeek; week++) {
    const proj = buildProjections({
      through: season, throughWeek: week - 1, scoring, kOverride, recency, roleRecency
    });
    if (!proj.size) continue;

    const weekRows = { week, n: 0, model: [], season_to_date: [], last3: [], blend: [], pits: [], crps: [] };

    for (const [pid, p] of proj) {
      const t = truth.get(pid);
      if (!t) continue;
      const priorWeeks = [];
      for (let w = 1; w < week; w++) { const v = t.weeks.get(w); if (v != null) priorWeeks.push(v); }
      if (!priorWeeks.length) continue;             // no in-season history to baseline against

      const std = mean(priorWeeks);
      const l3 = mean(priorWeeks.slice(-3));
      const rawModelPred = p.ppg;
      const sortedPrior = [...priorWeeks].sort((a, b) => a - b);
      const context = {
        structural: rawModelPred, season_to_date: std, last3: l3,
        last1: priorWeeks.at(-1), median: sortedPrior[Math.floor(sortedPrior.length / 2)],
        position: p.position, prior_weeks: priorWeeks.length, player_id: pid, week
      };
      const modelPred = predictionHead ? predictionHead(context) : rawModelPred;
      // Keep this comparator tied to the structural head, so a candidate
      // ensemble cannot move the baseline it is required to beat.
      const blendPred = 0.6 * rawModelPred + 0.4 * std;

      const played = t.weeks.has(week);
      const act = t.weeks.get(week);

      // Decision-relevant: he was active last week, so you'd have had to make a
      // call on him. A DNP this week is a real zero, not a row to drop.
      if (t.weeks.has(week - 1)) {
        const a0 = played ? act : 0;
        withZeros.model.push(Math.abs(modelPred - a0));
        withZeros.season_to_date.push(Math.abs(std - a0));
        withZeros.blend.push(Math.abs(blendPred - a0));
      }

      if (!played) continue;                        // conditional-on-active metrics below

      predictionRows.push({ ...context, prediction: modelPred, blend: blendPred, actual: act });

      models.model.absErr.push(Math.abs(modelPred - act));
      models.season_to_date.absErr.push(Math.abs(std - act));
      models.last3.absErr.push(Math.abs(l3 - act));
      models.blend.absErr.push(Math.abs(blendPred - act));
      models.model.pairs.push({ pred: modelPred, act });
      models.season_to_date.pairs.push({ pred: std, act });
      models.last3.pairs.push({ pred: l3, act });
      models.blend.pairs.push({ pred: blendPred, act });

      weekRows.n++;
      weekRows.model.push(Math.abs(modelPred - act));
      weekRows.season_to_date.push(Math.abs(std - act));
      weekRows.last3.push(Math.abs(l3 - act));
      weekRows.blend.push(Math.abs(blendPred - act));

      if (distributions) {
        // Conditional on him being active, which is what this metric grades —
        // availability is measured separately by decision_including_dnp.
        const shift = modelPred - rawModelPred;
        const samples = sampleWeeks(p.params, runs, scoring, 1, 1, level)
          .map(value => Math.max(0, value + shift));
        const u = randomizedPit(samples, act);
        pits.push(u); weekRows.pits.push(u);
        const c = crpsRaw(samples, act);
        if (c != null) { crpsVals.push(c); weekRows.crps.push(c); }
      }
    }
    perWeek.push({
      week: weekRows.week, n: weekRows.n,
      mae_model: +mean(weekRows.model).toFixed(3),
      mae_season_to_date: +mean(weekRows.season_to_date).toFixed(3),
      mae_last3: +mean(weekRows.last3).toFixed(3),
      mae_blend: +mean(weekRows.blend).toFixed(3),
      crps_model: weekRows.crps.length ? +mean(weekRows.crps).toFixed(3) : null,
      coverage_80: weekRows.pits.length
        ? +(weekRows.pits.filter(u => u >= 0.1 && u <= 0.9).length / weekRows.pits.length).toFixed(3) : null
    });
  }

  const bins = new Array(10).fill(0);
  for (const u of pits) bins[Math.min(9, Math.floor(u * 10))]++;
  const expected = pits.length / 10;

  return {
    season, start_week: startWeek, end_week: endWeek,
    player_weeks: models.model.absErr.length,
    per_week: perWeek,
    point: Object.fromEntries(Object.entries(models).map(([name, m]) => [name, {
      mae: +mean(m.absErr).toFixed(3),
      spearman: spearman(m.pairs),
      n: m.absErr.length
    }])),
    decision_including_dnp: Object.fromEntries(Object.entries(withZeros).map(([name, v]) => [name, {
      mae: +mean(v).toFixed(3), n: v.length
    }])),
    distribution: pits.length ? {
      n: pits.length,
      crps: +mean(crpsVals).toFixed(3),
      coverage_80: +(pits.filter(u => u >= 0.1 && u <= 0.9).length / pits.length).toFixed(3),
      pit_histogram: bins,
      calibration_error: +(mean(bins.map(b => Math.abs(b - expected))) / expected).toFixed(3)
    } : null,
    // Raw per-player-week errors, for the paired bootstrap.
    _errors: { ...Object.fromEntries(Object.entries(models).map(([k, v]) => [k, v.absErr])), crps: crpsVals },
    _predictions: predictionRows
  };
}
