import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * `normalizedGrade` -- the Z-score normalization of raw PFF grades that
 * came out of comparing this project's model architecture against a
 * compared proposal (docs/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08.md). No
 * live PFF data exists in this project (no connector is configured), so
 * every case here is built from synthetic, clearly-labeled fixture grades
 * via the real `importLicensedPffGrades` insert path -- proving the
 * function's actual logic, not a stub.
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pff-normalization-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { importLicensedPffGrades, __test } = await import('../server/services/nfl-roster-strength.js');
const { normalizedGrade } = __test;

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function seedGrades(position, season, week, grades) {
  importLicensedPffGrades(grades.map((g, i) => ({
    season, week, team: 'KC', player_id: `${position}-${season}-${week}-${i}`,
    player_name: `Fixture ${position} ${i}`, position, overall_grade: g
  })));
}

test('too few observed grades at a position returns null rather than a guessed default', () => {
  seedGrades('OL', 2024, 3, [72, 68, 70]); // only 3, below the 8-observation floor
  assert.equal(normalizedGrade(75, 'OL', 2024, 4), null);
});

test('a genuinely average raw grade normalizes to the center of the evidence scale', () => {
  const grades = [60, 62, 64, 66, 68, 70, 72, 74, 76, 78]; // mean 70, real spread
  seedGrades('WR', 2024, 5, grades);
  const mean = grades.reduce((s, v) => s + v, 0) / grades.length;
  const result = normalizedGrade(mean, 'WR', 2024, 6);
  assert.ok(result !== null);
  assert.ok(Math.abs(result - 65) < 0.5, `expected the mean grade to land near the scale's center (65), got ${result}`);
});

test('a grade two standard deviations above the population normalizes well above center, remapped onto the 35-95 evidence scale', () => {
  const grades = [50, 55, 60, 60, 60, 60, 60, 65, 70]; // mean 60, sd ~5.4
  seedGrades('CB', 2024, 7, grades);
  const mean = grades.reduce((s, v) => s + v, 0) / grades.length;
  const variance = grades.reduce((s, v) => s + (v - mean) ** 2, 0) / grades.length;
  const sd = Math.sqrt(variance);
  const outlierRaw = mean + 2 * sd;
  const result = normalizedGrade(outlierRaw, 'CB', 2024, 8);
  // 65 + 2*15 = 95, the top of the clamp -- an outlier this extreme should
  // land at or very near the ceiling, not be softened back toward center.
  assert.ok(result > 85, `expected a +2SD grade to sit near the top of the evidence scale, got ${result}`);
});

test('two positions with different grading distributions normalize the identical raw number differently', () => {
  // OL grades cluster tight and low; WR grades run higher and wider -- a
  // realistic case where the same raw "70" means something very different
  // depending on who is being graded.
  seedGrades('OL', 2024, 9, [55, 57, 58, 59, 60, 61, 62, 63, 65]); // mean ~60, tight
  seedGrades('WR', 2024, 9, [65, 68, 70, 72, 74, 76, 78, 80, 85]); // mean ~74, wider
  const olResult = normalizedGrade(70, 'OL', 2024, 10);
  const wrResult = normalizedGrade(70, 'WR', 2024, 10);
  assert.ok(olResult !== null && wrResult !== null);
  assert.ok(olResult > wrResult, 'the same raw 70 should read as more exceptional among OL graders (mean ~60) than WR graders (mean ~74)');
});

test('a degenerate population where every grade is identical returns null -- a zero-spread distribution carries no z-score information', () => {
  seedGrades('K', 2024, 11, [70, 70, 70, 70, 70, 70, 70, 70]);
  assert.equal(normalizedGrade(80, 'K', 2024, 12), null);
});

test('the reference population is strictly prior to the decision cutoff -- a grade from the SAME or a LATER week never leaks into the distribution', () => {
  // Two otherwise-identical positions. Both get the same week-12 population.
  // Only CONTAMINATED also gets a wildly different SAME-WEEK-13 batch, which
  // must not be visible to a week-13 decision (the cutoff is week < 13).
  const week12 = [58, 59, 60, 60, 61, 61, 62, 63];
  seedGrades('TE', 2024, 12, week12);
  seedGrades('CONTAMINATED', 2024, 12, week12);
  seedGrades('CONTAMINATED', 2024, 13, [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);

  const clean = normalizedGrade(60, 'TE', 2024, 13);
  const contaminated = normalizedGrade(60, 'CONTAMINATED', 2024, 13);
  // If the same-week batch had leaked into the reference population, 60
  // would read as an extreme outlier ABOVE a population now centered near
  // 10, and `contaminated` would diverge sharply from `clean` toward the
  // 95 ceiling. It must not.
  assert.equal(clean, contaminated,
    'a week-13 decision must see the identical reference population whether or not a same-week batch exists for that position -- the same-week rows must never join it');
  assert.ok(clean !== null && clean < 85);
});

test('a non-finite raw grade (never graded) returns null immediately, without querying a population at all', () => {
  assert.equal(normalizedGrade(null, 'QB', 2024, 5), null);
  assert.equal(normalizedGrade(undefined, 'QB', 2024, 5), null);
  assert.equal(normalizedGrade(NaN, 'QB', 2024, 5), null);
});
