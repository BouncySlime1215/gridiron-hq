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
const { weeklyAvailability, resetAvailabilityCache, AVAILABILITY_RATES_DDL, AVAILABILITY_ROLE_RATES_DDL } =
  await import("../server/services/contingency.js");
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

test('every value this file can serve is a member, and the three consumer arms are not servable', () => {
  for (const value of B.SERVABLE_AVAILABILITY_BASIS) {
    assert.ok(B.AVAILABILITY_BASIS.includes(value), `${value} must be in the canonical list`);
  }
  // `unfitted_position` means there is no row for this player at all,
  // `unrecognised` means a row arrived without the field, and `unvouched` means
  // a row carried a basis but no number. None can be written onto a row by the
  // thing that builds rows.
  for (const arm of ['unfitted_position', 'unrecognised', 'unvouched']) {
    assert.ok(B.AVAILABILITY_BASIS.includes(arm), `${arm} must be in the canonical list`);
    assert.equal(B.SERVABLE_AVAILABILITY_BASIS.includes(arm), false,
      `${arm} must not be servable on a row`);
  }
});

test('a row with a basis but no number is its own arm, not version skew', () => {
  // These two are both "the consumer could not take the row at its word", and that
  // is exactly why they must not share a name. `unrecognised` is a payload built
  // before the field existed, which stops happening once the producers are on the
  // new shape. `unvouched` is a current payload whose producer classified the row
  // and then served no number, which is a live fault and should not decay out of a
  // count of the first. A consumer that folds them cannot tell the two apart, which
  // is the defect this whole vocabulary exists to remove, arriving from the other
  // side.
  assert.ok(B.AVAILABILITY_BASIS.includes('unvouched'), 'unvouched must be a member');
  assert.equal(B.isAvailabilityBasis('unvouched'), true);
  assert.equal(B.SERVABLE_AVAILABILITY_BASIS.includes('unvouched'), false,
    'unvouched is a consumer arm and must never be servable on a row');
  assert.ok(B.AVAILABILITY_BASIS.includes('unrecognised'), 'unrecognised keeps its meaning');
  assert.notEqual(B.AVAILABILITY_BASIS.indexOf('unvouched'),
    B.AVAILABILITY_BASIS.indexOf('unrecognised'));
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

test('the default prior behind a default_durability row is the shared constant', () => {
  // One definition, imported by contingency.js and by any consumer that needs
  // to explain the number. A second copy elsewhere would disagree silently.
  assert.equal(typeof B.DEFAULT_DURABILITY_PRIOR, 'number');
  assert.equal(served.get(202).availability_basis, 'default_durability');
  assert.equal(served.get(202).durability_prior, +B.DEFAULT_DURABILITY_PRIOR.toFixed(3));
  // And the measured player's prior is NOT that number, so the row above is
  // pinning the substitution rather than a coincidence.
  assert.notEqual(served.get(201).durability_prior, served.get(202).durability_prior);
});

test('the prior and the fallback active probability are independent literals', async () => {
  // They carry the same digits today and that is coincidence: one is the INPUT
  // to the report-status curve, the other replaces its OUTPUT for a player the
  // curve never ran on. Deriving either from the other would look like tidying
  // and would silently move a served probability the next time the prior is
  // revised, so the check is on the source, not on the values.
  assert.equal(typeof B.DEFAULT_DURABILITY_PRIOR, 'number');
  assert.equal(typeof B.DEFAULT_ACTIVE_PROBABILITY, 'number');
  const source = await fs.promises.readFile(
    new URL('../server/services/availability-basis.js', import.meta.url), 'utf8');
  for (const name of ['DEFAULT_DURABILITY_PRIOR', 'DEFAULT_ACTIVE_PROBABILITY']) {
    const line = new RegExp(`^export const ${name} = (.+);$`, 'm').exec(source);
    assert.ok(line, `${name} must be exported on its own line`);
    assert.match(line[1], /^[0-9.]+$/,
      `${name} must be its own numeric literal, not derived from the other constant`);
  }
});

test('a fitted pooled rate moves the basis off the prior, for both players', () => {
  // One league-scope rate for "no report, no practice status" is enough for the
  // pooled lookup to answer, and it answers for everyone — including the player
  // whose prior is the substituted constant, whose basis must therefore stop
  // being about his prior at all.
  // The fit tables are created by scripts/fit-availability.mjs, not by a
  // migration, which is why the DDL is exported for this exact purpose.
  run(AVAILABILITY_RATES_DDL);
  run(`INSERT INTO nfl_availability_rates
       (scope, team, report_status, practice_status, p_active, n, raw_rate, shrunk, fitted_at)
       VALUES ('league','','none','any',0.955,9000,0.955,1,'2026-09-20T00:00:00Z')`);
  resetAvailabilityCache();
  const withFit = weeklyAvailability(2026, 2, { through: 2025, useRole: false, espn: false });
  assert.equal(withFit.get(201).availability_basis, 'pooled');
  assert.equal(withFit.get(202).availability_basis, 'pooled');
  // And the flag underneath is unchanged: the rookie's prior is still a default,
  // it is simply no longer what priced him.
  assert.equal(withFit.get(202).durability_prior_measured, false);
});

test('a fitted role cell takes precedence, and the basis says role', () => {
  // The fourth arm. It needs three things the arms above do not: role rates on
  // file, a 2026 week-1 appearance so `roleStates` can compute a tier and a
  // games gap, and `useRole: true`. Without all three the role branch never
  // executes — which is exactly why mislabelling it survived a mutation before
  // this test existed.
  run(AVAILABILITY_ROLE_RATES_DDL);
  const config = JSON.stringify({ k: 10, byPosition: false, durabilityCap: false });
  for (const [rs, ps, pos, tier, gap, p] of [
    ['noreport', '*', '*', '*', '*', 0.70],
    ['noreport', 'none', '*', '*', '*', 0.70],
    ['noreport', 'none', '*', 'starter', '*', 0.90],
    ['noreport', 'none', '*', 'starter', 'g0', 0.953]
  ]) {
    run(`INSERT INTO nfl_availability_role_rates
         (report_status,practice_status,position,tier,gap,p_active,n,raw_rate,config,fitted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      rs, ps, pos, tier, gap, p, 100, p, config, '2026-09-20T00:00:00Z');
  }
  // Week 1 of the graded season, so the gap is g0 and the tier is starter.
  // 203 is filler: it is what gives team AAA a week 1 on the schedule.
  player(203, 'AAA Filler', 'WR', 'basis-fill');
  for (const id of [201, 202, 203]) {
    usage(id, 2026, 1, 'AAA', 'WR');
    run(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct)
         VALUES (?,?,?,?,?)`, id, 2026, 1, 59, 0.9);
  }
  resetAvailabilityCache();
  const withRole = weeklyAvailability(2026, 2, { through: 2025, useRole: true, espn: false });
  assert.equal(withRole.get(201).availability_basis, 'role');
  // And it beats the pooled rate written by the test above, which is the
  // precedence the arm exists to express.
  assert.equal(withRole.get(201).source.startsWith('fitted availability by role'), true);
  // The rookie's prior is still a default; the role fit priced him all the same.
  assert.equal(withRole.get(202).availability_basis, 'role');
  assert.equal(withRole.get(202).durability_prior_measured, false);
});

test('the basis does not depend on the wording of the source sentence', () => {
  // The two rows differ in basis while sharing a source sentence, which is
  // exactly what a prose-matching classifier cannot see.
  assert.equal(served.get(201).source, served.get(202).source);
  assert.notEqual(served.get(201).availability_basis, served.get(202).availability_basis);
});
