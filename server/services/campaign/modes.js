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
 */
import { pathExpectation, assetsSpent } from './paths.js';

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

/**
 * Why a plan breaks a slider, or null when it fits.
 * ctx: { originalIds, sentThisWeek: Map|obj manager -> offers already sent, core: Set of ids (SAFE) }
 */
export function toleranceViolation(plan, tol, ctx = {}, mode = DEFAULT_MODE) {
  const spent = assetsSpent(plan.steps, ctx.originalIds ?? []);
  if (spent > tol.max_assets) return `spends ${spent} of your players (limit ${tol.max_assets})`;
  const per = new Map();
  for (const s of plan.steps) per.set(String(s.team), (per.get(String(s.team)) ?? 0) + 1);
  const sent = ctx.sentThisWeek instanceof Map ? ctx.sentThisWeek : new Map(Object.entries(ctx.sentThisWeek ?? {}));
  for (const [team, n] of per) {
    const already = Number(sent.get(team) ?? 0);
    if (already + n > tol.max_offers_per_manager_week) {
      return `Team ${team} would get ${already + n} offers this week (limit ${tol.max_offers_per_manager_week})`;
    }
  }
  for (const s of plan.steps) {
    if (s.give.length > tol.max_give_per_step) return `a step gives ${s.give.length} players (limit ${tol.max_give_per_step})`;
    if (Number.isFinite(s.delta) && s.delta < -tol.max_downside_per_step) {
      return `a step leaves you ${(-s.delta * 100).toFixed(1)} pts below today (limit ${(tol.max_downside_per_step * 100).toFixed(1)})`;
    }
  }
  if (mode === 'safe' && ctx.core) {
    const hit = plan.steps.flatMap(s => s.give).find(id => ctx.core.has(String(id)));
    if (hit != null) return 'spends a core starter (Safe mode keeps them)';
  }
  const untouch = ctx.untouchables instanceof Set ? ctx.untouchables : new Set((ctx.untouchables ?? []).map(String));
  const u = plan.steps.flatMap(s => s.give).find(id => untouch.has(String(id)));
  if (u != null) return 'sells a player you marked untouchable';
  return null;
}

/**
 * One plan's score under a mode. Returns { score, eligible, why }.
 * `plan.steps[i]` carries p, delta, se; `skipWeight` (0-1] from the skip log multiplies the score's
 * positive part so a skipped option sinks without being hidden.
 */
export function scorePlan(plan, mode) {
  const e = pathExpectation(plan.steps);
  const w = plan.skip_weight ?? 1;
  const tilt = v => (v > 0 ? v * w : v);
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

/**
 * Rank candidate plans for a mode: drop tolerance breakers (kept in `dropped` with
 * the reason), score the rest, sort best first (ties: expected, then fewer steps).
 */
export function rankPlans(plans, mode, tol, ctx = {}) {
  const m = normaliseMode(mode);
  const kept = [], dropped = [];
  for (const p of plans) {
    const why = toleranceViolation(p, tol, ctx, m);
    if (why) { dropped.push({ plan: p, why }); continue; }
    const s = scorePlan(p, m);
    if (!s.eligible) { dropped.push({ plan: p, why: s.why }); continue; }
    kept.push({ ...p, ...s, mode: m });
  }
  kept.sort((a, b) => (b.score - a.score) || (b.expected - a.expected) || (a.steps.length - b.steps.length));
  return { ranked: kept, dropped };
}

/**
 * NO-TRADE-SHRINK: the do-nothing option. Keeping today's roster gains nothing, spreads nothing and
 * lands for sure, so every mode's objective scores it exactly 0 (safe: 0 - 0; balanced: 0; all_in: 0).
 */
export const NO_TRADE = Object.freeze({ expected: 0, if_complete: 0, p_complete: 1 });

/** Which option a mode's own objective prefers: its best plan only when it scores above doing nothing. */
export function noTradeRow(best) {
  if (!best) return { ...NO_TRADE, pick: 'no_trade', why: 'No plan fits this mode, so keeping your roster is the pick.' };
  return best.score > 0
    ? { ...NO_TRADE, pick: 'plan', why: 'The best plan scores above keeping your roster.' }
    : { ...NO_TRADE, pick: 'no_trade', why: 'The best plan scores no better than keeping your roster.' };
}

/** Same-dice comparison of the three modes' best plans, for the risk-mode sheet, each beside the no-trade option. */
export function compareModes(plans, ctxFor) {
  return MODES.map(mode => {
    const { tol, ctx } = ctxFor(mode);
    const best = rankPlans(plans, mode, tol, ctx).ranked[0] ?? null;
    return {
      mode, label: MODE_LABELS[mode],
      expected: best ? best.expected : null,
      if_complete: best ? best.delta_final : null,
      p_complete: best ? best.p_complete : null,
      first_step: best ? best.steps[0] : null,
      steps: best ? best.steps.length : null,
      no_trade: noTradeRow(best),
    };
  });
}

/* ------------------------------------------------------------ pre-rank shrinkage (SHADOW)
 * The optimizer's curse (ONE-PLAN spot-check row 6): the top of a ranking of noisy gains is biased
 * up, most for the noisiest. confirm.js measures the bias after the fact on fresh dice; this shrinks
 * BEFORE ranking. Normal-normal empirical Bayes with the prior centred on the no-trade gain (0):
 * tau^2 = max(0, mean(e^2) - mean(se^2)) over the candidate pool, shrunk e = e x tau^2 / (tau^2 + se^2).
 * Unproven (no graded plan outcome yet), so it is SHADOW: reported under _run.shrink, never read by the
 * ranker, the deck, the confirm pass or any served number.
 */

/** The shrinkage prior from a pool of { expected, expected_se }. tau2 null when no plan carries an SE. */
export function shrinkPrior(items) {
  const xs = items.filter(x => Number.isFinite(x.expected) && Number.isFinite(x.expected_se));
  if (!xs.length) return { tau2: null, n: 0 };
  const m2 = xs.reduce((s, x) => s + x.expected ** 2, 0) / xs.length;
  const v = xs.reduce((s, x) => s + x.expected_se ** 2, 0) / xs.length;
  return { tau2: Math.max(0, m2 - v), n: xs.length };
}

/** The share of a gain that survives shrinkage: tau^2 / (tau^2 + se^2), in [0, 1]; null when unknown. */
export function shrinkFactor(se, tau2) {
  if (!Number.isFinite(se) || !Number.isFinite(tau2)) return null;
  const d = tau2 + se ** 2;
  return d > 0 ? tau2 / d : 0;
}

/** One gain shrunk toward 0 (no trade); null when the SE or the prior is unknown. */
export function shrinkExpected(expected, se, tau2) {
  const k = shrinkFactor(se, tau2);
  return k == null || !Number.isFinite(expected) ? null : expected * k;
}

const planKey = p => { const s = p.steps[0]; return `${s.team}|${s.give.join('+')}|${s.get.join('+')}`; };

/**
 * Shadow report: per mode, the served best (point estimate) beside the best after shrinking each
 * plan's expected gain, and whether shrinkage would reorder the top. Balanced / safe objectives use
 * the shrunk expected (safe keeps its spread penalty); all_in's landing value is shrunk by the same
 * factor. Nothing here feeds a served number.
 */
export function shadowShrink(plans, ctxFor) {
  const scored = plans.map(p => ({ p, e: pathExpectation(p.steps) }));
  const prior = shrinkPrior(scored.map(x => x.e));
  const modes = MODES.map(mode => {
    const { tol, ctx } = ctxFor(mode);
    const ranked = rankPlans(plans, mode, tol, ctx).ranked;
    const best = ranked[0] ?? null;
    if (!best || prior.tau2 == null) {
      return { mode, best: best ? planKey(best) : null, shrunk_best: null, reorders: false,
        best_expected: best?.expected ?? null, best_shrunk_expected: null, shrunk_best_expected: null };
    }
    const shr = ranked.map(r => {
      const k = shrinkFactor(r.expected_se, prior.tau2);
      if (k == null) return { r, shrunk: null, score: null };
      const w = r.skip_weight ?? 1;
      const tilt = v => (v > 0 ? v * w : v);
      const shrunk = r.expected * k;
      const score = mode === 'safe' ? tilt(shrunk - SAFE_LAMBDA * r.sd)
        : mode === 'all_in' ? tilt(r.delta_final * k) : tilt(shrunk);
      return { r, shrunk, score };
    }).filter(x => x.score != null).sort((a, b) => b.score - a.score || (a.r.steps.length - b.r.steps.length));
    const top = shr[0] ?? null;
    const own = shr.find(x => x.r === best) ?? null;
    return { mode, best: planKey(best), shrunk_best: top ? planKey(top.r) : null,
      reorders: !!top && top.r !== best, best_expected: best.expected,
      best_shrunk_expected: own?.shrunk ?? null, shrunk_best_expected: top?.shrunk ?? null,
      shrunk_pick: top ? (top.score > 0 ? 'plan' : 'no_trade') : 'no_trade' };
  });
  return { status: 'shadow', tau2: prior.tau2, n: prior.n,
    basis: 'empirical Bayes toward the no-trade gain (0); not graded, reads nothing served', modes };
}
