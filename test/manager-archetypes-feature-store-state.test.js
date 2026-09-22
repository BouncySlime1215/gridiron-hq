/**
 * A feature store that cannot be read is not a player with nothing to measure.
 *
 * `storeYardageCv()` (manager-archetypes.js) wrapped `buildPlayerFeatureVector()`
 * in `catch { cv = null; }`. The legitimate "this player has no earlier
 * observations" case never reaches that catch — the store returns
 * `{ error: 'no earlier player observations' }` and the `?.vector ?? {}` on the
 * line above absorbs it — so the catch's only possible trigger was a genuine
 * read fault: `playerHistory()` (nfl-weekly-feature-store.js:215) reads
 * `nfl_player_week_features`, `nfl_ngs` and `nfl_pfr_adv` raw, so a missing
 * table, a dropped column or a locked database threw straight out and was
 * flattened into the same `null`.
 *
 * Every player then scored `null`, `storeCvs.length` was 0, and the published
 * manager metric `risk_store_yard_cv` (:393) was simply absent from the build —
 * indistinguishable from "fewer than four skill players had a computable CV".
 * Same shape as the contingency.js#fittedAvailability bug that
 * test/availability-fit-loader.test.js records, and the same rule applies: a
 * table that does not exist is a NAMED state, and any other read error throws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-feature-store-state-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { featureStoreState, buildManagerArchetypes } =
  await import('../server/services/manager-archetypes.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('the store reports itself present when its tables are there', () => {
  const state = featureStoreState();
  assert.equal(state.present, true, 'runMigrations() creates the weekly feature store tables');
  assert.equal(state.reason, null);
});

test('a missing store table is a named state, not a silent null', () => {
  db.exec('ALTER TABLE nfl_player_week_features RENAME TO nfl_player_week_features_hidden');
  try {
    const state = featureStoreState();
    assert.equal(state.present, false, 'the table is gone, so the store cannot be read at all');
    assert.match(String(state.reason), /nfl_player_week_features/,
      'the reason has to name the table — "we cannot look" is not "this player has nothing"');
    assert.match(String(state.reason), /cannot|not on this database/i);
  } finally {
    db.exec('ALTER TABLE nfl_player_week_features_hidden RENAME TO nfl_player_week_features');
  }
});

test('buildManagerArchetypes reports the store state instead of quietly dropping the metric', () => {
  db.exec('ALTER TABLE nfl_ngs RENAME TO nfl_ngs_hidden');
  try {
    const out = buildManagerArchetypes({ luckPanel: [] });
    assert.equal(out.feature_store_state, 'table_absent',
      'risk_store_yard_cv going missing must never be indistinguishable from "not enough players"');
    assert.match(String(out.feature_store_reason), /nfl_ngs/,
      'and the build has to say which table, the same way draft_data_reason does');
  } finally {
    db.exec('ALTER TABLE nfl_ngs_hidden RENAME TO nfl_ngs');
  }
});

test('a healthy build names the store state too, rather than leaving it to be inferred', () => {
  const out = buildManagerArchetypes({ luckPanel: [] });
  assert.equal(out.feature_store_state, 'present');
  assert.equal(out.feature_store_reason, null);
});
