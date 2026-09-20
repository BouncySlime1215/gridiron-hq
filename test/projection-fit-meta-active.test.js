/**
 * `volume_k` with a fit actually stored (2026-09-20).
 *
 * `test/projection-fit-meta.test.js` deliberately runs with NO active fit, because that is
 * the state the live volume is in. A retroactive mutation sweep showed what that leaves
 * uncovered: with `shrinkage_fits` empty, `activeFitMeta()` returns null and
 * `projectionFitMeta` returns null before reaching any of the logic the field exists for.
 * Two mutations passed all four of those tests —
 *
 *   - `volume_k` hardcoded to `'fitted'`
 *   - `activeFitMeta()` no longer selecting `fitted_at`
 *
 * — and `volume_k` is the single field the Trade Lab copy was built on. A page that says
 * "these odds use the fitted model" while the volume half runs on hand-set constants is
 * exactly the claim the field was added to prevent, and nothing would have failed.
 *
 * So this file stores a fit and asserts on the branch the other file cannot reach. It is a
 * separate file rather than an edit to that one, because the no-fit premise there is worth
 * keeping: it is the production case.
 *
 * THE FIXTURE MATTERS. `through_season` is 2025 and the predicted season is 2026, so
 * `cutoffSafeKVector` returns the stored vector rather than re-fitting for cutoff safety —
 * that is the production configuration. The k rows mix one efficiency metric with two
 * volume ones, because the withholding rule is the thing under test and a vector of only
 * one kind could not show it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-projfit-active-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const FITTED_AT = '2026-09-18T04:05:06.000Z';
run(`INSERT INTO shrinkage_fits (id, fitted_at, through_season, active) VALUES (1, ?, 2025, 1)`, FITTED_AT);
// One efficiency metric and two volume ones. `catch_rate` is not in VOLUME_METRICS, so it
// survives the withholding; `target_share` and `carry_share` are, so they do not.
for (const [metric, position, k] of [
  ['catch_rate', 'ALL', 12.5], ['target_share', 'ALL', 7.5], ['carry_share', 'RB', 4.25]
]) run(`INSERT INTO shrinkage_k (fit_id, metric, position, k) VALUES (1, ?, ?, ?)`, metric, position, k);

const { projectionFitMeta } = await import('../server/services/projections.js');
const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

/** The simulator's own call shape: an in-season cutoff and no roleRecency. */
const simCall = () => projectionFitMeta({ through: 2026, throughWeek: 2 });

test('a season-long caller with an active fit reports hand_set volume, not fitted', () => {
  // This is the whole point of the field. `activeKVectorFor` withholds the volume entries
  // from any caller that is not on weekly-role recency, and the simulator is one of those,
  // so with a fit ACTIVE the odds still run on hand-set volume constants. Reporting
  // 'fitted' here would be the false sentence the UI was about to render.
  const meta = simCall();
  assert.ok(meta, 'an active fit must produce metadata, not null');
  assert.equal(meta.volume_k, 'hand_set');
  assert.equal(meta.recency, 'season_long');
  assert.deepEqual(meta.fitted_metrics, ['catch_rate'],
    'the volume metrics are withheld from this caller, so they are not among its fitted ones');
});

test('a weekly-role caller gets the volume constants, and says so', () => {
  // The other side of the same rule. If both call shapes reported the same thing, the field
  // would be carrying no information at all.
  const meta = projectionFitMeta({ through: 2026, throughWeek: 2, roleRecency: WEEKLY_ROLE_RECENCY });
  assert.ok(meta);
  assert.equal(meta.recency, 'weekly_role');
  assert.equal(meta.volume_k, 'fitted');
  assert.deepEqual(meta.fitted_metrics, ['carry_share', 'catch_rate', 'target_share']);
});

test('the fit is identified by id and by when it was fitted', () => {
  // A surface naming which constants produced a number has to be able to say when they
  // were fitted; `activeFitMeta` selects `fitted_at` for this and nothing else.
  const meta = simCall();
  assert.equal(meta.fit_id, 1);
  assert.equal(meta.fitted_at, FITTED_AT);
  assert.equal(meta.through_season, 2025);
});

test('a caller who forces the hand-set constants is told that, not given a fit id', () => {
  // kOverride null means "ignore the fit", and a response carrying the active fit's id
  // alongside would describe constants that were not used.
  const forced = projectionFitMeta({ through: 2026, throughWeek: 2, kOverride: null });
  assert.equal(forced.fit_id, null);
  assert.equal(forced.volume_k, 'hand_set');
  assert.equal(forced.applied, 'hand_set_forced');
});
