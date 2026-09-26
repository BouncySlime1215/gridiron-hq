/**
 * COACH-CHAT: the follow-ups Coach answers from the plan with no model ($0).
 *
 *   why             the focused move's reasoning: the case for it, his side, the
 *                   risk, the news check and how sure the planner is
 *   if_no           the focused step's reply table: on a no (and the backup move),
 *                   on a counter (the counter rules), on silence, the walk-away
 *   other_one       the move discussed before this one, in full
 *   partner_switch  "what about <manager> instead": the best served move through
 *                   him (partner.js), else his best flip leg, else his read and
 *                   an honest "nothing clears with him"
 *
 * Same contract as brief-claims.js: every sentence cites the plan cells it
 * stands on and is grounded by starter-answers.js#groundStarter (verify.js)
 * before it ships; a sentence that fails is dropped and reported. Nothing here
 * builds a trade: Coach only reads what the planner served, so Nick's rules
 * (never overpay, blue chips) hold because the planner already applied them.
 *
 * followupsFor() picks the 2-3 chips shown after an answer; every chip is a
 * question one of these (or a starter intent) answers at $0.
 */
import { moveClaims, servedMoveClaims, namedTeams, plainSteps, teamOf } from './brief-claims.js';
import { partnerClaimsFor } from './partner.js';
import { focusedMove, moveById } from './focus.js';

const ok = f => f?.status === 'ok';
const val = f => (ok(f) ? f.value : undefined);
const pct = p => `${Math.round(p * 100)}%`;

function record(ledger, tool, rows) {
  const e = ledger.record({ tool, tables: [tool], columns: Object.keys(rows[0] ?? {}), rows });
  return (i, col) => `${e.id}#${i}.${col}`;
}

/** Engine asides the planner's prose carries in parentheses (file names, check ids, field names) are not said. */
const ENGINE_ASIDE = /\s*\((?=[^)]*(?:\.js|_|\bE\d|\bunvalidated\b|\bband\b|\bmidpoint\b|\bhis screen\b))[^)]*\)/gi;
const plain = (entry, text) => (typeof text === 'string' && text.trim()
  ? plainSteps(namedTeams(entry, text)).replace(ENGINE_ASIDE, '').replace(/\s+([,.;:])/g, '$1').trim() : null);

/** Team and player labels a strict claim may name without them counting as numbers. */
function labelsFor(entry, move, step) {
  const names = entry.names ?? {};
  const teams = [...new Set([String(entry.me), String(step.partner), move.target_owner, ...Object.keys(val(entry.teams) ?? {})]
    .filter(t => t != null && t !== 'undefined').map(String))].flatMap(t => [`Team ${t}`, teamOf(entry, t)]);
  const players = [...step.give, ...step.get].map(pid => names[pid]).filter(Boolean);
  const n = move.steps.length;
  return [...teams, ...players, ...players.map(p => p.replace(/\s*\([^)]*\)\s*$/, '')), `${n} step(s)`, `${n} steps`];
}

const SLOT_LEAD = [
  ['case_for', 'Why'], ['his_side', 'Their side'], ['devils_advocate', 'The risk'], ['news_check', 'News'], ['confidence', 'How sure']
];

/** "why?": the focused move's reasoning slots, each held to the move's numbers (strict). */
export function whyClaims(entry, ledger, focus = {}) {
  const section = 'why';
  const at = focusedMove(entry, focus);
  if (!at) return noMove(entry, ledger, section);
  const { move, k, step } = at;
  const [offer] = moveClaims(entry, ledger, section, move, { k });
  const reasoning = { ...(val(step.reasoning) ?? {}), ...(val(move.reasoning) ?? {}) };
  const row = {
    delta: val(step.title_odds_delta) ?? null, p_yes: val(step.p_yes) ?? null, title_after: val(step.title_after) ?? null,
    delta_final: val(move.delta_final) ?? null, p_complete: val(move.p_complete) ?? null, expected: val(move.expected) ?? null
  };
  const c = record(ledger, 'plan_reasoning', [row]);
  const numeric = Object.keys(row).map(key => c(0, key));
  const labels = labelsFor(entry, move, step);
  const out = offer ? [{ ...offer, text: `About this offer: ${offer.text.replace(/^Offer /, 'offer ')}` }] : [];
  for (const [slot, lead] of SLOT_LEAD) {
    const text = plain(entry, reasoning[slot]);
    if (text) out.push({ section, strict: true, labels, cites: numeric, text: `${lead}: ${text}` });
  }
  if (out.length <= 1) {
    const r = record(ledger, 'plan_reasoning', [{ reason: 'the planner wrote no reasoning for this move' }]);
    out.push({ section, cites: [r(0, 'reason')], text: 'The plan has no written reasoning for this move beyond its numbers.' });
  }
  return out;
}

/** "what if he says no?": the focused step's reply table and walk-away. */
export function ifNoClaims(entry, ledger, focus = {}) {
  const section = 'if_no';
  const at = focusedMove(entry, focus);
  if (!at) return noMove(entry, ledger, section);
  const { move, k, step } = at;
  const out = [];
  const [offer] = moveClaims(entry, ledger, section, move, { k });
  if (offer) out.push({ ...offer, text: `About this offer: ${offer.text.replace(/^Offer /, 'offer ')}` });
  const table = val(step.reply_table) ?? {};
  const no = val(table.decline);
  if (no?.do) {
    const after = ok(no.odds_after) && no.odds_after.unit === 'title_odds' ? no.odds_after.value : null;
    const c = record(ledger, 'plan_reply_decline', [{ do: plain(entry, no.do), odds_after: after }]);
    out.push({ section, cites: [c(0, 'do'), ...(after != null ? [c(0, 'odds_after')] : [])],
      text: `If they say no: ${plain(entry, no.do)}${after != null ? ` Title odds are then ${pct(after)}.` : ''}` });
    const backup = no.move_id != null && String(no.move_id) !== String(move.move_id) ? moveById(entry, no.move_id) : null;
    if (backup) {
      const [line] = moveClaims(entry, ledger, section, backup, { k: 0 });
      if (line) out.push({ ...line, text: `The backup: ${line.text.replace(/^Offer /, 'offer ')}` });
    }
  }
  const counter = val(table.counter);
  if (counter?.do) {
    const rules = counter.counter_rules ?? {};
    const row = { do: plain(entry, counter.do), accept_if: plain(entry, rules.accept_if), counter_with: plain(entry, rules.counter_with),
      walk_away_if: plain(entry, rules.walk_away_if) };
    const c = record(ledger, 'plan_reply_counter', [row]);
    out.push({ section, cites: [c(0, 'do')], text: `If they counter: ${row.do}` });
    const parts = [['accept_if', 'take it if'], ['counter_with', 'counter with'], ['walk_away_if', 'walk away if']]
      .filter(([key]) => row[key]);
    if (parts.length) {
      const text = parts.map(([key, lead]) => `${lead} ${row[key]}`).join('; ');
      out.push({ section, cites: parts.map(([key]) => c(0, key)), text: `${text.charAt(0).toUpperCase()}${text.slice(1)}.` });
    }
  }
  const quiet = val(table.silence);
  if (quiet?.do) {
    const row = { do: plain(entry, quiet.do), when: plain(entry, quiet.when), message: typeof quiet.message === 'string' ? quiet.message : null };
    const c = record(ledger, 'plan_reply_silence', [row]);
    out.push({ section, cites: [c(0, 'do'), ...(row.when ? [c(0, 'when')] : [])],
      text: `If they go quiet${row.when ? ` (${row.when})` : ''}: ${row.do}` });
    if (row.message) out.push({ section, cites: [c(0, 'message')], text: `Nudge to copy and send yourself: "${row.message}"` });
  }
  const walk = val(step.walk_away);
  if (walk?.text) {
    const c = record(ledger, 'plan_walk_away', [{ text: plain(entry, walk.text) }]);
    out.push({ section, cites: [c(0, 'text')], text: `Your walk-away: ${plain(entry, walk.text)}` });
  }
  if (out.length <= 1) {
    const r = record(ledger, 'plan_reply_table', [{ reason: 'the plan has no reply playbook for this step' }]);
    out.push({ section, cites: [r(0, 'reason')], text: 'The plan has no reply playbook for this offer yet.' });
  }
  return out;
}

/** "the other one": the move discussed before this one, in full. */
export function otherOneClaims(entry, ledger, focus = {}) {
  const move = moveById(entry, focus.prev_move_id);
  if (!move) {
    const r = record(ledger, 'plan_read', [{ reason: 'the move discussed before is no longer in the plan' }]);
    return { move: null, claims: [{ section: 'other_one', cites: [r(0, 'reason')], text: 'The move discussed before is no longer in the plan.' }] };
  }
  return { move, claims: servedMoveClaims(entry, ledger, 'other_one', move, 0) };
}

/** "what about <manager> instead": partner.js's answer for the new partner. */
export function partnerSwitchClaims(entry, ledger, roster, identities = []) {
  return partnerClaimsFor({ entry, roster, ledger, identities });
}

function noMove(entry, ledger, section) {
  const reason = entry?.next_move?.reason ?? 'the plans file has no move for this league.';
  const r = record(ledger, 'plan_read', [{ reason }]);
  return [{ section, cites: [r(0, 'reason')], text: `There is no move to talk about yet: ${reason}` }];
}

/* ------------------------------------------------------------------ chips */

export const CHIP = Object.freeze({
  why: 'Why this trade?', if_no: 'What if they say no?', other: 'Any other option?', safe: 'Is it safe to send?',
  next: "What's my next move and why?", work: 'Who should I work this week?', nothing: 'Why is nothing clearing?',
  other_one: 'Go back to the other one'
});

/** A partner chip names them the way resolvePartner reads it back: manager name, else "team N". */
function partnerChip(entry, roster) {
  const t = val(entry?.teams)?.[String(roster)] ?? {};
  const who = typeof t.manager === 'string' && t.manager.trim() ? t.manager.trim().split(/\s+/)[0] : `team ${roster}`;
  return `What about ${who} instead?`;
}

/** Another served partner to suggest, not the one in focus. */
function otherPartner(entry, focus) {
  const seen = new Set([String(focus.partner ?? ''), String(entry?.me ?? '')]);
  const moves = [...(ok(entry?.next_move) && entry.next_move.value?.steps?.length ? [entry.next_move.value] : []), ...(val(entry?.alternatives) ?? [])];
  for (const m of moves) for (const s of m.steps ?? []) if (!seen.has(String(s.partner))) return String(s.partner);
  return null;
}

/**
 * The 2-3 follow-up chips after an answer, from what was just answered and the
 * focus it left. Each is answerable at $0.
 */
export function followupsFor(intent, focus = {}, entry = null) {
  const hasMove = focus.move_id != null;
  const out = [];
  if (!hasMove) {
    if (focus.partner != null) out.push(CHIP.next, CHIP.work);
    else if (intent === 'why_nothing') out.push(CHIP.work, CHIP.next);
    else out.push(CHIP.next, CHIP.work, CHIP.nothing);
  } else if (intent === 'why') out.push(CHIP.if_no, CHIP.other, CHIP.safe);
  else if (intent === 'if_no') out.push(CHIP.why, CHIP.other, CHIP.safe);
  else if (intent === 'safe_to_send') out.push(CHIP.why, CHIP.if_no, CHIP.other);
  else out.push(CHIP.why, CHIP.if_no, CHIP.other);
  if (hasMove && focus.prev_move_id && intent !== 'other_one' && out.length > 2) out[2] = CHIP.other_one;
  const alt = entry ? otherPartner(entry, focus) : null;
  if (alt && hasMove && out.length > 2 && intent !== 'safe_to_send') out[2] = partnerChip(entry, alt);
  return [...new Set(out)].slice(0, 3);
}
