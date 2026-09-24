/**
 * EA-07: one world per NFL week.
 *
 * Before this, four places drew their own football for the same player-week
 * (BROKEN-NUMBERS rows B and C, ENGINE-ARCHITECTURE §10.2):
 *   - the title odds drew a fresh `world` per simulateSeason call (season-sim.js),
 *     cached under three different keys (routes/model.js memo, title-odds-trades.js,
 *     tradeImpact's per-sync seed), so the My team twin, the Title tab and the
 *     TradeCard printed three title odds for one team;
 *   - the trade card's floor/ceiling sampled its own pool, seeded from a cache-key
 *     string (trade-engine.js, player-week-engine.js#playerWeekDistribution);
 *   - the ceiling lineup sampled unkeyed pools from another projection build
 *     (ceiling-lineup.js);
 *   - the lineup posture used a positional-CV normal (lineup-posture.js).
 *
 * With the flag on, every one of them reads the same addressed draws: the world is
 * `keyedSeed('world', season, nfl_week)` (ENGINE-ARCHITECTURE §4.7), a player's
 * pool for week w is drawn under `keyedSeed(world, 'pool', player, w)`, and a
 * page's range is that pool's own quantiles (the copula indexes it at
 * floor(u x n), so p10 here is the draw the title odds use at u = 0.1). The world
 * is centred on the finder's rest-of-season rate (RL-17-3, folded in: one world
 * always reads proj.ros).
 *
 * This file is pure (no season-sim import) so trade-engine.js can use it while
 * building the asset universe the world itself is built on. The per-league world
 * cache is league-world.js.
 *
 * GRIDIRON_ONE_WORLD: '1' on, '0' off, unset = off unless preview mode
 * (preview-mode.js#previewUnconfirmed), where the response is labelled.
 */
import { keyedSeed } from './stats-util.js';
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const ONE_WORLD_ENV = 'GRIDIRON_ONE_WORLD';
export const ONE_WORLD_PREVIEW_REASON =
  'One set of simulated draws per NFL week behind the title odds, trade cards, ceiling lineup and ' +
  'lineup posture (EA-07); default off until measured on the local leagues';

/** { on, preview }: read per call, so a test or a run can flip it. */
export function oneWorldFlag() {
  const v = process.env[ONE_WORLD_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

/** The label a response carries when the one world is on only because of preview mode. */
export const oneWorldPreviewFields = flag => (flag.preview ? previewFields(ONE_WORLD_PREVIEW_REASON) : {});

/**
 * The world of one NFL week. The same number in every league (a player's football
 * is the same everywhere; scoring changes points, not draws: ENGINE-ARCHITECTURE
 * S-B3), and it changes once a week, never per sync or per request.
 */
export function oneWorldSeed(season, nflWeek) {
  return keyedSeed('world', Number(season), Number(nflWeek));
}

/**
 * RL-17-3's volume factor onto the finder's ros_ppg, or undefined when either rate
 * is unusable (the player keeps last season's rate and is counted as unscaled).
 * One definition, so the world and the trade card scale a player identically.
 */
export function rosFactor(rosPpg, ppg) {
  return Number.isFinite(rosPpg) && rosPpg >= 0 && Number.isFinite(ppg) && ppg > 0 ? rosPpg / ppg : undefined;
}

// player-week-engine.js#playerWeekDistribution's boom/bust lines, so a card's
// boom/bust rates mean the same thing whichever pool they are read from.
export const BOOM_AT = { QB: 24, RB: 18, WR: 18, TE: 14 };
export const BUST_AT = { QB: 14, RB: 8, WR: 8, TE: 6 };

/**
 * A player-week's range from a SORTED world pool. Quantiles are read at
 * floor(q x n), the index the copula maps u = q to (correlation.js#correlatedSampler),
 * so the p10 a page prints is the draw the title odds use at the 10th percentile.
 * The pool is unconditional: weeks he does not play are zeros in it.
 */
export function rangeFromPool(sorted, position = null) {
  if (!sorted?.length) return null;
  const n = sorted.length;
  const at = q => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * n)))];
  let s1 = 0, s2 = 0;
  for (const v of sorted) { s1 += v; s2 += v * v; }
  const mean = s1 / n;
  const boom = BOOM_AT[position] ?? 18, bust = BUST_AT[position] ?? 8;
  let booms = 0, busts = 0;
  for (const v of sorted) { if (v >= boom) booms++; if (v <= bust) busts++; }
  const r2 = v => +v.toFixed(2);
  return {
    p10: r2(at(0.1)), p25: r2(at(0.25)), p50: r2(at(0.5)), p75: r2(at(0.75)), p90: r2(at(0.9)),
    mean: r2(mean),
    sd: r2(Math.sqrt(Math.max(0, s2 / n - mean * mean))),
    variance: Math.max(0, s2 / n - mean * mean),
    boom_rate: +(booms / n).toFixed(3), bust_rate: +(busts / n).toFixed(3),
    draws: n
  };
}
