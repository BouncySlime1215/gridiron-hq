/**
 * A weekly projection range, measured rather than assumed.
 *
 * docs/spec/projection-range.md (Model evidence audit, 2026-09-22, branch
 * claude/project-thread-w0gpjt commit c58c20e) section 2's method, translated
 * from the spec's own reference script (intervals2.py) into this repo's
 * style. A fixed ±N band is wrong for two measured reasons the spec gives:
 * residual spread scales ~2.56x from the bottom projection decile to the
 * top, and fantasy points are floored at zero with a long right tail, so a
 * symmetric mean±k*sd band puts its lower edge below zero for most players
 * while still understating the upside. The fix is conditional empirical
 * quantiles, read off history rather than derived from a normal.
 *
 * The core algorithm (quantile/fitProjectionRangeTable/projectionRangeFor)
 * does not itself read real production data or run a walk-forward -- it
 * takes whatever rows it's given. Section 7's requirement (re-measure
 * against real production before quoting a number to a user) was cleared
 * separately: causalCoverageReport below replays the method exactly the way
 * the spec's own reference script (intervals2.py) does, and
 * docs/tdd/projection-range-coverage.tdd.md records a real run -- 22,040
 * graded player-weeks 2021-2025 via weekly-backtest.js's replaySeasonWeekly,
 * 80.21% coverage against an 80% target for WR/TE/RB, tighter than the
 * spec's own research-baseline deviation.
 *
 * The caller is responsible for causality: `history` passed to
 * fitProjectionRangeTable must already be restricted to strictly earlier
 * season-weeks than whatever is being projected. This module has no notion
 * of season/week ordering -- it only bins and quantiles whatever rows it is
 * given.
 *
 * Persistence (saveProjectionRangeFit/activateProjectionRangeFit/
 * activeProjectionRangeTable/projectionRangeFitHistory, migration 064):
 * versioned and activatable, the same shape as shrinkage-fit.js's own
 * shrinkage_fits/shrinkage_k, because a projection-range fit is a periodic
 * batch artifact one job produces and buildProjections reads -- not many
 * small independent measurements like nfl_metric_reliability, which upserts
 * in place instead.
 */

import { db, rows, row } from '../db/index.js';

const NBIN = 8;
const MIN_BIN_ROWS = 150;
const TARGET_COVERAGE = 0.80;
const MIN_ROWS_TO_SERVE = 20;

/**
 * Linear-interpolation quantile over a SORTED array, same convention as the
 * spec's own reference script: index = p * (n - 1), interpolate between the
 * two nearest order statistics.
 * @returns {number|null} null on an empty array.
 */
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** One position's 8-bin table: equal-count edges by yhat, and each bin's fitted band. */
function fitOnePosition(history) {
  const sortedByYhat = [...history].sort((a, b) => a.yhat - b.yhat);
  const edges = [];
  for (let k = 1; k < NBIN; k++) edges.push(sortedByYhat[Math.floor((k * sortedByYhat.length) / NBIN)].yhat);

  const binOf = yhat => {
    let b = 0;
    while (b < NBIN - 1 && yhat > edges[b]) b++;
    return b;
  };

  const buckets = Array.from({ length: NBIN }, () => []);
  for (const r of sortedByYhat) buckets[binOf(r.yhat)].push(r.y);

  const bins = buckets.map(ys => {
    if (ys.length < MIN_ROWS_TO_SERVE) return null;
    const sorted = [...ys].sort((a, b) => a - b);
    const lo = Math.max(0, quantile(sorted, (1 - TARGET_COVERAGE) / 2));
    const fLo = sorted.filter(y => y < lo).length / sorted.length;
    const upperP = Math.min(0.999, 1 - Math.max(0, (1 - TARGET_COVERAGE) - fLo));
    const hi = quantile(sorted, upperP);
    return { lo, hi, n: sorted.length };
  });

  return { edges, bins };
}

/**
 * Fits the causal quantile-band table from prior scored player-weeks.
 * @param history [{pos, yhat, y}] -- already restricted to strictly earlier
 *   season-weeks by the caller.
 * @returns {[pos: string]: {edges: number[], bins: (Band|null)[]}} A position
 *   short of 8*150 rows is pooled onto the full-population fit (same table
 *   object shared across every under-populated position), rather than fit
 *   alone on too little data.
 */
export function fitProjectionRangeTable(history) {
  const byPos = new Map();
  for (const r of history) {
    if (!(byPos.has(r.pos))) byPos.set(r.pos, []);
    byPos.get(r.pos).push(r);
  }
  const pooledTable = fitOnePosition(history);
  const table = {};
  for (const [pos, rowsForPos] of byPos) {
    table[pos] = rowsForPos.length >= NBIN * MIN_BIN_ROWS ? fitOnePosition(rowsForPos) : pooledTable;
  }
  return table;
}

/**
 * Looks up the fitted band for one projection.
 * @returns {{lo:number, hi:number, n:number}|null} null when the position was
 *   never in the fitting history, or its bin has fewer than 20 prior rows --
 *   absent beats invented (spec section 5).
 */
export function projectionRangeFor(table, pos, yhat) {
  const posTable = table[pos];
  if (!posTable) return null;
  const { edges, bins } = posTable;
  let b = 0;
  while (b < NBIN - 1 && yhat > edges[b]) b++;
  return bins[b];
}

/* ------------------------------------------------ causal walk-forward gate */

/**
 * Walks a set of graded player-weeks forward exactly the way the spec's own
 * reference script (intervals2.py) does: group into (season, week) batches,
 * order those batches chronologically, and for each one -- once at least
 * `minHist` prior rows have accumulated -- fit the quantile table from ONLY
 * the rows seen so far, score the batch against that table, then fold the
 * batch's own rows into history for the next one. A row is never scored
 * against a table that has seen its own outcome.
 *
 * This is section 7's requirement made runnable: the spec's own 80.74%
 * coverage was measured on a research baseline, not production, and must be
 * re-measured before being quoted to a user. Feed this function real,
 * causally-generated production rows (server/services/weekly-backtest.js's
 * replaySeasonWeekly output, tagged with season and mapped to
 * {pos, yhat: prediction, y: actual}) to get that real number. This
 * function itself is data-source-agnostic and takes whatever rows it is
 * given, in any order.
 *
 * @param rows [{season, week, pos, yhat, y}]
 * @param opts.minHist rows required before scoring starts (the spec's own
 *   script defaults this to 2000 for a full production run; small values are
 *   for fast, synthetic tests).
 * @returns {{n, coverage, meanWidth, byPosition, scored}}
 */
export function causalCoverageReport(rows, { minHist = 2000 } = {}) {
  const batches = new Map();
  for (const r of rows) {
    const key = `${r.season}|${r.week}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(r);
  }
  const orderedKeys = [...batches.keys()].sort((a, b) => {
    const [sa, wa] = a.split('|').map(Number), [sb, wb] = b.split('|').map(Number);
    return sa - sb || wa - wb;
  });

  let history = [];
  const scored = [];
  for (const key of orderedKeys) {
    const batchRows = batches.get(key);
    if (history.length >= minHist) {
      const table = fitProjectionRangeTable(history);
      for (const r of batchRows) {
        const band = projectionRangeFor(table, r.pos, r.yhat);
        if (!band) continue;
        scored.push({
          season: r.season, week: r.week, pos: r.pos, yhat: r.yhat, y: r.y,
          lo: band.lo, hi: band.hi, covered: r.y >= band.lo && r.y <= band.hi
        });
      }
    }
    history = history.concat(batchRows);
  }

  const n = scored.length;
  const coverage = n ? scored.filter(r => r.covered).length / n : 0;
  const meanWidth = n ? scored.reduce((s, r) => s + (r.hi - r.lo), 0) / n : 0;

  const byPosition = {};
  for (const r of scored) {
    const g = (byPosition[r.pos] ??= { n: 0, covered: 0, widthSum: 0 });
    g.n++;
    if (r.covered) g.covered++;
    g.widthSum += r.hi - r.lo;
  }
  for (const g of Object.values(byPosition)) {
    g.coverage = g.n ? g.covered / g.n : 0;
    g.meanWidth = g.n ? g.widthSum / g.n : 0;
    delete g.widthSum;
  }

  return { n, coverage, meanWidth, byPosition, scored };
}

/* -------------------------------------------------------------- persistence */

/**
 * Persists one fitted table (migration 064) -- NOT active until
 * activateProjectionRangeFit is called, same two-step shape as
 * shrinkage-fit.js's saveFit/activateFit. table_json is
 * fitProjectionRangeTable's own return shape verbatim; coverageOverall and
 * coverageByPosition are causalCoverageReport's self-check, recorded
 * alongside the fit as evidence, not asserted about it.
 * @returns {number} the new row's id.
 */
export function saveProjectionRangeFit({ throughSeason, minHist, nRows, coverageOverall, coverageByPosition, table }) {
  db.prepare(`INSERT INTO nfl_projection_range_fits
      (fitted_at, through_season, min_hist, n_rows, coverage_overall, coverage_json, table_json, active)
    VALUES (?,?,?,?,?,?,?,0)`)
    .run(new Date().toISOString(), throughSeason, minHist, nRows, coverageOverall ?? null,
      coverageByPosition ? JSON.stringify(coverageByPosition) : null, JSON.stringify(table));
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

/** Makes `fitId` the one row activeProjectionRangeTable returns; deactivates every other row. */
export function activateProjectionRangeFit(fitId) {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE nfl_projection_range_fits SET active = 0').run();
    db.prepare('UPDATE nfl_projection_range_fits SET active = 1 WHERE id = ?').run(fitId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * The currently-active fitted table, parsed back from JSON, or null if none
 * has ever been activated. buildProjections's own read path.
 */
export function activeProjectionRangeTable() {
  const fit = row('SELECT * FROM nfl_projection_range_fits WHERE active = 1 ORDER BY id DESC LIMIT 1');
  if (!fit) return null;
  return {
    id: fit.id,
    fitted_at: fit.fitted_at,
    through_season: fit.through_season,
    min_hist: fit.min_hist,
    n_rows: fit.n_rows,
    coverage_overall: fit.coverage_overall,
    coverage_by_position: fit.coverage_json ? JSON.parse(fit.coverage_json) : null,
    table: JSON.parse(fit.table_json)
  };
}

export function projectionRangeFitHistory(limit = 20) {
  return rows('SELECT * FROM nfl_projection_range_fits ORDER BY id DESC LIMIT ?', limit);
}
