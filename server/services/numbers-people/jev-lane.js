/**
 * NUMBERS-PEOPLE lane 2, "Claude -> Jev": Claude's read of one key item is fed to Jev, and Jev
 * leads the lane with its own take from the people side.
 *
 * The Jev stage is COACH-LANES' (server/services/coach/jev-lane.js, #488): the same typed
 * questions (coach_take: p_accept, claude_call_right, better_stance, basis), the same
 * pseudonymised state (MANAGER M1, stored people-signal labels only, no roster ids, no chat text)
 * and the same strict reading of the answers. The Jev client is the stage's own: JEV-01a's gateway
 * (server/services/jev/gateway.js, #489), which records each call's cost in ai_usage (jev:coach_take)
 * and a jev.call event. This file only adapts one plan item to that stage. Jev is not budget-capped
 * (Nick, 9/23: no Jev limits).
 *
 * Interface: `jevLane(input) -> take`, input { item: {key, kind, move_id?, players?}, facts, claude:
 * {stance, basis, why}, signals: [labels] }; take { lead: 'jev', stance, basis, why, probabilities,
 * cost_usd } or { skipped, reason }. Tests pass recorded replies as `ask`.
 */
import { jevLane as jevStage } from '../coach/jev-lane.js';

const LEAN = 0.5;

/** Jev's one-line why, written from its answers (no numbers: those are the lane's cited numbers). */
export function jevWhy({ stance, claude, backs, accept }) {
  const same = stance === claude.stance;
  const deal = accept == null ? null : accept >= LEAN ? 'ready to deal now' : 'not ready to deal yet';
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

export function createJevLane({ ask = undefined } = {}) {
  return async function jevLane(input) {
    const res = await jevStage({
      question: `What should Nick do about this ${input.item.kind} right now?`,
      laneOne: laneOneOf(input),
      signals: { rows: input.signals.map(({ ref, ...r }) => r) },
      focus: { move_id: input.item.move_id ?? null, players: input.item.players ?? [] }
    }, ask ? { ask } : {});
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
