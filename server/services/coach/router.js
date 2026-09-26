/**
 * COACH-V2 [0] ROUTE: what kind of question this is, and what answering it costs.
 *
 * Deterministic first ($0, well under 50 ms): regex over the question. Only when
 * no rule matches does a cheap model pick the intent from a fixed schema
 * (Haiku, ~$0.001, `coach:route`), and only when the model is on. The router
 * never answers anything; it picks the intent, the model, the effort and the
 * lookup budget for lane 1 (ask.js).
 *
 *   DO       "what's my next move", "what should I do"
 *   WHY      "why him", "why that trade"
 *   WHAT_IF  "if he says no", "what about team 7", "what if I wait"
 *   ABOUT    "tell me about X", "how is my team", "should I trade A.J."
 *   CHANGE   "go all in", "make the goal the playoffs"
 *   EXPLAIN  "what does 19.6% mean", "what is title odds"
 *   CHAT     "lol ok", "thanks"
 *
 * The plan's own follow-ups (why / if-no / the other one / partner switch) and
 * the starter questions are answered before the router runs (chat.js); the
 * router sees only what goes to the model.
 */
import { callClaude, parseJson } from '../claude.js';
import { COACH_MODEL } from './ask.js';

export const INTENTS = Object.freeze(['DO', 'WHY', 'WHAT_IF', 'ABOUT', 'CHANGE', 'EXPLAIN', 'CHAT']);
export const ROUTE_MODEL = 'claude-haiku-4-5-20251001';
export const MODELS = Object.freeze({ cheap: 'claude-haiku-4-5-20251001', normal: COACH_MODEL, strong: 'claude-opus-5-5' });

const norm = q => String(q ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const TRADE = /\b(trades?|offers?|deals?|packages?|swap|flip|send|sell|buy|acquire|get)\b/;

/** Ordered: the first intent whose rule matches wins. */
const RULES = [
  ['CHAT', [/^((lol|lmao|ok(ay)?|k|thanks?|thank you|thx|cool|nice|got it|sounds good|haha|yep|nope|sure|great|word|bet)[.!, ]*)+$/]],
  ['EXPLAIN', [/\bwhat (does|do|is|are) .{0,40}\b(mean|means)\b/, /\bwhat (is|are) (a |an |the )?(title odds|playoff odds|p\(?yes\)?|se|noise|floor|blue chip|expected|clears? the noise)\b/,
    /\bexplain (what|how)\b/, /\bhow (is|are) .{0,30}(calculated|computed|worked out)\b/, /\bwhat'?s (a|an|the) .{0,20}(number|stat|metric)\b.*\bmean\b/]],
  ['CHANGE', [/\b(go|switch|set|change|make)\b.{0,20}\b(all[- ]?in|safe|balanced|risk mode|goal|objective|tolerance)\b/, /\b(add|remove|drop) (a |the )?stop\b/,
    /\bchange (my|the) (goal|plan|mode)\b/]],
  ['WHAT_IF', [/\bwhat if\b/, /\bwhat about\b/, /\bhow about\b/, /\binstead\b/, /\bif (he|they|she) (say|says|decline|declines|counter|counters)\b/, /\bshould i wait\b/]],
  ['WHY', [/^(but |so |ok |okay )?why\b/, /\bhow come\b/, /\bwhat'?s the (reasoning|case|logic)\b/]],
  ['DO', [/\bnext (move|step|trade)\b/, /\bwhat (should|do|can) i do\b/, /\bwho should i (trade|message|work|target|start|sit|pick up|add)\b/,
    /\b(best|top) (trade|move|offer|deal|target|pickup|add)\b/, /\bwhich (target|trade|move|player) should i\b/, /\bshould i (send|offer|accept|trade|start|sit|add|drop)\b/]],
  ['ABOUT', [/\btell me about\b/, /\bhow (is|are|does|do) (my|his|the)\b/, /\bwhat do you (think|make) of\b/, /\bweak(ness|est)?\b/, /\bstrong(est)?\b/,
    /\bwho (is|are) (my|his)\b/, /\bmy (roster|team|lineup|starters|bench)\b/, /\bmy title odds\b/, /\buntouchables?\b/, /\boverpay\b/]]
];

/** The intent by rule, or null. */
export function ruleIntent(question) {
  const t = norm(question);
  if (!t) return null;
  for (const [intent, rules] of RULES) if (rules.some(rx => rx.test(t))) return intent;
  return null;
}

const ROUTE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['intent'],
  properties: { intent: { enum: INTENTS } }
});
const ROUTE_SYSTEM = `Classify a fantasy-football manager's question to his assistant into exactly one intent:
DO (what to do next), WHY (why the assistant said something), WHAT_IF (a hypothetical or an alternative), ABOUT (tell me about a player, team or my roster), CHANGE (change the plan's goal, risk mode, stops or limits), EXPLAIN (what a number or term means), CHAT (small talk, thanks, acknowledgements).
Reply with only the JSON object.`;

/** The intent from a cheap model, when no rule matched. Never throws for a bad answer: ABOUT is the default. */
async function modelIntent(question) {
  const msg = await callClaude({ feature: 'coach:route', model: ROUTE_MODEL, maxTokens: 64, system: ROUTE_SYSTEM,
    messages: [{ role: 'user', content: String(question).slice(0, 500) }], outputSchema: ROUTE_SCHEMA });
  const parsed = parseJson(msg);
  return { intent: INTENTS.includes(parsed.intent) ? parsed.intent : 'ABOUT', cost_usd: msg.cost_usd ?? 0 };
}

/**
 * Per intent: which model, how hard it thinks, and how many lookup rounds lane 1 gets.
 * Sonnet runs with thinking off on these turns (COACH-V2 latency target, p50 <= 5 s): the
 * bundle already holds the numbers, so the turn is reading and writing, not searching.
 * Opus cannot turn thinking off; it runs at low effort instead.
 */
const FAST = { type: 'disabled' };
export function planFor(intent, question) {
  const trade = TRADE.test(norm(question));
  const sonnet = (effort, toolRounds) => ({ model: MODELS.normal, effort, toolRounds, thinking: FAST });
  switch (intent) {
    case 'CHAT': return { model: MODELS.cheap, effort: null, toolRounds: 0, thinking: null };
    case 'EXPLAIN': return { model: MODELS.cheap, effort: null, toolRounds: 1, thinking: null };
    case 'WHY': return sonnet('low', 1);
    case 'WHAT_IF': return sonnet('low', 1);
    case 'CHANGE': return sonnet('low', 1);
    // COACH-V2: Sonnet for lane 1; Opus when a DO or ABOUT question is about a trade.
    case 'DO': return trade ? { model: MODELS.strong, effort: 'low', toolRounds: 2, thinking: null } : sonnet('low', 2);
    case 'ABOUT':
    default: return trade ? { model: MODELS.strong, effort: 'low', toolRounds: 2, thinking: null } : sonnet('low', 2);
  }
}

/**
 * Route one question for the model path. `hasModel` false: rules only.
 * Returns { intent, by: 'rule' | 'model' | 'default', model, effort, toolRounds, cost_usd }.
 */
export async function routeQuestion(question, { hasModel = true } = {}) {
  const byRule = ruleIntent(question);
  if (byRule) return { intent: byRule, by: 'rule', ...planFor(byRule, question), cost_usd: 0 };
  if (!hasModel) return { intent: 'ABOUT', by: 'default', ...planFor('ABOUT', question), cost_usd: 0 };
  try {
    const m = await modelIntent(question);
    return { intent: m.intent, by: 'model', ...planFor(m.intent, question), cost_usd: m.cost_usd };
  } catch (e) {
    if (e?.code === 'ai_credit') throw e; // the account is out: the turn answers from the plan, once
    console.warn(`[coach] router: the intent model failed (${e?.message ?? e}); answering as ABOUT`);
    return { intent: 'ABOUT', by: 'default', ...planFor('ABOUT', question), cost_usd: 0 };
  }
}
