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
import { answerClaimsFor, alternativeClaims, deckMoves } from './brief-claims.js';
import { resolvePartner, partnerShaped, partnerClaimsFor } from './partner.js';
import { identityRows } from '../manager-identity.js';
import { checkClaim, readPlansFile, leagueEntry, coachBriefFlag, BRIEF_PREVIEW_REASON, TARGET_LEAGUE } from './brief.js';
import { previewFields } from '../preview-mode.js';
import { warRoomPlansPath } from '../warroom-flag.js';

export const STARTER_INTENTS = Object.freeze(['next_move', 'why_nothing', 'all_in', 'message_first', 'next_alternative']);

/** What Coach can answer with no model key, in the dock's words. */
export const STARTER_QUESTIONS = Object.freeze([
  "What's my next move and why?", 'Why is nothing clearing?', 'Show me the all-in plan', 'Who should I message first?'
]);

const INTENT_RULES = [
  // COACH-PARTNER: "i don't like that, what else u got", "next one", "something else".
  ['next_alternative', [
    /\bwhat else\b/, /\bsomething else\b/, /\banything else\b/, /^(next|another)( one| option| idea| trade)?$/,
    /\bnext (one|option|idea|alternative|card)\b/, /\b(another|other|different) (one|option|idea|trade|move|deal)s?\b/,
    /\b(don'?t|do not) like (that|it|this)( one)?\b/, /\bgot anything else\b/, /\bshow me another\b/
  ]],
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
  next_alternative: [['warroom_view', { type: 'next' }]],
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
  if (intent === 'next_alternative') return alternativeAnswer({ question, leagueId, plansPath });
  if (intent === 'next_move') await noteNextMoveShown({ leagueId, plansPath });
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

/* ------------------------------------------------ COACH-PARTNER answers */

/**
 * Which deck card Coach last answered, per league and plans run. The client
 * keeps its own deck index and moves it on the 'next' action Coach returns
 * with each "what else"; this cursor follows the same steps (it starts on
 * card 1, like the client). A new plans run starts over.
 */
const deckAt = new Map();
const cursorKey = (league, file) => `${league}|${file?.generated_at ?? ''}`;
function cursor(league, file) { return deckAt.get(cursorKey(league, file)) ?? 0; }
function setCursor(league, file, index) {
  for (const k of deckAt.keys()) if (k.startsWith(`${league}|`)) deckAt.delete(k);
  deckAt.set(cursorKey(league, file), index);
}

/** The deck card a served move sits on, or null. */
const cardOf = (entry, moveId) => {
  const i = deckMoves(entry).findIndex(m => String(m.move_id) === String(moveId));
  return i < 0 ? null : i;
};

async function planEntry({ leagueId, plansPath }) {
  let file;
  try { file = await readPlansFile(plansPath); } catch (e) {
    return { refusal: `The plans file could not be read (${e.name ?? 'error'}), so there is no plan to answer from.` };
  }
  if (!file || !Array.isArray(file.leagues)) return { refusal: 'No plans file has been written yet, so there is no plan to answer from.' };
  const league = leagueId ?? TARGET_LEAGUE;
  const entry = leagueEntry(file, league);
  if (!entry) return { refusal: `League ${league} is not in the plans file.` };
  return { file, entry, league };
}

function identitiesFor(league) {
  try { return identityRows(league); } catch { return []; }
}

function shipped({ draft, ledger, file, question, intent, extra = {}, preview = {} }) {
  const { claims, dropped, numbers_checked } = groundStarter(draft, ledger);
  const refusals = claims.length ? [] : ['Coach could not ground any line of this answer in the plan, so it is not showing one.'];
  return { answer: { claims, refusals, as_of: file.generated_at ? `plans file of ${file.generated_at}` : 'plans file' },
    ledger: ledger.toJson(), dropped,
    verification: { ok: true, violations: [], warnings: [], numbers_checked, deterministic: true, intent, dropped: dropped.length, question },
    ...extra, ...preview };
}

/**
 * COACH-PARTNER: a trade idea aimed at one league-mate. Null when the question
 * is not shaped like one or names nobody in the league, so the caller answers
 * it the ordinary way; a name that fits two managers equally is a refusal
 * that asks which one.
 */
export async function partnerAnswer({ question, leagueId = null, plansPath = warRoomPlansPath(), identities = null }) {
  if (!partnerShaped(question)) return null;
  const read = await planEntry({ leagueId, plansPath });
  if (read.refusal) return null;
  const { file, entry, league } = read;
  const ids = identities ?? identitiesFor(league);
  const who = resolvePartner(question, { entry, identities: ids });
  if (!who) return null;
  const flag = coachBriefFlag();
  const preview = flag.preview ? previewFields(BRIEF_PREVIEW_REASON) : {};
  const ledger = newLedger();
  if (!who.roster) {
    return { answer: { claims: [], refusals: [`More than one manager fits that name (${who.ambiguous.join(', ')}); say which one.`], as_of: null },
      ledger: ledger.toJson(), dropped: [], actions: [],
      verification: { ok: true, violations: [], warnings: [], numbers_checked: 0, deterministic: true, intent: 'partner', question }, ...preview };
  }
  const out = partnerClaimsFor({ entry, roster: who.roster, ledger, identities: ids });
  const card = out.move_id ? cardOf(entry, out.move_id) : null;
  if (card != null) setCursor(league, file, card);
  const actions = out.source === 'flip_leg' ? [['warroom_view', { type: 'focus_panel', panel: 'flip_map' }]]
    : [['warroom_view', { type: 'focus_panel', panel: 'next_move' }]];
  return shipped({ draft: out.claims, ledger, file, question, intent: 'partner', preview,
    extra: { actions, partner: { roster: who.roster, source: out.source } } });
}

/** COACH-PARTNER: "what else u got": the next card in the deck, in full, and the deck move that shows it. */
export async function alternativeAnswer({ question, leagueId = null, plansPath = warRoomPlansPath(), deckIndex = null }) {
  const read = await planEntry({ leagueId, plansPath });
  const flag = coachBriefFlag();
  const preview = flag.preview ? previewFields(BRIEF_PREVIEW_REASON) : {};
  if (read.refusal) {
    return { answer: { claims: [], refusals: [read.refusal], as_of: null }, ledger: newLedger().toJson(), dropped: [], actions: [],
      verification: { ok: true, violations: [], warnings: [], numbers_checked: 0, deterministic: true, question }, ...preview };
  }
  const { file, entry, league } = read;
  const at = Number.isInteger(deckIndex) && deckIndex >= 0 ? deckIndex : cursor(league, file);
  const next = at + 1;
  const deck = deckMoves(entry);
  const ledger = newLedger();
  const draft = alternativeClaims(entry, ledger, next);
  const moved = next < deck.length;
  if (moved) setCursor(league, file, next);
  return shipped({ draft, ledger, file, question, intent: 'next_alternative', preview,
    extra: { actions: moved ? ACTIONS.next_alternative : [] } });
}

/** The next-move answer puts the deck back on the card it shows. */
export async function noteNextMoveShown({ leagueId = null, plansPath = warRoomPlansPath() }) {
  const read = await planEntry({ leagueId, plansPath });
  if (read.refusal) return;
  const nm = read.entry.next_move;
  const card = nm?.status === 'ok' ? cardOf(read.entry, nm.value?.move_id) : null;
  setCursor(read.league, read.file, card ?? 0);
}
