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

const { activeProbabilityFor } = await import('../server/services/player-week-engine.js');
const { AVAILABILITY_BASIS, SERVABLE_AVAILABILITY_BASIS, DEFAULT_DURABILITY_PRIOR }
  = await import('../server/services/availability-basis.js');
const { weeklyAvailability } = await import('../server/services/contingency.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** One WR with no games on file anywhere, so the producer has no measured prior for him. */
const PLAYER_ID = 900001;
run(`INSERT INTO players (id, name, position) VALUES (?, ?, ?)`, PLAYER_ID, 'Fixture Receiver', 'WR');

/** One row in `weeklyAvailability`'s served shape. */
const row = ({ active = 0.9, prior = 0.9, measured = true, basis = 'durability_prior',
  source = 'durability prior only' } = {}) => ({
  player_id: 1, name: 'A Player', position: 'WR',
  active_probability: active, durability_prior: prior,
  durability_prior_measured: measured, availability_basis: basis, source
});

const mapOf = (...rows) => new Map(rows.map((r, i) => [i + 1, r]));

test('the basis the producer states is the basis served, for every servable value', () => {
  // The whole point of the field: nothing here second-guesses it. Before it existed, this
  // function classified by matching a human sentence, and a reworded sentence would have
  // reclassified every fitted number as a prior with nothing failing.
  for (const basis of SERVABLE_AVAILABILITY_BASIS) {
    const out = activeProbabilityFor(mapOf(row({ basis, active: 0.61 })), 1);
    assert.equal(out.availability_basis, basis, basis);
    assert.equal(out.active_probability, 0.61);
  }
  // role and pooled are distinguishable ONLY from the field. A prose match cannot tell them
  // apart, which is why the field had to exist rather than the match being improved.
  assert.equal(activeProbabilityFor(mapOf(row({ basis: 'role' })), 1).availability_basis, 'role');
  assert.equal(activeProbabilityFor(mapOf(row({ basis: 'pooled' })), 1).availability_basis, 'pooled');
});

test('a player with no row at all is unfitted_position, not default_durability', () => {
  // Two different facts: "the fit does not cover this player" against "a row exists carrying a
  // substituted prior". weeklyAvailability covers QB, RB, WR and TE, so every kicker and
  // defence lands here by construction, and a surface showing availability for one is showing
  // a number no model produced.
  const out = activeProbabilityFor(mapOf(row()), 999);
  assert.equal(out.availability_basis, 'unfitted_position');
  assert.equal(out.active_probability, DEFAULT_DURABILITY_PRIOR,
    'the number the five replaced call sites gave an uncovered player, unchanged');
  assert.match(out.availability_source, /no availability row|QB, RB, WR and TE/i);
});

test('no map at all is the same answer, not a throw', () => {
  // Called from paths that may not have built availability yet; a throw here would take down
  // the odds, and a bare number with no basis is what this field exists to stop.
  for (const absent of [null, undefined, {}]) {
    const out = activeProbabilityFor(absent, 1);
    assert.equal(out.availability_basis, 'unfitted_position');
    assert.equal(out.active_probability, DEFAULT_DURABILITY_PRIOR);
  }
});

test('a row without the field falls back to the prose match, and says so when it cannot tell', () => {
  // Reachable only from a payload built before the field existed. The fallback reports the
  // COARSER truth -- pooled -- because role and pooled are indistinguishable from the sentence,
  // and claiming role would be inventing the finer answer.
  const noField = ({ source, measured }) => {
    const r = row({ source, measured });
    delete r.availability_basis;
    return r;
  };
  assert.equal(
    activeProbabilityFor(mapOf(noField({ source: 'fitted availability by role (x, n=9)', measured: true })), 1)
      .availability_basis, 'pooled');
  assert.equal(
    activeProbabilityFor(mapOf(noField({ source: 'durability prior only', measured: true })), 1)
      .availability_basis, 'durability_prior');
  assert.equal(
    activeProbabilityFor(mapOf(noField({ source: 'durability prior only', measured: false })), 1)
      .availability_basis, 'default_durability');
  assert.equal(
    activeProbabilityFor(mapOf(noField({ source: 'wording nobody told us about', measured: null })), 1)
      .availability_basis, 'unrecognised');
});

test('THE COLLISION: a measured prior of exactly 0.920 is not the default', () => {
  // The row is served at three decimals, so a veteran whose measured prior really is 0.920 is
  // byte-identical to the substituted constant. A mapping that compared the number would label
  // a real career measurement as a fallback, on precisely the players whose durability is
  // unremarkable -- an error correlated with the population rather than spread as noise. This
  // stays pinned here even though the field now answers it, because the fieldless fallback
  // still has to get it right.
  const measuredAt092 = mapOf((() => {
    const r = row({ active: 0.92, prior: DEFAULT_DURABILITY_PRIOR, measured: true });
    delete r.availability_basis; return r;
  })());
  const actuallyDefault = mapOf((() => {
    const r = row({ active: 0.92, prior: DEFAULT_DURABILITY_PRIOR, measured: false });
    delete r.availability_basis; return r;
  })());

  const a = activeProbabilityFor(measuredAt092, 1), b = activeProbabilityFor(actuallyDefault, 1);
  assert.equal(a.availability_basis, 'durability_prior', 'a measured 0.920 is not the default');
  assert.equal(b.availability_basis, 'default_durability');
  assert.equal(a.active_probability, b.active_probability, 'identical numbers');
  assert.notEqual(a.availability_basis, b.availability_basis, 'opposite bases');
});

test('every basis it can return is in the shared vocabulary, and none is defined here', async () => {
  const engine = await import('../server/services/player-week-engine.js');
  assert.equal('AVAILABILITY_BASES' in engine, false,
    'the vocabulary has ONE definition, in availability-basis.js');
  assert.equal('DEFAULT_ACTIVE_PROBABILITY' in engine, false,
    'and so does the constant');

  const seen = new Set([
    ...SERVABLE_AVAILABILITY_BASIS.map(basis =>
      activeProbabilityFor(mapOf(row({ basis })), 1).availability_basis),
    activeProbabilityFor(new Map(), 1).availability_basis,
    activeProbabilityFor(mapOf((() => {
      const r = row({ measured: null, source: 'unknown' }); delete r.availability_basis; return r;
    })()), 1).availability_basis
  ]);
  for (const basis of seen) {
    assert.ok(AVAILABILITY_BASIS.includes(basis), `undeclared basis: ${basis}`);
  }
  assert.equal(seen.size, 6, `all six arms should be reachable, saw ${[...seen].join(', ')}`);
});

test('the number for an uncovered player is the producer\'s own constant, read not copied', () => {
  // TWO 0.92s IN THE CODEBASE IS THE THING TO AVOID. The constant has one home now
  // (availability-basis.js) and contingency.js imports it there too, so this asserts the
  // producer really does substitute the same number for a player with no games on file.
  const availability = weeklyAvailability(2026, 2, { through: 2025 });
  const served = availability.get(PLAYER_ID);
  assert.ok(served, 'the fixture player must be in the map, or this proves nothing');
  assert.equal(served.durability_prior_measured, false);
  assert.equal(served.durability_prior, DEFAULT_DURABILITY_PRIOR);
  assert.equal(served.availability_basis, 'default_durability',
    'the producer states the basis on the row now, rather than leaving it to be guessed');

  const out = activeProbabilityFor(availability, PLAYER_ID);
  assert.equal(out.availability_basis, 'default_durability');
  assert.equal(out.active_probability, served.active_probability);
});

test('a basis the vocabulary does not declare is not passed through', () => {
  // `isAvailabilityBasis` and not a null check. A producer sending a value nobody declared --
  // a typo, or a new arm added on one side only -- must not reach six downstream switches as
  // an unknown string they will all fall through on. It is treated as a row that did not say,
  // so the fallback classifies it and the worst case is the named `unrecognised`.
  const bogus = activeProbabilityFor(mapOf(row({ basis: 'totally_made_up', measured: true })), 1);
  assert.notEqual(bogus.availability_basis, 'totally_made_up',
    'an undeclared value must not be served to consumers as if it were vocabulary');
  assert.equal(bogus.availability_basis, 'durability_prior',
    'it falls to the fallback, which here can tell from the flag');

  const bogusAndUnknown = activeProbabilityFor(
    mapOf(row({ basis: 'role_v2', measured: null, source: 'new wording' })), 1);
  assert.equal(bogusAndUnknown.availability_basis, 'unrecognised',
    'and where the fallback cannot tell either, it says so');
});

test('THE NO-OP CONTROL: rewording the source sentence changes nothing now', () => {
  // The control Opportunity ran on their side, repeated on mine, because it is the reason the
  // field exists. A row with the field keeps its basis whatever the prose says -- including
  // prose that directly contradicts it. Before the field, this test could not have passed.
  const contradicting = row({ basis: 'role', source: 'durability prior only, honestly' });
  assert.equal(activeProbabilityFor(mapOf(contradicting), 1).availability_basis, 'role',
    'the field wins over the sentence, so rewording the sentence is a no-op');
  const reworded = row({ basis: 'pooled', source: 'availability from fitted league rates (x, n=9)' });
  assert.equal(activeProbabilityFor(mapOf(reworded), 1).availability_basis, 'pooled');
});
