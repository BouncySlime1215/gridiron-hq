/**
 * The opportunity model's three load-bearing claims, on a fixture small enough
 * to check by hand:
 *
 *   1. features are strictly prior — the graded week's own box score never
 *      reaches the row that predicts it;
 *   2. a teammate ruled out is found even though he has no box-score row that
 *      week, which is the bug that made earlier redistribution attempts measure
 *      an effect of zero;
 *   3. the vacated correction is exactly the identity on a player with no
 *      absent teammate, so it cannot regress the rows it knows nothing about.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-opportunity-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const {
  buildSeasonRows, fitVacatedCorrection, applyVacatedCorrection,
  fitOpportunityModel, predictOpportunity, FEATURE_NAMES
} = await import('../server/services/opportunity-model.js');

const SEASON = 2024;
/** Two receivers on one team. WR2 is ruled out in week 6 and has no usage row. */
const PLAYERS = [
  { id: 1, name: 'Alpha Receiver', position: 'WR', gsis: '00-0000001' },
  { id: 2, name: 'Bravo Receiver', position: 'WR', gsis: '00-0000002' },
  { id: 3, name: 'Charlie Receiver', position: 'WR', gsis: '00-0000003' }
];

test.before(() => {
  for (const p of PLAYERS) {
    run('INSERT INTO players (id, name, position, gsis_id, fantasy_relevant) VALUES (?,?,?,?,1)',
      p.id, p.name, p.position, p.gsis);
  }
  for (let week = 1; week <= 8; week++) {
    run(`INSERT INTO game_lines (season, week, team, opponent, home, spread, total, implied_points,
         source, fetched_at, rest_days, gameday)
         VALUES (?,?,?,?,1,-3,45,24,'fixture','2024-01-01',7,?)`,
      SEASON, week, 'AAA', 'BBB', `2024-09-${String(week + 7).padStart(2, '0')}`);
    for (const p of PLAYERS) {
      // Bravo misses week 6 entirely: ruled out, so no box score at all.
      if (p.id === 2 && week === 6) continue;
      const targets = p.id === 1 ? 8 : p.id === 2 ? 6 : 2;
      run(`INSERT INTO player_week_usage (player_id, season, week, team, opponent, position,
           attempts, carries, targets, receptions, target_share)
           VALUES (?,?,?,?,?,?,0,0,?,?,?)`,
        p.id, SEASON, week, 'AAA', 'BBB', p.position, targets, targets - 2, targets / 16);
      run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (?,?,?,?,?)',
        p.id, SEASON, week, 50, 0.8);
    }
  }
  run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status)
       VALUES (?,?,?,?,?,?,?)`, SEASON, 6, '00-0000002', 'AAA', 'Bravo Receiver', 'WR', 'Out');
});

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('every feature the model names is present on every row', () => {
  const built = buildSeasonRows(SEASON, { positions: ['WR'], stat: 'targets', startWeek: 5, endWeek: 8 });
  assert.ok(built.length > 0, 'fixture produced no rows');
  for (const row of built) {
    for (const name of FEATURE_NAMES) {
      assert.equal(typeof row[name], 'number', `${name} missing or non-numeric`);
      assert.ok(Number.isFinite(row[name]), `${name} is not finite`);
    }
  }
});

test('a teammate ruled out is found although he has no box-score row that week', () => {
  const built = buildSeasonRows(SEASON, { positions: ['WR'], stat: 'targets', startWeek: 5, endWeek: 8 });
  const week6 = built.filter(r => r.week === 6);
  assert.ok(week6.length >= 2, 'expected the two active receivers in week 6');
  for (const row of week6) {
    assert.ok(row.vacated_same_pos > 0,
      'Bravo carried a real share and was ruled out, so it must register as vacated');
  }
  // He is absent from the box score, so a naive scan of the graded week finds nobody.
  assert.equal(week6.some(r => r.player_id === 2), false);
  // And no other week sees a vacancy.
  for (const row of built.filter(r => r.week !== 6)) {
    assert.equal(row.vacated_same_pos, 0, `week ${row.week} should have no vacancy`);
  }
});

test('features never read the graded week', () => {
  const built = buildSeasonRows(SEASON, { positions: ['WR'], stat: 'targets', startWeek: 5, endWeek: 8 });
  const alpha = built.filter(r => r.player_id === 1).sort((a, b) => a.week - b.week);
  // Alpha's usage is constant, so his prior share is the same every graded week.
  // A feature that leaked the graded week would still be constant here, so the
  // stronger check is the count: week 5 must see exactly four prior games.
  assert.equal(alpha[0].week, 5);
  assert.equal(alpha[0].prior_games, 4, 'week 5 must see weeks 1-4 and nothing else');
  assert.equal(alpha.at(-1).prior_games, 7, 'week 8 must see weeks 1-7 and nothing else');
});

test('the vacated correction is the identity when no teammate is out', () => {
  const rowsIn = buildSeasonRows(SEASON, { positions: ['WR'], stat: 'targets', startWeek: 5, endWeek: 8 });
  const correction = { samePosition: 0.5, otherPosition: 0.2, questionable: -0.1, interceptNotApplied: 9 };
  const quiet = rowsIn.find(r => r.vacated_same_pos === 0 && r.self_questionable === 0);
  assert.ok(quiet, 'fixture should contain a week with nobody out');
  assert.equal(applyVacatedCorrection(correction, quiet, 7.25), 7.25);
  // And it moves a row that does have an absent teammate.
  const affected = rowsIn.find(r => r.vacated_same_pos > 0);
  assert.ok(applyVacatedCorrection(correction, affected, 7.25) > 7.25);
});

test('a null correction and a null model degrade to the baseline, not to a crash', () => {
  assert.equal(applyVacatedCorrection(null, { vacated_same_pos: 0.3 }, 4), 4);
  assert.equal(predictOpportunity(null, {}), null);
  assert.equal(fitVacatedCorrection([]), null, 'too little data must return null, not a fit');
  assert.equal(fitOpportunityModel([]), null);
});

test('a prediction is never negative', () => {
  const model = {
    intercept: -5, weights: FEATURE_NAMES.map(() => -1),
    mu: FEATURE_NAMES.map(() => 0), sd: FEATURE_NAMES.map(() => 1),
    featureNames: [...FEATURE_NAMES]
  };
  const value = predictOpportunity(model, Object.fromEntries(FEATURE_NAMES.map(n => [n, 10])));
  assert.ok(value >= 0, `expected a non-negative prediction, got ${value}`);
});
