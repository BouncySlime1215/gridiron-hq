/**
 * COACH-V2 [4] RECONCILE: one answer from Claude's lane and Jev's, in Numbers & People's one
 * vocabulary.
 *
 *   verdict   numbers-people/lanes.js#verdictOf on (lane 1 stance + basis, Jev's stance + basis):
 *             AGREE, DIFFER, SAME_BUT, or NO_PEOPLE_READ. The same function the Trades tab uses.
 *   AGREE     no model call: lane 1's answer stands and the card shows both lanes agreeing.
 *   DIFFER /  one call (Sonnet; Opus when the lanes DIFFER on a trade question) writes one answer
 *   SAME_BUT  in the answer format from both lanes' lines as cells. It may recommend only what
 *             lane 1 cited from the served plan; Jev may change the ORDER and the PITCH, never
 *             the deal. On DIFFER it must name the disagreement in one sentence ("Numbers say X;
 *             Jev reads Y because Z."). It passes verify.js and the answer format, with one
 *             correction round; otherwise lane 1's answer stands with the disagreement said by a
 *             sentence built here from the two stances, so a DIFFER answer ALWAYS names it.
 *   Card      every answer with a lane 2 carries an NPItem (numbers-people view.js's shape), so the
 *             drawer shows it with the one NumbersPeopleCard (compact).
 */
import { callClaude, parseJson } from '../claude.js';
import { verifyAnswer } from './verify.js';
import { verdictOf, BASES } from '../numbers-people/lanes.js';
import { SHAPED_SCHEMA, toAnswer, shapeCheck, BASIS_KEYS } from './answer-shape.js';
import { BASIS_WORDS as JEV_BASIS_WORDS } from './jev-lane.js';

export const RECONCILE_MODELS = Object.freeze({ normal: 'claude-sonnet-5', trade_differ: 'claude-opus-5-5' });
const TRADE = /\b(trades?|offers?|deals?|packages?|swap|flip|send|accept|counter)\b/i;
const STANCE_WORDS = Object.freeze({ go: 'go', wait: 'wait', avoid: 'avoid' });
const BASIS_WORDS = Object.freeze({ title_gain: 'the title-odds gain', price: 'the price', willingness: 'whether he will deal',
  roster_fit: 'roster fit', risk: 'risk', timing: 'timing' });

/** Both lanes in the one vocabulary; the verdict. */
export function laneVerdict(shape, take) {
  const a = shape && shape.stance && shape.stance !== 'none' ? { stance: shape.stance, basis: shape.basis_key ?? null } : null;
  const b = take && take.stance ? { stance: take.stance, basis: take.basis ?? null } : null;
  if (!a) return { verdict: 'no_people_read', a, b, reason: 'lane 1 took no stance' };
  return { verdict: verdictOf(a, b), a, b };
}

/** The disagreement said without a model, from the two stances (the fallback, and the SAME_BUT line). */
export function disagreementLine(verdict, a, b) {
  if (verdict === 'differ') {
    return `Numbers say ${STANCE_WORDS[a.stance]}; Jev reads ${STANCE_WORDS[b.stance]} because of ${JEV_BASIS_WORDS[b.basis] ?? BASIS_WORDS[b.basis] ?? 'his read'} (chat read, ungraded).`;
  }
  if (verdict === 'same_but') {
    return `Same call, different reasons: the numbers rest on ${BASIS_WORDS[a.basis] ?? 'the plan'}, Jev on ${JEV_BASIS_WORDS[b.basis] ?? BASIS_WORDS[b.basis] ?? 'his read'}.`;
  }
  return null;
}

const RECONCILE_SCHEMA = Object.freeze({
  ...SHAPED_SCHEMA,
  required: [...SHAPED_SCHEMA.required, 'disagreement'],
  properties: { ...SHAPED_SCHEMA.properties, disagreement: { anyOf: [{ type: 'string' }, { type: 'null' }] } }
});

const RECONCILE_SYSTEM = `You write Coach's one answer to Nick from two lanes that read the same question.

CLAUDE (numbers): grounded in the plan and the app's data; its lines carry cites.
JEV (people): a people and chat evaluator reading Claude's lane and stored chat signals; its lines are ungraded chat reads.

The deal comes from the numbers: recommend only a move or player the numbers lane cited, never a trade of your own, never anything sent for Nick. Jev may change the ORDER (what to do first) and the PITCH (how to ask), not the deal. A line resting on Jev says it is a chat read.

Every line keeps the cites of the lane lines it comes from, copied exactly. Never write a number that is not in the lines you were given.

"disagreement": when the lanes DIFFER, one sentence: "Numbers say X; Jev reads Y because Z." When they give the same call for different reasons, one sentence saying so. Otherwise null.

Reply with ONLY the JSON object in the answer format: verdict, stance, basis, basis_key, why, risks, refusals, as_of, disagreement.`;

/** One lane line as the model sees it. */
const linesOf = (lane, claims, map = x => x) => claims.map(c => ({ lane, text: c.text, cites: c.cites.map(map) }));

function promptFor({ question, verdict, a, b, laneOne, jevClaims, remap }) {
  const given = [...linesOf('numbers', laneOne.claims ?? []), ...linesOf('jev', jevClaims, remap)];
  return `QUESTION: ${question}\n\nVERDICT (deterministic): ${verdict.toUpperCase()}. Claude: ${a.stance} on ${a.basis ?? 'unstated'}. Jev: ${b.stance} on ${b.basis ?? 'unstated'}.\n\n`
    + `CLAUDE'S VERDICT LINE: ${laneOne.shape?.verdict?.text ?? '(none)'}\n\nLANE LINES:\n${JSON.stringify(given)}`;
}

/**
 * Reconcile. `laneOne` is lane 1's shaped answer; `take` Jev's take; `jevClaims` Jev's rendered
 * lines (cites in lane 2's ledger, `remap` moves them into the merged `ledger`).
 * -> { answer, verdict, disagreement, reconciled: 'deterministic' | 'model' | 'fell_back', cost_usd, attempts }
 */
export async function reconcile({ question, laneOne, take, jevClaims = [], ledger, remap = x => x, call = callClaude }) {
  const v = laneVerdict(laneOne.shape, take);
  if (v.verdict === 'agree' || v.verdict === 'no_people_read' || !v.b) {
    return { answer: laneOne, verdict: v.verdict, disagreement: null, reconciled: 'deterministic', cost_usd: 0, attempts: 0 };
  }
  const model = v.verdict === 'differ' && TRADE.test(question) ? RECONCILE_MODELS.trade_differ : RECONCILE_MODELS.normal;
  const messages = [{ role: 'user', content: promptFor({ question, verdict: v.verdict, a: v.a, b: v.b, laneOne, jevClaims, remap }) }];
  const allCites = [...new Set([...(laneOne.claims ?? []).flatMap(c => c.cites), ...jevClaims.flatMap(c => c.cites.map(remap))])];
  let cost = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const msg = await call({ feature: 'coach:reconcile', model, maxTokens: 4000, system: RECONCILE_SYSTEM, messages, outputSchema: RECONCILE_SCHEMA });
    cost += msg.cost_usd ?? 0;
    let parsed;
    try { parsed = parseJson(msg); } catch (e) {
      if (attempt === 2) break;
      messages.push({ role: 'assistant', content: msg.content }, { role: 'user', content: `That was not the JSON object (${e.message}). Reply with only the object.` });
      continue;
    }
    const answer = toAnswer(parsed);
    const said = typeof parsed.disagreement === 'string' && parsed.disagreement.trim() ? parsed.disagreement.trim() : null;
    const problems = [];
    const check = verifyAnswer({ answer: { ...answer, claims: [...answer.claims, ...(said ? [{ text: said, cites: allCites }] : [])] }, ledger, question });
    if (!check.ok) problems.push(...check.violations.map(x => `${x.kind}: ${x.detail ?? x.number ?? ''}`));
    if (v.verdict === 'differ' && !(said && /numbers say/i.test(said) && /jev reads/i.test(said))) {
      problems.push('the lanes DIFFER: "disagreement" must be one sentence of the form "Numbers say X; Jev reads Y because Z."');
    }
    const shape = shapeCheck(answer).filter(x => x.block === 'verdict');
    problems.push(...shape.map(x => x.detail));
    if (!problems.length) {
      return { answer, verdict: v.verdict, disagreement: said, reconciled: 'model', cost_usd: cost, attempts: attempt };
    }
    if (attempt === 2) break;
    messages.push({ role: 'assistant', content: msg.content },
      { role: 'user', content: `The answer was not shown:\n${problems.map(p => `- ${p}`).join('\n')}\nFix only that; keep every cite exactly. Reply with only the JSON object.` });
  }
  // Fallback: lane 1 stands; the disagreement is said from the two stances, never dropped.
  return { answer: laneOne, verdict: v.verdict, disagreement: disagreementLine(v.verdict, v.a, v.b), reconciled: 'fell_back', cost_usd: cost, attempts: 2 };
}

/** The card for this answer, in numbers-people view.js's NPItem shape (the one NumbersPeopleCard renders). */
export function cardFor({ focus = {}, laneOne, take, jevClaims = [], verdict, title = 'This answer' }) {
  const shape = laneOne?.shape;
  const firstWhy = shape?.why?.[0]?.text ?? shape?.verdict?.text ?? null;
  const itemType = focus.move_id != null ? 'move' : focus.partner != null ? 'partner' : 'move';
  const itemId = String(focus.move_id ?? focus.partner ?? 'turn');
  return {
    key: `${itemType}:${itemId}`, item_type: itemType, item_id: itemId, title, subtitle: null, partner: focus.partner ?? null, players: [],
    numbers: shape?.stance && shape.stance !== 'none' ? { stance: shape.stance, basis: shape.basis_key ?? undefined, why: firstWhy, cites: [] }
      : { skipped: 'no stance this turn' },
    people: take?.stance ? { stance: take.stance, basis: take.basis, why: jevClaims[0]?.text ?? null, label: 'chat read (ungraded)', cites: [] }
      : { skipped: 'no chat read this turn' },
    verdict, read_at: null, history: []
  };
}

/** Pinned by the tests: the answer format's basis keys are Numbers & People's. */
export const SAME_VOCABULARY = BASES.length === BASIS_KEYS.length && BASES.every(b => BASIS_KEYS.includes(b));
