/**
 * What an availability number rests on, served as one field (2026-09-20).
 *
 * FIVE CALL SITES WROTE `?? 0.92` INDEPENDENTLY -- role-scenario-engine.js, season-sim.js,
 * news-fantasy-impact.js, roster-risk.js and trade-engine.js -- and not one of them could
 * tell a fitted availability rate from the blanket constant. Every surface printed both as
 * the same number. The defect was never the constant's value; it was that the constant was
 * invisible, which is the same shape as a layer going inert and the page printing on.
 *
 * THE MAPPING READS THE FLAG, NEVER THE NUMBER. `weeklyAvailability` serves
 * `durability_prior_measured`, and that is the only safe discriminator: a veteran whose
 * measured prior really is 0.920 is indistinguishable from the default if you compare
 * values, and `durability_prior` is served through `toFixed(3)`, so the collision is exact
 * rather than unlikely. The test below is built on exactly that collision, because the
 * version of this function that compares to 0.92 passes every other test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-avail-basis-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { activeProbabilityFor, DEFAULT_ACTIVE_PROBABILITY, AVAILABILITY_BASES }
  = await import('../server/services/player-week-engine.js');
const { weeklyAvailability } = await import('../server/services/contingency.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** One WR with no games on file anywhere, so the producer has no measured prior for him. */
const PLAYER_ID = 900001;
run(`INSERT INTO players (id, name, position) VALUES (?, ?, ?)`, PLAYER_ID, 'Fixture Receiver', 'WR');

/** One row in `weeklyAvailability`'s served shape. */
const row = ({ active = 0.9, prior = 0.9, measured = true, source = 'durability prior only' } = {}) => ({
  player_id: 1, name: 'A Player', position: 'WR',
  active_probability: active, durability_prior: prior,
  durability_prior_measured: measured, source
});

const mapOf = (...rows) => new Map(rows.map((r, i) => [i + 1, r]));

test('a fitted rate is reported as fitted, in both shapes the producer emits', () => {
  for (const source of [
    'fitted availability (questionable + limited, n=1204)',
    'fitted availability by role (noreport/starter/full, n=8657) x KC'
  ]) {
    const out = activeProbabilityFor(mapOf(row({ active: 0.952, source })), 1);
    assert.equal(out.availability_basis, 'fitted', source);
    assert.equal(out.active_probability, 0.952);
  }
});

test('THE COLLISION: a measured prior of exactly 0.920 is not the default', () => {
  // This is the whole reason the mapping reads the flag. This player's durability prior was
  // MEASURED from his own career and came out at 0.920, which is byte-identical to the
  // constant after toFixed(3). A mapping that compared the number would label a real
  // measurement as a fallback, on precisely the players whose durability is unremarkable --
  // an error correlated with the population rather than spread as noise.
  const measuredAt092 = activeProbabilityFor(
    mapOf(row({ active: 0.92, prior: 0.92, measured: true })), 1);
  assert.equal(measuredAt092.availability_basis, 'durability_prior',
    'a measured 0.920 must not be reported as the default');

  const actuallyDefault = activeProbabilityFor(
    mapOf(row({ active: 0.92, prior: 0.92, measured: false })), 1);
  assert.equal(actuallyDefault.availability_basis, 'default_durability');

  // Identical numbers, opposite bases. If these two ever agree, the flag is being ignored.
  assert.equal(measuredAt092.active_probability, actuallyDefault.active_probability);
  assert.notEqual(measuredAt092.availability_basis, actuallyDefault.availability_basis);
});

test('a player absent from the map gets the constant and says so', () => {
  // The common case, not an error: weeklyAvailability covers QB, RB, WR and TE only, so
  // every other position lands here by construction.
  const out = activeProbabilityFor(mapOf(row()), 999);
  assert.equal(out.active_probability, DEFAULT_ACTIVE_PROBABILITY);
  assert.equal(out.availability_basis, 'default_durability');
  assert.match(out.availability_source, /no availability read/i);
});

test('no map at all is the same answer, not a throw', () => {
  // Called from paths that may not have built availability yet; a throw here would take down
  // the odds, and a silent 0.92 with no basis is what this field exists to stop.
  for (const absent of [null, undefined, {}]) {
    const out = activeProbabilityFor(absent, 1);
    assert.equal(out.active_probability, DEFAULT_ACTIVE_PROBABILITY);
    assert.equal(out.availability_basis, 'default_durability');
  }
});

test('an unrecognised source is labelled, never quietly called a prior', () => {
  // `fitted` is read off a human sentence, because no machine-readable field says it yet. If
  // that sentence changes upstream, every fitted number would silently become a prior -- the
  // exact failure this field exists to end. So an unmatched shape is named.
  const out = activeProbabilityFor(mapOf(row({ source: 'some new wording nobody told us about',
    measured: null })), 1);
  assert.equal(out.availability_basis, 'unrecognised');
  assert.equal(out.availability_source, 'some new wording nobody told us about',
    'the raw sentence is carried so the mismatch can actually be read');
});

test('every basis it can return is a declared one', () => {
  const seen = new Set();
  const cases = [
    row({ source: 'fitted availability (x, n=1)' }),
    row({ measured: true }), row({ measured: false }), row({ measured: null }),
    row({ source: '' })
  ];
  for (const [i, r] of cases.entries()) {
    seen.add(activeProbabilityFor(mapOf(...cases), i + 1).availability_basis);
  }
  seen.add(activeProbabilityFor(new Map(), 1).availability_basis);
  for (const basis of seen) {
    assert.ok(AVAILABILITY_BASES.includes(basis), `undeclared basis: ${basis}`);
  }
  assert.ok(seen.size >= 4, `all four bases should be reachable, saw ${[...seen].join(', ')}`);
});

test('the constant agrees with the producer, read out of a real database', () => {
  // TWO 0.92s IN THE CODEBASE IS THE THING TO AVOID, and `contingency.js` does not export
  // DEFAULT_DURABILITY_PRIOR. The first version of this test passed our own constant in as
  // `prior` and asserted it came back -- which it always does, because that path returns the
  // prior it was handed. It survived the mutation that changed our constant to 0.85. So this
  // one asks the producer, against a player it has no availability rows for, what prior it
  // serves of its own accord. If either side's number moves, this fails.
  const availability = weeklyAvailability(2026, 2, { through: 2025 });
  const served = availability.get(PLAYER_ID);
  assert.ok(served, 'the fixture player must be in the map, or this proves nothing');
  assert.equal(served.durability_prior_measured, false,
    'the fixture has no games on file, so there is no measured prior');
  assert.equal(served.durability_prior, DEFAULT_ACTIVE_PROBABILITY,
    "the producer's own default and ours must be the same number, not two that agree today");

  // And end to end: the real row, through the real mapping.
  const out = activeProbabilityFor(availability, PLAYER_ID);
  assert.equal(out.availability_basis, 'default_durability');
  assert.equal(out.active_probability, served.active_probability);
});
