/**
 * EA-07: the one world per league per NFL week, and what every surface reads off it.
 *
 * A league's world is season-sim.js#tradeImpactWorld built once under this NFL
 * week's seed (one-world.js#oneWorldSeed) on the finder's rest-of-season basis
 * (RL-17-3). It is held here per league and rebuilt only when its snapshot key
 * moves: a new league sync (rosters), a new NFL week (the seed), the league's
 * scoring or the projection basis. Everything below reads the same object:
 *
 *   title.odds   oneWorldTitleOdds: the world's unchanged-league result. The My
 *                team twin (/simulate), the playoff odds behind the trade horizon
 *                (trade-engine.js#myPlayoffOdds), the Title tab's and the
 *                TradeCard's "before" (tradeImpact with this world) are this one
 *                row, so they cannot disagree (BROKEN-NUMBERS row B).
 *   range.week   worldRange: a player-week's pool quantiles from the world
 *                (row C), read by the ceiling lineup and the lineup posture;
 *                the trade card draws the identical pool (season-sim.js#worldPoolFor).
 *
 * Process memory, like the RL-19-2 world it wraps; nothing is written to the
 * database (the engine spine, #216, is not on main: a stored `sim.world` row is
 * EA-06's once it lands).
 */
import crypto from 'node:crypto';
import { scoringFor } from './scoring.js';
import { SENSE_CHECK_SIM_RUNS } from './trade-verify.js';
import { tradeImpactWorld, rosBasisFlag, simStartWeek, worldPoolFor } from './season-sim.js';
import { tradeWeekContext } from './trade-engine.js';
import { oneWorldFlag, oneWorldSeed, oneWorldPreviewFields, rangeFromPool } from './one-world.js';

/**
 * Runs in the one world: the count every trade delta already uses
 * (season-sim.js#TRADE_IMPACT_RUNS = the sense-check's measured budget), so the
 * title odds and every deal's "before" are the same runs, not two run counts of
 * one league. Read from trade-verify.js, not season-sim.js: this module sits in
 * the season-sim <-> trade-engine import cycle and must not read a binding of
 * either at load time.
 */
export const ONE_WORLD_RUNS = SENSE_CHECK_SIM_RUNS;

const worlds = new Map();      // league id -> { key, world }
export function clearLeagueWorlds() { worlds.clear(); }

/** Everything the world depends on; a change in any of these is a new snapshot. */
function snapshotKey(lg) {
  const { season, week } = tradeWeekContext();
  return JSON.stringify({
    league: lg.id, fetched_at: lg.fetched_at ?? null, season, nfl_week: week,
    from_week: simStartWeek(lg), scoring: scoringFor(lg), basis: rosBasisFlag().on ? 'ros' : 'last_season',
    runs: ONE_WORLD_RUNS
  });
}

/** The league's world for this NFL week, built at most once per snapshot. */
export function leagueWorld(lg) {
  const key = snapshotKey(lg);
  const held = worlds.get(lg.id);
  if (held?.key === key) return held.world;
  const world = tradeImpactWorld(lg, { runs: ONE_WORLD_RUNS });
  // A failed build is not held: the next caller retries (a named failure, e.g. no
  // fixtures left, is returned to this caller as the world's `fail`).
  if (!world.fail) worlds.set(lg.id, { key, world });
  return world;
}

/** The fields that name the snapshot a number came from, for every response. */
export function worldStamp(lg, world) {
  const { season, week } = tradeWeekContext();
  const key = world?.key ?? {};
  return {
    snapshot_id: crypto.createHash('sha256').update(snapshotKey(lg)).digest('hex').slice(0, 12),
    world_id: key.seed ?? oneWorldSeed(season, week),
    season, nfl_week: week, league_fetched_at: lg.fetched_at ?? null,
    runs: key.runs ?? ONE_WORLD_RUNS, projection_basis: key.basis ?? null
  };
}

/**
 * The league's title.odds for this snapshot: the world's unchanged-league season.
 * `ignored` lists request parameters that no longer choose a different number
 * (runs, seed, from_week), so a caller that sent one can see it was not used.
 */
export function oneWorldTitleOdds(lg, { ignored = null } = {}) {
  const world = leagueWorld(lg);
  if (world.fail) return world.fail;
  const { per_run, ...base } = world.base;
  const flag = oneWorldFlag();
  return {
    ...base,
    one_world: { ...worldStamp(lg, world), ...(ignored && Object.keys(ignored).length ? { ignored } : {}) },
    ...oneWorldPreviewFields(flag)
  };
}

/**
 * range.week for one player in one NFL week, from the league's world pool. A week
 * outside the world's simulated weeks (before the league's current week) is drawn
 * with the same address and inputs (worldPoolFor), so it is still this world's
 * football. null on a bye or without a projection.
 */
export function worldRange(lg, player, week) {
  return rangeFromPool(worldPool(lg, player, week), player.position);
}

/** The sorted pool worldRange summarises (null on a bye, without a projection, or no world). */
export function worldPool(lg, player, week) {
  const world = leagueWorld(lg);
  if (world.fail) return null;
  return world.prep.weekData.get(Number(week))?.pools.get(player.id)
    ?? worldPoolFor(player, week, { scoring: scoringFor(lg), proj: world.projections, world: world.prep.world });
}
