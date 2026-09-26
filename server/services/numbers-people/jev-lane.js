/**
 * NUMBERS-PEOPLE lane 2, "Claude -> Jev": Claude's read of an item is fed to Jev, and Jev leads
 * the lane. Jev (typesafe-ai/jev on the Vercel AI Gateway) answers typed questions about one
 * state: here the item's plan facts, Claude's call on it, and the STORED people signals for the
 * league-mates on it (coach/lanes.js#peopleSignals: labels, counts and ids; no chat text; no
 * league-mate names). Jev gives its own take from the people side:
 *
 *   stance        choice: go / wait / avoid                      -> the lane's stance
 *   basis         choice: the one thing that decides it           -> the lane's basis
 *   backs_claude  boolean: do the people signals support Claude's call?
 *   willing       boolean: does the other manager read as willing to deal right now?
 *
 * Jev returns probabilities, not prose, so the one-line why is written here from its answers
 * (no numbers in it; the probabilities are shown as the lane's cited numbers).
 *
 * The interface is `jevLane(input) -> take`. What is on main today is the call path the Jev
 * scripts use (build-manager-archetypes.mjs: ai's experimental_evaluate, AI_GATEWAY_API_KEY);
 * JEV-01a (#441, open) adds the one server Jev client (server/services/jev/gateway.js, with the
 * engine event log and runaway monitor). When it lands, `createJevLane({ evaluate })` should
 * be given that gateway's ask instead of the direct call. Spend is logged in ai_usage as
 * numbers_people:jev; Jev is not budget-capped (Nick, 9/23: no Jev limits).
 */
import { recordUsage } from '../claude.js';

export const JEV_MODEL = 'typesafe-ai/jev';
export const JEV_KEY_ENV = 'AI_GATEWAY_API_KEY';
export const JEV_FEATURE = 'numbers_people:jev';
const LEAN = 0.5;

export const JEV_QUESTIONS = Object.freeze({
  stance: { type: 'choice', instructions: 'Taking the people signals into account, and knowing CLAUDE\'s call from the numbers, what should NICK do about this item right now?',
    criteria: { go: 'Go: act on it this week.', wait: 'Wait: not yet; keep watching.', avoid: 'Avoid: do not pursue it.' } },
  basis: { type: 'choice', instructions: 'Which ONE thing decides that call?',
    criteria: { title_gain: 'What it does to the odds the plan chases.', price: 'What it costs NICK in value.',
      willingness: 'Whether the other manager will deal.', roster_fit: 'NICK\'s lineup need.',
      risk: 'Injury, volatility, or a guess too weak to lean on.', timing: 'Why now, or why not now.' } },
  backs_claude: { type: 'boolean', instructions: 'Do the people signals SUPPORT CLAUDE\'s call on this item (rather than cut against it)?' },
  willing: { type: 'boolean', instructions: 'From the people signals only: does the other manager read as willing to make a deal with NICK right now?' }
});

/** The Jev state for one item: facts, Claude's call, the stored signals. Ids and labels only. */
export function jevState({ item, facts, claude, signals }) {
  const lines = [
    `Fantasy football trade planning. NICK is the user. Item: ${item.kind} (${item.key}).`,
    'PLAN FACTS (numbers from the app\'s plan):',
    ...Object.entries(facts).map(([k, f]) => `- ${f.means}: ${f.value}`),
    `CLAUDE's call from the numbers alone: ${claude.stance.toUpperCase()}, decided on ${claude.basis.replace(/_/g, ' ')}.${claude.why ? ` Claude: ${claude.why}` : ''}`,
    'STORED PEOPLE SIGNALS about the other manager(s) on this item (ungraded chat reads; labels only):',
    ...signals.map(s => `- ${Object.entries(s).filter(([k]) => k !== 'ref').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('; ')}`)
  ];
  return lines.join('\n');
}

const pick = a => (a?.choice ?? (a?.probabilities ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] : null)) ?? null;
const prob = (a, key) => (a?.type === 'boolean' ? a.probability : a?.probabilities?.[key]) ?? null;

/** Jev's one-line why, written from its answers (no numbers: those are the lane's cites). */
export function jevWhy({ stance, claude, backs, willing }) {
  const side = backs == null ? '' : backs >= LEAN ? 'The chat read backs Claude\'s call' : 'The chat read cuts against Claude\'s call';
  const deal = willing == null ? '' : willing >= LEAN ? 'he reads as open to a deal' : 'he does not read as ready to deal';
  const turn = stance !== claude.stance ? `, so Jev says ${stance} instead of ${claude.stance}` : '';
  const text = [side, deal].filter(Boolean).join('; ');
  return text ? `${text}${turn}.` : `Jev says ${stance}.`;
}

const defaultEvaluate = async args => (await import('ai')).experimental_evaluate(args);

/**
 * `jevLane(input) -> take`. input: { item: {key, kind}, facts: {key: {value, means}}, claude:
 * {stance, basis, why}, signals: [{ref, ...labels}] }. take: { lead: 'jev', stance, basis, why,
 * probabilities, cost_usd } or { skipped } when Jev is not configured or failed.
 */
export function createJevLane({ evaluate = defaultEvaluate, env = process.env, record = recordUsage } = {}) {
  return async function jevLane(input) {
    if (!env[JEV_KEY_ENV]) return { skipped: 'jev_not_configured' };
    const state = jevState(input);
    let result;
    try {
      result = await evaluate({ model: JEV_MODEL, state, questions: JEV_QUESTIONS });
    } catch (e) {
      const status = e?.statusCode ?? e?.status ?? null;
      console.warn(`[numbers-people] Jev call failed for ${input.item.key}: ${status ? `${status} ` : ''}${String(e?.message ?? e).slice(0, 200)}`);
      return { skipped: 'jev_failed' };
    }
    const a = result?.answers ?? {};
    const stance = pick(a.stance);
    const basis = pick(a.basis);
    if (!['go', 'wait', 'avoid'].includes(stance) || !basis) return { skipped: 'jev_no_answer' };
    const usage = { input_tokens: result?.usage?.inputTokens ?? 0, output_tokens: result?.usage?.outputTokens ?? 0 };
    const cost = record(JEV_FEATURE, JEV_MODEL, usage) ?? 0;
    const backs = prob(a.backs_claude);
    const willing = prob(a.willing);
    return {
      lead: 'jev', stance, basis, why: jevWhy({ stance, claude: input.claude, backs, willing }),
      probabilities: { stance: prob(a.stance, stance), backs_claude: backs, willing },
      cost_usd: cost, state_chars: state.length
    };
  };
}
