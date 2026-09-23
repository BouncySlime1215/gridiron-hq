/**
 * LS-01: the lineup-signal tracker, one producer (server/services/lineup-signals.js)
 * read by GET /api/trades/:leagueId/brain/managers.
 *
 * Every signal is read from league_roster_snapshots (writer writePeriod,
 * scripts/collect-roster-snapshots.mjs:109), the only weekly lineup history the app
 * keeps. Each signal below has one fixture that must fire and one near miss that
 * must not, so a test cannot pass on a producer that flags everything.
 *
 * Fixture names are made up. No real league, manager or player appears here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineup-signals-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const LS = await import('../server/services/lineup-signals.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
await runMigrations();

const LEAGUE = 31, SEASON = 2026;
const BENCH = 20, IR = 21, FLEX = 23, WR = 4, RB = 2, TE = 6;

// ------------------------------------------------------------------ players
// id, position, pro team. Pro teams 901-906 have a game every week; 907 is on bye in week 3.
const PLAYERS = {
  101: ['WR', 901], 102: ['WR', 901], 103: ['RB', 902], 104: ['RB', 902],
  201: ['RB', 903], 202: ['RB', 903], 203: ['WR', 904], 204: ['TE', 907], 205: ['WR', 904],
  301: ['RB', 905], 302: ['RB', 905], 303: ['WR', 906], 304: ['WR', 906], 305: ['WR', 906], 306: ['RB', 905],
};
for (let i = 1; i <= 6; i++) PLAYERS[400 + i] = ['WR', 901];   // free-agent WRs who outscore 304 in week 2
for (const team of [901, 902, 903, 904, 905, 906, 907]) {
  run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (?, ?, ?, 'AFC', 'East')`,
    team, `F${team}`, `Fixture ${team}`);
}
// players.team_id is the app's own nfl_teams id, the key schedule_games uses.
for (const [id, [pos, team]] of Object.entries(PLAYERS)) {
  run('INSERT INTO players (id, name, position, team_id) VALUES (?, ?, ?, ?)', Number(id), `Fixture ${id}`, pos, team);
}
for (const team of [901, 902, 903, 904, 905, 906, 907]) {
  for (let w = 1; w <= 4; w++) {
    if (team === 907 && w === 3) continue;
    run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (?, ?, ?, 'OPP', 1)`, SEASON, team, w);
  }
}

// ---------------------------------------------------------------- snapshots
function snap(period, teamId, playerId, slot, { source = 'final', proj = 10, actual = 10, injury = null,
  pregame = null } = {}) {
  // ESPN's pro_team_id numbers teams its own way (33 = BAL, 34 = HOU); nfl_teams does not.
  // Every fixture row carries ESPN's 33 so a producer that joins pro_team_id to
  // schedule_games.team_id sees phantom byes and fails the near misses below.
  const [position] = PLAYERS[playerId];
  const proTeam = 33;
  run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id,
       player_id, player_name, position, pro_team_id, lineup_slot_id, is_starter, injury_status,
       pregame_injury_status, projected_points, actual_points, on_roster, source, first_seen_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '2026-09-20', '2026-09-20')`,
  LEAGUE, SEASON, period, teamId, 90000 + playerId, playerId, `Fixture ${playerId}`, position, proTeam, slot,
  slot === BENCH || slot === IR ? 0 : 1, injury, pregame, proj, source === 'final' ? actual : null, source);
}
function snaps(playerId, week, pct) {
  run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (?, ?, ?, ?, ?)',
    playerId, SEASON, week, Math.round(pct * 60), pct);
}

// Team 1. 101 was started weeks 1-2, benched week 3 while his snaps held: BWIU.
// 102 the same, but his snaps fell in week 3 (a role change, not a choice). 103 only started once.
for (const w of [1, 2]) { snap(w, 1, 101, WR); snap(w, 1, 102, WR); }
snap(3, 1, 101, BENCH); snap(3, 1, 102, BENCH);
snap(1, 1, 103, RB); snap(2, 1, 103, BENCH); snap(3, 1, 103, BENCH);
snap(3, 1, 104, RB);
for (const [w, p] of [[1, 0.80], [2, 0.84], [3, 0.80]]) snaps(101, w, p);
for (const [w, p] of [[1, 0.80], [2, 0.84], [3, 0.30]]) snaps(102, w, p);
for (const [w, p] of [[1, 0.70], [2, 0.70], [3, 0.70]]) snaps(103, w, p);
for (const w of [1, 2, 3]) snaps(104, w, 0.6);

// Team 2. 201 started in week 3 on a projection far below his own earlier ones while
// a benched RB (202) was projected higher: started through a bad matchup.
// 205 was projected low too but no benched player at his position was projected higher.
snap(1, 2, 201, RB, { proj: 12 }); snap(2, 2, 201, RB, { proj: 14 }); snap(3, 2, 201, RB, { proj: 6 });
snap(3, 2, 202, BENCH, { proj: 9 });
snap(1, 2, 205, WR, { proj: 12 }); snap(2, 2, 205, WR, { proj: 12 }); snap(3, 2, 205, WR, { proj: 5 });
// 203 started week 3, his team played, he did not (no snap row): dead starter left in.
snap(3, 2, 203, WR, { actual: 0 });
// 204 started week 3 while his team was on bye: bye unfilled (not also a dead starter).
snap(3, 2, 204, TE, { actual: 0 });
for (const w of [1, 2, 3]) { snaps(201, w, 0.7); snaps(202, w, 0.3); snaps(205, w, 0.8); }

// Team 3. Week 4 is the live period. 301 is IR-status on the bench; 302 is in the IR slot.
snap(4, 3, 301, BENCH, { source: 'live', injury: 'INJURY_RESERVE' });
snap(4, 3, 302, IR, { source: 'live', injury: 'INJURY_RESERVE' });
// Team 2's live week-4 lineup: 202 benched and on the block, 205 on the block but starting.
snap(4, 2, 202, BENCH, { source: 'live' }); snap(4, 2, 205, WR, { source: 'live' });
// 303 and 304 were on nobody's roster in week 2 and on team 3 in week 3. 303 was the
// top WR of week 2; 304 ranked below six free agents.
snap(3, 3, 303, WR); snap(3, 3, 304, BENCH);
for (const w of [1, 2, 3]) { snaps(303, w, 0.9); snaps(304, w, 0.5); }
const usage = (id, week, rec, yds, td) => run(`INSERT INTO player_week_usage (player_id, season, week, team, position,
  receptions, receiving_yards, receiving_tds) VALUES (?, ?, ?, 'FIX', 'WR', ?, ?, ?)`, id, SEASON, week, rec, yds, td);
usage(303, 2, 10, 180, 2);               // 40 PPR
usage(304, 2, 2, 20, 0);                 // 4 PPR
for (let i = 1; i <= 6; i++) usage(400 + i, 2, 5, 60, 0);   // 11 PPR each
// Flex: 305 (WR, projected 8) in the FLEX slot over 306 (RB, projected 11) on the bench.
snap(3, 3, 305, FLEX, { proj: 8 }); snap(3, 3, 306, BENCH, { proj: 11 });
for (const w of [1, 2, 3]) { snaps(305, w, 0.8); snaps(306, w, 0.5); }

// ------------------------------------------------------------------ league
const rosterEntry = id => ({ playerId: 90000 + id, lineupSlotId: BENCH,
  playerPoolEntry: { player: { id: 90000 + id, fullName: `Fixture ${id}`, defaultPositionId: 3 } } });
const payload = {
  teams: [1, 2, 3].map(id => ({
    id, name: `Team ${id}`, owners: [`{M${id}}`],
    roster: { entries: id === 2 ? [rosterEntry(202), rosterEntry(205)] : [rosterEntry(id * 100 + 1)] },
    tradeBlock: id === 2 ? { players: { [90202]: 'ON_THE_BLOCK', [90205]: 'ON_THE_BLOCK' } }
      : id === 3 ? { players: { [90301]: 'UNTOUCHABLE' } } : {},
  })),
  members: [1, 2, 3].map(id => ({ id: `{M${id}}`, firstName: `First${id}`, lastName: `Last${id}` })),
  settings: { name: 'Lineup fixture' },
  scoringPeriodId: 4, seasonId: SEASON,
};
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, espn_s2, swid, connection_status)
     VALUES (?, 'espn', 'espn-ls-31', ?, 'Lineup fixture', ?, 3, '1', ?, 'secret-s2', 'secret-swid', 'connected')`,
LEAGUE, SEASON, JSON.stringify(payload), JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
// A synced league with no snapshot rows at all: the empty case must say why.
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, connection_status)
     VALUES (32, 'espn', 'espn-ls-32', ?, 'Empty fixture', ?, 3, '1', ?, 'connected')`,
SEASON, JSON.stringify(payload), JSON.stringify(['QB', 'RB', 'WR', 'TE', 'FLEX']));

run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (7801, 'ls-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (7801, ?, datetime('now','+1 day'))`, hashSessionToken('ls-token'));
for (const id of [LEAGUE, 32]) run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 7801, 'member')`, id);

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const out = () => LS.lineupSignals(LEAGUE);
const find = (signal, pid) => out().signals.filter(s => s.signal === signal && s.player_id === pid);

// ------------------------------------------------------------------- tests
test('benched with intact usage: fires on the held-snaps benching, not on a usage drop or a one-time starter', () => {
  const hit = find('benched_intact_usage', 101);
  assert.equal(hit.length, 1, 'player 101 benched in week 3 with snaps held');
  assert.equal(hit[0].roster_id, '1');
  assert.equal(hit[0].week, 3);
  assert.equal(hit[0].evidence.starts_before, 2);
  assert.ok(Math.abs(hit[0].evidence.snap_share - 0.80) < 1e-9);
  assert.equal(find('benched_intact_usage', 102).length, 0, 'snaps fell to 0.30: not intact');
  assert.equal(find('benched_intact_usage', 103).length, 0, 'started once in three: not a regular');
});

test('benched and shopped: bench slot plus ON_THE_BLOCK, not a starter on the block or an untouchable', () => {
  const hit = find('benched_and_shopped', 202);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].roster_id, '2');
  assert.equal(hit[0].week, 4);
  assert.equal(find('benched_and_shopped', 205).length, 0, '205 is on the block but starting');
  assert.equal(find('benched_and_shopped', 301).length, 0, '301 is UNTOUCHABLE, not shopped');
});

test('started through a bad matchup: low projection vs his own history with a better benched option', () => {
  const hit = find('started_bad_matchup', 201);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].week, 3);
  assert.equal(hit[0].evidence.projected, 6);
  assert.equal(hit[0].evidence.own_prior_mean, 13);
  assert.equal(hit[0].evidence.better_bench_player_id, 202);
  assert.equal(find('started_bad_matchup', 205).length, 0, 'no benched WR projected above 205');
});

test('checked out: dead starter left in, bye unfilled, injured not on IR, each once and apart', () => {
  const dead = find('dead_starter_left_in', 203);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].week, 3);
  assert.equal(find('dead_starter_left_in', 204).length, 0, 'a bye is its own signal');
  assert.equal(find('dead_starter_left_in', 201).length, 0, '201 played');
  const bye = find('bye_unfilled', 204);
  assert.equal(bye.length, 1);
  assert.equal(bye[0].week, 3);
  assert.equal(find('bye_unfilled', 203).length, 0);
  const ir = find('injured_not_on_ir', 301);
  assert.equal(ir.length, 1);
  assert.equal(ir[0].week, 4);
  assert.equal(find('injured_not_on_ir', 302).length, 0, '302 is already in the IR slot');
});

test("adds last week's top scorer: a new add who ranked top at his position the week before", () => {
  const hit = find('added_last_week_top_scorer', 303);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].roster_id, '3');
  assert.equal(hit[0].week, 3);
  assert.equal(hit[0].evidence.prior_week_rank, 1);
  assert.equal(find('added_last_week_top_scorer', 304).length, 0, '304 ranked seventh');
  assert.equal(find('added_last_week_top_scorer', 101).length, 0, 'rostered all along');
});

test('flex choices: the revealed ranking, with ESPN projections beside it', () => {
  const hit = find('flex_choice', 305);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].week, 3);
  // 304 (WR, benched, played) is flex-eligible too, so he is one of the passed-over options.
  assert.deepEqual(hit[0].evidence.over_player_ids, [304, 306]);
  assert.equal(hit[0].evidence.chose_lower_projection, true);
});

test('per-manager counts, the guess label, and the honest empty case', () => {
  const o = out();
  assert.equal(o.available, true);
  assert.equal(o.inference, 'guess');
  assert.match(o.inference_reason, /pre-registered/);
  assert.equal(o.by_manager['1'].benched_intact_usage, 1);
  assert.equal(o.by_manager['2'].dead_starter_left_in, 1);
  assert.equal(o.by_manager['3'].injured_not_on_ir, 1);
  const empty = LS.lineupSignals(32);
  assert.equal(empty.available, false);
  assert.match(empty.reason, /league_roster_snapshots/);
  assert.deepEqual(empty.signals, []);
});

test('route: GET /brain/managers carries lineup_signals beside the typed tiers, no cookies', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/trades/${LEAGUE}/brain/managers`, {
    headers: { authorization: 'Bearer ls-token' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.managers), 'the typed-tier payload is still there');
  assert.equal(body.lineup_signals?.available, true);
  assert.ok(body.lineup_signals.signals.some(s => s.signal === 'benched_intact_usage' && s.player_id === 101));
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /secret-s2|secret-swid/);
});
