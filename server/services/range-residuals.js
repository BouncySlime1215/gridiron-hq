/**
 * PROJ-ESPN Q2: the calibrated weekly marginal of one player, pure.
 *
 * A player's week is drawn as   max(0, served ESPN mean + k x Q_pos(u))
 * where Q_pos is the empirical quantile function of (actual PPR - ESPN projection) at his
 * position over the 2022-2025 panel (range-residuals.json, built by
 * scripts/eval/proj-espn-residuals.mjs) and k is ONE global width multiplier
 * (range-calibration.js fits and stores it). Positions without a pool (K, D/ST) have no
 * spread here: they add their mean, as the season sim scores them.
 *
 * The lineup range itself (percentiles of the lineup total) is lineup-week-range.js's alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RESIDUALS_PATH = path.join(HERE, 'range-residuals.json');
export const REPLAY_RUNS = 4000;
export const REPLAY_SEED = 20260925;

let residualsCache = null;
/** The shipped residual quantiles and the initial k (with its fit date). Throws if the file is missing. */
export function residuals() {
  if (!residualsCache) residualsCache = JSON.parse(fs.readFileSync(RESIDUALS_PATH, 'utf8'));
  return residualsCache;
}
export function _setResidualsForTest(r) { residualsCache = r; }

/** Q_pos(u): linear interpolation on the stored grid; a position without a pool has no spread (0). */
export function residualAt(position, u, table = residuals()) {
  const q = table.positions?.[position];
  if (!q?.length) return 0;
  const n = q.length;
  // Grid point i sits at u_i = (i + 0.5) / n.
  const x = u * n - 0.5;
  if (x <= 0) return q[0];
  if (x >= n - 1) return q[n - 1];
  const i = Math.floor(x);
  return q[i] + (x - i) * (q[i + 1] - q[i]);
}

/** One player's week at uniform u. Never below 0 (a floor above zero is what the pages print). */
export const playerDraw = (mean, position, u, k, table) => Math.max(0, mean + k * residualAt(position, u, table));

/** A player's own p10 / p50 / p90 around his served mean (monotone in u, so read off the grid). */
export function playerWeekRange(mean, position, k, table = residuals()) {
  if (!Number.isFinite(mean)) return null;
  const at = u => +playerDraw(mean, position, u, k, table).toFixed(1);
  return { p10: at(0.10), p50: at(0.50), p90: at(0.90), mean: +mean.toFixed(2) };
}

/** Deterministic uniform in (0,1) for (seed, a, b, run): a 32-bit mix, no state. */
export function hashUniform(seed, a, b, run) {
  let h = (seed ^ Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(run + 1, 0x27d4eb2f)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h + 0.5) / 4294967296;
}
