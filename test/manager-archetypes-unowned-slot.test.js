/**
 * A roster with no ESPN member attributed to it is a real state, not a fault.
 *
 * `saveTeams()` (league-history.js) writes `espn_member_id = null` whenever
 * ESPN's own payload has an empty `owners` array for a team — checked against
 * the writer directly, not assumed: `const owner = (t.owners ?? [])[0];` then
 * `owner ?? null`. That happens on a real, if uncommon, ESPN state (a slot
 * nobody has claimed).
 *
 * Both readers of `league_season_teams` used to handle it the same way: a bare
 * `continue`, dropping the roster from the result with nothing left behind —
 * `archetypesFor()` (manager-archetypes.js) served no card for that roster_id
 * at all, and `outcomeRows()` silently excluded its outcome metrics from every
 * manager-season. Correct not to attribute a metric to nobody, but CLAUDE.md's
 * rule already burned this project twice on the shape "a layer goes inert and
 * the surface doesn't say so" — these tests pin a counted reason instead of a
 * silent drop, so a caller can tell "nothing to report" from "something went
 * missing".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-unowned-slot-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { archetypesFor, buildManagerArchetypes } = await import('../server/services/manager-archetypes.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const team = (leagueId, season, rosterId, memberId, owner) =>
  run(`INSERT INTO league_season_teams (league_id, season, roster_id, espn_member_id, owner_name, team_name, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-09-19T00:00:00.000Z')`,
  leagueId, season, rosterId, memberId, owner, `Team ${rosterId}`);

test('archetypesFor counts an unowned slot instead of dropping it with no trace', () => {
  team(41, 2026, '1', 'MEM-OWNED', 'Real Owner');
  team(41, 2026, '2', null, null); // ESPN reported this slot with owners: []

  const out = archetypesFor(41, 2026);
  assert.ok(out.has('1'), 'the owned roster still gets its card');
  assert.ok(!out.has('2'), 'no card is fabricated for a roster with nobody to attribute it to');
  assert.deepEqual(out.unownedSlots, ['2'],
    'the skip is counted and named, not just silently absent from the map');
});

test('a league-season with every roster owned reports no unowned slots', () => {
  team(42, 2026, '1', 'MEM-A', 'Owner A');
  team(42, 2026, '2', 'MEM-B', 'Owner B');
  const out = archetypesFor(42, 2026);
  assert.deepEqual(out.unownedSlots, []);
});

test('buildManagerArchetypes counts unowned-slot outcome rows instead of losing them silently', () => {
  team(43, 2026, '1', 'MEM-C', 'Owner C');
  team(43, 2026, '2', null, null);
  const luckPanel = [{
    league_id: 43, season: 2026,
    teams_detail: [
      { roster_id: '1', weeks: 10, ppg: 100, cv: 0.2, all_play: 0.5, ap_w: 5, ap_l: 5,
        h2h_w: 6, h2h_l: 4, h2h_pct: 0.6, luck_wins: 1, median_rate: 0.5 },
      { roster_id: '2', weeks: 10, ppg: 90, cv: 0.2, all_play: 0.4, ap_w: 4, ap_l: 6,
        h2h_w: 4, h2h_l: 6, h2h_pct: 0.4, luck_wins: -1, median_rate: 0.4 },
    ],
  }];
  const out = buildManagerArchetypes({ luckPanel });
  assert.equal(out.outcome_manager_seasons, 1, 'only the owned roster produces an outcome row');
  assert.equal(out.outcome_unowned_slots, 1, 'the other roster is counted, not just missing from the total');
});
