/**
 * Coach: ask the app anything it can answer from its own rows.
 *
 * This is the fantasy counterpart to the betting desk's /explain/page
 * (server/routes/betting-hub.js:902), and it is deliberately a different
 * endpoint rather than a widening of that one. That route explains the screen;
 * this one answers a question from the database, and the two have different
 * inputs, different outputs and different failure modes. What they share is
 * the discipline and the limits.
 *
 * The response carries its own evidence. Every cite in `answer` resolves into
 * `ledger`, so the client can show the row any number came from, and nothing
 * with `verification.ok === false` ever ships a claim — Coach returns a
 * refusal instead. The client therefore never has to decide whether to trust a
 * sentence, which is the whole point of the design.
 *
 * `Accept: text/event-stream` streams the thinking sequence as it happens and
 * ends with a `result` event carrying the same JSON the plain POST returns.
 *
 * Limits are the page-explain route's, for the reason written there: this app
 * is reachable through the public tunnel and every call spends on Nick's key.
 */
import { Router } from 'express';
import { requireAuthenticated, assertLeagueMember } from '../platform/auth.js';
import { legacyRateLimit } from '../platform/legacy-access.js';
import { getApiKey } from '../services/claude.js';
import { askCoach } from '../services/coach/ask.js';
import { catalog, readableTables, catalogCoverage } from '../services/coach/catalog.js';
import { recentCoachAnswers, coachGroundingRate } from '../services/coach/audit.js';
import { db } from '../db/index.js';
import { coachBriefFlag, BRIEF_ENV, morningBrief, weeklyCheckIn, readPlansFile } from '../services/coach/brief.js';
import { warRoomPlansPath } from '../services/warroom-flag.js';
import { chatTurn } from '../services/coach/chat.js';
import { activeThread, newThread, threadMessages, threadTurnLimit } from '../services/coach/threads.js';
import { followupsFor } from '../services/coach/followups.js';
import { budgetStatus } from '../services/llm-budget.js';

const r = Router();

const ASK_LIMIT_PER_MINUTE = 12;
const MAX_CONTEXT_CHARS = 16_000;
const MAX_QUESTION_CHARS = 2_000;
const askAccess = [requireAuthenticated, legacyRateLimit({ limit: ASK_LIMIT_PER_MINUTE, windowMs: 60_000 })];

const wantsStream = req => /text\/event-stream/i.test(req.get('accept') ?? '');

function send(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

r.post('/ask', ...askAccess, async (req, res, next) => {
  const body = req.body ?? {};
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return res.status(400).json({ error: 'question is required' });
  if (question.length > MAX_QUESTION_CHARS) {
    return res.status(413).json({ error: `question is ${question.length} characters, max ${MAX_QUESTION_CHARS}` });
  }
  const context = (body.context && typeof body.context === 'object' && !Array.isArray(body.context))
    ? body.context : null;
  const contextChars = JSON.stringify(context ?? null).length;
  if (contextChars > MAX_CONTEXT_CHARS) {
    return res.status(413).json({ error: `page context is ${contextChars} characters, max ${MAX_CONTEXT_CHARS}` });
  }
  const leagueId = Number.isInteger(body.league_id) ? body.league_id : null;
  // COACH-ANSWERS: with the brief flag on, Coach still answers the starter
  // questions from the plan (and refuses the rest plainly) when there is no key.
  const hasModel = !!getApiKey();
  if (!hasModel && !coachBriefFlag().on) {
    return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
  }

  // COACH-CHAT: `thread: true` makes this a turn of the league's conversation (threads, focus, $0 follow-ups).
  const threaded = body.thread === true && leagueId != null;
  const answer = onEvent => (threaded
    ? chatTurn({ userId: req.auth.userId, leagueId, question, context, hasModel, onEvent })
    : askCoach({ question, context, leagueId, hasModel, onEvent }));

  if (!wantsStream(req)) {
    try {
      res.json(await answer(undefined));
    } catch (e) { next(e); }
    return;
  }

  // Streaming. Headers go out before the first model call so the client can
  // render the trace from the first event rather than after the whole turn.
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });
  try {
    const result = await answer(event => send(res, event));
    send(res, { t: 'result', ...result });
  } catch (e) {
    // The stream is already open, so an error is an event rather than a status
    // code. It still says what went wrong — a stream that simply stops is the
    // silent failure this app keeps finding.
    send(res, { t: 'error', error: e.message, status: e.status ?? 500 });
  } finally {
    res.end();
  }
});

/* ------------------------------------------------ COACH-CHAT threads */

const leagueParam = req => {
  const id = Number(req.params.leagueId);
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('leagueId must be a positive whole number'), { status: 400 });
  return id;
};

/** A stored message as the drawer shows it: Nick's text, or Coach's grounded reply. */
const shownMessage = m => (m.role === 'nick' ? { id: m.id, who: 'nick', text: m.text, at: m.created_at }
  : { id: m.id, who: 'coach', text: m.text, intent: m.intent, at: m.created_at, claims: m.payload.claims ?? [], refusals: m.payload.refusals ?? [],
    ledger: m.payload.ledger ?? null, followups: m.payload.followups ?? [], proposals: m.payload.proposals ?? [], lanes: m.payload.lanes ?? null });

function threadView(userId, leagueId, thread) {
  const t = thread ?? activeThread(userId, leagueId, { create: false });
  const messages = t ? threadMessages(t.id).map(shownMessage) : [];
  return { thread: t ? { id: t.id, focus: t.focus, earlier_turns: t.summary?.turns_folded ?? 0 } : null,
    messages, starters: followupsFor(null, {}, null), turn_limit: threadTurnLimit() };
}

/** The league's active conversation (null thread when none has started). */
r.get('/thread/:leagueId', requireAuthenticated, (req, res, next) => {
  try { res.json(threadView(req.auth.userId, leagueParam(req))); } catch (e) { next(e); }
});

/** "New conversation": archive the active thread and open an empty one. */
r.post('/thread/:leagueId/new', requireAuthenticated, (req, res, next) => {
  try {
    const leagueId = leagueParam(req);
    res.json(threadView(req.auth.userId, leagueId, newThread(req.auth.userId, leagueId)));
  } catch (e) { next(e); }
});

/** Coach's AI spend today against its daily limit (llm-budget.js), for the drawer's hint and Settings. */
r.get('/spend', requireAuthenticated, (_req, res, next) => {
  try {
    const b = budgetStatus('coach');
    res.json({ model_on: !!getApiKey(), spent_today_usd: b.spent_usd, daily_budget_usd: b.budget_usd, resets_at: b.resets_at });
  } catch (e) { next(e); }
});

/** What Coach can and cannot see, so a page can say so rather than imply it. */
r.get('/catalog', requireAuthenticated, (_req, res, next) => {
  try { res.json({ tables: readableTables(), coverage: catalogCoverage(), catalog: catalog() }); }
  catch (e) { next(e); }
});

/** Recent answers, rejected ones included — the rejected ones are the point. */
r.get('/answers', requireAuthenticated, (req, res, next) => {
  try { res.json({ answers: recentCoachAnswers({ limit: req.query.limit }) }); }
  catch (e) { next(e); }
});

/**
 * COACH-BRIEF: the morning brief (default) or the weekly check-in for one league,
 * built from the War Room plans file and the app DB with no model call. Every
 * line in `claims` passed the grounding check against `ledger`; what failed is in
 * `dropped` with the reason. Flag off -> { status: 'off' } and nothing is read.
 */
const BRIEF_KINDS = new Set(['morning', 'weekly']);
r.get('/brief/:leagueId', requireAuthenticated, async (req, res, next) => {
  try {
    if (!coachBriefFlag().on) return res.json({ status: 'off', reason: `${BRIEF_ENV} is not 1 and preview mode is off` });
    const leagueId = Number(req.params.leagueId);
    if (!Number.isInteger(leagueId) || leagueId < 1) return res.status(400).json({ error: 'leagueId must be a positive whole number' });
    const kind = req.query.kind ?? 'morning';
    if (!BRIEF_KINDS.has(kind)) return res.status(400).json({ error: `kind must be one of ${[...BRIEF_KINDS].join(', ')}` });
    assertLeagueMember(req.auth.userId, leagueId);
    let file;
    try { file = await readPlansFile(warRoomPlansPath()); } catch (e) {
      return res.json({ status: 'failed', reason: `The plans file could not be read (${e.name ?? 'error'}), so there is no plan to brief.` });
    }
    res.json(kind === 'weekly' ? weeklyCheckIn({ db, file, leagueId }) : morningBrief({ db, file, leagueId }));
  } catch (e) { next(e); }
});

/** How often the grounding check has stopped something. */
r.get('/grounding', requireAuthenticated, (req, res, next) => {
  try { res.json(coachGroundingRate({ limit: req.query.limit })); }
  catch (e) { next(e); }
});

export default r;
