import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-dynasty-age-curve-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
// Side-effect import: nflverse_player_positions is created ad-hoc on import,
// same convention the rest of the suite relies on.
await import('../server/services/nflverse.js');
const {
  ageDecayMultiplier, ageFromBirthDate, playerRealAge, dynastyAgeAdjustment, clearAgeCurveCache
} = await import('../server/services/dynasty-age-curve.js');
await runMigrations();

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('ageDecayMultiplier reproduces the cited curve anchors exactly', () => {
  // RB: peaks 26, holds through 28, falls off 29-31 (4for4 2025 Production Curves).
  assert.equal(ageDecayMultiplier('RB', 26), 1.00);
  assert.equal(ageDecayMultiplier('RB', 28), 1.00);
  assert.ok(ageDecayMultiplier('RB', 31) < ageDecayMultiplier('RB', 29),
    'RB value should keep falling from 29 through 31');
  assert.ok(ageDecayMultiplier('RB', 31) < 0.70, 'RB should have fallen off substantially by 31');

  // WR: prime at 25, peak 26-28, steep decline starts 32-33.
  assert.equal(ageDecayMultiplier('WR', 25), 1.00);
  assert.equal(ageDecayMultiplier('WR', 27), 1.00);
  assert.ok(ageDecayMultiplier('WR', 33) < ageDecayMultiplier('WR', 31),
    'WR decline should steepen at 32-33');

  // TE: peaks 26, holds ~89% of peak even at 34 — cited exactly.
  assert.equal(ageDecayMultiplier('TE', 26), 1.00);
  assert.equal(ageDecayMultiplier('TE', 34), 0.89);

  // The TE curve must be flatter than RB/WR at the same late age, per the study.
  assert.ok(ageDecayMultiplier('TE', 34) > ageDecayMultiplier('RB', 34));
  assert.ok(ageDecayMultiplier('TE', 34) > ageDecayMultiplier('WR', 34));
});

test('no published curve for QB (or any other position) leaves the value unadjusted', () => {
  assert.equal(ageDecayMultiplier('QB', 38), 1);
  assert.equal(ageDecayMultiplier('K', 40), 1);
  assert.equal(ageDecayMultiplier('RB', null), 1);
});

test('ageFromBirthDate computes an exact age, accounting for whether the birthday has passed', () => {
  const asOf = new Date('2026-09-04');
  assert.equal(ageFromBirthDate('2000-09-03', asOf), 26); // birthday already passed this year
  assert.equal(ageFromBirthDate('2000-09-05', asOf), 25); // birthday not yet reached this year
  assert.equal(ageFromBirthDate(null, asOf), null);
});

test('playerRealAge prefers the exact birth-date age over the roster snapshot', () => {
  run(`INSERT INTO nflverse_player_positions (gsis_id, birth_date) VALUES ('gsis-1','2000-01-01')`);
  clearAgeCurveCache();
  const asOf = new Date('2026-09-04');
  const withBirthDate = playerRealAge('gsis-1', 20, { asOf });
  assert.equal(withBirthDate.age, 26);
  assert.equal(withBirthDate.source, 'birth_date');

  const withoutBirthDate = playerRealAge('gsis-unknown', 30, { asOf });
  assert.equal(withoutBirthDate.age, 30);
  assert.equal(withoutBirthDate.source, 'roster_snapshot');

  const withNeither = playerRealAge('gsis-unknown', null, { asOf });
  assert.equal(withNeither.age, null);
  assert.equal(withNeither.source, null);
});

test('dynastyAgeAdjustment surfaces raw value, multiplier and adjusted value separately — never a silent replacement', () => {
  run(`INSERT INTO nflverse_player_positions (gsis_id, birth_date) VALUES ('gsis-rb-31','1995-09-01')`);
  clearAgeCurveCache();
  const asOf = new Date('2026-09-04'); // exactly 31
  const result = dynastyAgeAdjustment({
    position: 'RB', rawValue: 4000, gsisId: 'gsis-rb-31', asOf
  });
  assert.equal(result.raw_value, 4000);
  assert.equal(result.age, 31);
  assert.equal(result.age_source, 'birth_date');
  assert.equal(result.multiplier, ageDecayMultiplier('RB', 31));
  assert.equal(result.adjusted_value, +(4000 * ageDecayMultiplier('RB', 31)).toFixed(1));
  assert.ok(result.adjusted_value < result.raw_value, 'a 31-year-old RB should be decayed below the raw market price');
  assert.match(result.source, /4for4/);
});

test('dynastyAgeAdjustment with no age information returns the raw value unadjusted, not silently zeroed', () => {
  const result = dynastyAgeAdjustment({ position: 'WR', rawValue: 3000, gsisId: null, rosterSnapshotAge: null });
  assert.equal(result.age, null);
  assert.equal(result.multiplier, 1);
  assert.equal(result.adjusted_value, 3000);
});

test('dynastyAgeAdjustment returns null when there is no dynasty value to adjust in the first place', () => {
  assert.equal(dynastyAgeAdjustment({ position: 'RB', rawValue: null, gsisId: 'gsis-rb-31' }), null);
});
