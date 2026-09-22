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
 * Measured, one rename at a time, rather than assumed from the read list: an
 * absent `nfl_player_week_features` or `nfl_ngs` throws `no such table`, while
 * an absent `nfl_pfr_adv` returns `{ error: 'no earlier player observations' }`
 * — it is read only once base history is in hand, so with none it never runs.
 * `featureStoreState()` still names all three, because the question it answers
 * is whether the store can be read, not which absence happens to throw; but no
 * test here may use `nfl_pfr_adv` to exercise a fault path.
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

const { db, run } = await import('../server/db/index.js');
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

/**
 * The `storePresent` argument is load-bearing, and nothing above reaches it.
 *
 * A mutation sweep on this PR hardcoded `draftSeason(..., true)` at the call
 * site and every test above still passed: `league_draft_picks` is created by no
 * migration in this repository (leagueDraftPicksState()'s own SOURCE string
 * says so), so the draft half of the build never ran and the argument was never
 * evaluated. The surviving mutant is what this test kills.
 *
 * It matters more than a coverage gap. Removing the `catch { cv = null; }` is
 * only safe BECAUSE the caller stops asking when the store is unreadable — the
 * two halves of this PR are one change. With the gate bypassed and a store
 * table absent, `storeYardageCv()` reads straight through to
 * `playerHistory()` (nfl-weekly-feature-store.js:215) and the exception leaves
 * `buildManagerArchetypes()` entirely: the whole archetype build dies over an
 * optional metric. So the assertion below is that the build still COMPLETES.
 */
test('an absent store stops the draft side asking, instead of throwing out of the build', () => {
  // The real table, created here because nothing in the repo creates it.
  db.exec(`CREATE TABLE league_draft_picks (
             league_id INTEGER, season INTEGER, pick_id TEXT, overall_pick INTEGER,
             round INTEGER, team_id TEXT, member_id TEXT, player_id INTEGER,
             auto_draft_type_id INTEGER, is_auto INTEGER)`);
  run(`INSERT INTO nfl_teams (id, abbr, name, conference, division)
       VALUES (1, 'KC', 'Kansas City', 'AFC', 'West')`);
  run(`INSERT INTO players (name, position, team_id, espn_id, gsis_id)
       VALUES ('Skill Player', 'RB', 1, 4242, '00-0042424')`);
  run(`INSERT INTO league_draft_picks
         (league_id, season, pick_id, overall_pick, round, team_id, member_id, player_id, is_auto)
       VALUES (9, 2026, 'p1', 1, 1, '1', 'MEM-D', 4242, 0)`);

  // Deliberately nfl_player_week_features and not nfl_pfr_adv: measured, only
  // two of the three store tables throw when absent. nfl_pfr_adv is read after
  // the base history is in hand, so with no observations the read short-circuits
  // and returns `{ error: 'no earlier player observations' }` instead. A test
  // renaming that one away passes whether or not the gate is honoured, and
  // proves nothing.
  db.exec('ALTER TABLE nfl_player_week_features RENAME TO nfl_player_week_features_hidden');
  try {
    const out = buildManagerArchetypes({ luckPanel: [] });

    // Asserted first: reaching this line at all is the point. If the call site
    // stops honouring storePresent, the line above throws instead.
    assert.equal(out.feature_store_state, 'table_absent',
      'the build completed and named the store as unreadable');
    assert.equal(out.draft_data_state, 'present',
      'and the draft side genuinely ran — otherwise this test proves nothing');
    assert.ok(out.draft_manager_seasons >= 1,
      'at least one drafted manager-season was built with the store unreadable');
  } finally {
    db.exec('ALTER TABLE nfl_player_week_features_hidden RENAME TO nfl_player_week_features');
    db.exec('DROP TABLE league_draft_picks');
  }
});
