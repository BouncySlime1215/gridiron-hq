/**
 * STOPS-01: bye and injury stops with the priced trade-off (pure).
 *
 * The season sim already scores a player 0 in a week his team has no game (season-sim.js#weekPool)
 * and, with AVAIL-HORIZON on, prices an injured player's later weeks on the fitted return-to-play
 * curve from his role cell (contingency.js#weeklyAvailability). So Nick's weekly lineup samples
 * (the world's weekly(), the same dice every plan is scored on) already carry bye and injury holes.
 * This module reads them; it builds no second projection.
 *
 *   findHoles     weeks where Nick's lineup drops well below its own median week, with the starters
 *                 on bye (or carrying an injury flag) that explain the drop. An unexplained dip is
 *                 not a stop.
 *   priceHoles    for each hole, the best-scoring ranked plan (already filtered by Nick's rules:
 *                 never-give, overpay cap, gets floor) that lands by that week and fills at least
 *                 half the hole on paired samples; its trade-off against the best plan is
 *                 itinerary.js#stopTradeOff, the same pricing Nick's own stops get.
 *
 * Flag GRIDIRON_STOPS: '1' serves the priced rows in stop_tradeoffs; 'shadow' computes them into
 * _run.inputs.stops only; anything else (default) is off and the entry is byte-for-byte unchanged.
 * Preview mode never turns it on.
 */

import { stopTradeOff, arrivalWeek } from './itinerary.js';

export const STOPS_ENV = 'GRIDIRON_STOPS';
/** A week this many lineup points under the median week is a hole. Hand-set, pre-registered in the PR. */
export const HOLE_MIN_PTS = 5;
/** A path fills a hole when it adds back at least this share of it in that week. */
export const COVER_SHARE = 0.5;
/** At most this many holes are priced, largest first. */
export const MAX_HOLES = 4;
/** Ranked plans scanned for a cover, best first. */
export const COVER_SCAN = 20;

/** 'on' | 'shadow' | 'off'. Only its own flag switches it; preview mode does not. */
export function stopsMode(env = {}) {
  const v = env?.[STOPS_ENV];
  return v === '1' ? 'on' : v === 'shadow' ? 'shadow' : 'off';
}

const meanOf = a => { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : NaN; };
const seOf = a => {
  const n = a.length;
  if (n < 2) return Infinity;
  const m = meanOf(a);
  let s2 = 0;
  for (const x of a) s2 += (x - m) ** 2;
  return Math.sqrt(s2 / (n - 1) / n);
};
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

/**
 * weeks:  [{ week, samples }] for Nick's roster today (world.weekly)
 * roster: [{ id, name, starter, bye, injury }]
 * Returns [{ week, kind: 'bye' | 'injury', drop, se, mean, baseline, players: [ids] }], largest drop first.
 */
export function findHoles({ weeks, roster = [], currentWeek = 1, minDrop = HOLE_MIN_PTS, max = MAX_HOLES }) {
  const ahead = (weeks ?? []).filter(w => w.week >= currentWeek && w.samples?.length);
  if (ahead.length < 2) return [];
  const means = ahead.map(w => meanOf(w.samples));
  const baseline = median(means);
  const starters = roster.filter(p => p.starter);
  const holes = [];
  ahead.forEach((w, i) => {
    const drop = baseline - means[i];
    const se = seOf(w.samples);
    if (!(drop >= minDrop) || !(drop > 2 * se)) return;
    const onBye = starters.filter(p => p.bye === w.week);
    const hurt = starters.filter(p => p.injury && p.bye !== w.week);
    const cause = onBye.length ? { kind: 'bye', players: onBye } : hurt.length ? { kind: 'injury', players: hurt } : null;
    if (!cause) return;
    holes.push({ week: w.week, kind: cause.kind, drop, se, mean: means[i], baseline, players: cause.players.map(p => String(p.id)) });
  });
  return holes.sort((a, b) => b.drop - a.drop || a.week - b.week).slice(0, max);
}

/** The plan-added stop a hole becomes; its key follows plans-schema.js#tradeoffKey. */
export function holeStop(hole) {
  return hole.kind === 'bye'
    ? { kind: 'cover_bye', week: hole.week, label: `Cover the week ${hole.week} bye` }
    : { kind: 'custom', label: `Cover the week ${hole.week} injury hole` };
}

/** Paired lift of `after` over `before` in one week: same run index, same dice. */
function pairedLift(before, after) {
  const n = Math.min(before.length, after.length);
  const d = new Array(n);
  for (let i = 0; i < n; i++) d[i] = after[i] - before[i];
  return { lift: meanOf(d), se: seOf(d) };
}

/**
 * holes:     findHoles output
 * ranked:    the objective mode's ranked plans, best first (post rules)
 * nowWeeks:  today's weekly samples (the holes' own basis)
 * weeklyOf:  plan -> [{ week, samples }] for the plan's final roster, or null
 * blocked:   ids no cover may give (adapter.untouchable after never-give.js#withNeverGive, plus the objective's)
 * served:    the plan the served next move is on (the confirmed deck head), or null when no move is served;
 *            defaults to ranked[0] (the unit tests' pure form). The stop is priced against it.
 * confirmed: plan -> truthy when the plan beats doing nothing on the confirm dice (planner.js#confirmedActive),
 *            or null (pure form: every ranked plan counts). integration-10a: a cover is a served move, so it
 *            obeys Nick's rule 6 like a backup or a catch-up deal.
 * Returns one row per hole: the stopTradeOff fields plus { week, hole_kind, stop, cover } or
 * { status: 'unreachable', because }.
 */
export function priceHoles({ holes, ranked = [], nowWeeks, weeklyOf, currentWeek, daysLeftInWeek = 7, names = id => `player ${id}`,
  blocked = new Set(), scan = COVER_SCAN, share = COVER_SHARE, served = ranked[0] ?? null, confirmed = null }) {
  const byWeek = new Map((nowWeeks ?? []).map(w => [w.week, w.samples]));
  const givesOf = p => [...new Set(p.steps.flatMap(s => s.give).map(String))];
  // Belt and braces: ranked is already rule-filtered; a plan giving a blocked id is still never a cover (fail closed).
  const pool = ranked.slice(0, scan).filter(p => !givesOf(p).some(id => blocked.has(id)));
  const plansWeeks = new Map();
  const weeksOf = p => { if (!plansWeeks.has(p)) plansWeeks.set(p, weeklyOf(p)); return plansWeeks.get(p); };
  return holes.map(h => {
    const stop = holeStop(h);
    const who = h.players.map(names).join(', ');
    const cause = h.kind === 'bye' ? `${who} on bye` : `${who} injured`;
    const base = byWeek.get(h.week);
    const common0 = { week: h.week, hole_kind: h.kind, stop, drop: h.drop, players: h.players, stop_label: stop.label };
    // integration-10a: no served move this week -> nothing to price the stop against (never "your best path").
    if (!served) {
      return { ...common0, status: 'unreachable',
        because: `${cause}; no move beats doing nothing on the fresh dice this week, so no path is priced for this hole` };
    }
    let cover = null;
    for (const p of pool) {
      if (arrivalWeek(p, currentWeek, { daysLeftInWeek }) > h.week) continue;
      const wk = weeksOf(p)?.find(w => w.week === h.week)?.samples;
      if (!base || !wk) continue;
      const { lift, se } = pairedLift(base, wk);
      if (!(lift >= share * h.drop && lift > 2 * se)) continue;
      // integration-10a: only a plan that beats doing nothing on the confirm dice may be the cover.
      if (confirmed && !confirmed(p)) continue;
      cover = { plan: p, lift, se }; break;
    }
    const common = { week: h.week, hole_kind: h.kind, stop, drop: h.drop, players: h.players };
    if (!cover) {
      return { ...common, stop_label: stop.label, status: 'unreachable',
        because: `${cause}; no searched path fills this week inside your rules and sliders` };
    }
    const t = stopTradeOff({ label: stop.label, without: served, with: cover.plan, gain: 0, se: served.expected_se ?? null,
      gain_text: `Week ${h.week} lineup: +${cover.lift.toFixed(1)} pts on this path, against a ${h.drop.toFixed(1)}-point hole.` });
    const first = cover.plan.steps[0];
    return { ...common, ...t, status: 'ok',
      because: `${cause}; ${cover.plan === served ? 'your best path already fills this week' : t.because}`,
      cover: { first_step: first ? { team: first.team, give: first.give, get: first.get, p: first.p ?? null } : null, give: givesOf(cover.plan), steps: cover.plan.steps.length,
        lift: cover.lift, lift_se: cover.se, score: cover.plan.score } };
  });
}

/** Week -> [team abbrs] on bye that week, from a team -> bye-week map (matchups.js byeWeek). */
export function byeClusters(byeWeek) {
  const out = new Map();
  for (const [team, w] of byeWeek ?? []) {
    if (!Number.isInteger(w)) continue;
    if (!out.has(w)) out.set(w, []);
    out.get(w).push(team);
  }
  for (const v of out.values()) v.sort();
  return new Map([...out].sort((a, b) => a[0] - b[0]));
}
