/**
 * HYPO-01a per-stream thresholds (FIX-277-3): the spec's rule, fitted on the collected
 * history rather than hand-set. Pre-registered, before any run on the league's data, in
 * docs/evidence/2026-09-24/hypo-01a-threshold-prereg.md (sha256 beside it):
 *
 *   - a stream's units are every scored unit, flagged or not: each resolved league offer
 *     (surprisal of what happened), each roster window with a base rate, each rostered
 *     player-week with a usable range;
 *   - units are placed in 7-day blocks from the stream's first unit, by `at`;
 *   - the threshold for block k is the 95th percentile (linear interpolation) of the
 *     surprisal of every unit in blocks before k, used only when that history holds at
 *     least MIN_HISTORY units; block k is not evaluated otherwise;
 *   - a unit in an evaluated block is flagged when its surprisal is above that threshold;
 *   - the flag rate is flagged / evaluated, reported against TARGET_RATE +/- TARGET_TOL.
 *
 * Read-only. Reports ids and p values only.
 */
import { offerUnits, burstUnits } from './surprise.js';
import { projectionUnits } from './projection-stream.js';

export const QUANTILE = 0.95;
export const MIN_HISTORY = 20;
export const BLOCK_DAYS = 7;
export const TARGET_RATE = 0.05;
export const TARGET_TOL = 0.015;
const DAY = 86_400_000;

const parseAt = at => {
  if (at == null) return NaN;
  const s = String(at).trim();
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
};

/** Linear-interpolation quantile (type 7) of a sorted array. */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  return sorted[lo] + (h - lo) * ((sorted[Math.min(lo + 1, sorted.length - 1)]) - sorted[lo]);
}

/**
 * The walk-forward flag rate of one stream. `units` carry { id, at, p, surprisal }.
 * @returns { units, undated, evaluated, flagged, flag_rate, within_target, blocks, threshold_all, flagged_units }
 */
export function walkForward(units, { minHistory = MIN_HISTORY } = {}) {
  const dated = units.map(u => ({ ...u, t: parseAt(u.at) })).filter(u => Number.isFinite(u.t) && Number.isFinite(u.surprisal))
    .sort((a, b) => a.t - b.t);
  const undated = units.length - dated.length;
  if (!dated.length) {
    return { units: units.length, undated, evaluated: 0, flagged: 0, flag_rate: null, within_target: null,
      blocks: [], threshold_all: null, flagged_units: [] };
  }
  const t0 = dated[0].t;
  const blockOf = u => Math.floor((u.t - t0) / (BLOCK_DAYS * DAY));
  const blocks = new Map();
  for (const u of dated) (blocks.get(blockOf(u)) ?? blocks.set(blockOf(u), []).get(blockOf(u))).push(u);
  const history = [];
  const out = [];
  const flaggedUnits = [];
  let evaluated = 0; let flagged = 0;
  for (const k of [...blocks.keys()].sort((a, b) => a - b)) {
    const inBlock = blocks.get(k);
    if (history.length >= minHistory) {
      const threshold = quantile([...history].sort((a, b) => a - b), QUANTILE);
      const hits = inBlock.filter(u => u.surprisal > threshold);
      evaluated += inBlock.length; flagged += hits.length;
      flaggedUnits.push(...hits.map(u => ({ id: u.id, p: u.p })));
      out.push({ block: k, history: history.length, threshold, units: inBlock.length, flagged: hits.length });
    } else {
      out.push({ block: k, history: history.length, threshold: null, units: inBlock.length, flagged: null });
    }
    history.push(...inBlock.map(u => u.surprisal));
  }
  const rate = evaluated ? flagged / evaluated : null;
  return {
    units: units.length, undated, evaluated, flagged, flag_rate: rate,
    within_target: rate == null ? null : Math.abs(rate - TARGET_RATE) <= TARGET_TOL,
    blocks: out, threshold_all: quantile(dated.map(u => u.surprisal).sort((a, b) => a - b), QUANTILE),
    flagged_units: flaggedUnits,
  };
}

/** Every stream's walk-forward threshold and flag rate for one league-season. */
export function calibrateStreams({ leagueId, season, minHistory = MIN_HISTORY } = {}) {
  const offers = offerUnits(leagueId, season).map(o => ({
    id: o.id != null ? `trade_outcome:${o.id}` : `tx:${o.espn_tx_id}`, at: o.at, p: o.y === 1 ? o.p : 1 - o.p,
    surprisal: o.surprisal,
  }));
  const bursts = burstUnits(leagueId, season).map(w => ({ id: `team:${w.team_id}:tx:${w.tx_id}`, at: w.at, p: w.p,
    surprisal: w.surprisal }));
  const projection = projectionUnits(leagueId, season);
  const proj = projection.units.map(u => ({ id: `snapshot:${u.season}:${u.week}:${u.player_id}`, at: u.at, p: u.p,
    surprisal: u.surprisal }));
  return {
    league_id: leagueId, season,
    rule: { quantile: QUANTILE, min_history: minHistory, block_days: BLOCK_DAYS, target: [TARGET_RATE - TARGET_TOL, TARGET_RATE + TARGET_TOL] },
    streams: {
      offer: walkForward(offers, { minHistory }),
      roster_burst: walkForward(bursts, { minHistory }),
      projection_miss: { ...walkForward(proj, { minHistory }), state: projection.state, no_range: projection.no_range },
    },
  };
}
