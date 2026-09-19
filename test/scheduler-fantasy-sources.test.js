/**
 * The fantasy ingestion chain must actually be on a timer (2026-09-19).
 *
 * On the deployed app the players table held 448 seed rows with no external id
 * on any of them, and the weekly usage, snap and projection tables were empty,
 * while the feeds themselves were reachable and working. The reason was not the
 * AUTO_HEAVY_SYNC flag everyone was looking at: these sources were registered
 * in source-registry.js's MANUAL_SOURCES, which means no timer at all, so they
 * only ran when somebody called their /sync route by hand, and nobody ever did.
 *
 * The chain also has a real ordering dependency — usage is keyed on gsis_id,
 * which only the crosswalk sets, which in turn needs espn_id from the ESPN
 * player sync — so these tests pin the order as well as the registration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fantasy-sources-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const scheduler = await import('../server/services/scheduler.js');
const registry = await import('../server/services/source-registry.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const FANTASY_CHAIN = ['nflverse_crosswalk', 'nflverse_weekly_usage', 'nflverse_snap_counts',
  'espn_depth_chart', 'espn_season_stats', 'sleeper_players'];

test('every fantasy source is on a timer, not waiting for someone to press a button', () => {
  for (const name of FANTASY_CHAIN) {
    assert.ok(scheduler.JOBS[name], `${name} has no scheduled job — it can only ever run by hand`);
    assert.ok(Number.isFinite(scheduler.JOBS[name].maxAgeMinutes), `${name} needs a cadence`);
  }
});

test('none of them is listed twice — allSources() concatenates without dedup', () => {
  const names = registry.allSources().map(s => s.source);
  const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(duplicated, [],
    'a source left in both MANUAL_SOURCES and JOBS is reported twice with two different cadences');
  for (const name of FANTASY_CHAIN) {
    assert.equal(registry.allSources().find(s => s.source === name)?.scheduled, true,
      `${name} should now report as scheduled`);
  }
});

test('the crosswalk runs before the usage sync that depends on it', () => {
  const order = Object.keys(scheduler.JOBS);
  assert.ok(order.indexOf('nflverse_crosswalk') < order.indexOf('nflverse_weekly_usage'),
    'a tier runs its jobs in this order; usage is keyed on the gsis_id the crosswalk sets');
});

test('the heavy nflverse parses stay off the request thread', () => {
  for (const name of ['nflverse_crosswalk', 'nflverse_weekly_usage', 'nflverse_snap_counts']) {
    assert.equal(scheduler.JOBS[name].offThread, true,
      `${name} parses a whole-season CSV synchronously; on the main thread that is the outage`);
  }
});

test('none of the fantasy chain is gated behind AUTO_HEAVY_SYNC', () => {
  for (const name of FANTASY_CHAIN) {
    assert.notEqual(scheduler.JOBS[name].tier, 'heavy',
      `${name} on the heavy tier only runs when an opt-in flag is set, which is how these came to never run`);
  }
});

test('a missing precondition is reported as a skip with its reason, not as a failure', async () => {
  // The database here has no players at all, which is the state the live app
  // was effectively in. Both jobs must recognize that and say so rather than
  // throwing — an error would start a failure backoff over an ordering gap
  // that the job ahead of them is about to close.
  const crosswalk = await scheduler.runIfStale('nflverse_crosswalk', { force: true });
  assert.equal(crosswalk.error, undefined, 'a precondition gap must not be an error');
  assert.match(crosswalk.detail?.skipped ?? '', /espn_id/);
  assert.equal(scheduler.lastRun('nflverse_crosswalk').last_status, 'skipped');

  const usage = await scheduler.runIfStale('nflverse_weekly_usage', { force: true });
  assert.equal(usage.error, undefined);
  assert.match(usage.detail?.skipped ?? '', /gsis_id/);
  assert.equal(scheduler.lastRun('nflverse_weekly_usage').last_status, 'skipped');
});

test('a skipped job is retried shortly, not after its full cadence', () => {
  // nflverse_crosswalk is a 24-hour job; having skipped over a precondition
  // that another job clears within minutes, it must not sit out the day.
  const due = scheduler.nextDueMinutes('nflverse_crosswalk', scheduler.JOBS.nflverse_crosswalk);
  assert.ok(due <= 5, `expected a short retry after a skip, got ${due} minutes`);
});
