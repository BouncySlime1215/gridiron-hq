/**
 * `?? 0.92` was written out at three sites — twice in trade-engine.js and once
 * in roster-risk.js — as the chance a player suits up when nothing has measured
 * him. It is hand-set: chosen, not fitted, with no outcome scored against it
 * and no study cited. It sat beside numbers that ARE fitted, and a reader had
 * no way to tell them apart, which is the same shape as the waiver board
 * publishing a hand-set 0.9 as a fitted confidence.
 *
 * `weeklyAvailability` covers QB/RB/WR/TE only, so a kicker or a defence is on
 * the constant BY CONSTRUCTION rather than by accident. That is exactly why the
 * basis has to travel with the number: "0.92 because nothing covers kickers" and
 * "0.87 because we measured him" are different claims wearing the same shape.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE CONTAINS A DELIBERATE TRIPWIRE. READ BEFORE MERGING.
 *
 * `DEFAULT_ACTIVE_PROBABILITY` and `availabilityBasisFor` in trade-engine.js are
 * TEMPORARY. The fantasy plan is landing the real pair in player-week-engine.js:
 * `DEFAULT_ACTIVE_PROBABILITY` and `activeProbabilityFor(availabilityMap,
 * playerId)` returning `{ active_probability, availability_basis }`.
 *
 * The last test below fails as soon as BOTH exist. That is intended and it is a
 * true statement — two definitions of one constant is the duplication being
 * removed, not a state to live in. It means the two changes must ride the same
 * train: when the fantasy plan's export lands, trade-engine's local pair is
 * deleted and the call sites move to the accessor, in that merge or the one
 * beside it. Recorded here rather than in a message because a message is not
 * where the person merging will be looking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-avail-basis-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db } = await import('../server/db/index.js');
const engine = await import('../server/services/trade-engine.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

test('the default is named once and is a probability', () => {
  assert.equal(typeof engine.DEFAULT_ACTIVE_PROBABILITY, 'number');
  assert.ok(engine.DEFAULT_ACTIVE_PROBABILITY > 0 && engine.DEFAULT_ACTIVE_PROBABILITY <= 1);
});

test('a player nothing measured is default_durability, not a quiet number', () => {
  // The case that matters: no availability row at all. Before this, the surface
  // served 0.92 with nothing to distinguish it from a measured 0.92.
  assert.equal(engine.availabilityBasisFor(undefined), 'default_durability');
  assert.equal(engine.availabilityBasisFor(null), 'default_durability');
  assert.equal(engine.availabilityBasisFor({ active_probability: null }), 'default_durability');
});

test('a durability prior is its own answer, not folded into fitted', () => {
  // contingency.js:901 has its own `?? 0.92` for a missing durability prior, so
  // "came from the prior" and "was fitted for this player" are genuinely
  // different states and must not collapse into one label.
  assert.equal(engine.availabilityBasisFor({ active_probability: 0.9, source: 'durability_prior' }),
    'durability_prior');
  assert.equal(engine.availabilityBasisFor({ active_probability: 0.87, source: 'role' }), 'fitted');
});

test('the literal is gone from both files', () => {
  // The regression guard. A fourth `?? 0.92` added next month is how the first
  // three got there.
  for (const f of ['server/services/trade-engine.js', 'server/services/roster-risk.js']) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue;
      assert.ok(!/\?\?\s*0\.92\b/.test(line), `${f}:${i + 1} writes the default out again: ${line.trim()}`);
    }
  }
});

test('TRIPWIRE: the temporary local pair must not outlive the real one', async () => {
  // See the header. This is expected to fail on the merge that lands
  // player-week-engine.js's accessor, and the fix is to delete trade-engine's
  // local pair and call the accessor instead — not to weaken this test.
  let real = {};
  try { real = await import('../server/services/player-week-engine.js'); } catch { real = {}; }
  const realHasIt = typeof real.activeProbabilityFor === 'function'
    || typeof real.DEFAULT_ACTIVE_PROBABILITY === 'number';
  if (!realHasIt) {
    assert.equal(typeof engine.DEFAULT_ACTIVE_PROBABILITY, 'number',
      'until the real accessor lands, trade-engine holds the only definition');
    return;
  }
  assert.equal(engine.DEFAULT_ACTIVE_PROBABILITY, undefined,
    'player-week-engine now exports the real accessor: delete trade-engine\'s temporary '
    + 'DEFAULT_ACTIVE_PROBABILITY and availabilityBasisFor and call activeProbabilityFor instead');
});
