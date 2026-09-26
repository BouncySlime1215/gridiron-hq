/**
 * COACH-CHAT: one turn of a Coach conversation.
 *
 *   1. The thread (threads.js) gives the focus: the move, partner and players
 *      under discussion.
 *   2. A follow-up the plan answers ("why?", "what if he says no?", "the other
 *      one", "what about <manager> instead") is answered from plans.json at $0
 *      (followups.js), grounded like every other Coach line.
 *   3. Anything else goes through askCoach unchanged (the starter intents, the
 *      partner answer, the War Room screen commands, then the model when a key
 *      is configured), with the focused move as the deck position and, on the
 *      model path, the recent turns, the rolling summary and the focus as
 *      context (never as evidence: verify.js still rejects an unsupported
 *      number).
 *   4. With no model, an unmatched question says plainly that it needs the
 *      model and offers the nearest $0 follow-ups as chips (no dead ends).
 *   5. The turn, the new focus, the chips and the action proposals are stored.
 *
 * Coach never sends an offer and never builds a trade of its own: every move
 * it talks about is one the planner served through Nick's rules.
 */
import { askCoach, COACH_MODEL } from './ask.js';
import { newLedger } from './ledger.js';
import { recordCoachAnswer } from './audit.js';
import { groundStarter, planEntry, identitiesFor, starterIntent, partnerAnswer } from './starter-answers.js';
import { answerWithLanes, lanesOn } from './lanes.js';
import { activeThread, appendTurn, recentTurns, summaryText, threadTurnLimit } from './threads.js';
import { followupIntent, focusFor, focusedMove, moveById, partnerOnlyFocus } from './focus.js';
import { whyClaims, ifNoClaims, otherOneClaims, partnerSwitchClaims, followupsFor, CHIP } from './followups.js';
import { teamOf } from './brief-claims.js';
import { withIdentityTeams } from './partner.js';
import { routeIntent } from '../warroom-actions/intent.js';
import { LlmBudgetError } from '../llm-budget.js';
import { routeQuestion, ruleIntent } from './router.js';
import { explainTerm, chatReply } from './explain.js';
import { shapeDeterministic, stripDevText } from './answer-shape.js';

/** Models per message (COACH-CHAT model routing). All three are priced in llm-budget.js. */
export const CHAT_MODELS = Object.freeze({
  followup: 'claude-haiku-4-5-20251001', normal: COACH_MODEL, deep: 'claude-opus-5-5'
});
const DEEP = /\b(analy[sz]e|deep dive|break (it|this|that) down|evaluate|compare|is (it|this|that) (fair|worth)|walk me through)\b/;
const TRADE = /\b(trades?|offers?|deals?|packages?|swap|flip)\b/;

/**
 * The model for one message: a short follow-up inside a thread that already has
 * a focus goes to the cheap model; a trade analysis ("analyze this trade",
 * "is it fair") to the strongest; everything else to the normal Coach model.
 */
export function routeModel(question, { focus = {}, turns = 0 } = {}) {
  const t = String(question ?? '').toLowerCase();
  if (DEEP.test(t) && (TRADE.test(t) || focus.move_id != null)) return CHAT_MODELS.deep;
  if (t.length <= 60 && turns > 0 && (focus.move_id != null || focus.partner != null) && !TRADE.test(t)) return CHAT_MODELS.followup;
  return CHAT_MODELS.normal;
}

const NO_MODEL = 'That one needs the AI model, which is off here, so Coach is not guessing. It can answer the questions below from your plan right now.';
const AI_UNAVAILABLE = "Coach's AI is unavailable right now, so this one waits. It can answer the questions below from your plan.";
const OVER_BUDGET = "Today's AI limit for Coach is used up, so this one waits until tomorrow. It can answer the questions below from your plan right now.";

const deterministic = (question, intent, extra = {}) => ({ ok: true, violations: [], warnings: [], deterministic: true, intent, question, ...extra });

/** The $0 answer for a follow-up intent, grounded; plus the focus it leaves. */
function followupAnswer({ question, intent, roster, ambiguous, entry, file, focus, identities }) {
  const ledger = newLedger();
  let draft;
  let next = { ...focus };
  if (intent === 'partner_switch' && !roster) {
    return { answer: { claims: [], refusals: [`More than one manager fits that name (${ambiguous.join(', ')}); say which one.`], as_of: null },
      ledger: ledger.toJson(), dropped: [], verification: deterministic(question, intent, { numbers_checked: 0 }), focus: next };
  }
  if (intent === 'why') {
    draft = whyClaims(entry, ledger, focus);
    if (focus.move_id == null) { const at = focusedMove(entry, focus); if (at) next = focusFor(at.move, at.k, focus); }
  } else if (intent === 'if_no') {
    draft = ifNoClaims(entry, ledger, focus);
    if (focus.move_id == null) { const at = focusedMove(entry, focus); if (at) next = focusFor(at.move, at.k, focus); }
  } else if (intent === 'other_one') {
    const out = otherOneClaims(entry, ledger, focus);
    draft = out.claims;
    if (out.move) next = focusFor(out.move, 0, focus);
  } else if (intent === 'partner_switch') {
    const out = partnerSwitchClaims(entry, ledger, roster, identities);
    draft = out.claims;
    const move = out.move_id ? moveById(entry, out.move_id) : null;
    if (move) {
      const k = Math.max(0, move.steps.findIndex(s => String(s.partner) === String(roster)));
      next = focusFor(move, k, focus);
    } else next = partnerOnlyFocus(roster, focus);
  }
  const { claims, dropped, numbers_checked } = groundStarter(draft, ledger);
  const refusals = claims.length ? [] : ['Coach could not ground any line of this answer in the plan, so it is not showing one.'];
  return { answer: { claims, refusals, as_of: file.generated_at ? `plans file of ${file.generated_at}` : 'plans file' },
    ledger: ledger.toJson(), dropped, verification: deterministic(question, intent, { numbers_checked, dropped: dropped.length }), focus: next };
}

/** The focus after an askCoach answer: the move it showed, or the focus unchanged. */
function focusAfter(result, { entry, focus }) {
  if (!entry) return focus;
  const intent = result.intent ?? result.verification?.intent ?? null;
  if (intent === 'next_move' || intent === 'safe_to_send') {
    const nm = entry.next_move?.status === 'ok' ? entry.next_move.value : null;
    return nm?.steps?.length ? focusFor(nm, 0, focus) : focus;
  }
  if (intent === 'next_alternative' && result.shown_move_id) {
    const m = moveById(entry, result.shown_move_id);
    return m ? focusFor(m, 0, focus) : focus;
  }
  if (intent === 'partner' && result.partner?.roster) {
    const m = result.partner.move_id ? moveById(entry, result.partner.move_id) : null;
    if (!m) return partnerOnlyFocus(result.partner.roster, focus);
    const k = Math.max(0, m.steps.findIndex(s => String(s.partner) === String(result.partner.roster)));
    return focusFor(m, k, focus);
  }
  return focus;
}

/** Intents whose answer puts one served offer in front of Nick: those get action cards. */
const OFFER_INTENTS = new Set(['next_move', 'safe_to_send', 'next_alternative', 'partner', 'other_one', 'partner_switch']);

/**
 * Action proposals for the answer (rendered as action cards; nothing runs
 * without Nick's tap): "I sent it" with the plan's draft to copy, and "skip
 * this card". Both are the War Room's own records (offer.sent, deck.skip).
 */
export function proposalsFor(intent, focus, entry) {
  if (!entry || !OFFER_INTENTS.has(intent) || focus.move_id == null) return [];
  const move = moveById(entry, focus.move_id);
  const k = Number.isInteger(focus.step) ? focus.step : 0;
  const step = move?.steps?.[k];
  if (!step) return [];
  const names = entry.names ?? {};
  const list = ids => ids.map(pid => names[pid] ?? `player ${pid}`).join(' + ');
  const deal = `${list(step.give)} for ${list(step.get)}`;
  const partner = teamOf(entry, step.partner);
  const message = step.message?.status === 'ok' && typeof step.message.value === 'string' ? step.message.value : null;
  return [
    { kind: 'offer.sent', title: `Mark as sent: ${deal} to ${partner}`, payload: { move_id: String(move.move_id), step_index: k, sent_as: 'card' },
      changes: 'Logs the offer as sent, so the plan waits for his reply instead of suggesting it again.',
      rules: 'Coach never sends it. You send it yourself, then tap here.', message },
    { kind: 'deck.skip', title: `Skip this card: ${deal}`, payload: { move_id: String(move.move_id) },
      changes: 'Hides this card and tells the planner you passed on it.',
      rules: 'Your trade rules stay on either way.' }
  ];
}

/**
 * One conversational turn. `userId`/`leagueId` pick the thread. Returns what
 * askCoach returns, plus `thread` ({ id, focus, followups, proposals }).
 */
export async function chatTurn({ userId, leagueId, question, context = null, hasModel = false, onEvent = () => {} }) {
  const asked = String(question ?? '').trim();
  if (!asked) {
    const err = new Error('Coach was asked nothing.');
    err.status = 400;
    throw err;
  }
  const limit = threadTurnLimit();
  const thread = activeThread(userId, leagueId);
  const focus = thread.focus ?? {};
  const read = await planEntry({ leagueId });
  const identities = read.refusal ? [] : identitiesFor(read.league);
  // Team labels from the identity rows too, so "Team 3" in the planner's prose reads as the manager's name.
  const entry = read.refusal ? null : withIdentityTeams(read.entry, identities);

  let result;
  const refuseSend = routeIntent(asked)?.refuse;
  const follow = !refuseSend && entry ? followupIntent(asked, { focus, entry, identities }) : null;
  // A starter question ("is it safe to send?") keeps its own answer; a follow-up wins only over free text.
  const starter = starterIntent(asked);
  const plan = [];
  const emit = e => { plan.push(e); onEvent(e); };
  const byRule = ruleIntent(asked);
  const defining = /^(what('?s| is| are| does| do)|explain|define)\b/i.test(asked);
  const quick = follow || starter || refuseSend ? null
    : byRule === 'CHAT' ? chatReply({ question: asked })
      : (byRule === 'EXPLAIN' || defining) && entry ? await explainTerm({ question: asked, leagueId }) : null;
  if (follow && !(starter && follow.intent !== 'partner_switch' && follow.intent !== 'other_one')) {
    emit({ t: 'understood', question: asked });
    const out = followupAnswer({ question: asked, ...follow, entry, file: read.file, focus, identities });
    emit({ t: 'answer', claims: out.answer.claims.length, refusals: out.answer.refusals.length, deterministic: true });
    const auditId = recordCoachAnswer({ question: asked, route: context?.route ?? null, leagueId, model: 'none:followup',
      answer: out.answer, ledger: out.ledger, plan, verification: out.verification, costUsd: 0 });
    result = { question: asked, answer: out.answer, actions: [], ledger: out.ledger, verification: out.verification, dropped: out.dropped,
      plan, audit_id: auditId, cost_usd: 0, dropped_by_rule: 0, intent: follow.intent, nextFocus: out.focus };
  } else if (quick) {
    // COACH-V2 $0 paths: small talk, and a definition of a term the app serves (its value from the bundle).
    emit({ t: 'understood', question: asked });
    emit({ t: 'answer', claims: quick.answer.claims.length, refusals: 0, deterministic: true });
    const auditId = recordCoachAnswer({ question: asked, route: context?.route ?? null, leagueId, model: `none:${quick.verification.intent}`,
      answer: quick.answer, ledger: quick.ledger, plan, verification: quick.verification, costUsd: 0 });
    result = { question: asked, answer: quick.answer, actions: [], ledger: quick.ledger, verification: quick.verification, dropped: quick.dropped ?? [],
      plan, audit_id: auditId, cost_usd: 0, dropped_by_rule: 0, intent: quick.verification.intent, nextFocus: focus };
  } else {
    const ctx = { ...(context ?? {}), league: context?.league ?? leagueId };
    if (ctx.move_id == null && ctx.deck_index == null && focus.move_id) ctx.move_id = focus.move_id;
    const turns = recentTurns(thread.id, limit);
    const conversation = { turns, summary: summaryText(thread.summary), focus };
    const noModelRefusal = NO_MODEL;
    const askArgs = { question: asked, context: ctx, leagueId, hasModel, onEvent, conversation,
      model: routeModel(asked, { focus, turns: turns.length / 2 }), feature: 'coach:chat', noModelRefusal };
    try {
      // COACH-V2 [0]: the router picks the intent, model, effort and lookup budget; the answer comes back shaped.
      const route = hasModel && !starter && !routeIntent(asked) ? await routeQuestion(asked, { hasModel }) : null;
      if (route) onEvent({ t: 'routed', intent: route.intent, by: route.by });
      const routed = { ...askArgs, model: route?.model ?? askArgs.model, shaped: true, toolRounds: route?.toolRounds ?? null,
        effort: route?.effort ?? null, thinking: route?.thinking ?? null };
      // COACH-LANES: a question bound for the model (no command, starter or partner answer) runs both lanes.
      const modelBound = hasModel && lanesOn() && !routeIntent(asked) && !starter
        && !(await partnerAnswer({ question: asked, leagueId }));
      result = modelBound
        ? await answerWithLanes({ question: asked, askArgs: routed, focus, leagueId, threadId: thread.id })
        : await askCoach(routed);
      if (route) { result.route = route; result.cost_usd = (result.cost_usd ?? 0) + route.cost_usd; }
    } catch (e) {
      const credit = e?.code === 'ai_credit';
      if (!(e instanceof LlmBudgetError) && !credit) throw e;
      const ledger = newLedger().toJson();
      result = { question: asked, answer: { claims: [], refusals: [credit ? AI_UNAVAILABLE : OVER_BUDGET], as_of: null },
        actions: [], ledger, verification: deterministic(asked, null, { numbers_checked: 0 }), plan: [], audit_id: null, cost_usd: 0,
        dropped_by_rule: 0, over_budget: !credit, ai_unavailable: credit };
    }
    result.nextFocus = focusAfter(result, { entry, focus });
  }

  const nextFocus = result.nextFocus;
  delete result.nextFocus;
  // COACH-V2 section 2: plan answers come back in the same format as model answers (verdict, why, risks).
  if (!result.answer.shape) result.answer = shapeDeterministic(result.answer);
  // CLAUDE.md 2b, whatever path answered: no table, column or snake_case name reaches the drawer.
  const clean = stripDevText(result.answer);
  if (clean.dropped.length) { result.answer = clean.answer; result.dev_text_dropped = clean.dropped.length; }
  const intent = result.intent ?? result.verification?.intent ?? null;
  const followups = followupsFor(intent, nextFocus, entry);
  const proposals = proposalsFor(intent, nextFocus, entry);
  const replyText = [...result.answer.claims.map(c => c.text), ...result.answer.refusals].join(' ');
  const reply = { text: replyText, claims: result.answer.claims, refusals: result.answer.refusals, ledger: result.ledger,
    followups, proposals, cost_usd: result.cost_usd ?? 0, ...(result.lanes ? { lanes: result.lanes } : {}),
    ...(result.answer.shape ? { shape: result.answer.shape } : {}), ...(result.route ? { route: result.route.intent } : {}) };
  appendTurn(thread.id, { question: asked, intent, reply, focus: nextFocus }, { limit });
  return { ...result, intent, thread: { id: thread.id, focus: nextFocus, followups, proposals } };
}

export { CHIP };
