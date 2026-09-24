/**
 * REASON-01 producer: reasoning panels for the deck of every league, run
 * offline inside the campaign producer (plan-reasoning.js) and never on a web
 * request.
 *
 * Cost guard, in order:
 * 1. Only the top card + deck (cards.js MAX_CARDS_PER_LEAGUE) ever reaches a
 *    prompt.
 * 2. A card whose inputs have not changed since the last refresh reuses its
 *    panel (same fingerprint) and costs nothing.
 * 3. One call per league, held against that league's existing in-app daily
 *    pot, `trade_proposals:league-<id>` (llm-budget.js budgetScopeFor): the
 *    cap Nick approved for Trade Brain-style reasoning. callClaude refuses
 *    before spending once the pot is used, and that refusal turns the
 *    league's panels into "unknown: today's allowance is spent", not an error.
 * 4. Every call is logged with its cost (ai_usage via callClaude, and the
 *    `calls` list here, which run.mjs prints).
 */
import crypto from 'node:crypto';
import { callClaude as liveCallClaude, parseJson as liveParseJson } from '../claude.js';
import { cardsForLeague, factsForCard, recentNews, cleanLabels, partnerFor, leagueIdOf } from './cards.js';
import { groundSections } from './ground.js';
import { reasoningPrompt, REASONING_SYSTEM } from './prompt.js';
import { assemblePanel, PRODUCER, PRODUCER_VERSION } from './panel.js';
import { panelErrors } from './schema.js';

export const DEFAULT_MODEL = 'claude-sonnet-5';
// Sonnet 5 thinks by default and thinking counts toward max_tokens
// (trade-proposals.js liveCaller, 2026-09-23): low effort, room for six panels.
const MAX_TOKENS = 12000;

export const budgetFeatureFor = leagueId => `trade_proposals:league-${leagueId}:reasoning`;

function fingerprintOf(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function partnerHasData(partner) {
  if (!partner) return false;
  return partner.p_responds?.status === 'ok' || (partner.roster_holes?.length ?? 0) > 0 || Object.keys(partner.paper_values ?? {}).length > 0
    || (partner.recent_moves?.length ?? 0) > 0 || cleanLabels(partner.chat_labels).labels.length > 0;
}

function contextFor(card, league, leagueNews, asOf, model) {
  const news = recentNews(leagueNews, card, asOf);
  const facts = factsForCard({ card, league, news });
  const omit = [];
  const omitReason = {};
  if (!card.reply_table.length) { omit.push('counter'); omitReason.counter = 'no_reply_table'; }
  if (!partnerHasData(partnerFor(league, card.partner_team))) { omit.push('his_side'); omitReason.his_side = 'no_partner'; }
  // No feed at all is not the same as a quiet 48 h: say the check did not run.
  if (!Array.isArray(leagueNews)) { omit.push('news_check'); omitReason.news_check = 'no_news_feed'; }
  const promptOmit = news.length ? omit : [...omit, 'news_check'];
  const fingerprint = fingerprintOf({ card, facts, news: news.map(n => n.id), v: PRODUCER_VERSION, model });
  return { card, news, facts, omit, omitReason, promptOmit, fingerprint };
}

const isBudgetRefusal = e => e?.code === 'LLM_BUDGET_EXHAUSTED';

/**
 * @param {object} args
 * @param {object} args.plans              { as_of, leagues[] }: contract league entries (plans-schema.js)
 * @param {object} [args.news]             news per league id: { "<league>": [{ id, published_at, player_ids, headline }] };
 *                                         a league with no list gets news_check 'unknown', not an empty check
 * @param {object} [args.previous]         the last output of this function, for reuse
 * @param {boolean} [args.dryRun]          build everything but make no call
 * @param {Function} [args.callClaude]     injected in tests; defaults to claude.js
 * @param {Function} [args.log]            one line per call (cost included)
 */
export async function produceReasoning({ plans, news = {}, previous = null, dryRun = false, model = DEFAULT_MODEL,
  callClaude = liveCallClaude, parseJson = liveParseJson, log = () => {} }) {
  const asOf = plans?.as_of;
  if (!asOf || !Number.isFinite(Date.parse(asOf))) throw new Error('plans.as_of is missing or not a date; news cannot be windowed without it');

  const prior = new Map();
  for (const l of previous?.leagues ?? []) {
    for (const p of l.panels ?? []) if (p.cost?.call_ok) prior.set(`${l.league_id}|${p.card_id}`, p);
  }

  const leagues = [];
  const calls = [];
  for (const league of plans.leagues ?? []) {
    const leagueId = leagueIdOf(league);
    const { cards, dropped } = cardsForLeague(league);
    const contexts = cards.map(c => contextFor(c, league, news?.[String(leagueId)], asOf, model));
    const panels = new Array(contexts.length);

    const todo = [];
    contexts.forEach((ctx, i) => {
      const old = prior.get(`${leagueId}|${ctx.card.id}`);
      if (old && old.fingerprint === ctx.fingerprint) panels[i] = { ...old, rank: ctx.card.rank, cost: { ...old.cost, reused: true } };
      else todo.push(i);
    });

    let written = null;
    let missing = null;
    let call = null;
    if (todo.length && dryRun) {
      missing = 'dry_run';
    } else if (todo.length) {
      const feature = budgetFeatureFor(leagueId);
      call = { league_id: leagueId, feature, model, cards: todo.length, cost_usd: 0, outcome: 'ok' };
      try {
        const msg = await callClaude({
          feature, model, maxTokens: MAX_TOKENS, effort: 'low', system: REASONING_SYSTEM,
          prompt: reasoningPrompt(todo.map(i => ({ ...contexts[i], omit: contexts[i].promptOmit })))
        });
        call.cost_usd = msg.cost_usd ?? 0;
        call.input_tokens = msg.usage?.input_tokens ?? null;
        call.output_tokens = msg.usage?.output_tokens ?? null;
        try {
          const parsed = parseJson(msg);
          written = new Map((Array.isArray(parsed?.panels) ? parsed.panels : []).map(p => [String(p?.card_id), p]));
        } catch (e) {
          call.outcome = 'unparsed';
          call.error = e.message;
          missing = 'unparsed';
        }
      } catch (e) {
        if (isBudgetRefusal(e)) { call.outcome = 'capped'; missing = 'capped'; }
        else { call.outcome = 'failed'; call.error = e.message; missing = 'failed_call'; }
      }
      calls.push(call);
      log(call);
    }

    for (const i of todo) {
      const ctx = contexts[i];
      const w = written?.get(String(ctx.card.id)) ?? null;
      const grounded = w ? groundSections({ written: w, facts: ctx.facts, newsIds: ctx.news.map(n => n.id) }) : null;
      panels[i] = assemblePanel({
        ...ctx, league, leagueId, grounded, missing: w ? null : (missing ?? 'not_returned'), asOf,
        cost: { reused: false, call_ok: Boolean(w), model, call_cost_usd: call?.cost_usd ?? 0 }
      });
    }

    for (const p of panels) {
      const errors = panelErrors(p);
      if (errors.length) throw new Error(`reasoning panel ${p.card_id} (league ${leagueId}) breaks its contract: ${errors.join('; ')}`);
    }
    leagues.push({ league_id: leagueId, dropped_cards: dropped, panels });
  }

  return {
    producer: PRODUCER, producer_version: PRODUCER_VERSION, model,
    as_of: asOf, snapshot_id: plans.snapshot_id ?? null,
    leagues, calls,
    total_cost_usd: calls.reduce((s, c) => s + (c.cost_usd ?? 0), 0)
  };
}
