/**
 * PLANS-EXPIRE: how old a league's War Room plan is, and when it stops being actionable.
 *
 * A --leagues run (the refresh loop's GRIDIRON_WARROOM_LEAGUES) replans only those leagues and
 * copies every other league's previous entry into the new file (produce-plans.mjs#mergeKept),
 * under the new file's generated_at. So the file time says nothing about a kept entry. Each
 * entry therefore carries its own `planned_at` (the contract's optional entry key): the producer
 * stamps every entry it plans (stampPlannedAt, in main() only, so buildPlansFile and the
 * committed contract fixture are unchanged) and a kept entry keeps its stamp.
 *
 * The view (war-room-view.js#buildWarRoomView) serves an entry older than PLAN_MAX_AGE_HOURS as
 * "plan out of date": every section hidden with the reason, nothing actionable. A kept entry with
 * no stamp in a file where others have one (kept from before this unit) has an unknown age and
 * is out of date too. A file with no stamps at all (older producer, fixtures) is not judged.
 *
 * Flag GRIDIRON_PLANS_EXPIRE: ON BY DEFAULT (it only hides; it never computes a number). Only an
 * explicit '0' turns it off. Preview mode plays no part. Pure: env and clock arrive as arguments.
 */

export const PLANS_EXPIRE_ENV = 'GRIDIRON_PLANS_EXPIRE';
/** A plan older than this is out of date (Batch D item 3). */
export const PLAN_MAX_AGE_HOURS = 24;

/** 'on' (default) | 'off' (only an explicit '0'). */
export function plansExpireFlag(env = {}) {
  return env?.[PLANS_EXPIRE_ENV] === '0' ? 'off' : 'on';
}

export const PLANS_EXPIRE_OFF_WARNING =
  `WARNING: ${PLANS_EXPIRE_ENV}=0 turns OFF plan expiry: a kept plan of any age is served as actionable.`;

/** The file with `planned_at` = its generated_at on every entry that has none. Returns a new file. */
export function stampPlannedAt(file) {
  return { ...file, leagues: file.leagues.map(e => ('planned_at' in e ? e : { ...e, planned_at: file.generated_at })) };
}

/**
 * entry: one plans entry; entries: every entry in its file; now: ms.
 * -> { status: 'fresh' | 'out_of_date' | 'undated', planned_at, age_hours, max_hours, reason? }
 */
export function planAge(entry, { entries = [], now = Date.now(), maxHours = PLAN_MAX_AGE_HOURS } = {}) {
  const base = { max_hours: maxHours };
  if (!entry || !('planned_at' in entry)) {
    if (!entries.some(e => e && 'planned_at' in e)) return { status: 'undated', planned_at: null, age_hours: null, ...base };
    return { status: 'out_of_date', planned_at: null, age_hours: null, ...base,
      reason: `Plan out of date: this league's plan was kept from an older run and its age is unknown, so it is not actionable. It comes back on this league's next replan.` };
  }
  const t = typeof entry.planned_at === 'string' ? Date.parse(entry.planned_at) : NaN;
  if (!Number.isFinite(t)) {
    return { status: 'out_of_date', planned_at: null, age_hours: null, ...base,
      reason: `Plan out of date: this league's plan time is unreadable, so its age is unknown and it is not actionable. It comes back on this league's next replan.` };
  }
  const ageMs = now - t;
  const age_hours = Math.max(0, Math.floor(ageMs / 3_600_000));
  if (!(ageMs > maxHours * 3_600_000)) return { status: 'fresh', planned_at: entry.planned_at, age_hours, ...base };
  return { status: 'out_of_date', planned_at: entry.planned_at, age_hours, ...base,
    reason: `Plan out of date: this league was last planned ${age_hours} h ago (plans go out of date after ${maxHours} h), so it is not actionable. It comes back on this league's next replan.` };
}

/**
 * integration-10a: the one staleness gate for every reader of a plans entry that is not the War Room
 * view (Coach's plan_read, starter answers, the brief), so Coach never states a move the War Room hides
 * as out of date. -> the out-of-date reason (string) or null (fresh, undated file, or the flag off).
 */
export function outOfDateReason(entry, entries = [], { env = process.env, now = Date.now() } = {}) {
  if (plansExpireFlag(env) !== 'on') return null;
  const age = planAge(entry, { entries, now });
  return age.status === 'out_of_date' ? age.reason : null;
}
