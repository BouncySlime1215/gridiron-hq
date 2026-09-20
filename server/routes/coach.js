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
import { requireAuthenticated } from '../platform/auth.js';
import { legacyRateLimit } from '../platform/legacy-access.js';
import { getApiKey } from '../services/claude.js';
import { askCoach } from '../services/coach/ask.js';
import { catalog, readableTables, catalogCoverage } from '../services/coach/catalog.js';
import { recentCoachAnswers, coachGroundingRate } from '../services/coach/audit.js';

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
  if (!getApiKey()) {
    return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
  }

  if (!wantsStream(req)) {
    try {
      res.json(await askCoach({ question, context, leagueId }));
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
    const result = await askCoach({ question, context, leagueId, onEvent: event => send(res, event) });
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

/** How often the grounding check has stopped something. */
r.get('/grounding', requireAuthenticated, (req, res, next) => {
  try { res.json(coachGroundingRate({ limit: req.query.limit })); }
  catch (e) { next(e); }
});

export default r;
