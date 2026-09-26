/**
 * OFFLINE / LAST-GOOD MODE (Batch D item 53, research E6 fail-safe).
 *
 * When a refresh fails, the War Room keeps serving the last good plans (the producer's
 * write is atomic, so a failed run already leaves the previous plans.json in place,
 * produce-plans.mjs main()) and now SAYS so: the view carries `last_good` with the plans'
 * own "as of" time and `send_blocked: true`, and the two War Room routes that mark an
 * offer as sent (POST /requests kind offer.sent, POST /negotiations) answer 409 until a
 * refresh succeeds. Nothing here computes or moves a number; it only labels and blocks.
 *
 * "A refresh failed" is read from sync_log, the one record every refresh step already
 * writes (scheduler.js#record): the ESPN league sync (league_rosters) and the War Room
 * producer (warroom_plans). A job counts as failed when its last status is 'error', or it
 * is 'running' after an error, or it has been 'running' longer than STUCK_MINUTES (a hung
 * run looks exactly like a slow one otherwise) or with no readable start time. No sync_log row for a job = no evidence
 * either way: not blocked. sync_log that cannot be read at all fails CLOSED (blocked, with
 * the reason), because a gate that cannot see must not wave a send through.
 *
 * Flag GRIDIRON_LAST_GOOD: '1' on; anything else off, and off is byte-equal to main (the
 * view has no `last_good`, the routes never read sync_log). Preview mode plays no part.
 * Pure apart from readRefreshRows, which is one parameterised SELECT on a handle passed in.
 */

export const LAST_GOOD_ENV = 'GRIDIRON_LAST_GOOD';

/** The refresh steps whose failure means the plans may be stale. Job id -> what the screen calls it. */
export const REFRESH_JOBS = Object.freeze({
  league_rosters: 'ESPN league sync',
  warroom_plans: 'plan refresh'
});

/** A run still 'running' after this long is treated as failed (hand-set; the producer's slowest measured run is ~98 s). */
export const STUCK_MINUTES = 90;

/** 'on' only for an explicit '1'. */
export function lastGoodFlag(env = process.env) {
  return env?.[LAST_GOOD_ENV] === '1' ? 'on' : 'off';
}

/** The sync_log rows for REFRESH_JOBS. db: { rows(sql, ...params) }. Throws when the table cannot be read. */
export function readRefreshRows(db) {
  const jobs = Object.keys(REFRESH_JOBS);
  return db.rows(`SELECT job, last_run_at, last_status, last_detail, consecutive_failures
                    FROM sync_log WHERE job IN (${jobs.map(() => '?').join(', ')})`, ...jobs);
}

/** The start time recordStart wrote into a 'running' row's detail, or null when it is missing or unreadable. */
const startedAt = detail => {
  let parsed;
  try { parsed = JSON.parse(detail ?? 'null'); } catch (e) {
    if (e instanceof SyntaxError) return null; // not JSON: no start time; jobFailure fails closed on null
    throw e;
  }
  const t = Date.parse(parsed?.started_at);
  return Number.isFinite(t) ? t : null;
};

/** One sync_log row -> null (fine) or { job, label, kind: 'error' | 'stuck', since } */
export function jobFailure(r, { now = Date.now() } = {}) {
  if (!r || !(r.job in REFRESH_JOBS)) return null;
  const label = REFRESH_JOBS[r.job];
  const failures = Number(r.consecutive_failures) || 0;
  if (r.last_status === 'error') return { job: r.job, label, kind: 'error', since: r.last_run_at ?? null, consecutive: Math.max(1, failures) };
  if (r.last_status === 'running') {
    if (failures > 0) return { job: r.job, label, kind: 'error', since: r.last_run_at ?? null, consecutive: failures };
    const t = startedAt(r.last_detail);
    // recordStart always writes started_at; a running row without one cannot be dated, so it fails closed.
    if (t == null) return { job: r.job, label, kind: 'stuck', since: null, consecutive: 0 };
    if (now - t > STUCK_MINUTES * 60_000) {
      return { job: r.job, label, kind: 'stuck', since: new Date(t).toISOString(), consecutive: 0 };
    }
  }
  return null;
}

/**
 * The refresh state from sync_log rows (or the error reading them).
 * -> { status: 'ok' | 'failed' | 'unreadable', failed: [...] , reason? }
 */
export function refreshState({ rows = null, readError = null, now = Date.now() } = {}) {
  if (readError) return { status: 'unreadable', failed: [], reason: 'the refresh record could not be read' };
  const failed = (rows ?? []).map(r => jobFailure(r, { now })).filter(Boolean)
    .sort((a, b) => Object.keys(REFRESH_JOBS).indexOf(a.job) - Object.keys(REFRESH_JOBS).indexOf(b.job));
  return { status: failed.length ? 'failed' : 'ok', failed };
}

const sentenceList = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/**
 * The view's `last_good` block, or null when the refresh is fine.
 * plansAsOf: the served plans' generated_at (loadPlans().as_of).
 */
export function lastGoodBlock(state, { plansAsOf = null } = {}) {
  if (!state || state.status === 'ok') return null;
  const what = state.status === 'unreadable'
    ? 'the refresh record could not be read'
    : `the last ${sentenceList(state.failed.map(f => (f.kind === 'stuck' ? `${f.label} (stuck)` : f.label)))} failed`;
  const since = state.failed.map(f => f.since).filter(Boolean).sort()[0] ?? null;
  return {
    as_of: plansAsOf,
    failed: state.failed.map(f => ({ label: f.label, kind: f.kind, since: f.since })),
    failed_since: since,
    send_blocked: true,
    reason: `Offline: ${what}, so this is the last good plan${plansAsOf ? '' : ' (its time is unknown)'}. `
      + 'Sending is paused until a refresh succeeds.'
  };
}

/**
 * The one gate every War Room reader and send route calls.
 * -> null (flag off, or refresh fine) or the last_good block.
 * plansAsOf: the served plans' time, or an (async) function returning it.
 * read: () => rows (default: the app DB's sync_log, imported lazily so pure callers never open it).
 */
export async function currentLastGood({ env = process.env, now = Date.now(), plansAsOf = null, read = null } = {}) {
  if (lastGoodFlag(env) !== 'on') return null;
  let rows = null, readError = null;
  try {
    if (read) rows = await read();
    else {
      const db = await import('../../db/index.js');
      rows = readRefreshRows({ rows: db.rows });
    }
  } catch (e) { readError = e; }
  const state = refreshState({ rows, readError, now });
  if (state.status === 'ok') return null;
  // plansAsOf may be a function, so a caller reads the plans file only when a send is actually blocked.
  const asOf = typeof plansAsOf === 'function' ? await plansAsOf() : plansAsOf;
  return lastGoodBlock(state, { plansAsOf: asOf });
}
