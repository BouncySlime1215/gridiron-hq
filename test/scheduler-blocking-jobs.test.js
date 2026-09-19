/**
 * The jobs that were still parsing megabytes on the request thread (2026-09-19).
 *
 * Making the heavy tier off-thread fixed the eleven jobs behind AUTO_HEAVY_SYNC.
 * It did not fix the two 'growth'-tier jobs that always run and are just as
 * blocking, and which the flag therefore never protected anyone from:
 *
 *   nfelo_sync     six CSVs, qb_elos.csv alone 6.4 MB; one run on the Fly
 *                  machine was timed at 69 seconds
 *   ffopportunity  ~5.4 MB per completed season, and it pulled four seasons
 *                  every three days to arrive at rows it already had
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-blocking-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db } = await import('../server/db/index.js');
const scheduler = await import('../server/services/scheduler.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('the two always-on jobs that parse megabytes do not run on the request thread', () => {
  for (const name of ['nfelo_sync', 'ffopportunity']) {
    assert.equal(scheduler.JOBS[name].offThread, true,
      `${name} is on the growth tier, so it always runs; on the main thread that is a multi-second freeze`);
  }
});

test('a completed season already held is not pulled again', () => {
  const insert = db.prepare(`INSERT INTO nfl_ffopportunity_weekly
    (season,week,player_gsis_id,player_name,team,position,expected_fantasy_points,
     actual_fantasy_points,expected_pass_points,expected_receive_points,
     expected_rush_points,expected_total_yards,expected_touchdowns,source_release,ingested_at)
    VALUES (?,1,'00-0000001','Test Player','KC','WR',1,1,0,1,0,10,0,'test',datetime('now'))`);
  for (const season of [2023, 2024, 2025]) insert.run(season);

  assert.deepEqual(scheduler.ffOpportunitySeasons(2026), [2026],
    'a completed season ffverse never revises must not be re-parsed to arrive at the rows already stored');
});

test('a season we do not hold yet is still backfilled', () => {
  db.exec('DELETE FROM nfl_ffopportunity_weekly');
  assert.deepEqual(scheduler.ffOpportunitySeasons(2026), [2023, 2024, 2025, 2026],
    'the backfill must still happen on a fresh install — it just happens once');
});

test('a partially held history backfills only the gap', () => {
  db.exec('DELETE FROM nfl_ffopportunity_weekly');
  db.prepare(`INSERT INTO nfl_ffopportunity_weekly
    (season,week,player_gsis_id,player_name,team,position,expected_fantasy_points,
     actual_fantasy_points,expected_pass_points,expected_receive_points,
     expected_rush_points,expected_total_yards,expected_touchdowns,source_release,ingested_at)
    VALUES (2024,1,'00-0000001','Test Player','KC','WR',1,1,0,1,0,10,0,'test',datetime('now'))`).run();
  assert.deepEqual(scheduler.ffOpportunitySeasons(2026), [2023, 2025, 2026]);
});

test('an off-thread job cannot be module-mocked from the main thread', () => {
  // Recorded as a fact about the mechanism, not a wish: the worker imports its
  // own copy of every module, so `t.mock.module` here does not reach it. Any
  // test of an off-thread job's logic must target that logic directly, which is
  // why ffOpportunitySeasons is exported.
  assert.equal(scheduler.JOBS.ffopportunity.offThread, true);
});

test('the two live-status jobs that were burning their whole budget on the request thread are off it', () => {
  // Measured on the deployed app 2026-09-19, from /api/mlb/sync/status:
  //
  //   evidence_daemon  live   error  29 runs  "exceeded its 120s budget and
  //                                            was abandoned so the rest of
  //                                            the tier could run"
  //   nfl_reports      growth error   3 runs  same message
  //
  // evidence_daemon is maxAgeMinutes 5 on the 90-second live tick, so that was
  // happening continuously, on the thread serving requests, and nothing about
  // AUTO_HEAVY_SYNC touched it.
  for (const name of ['evidence_daemon', 'nfl_reports']) {
    assert.equal(scheduler.JOBS[name].offThread, true,
      `${name} spent its entire 120s budget on every attempt; that cost belongs on a worker`);
  }
});

test('moving a job off-thread does not change its tier or its cadence', () => {
  // The point of this change is scheduling, not behaviour. If either of these
  // drifted, the job would be running at a different rate than the live
  // measurement above was taken at, and the comparison would be worthless.
  assert.equal(scheduler.JOBS.evidence_daemon.tier, 'live');
  assert.equal(scheduler.JOBS.evidence_daemon.maxAgeMinutes, 5);
  assert.equal(scheduler.JOBS.nfl_reports.tier, 'growth');
  assert.equal(scheduler.JOBS.nfl_reports.maxAgeMinutes, 180);
});
