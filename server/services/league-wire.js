/**
 * THE league's wire (one producer): every priced QB/RB/WR/TE nobody in this league
 * rosters, who is available and on an NFL team.
 *
 * waiverBoard() (waiver-wire.js) builds its claims from exactly this pool, and the
 * trade engine's lineup value (trade-engine.js#lineupValueContext) takes its
 * replacement level from it, so a roster spot a trade frees is filled from the same
 * wire the Waivers page shows. Lifted out of waiver-wire.js (RL-9-3); it
 * lives in its own module because waiver-wire.js imports trade-engine.js, and the
 * trade engine importing it back would load waiver-wire.js ahead of any test that
 * mocks the engine for it.
 *
 * Who is rostered is decided by the ESPN-id-first resolver
 * (trade-engine.js#espnPlayerResolver, RL-6-4 #191), passed in by the caller rather
 * than imported for the same load-order reason. A name-only join hid a free agent
 * who shares a name with anyone rostered (the "Mike Williams" RB vs WR case) from
 * both the Waivers page and lineup_value's replacement pool.
 */
const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * Every asset rostered anywhere in the league: asset id -> ESPN team id, resolved by
 * `resolve` (trade-engine.js#espnPlayerResolver(assets)).
 */
export function rosteredAssetIds(payload, resolve) {
  const owned = new Map();
  for (const team of payload.teams ?? []) {
    for (const e of team.roster?.entries ?? []) {
      const { asset } = resolve(e.playerPoolEntry?.player);
      if (asset) owned.set(asset.id, String(team.id));
    }
  }
  return owned;
}

/** Whether a player can score at all: a free agent with no NFL team cannot. */
export const onNflTeam = a => Boolean(a.team_abbr ?? a.team);

/** Priced skill players whose asset id is not in `ownedById` (rosteredAssetIds) and not ruled out. */
export const unrosteredSkill = (assets, ownedById) => [...assets.values()].filter(a =>
  SCORED.has(a.position)
  && !ownedById.has(a.id)
  && a.available !== false);

/**
 * The wire for league `lg`, priced from `assets` (assetUniverse()), with rostered
 * players found by `resolve` (trade-engine.js#espnPlayerResolver(assets)).
 */
export function leagueWire(lg, assets, resolve) {
  if (!lg?.payload) return [];
  if (typeof resolve !== 'function') {
    throw new TypeError('leagueWire needs the ESPN-id-first resolver (trade-engine.js#espnPlayerResolver)');
  }
  return unrosteredSkill(assets, rosteredAssetIds(JSON.parse(lg.payload), resolve)).filter(onNflTeam);
}
