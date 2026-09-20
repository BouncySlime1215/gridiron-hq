/**
 * One vocabulary for "what priced this player's chance to play".
 *
 * Three separate classifiers had grown for the same question, none of them
 * reading a field:
 *
 *   - lineup-brain.js#playerAvailabilityBasis matches prose prefixes of the
 *     `source` sentence ('fitted availability by role' -> role, 'fitted
 *     availability (' -> pooled, anything else -> constants).
 *   - the fantasy plan's accessor classifies the same sentence into a different
 *     set of words (fitted / durability_prior / default_durability).
 *   - availabilityBasis() reports a THIRD thing under the same name: which fit
 *     tables are loaded in this process, which is not a property of any player.
 *
 * A wording change in one sentence would silently reclassify every fitted
 * number as a prior, in two consumers, with nothing failing. The fix is for
 * contingency.js to say it outright on the row, from a list defined once.
 *
 * These tests pin the list and the four values this file can serve. They do not
 * pin the prose, which is display text and free to change --- that is the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-availability-basis-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { weeklyAvailability } = await import('../server/services/contingency.js');
const B = await import('../server/services/availability-basis.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const player = (id, name, position, gsis) =>
  run('INSERT INTO players (id, name, position, gsis_id) VALUES (?,?,?,?)', id, name, position, gsis);
const usage = (id, season, week, team, position) =>
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, carries, attempts)
       VALUES (?,?,?,?,?,5,0,0)`, id, season, week, team, position);

// 201 has four seasons on file, so his durability prior is measured.
// 202 has none, so his prior is the standing constant.
player(201, 'Measured Veteran', 'WR', 'basis-vet');
player(202, 'Unseen Rookie', 'WR', 'basis-rook');
for (const season of [2022, 2023, 2024, 2025]) {
  for (let week = 1; week <= 16; week++) usage(201, season, week, 'AAA', 'WR');
}

// No fit tables are written by this fixture, so neither fitted path can apply
// and both players fall through to the report-status chain over their prior.
const served = weeklyAvailability(2026, 2, { through: 2025, useRole: false, espn: false });

test('the canonical list is exported, frozen, and has no duplicates', () => {
  assert.ok(Array.isArray(B.AVAILABILITY_BASIS), 'AVAILABILITY_BASIS must be an array');
  assert.ok(Object.isFrozen(B.AVAILABILITY_BASIS), 'it must be frozen');
  assert.equal(new Set(B.AVAILABILITY_BASIS).size, B.AVAILABILITY_BASIS.length);
  for (const value of B.AVAILABILITY_BASIS) assert.equal(typeof value, 'string');
});

test('every value this file can serve is a member, and the two consumer arms are not servable', () => {
  for (const value of B.SERVABLE_AVAILABILITY_BASIS) {
    assert.ok(B.AVAILABILITY_BASIS.includes(value), `${value} must be in the canonical list`);
  }
  // `unfitted_position` means there is no row for this player at all, and
  // `unrecognised` means a row arrived without the field. Neither can be
  // written onto a row by the thing that builds rows.
  for (const arm of ['unfitted_position', 'unrecognised']) {
    assert.ok(B.AVAILABILITY_BASIS.includes(arm), `${arm} must be in the canonical list`);
    assert.equal(B.SERVABLE_AVAILABILITY_BASIS.includes(arm), false,
      `${arm} must not be servable on a row`);
  }
});

test('every served row carries a basis from the list', () => {
  assert.ok(served.size >= 2, 'fixture must serve both players');
  for (const [id, row] of served) {
    assert.ok(B.SERVABLE_AVAILABILITY_BASIS.includes(row.availability_basis),
      `player ${id} served availability_basis ${JSON.stringify(row.availability_basis)}`);
  }
});

test('with no fit on file the basis is the prior, and it says which prior', () => {
  assert.equal(served.get(201).availability_basis, 'durability_prior',
    'four seasons on file is a measured career prior');
  assert.equal(served.get(202).availability_basis, 'default_durability',
    'no games on file means the standing constant, not a measurement');
});

test('the basis does not depend on the wording of the source sentence', () => {
  // The two rows differ in basis while sharing a source sentence, which is
  // exactly what a prose-matching classifier cannot see.
  assert.equal(served.get(201).source, served.get(202).source);
  assert.notEqual(served.get(201).availability_basis, served.get(202).availability_basis);
});
