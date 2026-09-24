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

/** Same-dice comparison of the three modes' best plans, for the risk-mode sheet. */
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
    };
  });
}
