/**
 * COACH-V2 [5] RULES-CHECK: every trade a Coach answer or action card puts in
 * front of Nick, checked against Nick's rules in code, after verify.js.
 *
 * A suggestion is { give, get, partner, move_id, step, kind } from Nick's side.
 * It is dropped, and the drop logged with its rule, when:
 *
 *   not_served        its give / get / partner are not a step of a move the planner
 *                     served (next move, alternatives, flip legs): Coach never builds a
 *                     trade of its own
 *   never_give        Nick gives a pinned player (Nico Collins 160, Chase Brown 80) or one
 *                     of his objectives' untouchables
 *   aj_needs_ok       A.J. Brown (277) is in the give and the card is not a Needs-your-OK
 *                     card for an approved pick (83+): he never shows as a plain offer
 *   never_get         Nick gets a pinned never-get player (Chris Olave 290)
 *   sold_this_season  Nick gets back a player he sold this season
 *   below_blue_chip   a get scores under the 83 floor on the served board
 *   unscored          a get the board does not score (fails closed)
 *   no_fc_value       a side has no FantasyCalc value (the overpay rule fails closed)
 *   overpay           Nick gives more value than he gets: cap 0, or +12% on a depth-only
 *                     2-for-1 whose lineup points and title odds both rise
 *   loses_to_nothing  the step does not beat doing nothing (title-odds change <= 0)
 *   rules_unreadable  a rule source could not be read (everything fails closed)
 *
 * The value, board and ledger rules are never-give.js#ruleVerdict's (the ONE rule
 * gate); this adds what only Coach needs: served-only, the 277 card kind and the
 * doing-nothing floor. Nothing here loosens a rule.
 */
import { ruleVerdict, ruleGate } from '../campaign/never-give.js';
import { BLUE_CHIP_SCORE } from '../campaign/search.js';
import { db, row, rows } from '../../db/index.js';

export const COACH_RULES = Object.freeze(['not_served', 'never_give', 'aj_needs_ok', 'never_get', 'sold_this_season',
  'below_blue_chip', 'unscored', 'no_fc_value', 'overpay', 'loses_to_nothing', 'rules_unreadable']);
const AJ = '277';
const S = x => String(x);
const ok = f => f?.status === 'ok';
const same = (a, b) => a.length === b.length && [...a].map(S).sort().join(',') === [...b].map(S).sort().join(',');

/** Every step the planner served for this league: next move, alternatives and flip legs, with their title-odds change. */
export function servedSteps(entry) {
  const out = [];
  const moves = [...(ok(entry?.next_move) && entry.next_move.value ? [entry.next_move.value] : []), ...(ok(entry?.alternatives) ? entry.alternatives.value ?? [] : [])];
  for (const m of moves) {
    (m.steps ?? []).forEach((s, k) => {
      // CAP-1C: a depth-only 2-for-1 the planner allowed at up to +12% carries its lineup and title gains.
      const dp = ok(s.depth_premium) ? s.depth_premium.value : null;
      out.push({ move_id: S(m.move_id), step: k, partner: S(s.partner), give: (s.give ?? []).map(S), get: (s.get ?? []).map(S),
        delta: ok(s.title_odds_delta) ? s.title_odds_delta.value : null,
        premium: dp ? { points_delta: dp.lineup_points_delta, title_delta: dp.title_odds_delta } : null });
    });
  }
  for (const f of ok(entry?.flip_map) ? entry.flip_map.value ?? [] : []) {
    const legs = f?.legs ?? {};
    const after = ok(legs.nick_after) ? legs.nick_after.value : null;
    const ids = (key, lead) => (Array.isArray(legs[`${key}_ids`]) ? legs[`${key}_ids`].filter(x => x != null).map(S) : [S(legs[lead])]);
    out.push({ move_id: `flip:${f.player}:${f.buy_from}`, step: 0, partner: S(f.buy_from), give: ids('give_a', 'give_a'), get: [S(f.player)], delta: after });
    out.push({ move_id: `flip:${f.player}:${f.sell_to}`, step: 1, partner: S(f.sell_to), give: [S(f.player)], get: ids('get_b', 'get_b'), delta: after });
  }
  return out;
}

/**
 * One suggestion against the rules. `rules` is never-give.js's rule set (ruleGate(...).rules),
 * `served` the served steps. -> { ok, reasons }
 */
export function checkSuggestion(s, { rules, served }) {
  const give = (s.give ?? []).map(S);
  const get = (s.get ?? []).map(S);
  const reasons = new Set();
  const step = served.find(x => same(x.give, give) && same(x.get, get) && (s.partner == null || x.partner === S(s.partner))
    && (s.move_id == null || x.move_id === S(s.move_id)));
  if (!step) reasons.add('not_served');
  const v = ruleVerdict(rules, { give, get, premium: s.premium ?? null });
  for (const r of v.reasons) {
    // 277 is never_give to ruleVerdict unless a consistency reader clears the return; Coach may show him only
    // as a Needs-your-OK card, for gets that are all on the 83 floor.
    if (r === 'never_give' && give.includes(AJ) && give.filter(id => rules.neverGive.has(id) && id !== AJ).length === 0) continue;
    reasons.add(r);
  }
  if (give.includes(AJ)) {
    const approvedPick = get.length > 0 && get.every(id => (rules.scoreOf(id) ?? -Infinity) >= BLUE_CHIP_SCORE);
    if (s.kind !== 'needs_ok' || !approvedPick) reasons.add('aj_needs_ok');
  }
  if (step && !(Number(step.delta) > 0)) reasons.add('loses_to_nothing');
  return { ok: reasons.size === 0, reasons: [...reasons] };
}

/** The move a claim is about: the move_id (and step) on a row one of its cites points into. */
function moveOfClaim(claim, ledger) {
  for (const cite of claim.cites ?? []) {
    const m = /^(r\d+)#(\d+)\./.exec(cite);
    if (!m) continue;
    const q = (ledger?.queries ?? []).find(x => x.id === m[1]);
    const r = q?.rows?.[Number(m[2])];
    // brief-claims.js#moveClaims rows carry step (1-based) and steps; other rows name the move only (its first step).
    if (r?.move_id != null) return { move_id: S(r.move_id), step: Number.isInteger(r.step) && Number.isInteger(r.steps) ? r.step - 1 : 0 };
  }
  return null;
}

/**
 * Hold an answer and its action cards to the rules. A claim about a move whose step
 * breaks a rule is dropped; so is a card. Every drop is returned with its rule
 * (logged into the turn's plan as `rule_drop` events by the caller).
 * -> { answer, proposals, drops: [{ where, rule(s), move_id, give, get }] }
 */
export function holdToRules({ answer, proposals = [], ledger, entry, rules }) {
  const served = servedSteps(entry);
  const byMove = new Map(served.map(x => [`${x.move_id}:${x.step}`, x]));
  const drops = [];
  const verdictFor = (moveId, stepIx, kind = null) => {
    const st = byMove.get(`${moveId}:${stepIx ?? 0}`) ?? served.find(x => x.move_id === S(moveId));
    if (!st) return { ok: false, reasons: ['not_served'], step: null };
    return { ...checkSuggestion({ give: st.give, get: st.get, partner: st.partner, move_id: st.move_id, kind, premium: st.premium ?? null }, { rules, served }), step: st };
  };
  const claims = [];
  for (const c of answer?.claims ?? []) {
    const mv = moveOfClaim(c, ledger);
    if (!mv) { claims.push(c); continue; }
    const v = verdictFor(mv.move_id, mv.step);
    if (v.ok) claims.push(c);
    else drops.push({ where: 'claim', rules: v.reasons, move_id: mv.move_id, give: v.step?.give ?? null, get: v.step?.get ?? null });
  }
  const kept = [];
  for (const p of proposals) {
    const v = verdictFor(p.payload?.move_id, p.payload?.step_index ?? 0, p.kind === 'needs_ok' ? 'needs_ok' : null);
    if (v.ok) kept.push(p);
    else drops.push({ where: `card:${p.kind}`, rules: v.reasons, move_id: p.payload?.move_id ?? null, give: v.step?.give ?? null, get: v.step?.get ?? null });
  }
  const out = { ...answer, claims };
  if (answer?.claims?.length && !claims.length) {
    out.refusals = [...(answer.refusals ?? []), 'Coach dropped every line about this move: it breaks one of your trade rules.'];
  }
  return { answer: out, proposals: kept, drops };
}

/** The rules for one league, from the one gate (never-give.js#ruleGate). Null when the league has no Nick team. */
function gateRules(leagueId) {
  const gate = ruleGate({ row, rows, db }, { leagueId });
  return gate.applies ? gate.rules : null;
}
let source = gateRules;
export const coachRules = leagueId => source(leagueId);
/** Tests: swap the rule source (a fixed rule set, or () => null for a test that is not about rules); null restores the gate. */
export function setCoachRulesSource(fn) { source = fn ?? gateRules; }
