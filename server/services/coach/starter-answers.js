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
import { resolvePartner, partnerShaped, requestsIdea, partnerClaimsFor } from './partner.js';
import { identityRows } from '../manager-identity.js';
import { checkClaim, readPlansFile, leagueEntry, coachBriefFlag, BRIEF_PREVIEW_REASON, TARGET_LEAGUE } from './brief.js';
import { previewFields } from '../preview-mode.js';
import { warRoomPlansPath } from '../warroom-flag.js';
import { safeToSend, broken, saidLately } from './preset-claims.js';
import { readStatements } from './brief-inputs.js';
import { db } from '../../db/index.js';
import { outOfDateReason } from '../campaign/plan-age.js';

export const STARTER_INTENTS = Object.freeze(['next_move', 'why_nothing', 'all_in', 'message_first', 'next_alternative',
  'safe_to_send', 'said_lately', 'broken']);

/** What Coach can answer with no model key, in the dock's and the drawer's words. */
export const STARTER_QUESTIONS = Object.freeze([
  "What's my next move and why?", 'Is it safe to send?', 'Why is nothing clearing?', 'Who should I work this week?',
  'What did league-mates say lately?', "What's broken right now?", 'Show me the all-in plan'
]);

/** How far back "lately" reaches for league-mates' statements: the pulse's own two-week window (brain-tools pulse_read). */
export const SAID_LATELY_DAYS = 14;

const INTENT_RULES = [
  // COACH-PARTNER: "i don't like that, what else u got", "next one", "something else".
  ['next_alternative', [
    /\bwhat else\b/, /\bsomething else\b/, /\banything else\b/, /^(next|another)( one| option| idea| trade)?$/,
    /\bnext (one|option|idea|alternative|card)\b/, /\b(another|other|different) (one|option|idea|trade|move|deal)s?\b/,
    /\b(don'?t|do not) like (that|it|this)( one)?\b/, /\bgot anything else\b/, /\bshow me another\b/
  ]],
  // COACH-PRESETS (#390): the War Room drawer's fixed questions (CoachDrawer.tsx FIXED_QUESTIONS).
  ['safe_to_send', [/\b(is it|is this|is that|it'?s) (safe|ok|okay|smart) to send\b/, /\bsafe to (send|offer)\b/, /\bshould i (send|offer) (it|this|that)\b/]],
  ['said_lately', [
    /\bwhat (did|have|has)\b.*\b(league[- ]?mates|managers|people|guys|everyone|the league|the chat)\b.*\b(say|said|saying|talk\w*)\b/,
    /\b(league[- ]?mates|managers|the chat)\b.*\b(say|said|saying|talk\w*)\b.*\b(lately|recently|this week|today)\b/
  ]],
  ['broken', [/\bwhat'?s broken\b/, /\bwhat is broken\b/, /\banything broken\b/, /\bis (the brain|it|anything) (working|broken)\b/]],
  ['all_in', [/\ball[- ]?in\b/, /\bfuck it\b/, /\bgo(ing)? for broke\b/, /\baggressive (plan|mode|route|path)\b/, /\b(max(imum)?|most) risk\b/]],
  ['message_first', [
    /\b(message|contact|reach out|text|dm|talk to|ping|approach|hit up|trade with)\b.*\bfirst\b/,
    /\bwho\b.*\b(should|do|can) i\b.*\b(message|contact|reach out|text|dm|talk to|ping|approach|hit up|trade with|work)\b/,
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

/** Draft claims for one intent (exported for the mutation test). `said` is the statements read for said_lately. */
export function starterClaims(intent, { entry, ledger, said = null }) {
  if (intent === 'safe_to_send') return safeToSend(entry, ledger);
  if (intent === 'broken') return broken(entry, ledger);
  if (intent === 'said_lately') return saidLately(said ?? readSaidLately(entry.league), ledger);
  return answerClaimsFor(intent, { entry, ledger });
}

/** League-mates' labelled statements over the last SAID_LATELY_DAYS, from PULSE-01's reader. */
export function readSaidLately(leagueId, { database = db, now = new Date() } = {}) {
  const until = now.toISOString();
  const since = new Date(now.getTime() - SAID_LATELY_DAYS * 864e5).toISOString();
  return readStatements(database, { leagueId, since, until });
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
  message_first: [['warroom_view', { type: 'focus_panel', panel: 'next_move' }]],
  safe_to_send: [['warroom_view', { type: 'focus_panel', panel: 'next_move' }]],
  broken: [['warroom_view', { type: 'focus_panel', panel: 'brain_check' }]],
  said_lately: []
};
export const starterActions = intent => ACTIONS[intent] ?? [];

/**
 * The answer for one starter intent, or, with intent null (no model key and a
 * question outside the four), a refusal that says what Coach can answer.
 *
 * @returns {Promise<{answer, ledger, verification, dropped, preview?, preview_reason?}>}
 */
export async function starterAnswer({ question, intent, leagueId = null, plansPath = warRoomPlansPath(), context = null,
  noModelRefusal = null }) {
  const flag = coachBriefFlag();
  const ledger = newLedger();
  const preview = flag.preview ? previewFields(BRIEF_PREVIEW_REASON) : {};
  const refuse = text => ({ answer: { claims: [], refusals: [text], as_of: null }, ledger: ledger.toJson(), dropped: [],
    verification: { ok: true, violations: [], warnings: [], numbers_checked: 0, deterministic: true, question }, ...preview });
  if (intent === 'next_alternative') {
    return alternativeAnswer({ question, leagueId, plansPath, deckIndex: context?.deck_index, moveId: context?.move_id });
  }
  if (!intent) {
    if (noModelRefusal) return refuse(noModelRefusal);
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
  const stale = outOfDateReason(entry, file.leagues);
  if (stale) return refuse(stale);
  const { claims, dropped, numbers_checked } = groundStarter(starterClaims(intent, { entry, ledger }), ledger);
  const asOf = file.generated_at ? `plans file of ${file.generated_at}` : 'plans file';
  const refusals = claims.length ? [] : ['Coach could not ground any line of this answer in the plan, so it is not showing one.'];
  return { answer: { claims, refusals, as_of: asOf }, ledger: ledger.toJson(), dropped,
    verification: { ok: true, violations: [], warnings: [], numbers_checked, deterministic: true, intent, dropped: dropped.length, question },
    ...preview };
}

/* ------------------------------------------------ COACH-PARTNER answers */

/** The deck card a served move sits on, or null. */
const cardOf = (entry, moveId) => {
  const i = deckMoves(entry).findIndex(m => String(m.move_id) === String(moveId));
  return i < 0 ? null : i;
};

export async function planEntry({ leagueId, plansPath = warRoomPlansPath() }) {
  let file;
  try { file = await readPlansFile(plansPath); } catch (e) {
    console.warn(`[coach] plans file ${plansPath} could not be read: ${e?.message ?? e}`);
    return { refusal: `The plans file could not be read (${e.name ?? 'error'}), so there is no plan to answer from.` };
  }
  if (!file || !Array.isArray(file.leagues)) return { refusal: 'No plans file has been written yet, so there is no plan to answer from.' };
  const league = leagueId ?? TARGET_LEAGUE;
  const entry = leagueEntry(file, league);
  if (!entry) return { refusal: `League ${league} is not in the plans file.` };
  // PLANS-EXPIRE (integration-10a): the War Room hides an out-of-date plan, so Coach does not answer from it.
  const stale = outOfDateReason(entry, file.leagues);
  if (stale) return { refusal: stale };
  return { file, entry, league };
}

export function identitiesFor(league) {
  try { return identityRows(league); } catch (e) {
    console.warn(`[coach] identity rows for league ${league} could not be read, so names resolve from the plans file only: ${e?.message ?? e}`);
    return [];
  }
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
  // Naming him is not asking for a trade idea ("why did X reject my trade"): that goes the ordinary way.
  if (![].concat(who.matched).some(m => requestsIdea(question, m))) return null;
  const flag = coachBriefFlag();
  const preview = flag.preview ? previewFields(BRIEF_PREVIEW_REASON) : {};
  const ledger = newLedger();
  if (!who.roster) {
    return { answer: { claims: [], refusals: [`More than one manager fits that name (${who.ambiguous.join(', ')}); say which one.`], as_of: null },
      ledger: ledger.toJson(), dropped: [], actions: [],
      verification: { ok: true, violations: [], warnings: [], numbers_checked: 0, deterministic: true, intent: 'partner', question }, ...preview };
  }
  const out = partnerClaimsFor({ entry, roster: who.roster, ledger, identities: ids });
  const actions = out.source === 'flip_leg' ? [['warroom_view', { type: 'focus_panel', panel: 'flip_map' }]]
    : [['warroom_view', { type: 'focus_panel', panel: 'next_move' }]];
  return shipped({ draft: out.claims, ledger, file, question, intent: 'partner', preview,
    extra: { actions, partner: { roster: who.roster, source: out.source, move_id: out.move_id ?? null } } });
}

/**
 * COACH-PARTNER: "what else u got": the card after the one the War Room shows,
 * in full, and the 'next' deck move that shows it. The client says which card
 * it shows (context.deck_index, or context.move_id); Coach keeps no cursor of
 * its own. Without either, the answer is the card after the served next move,
 * it says so, and it does not move the deck (the client's position is unknown).
 */
export async function alternativeAnswer({ question, leagueId = null, plansPath = warRoomPlansPath(), deckIndex = null, moveId = null }) {
  const read = await planEntry({ leagueId, plansPath });
  const flag = coachBriefFlag();
  const preview = flag.preview ? previewFields(BRIEF_PREVIEW_REASON) : {};
  if (read.refusal) {
    return { answer: { claims: [], refusals: [read.refusal], as_of: null }, ledger: newLedger().toJson(), dropped: [], actions: [],
      verification: { ok: true, violations: [], warnings: [], numbers_checked: 0, deterministic: true, question }, ...preview };
  }
  const { file, entry } = read;
  const byMove = typeof moveId === 'string' && moveId ? cardOf(entry, moveId) : null;
  const known = Number.isInteger(deckIndex) && deckIndex >= 0 ? deckIndex : byMove;
  const nm = entry.next_move?.status === 'ok' ? entry.next_move.value : null;
  const at = known ?? (nm ? (cardOf(entry, nm.move_id) ?? -1) : -1);
  const next = at + 1;
  const deck = deckMoves(entry);
  const ledger = newLedger();
  const draft = alternativeClaims(entry, ledger, next);
  if (known == null && deck.length) {
    const n = ledger.record({ tool: 'plan_deck', tables: ['plan_deck'], columns: ['basis'],
      rows: [{ basis: nm ? 'the card after the served next move' : 'the first card' }] });
    draft.push({ section: 'alternative', cites: [`${n.id}#0.basis`],
      text: `The War Room did not say which card it shows, so this is ${nm ? 'the card after the served next move' : 'the first card'}; the deck was not moved.` });
  }
  const moved = known != null && next < deck.length;
  return shipped({ draft, ledger, file, question, intent: 'next_alternative', preview,
    extra: { actions: moved ? ACTIONS.next_alternative : [], shown_move_id: next < deck.length ? String(deck[next].move_id) : null } });
}
