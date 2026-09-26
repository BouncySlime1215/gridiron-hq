/**
 * INJURY INSURANCE (batch D item 27): price a handcuff for each of Nick's Blue chips as an explicit
 * option beside the served trade.
 *
 * The planner prices trades on the season sim, and the sim cannot see insurance: it does not know
 * that when a starter sits, his backup inherits the work. contingency.js#cascades measures exactly
 * that handoff (games the starter actually missed), so a backup has a price here:
 *
 *   at risk     weeks left x P(miss a week) x what the lineup loses without the Blue chip
 *   insured     weeks left x [ P(miss) x what the handcuff wins back in those weeks
 *                             - (1 - P(miss)) x what the dropped player cost in the healthy weeks ]
 *   the trade   weeks left x what the served move adds to the lineup x P(every step says yes)
 *
 * Every lineup is the one roster-risk.js prices bye and fragility weeks with (trade-engine.js
 * bestLineup on ros_ppg), passed in; this module keeps no lineup solver and no copy of a number.
 *
 * Nick's rules, all fail closed:
 *   - only a Blue chip (board score 83+, gets-floor.js#floorRead) who starts is insured; no board, no chips;
 *   - a handcuff counts only when he passed the workload test (waiver-perishable.js#handcuffWorkload);
 *   - only a free agent is an option: a handcuff on a rival's roster would be a trade get below the
 *     Blue chip floor, which Nick's rules refuse, so it is listed as refused and never priced;
 *   - never a pinned never-get, an untouchable, or a player Nick sold this season (no buy-backs);
 *   - the drop is SEARCH-WIDE's (search-wide.js makeDropOk + pickDrop): never 160 / 80 / 277, an
 *     untouchable, a Blue chip or an unscored player, and never worth more than the handcuff on
 *     FantasyCalc value (overpay cap 0). No priced drop, no option.
 *
 * SHADOW behind GRIDIRON_INJURY_INSURANCE (the preview switch never turns it on): the producer
 * writes `_run.inputs.injury_insurance` (ids and numbers only; the repo is public) after planning,
 * and nothing served reads it. It moves no value, price, target or served number.
 */

import { floorRead } from './gets-floor.js';
import { BLUE_CHIP_SCORE } from './search.js';
import { makeDropOk, pickDrop } from './search-wide.js';
import { PINNED_NEVER_GET } from './never-give.js';

export const INSURANCE_ENV = 'GRIDIRON_INJURY_INSURANCE';
export const insuranceEnabled = (env = process.env) => env?.[INSURANCE_ENV] === '1';

/** Every setting in one place, so a local run prints exactly what it used. */
export const INSURANCE_RULE = Object.freeze({
  version: 1,
  basis: 'GUESS: horizon and floors set by hand before any measurement; miss rate from contingency.js#availability',
  last_week: 17,             // insure through the fantasy final (weeks 15-17 included)
  default_miss_rate: null,   // no availability read -> the chip is priced 'no_miss_rate', never guessed
  min_insured_points: 0.5,   // an option must win back at least this many season points to be kept
});

/**
 * Pre-registered pass bar for the grade (PR body "Pre-registration"). Held-out: the handoff is fit
 * through season S-1 and judged on season S games where the starter missed. Changing it after a
 * run is a new version.
 */
export const INSURANCE_PASS_BAR = Object.freeze({
  version: 1,
  min_games: 30,             // B1: held-out starter-missed games with a workload-passing handcuff
  ratio_low: 0.75,           // B2: realized / predicted points in those games, point estimate
  ratio_high: 1.25,
  ci_low: 0.6,               // B3: the 95% bootstrap interval of that ratio stays inside [0.6, 1.5]
  ci_high: 1.5,
  min_lift: 1.5,             // B4: passers score at least 1.5x what workload failers score in the same spot
  min_fail_games: 10,        //     (B4 unmeasured below this many failer games)
});

export const REFUSE_REASONS = Object.freeze(['workload_test', 'rostered', 'never_get', 'no_fc_value', 'no_drop', 'no_gain']);

const finite = x => typeof x === 'number' && Number.isFinite(x);
const r2 = x => (finite(x) ? Math.round(x * 100) / 100 : null);
const r4 = x => (finite(x) ? Math.round(x * 1e4) / 1e4 : null);

/** Weeks left to insure, this week included. */
export function weeksLeft(week, lastWeek = INSURANCE_RULE.last_week) {
  const w = Number(week);
  return Number.isInteger(w) && w > 0 ? Math.max(0, lastWeek - w + 1) : 0;
}

/**
 * Price insurance for Nick's Blue chips.
 *
 * @param inp {
 *   roster: [{ id, position, ros_ppg, available? }]   Nick's players
 *   lineupPoints(players) -> number                     the one lineup (bestLineup on ros_ppg)
 *   scoreOf(id) -> { score, label } | null              the Blue chip board (adapter.scoreOf)
 *   valueOf(id) -> FantasyCalc value | null             (fc-value.js through the adapter)
 *   missRateOf(id) -> P(miss a week) | null             1 - contingency.js#availability
 *   handcuffs: Map starterId -> [{ id, position, ros_ppg, points_without, owner, workload_test }]
 *   untouchable, sold: Set of ids                       Nick's word and this season's sales
 *   week                                                the league's current week
 *   trade: { give: ids, get: [{ id, position, ros_ppg }], p_complete } | null   Nick's side of the served move
 * }
 */
export function priceInsurance(inp) {
  const { roster = [], lineupPoints, scoreOf = null, valueOf = () => null, missRateOf = () => null,
    handcuffs = new Map(), untouchable = new Set(), sold = new Set(), week = null, trade = null } = inp ?? {};
  const weeks = weeksLeft(week);
  const base = { lane: 'shadow', rule_version: INSURANCE_RULE.version, weeks_left: weeks };
  if (typeof lineupPoints !== 'function') return { ...base, status: 'error', reason: 'no lineup solver', chips: [] };
  if (typeof scoreOf !== 'function') return { ...base, status: 'no_board', reason: 'the Blue chip board is off, so no player is a Blue chip (fails closed)', chips: [] };
  if (!weeks) return { ...base, status: 'season_over', reason: `week ${week} is past week ${INSURANCE_RULE.last_week}`, chips: [] };

  const S = id => String(id);
  const full = lineupPoints(roster);
  const tradeRead = priceTrade({ roster, lineupPoints, trade, weeks, full });
  const blocked = new Set([...PINNED_NEVER_GET, ...[...untouchable].map(S), ...[...sold].map(S)]);
  const dropOk = makeDropOk({ scoreOf, floor: BLUE_CHIP_SCORE, untouchable });
  const tradeGives = new Set((trade?.give ?? []).map(S));
  const onField = startersOf(roster, lineupPoints, full);

  const chips = [];
  for (const star of roster) {
    if (!floorRead(scoreOf, star.id, BLUE_CHIP_SCORE).passes) continue;
    const without = roster.filter(p => S(p.id) !== S(star.id));
    const lostPerWeek = full - lineupPoints(without);
    if (!(lostPerWeek > 0.01)) continue;                      // not a starter, or covered by depth already
    const miss = missRateOf(star.id);
    const chip = { player: S(star.id), position: star.position ?? null, score: scoreOf(star.id)?.score ?? null,
      cost_per_missed_week: r2(lostPerWeek) };
    if (!finite(miss)) {
      chips.push({ ...chip, status: 'no_miss_rate', miss_rate: null, at_risk_points: null, options: [], refused: [], best: null, vs_trade: null });
      continue;
    }
    const options = [], refused = [];
    for (const h of handcuffs.get(S(star.id)) ?? []) {
      const why = refuseReason(h, { blocked });
      if (why) { refused.push({ handcuff: S(h.id), reason: why, ...(why === 'workload_test' ? { detail: h.workload_test?.reason ?? null } : {}) }); continue; }
      const addV = valueOf(h.id);
      if (!finite(addV)) { refused.push({ handcuff: S(h.id), reason: 'no_fc_value' }); continue; }
      const drop = pickDrop({ roster: roster.map(p => p.id), add: h.id, dropOk, valueOf, starters: onField });
      if (drop == null) { refused.push({ handcuff: S(h.id), reason: 'no_drop' }); continue; }
      const kept = roster.filter(p => S(p.id) !== S(drop));
      // Star out: the handcuff plays at his measured without-starter rate.
      const outRoster = kept.filter(p => S(p.id) !== S(star.id));
      const recovered = lineupPoints([...outRoster, { ...h, ros_ppg: h.points_without }]) - lineupPoints(without);
      // Star healthy: the handcuff sits at his own rate, and the dropped player is gone.
      const dropCost = full - lineupPoints([...kept, h]);
      const insured = weeks * (miss * recovered - (1 - miss) * dropCost);
      if (!(insured >= INSURANCE_RULE.min_insured_points)) { refused.push({ handcuff: S(h.id), reason: 'no_gain', insured_points: r2(insured) }); continue; }
      options.push({ kind: 'wire_handcuff', handcuff: S(h.id), drop: S(drop),
        recovered_per_missed_week: r2(recovered), drop_cost_per_week: r2(dropCost), insured_points: r2(insured),
        workload: h.workload_test ? { games: h.workload_test.games_observed ?? null, opportunities: h.workload_test.opportunity_without ?? null } : null });
    }
    options.sort((a, b) => b.insured_points - a.insured_points || a.handcuff.localeCompare(b.handcuff));
    const best = options[0] ?? null;
    chips.push({ ...chip, status: best ? 'insurable' : 'no_option', miss_rate: r4(miss),
      at_risk_points: r2(weeks * miss * lostPerWeek), options, refused, best,
      vs_trade: best ? compare(best, tradeRead, tradeGives) : null });
  }
  chips.sort((a, b) => (b.at_risk_points ?? -1) - (a.at_risk_points ?? -1) || a.player.localeCompare(b.player));
  return { ...base, status: chips.length ? 'ok' : 'no_chips', ...(chips.length ? {} : { reason: 'no Blue chip starter on the roster' }),
    full_strength_points: r2(full), trade: tradeRead, chips };
}

function refuseReason(h, { blocked }) {
  if (!h?.workload_test?.passes) return 'workload_test';
  if (h.owner != null) return 'rostered';
  if (blocked.has(String(h.id))) return 'never_get';
  if (!finite(h.points_without)) return 'workload_test';
  return null;
}

/** The ids in Nick's best lineup (pickDrop benches before starters). */
function startersOf(roster, lineupPoints, full) {
  const out = new Set();
  for (const p of roster) {
    if (full - lineupPoints(roster.filter(x => x.id !== p.id)) > 0.01) out.add(String(p.id));
  }
  return out;
}

/** The served move on the same yardstick: lineup points it adds a week, times P(complete), over the weeks left. */
function priceTrade({ roster, lineupPoints, trade, weeks, full }) {
  if (!trade) return { status: 'none', reason: 'no served move this run' };
  const give = new Set((trade.give ?? []).map(String));
  const after = [...roster.filter(p => !give.has(String(p.id))), ...(trade.get ?? [])];
  const perWeek = lineupPoints(after) - full;
  const p = finite(trade.p_complete) ? trade.p_complete : null;
  return { status: 'ok', give: [...give], get: (trade.get ?? []).map(g => String(g.id)),
    points_per_week: r2(perWeek), p_complete: r4(p), expected_points: p == null ? null : r2(weeks * perWeek * p) };
}

/**
 * Insurance vs the trade. They only compete when the drop is one of the trade's gives; otherwise
 * both can be done, and the read says which is worth more on its own.
 */
function compare(best, tradeRead, tradeGives) {
  const t = tradeRead?.status === 'ok' ? tradeRead.expected_points : null;
  const better = t == null || best.insured_points > t ? 'insure' : 'trade';
  return { insured_points: best.insured_points, trade_points: t, better, drop_in_trade: tradeGives.has(best.drop) };
}

/** The producer's shadow block: counts plus the priced chips (ids only). */
export function insuranceSummary(read) {
  const chips = read?.chips ?? [];
  const count = s => chips.filter(c => c.status === s).length;
  return { ...read, counts: { chips: chips.length, insurable: count('insurable'), no_option: count('no_option'), no_miss_rate: count('no_miss_rate'),
    better_than_trade: chips.filter(c => c.vs_trade?.better === 'insure').length } };
}

/* ------------------------------------------------------------------ grade */

/** Deterministic PRNG for the bootstrap (mulberry32), so a grade reproduces bit for bit. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Grade the handoff price on held-out games.
 * @param games [{ season, week, starter, backup, predicted, realized, passes }] one row per game the
 *   starter missed: predicted = the backup's points_without from the fit through season-1; realized
 *   = what he scored that week (0 if he had no row while his team played); passes = workload test.
 */
export function gradeInsurance(games, { bar = INSURANCE_PASS_BAR, reps = 2000, seed = 27 } = {}) {
  const ok = (games ?? []).filter(g => finite(g.predicted) && finite(g.realized));
  const pass = ok.filter(g => g.passes === true), fail = ok.filter(g => g.passes === false);
  const sum = (xs, k) => xs.reduce((s, g) => s + g[k], 0);
  const mean = (xs, k) => (xs.length ? sum(xs, k) / xs.length : null);
  const predP = sum(pass, 'predicted');
  const ratio = predP > 0 ? sum(pass, 'realized') / predP : null;
  let ci = null;
  if (pass.length >= 2 && predP > 0) {
    const r = rng(seed), stats = [];
    for (let i = 0; i < reps; i++) {
      let a = 0, b = 0;
      for (let j = 0; j < pass.length; j++) { const g = pass[Math.floor(r() * pass.length)]; a += g.realized; b += g.predicted; }
      if (b > 0) stats.push(a / b);
    }
    stats.sort((x, y) => x - y);
    ci = [stats[Math.floor(0.025 * (stats.length - 1))], stats[Math.ceil(0.975 * (stats.length - 1))]];
  }
  const mp = mean(pass, 'realized'), mf = mean(fail, 'realized');
  const lift = fail.length >= bar.min_fail_games && mf > 0 && mp != null ? mp / mf : null;
  const checks = {
    B1_games: { value: pass.length, pass: pass.length >= bar.min_games },
    B2_ratio: { value: r4(ratio), pass: ratio != null && ratio >= bar.ratio_low && ratio <= bar.ratio_high },
    B3_ci: { value: ci && ci.map(r4), pass: !!ci && ci[0] >= bar.ci_low && ci[1] <= bar.ci_high },
    B4_lift: lift == null ? { value: null, pass: null, reason: `fewer than ${bar.min_fail_games} failer games, or failers scored 0` }
      : { value: r4(lift), pass: lift >= bar.min_lift },
  };
  const verdict = pass.length < bar.min_games ? 'insufficient'
    : Object.values(checks).every(c => c.pass !== false) ? 'pass' : 'fail';
  return { bar_version: bar.version, verdict, n_pass: pass.length, n_fail: fail.length,
    mean_realized_pass: r2(mp), mean_predicted_pass: r2(mean(pass, 'predicted')), mean_realized_fail: r2(mf), checks };
}
