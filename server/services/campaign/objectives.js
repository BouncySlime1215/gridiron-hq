/**
 * CAMPAIGN-01a + north-star row 9: objectives and the feasibility report (pure).
 *
 * Objective kinds:
 *   title     maximise title odds (default)
 *   playoffs  maximise playoff odds (per-league setting)
 *   player    go get player X; scored on the league goal (title or playoffs)
 *   points    X projected points per week; scored on mean weekly lineup points
 *
 * The feasibility report answers: how likely, by when, at what cost, with bye
 * and injury warnings. Every number comes from the sim's per-run weekly lineup
 * points (the same world the plans are scored in).
 */
import { DEFAULT_MODE, normaliseMode, tolerancesFor } from './modes.js';
import { arrivalWeek } from './itinerary.js';

export const OBJECTIVE_KINDS = Object.freeze(['title', 'playoffs', 'player', 'points']);

/** Read one league's stored objective (file row) into a complete objective. */
export function normaliseObjective(raw = {}, { leagueGoal = 'title' } = {}) {
  const goal = raw.goal === 'playoffs' || leagueGoal === 'playoffs' ? 'playoffs' : 'title';
  let kind = OBJECTIVE_KINDS.includes(raw.kind) ? raw.kind : goal;
  if (kind === 'player' && raw.target == null) kind = goal;
  const ppw = Number(raw.points_per_week);
  if (kind === 'points' && !(ppw > 0)) kind = goal;
  const risk_mode = normaliseMode(raw.risk_mode ?? DEFAULT_MODE);
  const arrive = Number(raw.arrive_by);
  const until = Number(raw.risk_until_week);
  return {
    kind, goal,
    target: kind === 'player' ? String(raw.target) : null,
    points_per_week: kind === 'points' ? ppw : null,
    risk_mode,
    // Coach's set_risk_mode may end the mode at a week (then the league default returns).
    risk_until_week: Number.isInteger(until) && until >= 1 && until <= 18 ? until : null,
    tolerances: tolerancesFor(risk_mode, raw.tolerances ?? {}),
    arrive_by: Number.isInteger(arrive) && arrive > 0 ? arrive : null,
    stops: Array.isArray(raw.stops) ? raw.stops.filter(s => s && typeof s.kind === 'string') : [],
    untouchables: Array.isArray(raw.untouchables) ? raw.untouchables.map(String) : [],
    version: Number.isInteger(raw.version) ? raw.version : 0,
    source: raw && Object.keys(raw).length ? 'objectives_file' : 'default',
  };
}

/** The label the top strip shows. */
export function objectiveLabel(o, names = {}) {
  if (o.kind === 'player') return `Get ${names[o.target] ?? `player ${o.target}`}`;
  if (o.kind === 'points') return `${o.points_per_week} projected pts a week`;
  return o.goal === 'playoffs' ? 'Make the playoffs' : 'Win the title';
}

/** Which sim metric a rescore is judged on. */
export function metricKey(o) {
  if (o.kind === 'points') return 'points';
  return o.goal === 'playoffs' ? 'playoff' : 'title';
}

/** Pull { delta, se, clears, before } for the objective out of a rescore's `me` block. */
export function metricOf(me, o) {
  const k = metricKey(o);
  if (k === 'points') return { delta: me.points_delta, se: me.points_delta_se ?? null, clears: !!me.points_delta_clears, before: me.points_before };
  if (k === 'playoff') return { delta: me.playoff_delta, se: me.playoff_delta_se, clears: !!me.playoff_delta_clears_noise, before: me.playoff_before };
  return { delta: me.title_delta, se: me.title_delta_se, clears: !!me.title_delta_clears_noise, before: me.title_before };
}

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

/**
 * Weekly lineup points in every run -> per-week means and the chance the season average reaches X.
 * weeks: [{ week, samples: number[] (one per run, same run order every week) }]
 */
export function weeklySummary(weeks, x) {
  const per = weeks.map(w => ({ week: w.week, mean: mean(w.samples),
    p_hit: w.samples.length ? w.samples.filter(v => v >= x).length / w.samples.length : null }));
  const runs = Math.min(...weeks.map(w => w.samples.length));
  let hit = 0;
  for (let r = 0; r < runs; r++) {
    let s = 0;
    for (const w of weeks) s += w.samples[r];
    if (s / weeks.length >= x) hit++;
  }
  return { per_week: per, season_mean: mean(per.map(p => p.mean)), p_average_hits: runs > 0 && Number.isFinite(runs) ? hit / runs : null, runs };
}

/**
 * The "X projected points a week" report.
 * now:      weeklySummary input for today's roster
 * options:  [{ label, weeks (weeklySummary input), p_complete, arrive_week, give: ids, steps }]
 * roster:   [{ id, name, position, bye, injury, starter }] for warnings
 */
export function pointsFeasibility({ target, now, options = [], roster = [], currentWeek }) {
  const base = weeklySummary(now, target);
  const opts = options.map(o => {
    const s = weeklySummary(o.weeks.filter(w => w.week >= o.arrive_week), target);
    const byWeek = s.per_week.find(w => w.mean >= target)?.week ?? null;
    return { label: o.label, p_complete: o.p_complete, arrive_week: o.arrive_week, steps: o.steps,
      cost_players: o.give.length, give: o.give, season_mean_after: s.season_mean,
      p_average_hits_if_done: s.p_average_hits,
      p_average_hits: o.p_complete * (s.p_average_hits ?? 0) + (1 - o.p_complete) * (base.p_average_hits ?? 0),
      first_week_at_target: byWeek };
  }).sort((a, b) => b.p_average_hits - a.p_average_hits);
  const warnings = [];
  for (const w of base.per_week) {
    if (w.mean >= target) continue;
    const onBye = roster.filter(p => p.starter && p.bye === w.week);
    if (onBye.length) warnings.push({ kind: 'bye', week: w.week, players: onBye.map(p => p.id),
      text: `Week ${w.week}: ${onBye.map(p => p.name).join(', ')} on bye; lineup projects ${w.mean.toFixed(1)} vs ${target}.` });
  }
  for (const p of roster.filter(q => q.starter && q.injury)) {
    warnings.push({ kind: 'injury', players: [p.id], text: `${p.name} carries an injury flag; his weeks may be zeros.` });
  }
  const best = opts[0] ?? null;
  const status = base.season_mean >= target ? 'on_track'
    : best && best.season_mean_after >= target ? 'reachable' : 'out_of_reach';
  return {
    target, status,
    now: { season_mean: base.season_mean, p_average_hits: base.p_average_hits, per_week: base.per_week },
    how_likely: best ? Math.max(best.p_average_hits, base.p_average_hits ?? 0) : base.p_average_hits,
    by_when: status === 'on_track' ? currentWeek : best?.first_week_at_target ?? null,
    at_what_cost: best ? { players: best.cost_players, give: best.give, steps: best.steps } : null,
    options: opts.slice(0, 5), warnings,
  };
}

/**
 * The "get player X" report: how likely (best plan's P(complete)), by when, at what cost.
 * plan: best ranked plan for the target or null.
 */
export function targetFeasibility({ target, plan, currentWeek, deadlineWeek, daysLeftInWeek = 7, injured = false, bye = null }) {
  if (!plan) {
    return { target, status: 'out_of_reach', how_likely: 0, by_when: null, at_what_cost: null,
      warnings: [], reason: 'no path to him fits the sliders this week' };
  }
  const by = arrivalWeek(plan, currentWeek, { daysLeftInWeek });
  const warnings = [];
  if (injured) warnings.push({ kind: 'injury', text: 'He carries an injury flag: check the report before sending.' });
  if (bye != null && bye >= currentWeek) warnings.push({ kind: 'bye', week: bye, text: `His bye is week ${bye}.` });
  if (deadlineWeek != null && by > deadlineWeek) warnings.push({ kind: 'deadline', text: 'The path runs past the trade deadline.' });
  return { target, status: by <= (deadlineWeek ?? Infinity) ? 'reachable' : 'out_of_reach',
    how_likely: plan.p_complete, by_when: by,
    at_what_cost: { players: [...new Set(plan.steps.flatMap(s => s.give))].length, steps: plan.steps.length,
      expected_gain: plan.expected },
    warnings };
}

