/**
 * The three load-bearing claims of the cascade grader, on a fixture small
 * enough to check by hand:
 *
 *   1. an absence is found although the starter has NO box-score row that week
 *      — the defect that made four earlier attempts at this question in this
 *      repository measure an effect of exactly zero;
 *   2. weeks outside the starter's roster span are not absences, so the weeks
 *      before he was signed are not scored as games he missed;
 *   3. the baseline is strictly prior — the graded week's own box score never
 *      reaches the number that predicts it.
 *
 * Every one of the three has a mutation recorded in
 * docs/tdd/cascade-grade.tdd.md that makes it fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-cascade-grade-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { buildGradedRows, priorUsage, seasonIndex } =
  await import('../server/services/cascade-grade.js');

const SEASON = 2024;
const STARTER = 1, MATE = 2;

test.before(() => {
  run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant)
       VALUES (?,?,?,?,1)`, STARTER, 'Starter Back', 'RB', '00-0000001');
  run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant)
       VALUES (?,?,?,?,1)`, MATE, 'Backup Back', 'RB', '00-0000002');

  // The backup plays every week 1-8. The starter joins in week 3 and misses
  // week 6 only, so weeks 1 and 2 are "before he was here", not absences.
  for (let week = 1; week <= 8; week++) {
    // Week 6 is the graded week and the backup's carries spike there. If the
    // baseline were not strictly prior it would absorb that spike.
    const mateCarries = week === 6 ? 30 : 5;
    run(`INSERT INTO player_week_usage (player_id, season, week, team, opponent, position,
         attempts, carries, targets)
         VALUES (?,?,?,?,?,?,0,?,0)`, MATE, SEASON, week, 'AAA', 'BBB', 'RB', mateCarries);
    if (week >= 3 && week !== 6) {
      run(`INSERT INTO player_week_usage (player_id, season, week, team, opponent, position,
           attempts, carries, targets)
           VALUES (?,?,?,?,?,?,0,?,0)`, STARTER, SEASON, week, 'AAA', 'BBB', 'RB', 20);
    }
  }
});

/** The claim `cascades()` would publish, supplied directly so this tests the grader alone. */
const cascadeMap = () => new Map([[STARTER, {
  player_id: STARTER, name: 'Starter Back', position: 'RB', team: 'AAA',
  beneficiaries: [{
    player_id: MATE, name: 'Backup Back', position: 'RB',
    base_opportunity: 5, opportunity_without: 15, gain: 10, multiplier: 3, games_observed: 4
  }]
}]]);

test('an absent starter is found although he has no box-score row that week', () => {
  const r = buildGradedRows({ season: SEASON, cascadeMap: cascadeMap(), minPriorGames: 2 });
  assert.equal(r.absences, 1, 'week 6 is the one absence inside the starter\'s span');
  assert.equal(r.graded.length, 1);
  assert.equal(r.graded[0].week, 6);
  assert.equal(r.graded[0].player_id, MATE);
  assert.equal(r.graded[0].actual, 30, 'the graded week\'s real opportunity');
});

test('weeks before the starter joined the roster are not absences', () => {
  const r = buildGradedRows({ season: SEASON, cascadeMap: cascadeMap(), minPriorGames: 2 });
  // Weeks 1 and 2 have a team-week and no starter row, but precede his span.
  assert.equal(r.absences, 1, 'weeks 1 and 2 must not be counted');
  assert.ok(!r.graded.some(x => x.week < 3));
});

test('the baseline is strictly prior to the graded week', () => {
  const r = buildGradedRows({ season: SEASON, cascadeMap: cascadeMap(), minPriorGames: 2 });
  const row = r.graded[0];
  // Weeks 1-5 are all 5 carries, so any strictly-prior weighting is 5 up to the
  // rounding of the exponential weights. Letting week 6 in would put it near 9.
  assert.ok(Math.abs(row.own_recent - 5) < 1e-9,
    `the week-6 spike of 30 must not reach the baseline (got ${row.own_recent})`);
  assert.equal(row.own_recent_games, 5);
});

test('priorUsage returns null below the minimum prior games', () => {
  const { playerWeeks } = seasonIndex(SEASON);
  const weeks = playerWeeks.get(`${MATE}|AAA`);
  assert.equal(priorUsage(weeks, 1, { minPriorGames: 2 }), null, 'no weeks precede week 1');
  assert.equal(priorUsage(weeks, 2, { minPriorGames: 2 }), null, 'only one week precedes week 2');
  assert.ok(priorUsage(weeks, 3, { minPriorGames: 2 }));
});

test('a beneficiary who also sat that week is not graded', () => {
  const map = cascadeMap();
  map.get(STARTER).beneficiaries.push({
    player_id: 99, name: 'Never Played', position: 'RB',
    base_opportunity: 1, opportunity_without: 4, gain: 3, multiplier: 4, games_observed: 3
  });
  const r = buildGradedRows({ season: SEASON, cascadeMap: map, minPriorGames: 2 });
  assert.equal(r.graded.length, 1, 'the teammate with no row in week 6 contributes nothing');
});
