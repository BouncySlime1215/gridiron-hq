/**
 * CAMPAIGN-01g: the speed curve and the priced speed levers (pure).
 *
 * "Arrive by week N at cost X", read from the planner's own ranked paths, not
 * from templates. Every route is a sequence of negotiation ROUNDS on the clock:
 * a plan takes DAYS_PER_STEP days when its steps are independent (sent in
 * parallel) and steps x DAYS_PER_STEP when chained (each leg waits for the one
 * before). A declined plan hands the clock to the next-ranked plan with a
 * different first partner. What lands by week N is then a probability, and the
 * deadline is a hard wall: fewer rounds fit, so catching up costs more each week.
 *
 * Each lever re-orders or re-prices the SAME ranked plans and is scored on the
 * same landing model:
 *   sequential  no lever: one partner at a time in rank order (the reference)
 *   parallel    first round sends the top k one-step plans to k different
 *               managers at once; the best yes wins, the others are withdrawn
 *   concede     the best plan opens at its walk-away price (the playbook ladder's
 *               richest package): higher P(yes) now, smaller gain
 *   package     the best 2-for-1 (depth for a star) plan goes first
 *   all_in      the all-in mode's best plan goes first (the catch-up leg only)
 * Landing model: a route's value is sum P(plan i is the one that lands) x its
 * final delta (p_complete, delta_final). Legs stranded by a later decline are
 * not counted (they are in the plan's own `expected`, not here).
 * Levers priced outside the curve (not in objective units): waiver claims
 * (points a game, free) and wait-for-news (days lost vs option value).
 */
import { DAYS_PER_STEP } from './itinerary.js';
import { dealKey } from './paths.js';

export const PARALLEL_MAX = 3;
export const CURVE_LEVERS = Object.freeze(['sequential', 'parallel', 'concede', 'package', 'all_in']);
/** Weeks the curve runs past the current week when the deadline is unknown. */
export const NO_DEADLINE_WEEKS = 4;

const fin = Number.isFinite;

/** Days on the clock from now to the end of week n (-1 before the current week). */
export function daysBy(n, { currentWeek, daysLeftInWeek = 7 }) {
  return n < currentWeek ? -1 : daysLeftInWeek + 7 * (n - currentWeek);
}

/** Days one plan's negotiation round takes. */
export function planDays(plan, daysPerStep = DAYS_PER_STEP) {
  return plan.chained ? plan.steps.length * daysPerStep : daysPerStep;
}

const partnerOf = plan => String(plan.steps[0]?.team);
const landP = plan => (fin(plan.p_complete) ? plan.p_complete : 0);
const landV = plan => (fin(plan.delta_final) ? plan.delta_final : 0);

/** Outcomes [{ prob, value }] (miss = value 0) -> { p_land, expected, sd }. */
function summarise(outs) {
  const p_land = outs.reduce((s, o) => s + o.prob, 0);
  const expected = outs.reduce((s, o) => s + o.prob * o.value, 0);
  const all = [...outs, { prob: Math.max(0, 1 - p_land), value: 0 }];
  const sd = Math.sqrt(all.reduce((s, o) => s + o.prob * (o.value - expected) ** 2, 0));
  return { p_land, expected, sd };
}

/**
 * One partner at a time, in the given order, inside `days`. A plan that no longer fits the clock
 * is skipped (a shorter one after it may still fit); a partner already asked is not asked again.
 * Returns { outs, offers_used, rounds, first_step }.
 */
export function sequentialOutcomes(plans, days, { daysPerStep = DAYS_PER_STEP, reach = 1, asked = new Set() } = {}) {
  const outs = [];
  const seen = new Set(asked);
  let t = 0, offers = 0, rounds = 0, first = null;
  for (const p of plans) {
    if (!p?.steps?.length || seen.has(partnerOf(p))) continue;
    const d = planDays(p, daysPerStep);
    if (t + d > days) continue;
    seen.add(partnerOf(p));
    t += d; rounds++; offers += p.steps.length;
    first ??= p.steps[0];
    outs.push({ prob: reach * landP(p), value: landV(p), plan: p });
    reach *= 1 - landP(p);
    if (reach <= 1e-9) break;
  }
  return { outs, offers_used: offers, rounds, first_step: first };
}

/**
 * Parallel first round: the top k one-step plans with different partners go out together; the best
 * yes wins. Whatever time is left runs sequentially on the plans not yet asked.
 */
export function parallelOutcomes(plans, days, { daysPerStep = DAYS_PER_STEP, k = PARALLEL_MAX } = {}) {
  if (days < daysPerStep) return null;
  const picked = [], teams = new Set();
  for (const p of plans) {
    if (p?.steps?.length !== 1 || teams.has(partnerOf(p))) continue;
    teams.add(partnerOf(p)); picked.push(p);
    if (picked.length >= k) break;
  }
  if (picked.length < 2) return null;
  const outs = [];
  let miss = 1;
  for (const p of [...picked].sort((a, b) => landV(b) - landV(a))) {
    outs.push({ prob: miss * landP(p), value: landV(p), plan: p });
    miss *= 1 - landP(p);
  }
  const rest = sequentialOutcomes(plans, days - daysPerStep, { daysPerStep, reach: miss, asked: teams });
  return { outs: [...outs, ...rest.outs], offers_used: picked.length + rest.offers_used,
    rounds: 1 + rest.rounds, first_step: picked[0].steps[0], parallel: picked.length };
}

/**
 * The best plan re-priced at its playbook walk-away: step 0 pays the walk-away package instead of the
 * plan's own. ladder: priceLadder output for step 0 ({ walk_away: { give, p, delta } }). Null when
 * the ladder has no walk-away or it is no richer than the plan's own price.
 */
export function concededPlan(plan, ladder) {
  const wa = ladder?.walk_away, st = plan?.steps?.[0];
  if (!wa || !st || !fin(wa.p) || !fin(wa.delta) || !(wa.p > st.p)) return null;
  const steps = [{ ...st, give: wa.give, p: wa.p, delta: wa.delta }, ...plan.steps.slice(1)];
  const p_complete = steps.reduce((s, x) => s * x.p, 1);
  const delta_final = plan.steps.length === 1 ? wa.delta : landV(plan) - (st.delta - wa.delta);
  return { ...plan, steps, p_complete, delta_final, conceded: true, replaces: planKey(plan) };
}

/** Whether a plan pays two or more players for one somewhere (the "bigger package" lever). */
export const isPackage = plan => plan.steps.some(s => (s.give?.length ?? 0) >= 2 && (s.get?.length ?? 0) === 1);

/** A whole path's identity (the ranked lists are copies per mode, so objects never match). */
export const planKey = plan => plan.steps.map(dealKey).join('>');
const firstThen = (lead, ranked) => (lead
  ? [lead, ...ranked.filter(p => planKey(p) !== planKey(lead) && planKey(p) !== lead.replaces)] : null);

/**
 * Every curve lever's route at `days`. inputs: { ranked, conceded (plan|null), allIn (plan|null) }.
 * Returns [{ lever, p_land, expected, sd, offers_used, rounds, first_step, parallel }] (only levers that apply).
 */
export function leverRoutes({ ranked, conceded = null, allIn = null }, days, { daysPerStep = DAYS_PER_STEP, k = PARALLEL_MAX } = {}) {
  const orders = {
    sequential: ranked,
    concede: firstThen(conceded, ranked),
    package: ranked[0] && !isPackage(ranked[0]) ? firstThen(ranked.find(isPackage) ?? null, ranked) : null,
    all_in: allIn && planKey(allIn) !== planKey(ranked[0]) ? firstThen(allIn, ranked) : null,
  };
  const out = [];
  for (const lever of CURVE_LEVERS) {
    const r = lever === 'parallel' ? parallelOutcomes(ranked, days, { daysPerStep, k })
      : orders[lever] ? sequentialOutcomes(orders[lever], days, { daysPerStep }) : null;
    if (!r || !r.outs.length) continue;
    out.push({ lever, ...summarise(r.outs), offers_used: r.offers_used, rounds: r.rounds, first_step: r.first_step,
      parallel: r.parallel ?? 0 });
  }
  return out;
}

/**
 * The speed curve: for each arrive-by week N from now to the deadline, every lever's route on the
 * clock and the best one. A route that lands by an earlier week also lands by N, so the winner at N
 * is the best of every lever at every week up to N. cost = unhurried expected - winner's expected at
 * N (objective units), where unhurried is the winner at the last week (the deadline), so cost >= 0,
 * falls toward the deadline and is 0 there. `levers` lists every lever's own route at N.
 * inputs: { ranked (best first, each with steps, p_complete, delta_final, chained), conceded, allIn }.
 */
export function speedCurve(inputs, { currentWeek, deadlineWeek, daysPerStep = DAYS_PER_STEP, daysLeftInWeek = 7, k = PARALLEL_MAX }) {
  const ranked = inputs?.ranked ?? [];
  if (!ranked.length || !Number.isInteger(currentWeek)) return [];
  const hasDeadline = Number.isInteger(deadlineWeek);
  const last = hasDeadline ? Math.max(deadlineWeek, currentWeek) : currentWeek + NO_DEADLINE_WEEKS;
  const clock = { currentWeek, daysLeftInWeek };
  const weeks = [];
  let best = null;
  for (let n = currentWeek; n <= last; n++) {
    const routes = leverRoutes(inputs, daysBy(n, clock), { daysPerStep, k });
    for (const r of routes) if (!best || r.expected > best.expected + 1e-15) best = { ...r, week: n };
    if (best) weeks.push({ n, routes, best, ref: null });
  }
  if (!weeks.length) return [];
  const refE = best.expected;
  const refSd = weeks[weeks.length - 1].best.sd;
  return weeks.map(({ n, routes, best: b }) => ({
    arrive_by: n,
    lever: b.lever,
    cost: Math.max(0, refE - b.expected),
    net: b.expected,
    expected: b.expected,
    p_land: b.p_land,
    variance_note: b.sd > refSd + 1e-12 ? 'wider range of outcomes than the unhurried plan' : 'no wider than the unhurried plan',
    offers_used: b.offers_used,
    parallel: b.parallel > 1,
    before_deadline: !hasDeadline || n <= deadlineWeek,
    first_step: b.first_step,
    levers: routes.map(r => ({ lever: r.lever, expected: r.expected, p_land: r.p_land, cost: Math.max(0, refE - r.expected),
      offers_used: r.offers_used, rounds: r.rounds })),
  }));
}

/**
 * Levers priced off the curve (different units): waiver claims (points a game, free, land at the
 * next waiver run) and wait-for-news (the option value of waiting vs the days it costs).
 * free: freeMoves() items; waits: playbook `wait` entries for the best plan's steps.
 */
export function sideLevers({ free = [], waits = [] } = {}) {
  const out = [];
  const bestFree = free[0] ?? null;
  if (bestFree) {
    out.push({ lever: 'waiver', gain_ppg: bestFree.ppg_gain, moves: free.length, cost_assets: 0,
      text: `Waiver claims: ${free.length} free move${free.length === 1 ? '' : 's'}, best +${bestFree.ppg_gain.toFixed(1)} pts a game, no player spent.` });
  }
  for (const w of waits) {
    if (w?.flag !== 'wait') continue;
    out.push({ lever: 'wait', days: w.days, option_value: w.option_value, basis: w.option_value_basis ?? null,
      text: `Waiting ${w.days} days is worth ${(w.option_value * 100).toFixed(1)} pts of the objective (${w.option_value_basis ?? 'guess'}).` });
  }
  return out;
}
