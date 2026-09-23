/**
 * A substituted durability prior has to say so (contingency.js).
 *
 * `weeklyAvailability` serves every player a `durability_prior`. For a player
 * `availability()` has never seen — no `player_week_usage` row in any season
 * through the cutoff, which is every rookie before his first game and everyone
 * the usage table has not caught up with — there is no measured prior, so the
 * function substitutes a constant, 0.92.
 *
 * The number it substitutes sits inside the range measured priors occupy. So
 * the served row is a measurement for one player and a guess for the next, and
 * nothing on the row distinguishes them: a caller reading `durability_prior`
 * gets 0.920 either way. `source` does not settle it either, because it
 * describes which formula priced the week (fitted rates versus the published
 * designation curve), not where the prior came from.
 *
 * That matters off this file. The fantasy plan's served availability basis is
 * one of `fitted`, `durability_prior` or `default_durability`, and its accessor
 * can only reach `default_durability` if this row admits the substitution.
 * Silent, it reports a constant as a career measurement.
 *
 * These tests pin the distinction, not the constant's value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-durability-prior-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { availability, weeklyAvailability } = await import('../server/services/contingency.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const player = (id, name, position, gsis) =>
  run('INSERT INTO players (id, name, position, gsis_id) VALUES (?,?,?,?)', id, name, position, gsis);
const usage = (id, season, week, team, position) =>
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, carries, attempts)
       VALUES (?,?,?,?,?,5,0,0)`, id, season, week, team, position);

// 101 has played: four seasons of near-full attendance, so availability() has a
// measured rate for him. 102 has never appeared, so it has none.
player(101, 'Measured Veteran', 'WR', 'meas-vet');
player(102, 'Unseen Rookie', 'WR', 'unseen-rk');
for (const season of [2022, 2023, 2024, 2025]) {
  for (let week = 1; week <= 16; week++) usage(101, season, week, 'AAA', 'WR');
}

const CUTOFF = 2025;
const rowsByPlayer = weeklyAvailability(2026, 2, { through: CUTOFF, useRole: false, espn: false });
const measured = rowsByPlayer.get(101);
const substituted = rowsByPlayer.get(102);

test('the fixture is the case under test: one player measured, one never seen', () => {
  const base = availability({ through: CUTOFF });
  assert.ok(base.get(101), 'the veteran must have a measured availability row');
  assert.equal(base.get(102), undefined, 'the rookie must have none — that is the whole case');
  assert.ok(measured && substituted, 'both players must be served a weekly row');
});

test('a served durability prior says whether it was measured or substituted', () => {
  assert.equal(measured.durability_prior_measured, true,
    'the veteran has four seasons on file; his prior is a measurement');
  assert.equal(substituted.durability_prior_measured, false,
    'the rookie has no games on file; his prior is the substituted constant');
});

test('the substituted prior is otherwise indistinguishable, which is why the flag is needed', () => {
  // Both rows carry a number in the same range, of the same type, to the same
  // precision. Without the flag a caller has nothing to separate them.
  assert.equal(typeof substituted.durability_prior, 'number');
  assert.ok(substituted.durability_prior > 0 && substituted.durability_prior < 1);
  assert.equal(typeof measured.durability_prior, 'number');
  // And `source` describes the week's pricing formula, not the prior's origin,
  // so it is the same string for both.
  assert.equal(substituted.source, measured.source);
});
