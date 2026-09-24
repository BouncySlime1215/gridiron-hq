/**
 * CAMPAIGN-01f/g: itinerary (destination + stops), the trade-off of adding a
 * stop, and the speed curve (arrive by week N at cost) (pure).
 */

import { teamLabel } from './playbook.js';

/** Days one negotiation takes (offer, answer, maybe one counter). Hand-set, not fitted. */
export const DAYS_PER_STEP = 2;

/** When a plan lands: independent offers run in parallel, a chained one waits for each leg. */
export function arrivalWeek(plan, currentWeek, { daysPerStep = DAYS_PER_STEP, parallel = true, daysLeftInWeek = 7 } = {}) {
  const days = plan.chained || !parallel ? plan.steps.length * daysPerStep : daysPerStep;
  if (days <= daysLeftInWeek) return currentWeek;
  return currentWeek + 1 + Math.floor((days - daysLeftInWeek - 1) / 7);
}

/** True when step i's get is given on by a later step (a flip, not a keep). */
const passesOnAt = (plan, i) => plan.steps.slice(i + 1).some(t => t.give.some(id => plan.steps[i].get.includes(id)));

/**
 * TEAM-NAMES-2: a plan stop's label ('Flip X from <team>'); the team reads playbook.js#teamLabel.
 * nm: player id -> name. view.js calls it again with the entry's teams map.
 */
export function planStopLabel(plan, i, nm, teams = null) {
  const s = plan.steps[i];
  return `${passesOnAt(plan, i) ? 'Flip' : 'Get'} ${s.get.map(nm).join(' + ')} from ${teamLabel(teams, s.team)}`;
}

/**
 * The itinerary: stops from the chosen plan plus Nick's own stops (objectives file), untouchables,
 * and conflicts (a plan step that sells an untouchable, a Nick stop the plan cannot reach).
 */
export function buildItinerary(plan, objective, { names = {}, teams = null } = {}) {
  const nm = id => names[id] ?? `player ${id}`;
  const stops = [];
  const received = new Set();
  (plan?.steps ?? []).forEach((s, i) => {
    const passesOn = passesOnAt(plan, i);
    for (const id of s.get) received.add(id);
    stops.push({ id: `plan-${i}`, order: i, kind: passesOn ? 'flip' : 'get',
      label: planStopLabel(plan, i, nm, teams),
      status: i === 0 ? 'next' : 'waiting', added_by: 'plan', p_yes: s.p, odds_after: s.delta });
  });
  const conflicts = [];
  const untouch = new Set(objective.untouchables ?? []);
  for (const s of plan?.steps ?? []) {
    for (const id of s.give) if (untouch.has(String(id))) conflicts.push({ text: `This sells ${nm(id)}, who is untouchable.` });
  }
  (objective.stops ?? []).forEach((st, j) => {
    const player = st.player != null ? String(st.player) : null;
    const done = st.kind === 'get' && player && received.has(player);
    stops.push({ id: st.id ?? `nick-${j}`, order: stops.length, kind: ['get', 'sell', 'cover_bye', 'claim', 'custom'].includes(st.kind) ? st.kind : 'custom',
      label: st.label ?? (st.kind === 'cover_bye' ? `Cover the week ${st.week} bye` : `${st.kind === 'sell' ? 'Sell' : 'Get'} ${player ? nm(player) : ''}`.trim()),
      status: done ? 'next' : 'waiting', added_by: st.added_by === 'coach' ? 'coach' : 'nick' });
    if (st.kind === 'sell' && player && untouch.has(player)) conflicts.push({ text: `Selling ${nm(player)} conflicts with untouchable.` });
  });
  return { version: objective.version ?? 0, stops, untouchables: [...untouch], conflicts };
}

/**
 * The trade-off of adding a stop, on the same dice:
 *   without  best plan's score without the stop (objective units)
 *   with     best plan's score that also satisfies the stop
 *   gain     what the stop itself buys (e.g. week-9 points, the player's own value), optional
 * verdict: worth_it when net >= 0, close when |net| is inside the noise (se), else not_worth_it.
 */
export function stopTradeOff({ label, without, with: withStop, gain = null, gain_text = '', se = null }) {
  if (!without || !withStop) {
    return { stop_label: label, status: 'unreachable', because: 'no plan reaches this stop inside the sliders' };
  }
  const cost = without.score - withStop.score;
  const net = -cost + (gain ?? 0);
  const noise = se ?? 0;
  const verdict = Math.abs(net) <= noise ? 'close' : net >= 0 ? 'worth_it' : 'not_worth_it';
  return {
    stop_label: label, cost, extra_steps: withStop.steps.length - without.steps.length,
    gain: gain ?? 0, gain_text, net, verdict,
    because: verdict === 'close' ? 'the difference is inside the simulation noise'
      : verdict === 'worth_it' ? 'the stop pays for its detour' : 'the detour costs more than the stop gains',
    new_next_move_changes: JSON.stringify(without.steps[0]) !== JSON.stringify(withStop.steps[0]),
  };
}

/**
 * The speed curve: for each arrive-by week N from now to the deadline, the best plan that lands by N
 * and what speed costs versus the unconstrained best. Plans are already ranked (best first) with
 * `score`, `expected`, `sd`. Speed levers: parallel offers (independent steps) always on; a chained
 * plan that is too slow is dropped for that N.
 */
export function speedCurve(ranked, { currentWeek, deadlineWeek, daysPerStep = DAYS_PER_STEP, daysLeftInWeek = 7 }) {
  if (!ranked.length || !Number.isInteger(currentWeek)) return [];
  const last = Number.isInteger(deadlineWeek) ? deadlineWeek : currentWeek + 4;
  const top = ranked[0];
  const out = [];
  for (let n = currentWeek; n <= Math.max(last, currentWeek); n++) {
    const fit = ranked.find(p => arrivalWeek(p, currentWeek, { daysPerStep, daysLeftInWeek }) <= n) ?? null;
    if (!fit) continue;
    out.push({
      arrive_by: n,
      cost: top.score - fit.score,
      net: fit.score,
      expected: fit.expected,
      variance_note: fit.sd > top.sd ? 'wider range of outcomes than the unhurried plan' : 'no wider than the unhurried plan',
      offers_used: fit.steps.length,
      parallel: !fit.chained && fit.steps.length > 1,
      before_deadline: n <= last,
      first_step: fit.steps[0],
    });
  }
  return out;
}
