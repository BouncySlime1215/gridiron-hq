/**
 * THE league's wire (one producer): every priced QB/RB/WR/TE nobody in this league
 * rosters, who is available and on an NFL team.
 *
 * waiverBoard() (waiver-wire.js) builds its claims from exactly this pool, and the
 * trade engine's lineup value (trade-engine.js#lineupValueContext) takes its
 * replacement level from it, so a roster spot a trade frees is filled from the same
 * wire the Waivers page shows. Lifted out of waiver-wire.js unchanged (RL-9-3); it
 * lives in its own module because waiver-wire.js imports trade-engine.js, and the
 * trade engine importing it back would load waiver-wire.js ahead of any test that
 * mocks the engine for it.
 */
import { normalizePlayerName } from './player-identity.js';

const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);

/** Every player rostered anywhere in the league, by normalised name. */
export function rosteredNames(payload) {
  const owned = new Map();
  for (const team of payload.teams ?? []) {
    for (const e of team.roster?.entries ?? []) {
      const nm = e.playerPoolEntry?.player?.fullName;
      if (nm) owned.set(normalizePlayerName(nm), String(team.id));
    }
  }
  return owned;
}

/** Whether a player can score at all: a free agent with no NFL team cannot. */
export const onNflTeam = a => Boolean(a.team_abbr ?? a.team);

/** Priced skill players not in `owned` (rosteredNames) and not ruled out. */
export const unrosteredSkill = (assets, owned) => [...assets.values()].filter(a =>
  SCORED.has(a.position)
  && !owned.has(normalizePlayerName(a.name))
  && a.available !== false);

/** The wire for league `lg`, priced from `assets` (assetUniverse()). */
export function leagueWire(lg, assets) {
  if (!lg?.payload) return [];
  return unrosteredSkill(assets, rosteredNames(JSON.parse(lg.payload))).filter(onNflTeam);
}
