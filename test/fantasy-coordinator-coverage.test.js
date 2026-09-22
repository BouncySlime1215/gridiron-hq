/**
 * What the fantasy coordinator was actually fitted on (2026-09-20).
 *
 * `buildFantasyCoordinatorExamples` drops training data in three places and, until this
 * change, counted none of them:
 *
 *   1. `predictRankGap(season, …).catch(() => null)` — a whole SEASON's `boom_bust_signal`
 *      becomes null if that call throws. Every example from that season then carries null for
 *      one of the three expert signals, and the fit still reports `ready: true` because the
 *      other rows satisfy MIN_ROWS.
 *   2. `try { engine = buildPlayerWeekEngine(…) } catch { continue; }` — a week whose engine
 *      will not build is dropped from the training set entirely.
 *   3. `if (!actuals.length) continue;` — a week with no settled usage. Legitimate, and still
 *      worth counting, because "the season is only 14 weeks old" and "eleven weeks failed to
 *      load" are different facts that produced the same row count.
 *
 * The fit reports `rows: examples.length`, so a shrunken training set is PARTLY visible — but a
 * short history and a history that failed to load are indistinguishable in that number, and the
 * per-signal case is invisible in it entirely.
 *
 * WHY THIS IS NOT HOUSEKEEPING. This file's own comment at `weeklyExpertValues` says
 * `boom_bust_signal` "already shrank to zero in the persisted fit … so computing it here would
 * only cost a GBM prediction for a coefficient the fit already learned to ignore." A signal that
 * is null for a large share of its training rows would shrink toward zero whether or not it
 * carries information. So the coverage figure is what decides whether that documented finding is
 * a measurement or an artifact of case 1 — and nothing recorded it. That question is not settled
 * here; what is built here is the number needed to settle it.
 *
 * CLAUDE.md: "a silent catch deleted a whole data layer and the page kept printing numbers as if
 * nothing had happened."
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coord-cov-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { buildFantasyCoordinatorExamples, fantasyCoordinatorExampleCoverage,
  COORDINATOR_COVERAGE_KEYS, refitFantasyCoordinator }
  = await import('../server/services/fantasy-coordinator.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('coverage is reported for a build that found nothing at all', async () => {
  // An empty database is the clearest case: every week is skipped for want of settled usage,
  // and that must read as a confident zero with a reason, not as a clean fit on no data.
  const examples = await buildFantasyCoordinatorExamples({ fromSeason: 2022, throughSeason: 2023 });
  const cov = fantasyCoordinatorExampleCoverage();

  assert.equal(examples.length, 0);
  assert.equal(cov.examples, 0);
  assert.equal(cov.weeks_considered, 2 * 18, 'two seasons of eighteen weeks were looked at');
  assert.equal(cov.weeks_no_actuals, 2 * 18,
    'every one was skipped for no settled usage, which is a different fact from an engine that '
    + 'would not build');
  assert.equal(cov.weeks_engine_failed, 0);
  assert.equal(cov.ok, false, 'a build that produced no examples is not ok');
});

test('a season whose boom-bust signal failed is named, not folded into the row count', async () => {
  const examples = await buildFantasyCoordinatorExamples({ fromSeason: 2022, throughSeason: 2023 });
  const cov = fantasyCoordinatorExampleCoverage();

  // predictRankGap needs history this database does not have, so it fails for both seasons.
  // The point is not that it failed -- it is that the failure is now a number with the seasons
  // attached, rather than a silent null on one of three expert signals.
  assert.ok(Array.isArray(cov.seasons_without_boom_bust));
  assert.deepEqual(cov.seasons_without_boom_bust, [2022, 2023],
    'the seasons whose boom-bust signal is null must be named, because a signal absent for a '
    + 'whole season shrinks toward zero whether or not it carries information');
  assert.equal(cov.examples_with_boom_bust, 0);
  // The ratio is the figure that decides whether "it shrank to zero" was a measurement.
  assert.equal(cov.boom_bust_share, 0,
    'share, not just a count: a coefficient fitted on a signal present in a fraction of rows is '
    + 'not evidence that the signal is uninformative');
  assert.equal(examples.length, 0);
});

test('the coverage report names every field it can ever carry', async () => {
  await buildFantasyCoordinatorExamples({ fromSeason: 2022, throughSeason: 2022 });
  const cov = fantasyCoordinatorExampleCoverage();
  assert.deepEqual(Object.keys(cov).sort(), [...COORDINATOR_COVERAGE_KEYS].sort(),
    'a drop that is counted but not listed here is a drop nobody can ask about');
  for (const k of ['weeks_considered', 'weeks_no_actuals', 'weeks_engine_failed', 'examples',
    'examples_with_boom_bust']) {
    assert.equal(typeof cov[k], 'number', `${k} must be a number, not absent`);
  }
});

test('coverage is re-derived per build, not accumulated across builds', async () => {
  await buildFantasyCoordinatorExamples({ fromSeason: 2022, throughSeason: 2023 });
  const twoSeasons = fantasyCoordinatorExampleCoverage().weeks_considered;
  await buildFantasyCoordinatorExamples({ fromSeason: 2022, throughSeason: 2022 });
  const oneSeason = fantasyCoordinatorExampleCoverage().weeks_considered;
  assert.equal(twoSeasons, 36);
  assert.equal(oneSeason, 18,
    'a stale verdict beside a fresh build is the same bug in a new place');
});

/* --------------------------------------------- the two faults that need a thrower

 * MEASURED, not assumed: neither dependency throws on a database with no history.
 * `predictRankGap` returns a falsy value, and `buildPlayerWeekEngine` does not throw even with
 * `nfl_player_week_features` renamed away. So the two catch blocks cannot be reached from any
 * fixture built out of data alone, and a counter nothing can reach is a counter nobody has
 * tested -- which is precisely how the first sweep of this file left three rows surviving.
 * Hence the injection seam, used here only to make them throw.
 */

test('a boom-bust signal that THROWS is recorded with its reason, not just counted absent', async () => {
  await buildFantasyCoordinatorExamples({
    fromSeason: 2022, throughSeason: 2022,
    rankGap: async () => { throw new Error('rank gap model unavailable'); }
  });
  const cov = fantasyCoordinatorExampleCoverage();
  assert.equal(cov.boom_bust_errors.length, 1,
    'a throw is a different fact from a signal that came back empty, and it is the one that '
    + 'means something is broken rather than merely missing');
  assert.equal(cov.boom_bust_errors[0].season, 2022);
  assert.match(cov.boom_bust_errors[0].error, /rank gap model unavailable/,
    'the reason must survive, or the report says only that something went wrong');
  assert.deepEqual(cov.seasons_without_boom_bust, [2022]);
});

test('a week whose engine throws is counted and sampled', async () => {
  // A week must first HAVE settled usage, or the engine is never reached.
  run(`INSERT INTO players (id, name, position) VALUES (?,?,?)`, 9101, 'Coverage Tester', 'WR');
  run(`INSERT INTO player_week_usage (player_id, season, week, team, opponent) VALUES (?,?,?,?,?)`,
    9101, 2022, 1, 'AAA', 'BBB');
  await buildFantasyCoordinatorExamples({
    fromSeason: 2022, throughSeason: 2022,
    buildEngine: () => { throw new Error('engine refused to build'); }
  });
  const cov = fantasyCoordinatorExampleCoverage();
  assert.equal(cov.weeks_engine_failed, 1,
    'a fit on sixty per cent of the weeks returns the same shape as a fit on all of them');
  assert.equal(cov.weeks_no_actuals, 17, 'and the legitimate skips stay separately counted');
  assert.equal(cov.engine_errors.length, 1);
  assert.equal(cov.engine_errors[0].week, 1);
  assert.match(cov.engine_errors[0].error, /engine refused to build/);
  assert.equal(cov.ok, false);
});

test('the stored fit carries the coverage it was fitted under', async () => {
  // The durable half. A stored fit whose row count is all it knows about its own training set
  // cannot later be asked whether a signal was absent when its coefficient was learned, which is
  // the question this file's boom_bust_signal finding turns on.
  const out = await refitFantasyCoordinator({ fromSeason: 2022, throughSeason: 2022 });
  assert.ok(out.fit, 'a refit returns its fit');
  assert.ok(out.fit.training_coverage,
    'the coverage must travel WITH the fit, not beside it where it is lost on save');
  assert.equal(typeof out.fit.training_coverage.weeks_considered, 'number');
  assert.equal(typeof out.fit.training_coverage.boom_bust_share, 'number');
});
