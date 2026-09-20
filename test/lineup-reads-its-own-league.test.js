/**
 * Start/Sit and the matchup posture must be about the week YOUR league is playing.
 *
 * `tradeWeekContext()` with no league reads the betting `game_lines` table — the
 * lowest week with no score recorded — or `NFL_WEEK`. That is the NFL's week, not
 * the league's, and the two come apart in the cases that matter: a league whose
 * season is offset, a league synced from a payload that states its own matchup
 * period, and any install where `game_lines` is empty or stale because the betting
 * half is not being kept up. #57 gave the function a league argument for exactly
 * this; these two call sites were passing nothing.
 *
 * A wrong week here is not a cosmetic label. It selects the projections, the bye
 * flags and the opponent, so the page would be a confident lineup for a week that
 * is not the one being played.
 *
 * The second half of this file covers the other thing the call carries per player:
 * which availability model priced him. That was the process-level basis for every
 * player, which reads "measured" for someone the fitted role layer never saw.
 *
 * Fixtures follow test/lineup-floor-objective.test.js — the asset universe is
 * mocked, the solver, roster loading and slot rules are real. `tradeWeekContext`
 * is deliberately NOT mocked, because it is the thing under test.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineup-own-league-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
// The answer the zero-argument path gives. Every assertion below is that the
// league's own week wins over this one.
process.env.NFL_WEEK = '2';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realTradeEngine = await import('../server/services/trade-engine.js');
const realWaiverBrain = await import('../server/services/waiver-brain.js');

let assets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => assets,
    lineupDiff: () => ({ error: 'not under test' })
  }
});
mock.module('../server/services/waiver-brain.js', {
  namedExports: { ...realWaiverBrain, vegasLift: () => ({ multiplier: 1, line: null, applied: false }) }
});

const { lineupCall, playerAvailabilityBasis } = await import('../server/services/lineup-brain.js');
const { lineupPosture } = await import('../server/services/lineup-posture.js');
const { row } = await import('../server/db/index.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
function player(name, position, week, extra = {}) {
  const id = nextId++;
  return {
    asset: {
      id, name, position, team_abbr: 'MID', espn_id: 9000 + id, available: true,
      current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: week,
      ceiling: week * 1.5, floor: week * 0.5, active_probability: 0.85, bye: 17,
      availability_source: 'fitted availability by role (starter/noreport/full, n=812)',
      ...extra
    },
    entry: {
      lineupSlotId: 20,
      playerPoolEntry: { player: { id: 9000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: 'ACTIVE' } }
    }
  };
}

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let leagueSeq = 900;
function league(mine, { currentWeek = null } = {}) {
  const id = leagueSeq++;
  assets = new Map(mine.map(p => [p.asset.id, p.asset]));
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } }], schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr,
                            roster_positions, payload, current_week)
       VALUES (?, 'espn', ?, 2026, 'Own league', '1', 10, 1, ?, ?, ?)`,
  id, `ol-${id}`, JSON.stringify(SLOTS), JSON.stringify(payload), currentWeek);
  return id;
}

const roster = (extra = {}) => [
  player('Quarterback', 'QB', 22.4, extra), player('Back One', 'RB', 15.2), player('Back Two', 'RB', 12.8),
  player('Wideout One', 'WR', 16.0), player('Wideout Two', 'WR', 11.7), player('Tight End', 'TE', 8.3),
  player('Flex Back', 'RB', 9.4)
];

test('the call is for the week the league says it is on, not the NFL week', () => {
  const id = league(roster(), { currentWeek: 7 });
  const call = lineupCall(id, { providers: {} });
  assert.equal(call.week, 7, 'league.current_week wins over NFL_WEEK=2');
});

test('a league with no recorded week falls back rather than failing', () => {
  // leagueCurrentWeek drops to the payload's matchup period and then to the
  // calendar. The point is that the league is asked FIRST, not that the fallback
  // is never used.
  const id = league(roster(), { currentWeek: null });
  const call = lineupCall(id, { providers: {} });
  assert.ok(call.week >= 1 && call.week <= 18, 'still a usable week');
});

test('two leagues on different weeks get different calls in one process', () => {
  // The failure the zero-argument version cannot produce: it returns one answer
  // for the whole machine, so a second league silently inherits the first's week.
  const early = league(roster(), { currentWeek: 3 });
  const earlyCall = lineupCall(early, { providers: {} });
  const late = league(roster(), { currentWeek: 11 });
  const lateCall = lineupCall(late, { providers: {} });
  assert.equal(earlyCall.week, 3);
  assert.equal(lateCall.week, 11);
});

test('each call says which model priced that player, not which the process is on', () => {
  const id = league(roster({ availability_source: 'fitted availability (QUE/limited, n=1204)' }), { currentWeek: 4 });
  const call = lineupCall(id, { providers: {} });
  const qb = call.lineup.find(c => c.player.name === 'Quarterback');
  const rb = call.lineup.find(c => c.player.name === 'Back One');
  assert.equal(qb.player.availability_basis, 'pooled', 'this one fell through to the pooled rates');
  assert.equal(rb.player.availability_basis, 'role', 'and this one did not — same page, same process');
});

test('the two absences of a source are not the same absence', () => {
  // A player with the key present and null had no availability row: weeklyAvailability
  // selects QB/RB/WR/TE only. A player whose asset has no such key at all came from an
  // asset universe built before the field existed — fingerprint-cached on table
  // contents, not on code, so a deploy does not invalidate it. Reading the second as
  // the first would label every player on the page as one the fit does not cover.
  assert.equal(playerAvailabilityBasis({ availability_source: null }, { basis: 'role' }), 'unfitted_position');
  assert.equal(playerAvailabilityBasis({}, { basis: 'role' }), 'role');
  assert.equal(playerAvailabilityBasis({}, { basis: 'pooled' }), 'pooled');
  assert.equal(playerAvailabilityBasis({}, null), null);
});

test('every source string weeklyAvailability can build maps to a basis', () => {
  // The four shapes playerActiveProbability produces, written out rather than
  // derived from the function that produces them.
  assert.equal(playerAvailabilityBasis(
    { availability_source: 'fitted availability by role (starter/noreport/full, n=812) x KC' }, null), 'role');
  assert.equal(playerAvailabilityBasis(
    { availability_source: 'fitted availability (QUE/limited, n=1204)' }, null), 'pooled');
  assert.equal(playerAvailabilityBasis(
    { availability_source: 'weekly injury report + durability prior' }, null), 'constants');
  assert.equal(playerAvailabilityBasis(
    { availability_source: 'durability prior only' }, null), 'constants');
});

test('the matchup posture is about the same week the call is', () => {
  // A separate call site with the same bug, and the worse one to get wrong: the
  // posture picks an opponent, so the wrong week is a confident read of a matchup
  // that is not being played. It takes an explicit `week` too, and that still wins.
  const id = league(roster(), { currentWeek: 9 });
  const lg = row('SELECT * FROM leagues WHERE id = ?', id);
  const posture = lineupPosture(lg, { myTeamId: '1' });
  assert.equal(posture.week ?? posture.ctx?.week ?? null, 9,
    'the league says week 9; NFL_WEEK says 2');

  const forced = lineupPosture(lg, { myTeamId: '1', week: 12 });
  assert.equal(forced.week ?? forced.ctx?.week ?? null, 12, 'an explicit week still wins');
});
