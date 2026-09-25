/**
 * WEEKLY-RANGE-ONE: the one producer of "a lineup's weekly range".
 *
 * A lineup-week's floor, median and ceiling are the 10th, 50th and 90th
 * percentiles of the lineup's TOTAL in the league's one world
 * (league-world.js#leagueWorld): the correlated season-simulation draws the title
 * odds are played on. In each of the world's runs every starter scores his drawn
 * week for that NFL week (a week he does not play is the 0 in his pool; a K or
 * D/ST in the world's SIM-KDST map scores his fixed projection), the starters are
 * summed, and the percentiles are read off the sorted run totals.
 *
 * Why this sampler and not one of the four it replaced (number_health
 * `weekly_range`, CONSOLIDATION-MAP section 7 row B):
 *   - it is the only one the title odds read, so a card's range and the title odds
 *     it sits beside describe the same football;
 *   - it is a joint simulation with the fitted same-game correlations (and the game
 *     shocks when on), so it needs no normal approximation of a skewed total;
 *   - every lineup is scored on the SAME runs, so two lineups (a trade's before and
 *     after, the ceiling lineup's candidates) differ only by who is in them. That
 *     pairing is what the old trade-card sampler lacked when its 10,000-draw joint
 *     simulation failed the delta gate on draw noise (trade-engine.js history).
 * What it does not model: anything the world does not (a player with no pool this
 * week scores 0 in every run, as he does in the title odds).
 *
 * The percentile pair is WEEKLY_RANGE_PERCENTILES and nothing else. A quantile is
 * read at floor(q x n), the index the copula maps u = q to (one-world.js#rangeFromPool).
 *
 * Every surface calls lineupWeekRange / leagueLineupWeekRange for its starters:
 * the trade card and My team (trade-engine.js#lineupSpread), the ceiling lineup
 * (which also reads its hit probability off the same run totals), the lineup
 * posture's served range, and the number audit. test/weekly-range-one.test.js
 * fails if another module computes a lineup-week percentile on its own.
 */
import { leagueWorld } from './league-world.js';

export const WEEKLY_RANGE_PERCENTILES = Object.freeze({ floor: 0.10, median: 0.50, ceiling: 0.90 });
export const WEEKLY_RANGE_METHOD = 'percentiles of the lineup total over the league world\'s correlated runs';

/** The value at quantile q of an ascending array, at index floor(q x n). */
export function quantileAt(sorted, q) {
  const n = sorted?.length ?? 0;
  if (!n) return null;
  return sorted[Math.min(n - 1, Math.max(0, Math.floor(q * n)))];
}

const r1 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(1));

/**
 * One lineup's total in every run of `world` for NFL week `week`.
 * @returns {{ totals: Float64Array, covered: number, starters: number } | { error }}
 */
export function lineupWeekTotals(world, starterIds, week) {
  if (!world || world.fail) return { error: world?.fail?.error ?? 'no league world' };
  const wk = world.draws?.get(Number(week));
  if (!wk) return { error: `week ${week} is not one of the simulated weeks` };
  const ids = [...starterIds].filter(id => id != null);
  const index = wk.byRun[0]?.index;
  // Player ids are the asset universe's; a caller may hold them as strings.
  const lookup = (map, id) => map?.get(id) ?? map?.get(String(id)) ?? map?.get(Number(id));
  // Each starter is a draw column, a fixed K / D/ST projection, or nothing (0).
  const cols = [];
  let fixed = 0, covered = 0;
  for (const id of ids) {
    const i = lookup(index, id);
    if (i !== undefined) { cols.push(i); covered++; continue; }
    const k = lookup(wk.kdst, id);
    if (k != null) { fixed += k; covered++; }
  }
  const totals = new Float64Array(world.runs);
  for (let run = 0; run < world.runs; run++) {
    const vals = wk.byRun[run].vals;
    let t = fixed;
    for (let c = 0; c < cols.length; c++) t += vals[cols[c]];
    totals[run] = t;
  }
  return { totals, covered, starters: ids.length };
}

/**
 * Each player who has a draw in `world` for NFL week `week`, with his mean there
 * (the pool mean the title odds set lineups on); null when the week is not simulated.
 * A player on bye or without a pool is not in it: he scores 0 in every run.
 */
export function worldWeekMeans(world, week) {
  if (!world || world.fail) return null;
  return world.draws?.get(Number(week))?.expected ?? null;
}

/** The weekly range of a set of run totals (unsorted is fine). */
export function rangeOfTotals(totals) {
  const sorted = Float64Array.from(totals).sort();
  const n = sorted.length;
  if (!n) return { floor: null, median: null, ceiling: null, mean: null, sd: null, runs: 0 };
  let s1 = 0, s2 = 0;
  for (const v of sorted) { s1 += v; s2 += v * v; }
  const mean = s1 / n;
  return {
    floor: r1(quantileAt(sorted, WEEKLY_RANGE_PERCENTILES.floor)),
    median: r1(quantileAt(sorted, WEEKLY_RANGE_PERCENTILES.median)),
    ceiling: r1(quantileAt(sorted, WEEKLY_RANGE_PERCENTILES.ceiling)),
    mean: r1(mean),
    sd: r1(Math.sqrt(Math.max(0, s2 / n - mean * mean))),
    runs: n
  };
}

/**
 * A lineup's weekly range in `world`: { floor, median, ceiling, mean, sd, runs,
 * coverage, percentiles, method }, or { error } (floor/median/ceiling null).
 */
export function lineupWeekRange(world, starterIds, week) {
  const t = lineupWeekTotals(world, starterIds, week);
  if (t.error) return { floor: null, median: null, ceiling: null, error: t.error };
  return {
    ...rangeOfTotals(t.totals),
    coverage: t.starters ? +(t.covered / t.starters).toFixed(2) : 0,
    week: Number(week),
    percentiles: 'p10 / p50 / p90',
    method: WEEKLY_RANGE_METHOD
  };
}

/** lineupWeekRange in the league's one world (built once per snapshot, league-world.js). */
export function leagueLineupWeekRange(lg, starterIds, week) {
  let world;
  try {
    world = leagueWorld(lg);
  } catch (e) {
    // Named on the response (a range the page cannot print), the detail in the log.
    console.error(`[lineup-week-range] league ${lg?.id}: world build failed: ${e?.stack ?? e}`);
    return { floor: null, median: null, ceiling: null, error: 'the league world could not be built' };
  }
  return lineupWeekRange(world, starterIds, week);
}
