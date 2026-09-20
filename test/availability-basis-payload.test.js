/**
 * Every chance-to-play figure served by routes/model.js must say what produced it.
 *
 * `b6f72e6` added the `basis` label to both availability surfaces and shipped with no
 * test of its own. This file is that test, and it pins the two things the change is
 * actually for:
 *
 *   1. `basis` is claimed PER PLAYER on /projections/:playerId, not per process. The
 *      fit can be on the 'role' path globally while this particular player has no
 *      in-scope role cell and falls through to the pooled chain. Reporting 'role' for
 *      him would be the same class of error as the field name the change fixes.
 *
 *   2. The bare GET /availability branch does not serve the fit and every row says so.
 *
 * Writing it exposed two lines on the bare branch that could not be observed, both now
 * gone, and both of the same shape as the thing the change fixes — source that claims a
 * distinction the wire cannot show:
 *
 *   - `basis` was a ternary against an `unfitted_position` arm no row could take.
 *     `availability()` selects `WHERE p.position IN ('QB','RB','WR','TE')`
 *     (contingency.js:43), so its map can never hold a K or a DEF.
 *   - `position: meta?.position ?? null` restated a field the spread above it already
 *     carried, shadowing it with itself.
 *
 * Neither was caught by the first draft of this file either. The population fixture is
 * seeded for all four positions precisely so the first one fails under injection, and
 * the restatement was found only by removing it and watching nothing break.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-availability-basis-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'basis.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realContingency = await import('../server/services/contingency.js');

// The global basis is the one thing these cases vary, so it is a live closure rather
// than a fixed value. Everything else in contingency.js stays real and reads the DB.
let globalBasis = { basis: 'constants', missing: ['nfl_availability_rates', 'nfl_availability_role_rates'] };
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, availabilityBasis: () => globalBasis }
});

const { availabilityPayload, default: modelRouter, clearModelCache } =
  await import('../server/routes/model.js');

const app = express();
app.use(express.json());
app.use('/api/model', modelRouter);
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ fixture */

const players = [
  [901, 'Fitted Receiver', 'WR'],
  [902, 'Out Of Scope Back', 'RB'],
  [903, 'Real Kicker', 'K'],
  [904, 'Real Defense', 'DST']
];
for (const [id, name, position] of players) {
  run('INSERT INTO players (id, name, position) VALUES (?,?,?)', id, name, position);
}
// Four seasons of attendance for ALL FOUR, the kicker and the defense included. That
// is deliberate and it is what gives the population assertion below its teeth: if the
// K and the DEF had no usage rows, they would be absent from the bare branch for want
// of data and the test would pass no matter what contingency.js's position filter said.
// Seeded this way, that filter is the only thing keeping them off the wire.
for (const pid of [901, 902, 903, 904]) {
  for (const season of [2022, 2023, 2024, 2025]) {
    for (let week = 1; week <= 16; week++) {
      run(`INSERT INTO player_week_usage (player_id, season, week, targets, carries)
           VALUES (?,?,?,?,?)`, pid, season, week, 6, 1);
    }
  }
}

const weekly = (overrides = {}) => ({
  active_probability: 0.91, durability_prior: 0.88, ...overrides
});

/* --------------------------------------------------- per-player basis claims */

test('a player with no fitted weekly row is unfitted_position, not a bare low number', () => {
  globalBasis = { basis: 'role', missing: [] };
  const out = availabilityPayload(903, undefined, undefined);
  assert.equal(out.basis, 'unfitted_position');
  assert.equal(out.fitted, false);
  // The distinction the change exists for: "not modelled" must not be served as a
  // number that reads like a low chance of playing.
  assert.equal(out.active_probability, null);
});

test('the role basis is claimed only for a player who has an in-scope role cell', () => {
  globalBasis = { basis: 'role', missing: [] };
  const inScope = availabilityPayload(901, weekly({ role: { gap: 2, in_scope: true } }), null);
  assert.equal(inScope.basis, 'role');
  assert.equal(inScope.fitted, true);
});

test('THE BUG THIS GUARDS: a role-path process reports pooled for a player it could not price at role level', () => {
  globalBasis = { basis: 'role', missing: [] };
  const outOfScope = availabilityPayload(902, weekly({ role: { gap: 9, in_scope: false } }), null);
  assert.equal(outOfScope.basis, 'pooled');
  assert.equal(outOfScope.fitted, true);

  const noRoleCellAtAll = availabilityPayload(902, weekly(), null);
  assert.equal(noRoleCellAtAll.basis, 'pooled');
});

test('a pooled process never reports role, whatever the player carries', () => {
  globalBasis = { basis: 'pooled', missing: ['nfl_availability_role_rates'] };
  const out = availabilityPayload(901, weekly({ role: { gap: 2, in_scope: true } }), null);
  assert.equal(out.basis, 'pooled');
  assert.equal(out.fitted, true);
});

test('with no fit on file the basis is constants and fitted is false', () => {
  globalBasis = { basis: 'constants', missing: ['nfl_availability_rates', 'nfl_availability_role_rates'] };
  const out = availabilityPayload(901, weekly(), null);
  assert.equal(out.basis, 'constants');
  assert.equal(out.fitted, false);
});

test('the durability prior falls back to the four-season rate when the weekly row omits it', () => {
  globalBasis = { basis: 'pooled', missing: [] };
  const out = availabilityPayload(901, { active_probability: 0.9 }, { available: 0.8236 });
  assert.equal(out.durability_prior, 0.824);
});

/* ------------------------------------------------- the bare /availability route */

test('every row on the bare /availability branch says it is not the fit', async () => {
  globalBasis = { basis: 'role', missing: [] };
  clearModelCache();
  const res = await fetch(`${base}/api/model/availability`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.length >= 2, 'the fixture skill players are present');
  for (const row of body) {
    assert.equal(row.fitted, false, `${row.name} must not read as fitted on this branch`);
    assert.ok(row.position, 'the position is carried so a reader can see the fit population');
  }
});

test('the bare branch serves only the four positions the fit covers, so its label is durability_prior', async () => {
  globalBasis = { basis: 'role', missing: [] };
  clearModelCache();
  const body = await (await fetch(`${base}/api/model/availability`)).json();
  const positions = [...new Set(body.map(r => r.position))].sort();
  // availability() selects WHERE p.position IN ('QB','RB','WR','TE'), so the K and the
  // DEF in the fixture cannot appear here at all.
  assert.deepEqual(positions, ['RB', 'WR']);
  assert.ok(!body.some(r => r.name === 'Real Kicker' || r.name === 'Real Defense'));
  for (const row of body) assert.equal(row.basis, 'durability_prior');
  // A label no row can ever carry is a label a reader can be misled by. If the bare
  // route's population ever widens to K/DEF, the assertion above fails first.
  assert.ok(!body.some(r => r.basis === 'unfitted_position'));
});
