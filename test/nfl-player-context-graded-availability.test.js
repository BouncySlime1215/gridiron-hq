/**
 * Plan 01 / package #19 (Auditor units 11, 12, G5/G6): a graded, normalised
 * availability multiplier from the report_status a player actually carried,
 * fit from `nfl_injuries` (the designation roster -- an Out/Doubtful player
 * mostly has no `player_week_usage` row at all, so that table alone cannot
 * see them) and consumed as-of a decision time via `nfl_feature_revisions`,
 * never `nfl_injuries` directly (`nfl_injuries` UPSERTs in place and holds
 * only the final designation -- reading it for a Sunday-lock decision is a
 * look-ahead leak).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-graded-availability-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { fitGradedAvailability, gradedAvailabilityMultiplier } = await import('../server/services/nfl-player-context.js');
const { recordRevision } = await import('../server/services/nfl-bitemporal.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

let nextId = 1;
const insertPlayer = (name, position, gsisId) => {
  const id = nextId++;
  run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant) VALUES (?,?,?,?,1)`,
    id, name, position, gsisId);
  return id;
};

const insertUsage = (playerId, season, week, targets) => run(
  `INSERT INTO player_week_usage (player_id, season, week, team, opponent, position, targets, carries, attempts)
   VALUES (?,?,?, 'AAA', 'BBB', 'WR', ?,0,0)`,
  playerId, season, week, targets);

const insertInjury = (gsisId, season, week, reportStatus) => run(
  `INSERT INTO nfl_injuries (season, week, gsis_id, report_status) VALUES (?,?,?,?)`,
  season, week, gsisId, reportStatus);

// Fixture population for fitGradedAvailability: 40 "clean" baseline
// player-weeks (30 play, 10 sit -- rate 0.75, well above the minN floor),
// 40 Questionable weeks (20 play), 40 Out weeks (0 play), 20 Doubtful weeks
// (0 play, deliberately UNDER minN=30 to exercise the pre-registered floor).
//
// The establishing week is 21 and the measured week is 22 (the query's own
// `next_week <= 22` cap), not 1/2: a player who plays in the measured week
// becomes "active" there too and would otherwise cascade into a spillover
// candidate for week+1 in a live, full-season dataset that legitimately
// keeps rolling forward. At week 22 that spillover (week 23) is exactly
// what the production query's own cap excludes, which keeps this small,
// two-week fixture numerically self-contained without changing the query.
function seedFitPopulation() {
  // Baseline: 40 distinct players, each with a week-21 usage row (establishes
  // "active"), then week 22 is the measured week: 30 play, 10 do not, none on
  // the injury report week 22.
  for (let i = 0; i < 40; i++) {
    const id = insertPlayer(`Baseline ${i}`, 'WR', `gsis-base-${i}`);
    insertUsage(id, 2024, 21, 5);
    if (i < 30) insertUsage(id, 2024, 22, 5);
  }
  // Questionable: 40 players, active week 21, Questionable week 22, 20 play.
  for (let i = 0; i < 40; i++) {
    const id = insertPlayer(`Quest ${i}`, 'WR', `gsis-q-${i}`);
    insertUsage(id, 2024, 21, 5);
    insertInjury(`gsis-q-${i}`, 2024, 22, 'Questionable');
    if (i < 20) insertUsage(id, 2024, 22, 5);
  }
  // Out: 40 players, active week 21, Out week 22, none play.
  for (let i = 0; i < 40; i++) {
    const id = insertPlayer(`Out ${i}`, 'WR', `gsis-out-${i}`);
    insertUsage(id, 2024, 21, 5);
    insertInjury(`gsis-out-${i}`, 2024, 22, 'Out');
  }
  // Doubtful: only 20 (under minN=30) -- must collapse to 1.0.
  for (let i = 0; i < 20; i++) {
    const id = insertPlayer(`Doubtful ${i}`, 'WR', `gsis-dt-${i}`);
    insertUsage(id, 2024, 21, 5);
    insertInjury(`gsis-dt-${i}`, 2024, 22, 'Doubtful');
  }
}
seedFitPopulation();
const fit = fitGradedAvailability([2024], { minN: 30 });

test('Out and Questionable get real, different, correctly-ordered ratios', () => {
  assert.ok(fit.ratios.Out != null, 'Out must clear the minN floor in this fixture');
  assert.ok(fit.ratios.Questionable != null, 'Questionable must clear the minN floor in this fixture');
  assert.ok(fit.ratios.Out < fit.ratios.Questionable,
    `Out (rarely plays) must be a smaller ratio than Questionable (often plays): ` +
    `Out=${fit.ratios.Out}, Questionable=${fit.ratios.Questionable}`);
  // Out: 0 of 40 played -> ratio 0. Questionable: 20 of 40 played (rate 0.5)
  // against baseline rate 0.75 -> ratio 0.5/0.75 = 0.667.
  assert.equal(fit.ratios.Out, 0);
  assert.ok(Math.abs(fit.ratios.Questionable - 0.667) < 0.01,
    `expected Questionable ratio near 0.667, got ${fit.ratios.Questionable}`);
});

test('a bucket under the pre-registered minN floor (Doubtful, n=20) collapses to unretained, not a separate estimate', () => {
  assert.equal(fit.buckets.Doubtful.n, 20);
  assert.equal(fit.buckets.Doubtful.retained, false, 'n=20 < minN=30 must not be retained');
  assert.equal(fit.ratios.Doubtful, undefined, 'a collapsed bucket must not appear in the consumption vector at all');
});

test('G1 invariant: an unreported player-week gets a multiplier of EXACTLY 1, never a raw play-rate estimate', () => {
  const id = insertPlayer('No Report Player', 'WR', 'gsis-noreport-1');
  // No injury report recorded at all for this player-week.
  const decisionAt = '2024-09-25T12:00:00Z';
  const result = gradedAvailabilityMultiplier('gsis-noreport-1', 2024, 3, decisionAt, fit.ratios);
  assert.equal(result.multiplier, 1, 'unreported must be exactly 1, not close to 1');
  assert.equal(result.known, false);
});

test('a bucket collapsed by the minN floor (Doubtful) also resolves to exactly 1 through the consumer, not its raw rate', () => {
  recordRevision({
    entity: 'player:gsis-collapsed-1:2024:4', feature: 'injury_report',
    value: { report_status: 'Doubtful', practice_status: 'Did Not Participate', injury: 'ankle' },
    publishedAt: '2024-09-26T18:00:00Z', observedAt: '2024-09-26T18:05:00Z',
    provenance: 'captured', sourceId: 'nflverse_injuries', entitySeason: 2024, entityWeek: 4
  });
  const result = gradedAvailabilityMultiplier('gsis-collapsed-1', 2024, 4, '2024-09-27T12:00:00Z', fit.ratios);
  assert.equal(result.multiplier, 1,
    'Doubtful is not in fit.ratios (collapsed for n<minN), so the consumer must fall back to exactly 1, ' +
    'not silently apply some other value');
});

test('a retained bucket (Questionable) applies its fitted ratio through the consumer, as-of the decision time', () => {
  recordRevision({
    entity: 'player:gsis-live-q-1:2024:5', feature: 'injury_report',
    value: { report_status: 'Questionable', practice_status: 'Limited Participation', injury: 'hamstring' },
    publishedAt: '2024-10-03T18:00:00Z', observedAt: '2024-10-03T18:05:00Z',
    provenance: 'captured', sourceId: 'nflverse_injuries', entitySeason: 2024, entityWeek: 5
  });
  const result = gradedAvailabilityMultiplier('gsis-live-q-1', 2024, 5, '2024-10-04T12:00:00Z', fit.ratios);
  assert.equal(result.bucket, 'Questionable');
  assert.equal(result.retained, true);
  assert.equal(result.multiplier, fit.ratios.Questionable);
  assert.ok(result.multiplier > 0 && result.multiplier < 1, 'a real Questionable ratio must sit strictly between 0 and 1');
});

test('LOOK-AHEAD GUARD: a decision at Wednesday sees Wednesday\'s designation, not a later Friday downgrade', () => {
  const entity = 'player:gsis-lookahead-1:2024:6';
  // Wednesday: full participation, no designation on the report yet.
  recordRevision({
    entity, feature: 'injury_report',
    value: { report_status: null, practice_status: 'Full Participation', injury: 'hamstring' },
    publishedAt: '2024-10-09T18:00:00Z', observedAt: '2024-10-09T18:05:00Z',
    provenance: 'captured', sourceId: 'nflverse_injuries', entitySeason: 2024, entityWeek: 6
  });
  // Friday: downgraded to Questionable. A Sunday-lock decision would see this,
  // but a Wednesday one must not.
  recordRevision({
    entity, feature: 'injury_report',
    value: { report_status: 'Questionable', practice_status: 'Limited Participation', injury: 'hamstring' },
    publishedAt: '2024-10-11T21:00:00Z', observedAt: '2024-10-11T21:05:00Z',
    provenance: 'captured', sourceId: 'nflverse_injuries', entitySeason: 2024, entityWeek: 6
  });

  const wednesday = gradedAvailabilityMultiplier('gsis-lookahead-1', 2024, 6, '2024-10-09T20:00:00Z', fit.ratios);
  assert.equal(wednesday.bucket, null, 'Wednesday must see the pre-downgrade state (no report_status yet)');
  assert.equal(wednesday.multiplier, 1);

  const sunday = gradedAvailabilityMultiplier('gsis-lookahead-1', 2024, 6, '2024-10-13T17:00:00Z', fit.ratios);
  assert.equal(sunday.bucket, 'Questionable', 'Sunday must see the Friday downgrade');
  assert.equal(sunday.retained, true);
});

test('empty-source no-op: a player with zero injury-feature revisions of any kind is unaffected', () => {
  const result = gradedAvailabilityMultiplier('gsis-never-reported', 2024, 7, '2024-10-16T12:00:00Z', fit.ratios);
  assert.equal(result.multiplier, 1);
  assert.equal(result.known, false);
  assert.equal(result.reason, 'feature_never_recorded');
});
