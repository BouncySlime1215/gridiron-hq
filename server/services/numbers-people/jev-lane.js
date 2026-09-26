/**
 * NUMBERS-PEOPLE lane 2, "Claude -> Jev": Claude's read of one key item is fed to Jev, and Jev
 * leads the lane with its own take from the people side.
 *
 * The Jev stage is COACH-LANES' (server/services/coach/jev-lane.js, #488): the same typed
 * questions (JEV_TAKE_QUESTIONS: p_accept, claude_call_right, better_stance, basis), the same
 * pseudonymised state (MANAGER M1, stored people-signal labels only, no roster ids, no chat text)
 * and the same strict reading of the answers (readTake). This file only adapts one plan item to
 * that stage and supplies the Jev client.
 *
 * THE JEV CLIENT. The server's one Jev client is meant to be JEV-01a's gateway (#441, open, not on
 * main); without it coach/jev-lane.js reports "unavailable". So this lane calls Jev directly the way
 * the Jev scripts do (build-manager-archetypes.mjs: ai's experimental_evaluate on typesafe-ai/jev,
 * AI_GATEWAY_API_KEY read for presence only) and records the cost in ai_usage as
 * numbers_people:jev. When #441 lands, pass its gateway's ask as `ask` and delete directJevAsk.
 * Jev is not budget-capped (Nick, 9/23: no Jev limits).
 *
 * Interface: `jevLane(input) -> take`, input { item: {key, kind, move_id?, players?}, facts, claude:
 * {stance, basis, why}, signals: [labels] }; take { lead: 'jev', stance, basis, why, probabilities,
 * cost_usd } or { skipped, reason }.
 */
import { recordUsage } from '../claude.js';
import { jevLane as jevStage } from '../coach/jev-lane.js';

export const JEV_MODEL = 'typesafe-ai/jev';
export const JEV_KEY_ENV = 'AI_GATEWAY_API_KEY';
export const JEV_FEATURE = 'numbers_people:jev';
const LEAN = 0.5;

const defaultEvaluate = async args => (await import('ai')).experimental_evaluate(args);

/** A Jev client with the shape coach/jev-lane.js expects: ({state, questions}) -> {ok, answers, costUsd} | {unavailable} | {ok: false, error}. */
export function directJevAsk({ evaluate = defaultEvaluate, env = process.env, record = recordUsage } = {}) {
  return async ({ state, questions }) => {
    if (!env[JEV_KEY_ENV]) return { ok: false, unavailable: `Jev has no gateway key here (${JEV_KEY_ENV} is not set).` };
    let result;
    try {
      result = await evaluate({ model: JEV_MODEL, state, questions });
    } catch (e) {
      const status = e?.statusCode ?? e?.status ?? null;
      return { ok: false, error: `${status ? `${status} ` : ''}${String(e?.message ?? e)}`.slice(0, 200) };
    }
    const usage = { input_tokens: result?.usage?.inputTokens ?? 0, output_tokens: result?.usage?.outputTokens ?? 0 };
    return { ok: true, answers: result?.answers, costUsd: record(JEV_FEATURE, JEV_MODEL, usage) ?? 0 };
  };
}

/** Jev's one-line why, written from its answers (no numbers: those are the lane's cited numbers). */
export function jevWhy({ stance, claude, backs, accept }) {
  const same = stance === claude.stance;
  const deal = accept == null ? null : accept >= LEAN ? 'he reads as likely to take a fair offer' : 'he does not read as likely to accept';
  let side;
  if (same) side = backs == null || backs >= LEAN ? 'The chat read backs Claude\'s call' : 'Same call as Claude, though the chat gives it little support';
  else side = backs != null && backs >= LEAN ? 'The chat read partly backs Claude' : 'The chat read cuts against Claude\'s call';
  const turn = same ? '' : `, so Jev says ${stance} instead of ${claude.stance}`;
  return `${[side, deal].filter(Boolean).join('; ')}${turn}.`;
}

/** One plan item as the stage's lane-one read: Claude's call and the plan facts it read. */
function laneOneOf({ item, facts, claude }) {
  const call = `Claude's call on this ${item.kind}: ${claude.stance.toUpperCase()}.${claude.why ? ` ${claude.why}` : ''}`;
  return { claims: [{ text: call }, ...Object.values(facts).map(f => ({ text: `${f.means}: ${f.value}` }))] };
}

export function createJevLane({ ask = directJevAsk() } = {}) {
  return async function jevLane(input) {
    const res = await jevStage({
      question: `What should Nick do about this ${input.item.kind} right now?`,
      laneOne: laneOneOf(input),
      signals: { rows: input.signals.map(({ ref, ...r }) => r) },
      focus: { move_id: input.item.move_id ?? null, players: input.item.players ?? [] }
    }, { ask });
    if (res.status !== 'ok') {
      if (res.status === 'failed') console.warn(`[numbers-people] Jev did not answer for ${input.item.key}: ${res.reason}`);
      return { skipped: res.status === 'unavailable' ? 'jev_not_configured' : 'jev_failed', reason: res.reason };
    }
    const t = res.take;
    return {
      lead: 'jev', stance: t.stance, basis: t.basis,
      why: jevWhy({ stance: t.stance, claude: input.claude, backs: t.claude_call_right, accept: t.p_accept }),
      probabilities: { stance: t.stance_p, backs_claude: t.claude_call_right, accept: t.p_accept },
      cost_usd: res.cost_usd ?? 0
    };
  };
}
