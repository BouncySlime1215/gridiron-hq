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
import { projEspnFlag, ESPN_CAPTURED_POSITIONS } from './espn-week-projection.js';
import { playerDraw, hashUniform, residuals, REPLAY_RUNS, REPLAY_SEED } from './range-residuals.js';

export const WEEKLY_RANGE_PERCENTILES = Object.freeze({ floor: 0.10, median: 0.50, ceiling: 0.90 });
export const WEEKLY_RANGE_METHOD = 'percentiles of the lineup total over the league world\'s correlated runs';
/**
 * PROJ-ESPN Q2 (GRIDIRON_PROJ_ESPN on, the served week): each QB/RB/WR/TE starter scores
 * max(0, served ESPN mean + k x Q_pos(u)) in every run, u being his draw's rank in his own
 * world column (so the copula's same-game correlation and the paired runs across a trade's two
 * sides are kept, only the centre and the width change); K / D/ST keep the world's fixed
 * projection. k is range-calibration.js's fitted width (80% p10-p90 coverage).
 */
export const WEEKLY_RANGE_METHOD_ESPN = 'percentiles of the lineup total: served ESPN mean + k x positional residual quantiles, ranked on the league world\'s correlated runs';

/**
 * The served-week centres for a world's week under PROJ-ESPN, from the world's own asset
 * universe (trade-engine.js, the one weekly producer): null when the flag is off or `week` is
 * not the universe's served week (ESPN captures only that week; other weeks keep the world).
 */
function espnCentres(world, week) {
  if (!projEspnFlag().on) return null;
  const assets = world?.prep?.assets;
  const ctx = assets?.context;
  if (ctx?.week_projection?.source !== 'espn_frozen' || Number(ctx.week) !== Number(week)) return null;
  return { status: ctx.week_projection.status, reason: ctx.week_projection.reason, k: ctx.week_projection.range_k?.k,
    assets };
}

// Per world-week: each column's run ranks as uniforms, built on first use.
const rankCache = new WeakMap();
function columnUniforms(wk, col, runs) {
  let byCol = rankCache.get(wk);
  if (!byCol) { byCol = new Map(); rankCache.set(wk, byCol); }
  let u = byCol.get(col);
  if (u) return u;
  const vals = new Float64Array(runs);
  for (let r = 0; r < runs; r++) vals[r] = wk.byRun[r].vals[col];
  const order = Array.from({ length: runs }, (_, i) => i).sort((a, b) => vals[a] - vals[b]);
  u = new Float64Array(runs);
  // Ties share their mid-rank, so the result does not depend on sort stability.
  for (let i = 0; i < runs;) {
    let j = i;
    while (j + 1 < runs && vals[order[j + 1]] === vals[order[i]]) j++;
    const mid = ((i + j) / 2 + 0.5) / runs;
    for (let t = i; t <= j; t++) u[order[t]] = mid;
    i = j + 1;
  }
  byCol.set(col, u);
  return u;
}

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
  const espn = espnCentres(world, week);
  if (espn && espn.status !== 'ok') return { error: `the served weekly projection is unknown: ${espn.reason}` };
  // Each starter is a draw column, a fixed K / D/ST projection, or nothing (0); under
  // PROJ-ESPN a skill starter is his served ESPN mean plus k x his residual at the column's rank.
  const cols = [];
  const calibrated = [];
  let fixed = 0, covered = 0, unknown = 0;
  const table = espn ? residuals() : null;
  for (const id of ids) {
    const a = espn ? lookup(espn.assets, id) : null;
    if (a && ESPN_CAPTURED_POSITIONS.has(a.position) && a.week_projection) {
      if (!Number.isFinite(a.current_week_ppg)) { unknown++; continue; }
      const i = lookup(index, id);
      calibrated.push({ mean: a.current_week_ppg, position: a.position, id: Number(a.id),
        u: i !== undefined ? columnUniforms(wk, i, world.runs) : null });
      covered++;
      continue;
    }
    const i = lookup(index, id);
    if (i !== undefined) { cols.push(i); covered++; continue; }
    const k = lookup(wk.kdst, id);
    if (k != null) { fixed += k; covered++; }
  }
  const seed = Number(world.key?.seed ?? 0) >>> 0;
  const totals = new Float64Array(world.runs);
  for (let run = 0; run < world.runs; run++) {
    const vals = wk.byRun[run].vals;
    let t = fixed;
    for (let c = 0; c < cols.length; c++) t += vals[cols[c]];
    for (let c = 0; c < calibrated.length; c++) {
      const s = calibrated[c];
      // A starter the world does not simulate still gets a reproducible draw keyed on his id.
      const u = s.u ? s.u[run] : hashUniform(seed, s.id, Number(week), run);
      t += playerDraw(s.mean, s.position, u, espn.k, table);
    }
    totals[run] = t;
  }
  return { totals, covered, starters: ids.length,
    ...(espn ? { basis: 'espn_calibrated', k: espn.k, unknown } : {}) };
}

/**
 * The same marginal on independent seeded uniforms: p10 / p50 / p90 of a lineup total from its
 * starters' means ([{ position, mean }]). Used ONLY to replay finished weeks for the width fit
 * and the weekly coverage log (range-calibration.js); `key` makes a team-week reproducible.
 */
export function replayBand(starters, k, { runs = REPLAY_RUNS, seed = REPLAY_SEED, key = 0, table = residuals() } = {}) {
  const totals = new Float64Array(runs);
  for (let r = 0; r < runs; r++) {
    let t = 0;
    for (let j = 0; j < starters.length; j++) {
      const s = starters[j];
      t += playerDraw(s.mean, s.position, hashUniform(seed, key, j, r), k, table);
    }
    totals[r] = t;
  }
  totals.sort();
  return { p10: quantileAt(totals, WEEKLY_RANGE_PERCENTILES.floor), p50: quantileAt(totals, WEEKLY_RANGE_PERCENTILES.median),
    p90: quantileAt(totals, WEEKLY_RANGE_PERCENTILES.ceiling) };
}

/**
 * Each player who has a draw in `world` for NFL week `week`, with his mean there
 * (the pool mean the title odds set lineups on); null when the week is not simulated.
 * A player on bye or without a pool is not in it: he scores 0 in every run.
 */
export function worldWeekMeans(world, week) {
  if (!world || world.fail) return null;
  const expected = world.draws?.get(Number(week))?.expected ?? null;
  const espn = expected ? espnCentres(world, week) : null;
  if (!espn || espn.status !== 'ok') return expected;
  // PROJ-ESPN: a skill player's mean is his served ESPN number (an unknown one is left out).
  const out = new Map();
  for (const [id, m] of expected) {
    const a = espn.assets.get(id) ?? espn.assets.get(Number(id));
    if (a && ESPN_CAPTURED_POSITIONS.has(a.position) && a.week_projection) {
      if (Number.isFinite(a.current_week_ppg)) out.set(id, a.current_week_ppg);
    } else out.set(id, m);
  }
  return out;
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
    method: t.basis ? WEEKLY_RANGE_METHOD_ESPN : WEEKLY_RANGE_METHOD,
    ...(t.basis ? { basis: t.basis, k: t.k, unknown_starters: t.unknown } : {})
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
