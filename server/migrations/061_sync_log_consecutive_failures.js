export const name = '061_sync_log_consecutive_failures';
/**
 * `sync_log.consecutive_failures` — how many times in a row a job has failed.
 *
 * Why this column has to exist: scheduler.js decides whether to run a job from
 * `last_run_at` alone, and `record()` stamps `last_run_at` on failure exactly
 * as it does on success. So a job that FAILS is immediately indistinguishable
 * from one that just succeeded, and is not attempted again until its full
 * `maxAgeMinutes` has elapsed. For `espn_rosters` that is 24 hours of darkness
 * after one transient 502; for `ffopportunity` it is three days. On the live
 * app those 502s are the normal failure (the machine was being OOM-killed on
 * large payloads), which is precisely the case where a retry minutes later
 * would have worked.
 *
 * A fixed short retry is not the answer either — it would hammer a genuinely
 * broken upstream every tick forever. Backing off needs to know how many
 * failures have already happened, and nothing in this table recorded that.
 */
export function up(db) {
  const cols = db.prepare('PRAGMA table_info(sync_log)').all().map(c => c.name);
  if (!cols.includes('consecutive_failures')) {
    db.exec('ALTER TABLE sync_log ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0');
    // Existing rows whose last run failed start at one failure rather than
    // zero, so the first backoff after an upgrade reflects reality instead of
    // treating a long-broken job as if it had just started failing.
    db.exec(`UPDATE sync_log SET consecutive_failures = 1 WHERE last_status = 'error'`);
  }
}

export function down(db) {
  const cols = db.prepare('PRAGMA table_info(sync_log)').all().map(c => c.name);
  if (cols.includes('consecutive_failures')) db.exec('ALTER TABLE sync_log DROP COLUMN consecutive_failures');
}
