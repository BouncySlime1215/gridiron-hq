/**
 * An unreadable identity layer is not a pile of unowned ESPN slots.
 *
 * `teamMembers()` (manager-archetypes.js) called `teamMembersState()` and
 * returned only its `.byRoster`, discarding the `{ present, reason, source }`
 * it had just computed. `teamMembersState()` deliberately answers with an empty
 * Map when `league_season_teams` cannot be read — so with that table absent,
 * every roster in `outcomeRows()` fell through the
 * `if (!team?.espn_member_id) { out.unownedSlots++; continue; }` branch, whose
 * own comment certifies the case as "a real ESPN state, not a fault".
 *
 * Measured before this was written: two rosters owned by real ESPN members,
 * nothing about them changed, `league_season_teams` renamed away —
 *
 *   HEALTHY    outcome_manager_seasons=2  outcome_unowned_slots=0
 *   UNREADABLE outcome_manager_seasons=0  outcome_unowned_slots=2
 *
 * — and no field on the build named the failure. That is worse than the silent
 * drop it replaced: the count gives a whole-layer fault a confident, wrong
 * explanation. `league_season_teams` can genuinely be absent (migration 064 is
 * not on main, per leagueHistoryState()'s own docstring) while
 * `league_draft_picks` holds rows, so this is a state the build can be in.
 *
 * These tests pin the two halves: the count means only what it claims, and the
 * build names the state the same way it already names draft_data_state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-history-state-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { buildManagerArchetypes } = await import('../server/services/manager-archetypes.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const team = (leagueId, season, rosterId, memberId, owner) =>
  run(`INSERT INTO league_season_teams (league_id, season, roster_id, espn_member_id, owner_name, team_name, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-09-19T00:00:00.000Z')`,
  leagueId, season, rosterId, memberId, owner, `Team ${rosterId}`);

const detail = rosterId => ({
  roster_id: rosterId, weeks: 10, ppg: 100, cv: 0.2, all_play: 0.5, ap_w: 5, ap_l: 5,
  h2h_w: 6, h2h_l: 4, h2h_pct: 0.6, luck_wins: 1, median_rate: 0.5,
});

const luckPanel = [{ league_id: 7, season: 2026, teams_detail: [detail('1'), detail('2')] }];

team(7, 2026, '1', 'MEM-A', 'Owner A');
team(7, 2026, '2', 'MEM-B', 'Owner B');

test('a healthy build attributes both owned rosters and counts no unowned slots', () => {
  const out = buildManagerArchetypes({ luckPanel });
  assert.equal(out.outcome_manager_seasons, 2);
  assert.equal(out.outcome_unowned_slots, 0);
  assert.equal(out.league_history_state, 'present',
    'the state is named even when it is fine, so its absence is never inferred');
  assert.equal(out.league_history_reason, null);
});

test('an unreadable identity layer is named, not counted as unowned slots', () => {
  db.exec('ALTER TABLE league_season_teams RENAME TO league_season_teams_hidden');
  try {
    const out = buildManagerArchetypes({ luckPanel });

    // Asserted first, because this is the defect itself rather than the
    // missing field that reports it: both rosters are owned by real ESPN
    // members and nothing about them changed.
    assert.equal(out.outcome_unowned_slots, 0,
      'these rosters ARE owned — an unreadable table must never be reported as '
      + '"ESPN gave this slot no owner", which is what the count certifies');

    assert.equal(out.league_history_state, 'table_absent',
      'the build has to say the identity layer could not be read at all');
    assert.match(String(out.league_history_reason), /league_season_teams/,
      'and name the table, the same way draft_data_reason does');
  } finally {
    db.exec('ALTER TABLE league_season_teams_hidden RENAME TO league_season_teams');
  }
});

test('a genuinely unowned slot is still counted when the table is readable', () => {
  team(8, 2026, '1', 'MEM-C', 'Owner C');
  team(8, 2026, '2', null, null); // ESPN reported this slot with owners: []
  const out = buildManagerArchetypes({
    luckPanel: [{ league_id: 8, season: 2026, teams_detail: [detail('1'), detail('2')] }],
  });
  assert.equal(out.league_history_state, 'present');
  assert.equal(out.outcome_unowned_slots, 1,
    'the real ESPN state the counter was added for still counts');
  assert.equal(out.outcome_manager_seasons, 1);
});
