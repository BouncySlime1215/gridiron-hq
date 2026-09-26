/**
 * O1C gate: which validated O1-RADAR cells may move the served weekly projection.
 *
 * The radar (opportunity-radar.js, PR #440) already gates each cell on opportunity: fit CI
 * excludes 0 on 2021-23 and the 2024 out-of-sample gain CI is above 0. That proves the cell
 * predicts OPPORTUNITY. It does not prove the wired PROJECTION is better, and it says nothing
 * about ESPN. ONE-PLAN night 11: "beats ESPN on the same player-weeks before the served weekly
 * number moves, else ROS / LOVE / flip only". This module is that second gate.
 *
 * Pre-registered in docs/tdd/2026-09-25-o1c-wire.tdd.md. Every cell ships 'pending'; a cell
 * turns 'passed' only in its own PR carrying the output of scripts/rnd/o1c-grade.mjs.
 */
import { pairedBootstrapDiff } from './backtest-significance.js';

/** The four cells the radar's own gate passed (FITTED_EFFECTS passes_gate, PR #440). */
export const O1C_CELLS = Object.freeze(['teammate_out|RB', 'usage_rise|WRTE', 'star_return|RB', 'star_return|WRTE']);

export const O1C_MIN_N = 30;
export const O1C_SEED = 20260925;

/** Status per cell: 'pending' until graded; 'passed' / 'failed' only with a grade record. */
export const O1C_GATES = Object.freeze(Object.fromEntries(O1C_CELLS.map(c => [c, Object.freeze({
  status: 'pending',
  bar: `wired beats unwired (2024) AND ESPN (2026 as-of) on the same player-weeks: 90% CI of the error difference below 0, n >= ${O1C_MIN_N}`
})])));

/**
 * Grade one cell. rows: [{ player, err_base, err_wired, err_espn }] absolute errors of the unwired
 * projection, the wired one and ESPN's as-of projection on the same player-week (err_espn null
 * when no ESPN row exists). Lower is better; a CI entirely below 0 means wired is better.
 */
export function gradeO1cCell(rows, { minN = O1C_MIN_N, seed = O1C_SEED, iterations = 2000 } = {}) {
  const n = rows.length;
  const vs_unwired = n >= 10
    ? pairedBootstrapDiff(rows.map(r => r.err_base), rows.map(r => r.err_wired), { seed, iterations, groups: rows.map(r => r.player) })
    : null;
  const espn = rows.filter(r => Number.isFinite(r.err_espn));
  const vs_espn = espn.length >= 10
    ? pairedBootstrapDiff(espn.map(r => r.err_espn), espn.map(r => r.err_wired), { seed, iterations, groups: espn.map(r => r.player) })
    : null;
  const below = g => !!g && !g.error && g.ci90[1] < 0;
  let reason = null;
  if (n < minN) reason = `n ${n} < ${minN}`;
  else if (!below(vs_unwired)) reason = `wired does not beat unwired (CI ${vs_unwired?.ci90?.map(v => v.toFixed(3)).join(', ') ?? 'none'})`;
  else if (espn.length < minN) reason = `ESPN comparison n ${espn.length} < ${minN}: ROS / LOVE / flip only`;
  else if (!below(vs_espn)) reason = `wired does not beat ESPN (CI ${vs_espn.ci90.map(v => v.toFixed(3)).join(', ')})`;
  return { n, n_espn: espn.length, vs_unwired, vs_espn, passes: reason == null, reason: reason ?? 'passes both bars' };
}
