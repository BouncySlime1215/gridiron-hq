/**
 * AUTOPSY-01: the Monday Autopsy team-week producer (server/services/weekly-autopsy.js)
 * writing `weekly_autopsy` (migration 087), the table EVAL E7 reads.
 *
 * Fixtures are league_roster_snapshots rows as scripts/collect-roster-snapshots.mjs
 * writes them (source 'final' = ESPN's boxscore for a completed period). The
 * migration, the snapshot table, bestLineup and the producer are all real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-weekly-autopsy-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const {
  runWeeklyAutopsy, autopsyTeamWeek, autopsyEnabled, slotsFromPayload, AUTOPSY_ENV, AUTOPSY_OFF_REASON
} = await import('../server/services/weekly-autopsy.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// ESPN ids: slots QB 0, RB 2, WR 4, TE 6, FLEX 23, DEF 16, K 17, BENCH 20, IR 21;
// positions QB 1, RB 2, WR 3, TE 4, K 5, DEF 16.
const LEAGUE_SLOTS = { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 6, 21: 1 };
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'K'];
const POS = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
const SLOT = { QB: 0, RB: 2, WR: 4, TE: 6, FLEX: 23, DEF: 16, K: 17, BENCH: 20, IR: 21 };

let nextId = 1000;
/** [position, slot, projected, actual] -> a snapshot row. */
const p = (pos, slot, projected, actual, extra = {}) => ({
  espn_player_id: nextId++, position: pos, espn_position_id: POS[pos], lineup_slot_id: SLOT[slot],
  is_starter: slot === 'BENCH' || slot === 'IR' ? 0 : 1, on_roster: 1,
  projected_points: projected, actual_points: actual, ...extra
});

/** A full, optimally set lineup: every starter projects above his bench backup. */
const optimalTeam = () => [
  p('QB', 'QB', 20, 18.4), p('RB', 'RB', 14, 9.1), p('RB', 'RB', 12, 22.3), p('WR', 'WR', 15, 11),
  p('WR', 'WR', 13, 6.2), p('TE', 'TE', 9, 12), p('WR', 'FLEX', 11, 3.5), p('DEF', 'DEF', 7, 10), p('K', 'K', 8, 9),
  p('RB', 'BENCH', 6, 1.2), p('WR', 'BENCH', 5, 0), p('QB', 'BENCH', 12, 30)
];

function insertTeam(leagueId, season, week, teamId, players, source = 'final') {
  for (const x of players) {
    run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id,
        player_id, position, espn_position_id, lineup_slot_id, is_starter, on_roster, projected_points,
        actual_points, source, first_seen_at, changed_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-20', '2026-09-20')`,
    leagueId, season, week, teamId, x.espn_player_id, x.position, x.espn_position_id, x.lineup_slot_id,
    x.is_starter, x.on_roster, x.projected_points, x.actual_points, source);
  }
}

run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (4, 'espn', 'wa-4', 2026, 'Fixture', '1', 2, 1, ?, '2026-09-20 01:00:00')`,
JSON.stringify({ settings: { rosterSettings: { lineupSlotCounts: LEAGUE_SLOTS } } }));

test('the identity: actual = optimal_expected + decision + luck, decision <= 0', () => {
  const players = optimalTeam();
  const r = autopsyTeamWeek({ week: 2, players, slots: SLOTS });
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.actual_points - (r.optimal_expected_points + r.decision_points + r.luck_points)) < 1e-9);
  assert.ok(r.decision_points <= 0);
  // Known-nonzero control on the split itself: the fixture's luck is not 0.
  assert.equal(r.expected_points, 109);
  assert.equal(r.actual_points, 101.5);
  assert.equal(r.luck_points, -7.5);
});

test('an optimally set lineup costs 0 in decisions; the week is all luck', () => {
  const r = autopsyTeamWeek({ week: 2, players: optimalTeam(), slots: SLOTS });
  assert.equal(r.decision_points, 0);
  assert.equal(r.optimal_expected_points, r.expected_points);
});

test('benching a higher-projected player costs exactly the projection gap (flex)', () => {
  const players = optimalTeam();
  // Swap: the 11-point FLEX WR sits, the 6-point bench RB starts in FLEX.
  const flex = players.find(x => x.lineup_slot_id === SLOT.FLEX);
  const benchRb = players.find(x => x.position === 'RB' && x.lineup_slot_id === SLOT.BENCH);
  Object.assign(flex, { lineup_slot_id: SLOT.BENCH, is_starter: 0 });
  Object.assign(benchRb, { lineup_slot_id: SLOT.FLEX, is_starter: 1 });
  const r = autopsyTeamWeek({ week: 2, players, slots: SLOTS });
  assert.equal(r.decision_points, -5);
  assert.equal(r.optimal_expected_points, 109);
  assert.equal(r.expected_points, 104);
});

test('hindsight is reported, never part of the split', () => {
  // The bench QB scored 30 on a 12 projection: the bench line shows it, decisions stay 0.
  const r = autopsyTeamWeek({ week: 2, players: optimalTeam(), slots: SLOTS });
  assert.equal(r.decision_points, 0);
  assert.ok(r.bench_points_lost >= 30 - 18.4 - 1e-9, `bench ${r.bench_points_lost}`);
  assert.match(r.line, /^Week 2: decisions cost 0\.0, luck cost 7\.5; \d+\.\d sat on the bench in hindsight\.$/);
});

test('an IR-slot player never fills the best lineup; K and D/ST fill only their own slots', () => {
  const players = optimalTeam();
  players.push(p('WR', 'IR', 25, 0), p('K', 'BENCH', 30, 2), p('DEF', 'BENCH', 1, 25));
  const r = autopsyTeamWeek({ week: 2, players, slots: SLOTS });
  // IR WR (25) ignored; the bench K (30) would have been started over the 8-point K.
  assert.equal(r.decision_points, -22);
});

test('a lineup slot the model does not know leaves the week ungraded, not guessed', () => {
  const r = autopsyTeamWeek({ week: 2, players: optimalTeam(), slots: SLOTS, unknownSlots: [24] });
  assert.equal(r.optimal_expected_points, null);
  assert.equal(r.decision_points, null);
  assert.match(r.status, /^unsolved: lineup slot ids 24 not modelled$/);
  assert.equal(r.luck_points, -7.5);
});

test('slotsFromPayload reads ESPN lineupSlotCounts and names unknown ids', () => {
  const s = slotsFromPayload(JSON.stringify({ settings: { rosterSettings: { lineupSlotCounts: { ...LEAGUE_SLOTS, 24: 1 } } } }));
  assert.deepEqual([...s.slots].sort(), [...SLOTS].sort());
  assert.deepEqual(s.unknown, [24]);
  assert.equal(slotsFromPayload(null).slots, null);
});

test('the flag: off by default, on with the site flag, preview marks rows, site flag 0 vetoes preview', () => {
  const saved = { a: process.env[AUTOPSY_ENV], p: process.env[PREVIEW_ENV] };
  try {
    delete process.env[AUTOPSY_ENV]; delete process.env[PREVIEW_ENV];
    assert.deepEqual(autopsyEnabled(), { on: false, preview: false });
    process.env[PREVIEW_ENV] = '1';
    assert.deepEqual(autopsyEnabled(), { on: true, preview: true });
    process.env[AUTOPSY_ENV] = '0';
    assert.deepEqual(autopsyEnabled(), { on: false, preview: false });
    process.env[AUTOPSY_ENV] = '1';
    assert.deepEqual(autopsyEnabled(), { on: true, preview: false });
  } finally {
    for (const [k, v] of [[AUTOPSY_ENV, saved.a], [PREVIEW_ENV, saved.p]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('flag off: the job writes nothing and says why', () => {
  const saved = process.env[AUTOPSY_ENV];
  delete process.env[AUTOPSY_ENV];
  try {
    insertTeam(4, 2026, 1, 1, optimalTeam());
    const got = runWeeklyAutopsy({ leagueId: 4 });
    assert.equal(got.off, true);
    assert.equal(got.reason, AUTOPSY_OFF_REASON);
    assert.equal(rows('SELECT * FROM weekly_autopsy').length, 0);
  } finally {
    if (saved === undefined) delete process.env[AUTOPSY_ENV]; else process.env[AUTOPSY_ENV] = saved;
  }
});

test('the job: one row per team per completed week in E7\'s contract, idempotent, live weeks skipped', () => {
  // Week 1 team 1 is already in from the previous test; add team 2 and a live-only week 3.
  const t2 = optimalTeam();
  const flex = t2.find(x => x.lineup_slot_id === SLOT.FLEX);
  const benchRb = t2.find(x => x.position === 'RB' && x.lineup_slot_id === SLOT.BENCH);
  Object.assign(flex, { lineup_slot_id: SLOT.BENCH, is_starter: 0 });
  Object.assign(benchRb, { lineup_slot_id: SLOT.FLEX, is_starter: 1 });
  insertTeam(4, 2026, 1, 2, t2);
  insertTeam(4, 2026, 2, 1, optimalTeam());
  insertTeam(4, 2026, 2, 2, optimalTeam());
  insertTeam(4, 2026, 3, 1, optimalTeam(), 'live');

  const first = runWeeklyAutopsy({ leagueId: 4, enabled: true, now: () => '2026-09-22T10:00:00Z' });
  assert.equal(first.ok, true);
  assert.equal(first.written, 4);
  assert.deepEqual(first.weeks.map(w => w.week), [1, 2]);
  const again = runWeeklyAutopsy({ leagueId: 4, enabled: true });
  assert.equal(again.written, 4);

  // E7's columns (server/services/eval/e7.js COLS on #235/#266), all present and filled.
  const E7_COLS = ['season', 'week', 'league_id', 'team_id', 'actual_points', 'expected_points', 'optimal_expected_points'];
  const got = rows(`SELECT ${E7_COLS.join(', ')}, decision_points, luck_points, preview, projection_basis
    FROM weekly_autopsy ORDER BY week, team_id`);
  assert.equal(got.length, 4);
  for (const r of got) {
    for (const c of E7_COLS) assert.ok(r[c] != null && Number.isFinite(Number(r[c])), `${c} filled`);
    assert.equal(r.preview, 0);
    assert.equal(r.projection_basis, 'espn_pregame');
    assert.ok(Math.abs(r.actual_points - (r.optimal_expected_points + r.decision_points + r.luck_points)) < 1e-9);
  }
  assert.deepEqual(got.map(r => r.decision_points), [0, -5, 0, 0]);
  // E7's own formulas on these rows: luck = actual - expected, decision = expected - optimal.
  for (const r of got) {
    assert.equal(r.luck_points, +(r.actual_points - r.expected_points).toFixed(2));
    assert.equal(r.decision_points, +(r.expected_points - r.optimal_expected_points).toFixed(2));
  }
});

test('preview-mode rows are marked preview = 1', () => {
  const saved = { a: process.env[AUTOPSY_ENV], p: process.env[PREVIEW_ENV] };
  try {
    delete process.env[AUTOPSY_ENV]; process.env[PREVIEW_ENV] = '1';
    const got = runWeeklyAutopsy({ leagueId: 4 });
    assert.equal(got.preview, true);
    assert.deepEqual(rows('SELECT DISTINCT preview FROM weekly_autopsy').map(r => r.preview), [1]);
  } finally {
    for (const [k, v] of [[AUTOPSY_ENV, saved.a], [PREVIEW_ENV, saved.p]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('an unknown league is an error, not an empty success', () => {
  const got = runWeeklyAutopsy({ leagueId: 999, enabled: true });
  assert.equal(got.ok, false);
  assert.match(got.error, /league 999 not found/);
});
