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
 * `FALLBACK_ACTIVE_PROBABILITY` and `availabilityBasisFor` in trade-engine.js
 * are TEMPORARY. The fantasy plan is landing the real pair in
 * player-week-engine.js: `DEFAULT_ACTIVE_PROBABILITY` and
 * `activeProbabilityFor(availabilityMap, playerId)` returning
 * `{ active_probability, availability_basis }`.
 *
 * The names differ on purpose, so both can sit on main at once with no merge
 * order between them. An earlier draft of this file asserted that both could
 * never exist together; that would have turned main red between two merges
 * that each passed alone, which is the branch-pair collision shape in a new
 * costume. The swap to the accessor is an ordinary follow-up, not a coupling.
 *
 * What is still enforced below: this file's own constant is defined exactly
 * once, so the literal cannot quietly scatter again while the follow-up waits.
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
  assert.equal(typeof engine.FALLBACK_ACTIVE_PROBABILITY, 'number');
  assert.ok(engine.FALLBACK_ACTIVE_PROBABILITY > 0 && engine.FALLBACK_ACTIVE_PROBABILITY <= 1);
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

test('the fallback is defined once, in one file, and nowhere else', () => {
  // The part of the old tripwire worth keeping, pointed at my own files only.
  // Two definitions of one constant is the duplication being removed; a second
  // one appearing here is a regression regardless of what other modules export.
  const defs = [];
  for (const f of ['server/services/trade-engine.js', 'server/services/roster-risk.js']) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^(export )?const FALLBACK_ACTIVE_PROBABILITY\s*=/gm)) {
      defs.push(`${f}: ${m[0].trim()}`);
    }
  }
  assert.equal(defs.length, 1, `expected one definition, found: ${defs.join(' | ')}`);
});
