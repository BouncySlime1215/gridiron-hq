/**
 * WHERE league_draft_picks IS NOT THERE, SAY SO — DO NOT THROW.
 *
 * Same failure shape as league_season_teams (test/league-history-absent.test.js),
 * found independently by the wiring map's phantom-table sweep:
 * `buildManagerArchetypes()` (server/services/manager-archetypes.js) runs
 * `SELECT ... FROM league_draft_picks` with no guard at all. On a box where the
 * table has never been populated, that is a raw `no such table` thrown out of
 * the one function that writes `manager_archetypes` — worse than an empty
 * result, because the nearest try/catch (scheduler.js's job runner, or a bare
 * shell around the CLI script) turns it into an opaque failure that says
 * nothing about which table, or that the failure is routine and expected on a
 * fresh box.
 *
 * WHO CREATES THE TABLE — checked, not assumed, and the answer is nobody in
 * this repository. Both `server/migrations/064_league_history_tables.js` and
 * `scripts/backfill-league-history.mjs` carry a comment claiming it "is owned
 * by scripts/collect-league-transactions.mjs's sibling collector". That file
 * exists and runs, but it creates `league_transactions_raw` — a different
 * table — and grepping every migration and every script in this repo for
 * `CREATE TABLE ... league_draft_picks` finds nothing. Whatever wrote the
 * 1,738 live rows the comments cite is not part of this codebase. A guard here
 * cannot lean on "the sibling will create it eventually" being true.
 *
 * The fix mirrors `leagueHistoryState()` exactly: a state accessor with a
 * `present`/`reason`/`source`, and the one function that reads the table
 * checks it first instead of letting the SELECT throw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-draft-picks-absent-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const arch = await import('../server/services/manager-archetypes.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** The state today: no migration and no script in this repo creates this table. */
function dropDraftPicksTable() { db.exec('DROP TABLE IF EXISTS league_draft_picks'); }
function restoreDraftPicksTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS league_draft_picks (
    league_id INTEGER, season INTEGER, pick_id INTEGER, overall_pick INTEGER, round INTEGER,
    team_id TEXT, member_id TEXT, player_id INTEGER, auto_draft_type_id INTEGER, is_auto INTEGER)`);
}

/** One minimal pick, drafted by a member who is also indexed in league_season_teams
 *  (draftSeason() attributes a pick via the member index, not the pick alone). */
function seedOnePick() {
  run(`INSERT OR IGNORE INTO players (id, espn_id, name, position, gsis_id)
       VALUES (100, 9001, 'Test Player', 'WR', '00-9001')`);
  run(`INSERT INTO league_draft_picks
         (league_id, season, pick_id, overall_pick, round, team_id, member_id, player_id, auto_draft_type_id, is_auto)
       VALUES (1, 2025, 1, 1, 1, '1', 'MEM-1', 9001, 0, 0)`);
  run(`INSERT OR IGNORE INTO league_season_teams
         (league_id, season, roster_id, espn_member_id, owner_name, team_name, captured_at)
       VALUES (1, 2025, '1', 'MEM-1', 'Owner One', 'Team One', '2026-09-19T00:00:00.000Z')`);
}

test('the state of league_draft_picks is readable, and the source names the wrong comment', () => {
  restoreDraftPicksTable();
  const present = arch.leagueDraftPicksState();
  assert.equal(present.present, true);
  assert.equal(present.reason, null, 'nothing to explain when the table is there');

  dropDraftPicksTable();
  const absent = arch.leagueDraftPicksState();
  assert.equal(absent.present, false);
  assert.match(absent.reason ?? '', /league_draft_picks/, 'name the table that is missing');
  // Two separate assertions, not one alternation — the failure mode this
  // project has already hit four times, once in this exact file's sibling.
  assert.match(absent.reason ?? '', /cannot be measured|cannot look|cannot be read/i,
    'that the lookup could not happen');
  assert.match(absent.reason ?? '', /nobody drafted|not a statement|no draft/i,
    'and, explicitly, that this is not a claim that nobody drafted');
  assert.match(absent.source ?? '', /no migration|not created|nothing in this repo|no script/i,
    'the source says plainly that nothing here creates it');
  assert.match(absent.source ?? '', /collect-league-transactions/i,
    'and names the file the wrong "owned by" comments blame, so a reader does not go looking there');
});

test('buildManagerArchetypes reports the absence instead of throwing a raw SQLite error', () => {
  dropDraftPicksTable();
  let out;
  assert.doesNotThrow(() => { out = arch.buildManagerArchetypes({ luckPanel: null }); },
    'a raw "no such table" out of the one function that writes manager_archetypes is an opaque '
    + 'failure to every caller above it — scheduler.js\'s job runner and the CLI script alike');
  assert.equal(out.draft_data_state, 'table_absent');
  assert.match(out.draft_data_reason ?? '', /league_draft_picks/);
  assert.equal(out.league_seasons, 0, 'nothing to report when the table cannot be read');
  assert.equal(out.draft_manager_seasons, 0);
  assert.equal(out.picks_without_manager, 0, 'not a negative count from an empty allPicks array');
});

test('buildManagerArchetypes still reports present with real data, unchanged', () => {
  restoreDraftPicksTable();
  seedOnePick();
  const out = arch.buildManagerArchetypes({ luckPanel: null });
  assert.equal(out.draft_data_state, 'present');
  assert.equal(out.draft_data_reason, null);
  assert.equal(out.league_seasons, 1);
  assert.ok(out.draft_manager_seasons >= 1);
});

test('the absent state is not cached, because a table can appear mid-process', () => {
  dropDraftPicksTable();
  assert.equal(arch.leagueDraftPicksState().present, false);
  restoreDraftPicksTable();
  assert.equal(arch.leagueDraftPicksState().present, true,
    'a cached absence would outlive whatever created the table and keep reporting it missing');
});
