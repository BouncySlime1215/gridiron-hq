/**
 * Who on a roster can no longer move this week, because his game has started.
 *
 * All five synced leagues lock each player at his own game's kickoff (ESPN
 * `settings.rosterSettings.lineupLocktimeType` = INDIVIDUAL_GAME): once his game
 * begins he cannot move between the lineup and the bench (ESPN Fan Support,
 * "Lineup Lock Times"). The lineup surfaces used to solve every slot as if everyone
 * could still move, so from 1:00 pm ET Sunday the Start/Sit tab, the League Hub
 * card and the Decision Inbox recommended swaps ESPN refuses (RL-4-2).
 *
 * A player is locked when either source says so:
 *   - ESPN's own flag, `playerPoolEntry.lineupLocked === true` on the payload the
 *     hourly `league_rosters` job fetches (the only reader until now was
 *     scripts/collect-roster-snapshots.mjs:91); it also covers a delayed or moved
 *     game;
 *   - his game's kickoff, `gameCutoff(season, week, team)` (game-cutoff.js, the
 *     one cutoff representation), at or before `now`; it covers the up-to-60-minute
 *     age of the payload.
 *
 * This is a leaf module on purpose: trade-engine.js (the League Hub card) cannot
 * import lineup-brain.js (Start/Sit) without a cycle, and both must read the same
 * lock. ESPN only: a Sleeper roster reports `covered: false` and no locks, and the
 * surfaces say so rather than implying nobody is locked.
 */
import { gameCutoff } from './game-cutoff.js';
import { SLOT_NAME } from './espn-draft.js';

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Lock state of every rostered player on one ESPN team.
 *
 * @param lg        the leagues row (platform, payload)
 * @param rosterId  the team's id as loadRosters() reports it
 * @param players   that roster's players (id, name, espn_id, team_abbr)
 * @returns {{ covered: boolean, byId: Map<number, { locked: boolean,
 *   reason: 'espn_locked'|'kicked_off'|null, kickoff: string|null, slot: string|null }> }}
 *   `slot` is where ESPN has him set (SLOT_NAME: 'QB', 'FLEX', 'BENCH', 'IR', ...),
 *   null when the slot id is one this app does not model. `kickoff` is null when
 *   his team has no game_lines row this week (a bye, or a schedule not loaded).
 */
export function rosterLocks(lg, rosterId, players, { season, week, now = Date.now() }) {
  const byId = new Map();
  if (lg?.platform !== 'espn') return { covered: false, byId };
  const payload = typeof lg.payload === 'string' ? JSON.parse(lg.payload) : lg.payload;
  const team = (payload?.teams ?? []).find(t => String(t.id) === String(rosterId));
  const kickoffs = new Map();
  const kickoffOf = abbr => {
    if (!abbr) return null;
    if (!kickoffs.has(abbr)) kickoffs.set(abbr, gameCutoff(season, week, abbr));
    return kickoffs.get(abbr);
  };
  for (const e of team?.roster?.entries ?? []) {
    const pl = e.playerPoolEntry?.player;
    if (!pl) continue;
    // Matched the way loadRosters() put him on the roster: ESPN id first, then name.
    const p = players.find(x => x.espn_id != null && String(x.espn_id) === String(pl.id))
      ?? players.find(x => norm(x.name) === norm(pl.fullName));
    if (!p) continue;
    const kickoff = kickoffOf(p.team_abbr);
    const espnLocked = e.playerPoolEntry.lineupLocked === true;
    const kickedOff = kickoff != null && Date.parse(kickoff) <= now;
    byId.set(p.id, {
      locked: espnLocked || kickedOff,
      reason: espnLocked ? 'espn_locked' : kickedOff ? 'kicked_off' : null,
      kickoff,
      slot: SLOT_NAME[Number(e.lineupSlotId)] ?? null
    });
  }
  return { covered: true, byId };
}

/**
 * The pins the pinned solve takes (trade-engine.js#pinnedBestLineup): every locked
 * player, mapped to the slot ESPN has him in. A locked starter keeps that slot; a
 * locked bench or IR player is out of the solve. A locked player in a slot id this
 * app does not model is pinned to 'UNMODELED', which also keeps him out.
 */
export function lockPins(locks) {
  const pins = new Map();
  for (const [id, l] of locks.byId) if (l.locked) pins.set(id, l.slot ?? 'UNMODELED');
  return pins;
}

/** "1:00 pm ET" for a kickoff instant, for the sentence a locked slot prints. */
export function kickoffLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET';
}
