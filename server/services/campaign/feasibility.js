/**
 * FEAS-140 + north-star row 9: the "X projected points a week" card as a side panel (pure).
 *
 * Nick asked for the points objective on every league. When a league is planned on
 * title (or playoff, or get-player) odds, this card still answers the points
 * question next to it: how likely he reaches X projected points a week, by which
 * week, what the path costs in players and in title odds, and which byes and
 * injuries drag the lineup under X. X is the league's `side_points_per_week`
 * (objectives file), default 140.
 *
 * It re-uses objectives.js#pointsFeasibility on the same simulated world the plans
 * are scored in; the only new number is the title-odds cost of each option: the best
 * plan's expected title gain minus the option's (both from the same rescores).
 *
 * Flag: GRIDIRON_POINTS_FEASIBILITY ('1' on, '0' off). Unset, it follows the local
 * preview switch (preview-mode.js#previewUnconfirmed), so it is default-off in
 * production and on under the preview switch. A league whose objective
 * is already points keeps the main card; this returns null for it.
 */
import { pointsFeasibility, DEFAULT_SIDE_POINTS } from './objectives.js';
import { PREVIEW_ENV, previewUnconfirmed, previewFields } from '../preview-mode.js';

export const POINTS_FEASIBILITY_ENV = 'GRIDIRON_POINTS_FEASIBILITY';
export const DEFAULT_POINTS_TARGET = DEFAULT_SIDE_POINTS;
export const SIDE_OPTIONS = 5;
const PREVIEW_REASON = 'FEAS-140 points side panel: default-off until Nick confirms the card on the target league';

/** { on, preview } for the side panel. An explicit flag wins over the preview switch. */
export function pointsFeasibilityFlag(env = process.env) {
  const v = env[POINTS_FEASIBILITY_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const preview = env === process.env ? previewUnconfirmed() : env[PREVIEW_ENV] === '1';
  return { on: preview, preview };
}

/** The side-panel target: the league's configured number, else 140. */
export function sidePointsTarget(objective = {}) {
  const t = Number(objective.side_points_per_week);
  return t > 0 ? t : DEFAULT_POINTS_TARGET;
}

/**
 * objective:  normalised objective (objectives.js#normaliseObjective)
 * nowWeeks:   weeklySummary input for today's roster ([{ week, samples }]) or null
 * plans:      ranked plans on the league objective, best first:
 *             [{ label?, expected, p_complete, arrive_week, give: ids, steps: n, weeks: [{ week, samples }] }]
 * roster:     [{ id, name, bye, injury, starter }]
 * Returns null when the flag is off, the league is already on the points objective,
 * or the world has no weekly lineup points. Otherwise the pointsFeasibility report
 * plus p_reach / arrive_week / cost (players and title odds) and the flag fields.
 */
export function sidePanelFeasibility({ objective, nowWeeks, plans = [], roster = [], currentWeek, env = process.env }) {
  const flag = pointsFeasibilityFlag(env);
  if (!flag.on || !objective || objective.kind === 'points' || !Array.isArray(nowWeeks) || !nowWeeks.length) return null;
  const target = sidePointsTarget(objective);
  const opts = plans.filter(p => Array.isArray(p?.weeks) && p.weeks.length).slice(0, SIDE_OPTIONS)
    .map((p, j) => ({ ...p, label: p.label ?? `plan ${j + 1}` }));
  const bestExpected = opts.length ? Math.max(...opts.map(p => Number(p.expected) || 0)) : 0;
  const titleCost = new Map(opts.map(p => [p.label, Math.max(0, bestExpected - (Number(p.expected) || 0))]));
  const r = pointsFeasibility({ target, now: nowWeeks, currentWeek, roster,
    options: opts.map(p => ({ label: p.label, weeks: p.weeks, p_complete: p.p_complete, arrive_week: p.arrive_week,
      give: p.give ?? [], steps: p.steps })) });
  const options = r.options.map(o => ({ ...o, title_odds_cost: titleCost.get(o.label) ?? null }));
  const best = options[0] ?? null;
  const onTrack = r.status === 'on_track';
  return {
    kind: 'points', side_panel: true, league_objective: objective.kind, ...r, options,
    p_reach: r.how_likely,
    arrive_week: r.by_when,
    cost: onTrack || !best ? { players: 0, give: [], steps: 0, title_odds: 0, basis: onTrack ? 'already on track' : 'no plan to price' }
      : { players: best.cost_players, give: best.give, steps: best.steps, title_odds: best.title_odds_cost,
        basis: 'best plan on the league objective minus this option, same rescores' },
    warnings_count: { bye: r.warnings.filter(w => w.kind === 'bye').length, injury: r.warnings.filter(w => w.kind === 'injury').length },
    ...(flag.preview ? previewFields(PREVIEW_REASON) : {}),
  };
}
