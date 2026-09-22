/**
 * Promoting a shrinkage fit has to reach a running process (2026-09-20).
 *
 * `buildPlayerWeekEngine` memoises on a key whose kOverride slot reads
 * `kOverride ?? 'active'`. The literal stands in for "whatever the active fit is" -- so when
 * a new fit is promoted, `kOverride` is still undefined, the key is still the same string,
 * and the cached engine built from the OLD fit is handed back. The promotion is invisible for
 * as long as the process lives, and the only thing that clears it is a restart or an explicit
 * cache clear that nothing calls on promotion.
 *
 * WHY THAT IS WORSE THAN A STALE NUMBER. It is not detectable from the output. Both fits
 * produce plausible projections, the served payload names a fit (see `projectionFitMeta`),
 * and after this change the id it names is the id the numbers were actually built from. Before
 * it, a promotion could leave the payload naming the new fit while the numbers came from the
 * old one -- the worst available combination, because the label is what a reader checks.
 *
 * The key already carries `weightFit: weightChampion.id` for exactly this reason on the
 * weekly weight set. This makes the shrinkage fit consistent with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-memo-fit-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { buildPlayerWeekEngine, clearPlayerWeekEngineCache }
  = await import('../server/services/player-week-engine.js');
const { saveFit, activateFit, activeFitMeta } = await import('../server/services/shrinkage-fit.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const K_VECTOR = k => [
  { metric: 'yards_per_target', position: 'WR', k, n_obs: 400, n_groups: 80 },
  { metric: 'target_share', position: 'ALL', k: k + 1, n_obs: 400, n_groups: 80 }
];

const build = () => buildPlayerWeekEngine({ season: 2026, week: 2 });

test('the memo really is a memo, or the rest of this file proves nothing', () => {
  // Same inputs, same active fit: the second call must be the cached object, not a rebuild.
  // If this ever fails the cache has been disabled and the assertions below are vacuous.
  const first = build();
  assert.equal(build(), first, 'identical arguments must hit the cache');
});

test('promoting a fit is visible to a running process, with no cache clear', () => {
  // THE RED. Before the fix the key's kOverride slot was the literal 'active' whatever fit was
  // live, so this returned the object built under the first fit and the promotion was invisible
  // until a restart.
  const firstId = (() => { const id = saveFit({ through: 2025, kVector: K_VECTOR(5), note: 'first' });
    activateFit(id); return id; })();
  assert.equal(activeFitMeta().id, firstId);
  const underFirst = build();

  const secondId = (() => { const id = saveFit({ through: 2025, kVector: K_VECTOR(9), note: 'second' });
    activateFit(id); return id; })();
  assert.notEqual(secondId, firstId, 'the fixture must actually promote a different fit');
  assert.equal(activeFitMeta().id, secondId);

  const underSecond = build();
  assert.notEqual(underSecond, underFirst,
    'the engine served after a promotion must not be the one built under the previous fit; '
    + 'nothing calls clearPlayerWeekEngineCache when a fit is activated');

  // And it is still a cache: a second call under the SAME fit hits it again.
  assert.equal(build(), underSecond, 'the fit id must not turn the memo into a no-op');
});

test('going back to the previous fit is also visible', () => {
  // Not symmetry for its own sake: a rollback is the case where being served the newer numbers
  // is worst, because the reason for rolling back is usually that they were wrong.
  const fits = [...Array(2)].map((_, i) => {
    const id = saveFit({ through: 2025, kVector: K_VECTOR(20 + i * 5), note: `roll${i}` });
    return id;
  });
  activateFit(fits[0]);
  const a = build();
  activateFit(fits[1]);
  const b = build();
  activateFit(fits[0]);
  const backToA = build();

  assert.notEqual(b, a);
  assert.equal(backToA, a,
    'the key is the fit id, so returning to a fit legitimately returns its cached engine');
});

test('no fit at all is its own key, not a collision with some fit', () => {
  // The live state today: shrinkage_fits holds zero rows. It has to key distinctly from any
  // real fit, or the first promotion ever made would be invisible.
  clearPlayerWeekEngineCache();
  run('UPDATE shrinkage_fits SET active = 0');
  assert.equal(activeFitMeta(), null);
  const withNoFit = build();

  const id = saveFit({ through: 2025, kVector: K_VECTOR(3), note: 'first ever' });
  activateFit(id);
  assert.notEqual(build(), withNoFit,
    'the first promotion on a deployment that had none must reach a running process too');
});

test('an explicit kOverride still keys separately from the active fit', () => {
  // A caller that bypasses the fit must not be served the fitted engine or vice versa. This
  // already worked and is pinned so the new key cannot break it.
  const id = saveFit({ through: 2025, kVector: K_VECTOR(7), note: 'override check' });
  activateFit(id);
  const fitted = build();
  const overridden = buildPlayerWeekEngine({ season: 2026, week: 2, kOverride: null });
  assert.notEqual(overridden, fitted);
  assert.equal(buildPlayerWeekEngine({ season: 2026, week: 2, kOverride: null }), overridden);
});

test('two different supplied vectors are two different builds', () => {
  // Guarding against the fix introducing a new collision: labelling the supplied-vector case
  // with one string, rather than keying on the vector, would serve one caller's engine to
  // another. That is the same defect this file is about, arriving by a different route.
  const engineA = buildPlayerWeekEngine({ season: 2026, week: 2, kOverride: { target_share: { ALL: 4 } } });
  const engineB = buildPlayerWeekEngine({ season: 2026, week: 2, kOverride: { target_share: { ALL: 9 } } });
  assert.notEqual(engineA, engineB, 'different constants, different build');
  assert.equal(
    buildPlayerWeekEngine({ season: 2026, week: 2, kOverride: { target_share: { ALL: 4 } } }),
    engineA, 'and the same vector still hits the cache');
});
