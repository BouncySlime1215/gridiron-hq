/**
 * COACH-CHAT: what a follow-up is about.
 *
 * A thread's FOCUS is the card under discussion (move_id, and the step in it),
 * the league-mate on the other side (partner, a roster id), the players in
 * that step, and the move discussed before it (prev_move_id, for "the other
 * one"). It is ids only, set from what Coach last answered.
 *
 *   "why?", "why him?", "what if he says no?"   the focus as it stands
 *   "the other one", "the other trade"          the move discussed before this one
 *   "what about Lars instead", "what about team 7"
 *                                               a PARTNER SWITCH: the named manager
 *                                               (partner.js resolves him; a name that fits
 *                                               two managers is asked about, never guessed)
 *
 * followupIntent() classifies the follow-ups Coach answers from the plan with
 * no model; everything else goes the ordinary way (the starter intents, then
 * the model when it is on).
 */
import { resolvePartner } from './partner.js';
import { servedMoves, deckMoves } from './brief-claims.js';

const ok = f => f?.status === 'ok';

export const FOLLOWUP_INTENTS = Object.freeze(['why', 'if_no', 'other_one', 'partner_switch']);

const norm = q => String(q ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim();

const WHO = "(?:he|she|they|him|them|[a-z]+)";
const IF_NO = [
  new RegExp(`\\b(?:what|and|but) if ${WHO} (?:says? no|declines?|rejects?|passes|turns? (?:it|this|that)? ?down|doesn'?t (?:accept|reply|answer|respond|bite)|won'?t|counters?|ignores? (?:it|me)|goes quiet|ghosts?)\\b`),
  /\bif (?:he|she|they) (?:says? no|declines?|rejects?|counters?|goes quiet)\b/,
  /^(?:and |but )?(?:what )?if not\b/, /\bwhat if (?:it|that) (?:fails|falls through|doesn'?t work)\b/,
  /\bplan b\b/, /\bwhat'?s the backup\b/, /\bif (?:there'?s|i get) no (?:reply|answer)\b/
];
const WHY = [
  /^(?:but |ok |okay |so )?why\b(?! is nothing| nothing| are none| no trade)/, /\bhow come\b/, /\bexplain (?:it|that|this|why)\b/,
  /\bwhat'?s the (?:reasoning|case|logic|catch|risk)\b/, /\bwhy (?:him|her|them|that|this|it|that one|this one|that trade)\b/,
  /\bconvince me\b/, /\bwhat'?s the downside\b/
];
const OTHER_ONE = /\bthe other (?:one|trade|deal|move|card|offer)\b/;
const SWITCH = /\b(?:what|how) about\b|\binstead\b|^(?:and|or|try) |\brather\b|\bswitch to\b/;

/**
 * The follow-up a question asks, given the thread's focus and the league's
 * plan entry: { intent, roster? } or null. `identities` are the identity rows
 * partner.js resolves names with.
 */
export function followupIntent(question, { focus = {}, entry = null, identities = [] } = {}) {
  const t = norm(question);
  if (!t || t.length > 200) return null;
  if (entry) {
    const who = resolvePartner(question, { entry, identities });
    const short = t.split(' ').length <= 6;
    if (who && (SWITCH.test(t) || (short && !WHY.some(rx => rx.test(t)) && !IF_NO.some(rx => rx.test(t))))) {
      if (!who.roster) return { intent: 'partner_switch', ambiguous: who.ambiguous };
      return { intent: 'partner_switch', roster: who.roster };
    }
  }
  if (OTHER_ONE.test(t) && focus.prev_move_id) return { intent: 'other_one' };
  if (IF_NO.some(rx => rx.test(t))) return { intent: 'if_no' };
  if (WHY.some(rx => rx.test(t))) return { intent: 'why' };
  return null;
}

/** The served move with this id, or null. */
export function moveById(entry, moveId) {
  if (moveId == null) return null;
  return servedMoves(entry).find(m => String(m.move_id) === String(moveId))
    ?? deckMoves(entry).find(m => String(m.move_id) === String(moveId)) ?? null;
}

/**
 * The move and step a pronoun follow-up is about: the focused move (the step
 * with the focused partner, else the first), else the served next move.
 * Null when the plan has neither.
 */
export function focusedMove(entry, focus = {}) {
  const move = moveById(entry, focus.move_id) ?? (ok(entry?.next_move) && entry.next_move.value?.steps?.length ? entry.next_move.value : null);
  if (!move) return null;
  const k = Math.max(0, focus.partner != null ? move.steps.findIndex(s => String(s.partner) === String(focus.partner)) : 0);
  return { move, k, step: move.steps[k] };
}

/** The focus a served move sets: its id, the step's partner and players, the move it replaced. */
export function focusFor(move, k = 0, prev = {}) {
  const step = move?.steps?.[k];
  if (!step) return { ...prev };
  const id = String(move.move_id);
  const before = prev.move_id != null && String(prev.move_id) !== id ? String(prev.move_id) : (prev.prev_move_id ?? null);
  const prevMove = before === id ? null : before;
  return { move_id: id, step: k, partner: String(step.partner),
    players: [...step.give, ...step.get].map(String), prev_move_id: prevMove };
}

/** The focus after a partner answer that found no served move with him: the partner alone. */
export function partnerOnlyFocus(roster, prev = {}) {
  return { partner: String(roster), players: [], move_id: null, step: null,
    prev_move_id: prev.move_id ?? prev.prev_move_id ?? null };
}
