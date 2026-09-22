/**
 * The nflverse usage feed must not report 'ok' for a season it did not write
 * (2026-09-20).
 *
 * THE BUG. `syncAll(seasons)` loops over the season list and calls
 * `recordSync('nflverse_weekly_usage', ...)` once per season. `sync_log` is
 * keyed on `job`, one row per job, so the last season in the list overwrites
 * every earlier verdict. Five seasons could fail and the sixth succeed and the
 * feed reads 'ok' with `consecutive_failures` reset to 0, because
 * `record()` resets that counter on anything that is not an error.
 *
 * The second half is worse. `syncWeeklyUsage` returns
 * `{ season, rows, inserted, unmatched }` and only THROWS on a fetch or a
 * schema failure. A season whose CSV downloaded fine but matched no player in
 * the crosswalk returns `{ rows: 4210, inserted: 0, unmatched: 4210 }` — no
 * `error` key, so `usage.error ? 'error' : 'ok'` stamps it 'ok'. That is a
 * green feed over an empty table, which is the exact shape of the live gap:
 * `player_week_usage` holds 2021-2025 and nothing for 2026, while
 * `nfl-model-growth.js:187` asks for `[2026]` on every boot (gated on
 * `coreLag`, which is true *because* the table has no 2026 rows) and
 * `source-registry.js` reads a status row that says the feed is fine.
 *
 * So the season list was never the blocker — 2026 is requested. These tests
 * pin two things: one status for the whole run, derived from what the run
 * actually wrote, and a coverage read that asks `player_week_usage` what it
 * holds rather than believing the stamp.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-nflverse-usage-truth-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { run, row } = await import('../server/db/index.js');
const { statusFromDetail, recordSync, lastRun } = await import('../server/services/scheduler.js');
const nflverse = await import('../server/services/nflverse.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const ok = (season, n = 4000) => ({ season, rows: n, inserted: n - 10, unmatched: 10 });
const unmatched = (season, n = 4000) => ({ season, rows: n, inserted: 0, unmatched: n });
const failed = (season, message = 'HTTP 404') => ({ season, error: message });
const empty = season => ({ season, rows: 0, inserted: 0, unmatched: 0 });

/* --------------------------------------------- one season's own verdict */

test('a season that downloaded rows and inserted none is not ok, however it returned', () => {
  assert.equal(nflverse.usageSeasonOutcome(unmatched(2026)), 'unmatched');
  assert.equal(nflverse.usageSeasonOutcome(ok(2025)), 'ok');
  assert.equal(nflverse.usageSeasonOutcome(failed(2026)), 'error');
});

test('a season the upstream release has no regular-season rows for is distinguishable', () => {
  // Not a failure of ours and not a success either: nothing was published yet.
  assert.equal(nflverse.usageSeasonOutcome(empty(2027)), 'upstream_empty');
});

/* ------------------------------------------ the whole run's own verdict */

test('one failing season in a six-season run cannot be overwritten by a later success', () => {
  const summary = nflverse.usageRunSummary(
    [2021, 2022, 2023, 2024, 2025].map(s => failed(s)).concat([ok(2026)]));
  assert.equal(summary.seasons, 6);
  assert.equal(summary.failed, 5);
  assert.equal(statusFromDetail(summary), 'partial',
    'five of six seasons failed — the run is not ok because the last one worked');
});

test('a run where every season matched nothing is an error, not a green feed', () => {
  const summary = nflverse.usageRunSummary([unmatched(2026)]);
  assert.equal(summary.failed, 1);
  assert.equal(statusFromDetail(summary), 'error');
});

test('a clean run is still ok — this narrows a too-generous default, it does not invert it', () => {
  const summary = nflverse.usageRunSummary([2024, 2025, 2026].map(s => ok(s)));
  assert.equal(summary.failed, 0);
  assert.equal(statusFromDetail(summary), 'ok');
});

test('a run with nothing published upstream reports skipped, so it does not read as fresh', () => {
  const summary = nflverse.usageRunSummary([empty(2027)]);
  assert.equal(summary.empty, 1);
  assert.equal(summary.failed, 0);
  assert.equal(statusFromDetail(summary), 'skipped');
});

test('the summary keeps every season, so the detail stored names which one broke', () => {
  const summary = nflverse.usageRunSummary([ok(2025), unmatched(2026)]);
  assert.deepEqual(summary.per_season.map(s => [s.season, s.outcome]),
    [[2025, 'ok'], [2026, 'unmatched']]);
  assert.equal(summary.per_season.find(s => s.season === 2026).unmatched, 4000);
});

/* ------------------------------------------------- what reaches sync_log */

test('a six-season run leaves ONE sync_log row, not six that overwrite each other', () => {
  const before = Number(row("SELECT runs FROM sync_log WHERE job = 'nflverse_weekly_usage'")?.runs) || 0;
  nflverse.recordUsageRun({
    usage: [2021, 2022, 2023, 2024, 2025].map(s => failed(s)).concat([ok(2026)]),
    snaps: [2021, 2022, 2023, 2024, 2025, 2026].map(s => ok(s))
  });
  const stamp = lastRun('nflverse_weekly_usage');
  assert.equal(Number(stamp.runs) - before, 1,
    'the old loop stamped once per season, so the last season decided the feed');
  assert.equal(stamp.last_status, 'partial',
    'five of six seasons failed — a later success must not erase that');
  assert.equal(lastRun('nflverse_snap_counts').last_status, 'ok',
    'the feeds are stamped independently');
});

test('a run that matched no player anywhere stamps error, and the detail names the seasons', () => {
  nflverse.recordUsageRun({ usage: [unmatched(2026)], snaps: [unmatched(2026)] });
  const stamp = lastRun('nflverse_weekly_usage');
  assert.equal(stamp.last_status, 'error');
  assert.equal(Number(stamp.consecutive_failures), 1, 'an error must accumulate a backoff');
  assert.deepEqual(JSON.parse(stamp.last_detail).per_season.map(s => [s.season, s.outcome]),
    [[2026, 'unmatched']]);
});

/* --------------------------------------------------- coverage vs. stamp */

// player_week_usage.player_id carries a foreign key, so the players have to
// exist before a usage row can.
const player = name => Number(
  run('INSERT INTO players (name, position) VALUES (?, ?)', name, 'WR').lastInsertRowid);
const usageRow = (season, week, playerId) => run(
  'INSERT INTO player_week_usage (player_id, season, week) VALUES (?,?,?)', playerId, season, week);

test('coverage reads the table, not the status row', () => {
  const a = player('Usage One'), b = player('Usage Two');
  usageRow(2025, 1, a);
  usageRow(2025, 2, a);
  usageRow(2025, 1, b);
  const cov = nflverse.usageCoverage([2025, 2026]);
  assert.equal(cov.per_season.find(s => s.season === 2025).rows, 3);
  assert.equal(cov.per_season.find(s => s.season === 2025).players, 2);
  assert.deepEqual(cov.missing, [2026]);
});

test('a green stamp over a season with no rows is reported as a disagreement', () => {
  recordSync('nflverse_weekly_usage', 'ok', { seasons: 1, failed: 0 });
  const cov = nflverse.usageCoverage([2025, 2026]);
  assert.equal(cov.stamp.status, 'ok');
  assert.ok(cov.stamp_disagrees,
    'the feed claims ok while 2026 has no rows — that is the live failure this names');
});

test('a feed that has never run is not a disagreement, it is a feed that has never run', () => {
  const never = nflverse.usageCoverage([2026], { job: 'nflverse_weekly_usage_never_run' });
  assert.deepEqual(never.missing, [2026]);
  assert.ok(never.never_run, 'no sync_log row at all');
  assert.equal(never.stamp_disagrees, false,
    'a feed that has made no claim cannot be contradicting the table');
});

test('coverage with no argument reports every season the table holds', () => {
  const cov = nflverse.usageCoverage();
  assert.deepEqual(cov.per_season.map(s => s.season), [2025]);
  assert.equal(cov.missing.length, 0, 'asking about what is held cannot report a gap');
});
