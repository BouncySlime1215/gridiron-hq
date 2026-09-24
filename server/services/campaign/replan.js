/**
 * CAMPAIGN-01c / north-star row 7: replan on every refresh and flag a changed next move (pure).
 *
 * The producer reruns on each refresh; this compares the new next move with
 * the one in the previous plans file and writes { changed, reason } so a push
 * can fire only when the move Nick should make is different.
 */
import { dealKey } from './paths.js';

export function nextMoveKey(entry) {
  const s = entry?.next_step ?? null;
  return s ? dealKey(s) : 'none';
}

/**
 * prev / next: { next_step, objective_version, risk_mode, title_now, roster_key }
 * Returns { changed, reason, previous_key, next_key }.
 */
export function diffNextMove(prev, next) {
  const nk = nextMoveKey(next);
  if (!prev) return { changed: nk !== 'none', reason: nk === 'none' ? 'no move yet' : 'first plan for this league', previous_key: null, next_key: nk };
  const pk = nextMoveKey(prev);
  if (pk === nk) return { changed: false, reason: 'same next move', previous_key: pk, next_key: nk };
  let reason;
  if (nk === 'none') reason = 'no move clears the bar now';
  else if ((prev.objective_version ?? 0) !== (next.objective_version ?? 0)) reason = 'you changed the goal';
  else if (prev.risk_mode !== next.risk_mode) reason = `risk mode changed to ${next.risk_mode}`;
  else if (prev.roster_key && next.roster_key && prev.roster_key !== next.roster_key) reason = 'rosters changed (a trade, claim or drop landed)';
  else if (pk !== 'none' && prev.next_step && next.next_step && String(prev.next_step.team) !== String(next.next_step.team)) reason = `better partner now: Team ${next.next_step.team}`;
  else reason = 'new numbers moved a different deal to the top';
  return { changed: true, reason, previous_key: pk, next_key: nk };
}
