/**
 * COACH-LANES lane 2: CLAUDE -> JEV. Jev leads this lane.
 *
 * Nick, 2026-09-26: lane 1 is Claude solo (the numbers and the plan). Lane 2
 * feeds Claude's lane-1 read and the context into Jev, and Jev gives its own
 * take from its people / chat perspective. The synthesis then compares Claude
 * with Jev.
 *
 * Jev (typesafe-ai/jev on the Vercel AI Gateway) answers TYPED questions about
 * a state: boolean probabilities and choices, not prose. Jev's take (COACH-V2):
 *   p_accept           P(he takes the offer as it stands)
 *   claude_call_right  P(Claude's call is right for this particular manager)
 *   better_stance      go / wait / avoid, with its probability
 *   basis              willingness / price / timing / roster fit / risk
 * Each answer becomes a ledger cell, so the synthesis cites Jev like any other
 * source, and every Jev line is a chat read (ungraded): it never overrides a
 * number.
 *
 * The state Jev sees is Claude's verified claims, the ids in focus and the
 * STORED people signals (lanes.js#peopleSignals, labels only). Raw chat text
 * never enters it, and league-mate names never do: the manager is MANAGER M1.
 *
 * CALLING JEV. The server's one Jev client is JEV-01a's gateway
 * (server/services/jev/gateway.js, #441), which records cost in ai_usage and the
 * jev_call event. It is not on main yet, so on main this lane reports
 * `unavailable` with that reason and lanes.js falls back to the Claude people
 * lane, labelled as such. To light it up once #441 merges: register
 * COACH_TAKE_TYPE (below) as `coach_take` in jev/questions.js QUESTION_TYPES.
 * Tests (and COACH-V2) inject `ask` instead.
 */

export const JEV_TAKE_VERSION = 1;
export const STANCES = Object.freeze(['go', 'wait', 'avoid']);
export const BASES = Object.freeze(['willingness', 'price', 'timing', 'roster_fit', 'risk']);
export const BASIS_WORDS = Object.freeze({ willingness: 'willingness', price: 'price', timing: 'timing', roster_fit: 'roster fit', risk: 'risk' });
export const JEV_MISSING = 'Jev is not wired for Coach on this build: coach_take is not registered in the Jev question types '
  + '(server/services/jev/questions.js), or the Jev gateway (JEV-01a) is absent.';
/** The one alias Jev ever sees for the manager in focus (COACH-V2: pseudonymised state, 0 names). */
export const MANAGER_ALIAS = 'MANAGER M1';

const bool = (instructions, t, f) => ({ type: 'boolean', instructions, criteria: { true: t, false: f } });

/** The typed questions Jev answers for lane 2 (COACH-V2 section 1 [3]b). */
export const JEV_TAKE_QUESTIONS = Object.freeze({
  p_accept: bool(`Will ${MANAGER_ALIAS} accept the offer on the table as it stands?`, 'He accepts it as sent.', 'He declines, counters or does not reply.'),
  claude_call_right: bool(`Given the STORED PEOPLE SIGNALS about ${MANAGER_ALIAS}, is Claude's call (its stance in the NUMBERS READ) right for this particular manager?`,
    'The people signals support Claude\'s call.', 'The people signals point to a different call.'),
  better_stance: {
    type: 'choice', instructions: `Reading ${MANAGER_ALIAS} as a person, what should Nick do about this deal?`,
    criteria: { go: 'Go: send the served offer.', wait: 'Wait: the timing or his mood is wrong right now.', avoid: 'Avoid: he will not do this deal.' }
  },
  basis: {
    type: 'choice', instructions: `What is the main reason for that stance, as ${MANAGER_ALIAS} reads?`,
    criteria: { willingness: 'Whether he trades at all.', price: 'What he would ask for.', timing: 'When he is ready.',
      roster_fit: 'What his roster needs.', risk: 'What could go wrong with him.' }
  }
});

/** The same questions in JEV-01a's question-type shape, ready to register as `coach_take`. */
export const COACH_TAKE_TYPE = Object.freeze({
  version: JEV_TAKE_VERSION,
  subject: 'manager',
  build: () => JEV_TAKE_QUESTIONS,
  interpret: answers => readTake(answers)
});

/** Jev's typed answers -> the take. A missing or malformed answer is an error, never a default. */
export function readTake(answers) {
  const p = id => {
    const a = answers?.[id];
    if (!a || a.type !== 'boolean' || !Number.isFinite(a.probability)) throw new Error(`Jev returned no usable answer for "${id}"`);
    return Math.min(1, Math.max(0, a.probability));
  };
  const choice = (id, keys) => {
    const c = answers?.[id];
    if (!c || c.type !== 'choice' || !keys.includes(c.choice)) throw new Error(`Jev returned no usable answer for "${id}"`);
    return { choice: c.choice, p: Number.isFinite(c.probabilities?.[c.choice]) ? c.probabilities[c.choice] : null };
  };
  const stance = choice('better_stance', STANCES);
  const basis = choice('basis', BASES);
  return { p_accept: p('p_accept'), claude_call_right: p('claude_call_right'), stance: stance.choice, stance_p: stance.p,
    basis: basis.choice, basis_p: basis.p };
}

/** The state Jev reads: Claude's verified lines, the ids in focus, the stored labels. No chat text, no names, no roster id. */
export function jevState({ question, laneOne, signals, focus = {} }) {
  const lines = (laneOne?.claims ?? []).map(c => `- ${c.text}`);
  return [
    `QUESTION NICK ASKED: ${question}`,
    `NUMBERS READ (Claude, every number checked against the plan):\n${lines.length ? lines.join('\n') : '- (no verified line)'}`,
    `IN FOCUS: ${MANAGER_ALIAS}; players ${(focus.players ?? []).join(', ') || 'none'}; move ${focus.move_id ?? 'none'}.`,
    `STORED PEOPLE SIGNALS ABOUT ${MANAGER_ALIAS} (labels and counts only):\n${JSON.stringify((signals?.rows ?? []).map(({ roster_id, ...r }) => r))}`
  ].join('\n\n');
}

/** Try JEV-01a's gateway; on this build it is absent, and the lane says so. */
async function defaultJevAsk({ state, questions }) {
  let gateway;
  try {
    const mod = await import('../jev/engine-sink.js');
    if (typeof mod.createEngineJevGateway !== 'function') return { ok: false, unavailable: JEV_MISSING };
    // createEngineJevGateway returns { sink, gateway } (jev/engine-sink.js); the client is `gateway`.
    gateway = mod.createEngineJevGateway().gateway;
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') return { ok: false, unavailable: JEV_MISSING };
    throw e;
  }
  if (!gateway.hasKey()) return { ok: false, unavailable: 'Jev has no gateway key here (AI_GATEWAY_API_KEY is not set).' };
  try {
    return await gateway.ask({ qtype: 'coach_take', arm: 'a', state, questions, asOf: new Date().toISOString() });
  } catch (e) {
    if (/unknown Jev question type/.test(e?.message ?? '')) return { ok: false, unavailable: JEV_MISSING };
    throw e;
  }
}

/**
 * Lane 2. `laneOne` is lane 1's answer ({ claims, refusals }); `signals` the
 * stored people signals for the focus. Returns { status: 'ok', take, rows,
 * cost_usd, state } | { status: 'unavailable', reason } | { status: 'failed', reason }.
 */
let askOverride = null;
/** Swap the Jev client (tests, and the JEV LANE unit's wiring); null restores the default. */
export function setJevAsk(fn) { askOverride = fn ?? null; }

export async function jevLane({ question, laneOne, signals, focus = {} }, { ask = askOverride ?? defaultJevAsk } = {}) {
  const state = jevState({ question, laneOne, signals, focus });
  const res = await ask({ state, questions: JEV_TAKE_QUESTIONS });
  if (res?.unavailable) return { status: 'unavailable', reason: res.unavailable };
  if (!res?.ok) return { status: 'failed', reason: `Jev did not answer (${res?.error ?? 'no reason given'})` };
  let take;
  try { take = readTake(res.answers); } catch (e) { return { status: 'failed', reason: e.message }; }
  const rows = [{ source: 'jev', p_accept: take.p_accept, claude_call_right: take.claude_call_right, stance: take.stance,
    stance_p: take.stance_p, basis: BASIS_WORDS[take.basis], basis_p: take.basis_p }];
  return { status: 'ok', take, rows, cost_usd: res.costUsd ?? 0, state };
}

const pct = p => `${Math.round(p * 100)}%`;

/**
 * Jev's take as cited lines, no model (COACH-V2 [3]c). `cite(col)` returns the
 * cite of the recorded jev_take cell. Every line is a chat read (ungraded).
 */
export function jevLines(take, cite) {
  const lines = [
    { text: `Jev: ${pct(take.p_accept)} they take it as sent (from chat, unverified).`, cites: [cite('p_accept')] },
    { text: `Jev: ${take.stance}, mainly on ${BASIS_WORDS[take.basis]} (from chat, unverified).`, cites: [cite('stance'), cite('basis')] },
    { text: take.claude_call_right >= 0.5
      ? `Jev backs Claude's call, ${pct(take.claude_call_right)} (from chat, unverified).`
      : `Jev doubts Claude's call: only ${pct(take.claude_call_right)} that it is right for them (from chat, unverified).`,
    cites: [cite('claude_call_right')] }
  ];
  return lines;
}
