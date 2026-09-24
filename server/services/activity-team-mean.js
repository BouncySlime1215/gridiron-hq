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

/**
 * Points per week per unit of each signal, from scripts/rnd/living01c-fit.mjs
 * (fit 2021-22 Sleeper, graded 2023-24 held out). `fitted: false` keeps the
 * shift at zero until the fit's output is copied here.
 */
export const ACTIVITY_MEAN_FIT = Object.freeze({
  fitted: false,
  per_add_per_week: null,
  per_dead_start: null,
  cap: 10,
  min_weeks: 4,
  source: 'scripts/rnd/living01c-fit.mjs, Sleeper 2021-22 fit; coefficients pending the corpus run',
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
    return zero('coefficients not fitted yet (scripts/rnd/living01c-fit.mjs)');
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
  const dead = new Map(ids.map(id => [id, read(id, 'lineup_dead_starts_last_week')]));
  const known = m => [...m.values()].filter(v => v != null);
  if (!known(adds).length && !known(dead).length) {
    return zero(`no team has tx_adds_per_week (>= ${fit.min_weeks} weeks) or lineup_dead_starts_last_week`);
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
    const missing = [a == null && 'tx_adds_per_week', d == null && 'lineup_dead_starts_last_week'].filter(Boolean);
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
        cap: fit.cap, min_weeks: fit.min_weeks, fitted: fit.fitted, source: fit.source },
      teams: s.teams,
      ...(flag.preview ? previewFields(ACTIVITY_MEAN_UNCONFIRMED) : {}),
    },
  };
}
