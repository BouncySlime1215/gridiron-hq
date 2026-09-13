/**
 * Purged walk-forward evaluation (Giant Plan Step 2a).
 *
 * The standing protocol this project actually runs (`nfl-replay.js`,
 * `nfl-family-contribution.js`, the blind-audit runner) is already
 * chronological -- fit on seasons 1..n, grade season n+1, never fit on a
 * game that hasn't happened yet. What none of them share is a single,
 * reusable PURGE step: dropping any TRAINING row whose own feature window
 * reaches forward into the test season, so a multi-week feature (a rolling
 * 3-game form average, a season-to-date rate) cannot leak the test period's
 * information backward into the model that is about to be graded on it.
 *
 * This is López de Prado's purged k-fold idea (Advances in Financial Machine
 * Learning, ch.7), specialized to season-level walk-forward instead of
 * random k-fold: every row carries a closed time interval
 * `[t - featureLookbackWeeks, t + labelHorizonWeeks]` (the span of weeks its
 * OWN features/label actually touch, not just the week it is dated to), and
 * a training row is dropped -- "purged" -- whenever that interval overlaps
 * the test season's own interval, optionally padded by an `embargoWeeks`
 * buffer on either side for residual correlation past the strict overlap
 * (also op.cit., ch.7.4).
 *
 * Every caller gets exactly one thing to get right (the two window widths
 * for ITS OWN features), and never has to re-derive the purge arithmetic
 * itself. `nfl-family-contribution.js`, `nfl-candidate-findings.js`'s
 * holdout tests, and the 21-model materiality question this stage backfills
 * (`docs/evidence/historical/path-to-profit-measurements.md`) can all call
 * this instead of each hand-rolling "seasons 1..n train, n+1 test."
 */

/**
 * Turns the distinct (season, week) pairs present in `rows` into a single
 * strictly increasing integer timeline. Two rows in different seasons never
 * collide, and gaps (a bye week nobody has a row for) simply don't get an
 * index -- which is correct, since nothing needs to purge around a week that
 * produced no data at all.
 */
export function buildWeekIndex(rowsIn) {
  const bySeason = new Map();
  for (const r of rowsIn) {
    if (!Number.isFinite(r.season) || !Number.isFinite(r.week)) {
      throw new Error(`buildWeekIndex: row missing numeric season/week: ${JSON.stringify(r)}`);
    }
    if (!bySeason.has(r.season)) bySeason.set(r.season, new Set());
    bySeason.get(r.season).add(r.week);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);
  const index = new Map();
  let i = 0;
  for (const season of seasons) {
    const weeks = [...bySeason.get(season)].sort((a, b) => a - b);
    for (const week of weeks) index.set(`${season}|${week}`, i++);
  }
  return { index, seasons };
}

const strip = r => { const { __wi, ...rest } = r; return rest; };

/**
 * Builds the fold sequence: for each season after the first `minTrainSeasons`
 * seasons, train on every earlier season EXCEPT rows purged by overlap with
 * the test season's window, test on that season.
 *
 * `featureLookbackWeeks` -- how many weeks BEFORE a row's own week its
 *   features reach back into (e.g. a "last 3 games" rolling form feature: 3).
 * `labelHorizonWeeks` -- how many weeks AFTER a row's own week its own
 *   label/target reaches forward into (0 for a same-week outcome like "did
 *   the spread cover this game"; >0 for a label defined over several
 *   upcoming weeks).
 * `embargoWeeks` -- extra buffer purged on both sides of the test window,
 *   for correlation that survives past the strict feature-window overlap
 *   (autocorrelated errors, slow-moving team-strength state). Defaults to 0
 *   (strict overlap purge only); callers with known slower-decaying
 *   dependence should pass a positive value.
 */
export function purgedWalkForwardFolds(rowsIn, {
  minTrainSeasons = 1,
  featureLookbackWeeks = 0,
  labelHorizonWeeks = 0,
  embargoWeeks = 0,
} = {}) {
  if (!rowsIn.length) return [];
  const { index, seasons } = buildWeekIndex(rowsIn);
  const withIdx = rowsIn.map(r => ({ ...r, __wi: index.get(`${r.season}|${r.week}`) }));

  const folds = [];
  for (let n = minTrainSeasons; n < seasons.length; n++) {
    const testSeason = seasons[n];
    const trainSeasons = seasons.slice(0, n);
    const trainSeasonSet = new Set(trainSeasons);
    const testRows = withIdx.filter(r => r.season === testSeason);
    if (!testRows.length) continue;

    const testMin = Math.min(...testRows.map(r => r.__wi));
    const testMax = Math.max(...testRows.map(r => r.__wi));
    const purgeLower = testMin - embargoWeeks;
    const purgeUpper = testMax + embargoWeeks;

    const trainRows = [], purgedRows = [];
    for (const r of withIdx) {
      if (!trainSeasonSet.has(r.season)) continue;
      const winStart = r.__wi - featureLookbackWeeks;
      const winEnd = r.__wi + labelHorizonWeeks;
      const overlaps = winEnd >= purgeLower && winStart <= purgeUpper;
      (overlaps ? purgedRows : trainRows).push(r);
    }

    folds.push({
      testSeason, trainSeasons,
      trainRows: trainRows.map(strip),
      testRows: testRows.map(strip),
      purgedRows: purgedRows.map(strip),
      counts: { train: trainRows.length, test: testRows.length, purged: purgedRows.length },
    });
  }
  return folds;
}

/**
 * The full driver: builds the purged folds, calls `predict(trainRows,
 * testRows, fold)` for each, scores the result with `score(predictions,
 * testRows, fold)`, and returns one entry per fold plus the pooled inputs a
 * caller commonly wants (e.g. to hand every fold's predictions to a single
 * pooled significance test rather than testing each fold in isolation).
 *
 * Deliberately does not pool or average metrics itself -- "how do five
 * seasons' worth of MAE combine" is a question with more than one right
 * answer (macro-average across folds vs. micro-average across pooled rows)
 * and this project's own evidence has been burned before by silently
 * picking one (`nfl-family-contribution.js`'s header comment on why ROI
 * comparisons need a common universe). Callers combine `folds[].metric`
 * themselves, deliberately.
 */
export function purgedWalkForwardEvaluate(rowsIn, { predict, score, ...foldOptions } = {}) {
  if (typeof predict !== 'function' || typeof score !== 'function') {
    throw new Error('purgedWalkForwardEvaluate requires both predict(trainRows, testRows, fold) and score(predictions, testRows, fold)');
  }
  const folds = purgedWalkForwardFolds(rowsIn, foldOptions);
  const evaluated = folds.map(fold => {
    const predictions = predict(fold.trainRows, fold.testRows, fold);
    const metric = score(predictions, fold.testRows, fold);
    return { testSeason: fold.testSeason, trainSeasons: fold.trainSeasons, counts: fold.counts, metric };
  });
  return {
    method: 'purged walk-forward: train on seasons 1..n minus any row whose feature/label window ' +
      'overlaps the test season (plus embargo), test on season n+1, roll forward',
    seasons_evaluated: evaluated.map(e => e.testSeason),
    folds: evaluated,
  };
}
