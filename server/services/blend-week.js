/**
 * BROKEN-G: `blend.week`, the one "this week" number per player.
 *
 * Before this, three pages printed three different numbers for the same Sunday
 * (BROKEN-NUMBERS row G, ENGINE-ARCHITECTURE §10.2 G):
 *   - trade-engine.js#buildAssetUniverse served `current_week_ppg` (coordinator-
 *     corrected weekly rate x game multiplier x chance to play, 0 on a bye) with
 *     no betting-line lift;
 *   - Start/Sit and the League Hub lineup card (lineup-brain.js#startSitWeekPoints,
 *     trade-engine.js#lineupDiffWeekPoints) re-derived `week_points` =
 *     current_week_ppg x the FULL vegasLift, each on its own call;
 *   - the trade card's horizon (`adj_ppg` = 0.25 x this week + 0.75 x ros_ppg) and
 *     lineupSpan's this-week leg used the UNLIFTED current_week_ppg.
 *
 * With the flag on, buildAssetUniverse calls blendWeek() once per player and serves
 * the result as `blend_week`; Start/Sit, the lineup card and the trade card all read
 * that field, and `adj_ppg` becomes a derived field of it (horizonPpg below). The
 * construction is Start/Sit's (the number the lineup decision is already made and
 * graded on), so Start/Sit's own figure does not move; the trade side gains the lift
 * on its 25% this-week share, which is exactly where waiver-brain.js#vegasLift says
 * the lift belongs.
 *
 * Flag: GRIDIRON_BLEND_WEEK=1 on, =0 off (vetoes preview), unset follows
 * preview-mode.js#previewUnconfirmed(). Off, every number is what it was.
 * EA-07 moves this producer onto the engine spine as the `weekly-blend` producer's
 * `blend.week` field; until then this module is the one writer.
 */
import { previewUnconfirmed } from './preview-mode.js';
import { vegasLift } from './waiver-brain.js';

export const BLEND_WEEK_ENV = 'GRIDIRON_BLEND_WEEK';

/** This week's share of the trade horizon (adj_ppg). The rest is ros_ppg. */
export const CURRENT_WEEK_SHARE = 0.25;

export const BLEND_WEEK_REASON =
  'BROKEN-G: one this-week number (blend.week) for Start/Sit, the lineup card and the trade card; '
  + 'the trade horizon now carries the betting-line lift on its this-week share. Off by default '
  + 'until the coordinator\'s diff on the live DB is read.';

const r2 = n => Math.round(n * 100) / 100;

/** { on, preview }: preview is true only when the flag is on because of preview mode. */
export function blendWeekFlag() {
  const v = process.env[BLEND_WEEK_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

/**
 * The one producer. `p.current_week_ppg` is the served (2-dp) week projection;
 * a non-finite one returns null (no week number to lift), never a 0.
 * `lift` is injectable for tests; production uses vegasLift.
 */
export function blendWeek(p, season, week, { lift = vegasLift } = {}) {
  const base = p?.current_week_ppg;
  if (!Number.isFinite(base)) return null;
  // A bye (or a 0% chance to play) is a known 0: no line to read.
  if (base === 0) return { value: 0, base, vegas: { multiplier: 1, line: null, applied: false } };
  const vegas = lift(p, season, week);
  return { value: r2(base * (vegas.applied ? vegas.multiplier : 1)), base, vegas };
}

/** The trade horizon, derived from blend.week: never a second this-week number. */
export const horizonPpg = (weekPpg, rosPpg) =>
  CURRENT_WEEK_SHARE * weekPpg + (1 - CURRENT_WEEK_SHARE) * rosPpg;

/** The served blend.week on an asset, or null when the flag was off at build. */
export const servedBlendWeek = p => (Number.isFinite(p?.blend_week) ? p.blend_week : null);
