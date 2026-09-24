/**
 * LIVING-01c: the activity-adjusted team mean in the season sim (R&D r25 IDEA-046).
 *
 * The frozen-roster sim plays every remaining week with the rosters as they stand.
 * A manager who keeps adding players improves his team, and one who leaves dead
 * starters in scores less than his roster says. r25 measured this on the Sleeper
 * replay: a team mean shifted by recent adds and dead starts beat the frozen sim
 * (playoff Brier +0.0039, weeks 10-14 points MSE +31.6), and the full checkout sim
 * added only +0.0008 Brier on top. So this is the part that ships: one points
 * shift per team per remaining week, and nothing else about the sim changes.
 *
 * Inputs are the two signals manager-signals.js already produces (one producer,
 * never recounted here), read through managerSignalsFor's priceable bag:
 *   tx_adds_per_week              adds through the last completed week / weeks
 *   lineup_dead_starts_last_week  final-lineup starters who did not play last week
 * The fit (scripts/rnd/living01c-fit.mjs) uses the same definitions on the corpus.
 * manager-signals.js also emits the spec's dead start (bye or Out tag at lineup
 * lock, `lineup_dead_starts_at_lock_last_week`); ACTIVITY_MEAN_FIT.dead_start_metric
 * picks which one is read, and it is the did-not-play one because that is the
 * corpus's "no stat row" definition, the one the coefficients were fitted on.
 *
 *   shift_t = per_add * (adds_t - league mean) + per_dead_start * (dead_t - league mean)
 *
 * League-centred, as fitted (league-week demeaned), so the shifts sum to ~0 and
 * move title odds between teams without inflating the league's scoring. Clamped
 * to +-cap points per week. A team with no value for a signal gets the league
 * mean for it (a 0 term), and says so.
 *
 * Default-off behind GRIDIRON_ACTIVITY_MEAN=1 or preview mode (preview-mode.js).
 * Until the coefficients are fitted it is inert even when on, with that reason.
 */
import { previewUnconfirmed, previewFields } from './preview-mode.js';
import { managerSignalsFor } from './manager-signals.js';

export const ACTIVITY_MEAN_ENV = 'GRIDIRON_ACTIVITY_MEAN';

export const ACTIVITY_MEAN_UNCONFIRMED =
  'activity-adjusted team mean (LIVING-01c): fitted on Sleeper 2021-22, held out 2023-24; no forward check on these leagues yet';

/** The two dead-start inputs manager-signals.js produces (FIX-273-3). */
export const DEAD_START_METRICS = Object.freeze({
  did_not_play: 'lineup_dead_starts_last_week',
  at_lock: 'lineup_dead_starts_at_lock_last_week',
});

/**
 * Points per week per unit of each signal, from scripts/rnd/living01c-fit.mjs
 * (fit 2021-22 Sleeper, graded 2023-24 held out). `fitted: false` keeps the
 * shift at zero until a fit that clears the gate is copied here.
 *
 * Gate (FIX-273-1): the held-out playoff Brier delta's 90% interval must clear 0 in
 * BOTH 2023 and 2024. The 2000-run corpus fit (per_add +2.490 SE 0.140, per_dead
 * -1.012 SE 0.153) cleared 2023 (+0.0011 [+0.0003, +0.0018]) but not 2024 (+0.0005
 * [-0.0004, +0.0013]); title Brier the same (2024 +0.0001 [-0.0003, +0.0006]). So the
 * null is recorded here and the coefficients stay out.
 */
export const ACTIVITY_MEAN_FIT = Object.freeze({
  fitted: false,
  per_add_per_week: null,
  per_dead_start: null,
  cap: 10,
  min_weeks: 4,
  dead_start_metric: DEAD_START_METRICS.did_not_play,
  gate: Object.freeze({
    rule: 'playoff Brier delta 90% CI above 0 in 2023 and in 2024 (held out)',
    passed: false,
    held_out: Object.freeze({
      2023: Object.freeze({ brier_delta: 0.00106, ci90: [0.00026, 0.00184], title_brier_delta: 0.00089, title_ci90: [0.00047, 0.00133] }),
      2024: Object.freeze({ brier_delta: 0.0005, ci90: [-0.00039, 0.00135], title_brier_delta: 0.00012, title_ci90: [-0.00034, 0.00055] }),
    }),
  }),
  source: 'scripts/rnd/living01c-fit.mjs, Sleeper 2021-22 fit, 2000 runs; 2024 held-out interval crosses 0, so not fitted',
});

/** On by the site flag or by preview mode; read per call so a test can flip it. */
export function activityMeanOn() {
  const flag = process.env[ACTIVITY_MEAN_ENV] === '1';
  const preview = !flag && previewUnconfirmed();
  return { on: flag || preview, preview };
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Per-team weekly points shift. Pure: `signals` is managerSignalsFor's Map
 * (roster_id -> { metrics, samples }), `teamIds` the sim's roster ids.
 * Returns { applied, reason, shifts: Map<roster_id, number>, teams: [...] }.
 */
export function activityShifts(signals, teamIds, fit = ACTIVITY_MEAN_FIT) {
  const ids = teamIds.map(String);
  const zero = reason => ({ applied: false, reason, shifts: new Map(), teams: [] });
  if (!fit.fitted || !Number.isFinite(fit.per_add_per_week) || !Number.isFinite(fit.per_dead_start)) {
    return zero(`coefficients not fitted: ${fit.gate && fit.gate.passed === false ? "the held-out gate did not pass" : "pending the corpus run"} (scripts/rnd/living01c-fit.mjs)`);
  }
  const bag = new Map([...(signals ?? new Map())].map(([k, v]) => [String(k), v]));
  const read = (id, metric, minN = 0) => {
    const m = bag.get(id);
    const v = m?.metrics?.[metric];
    if (!Number.isFinite(v)) return null;
    if ((m.samples?.[metric] ?? 0) < minN) return null;
    return v;
  };
  const adds = new Map(ids.map(id => [id, read(id, 'tx_adds_per_week', fit.min_weeks)]));
  const deadMetric = fit.dead_start_metric ?? DEAD_START_METRICS.did_not_play;
  const dead = new Map(ids.map(id => [id, read(id, deadMetric)]));
  const known = m => [...m.values()].filter(v => v != null);
  if (!known(adds).length && !known(dead).length) {
    return zero(`no team has tx_adds_per_week (>= ${fit.min_weeks} weeks) or ${deadMetric}`);
  }
  const addsMean = known(adds).length ? mean(known(adds)) : 0;
  const deadMean = known(dead).length ? mean(known(dead)) : 0;
  const shifts = new Map();
  const teams = ids.map(id => {
    const a = adds.get(id), d = dead.get(id);
    const raw = (a == null ? 0 : fit.per_add_per_week * (a - addsMean))
      + (d == null ? 0 : fit.per_dead_start * (d - deadMean));
    const shift = +Math.max(-fit.cap, Math.min(fit.cap, raw)).toFixed(2);
    shifts.set(id, shift);
    const missing = [a == null && 'tx_adds_per_week', d == null && deadMetric].filter(Boolean);
    return { roster_id: id, shift, adds_per_week: a, dead_starts_last_week: d, capped: shift !== +raw.toFixed(2),
      ...(missing.length ? { missing, missing_reason: 'no value: the league mean is used (a 0 term)' } : {}) };
  });
  return { applied: true, reason: null, shifts, teams };
}

/**
 * What simulateSeason applies: null when off (the frozen sim, byte-for-byte),
 * else { shifts, report } with the report the payload carries.
 * `on` (true/false) overrides the flag for a caller or test.
 */
export function activityMeanFor(lg, teamIds, { on = null, fit = ACTIVITY_MEAN_FIT, signals = null } = {}) {
  const flag = on == null ? activityMeanOn() : { on, preview: false };
  if (!flag.on) return null;
  const s = activityShifts(signals ?? managerSignalsFor(lg.id), teamIds, fit);
  return {
    shifts: s.applied ? s.shifts : new Map(),
    report: {
      on: true, applied: s.applied, reason: s.reason,
      coefficients: { per_add_per_week: fit.per_add_per_week, per_dead_start: fit.per_dead_start,
        cap: fit.cap, min_weeks: fit.min_weeks, fitted: fit.fitted, source: fit.source,
        dead_start_metric: fit.dead_start_metric ?? DEAD_START_METRICS.did_not_play },
      teams: s.teams,
      ...(flag.preview ? previewFields(ACTIVITY_MEAN_UNCONFIRMED) : {}),
    },
  };
}
