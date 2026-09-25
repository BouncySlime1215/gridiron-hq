/**
 * CAMPAIGN-01d: risk modes and tolerance sliders (pure).
 *
 * The mode changes the OBJECTIVE FUNCTION, never the facts: every mode scores
 * the same candidate plans on the same dice.
 *
 *   safe      expected gain minus one spread of the accept/decline outcomes
 *             (a variance penalty), and no core starter may be spent
 *   balanced  expected gain across accept/decline outcomes (the default)
 *   all_in    ("Fuck it, let's go") the objective itself if the plan lands:
 *             maximise P(title) after completion, variance allowed, as long as
 *             the plan has at least ALL_IN_MIN_COMPLETE chance to land
 *
 * Tolerances (sliders): max_assets spent across the path, max offers per
 * manager per week (offer fatigue, counting offers already sent this week),
 * max downside per step (how far below today Nick may sit after any one step).
 *
 * RISK-RULE (ONE-PLAN 4d, night 3), on only with GRIDIRON_RISK_RULE=1 in the planner's settings.env
 * (off: the rules above, unchanged). It changes the RANKING only:
 *   safe      worst case: the lowest place the path can end, a declined offer included
 *   balanced  minimax regret: in each scenario "the first k offers say yes", the shortfall
 *             against the best candidate (or doing nothing); smallest worst shortfall wins.
 *             P(yes) does not enter the score (it is the unvalidated 0.30-class guess until E1)
 *   all_in    expected title odds across yes/no outcomes (risk-neutral)
 * balanced and all_in both refuse a plan under ALL_IN_MIN_COMPLETE to land. Ties: expected.
 * "Beats doing nothing" is NOT the rule score under the rule (regret is never positive, a declinable
 * worst case is 0): `beatsNoTrade(scored, mode, { rule: true })` is expected > 0, applied on the confirm dice.
 */
import { pathExpectation, pathOutcomes, assetsSpent } from './paths.js';

export const MODES = Object.freeze(['safe', 'balanced', 'all_in']);
export const MODE_LABELS = Object.freeze({ safe: 'Safe', balanced: 'Balanced', all_in: "Fuck it, let's go" });
export const DEFAULT_MODE = 'balanced';

/** All-in still refuses a plan that almost never lands (hand-set, not fitted). */
export const ALL_IN_MIN_COMPLETE = 0.03;
/** SAFE's variance penalty: expected minus this many outcome SDs (hand-set). */
export const SAFE_LAMBDA = 1;

/** Slider defaults per mode. Objective values are in objective units (title odds as 0-1). */
export const DEFAULT_TOLERANCES = Object.freeze({
  safe: Object.freeze({ max_assets: 2, max_offers_per_manager_week: 1, max_downside_per_step: 0.005, max_give_per_step: 2 }),
  balanced: Object.freeze({ max_assets: 3, max_offers_per_manager_week: 2, max_downside_per_step: 0.01, max_give_per_step: 2 }),
  all_in: Object.freeze({ max_assets: 5, max_offers_per_manager_week: 3, max_downside_per_step: 0.03, max_give_per_step: 3 }),
});

export const RISK_RULE_ENV = 'GRIDIRON_RISK_RULE';
/** RISK-RULE is shadow until measured on league 4: on only with its own flag set to '1' in the given env. */
export const riskRuleOn = (env = {}) => env?.[RISK_RULE_ENV] === '1';

/** The lowest delta the path can end on, over endings with a nonzero chance (0 = nothing landed). */
export function worstCase(steps) {
  if (!steps.length) return 0;
  return Math.min(...pathOutcomes(steps).filter(o => o.prob > 0).map(o => o.delta));
}

/** Nick's delta if the first k offers of the path say yes and the next says no (k >= length: it lands). */
const scenarioValue = (steps, k) => (k === 0 || !steps.length ? 0 : steps[Math.min(k, steps.length) - 1].delta);

/**
 * Largest regret of `plan` over scenarios k = 1..K (k = 0 is 0 for every plan): the best of
 * `pool` and doing nothing (0) in that scenario, minus this plan's value in it.
 */
export function maxRegret(plan, pool) {
  const K = Math.max(plan.steps.length, ...pool.map(q => q.steps.length));
  let worst = 0;
  for (let k = 1; k <= K; k++) {
    const best = Math.max(0, ...pool.map(q => scenarioValue(q.steps, k)));
    worst = Math.max(worst, best - scenarioValue(plan.steps, k));
  }
  return worst;
}

export function normaliseMode(mode) {
  const m = String(mode ?? '').toLowerCase().replace(/[^a-z_]/g, '');
  if (m === 'fuckit' || m === 'fuck_it' || m === 'allin') return 'all_in';
  return MODES.includes(m) ? m : DEFAULT_MODE;
}

/** Slider values for a mode, with any finite overrides applied. */
export function tolerancesFor(mode, overrides = {}) {
  const base = { ...DEFAULT_TOLERANCES[normaliseMode(mode)] };
  for (const k of Object.keys(base)) {
    const v = Number(overrides?.[k]);
    if (overrides?.[k] != null && Number.isFinite(v) && v >= 0) base[k] = v;
  }
  return base;
}

/** REACH-01: the gate codes toleranceCheck names (the keys of reach.drops_by_gate's `tolerance` counts). */
export const TOLERANCE_CODES = Object.freeze(['max_assets', 'max_offers_per_manager_week', 'max_give_per_step',
  'max_downside_per_step', 'core_starter', 'untouchable']);

/** Why a plan breaks a slider, or null when it fits (the text of toleranceCheck). */
export function toleranceViolation(plan, tol, ctx = {}, mode = DEFAULT_MODE) {
  return toleranceCheck(plan, tol, ctx, mode)?.why ?? null;
}

/**
 * Which slider a plan breaks first, as { code, why } (code one of TOLERANCE_CODES), or null when it fits.
 * ctx: { originalIds, sentThisWeek: Map|obj manager -> offers already sent, core: Set of ids (SAFE) }
 */
export function toleranceCheck(plan, tol, ctx = {}, mode = DEFAULT_MODE) {
  const fail = (code, why) => ({ code, why });
  const spent = assetsSpent(plan.steps, ctx.originalIds ?? []);
  if (spent > tol.max_assets) return fail('max_assets', `spends ${spent} of your players (limit ${tol.max_assets})`);
  const per = new Map();
  for (const s of plan.steps) per.set(String(s.team), (per.get(String(s.team)) ?? 0) + 1);
  const sent = ctx.sentThisWeek instanceof Map ? ctx.sentThisWeek : new Map(Object.entries(ctx.sentThisWeek ?? {}));
  for (const [team, n] of per) {
    const already = Number(sent.get(team) ?? 0);
    if (already + n > tol.max_offers_per_manager_week) {
      return fail('max_offers_per_manager_week', `Team ${team} would get ${already + n} offers this week (limit ${tol.max_offers_per_manager_week})`);
    }
  }
  for (const s of plan.steps) {
    if (s.give.length > tol.max_give_per_step) return fail('max_give_per_step', `a step gives ${s.give.length} players (limit ${tol.max_give_per_step})`);
    if (Number.isFinite(s.delta) && s.delta < -tol.max_downside_per_step) {
      return fail('max_downside_per_step', `a step leaves you ${(-s.delta * 100).toFixed(1)} pts below today (limit ${(tol.max_downside_per_step * 100).toFixed(1)})`);
    }
  }
  if (mode === 'safe' && ctx.core) {
    const hit = plan.steps.flatMap(s => s.give).find(id => ctx.core.has(String(id)));
    if (hit != null) return fail('core_starter', 'spends a core starter (Safe mode keeps them)');
  }
  const untouch = ctx.untouchables instanceof Set ? ctx.untouchables : new Set((ctx.untouchables ?? []).map(String));
  const u = plan.steps.flatMap(s => s.give).find(id => untouch.has(String(id)));
  if (u != null) return fail('untouchable', 'sells a player you marked untouchable');
  return null;
}

/**
 * One plan's score under a mode. Returns { score, eligible, why }.
 * `plan.steps[i]` carries p, delta, se; `skipWeight` (0-1] from the skip log multiplies the score's
 * positive part so a skipped option sinks without being hidden.
 */
export function scorePlan(plan, mode, { rule = false, pool = [plan] } = {}) {
  const e = pathExpectation(plan.steps);
  const w = plan.skip_weight ?? 1;
  const tilt = v => (v > 0 ? v * w : v);
  if (rule) return ruleScore(plan, normaliseMode(mode), e, tilt, pool);
  switch (normaliseMode(mode)) {
    case 'safe':
      return { ...e, score: tilt(e.expected - SAFE_LAMBDA * e.sd), eligible: true,
        why: 'expected gain minus one spread of the yes/no outcomes' };
    case 'all_in':
      if (e.p_complete < ALL_IN_MIN_COMPLETE) {
        return { ...e, score: -Infinity, eligible: false,
          why: `lands under ${(ALL_IN_MIN_COMPLETE * 100).toFixed(0)}% of the time` };
      }
      return { ...e, score: tilt(e.delta_final), eligible: true, why: 'title odds if the whole plan lands' };
    default:
      return { ...e, score: tilt(e.expected), eligible: true, why: 'expected gain across yes/no outcomes' };
  }
}

/** RISK-RULE scoring. Regret is a pool-relative number: `pool` is what the plan is compared against. */
function ruleScore(plan, mode, e, tilt, pool) {
  if (mode !== 'safe' && e.p_complete < ALL_IN_MIN_COMPLETE) {
    return { ...e, score: -Infinity, eligible: false,
      why: `lands under ${(ALL_IN_MIN_COMPLETE * 100).toFixed(0)}% of the time` };
  }
  if (mode === 'safe') {
    return { ...e, score: tilt(worstCase(plan.steps)), eligible: true, why: 'worst case: the lowest place this path can end' };
  }
  if (mode === 'all_in') return { ...e, score: tilt(e.expected), eligible: true, why: 'expected title odds across yes/no outcomes' };
  return { ...e, score: -maxRegret(plan, pool), eligible: true,
    why: 'minimax regret: smallest shortfall against the best option if the offers stop anywhere' };
}

/**
 * Rank candidate plans for a mode: drop tolerance breakers (kept in `dropped` with
 * the reason and its code; the all-in floor is code 'p_complete_floor'), score the rest, sort best first (ties: expected, then fewer steps).
 * RISK-RULE (`rule`): Balanced's regret is measured against the plans that pass the sliders and the
 * landing floor, or against `ctx.regretPool` when given (the confirm pass re-scores one plan at a time).
 */
export function rankPlans(plans, mode, tol, ctx = {}, { rule = false } = {}) {
  const m = normaliseMode(mode);
  const kept = [], dropped = [], fits = [];
  for (const p of plans) {
    const bad = toleranceCheck(p, tol, ctx, m);
    if (bad) { dropped.push({ plan: p, why: bad.why, code: bad.code }); continue; }
    fits.push(p);
  }
  const floor = p => pathExpectation(p.steps).p_complete >= ALL_IN_MIN_COMPLETE;
  const pool = rule && m === 'balanced' ? (ctx.regretPool ?? fits.filter(floor)) : undefined;
  for (const p of fits) {
    const s = scorePlan(p, m, { rule, pool });
    if (!s.eligible) { dropped.push({ plan: p, why: s.why, code: 'p_complete_floor' }); continue; }
    kept.push({ ...p, ...s, mode: m });
  }
  kept.sort((a, b) => (b.score - a.score) || (b.expected - a.expected) || (a.steps.length - b.steps.length));
  return { ranked: kept, dropped };
}

/**
 * Whether a scored plan (rankPlans row) beats keeping the roster under its mode. Balanced and all-in:
 * its score > 0. Safe (integration-7): its expected gain minus one DOWNSIDE deviation > 0. Safe still
 * RANKS by the full yes/no spread (it prefers the sure move), but the no-trade comparison must not count
 * a decline as risk: a declined offer leaves Nick exactly where keeping the roster does. With the full
 * spread, no move under ~50% to land could ever beat doing nothing, and Safe served nothing (0 of 80
 * fuzz leagues).
 */
export function beatsNoTrade(scored, mode, { rule = false } = {}) {
  if (!scored || !Number.isFinite(scored.score)) return false;
  // RISK-RULE: the rule scores are not on the no-trade scale (regret <= 0), so the test is the expected gain.
  if (rule) return scored.expected > 0;
  if (normaliseMode(mode) !== 'safe') return scored.score > 0;
  const down = Number.isFinite(scored.downside_sd) ? scored.downside_sd : scored.sd;
  return scored.expected - SAFE_LAMBDA * down > 0;
}

/**
 * NO-TRADE-SHRINK: the do-nothing option. Keeping today's roster gains nothing, spreads nothing and
 * lands for sure, so every mode's objective scores it exactly 0 (safe: 0 - 0; balanced: 0; all_in: 0).
 */
export const NO_TRADE = Object.freeze({ expected: 0, if_complete: 0, p_complete: 1 });

/**
 * Which option a mode's own objective prefers: `best` is that mode's best plan priced on the CONFIRM
 * dice (the planner's served deck rule: fresh-dice score > 0, i.e. above doing nothing), or null when
 * none survives. `confirmed` false: the fresh-dice check did not run and the planning score decided.
 */
export function noTradeRow(best, { confirmed = true, mode = DEFAULT_MODE, rule = false } = {}) {
  const dice = confirmed ? 'on fresh dice' : 'on the planning dice (the fresh-dice check did not run)';
  const on = rule ? ' (its expected gain above 0)' : normaliseMode(mode) === 'all_in' ? ' (ranked on the gain if the whole plan lands)' : '';
  if (!best) return { ...NO_TRADE, pick: 'no_trade', why: `No plan in this mode beats keeping your roster ${dice}${on}.` };
  return { ...NO_TRADE, pick: 'plan', why: `The best plan scores above keeping your roster ${dice}${on}.` };
}

/**
 * Same-dice comparison of the three modes' best plans, for the risk-mode sheet, each beside the
 * no-trade option. pickFor(mode) -> { best, confirmed }: the mode's best after the confirm pass
 * (planner.js); absent, the planning-dice best decides (score > 0).
 */
export function compareModes(plans, ctxFor, pickFor = null, { rule = false } = {}) {
  return MODES.map(mode => {
    const { tol, ctx } = ctxFor(mode);
    const best = rankPlans(plans, mode, tol, ctx, { rule }).ranked[0] ?? null;
    const pk = pickFor ? pickFor(mode) : { best: beatsNoTrade(best, mode, { rule }) ? best : null, confirmed: false };
    // integration-7: with the confirm pass (pickFor), every field is the mode's served pick on the confirm
    // dice, so the sheet never shows a planning-dice move that does not beat keeping the roster.
    const shown = pickFor ? pk.best : best;
    return {
      mode, label: MODE_LABELS[mode],
      expected: shown ? shown.expected : null,
      if_complete: shown ? shown.delta_final : null,
      p_complete: shown ? shown.p_complete : null,
      first_step: shown ? shown.steps[0] : null,
      steps: shown ? shown.steps.length : null,
      no_trade: noTradeRow(pk.best, { confirmed: pk.confirmed, mode, rule }),
    };
  });
}

/* ------------------------------------------------------------ pre-rank shrinkage (SHADOW)
 * The optimizer's curse (ONE-PLAN spot-check row 6): the top of a ranking of noisy gains is biased
 * up, most for the noisiest. confirm.js measures the bias after the fact on fresh dice; this shrinks
 * BEFORE ranking. Normal-normal empirical Bayes with the prior centred on the no-trade gain (0):
 * tau^2 = max(0, mean(g^2) - mean(se^2)) over the mode's own candidates (the plans that pass its
 * sliders), shrunk g = g x tau^2 / (tau^2 + se^2). Safe and Balanced shrink the expected gain with
 * the path's expected_se; all-in ranks the if-it-lands gain, so it fits its own prior on delta_final
 * with the last step's se. Unproven (no graded plan outcome yet), so it is SHADOW: reported under
 * _run.shrink, never read by the ranker, the deck, the confirm pass or any served number.
 */

/** The shrinkage prior from a pool of { expected, expected_se } (any gain and its SE). tau2 null when no item carries an SE. */
export function shrinkPrior(items) {
  const xs = items.filter(x => Number.isFinite(x.expected) && Number.isFinite(x.expected_se));
  if (!xs.length) return { tau2: null, n: 0 };
  const m2 = xs.reduce((s, x) => s + x.expected ** 2, 0) / xs.length;
  const v = xs.reduce((s, x) => s + x.expected_se ** 2, 0) / xs.length;
  return { tau2: Math.max(0, m2 - v), n: xs.length };
}

/** The share of a gain that survives shrinkage: tau^2 / (tau^2 + se^2), in [0, 1]; an exact gain (se 0) keeps 1; null when unknown. */
export function shrinkFactor(se, tau2) {
  if (!Number.isFinite(se) || !Number.isFinite(tau2)) return null;
  if (se === 0) return 1;
  return tau2 / (tau2 + se ** 2);
}

/** One gain shrunk toward 0 (no trade); null when the SE or the prior is unknown. */
export function shrinkExpected(expected, se, tau2) {
  const k = shrinkFactor(se, tau2);
  return k == null || !Number.isFinite(expected) ? null : expected * k;
}

const planKey = p => { const s = p.steps[0]; return `${s.team}|${s.give.join('+')}|${s.get.join('+')}`; };

/** The gain a mode ranks, with its SE: the if-it-lands gain for all-in, the expected gain otherwise. */
const gainOf = (r, mode) => (mode === 'all_in'
  ? { expected: r.delta_final, expected_se: r.steps[r.steps.length - 1]?.se ?? null }
  : { expected: r.expected, expected_se: r.expected_se });

/**
 * Shadow report: per mode, the served best (point estimate) beside the best after shrinking each
 * plan's ranked gain, and whether shrinkage would reorder the top. `reorders` is null (unknown) when
 * the served best carries no SE, since it cannot be shrunk; SE-less plans never enter the shrunk
 * ranking. Nothing here feeds a served number.
 */
export function shadowShrink(plans, ctxFor) {
  const modes = MODES.map(mode => {
    const { tol, ctx } = ctxFor(mode);
    const ranked = rankPlans(plans, mode, tol, ctx).ranked;
    const best = ranked[0] ?? null;
    const prior = shrinkPrior(ranked.map(r => gainOf(r, mode)));
    const head = { mode, basis: mode === 'all_in' ? 'if-it-lands gain, last step se' : 'expected gain, path se',
      tau2: prior.tau2, n: prior.n, best: best ? planKey(best) : null, best_expected: best?.expected ?? null };
    const empty = { ...head, shrunk_best: null, reorders: best ? null : false, best_shrunk_expected: null,
      shrunk_best_expected: null, best_shrunk_if_complete: null, shrunk_pick: null };
    if (!best || prior.tau2 == null) return empty;
    const shr = ranked.map(r => {
      const g = gainOf(r, mode);
      const k = shrinkFactor(g.expected_se, prior.tau2);
      if (k == null) return null;
      const w = r.skip_weight ?? 1;
      const tilt = v => (v > 0 ? v * w : v);
      const shrunk = g.expected * k;
      const score = mode === 'safe' ? tilt(shrunk - SAFE_LAMBDA * r.sd) : tilt(shrunk);
      return { r, shrunk, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score || (a.r.steps.length - b.r.steps.length));
    const top = shr[0] ?? null;
    const own = shr.find(x => x.r === best) ?? null;
    return { ...head, shrunk_best: top ? planKey(top.r) : null,
      reorders: own && top ? top.r !== best : null,
      best_shrunk_expected: mode === 'all_in' ? null : own?.shrunk ?? null,
      shrunk_best_expected: mode === 'all_in' ? null : top?.shrunk ?? null,
      best_shrunk_if_complete: mode === 'all_in' ? own?.shrunk ?? null : null,
      shrunk_pick: top ? (top.score > 0 ? 'plan' : 'no_trade') : null };
  });
  return { status: 'shadow', basis: 'empirical Bayes toward the no-trade gain (0), fitted per mode; not graded, reads nothing served', modes };
}
