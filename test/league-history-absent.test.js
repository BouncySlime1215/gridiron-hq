/**
 * WHERE league_season_teams IS NOT THERE, SAY SO — DO NOT THROW.
 *
 * The as-of family exists so that a surface can tell "nothing has been built"
 * apart from "this is current". A raw `SQLITE_ERROR: no such table` is neither:
 * it is an exception that the nearest try/catch turns into an empty result, and
 * an empty result is the one answer that reads as "we looked and there is
 * nothing to say".
 *
 * WHO CREATES THE TABLE, checked rather than assumed. It is
 * `server/migrations/064_league_history_tables.js:29`, whose own comment names
 * `managerProfile()` and `archetypesFor()` as the readers it indexes for. That
 * migration is NOT on origin/main — it arrives with PR #47, which this branch
 * is stacked on. So today, on main, `runMigrations()` does not create it and
 * all three readers throw; after #47 they do not. The guard is for the window
 * before that merge, and afterwards for a database restored from a backup
 * older than it. `scripts/backfill-league-history.mjs` also creates it, which
 * is why the table exists on boxes that have run the backfill and is missing
 * on boxes that have not — the same table arriving by two routes is exactly
 * why nothing should depend on it having arrived.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-history-absent-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const arch = await import('../server/services/manager-archetypes.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** The state main is in today: every other table migrated, this one not there. */
function dropHistoryTable() { db.exec('DROP TABLE IF EXISTS league_season_teams'); }
function restoreHistoryTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS league_season_teams (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, roster_id TEXT NOT NULL,
    team_name TEXT, owner_name TEXT, espn_member_id TEXT,
    wins INTEGER, losses INTEGER, ties INTEGER, points_for REAL, points_against REAL,
    final_rank INTEGER, playoff_seed INTEGER, captured_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, roster_id))`);
}

test('the state of the history table is readable, and names what creates it', () => {
  restoreHistoryTable();
  const present = arch.leagueHistoryState();
  assert.equal(present.present, true);
  assert.equal(present.reason, null, 'nothing to explain when the table is there');
  dropHistoryTable();
  const absent = arch.leagueHistoryState();
  assert.equal(absent.present, false);
  assert.match(absent.reason ?? '', /league_season_teams/, 'name the table that is missing');
  // THE DISAMBIGUATION IS THE REASON'S JOB, and asserting only the table name
  // left it unguarded: a mutation deleting this clause survived the first run
  // of this suite. Naming a missing table tells a reader what broke; this
  // clause is what stops the absence being read as a finding about a manager.
  assert.match(absent.reason ?? '', /cannot look|cannot be read|we cannot/i,
    'that the lookup could not happen');
  assert.match(absent.reason ?? '', /unknown|nobody|no such manager/i,
    'and, explicitly, that this is NOT a statement about the manager — the two nulls this '
    + 'whole guard exists to keep apart');
  // Two separate assertions, not /064|migration/. That alternation passed with
  // the migration clause deleted, because the word "migration" survived in the
  // sentence about the script. One term surviving is not the claim holding.
  assert.match(absent.source ?? '', /064/,
    'the migration by number, so a reader can go and look at it');
  assert.match(absent.source ?? '', /backfill-league-history/,
    'and the script, because the table arriving by two routes is why it can be missing at all');
});

test('archetypesFor returns nothing rather than throwing where the table is absent', () => {
  dropHistoryTable();
  let out;
  assert.doesNotThrow(() => { out = arch.archetypesFor(1, 2025); },
    'a raw "no such table" is what the trade route swallows into an empty Map, which is the '
    + 'silent-empty failure this whole family of work exists to delete');
  assert.equal(out.size, 0);
});

test('managerProfile distinguishes no identity row from no identity table', () => {
  restoreHistoryTable();
  const noRow = arch.managerProfile('member-with-no-row');
  assert.equal(noRow.identity, null);
  assert.equal(noRow.identity_state, 'no_row',
    'the table is there and this member is not in it — a real, ordinary answer');

  dropHistoryTable();
  const noTable = arch.managerProfile('member-with-no-row');
  assert.equal(noTable.identity, null, 'still null, because there is still no identity');
  assert.equal(noTable.identity_state, 'table_absent',
    'but a DIFFERENT null: one says this manager is unknown, the other says we cannot look. '
    + 'Collapsing them is how "who is this?" becomes "nobody".');
  assert.match(noTable.identity_reason ?? '', /league_season_teams/);
});

test('teamMembers reports the absence instead of throwing, and an empty map is not the answer', () => {
  dropHistoryTable();
  let out;
  assert.doesNotThrow(() => { out = arch.teamMembersState(1, 2025); });
  assert.equal(out.present, false);
  assert.equal(out.byRoster.size, 0);
  assert.match(out.reason ?? '', /league_season_teams/,
    'pick attribution silently losing every roster-to-member mapping is how ~20% of picks '
    + 'become unattributed with nothing saying why');
  restoreHistoryTable();
  const back = arch.teamMembersState(1, 2025);
  assert.equal(back.present, true);
  assert.equal(back.reason, null);
});

test('the absent state is not cached, because a migration can create the table mid-process', () => {
  dropHistoryTable();
  assert.equal(arch.leagueHistoryState().present, false);
  restoreHistoryTable();
  assert.equal(arch.leagueHistoryState().present, true,
    'caching the absence would outlive the migration that fixes it, and the process would keep '
    + 'reporting a table it is now sitting on top of');
});

/* ------------------- never collected, versus collected and genuinely zero */

/**
 * A ZERO THAT WAS NEVER COUNTED IS NOT A ZERO.
 *
 * An archetype computed over no rows is a real-looking answer about a real
 * person. So the caller has to be able to tell "this league-season was never
 * collected" from "it was collected and there is genuinely nothing in it" —
 * and an empty result says neither.
 *
 * No migration creates `league_season_teams` empty for the same reason: an
 * empty table turns an honest "no such table" into a silent zero. The absence
 * is served through `reason`, the field this module already uses for
 * not-built data, rather than through a new field invented ahead of the
 * confident-zero contract.
 */
test('a league-season that was never collected says so, and does not read as a zero', () => {
  dropHistoryTable();
  const built = arch.archetypesBuilt(1, 2025);
  assert.match(built.reason ?? '', /league_season_teams/,
    'the not-collected state reaches the caller through the reason field, the same one a '
    + 'never-built archetype uses — a caller seeing rows: 0 with no reason cannot tell the two apart');
  assert.match(built.reason ?? '', /never collected|not collected|cannot look|no such table|is not on this database/i,
    'and it says WHICH kind of nothing this is');
});

test('collected and genuinely empty is a different sentence from never collected', () => {
  restoreHistoryTable();
  const collected = arch.archetypesBuilt(1, 2025);
  const absentClause = /league_season_teams/;
  assert.ok(!absentClause.test(collected.reason ?? ''),
    'with the table there, a league-season with no rows is an ordinary empty and must not '
    + 'borrow the not-collected sentence; otherwise the two states share one answer again '
    + 'and the whole distinction is decorative');
  dropHistoryTable();
  assert.match(arch.archetypesBuilt(1, 2025).reason ?? '', absentClause,
    'and the same call on the same key says the other thing when the table is gone');
  restoreHistoryTable();
});
