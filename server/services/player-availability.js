/**
 * Season-ending / released detection, shared so every roster view agrees on who is
 * actually available. `server/routes/teams.js` first built this for the X's&O's
 * depth chart (a real season-ending torn triceps was still showing as the starting
 * LT there until that fix landed) — this module is the same detection, generalized
 * so the fantasy trade engine's lineup solver (which never had it at all) can use it
 * too, instead of drifting into its own copy of the same regex.
 */
import { rows } from '../db/index.js';

export const SEASON_ENDING_RE = /(?:out for (?:the )?season|season[- ]ending|torn (?:acl|achilles|triceps|pector\w*|pec|quad(?:riceps)?|bicep|patella|meniscus)|ruptured \w+|placed on (?:injured reserve|ir))\b/i;
export const RELEASED_RE = /\b(?:waived|released|cut|terminated)\b/i;

/**
 * Every rostered player's espn_id currently flagged season-ending/released, league-wide.
 * Cheap by construction: filters news down to the (usually small) set of severe-language
 * items first, then only checks roster names against that subset — not every player
 * against every news item.
 */
export function seasonEndingEspnIds({ days = 45 } = {}) {
  const roster = rows(`SELECT DISTINCT espn_id, name FROM roster_players WHERE espn_id IS NOT NULL`);
  if (!roster.length) return new Set();
  const severe = rows(
    `SELECT headline, body FROM news_items WHERE COALESCE(published_at, date) >= datetime('now', ?)`,
    `-${days} days`
  ).filter(n => {
    const text = `${n.headline ?? ''} ${n.body ?? ''}`;
    return SEASON_ENDING_RE.test(text) || RELEASED_RE.test(text);
  });
  if (!severe.length) return new Set();

  const flagged = new Set();
  for (const player of roster) {
    const lastName = player.name.split(' ').slice(-1)[0];
    const nameRe = new RegExp(`\\b${lastName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (severe.some(n => nameRe.test(`${n.headline ?? ''} ${n.body ?? ''}`))) flagged.add(player.espn_id);
  }
  return flagged;
}
