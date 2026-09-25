/**
 * Question in, verified answer out.
 *
 * The shape is the one this app already got right. /trades/:leagueId/sense-check
 * (server/routes/trades.js:705-887) produces a verdict, checks it against a real
 * simulation, and gives Claude one retry when the numbers contradict it. Coach
 * does the same with two differences: the check is deterministic (verify.js, not
 * a second opinion), and a second failure is not softened into a hedge. A
 * sentence Coach cannot stand up twice does not ship, and Coach says which
 * numbers it could not support.
 *
 * What the model is allowed to produce is therefore not prose. It is a list of
 * claims, each carrying the cites that support it, and a list of refusals. The
 * refusals are a first-class output: "Coach does not read that" is a correct
 * answer and is never dressed up as an estimate.
 *
 * Nothing here decides anything. Coach explains, retrieves and computes through
 * the ledger; it cannot write to the database (the query connection is
 * read-only), set a lineup, or send a message.
 *
 * WR-COACH. Asked from the War Room (context.surface === 'war_room', flag on),
 * Coach also gets UI tools (tools.js WARROOM_TOOLS). Each returns a typed
 * action that comes back in `actions` for the client dispatcher; the client
 * refuses anything outside the schema and gates plan changes behind a
 * trade-off preview and Nick's Confirm tap. Plain screen commands ("show the
 * flip map for league 3", "undo") skip the model entirely (intent.js). The
 * grounding check is unchanged: a claim with an invented number still fails.
 *
 * COACH-ANSWERS. With the Coach brief flag on (brief.js#coachBriefFlag), the
 * dock's four starter questions and their paraphrases (starter-answers.js) are
 * answered from the War Room plans file with no model call: grounded, cited
 * claims plus the screen actions that go with them. With no model key, every
 * other question gets a refusal naming what Coach can answer. Cost $0.
 */
import { callClaude, parseJson } from '../claude.js';
import { catalog, readableTables } from './catalog.js';
import { toolDefinitions, runCoachTool, CoachToolError } from './tools.js';
import { CoachQueryRefused, CoachQueryFailed } from './select.js';
import { newLedger, LedgerError } from './ledger.js';
import { verifyAnswer } from './verify.js';
import { recordCoachAnswer } from './audit.js';
import { warRoomEnabled } from '../warroom-actions/store.js';
import { routeIntent } from '../warroom-actions/intent.js';
import { coachBriefFlag } from './brief.js';
import { starterIntent, starterAnswer, starterActions } from './starter-answers.js';

/**
 * Rounds of model call. One round is one Claude turn; a round that asks for
 * tools spends itself on lookups. The last round keeps the same tools declared
 * but sends tool_choice "none", so the model cannot queue a lookup it will
 * never get to run — the same discipline as nfl-page-explain.js, with more
 * room because Coach reads more. The tools stay declared because the history
 * already holds tool_use/tool_result blocks, and because tools sit at the
 * front of the cached prefix: dropping them would miss the system cache.
 */
export const MAX_TOOL_ROUNDS = 6;

/** Sonnet rather than Haiku: this one writes SQL over 34 tables and has to get joins right. */
export const COACH_MODEL = 'claude-sonnet-5';

/**
 * Output cap per round, thinking included. Sonnet 5 runs adaptive thinking by
 * default and its thinking counts toward max_tokens, so a cap sized for the
 * answer alone can be spent before the answer starts — trade-proposals.js hit
 * exactly that at 4,000. Only tokens actually produced are billed.
 */
const MAX_OUTPUT_TOKENS = 8000;

/** One line per table: enough to choose one, not enough to write a query blind. */
function catalogBrief() {
  const full = catalog();
  return readableTables()
    .map(name => `- ${name} (${full[name].collection}) — one row is ${full[name].grain}. ${full[name].means}`)
    .join('\n');
}

const WAR_ROOM_PROMPT = `

THE WAR ROOM. This question comes from the War Room dashboard, and you have War Room tools that change the screen (warroom_view, warroom_plug_in, warroom_plan_change, warroom_draft_message). Use them when Nick asks to see, arrange, filter, pin, chart or change something. They return actions the dashboard applies; you never state a number that only an engine field holds, and plan changes (goal, stops, risk mode, tolerances) only open a preview that waits for Nick's Confirm tap. You never send anything to a league-mate: if asked, refuse and say he sends it himself. When a tool did what was asked, "claims" may be empty; the dashboard describes the change and ends with the destination, stops left and the next move.`;

function systemPrompt({ warRoom = false } = {}) {
  return `You are Coach, the answering layer of a personal fantasy-football app. You answer from rows in this app's database and from its own services. You have no other source. Your training knowledge about players, teams, schedules, injuries and results is out of date and is not evidence here; if a fact is not in a tool result, you do not have it.

WHAT YOU MAY READ. These tables, and nothing else. A question about anything absent from this list is answered by saying Coach does not read it.

${catalogBrief()}

HOW EVIDENCE WORKS. Every tool result is recorded and addressable. A row cell is cited as r1#0.target_share (query 1, row 0, column target_share); a computed number is cited as d1. You must attach, to every claim you make, the cites that support it — a claim's own cites, not another claim's.

ARITHMETIC. Do not do any in your head. A number you calculate in prose cannot be cited and will be rejected, however right it is. Either ask SQL for it (SUM, AVG, COUNT, RANK are all available and exact) or call the compute tool, which records the formula and gives you a cite.

WHAT IS ON SCREEN. If the user's message includes what the page is showing, that is context for understanding the question. It is not evidence. Do not cite it and do not state a number that came only from it — retrieve the number yourself.

REFUSING IS AN ANSWER. If the data is not there, say so plainly and specifically: which table you would have needed, or what has never been collected. Do not estimate, do not reason from general football knowledge, and do not soften a gap into a hedge. A short honest refusal is worth more than a paragraph that cannot be checked.

DATA AGE. Some tables are only as current as the last time a person ran something — they are marked (by_hand) above. If your answer stands on one, put the age in the "as_of" field in plain words. An answer built on stale data that reads as current is the failure this app cares most about.

YOUR OUTPUT. When you are ready to answer, reply with ONLY this JSON object and no other text:
{
  "claims": [ { "text": "one sentence a person can act on", "cites": ["r1#0.column", "d1"] } ],
  "refusals": [ "what you could not answer, and why" ],
  "as_of": "how old the hand-collected data behind this is, or null"
}
Write the claims the way a knowledgeable friend would say them out loud: short sentences, the answer first, no hedging and no restating of the question. One idea per claim.${warRoom ? WAR_ROOM_PROMPT : ''}`;
}

function userPrompt({ question, context, leagueId }) {
  const screen = context && Object.keys(context).length
    ? `\n\nWHAT THE PAGE IS SHOWING (context only — never cite this, never state a number that is only here):\n${JSON.stringify(context)}`
    : '';
  const league = leagueId ? `\n\nThe user's league id is ${leagueId}.` : '';
  return `QUESTION: ${question}${league}${screen}`;
}

/** The correction turn: name every failure so the retry is actionable, not a re-roll. */
function correctionPrompt(verification) {
  const lines = verification.violations.map(v => {
    if (v.kind === 'ungrounded_number') {
      return `- ungrounded_number: "${v.number}" in "${v.text}" is in no cell that claim cites. Retrieve it, compute it through the compute tool, or drop the sentence.`;
    }
    if (v.kind === 'uncited_claim') return `- uncited_claim: "${v.text}" carries no cite. Support it or refuse it.`;
    if (v.kind === 'bad_cite') return `- bad_cite: ${v.cite} is not in this turn's ledger.`;
    if (v.kind === 'missing_as_of') return `- missing_as_of: ${v.tables.join(', ')} ${v.tables.length === 1 ? 'is' : 'are'} collected by hand, so "as_of" cannot be empty.`;
    return `- ${v.kind}: ${v.detail}`;
  });
  return `Your answer did not pass the grounding check and was not shown to the user.

${lines.join('\n')}

Fix it. You may call a tool to retrieve what is missing if you have rounds left. If a claim cannot be supported by something you actually retrieved, remove it and put the gap in "refusals" instead — that is the correct answer, not a failure. Reply with only the JSON object.`;
}

/** The deterministic refusal used when a second attempt still cannot be stood up. */
function refusalFor(verification) {
  const numbers = [...new Set(verification.violations
    .filter(v => v.kind === 'ungrounded_number').map(v => v.number))];
  if (numbers.length) {
    return `Coach could not trace ${numbers.length === 1 ? 'one number' : `${numbers.length} numbers`} ` +
      `(${numbers.join(', ')}) back to anything it retrieved, so it is not showing the answer. ` +
      'Ask again more narrowly, or ask what Coach does read about this.';
  }
  return 'Coach could not support its own answer from the data it retrieved, so it is not showing it.';
}

function answerFrom(parsed) {
  const claims = Array.isArray(parsed?.claims) ? parsed.claims
    .filter(c => c && typeof c.text === 'string' && c.text.trim())
    .map(c => ({ text: c.text.trim(), cites: Array.isArray(c.cites) ? c.cites.filter(x => typeof x === 'string') : [] }))
    : [];
  const refusals = Array.isArray(parsed?.refusals)
    ? parsed.refusals.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim()) : [];
  const asOf = typeof parsed?.as_of === 'string' && parsed.as_of.trim() ? parsed.as_of.trim() : null;
  return { claims, refusals, as_of: asOf };
}

/**
 * Ask Coach one question.
 *
 * @param {{question: string, context?: object, leagueId?: number|null,
 *   onEvent?: (event: object) => void, model?: string}} args
 * @returns {Promise<{question, answer, ledger, verification, plan, audit_id, cost_usd}>}
 */
export async function askCoach({ question, context = null, leagueId = null,
  onEvent = () => {}, model = COACH_MODEL, hasModel = true } = {}) {
  const asked = String(question ?? '').trim();
  if (!asked) {
    const err = new Error('Coach was asked nothing.');
    err.status = 400;
    throw err;
  }

  const ledger = newLedger();
  const plan = [];
  const actions = [];
  // RULES-EVERYWHERE: suggestions a tool dropped for breaking one of Nick's hard rules, this answer.
  const counts = { dropped_by_rule: 0 };
  const tally = out => { counts.dropped_by_rule += Number(out?.dropped_by_rule) || 0; return out; };
  const emit = event => { plan.push(event); onEvent(event); };
  emit({ t: 'understood', question: asked });

  const warRoom = context?.surface === 'war_room' && warRoomEnabled();
  const fast = warRoom ? routeIntent(asked) : null;
  if (fast?.refuse) {
    emit({ t: 'answer', claims: 0, refusals: 1, fast_path: true });
    return { question: asked, answer: { claims: [], refusals: [fast.refuse], as_of: null }, actions: [],
      ledger: ledger.toJson(), verification: { ok: true, violations: [], warnings: [], numbers_checked: 0, fast_path: true },
      plan, audit_id: null, cost_usd: 0, dropped_by_rule: 0 };
  }

  // The brief flag gates the plan-read path; a screen command with no model key still runs below.
  const planAnswers = coachBriefFlag().on;
  const intent = planAnswers ? starterIntent(asked) : null;
  if (intent || (planAnswers && !hasModel && !fast)) {
    const league = leagueId ?? (Number.isInteger(context?.league) ? context.league : null);
    const out = await starterAnswer({ question: asked, intent, leagueId: league });
    const starterActs = [];
    if (warRoom && intent) {
      for (const [tool, input] of (fast?.tool ? [[fast.tool, fast.input]] : starterActions(intent))) {
        const { action } = tally(runCoachTool(tool, input, { ledger }));
        if (!action) continue;
        starterActs.push(action);
        emit({ t: 'action', action, fast_path: true });
      }
    }
    emit({ t: 'answer', claims: out.answer.claims.length, refusals: out.answer.refusals.length, deterministic: true });
    const auditId = recordCoachAnswer({ question: asked, route: context?.route ?? null, leagueId: league, model: 'none:starter',
      answer: out.answer, ledger: out.ledger, plan, verification: out.verification, costUsd: 0 });
    return { question: asked, answer: out.answer, actions: starterActs, ledger: out.ledger, verification: out.verification,
      dropped: out.dropped, plan, audit_id: auditId, cost_usd: 0, dropped_by_rule: counts.dropped_by_rule,
      ...(out.preview ? { preview: true, preview_reason: out.preview_reason } : {}) };
  }

  if (warRoom) {
    if (fast) {
      const { action } = tally(runCoachTool(fast.tool, fast.input, { ledger }));
      if (action) emit({ t: 'action', action, fast_path: true });
      return { question: asked, answer: { claims: [], refusals: [], as_of: null }, actions: action ? [action] : [],
        ledger: ledger.toJson(), verification: { ok: true, violations: [], warnings: [], numbers_checked: 0, fast_path: true },
        plan, audit_id: null, cost_usd: 0, dropped_by_rule: counts.dropped_by_rule };
    }
  }

  const messages = [{ role: 'user', content: userPrompt({ question: asked, context, leagueId }) }];
  let retried = false;
  let costUsd = 0;
  let answer = null;
  let verification = null;

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const isFinalRound = round === MAX_TOOL_ROUNDS;
    const msg = await callClaude({
      feature: 'coach:answer', model, maxTokens: MAX_OUTPUT_TOKENS,
      // System (with the tools in front of it) is the stable breakpoint; the
      // conversation cache lets each round re-read the rounds before it, whose
      // tool results are most of what a later round sends.
      system: systemPrompt({ warRoom }), cacheSystem: true, cacheConversation: true, messages,
      tools: toolDefinitions({ warRoom }),
      toolChoice: isFinalRound ? { type: 'none' } : undefined
    });
    costUsd += msg.cost_usd ?? 0;

    const toolUses = (msg.content ?? []).filter(block => block.type === 'tool_use');
    if (toolUses.length && !isFinalRound) {
      emit({ t: 'planning', tools: toolUses.map(block => block.name) });
      messages.push({ role: 'assistant', content: msg.content });
      messages.push({ role: 'user', content: toolUses.map(block => runOne(block, { ledger, emit, actions, tally })) });
      continue;
    }

    emit({ t: 'drafting' });
    let parsed;
    try {
      parsed = parseJson(msg);
    } catch (e) {
      if (retried || isFinalRound) {
        const err = new Error(`Coach did not return an answer in the agreed shape: ${e.message}`);
        err.status = 502;
        throw err;
      }
      retried = true;
      messages.push({ role: 'assistant', content: msg.content });
      messages.push({ role: 'user', content:
        `That was not the JSON object described in your instructions (${e.message}). Reply with only the object.` });
      continue;
    }

    answer = answerFrom(parsed);
    emit({ t: 'checking', numbers: answer.claims.length });
    verification = { ...verifyAnswer({ answer, ledger, question: asked }), retried };
    // A War Room turn whose whole answer was a screen change is not silence.
    // Only the empty-answer rule relaxes; every number rule stands.
    if (actions.length && verification.violations.every(v => v.kind === 'empty_answer')) {
      verification = { ...verification, ok: true, violations: [], answered_by_actions: actions.length };
    }

    if (verification.ok) break;
    if (retried) {
      emit({ t: 'rejected', violations: verification.violations, final: true });
      answer = { claims: [], refusals: [...answer.refusals, refusalFor(verification)], as_of: answer.as_of };
      break;
    }
    retried = true;
    emit({ t: 'rejected', violations: verification.violations, final: false });
    messages.push({ role: 'assistant', content: msg.content });
    messages.push({ role: 'user', content: correctionPrompt(verification) });
  }

  if (!answer) {
    const err = new Error('Coach ran out of rounds without producing an answer.');
    err.status = 502;
    throw err;
  }

  emit({ t: 'answer', claims: answer.claims.length, refusals: answer.refusals.length });

  const ledgerJson = ledger.toJson();
  const auditId = recordCoachAnswer({
    question: asked, route: context?.route ?? null, leagueId, model,
    answer, ledger: ledgerJson, plan, verification, costUsd
  });

  return { question: asked, answer, actions, ledger: ledgerJson, verification, plan,
    audit_id: auditId, cost_usd: costUsd, dropped_by_rule: counts.dropped_by_rule };
}

/**
 * Run one tool call and turn it into a tool_result block.
 *
 * A refusal, a bad query and a bad argument all come back to the model as
 * results rather than ending the question: the boundary is information it can
 * act on, and hiding it would just make the next round guess again. Anything
 * that is not one of those is a real fault and is left to throw.
 */
function runOne(block, { ledger, emit, actions = [], tally = x => x }) {
  const started = Date.now();
  emit({ t: 'query', id: null, tool: block.name, status: 'running', input: block.input ?? {} });
  try {
    const { entry, summary, action } = tally(runCoachTool(block.name, block.input ?? {}, { ledger }));
    if (action) {
      actions.push(action);
      emit({ t: 'action', action });
    } else if (entry && entry.op) {
      emit({ t: 'computing', id: entry.id, label: entry.label, formula: entry.formula, value: entry.value });
    } else if (entry) {
      emit({ t: 'query', id: entry.id, tool: block.name, status: 'done',
        row_count: entry.row_count, tables: entry.tables, truncated: entry.truncated,
        ms: Date.now() - started });
    } else {
      emit({ t: 'query', id: null, tool: block.name, status: 'done', ms: Date.now() - started });
    }
    return { type: 'tool_result', tool_use_id: block.id,
      content: JSON.stringify(summary).slice(0, 20_000) };
  } catch (e) {
    const expected = e instanceof CoachQueryRefused || e instanceof CoachQueryFailed
      || e instanceof CoachToolError || e instanceof LedgerError;
    if (!expected) throw e;
    emit({ t: 'refused', tool: block.name, reason: e.message, ms: Date.now() - started });
    return { type: 'tool_result', tool_use_id: block.id, is_error: true,
      content: JSON.stringify({ error: e.message, kind: e.kind ?? 'tool' }) };
  }
}
