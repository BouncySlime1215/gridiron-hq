/**
 * COACH-LANES: two lanes and one reply, for questions that go to the model.
 *
 *   Lane A (numbers)  askCoach as it always ran: the plan and the app's rows, every
 *                     number cited and checked by verify.js.
 *   Lane B (people)   the same question with the STORED people signals for the
 *                     manager and players in focus: his profile labels (people_read),
 *                     his labelled chat statements (pulse_read) and what his trade
 *                     screenshots showed (chat_trade_interest). Ids, labels and counts
 *                     only; raw chat text never enters a Coach prompt. Every claim it
 *                     makes is a "chat read (ungraded)": it never overrides a number.
 *   Synthesis         one reply from both: where they agree it says so, where they
 *                     disagree it says so plainly ("numbers say X; chat suggests Y
 *                     because ...") with the recommended action. It passes verify.js
 *                     like every Coach answer; when it cannot, Coach shows lane A with
 *                     lane B's lines under their label instead of guessing.
 *
 * A and B run in parallel. B is skipped when nobody is in focus or there is no
 * stored signal for him (then A's answer is the reply, as before). Each lane
 * logs its own model and cost in ai_usage (coach:lane_numbers, coach:lane_people,
 * coach:synth), all under the Coach budget. A turn asked twice reuses its lanes.
 *
 * Coach never sends offers and never builds a trade: the synthesis may only
 * recommend what the numbers lane cited from the served plan.
 */
import { callClaude, parseJson } from '../claude.js';
import { askCoach, ANSWER_SCHEMA, COACH_MODEL } from './ask.js';
import { newLedger } from './ledger.js';
import { verifyAnswer } from './verify.js';
import { peopleRead, pulseRead } from './brain-tools.js';
import { readChatTradeInterest } from '../people/chat-trade-interest.js';
import { db, row } from '../../db/index.js';

export const LANES_ENV = 'GRIDIRON_COACH_LANES';
/** On with the model; GRIDIRON_COACH_LANES=0 turns the people lane and the synthesis off. */
export const lanesOn = (env = process.env) => env[LANES_ENV] !== '0';

export const LANE_MODELS = Object.freeze({ numbers: COACH_MODEL, people: COACH_MODEL, synth: COACH_MODEL, synth_trade: 'claude-opus-5-5' });
export const PEOPLE_LABEL = 'chat read (ungraded)';
const TRADE = /\b(trades?|offers?|deals?|packages?|swap|flip|accept|counter)\b/i;
const PEOPLE_OUTPUT_TOKENS = 3000;
const SYNTH_OUTPUT_TOKENS = 4000;

/* --------------------------------------------------------- people signals */

/**
 * A stored signal value is kept only if it is a label, a count, an id or a
 * short list of player names; anything longer or shaped like speech (quotes,
 * line breaks, first person) is dropped. This is the no-chat-text guard: even a
 * reader that one day returns a quote cannot carry it into a prompt.
 */
const MAX_LABEL = 60;
const SPEECH = /["“”\n\r]|\b(i|i'm|im|i'd|me|my|lol|lmao|u|ur)\b/i;
export function safeSignal(v) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v ?? null;
  if (Array.isArray(v)) {
    const kept = v.map(safeSignal).filter(x => x != null && typeof x !== 'object');
    return kept.length ? kept.join(', ') : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > MAX_LABEL || SPEECH.test(s)) return null;
  return s;
}
const clean = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, safeSignal(v)]).filter(([, v]) => v != null));

const seasonOf = leagueId => row('SELECT season FROM leagues WHERE id = ?', leagueId)?.season ?? null;

/**
 * The stored people signals for the focus partner (and his players), as ledger
 * rows. Null when nobody is in focus or nothing is stored for him.
 */
export function peopleSignals({ leagueId, focus = {}, database = db }) {
  const roster = focus.partner != null ? String(focus.partner) : null;
  const players = new Set((focus.players ?? []).map(String));
  if (!roster && !players.size) return null;
  const rows = [];
  if (roster) {
    for (const p of peopleRead({ league_id: leagueId, roster_id: roster })) {
      if (p.status !== 'ok') continue;
      rows.push(clean({ signal: 'profile', roster_id: roster, in_market: p.in_market, nick_override: p.nick_override,
        wants: p.wants, shopping: p.shopping, untouchable: p.untouchable, profile_confidence: p.profile_confidence,
        p_open_to_trade: p.p_open_to_trade, messages_read: p.messages_read }));
    }
  }
  for (const s of pulseRead({ league_id: leagueId, days: 14 }, { database })) {
    if (s.status !== 'ok' || s.roster_id == null) continue;
    if (roster && String(s.roster_id) !== roster) continue;
    rows.push(clean({ signal: 'statement', roster_id: String(s.roster_id), type: s.type, phrase: s.phrase,
      credible: s.credible, weight: s.weight, ago: s.ago }));
  }
  const season = seasonOf(leagueId);
  if (roster && season != null) {
    const interest = readChatTradeInterest(database, leagueId, season);
    if (interest.status === 'ok') {
      for (const r of interest.rows.filter(x => String(x.roster_id) === roster).slice(0, 5)) {
        rows.push(clean({ signal: 'screenshot', roster_id: roster, kind: r.kind, seen_at: r.seen_at, confidence: r.confidence,
          wants_player_ids: r.wants.map(x => String(x.player_id)), would_give_player_ids: r.would_give.map(x => String(x.player_id)) }));
      }
    }
  }
  const kept = rows.filter(r => Object.keys(r).length > 2);
  return kept.length ? { roster, rows: kept } : null;
}

/* ---------------------------------------------------------------- lane B */

const PEOPLE_SYSTEM = `You are the people lane of Coach, a personal fantasy-football app. You read only the STORED PEOPLE SIGNALS given to you: labels about one league-mate (what he wants, is shopping, calls untouchable, how open to trading he reads, his labelled chat statements, what his trade screenshots showed). They are ungraded reads, not facts, and they never override a number.

Answer the question from those signals only. Every claim must cite the signal cells it stands on (for example r1#0.wants). Never state a number that is not in a cited cell. Never suggest a trade of your own and never offer to send anything. If the signals say nothing useful, return no claims and one refusal saying so.

Reply with ONLY this JSON object: {"claims":[{"text":"...","cites":["r1#0.column"]}],"refusals":["..."],"as_of":null}`;

async function laneB({ question, focus, signals, model = LANE_MODELS.people }) {
  const ledger = newLedger();
  const e = ledger.record({ tool: 'people_read', tables: ['people_signals'], rows: signals.rows,
    columns: [...new Set(signals.rows.flatMap(r => Object.keys(r)))] });
  const prompt = `QUESTION: ${question}\n\nIN FOCUS: roster ${signals.roster ?? 'none'}; players ${(focus.players ?? []).join(', ') || 'none'}.\n\n`
    + `STORED PEOPLE SIGNALS (query ${e.id}; cite as ${e.id}#<row>.<column>):\n${JSON.stringify(signals.rows)}`;
  const msg = await callClaude({ feature: 'coach:lane_people', model, maxTokens: PEOPLE_OUTPUT_TOKENS, system: PEOPLE_SYSTEM,
    messages: [{ role: 'user', content: prompt }], outputSchema: ANSWER_SCHEMA });
  const parsed = parseJson(msg);
  const answer = { claims: (parsed.claims ?? []).filter(c => c?.text).map(c => ({ text: String(c.text), cites: (c.cites ?? []).map(String) })),
    refusals: (parsed.refusals ?? []).map(String), as_of: null };
  const verification = verifyAnswer({ answer, ledger, question });
  // A people line that fails the check is dropped, never softened.
  const bad = new Set(verification.violations.map(v => v.text).filter(Boolean));
  const claims = answer.claims.filter(c => !bad.has(c.text));
  return { answer: { ...answer, claims }, ledger: ledger.toJson(), cost_usd: msg.cost_usd ?? 0, prompt, model };
}

/* --------------------------------------------------------------- merging */

/** Rebuild lane A's ledger, then append lane B's queries under new ids; returns the ledger and B's id map. */
export function mergeLedgers(aJson, bJson) {
  const ledger = newLedger();
  for (const q of aJson?.queries ?? []) ledger.record(q);
  for (const d of aJson?.derived ?? []) ledger.derive({ op: d.op, inputs: d.inputs, label: d.label });
  const map = new Map();
  for (const q of bJson?.queries ?? []) map.set(q.id, ledger.record(q).id);
  const remap = cite => {
    const m = /^(r\d+)(#.*)$/.exec(cite);
    return m && map.has(m[1]) ? `${map.get(m[1])}${m[2]}` : cite;
  };
  return { ledger, remap };
}

const SYNTH_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['claims', 'refusals', 'as_of', 'disagreement', 'action'],
  properties: {
    claims: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'cites', 'lane'],
      properties: { text: { type: 'string' }, cites: { type: 'array', items: { type: 'string' } }, lane: { enum: ['numbers', 'people', 'both'] } } } },
    refusals: { type: 'array', items: { type: 'string' } },
    as_of: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    disagreement: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    action: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  }
});

const SYNTH_SYSTEM = `You write Coach's one reply from two lanes that answered the same question.

NUMBERS lane: grounded in the plan and the app's data. PEOPLE lane: ungraded reads of stored chat signals about a league-mate. Numbers win: a people read never changes a number and never makes a trade look better than the numbers say.

Write short claims a person can act on. Every claim keeps the cites of the lane lines it comes from (copy them exactly) and says which lane it rests on ("numbers", "people" or "both"). A claim resting on the people lane must say it is a chat read. Never write a number that is not in the lines you were given.

If the lanes agree, say so in one claim. If they disagree, fill "disagreement" with one plain sentence in the form "Numbers say X; chat suggests Y because Z." and "action" with what to do (only something the numbers lane already supports). Otherwise both are null. Never suggest sending anything for Nick, and never suggest a trade that is not in the numbers lane.

Reply with ONLY the JSON object in the schema.`;

async function synthesize({ question, a, b, ledger, remap, model }) {
  const lines = (lane, claims, map = x => x) => claims.map(c => ({ lane, text: c.text, cites: c.cites.map(map) }));
  const given = [...lines('numbers', a.answer.claims), ...lines('people', b.answer.claims, remap)];
  const prompt = `QUESTION: ${question}\n\nLANE LINES:\n${JSON.stringify(given)}\n\nNUMBERS LANE REFUSALS: ${JSON.stringify(a.answer.refusals)}`;
  const msg = await callClaude({ feature: 'coach:synth', model, maxTokens: SYNTH_OUTPUT_TOKENS, system: SYNTH_SYSTEM,
    messages: [{ role: 'user', content: prompt }], outputSchema: SYNTH_SCHEMA });
  const parsed = parseJson(msg);
  const peopleCites = new Set(given.filter(g => g.lane === 'people').flatMap(g => g.cites));
  const claims = (parsed.claims ?? []).filter(c => c?.text).map(c => {
    const cites = (c.cites ?? []).map(String);
    const lane = cites.every(x => peopleCites.has(x)) && cites.length ? 'people' : (cites.some(x => peopleCites.has(x)) ? 'both' : 'numbers');
    const text = lane === 'people' && !/chat read/i.test(c.text) ? `${c.text} (${PEOPLE_LABEL})` : c.text;
    return { text, cites, lane };
  });
  const all = given.flatMap(g => g.cites);
  const extra = [parsed.disagreement, parsed.action].filter(t => typeof t === 'string' && t.trim())
    .map(t => ({ text: t.trim(), cites: [...new Set(all)] }));
  const answer = { claims, refusals: (parsed.refusals ?? []).map(String), as_of: parsed.as_of ?? a.answer.as_of ?? null };
  const verification = verifyAnswer({ answer: { ...answer, claims: [...claims, ...extra] }, ledger, question });
  return { answer, disagreement: parsed.disagreement ?? null, action: parsed.action ?? null, verification, cost_usd: msg.cost_usd ?? 0, prompt };
}

/** When the synthesis cannot stand up: lane A as it was, lane B's lines under their label. */
function fallback(a, b, remap) {
  const people = b.answer.claims.map(c => ({ text: `Chat read (ungraded): ${c.text}`, cites: c.cites.map(remap), lane: 'people' }));
  return { claims: [...a.answer.claims.map(c => ({ ...c, lane: 'numbers' })), ...people], refusals: a.answer.refusals, as_of: a.answer.as_of };
}

/* ------------------------------------------------------------ the turn */

const cache = new Map();
const CACHE_MAX = 50;
const cacheKey = (threadId, question, focus) => `${threadId}|${question}|${JSON.stringify(focus ?? {})}`;

/**
 * Answer through both lanes. `askArgs` are askCoach's arguments for lane A.
 * Returns askCoach's shape with `answer`/`ledger` replaced by the reply and
 * `lanes` describing each lane (for the "Numbers + People" reveal).
 */
export async function answerWithLanes({ question, askArgs, focus = {}, leagueId, threadId = null, signals = undefined }) {
  const key = cacheKey(threadId, question, focus);
  if (threadId != null && cache.has(key)) return { ...cache.get(key), cached: true };
  const people = signals === undefined ? peopleSignals({ leagueId, focus }) : signals;
  if (!people) {
    // No people lane: this is the ordinary chat answer, logged as one.
    const a = await askCoach(askArgs);
    return { ...a, lanes: { numbers: { claims: a.answer.claims.length }, people: { skipped: 'nobody in focus has a stored people signal' } } };
  }
  const [a, b] = await Promise.all([askCoach({ ...askArgs, feature: 'coach:lane_numbers' }), laneB({ question, focus, signals: people })]);
  const { ledger, remap } = mergeLedgers(a.ledger, b.ledger);
  let reply;
  let synth = null;
  if (!b.answer.claims.length) {
    reply = { claims: a.answer.claims.map(c => ({ ...c, lane: 'numbers' })), refusals: a.answer.refusals, as_of: a.answer.as_of };
  } else {
    synth = await synthesize({ question, a, b, ledger, remap, model: TRADE.test(question) ? LANE_MODELS.synth_trade : LANE_MODELS.synth });
    reply = synth.verification.ok ? synth.answer : fallback(a, b, remap);
  }
  const lanes = {
    numbers: { claims: a.answer.claims.map(c => c.text), refusals: a.answer.refusals, cost_usd: a.cost_usd ?? 0 },
    people: { claims: b.answer.claims.map(c => `${c.text}`), refusals: b.answer.refusals, cost_usd: b.cost_usd, label: PEOPLE_LABEL },
    disagreement: synth?.verification.ok ? synth.disagreement : null,
    action: synth?.verification.ok ? synth.action : null,
    synthesis: synth ? (synth.verification.ok ? 'ok' : 'fell_back') : 'skipped',
    cost_usd: { numbers: a.cost_usd ?? 0, people: b.cost_usd, synth: synth?.cost_usd ?? 0 }
  };
  const out = { ...a, answer: reply, ledger: ledger.toJson(), lanes,
    cost_usd: (a.cost_usd ?? 0) + b.cost_usd + (synth?.cost_usd ?? 0) };
  if (threadId != null) {
    cache.set(key, out);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return out;
}

/** Tests: forget cached turns. */
export const clearLaneCache = () => cache.clear();
