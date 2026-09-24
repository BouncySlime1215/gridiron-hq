/**
 * COACH-ANSWERS: Coach answers the War Room dock's four starter prompts
 * (CoachDock.tsx STARTER_PROMPTS) with no model call.
 *
 *   next_move      "What's my next move and why?"   partner, give, get, step k of n,
 *                                                    title-odds change, chance he says yes
 *                                                    (with its guess label), why, send-when
 *   why_nothing    "Why is nothing clearing?"        the producer's next_move reason and the
 *                                                    nearest miss (or, when a move clears,
 *                                                    that move and the runner-up)
 *   all_in         "Show me the all-in plan"         risk_modes all_in: first step, expected,
 *                                                    if complete, chance to complete
 *   message_first  "Who should I message first?"     the planner's partners, reachable only,
 *                                                    active pool first
 *
 * Close paraphrases match too (starterIntent). Every sentence is built by
 * brief-claims.js from the War Room plans file (warroom-plans/1), cites the
 * plan cells it stands on, and is grounded by brief.js#checkClaim (verify.js)
 * before it ships; a claim that fails is dropped and reported, never softened.
 *
 * When it runs (ask.js): the Coach brief flag is on (GRIDIRON_COACH_BRIEF_ENABLED=1,
 * or preview mode; =0 vetoes) AND either the question is one of these intents
 * or no model key is configured. Cost: $0, always.
 */
import { newLedger } from './ledger.js';
import { answerClaimsFor } from './brief-claims.js';
import { checkClaim, readPlansFile, leagueEntry, coachBriefFlag, BRIEF_PREVIEW_REASON, TARGET_LEAGUE } from './brief.js';
import { previewFields } from '../preview-mode.js';
import { warRoomPlansPath } from '../warroom-flag.js';

export const STARTER_INTENTS = Object.freeze(['next_move', 'why_nothing', 'all_in', 'message_first']);

/** What Coach can answer with no model key, in the dock's words. */
export const STARTER_QUESTIONS = Object.freeze([
  "What's my next move and why?", 'Why is nothing clearing?', 'Show me the all-in plan', 'Who should I message first?'
]);

const INTENT_RULES = [
  ['all_in', [/\ball[- ]?in\b/, /\bfuck it\b/, /\bgo(ing)? for broke\b/, /\baggressive (plan|mode|route|path)\b/, /\b(max(imum)?|most) risk\b/]],
  ['message_first', [
    /\b(message|contact|reach out|text|dm|talk to|ping|approach|hit up|trade with)\b.*\bfirst\b/,
    /\bwho\b.*\b(should|do|can) i\b.*\b(message|contact|reach out|text|dm|talk to|ping|approach|hit up|trade with)\b/,
    /\b(which|what) (manager|team|partner|owner)s?\b.*\b(message|contact|reach out|talk to|approach|trade with)\b/
  ]],
  ['why_nothing', [
    /\b(nothing|no (trade|move|deal|offer)s?|none( of them)?)\b.*\b(clear|clears|clearing|work|works|pass|passes|qualif\w*)\b/,
    /\bwhy\b.*(\bnot\b|n't\b|\bno\b|\bnothing\b|\bnone\b).*\b(clear|clears|clearing)\b/
  ]],
  ['next_move', [
    /\bnext (move|step|trade)\b/,
    /\bwhat (should|do|can) i do\b/,
    /\bbest (trade|move|offer|deal)\b/,
    /\bwhat('?s| is) the (move|play)\b/
  ]]
];

/** The starter intent a question asks, or null. Case and punctuation do not matter. */
export function starterIntent(question) {
  const t = String(question ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 200) return null;
  for (const [intent, rules] of INTENT_RULES) if (rules.some(rx => rx.test(t))) return intent;
  return null;
}

/** Draft claims for one intent (exported for the mutation test). */
export function starterClaims(intent, { entry, ledger }) {
  return answerClaimsFor(intent, { entry, ledger });
}

/** Ground every draft claim; what fails is dropped with its violations. */
export function groundStarter(draft, ledger) {
  const claims = [];
  const dropped = [];
  let numbers = 0;
  for (const c of draft) {
    const v = checkClaim(c, ledger);
    numbers += v.numbers_checked ?? 0;
    if (v.ok) claims.push({ text: c.text, cites: c.cites });
    else dropped.push({ text: c.text, violations: v.violations.map(x => x.detail) });
  }
  return { claims, dropped, numbers_checked: numbers };
}

/**
 * Screen actions that go with each intent on the War Room, so the dock keeps
 * doing what it did when the model answered (focus the panel, plug in title odds).
 */
const ACTIONS = {
  next_move: [['warroom_view', { type: 'focus_panel', panel: 'next_move' }],
    ['warroom_plug_in', { type: 'plug_in', field: 'destination.title_now', view: 'number' }]],
  why_nothing: [['warroom_view', { type: 'explain', panel: 'next_move' }]],
  all_in: [['warroom_view', { type: 'focus_panel', panel: 'destination' }]],
  message_first: [['warroom_view', { type: 'focus_panel', panel: 'next_move' }]]
};
export const starterActions = intent => ACTIONS[intent] ?? [];

/**
 * The answer for one starter intent, or, with intent null (no model key and a
 * question outside the four), a refusal that says what Coach can answer.
 *
 * @returns {Promise<{answer, ledger, verification, dropped, preview?, preview_reason?}>}
 */
export async function starterAnswer({ question, intent, leagueId = null, plansPath = warRoomPlansPath() }) {
  const flag = coachBriefFlag();
  const ledger = newLedger();
  const preview = flag.preview ? previewFields(BRIEF_PREVIEW_REASON) : {};
  const refuse = text => ({ answer: { claims: [], refusals: [text], as_of: null }, ledger: ledger.toJson(), dropped: [],
    verification: { ok: true, violations: [], warnings: [], numbers_checked: 0, deterministic: true, question }, ...preview });
  if (!intent) {
    return refuse('Coach has no model key here, so it answers only from the plan: ' +
      `${STARTER_QUESTIONS.map(q => `"${q}"`).join(', ')}. Add a key in the Dev Hub for anything else.`);
  }
  let file;
  try { file = await readPlansFile(plansPath); } catch (e) {
    return refuse(`The plans file could not be read (${e.name ?? 'error'}), so there is no plan to answer from.`);
  }
  if (!file || !Array.isArray(file.leagues)) return refuse('No plans file has been written yet, so there is no plan to answer from.');
  const league = leagueId ?? TARGET_LEAGUE;
  const entry = leagueEntry(file, league);
  if (!entry) return refuse(`League ${league} is not in the plans file.`);
  const { claims, dropped, numbers_checked } = groundStarter(starterClaims(intent, { entry, ledger }), ledger);
  const asOf = file.generated_at ? `plans file of ${file.generated_at}` : 'plans file';
  const refusals = claims.length ? [] : ['Coach could not ground any line of this answer in the plan, so it is not showing one.'];
  return { answer: { claims, refusals, as_of: asOf }, ledger: ledger.toJson(), dropped,
    verification: { ok: true, violations: [], warnings: [], numbers_checked, deterministic: true, intent, dropped: dropped.length, question },
    ...preview };
}
