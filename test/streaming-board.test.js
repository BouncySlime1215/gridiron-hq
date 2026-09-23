/**
 * WV-01: the defense streaming board.
 *
 * Defenses ranked by the opponent's market implied team total for the week (read
 * from game_lines through gamescript.js#linesFor, the close once it is frozen), free
 * agents only, with the implied-point edge over the defense you hold and one add
 * suggestion that respects the league's roster limits.
 *
 * Every team, league and manager here is a fixture. game_lines rows are real table
 * rows in a temp database; the ESPN payload is built here in ESPN's own field names
 * (defaultPositionId 16 = D/ST, lineupSlotId 16 = D/ST slot, 20 = bench, 21 = IR).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import * as childProcess from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-streaming-board-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
process.env.NFL_WEEK = '3';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const FUTURE = '2099-09-27';
const PAST = '2000-09-27';
// [team, opponent, spread (team view), total, gameday, closing_spread, closing_total]
// Implied = total/2 - spread/2. Defense's opponent implied in the comment.
const GAMES = [
  ['HOU', 'IND', -3, 42.5, FUTURE],   // HOU D faces IND 19.75
  ['BUF', 'LAC', -7, 50.5, FUTURE],   // BUF D faces LAC 21.75
  ['CLE', 'CAR', 2.5, 42.5, FUTURE],  // CLE D faces CAR 22.5
  ['NYG', 'NO', -7, 39, FUTURE],      // NYG D faces NO 16 (rostered by team 2)
  ['SEA', 'ARI', -7, 41, FUTURE],     // SEA D faces ARI 17: best free, unlocked
  // Already kicked off. The live columns show an in-game number (TEN implied 35);
  // the frozen close says TEN 15.5, so DEN's defense is ranked on 15.5.
  ['DEN', 'TEN', 10, 60, PAST, -9.5, 40.5],
];
function insertLine(season, week, team, opponent, spread, total, gameday, cs = null, ct = null) {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, spread, total, implied_points, source,
         gameday, gametime, closing_spread, closing_total)
       VALUES (?,?,?,?,1,?,?,?, 'espn', ?, '13:00', ?, ?)`,
  season, week, team, opponent, spread, total, total / 2 - spread / 2, gameday, cs, ct);
}
for (const [t, o, s, tot, day, cs = null, ct = null] of GAMES) {
  insertLine(2026, 3, t, o, s, tot, day, cs, ct);
  insertLine(2026, 3, o, t, -s, tot, day, cs == null ? null : -cs, ct);
}

const PRO = { HOU: 34, BUF: 2, CLE: 5, NYG: 19, SEA: 26, DEN: 7, IND: 11, LAC: 24, CAR: 29, NO: 18, ARI: 22, TEN: 10, KC: 12 };
const dst = (team, slot = 16) => ({
  lineupSlotId: slot,
  playerPoolEntry: { player: { id: -16000 - PRO[team], fullName: `${team} D/ST`, defaultPositionId: 16, proTeamId: PRO[team] } }
});
const filler = (n, slot = 20) => Array.from({ length: n }, (_, i) => ({
  lineupSlotId: slot,
  playerPoolEntry: { player: { id: 9000 + i, fullName: `Filler ${i}`, defaultPositionId: 3, proTeamId: 12 } }
}));
// 16 roster spots (IR not counted): QB1 RB2 WR2 TE1 FLEX1 D/ST1 K1 BE7.
const SLOT_COUNTS = { 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 20: 7, 21: 1, 23: 1 };
function league({ mine, theirs = [dst('NYG'), ...filler(15)], slotCounts = SLOT_COUNTS, positionLimits = { 16: 3 },
  rosterPositions = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'DEF', 'K', 'FLEX'], id = 1 } = {}) {
  const payload = {
    settings: { rosterSettings: { lineupSlotCounts: slotCounts, positionLimits } },
    teams: [{ id: 1, roster: { entries: mine } }, { id: 2, roster: { entries: theirs } }]
  };
  return { id, platform: 'espn', league_id: '424242', season: 2026, team_count: 2, my_team_id: '1',
    roster_positions: JSON.stringify(rosterPositions), payload: JSON.stringify(payload) };
}

const { rankDefenses, streamingBoard, MIN_EDGE, WV01_STREAMING_BOARD_ENABLED } = await import('../server/services/streaming-board.js');
const { linesFor } = await import('../server/services/gamescript.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const NOW = new Date('2026-09-24T12:00:00Z');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('rankDefenses orders every defense with a game by the opponent implied total, lowest first', () => {
  const ranked = rankDefenses(linesFor(2026, 3), { now: NOW });
  const order = ranked.map(r => r.team);
  assert.deepEqual(order.slice(0, 4), ['DEN', 'NYG', 'SEA', 'HOU'],
    `expected DEN (15.5 close), NYG (16), SEA (17), HOU (19.75) first; got ${order.join(',')}`);
  assert.equal(ranked.length, 12, 'every team with a game is ranked, and only those');
  const sea = ranked.find(r => r.team === 'SEA');
  assert.equal(sea.opponent, 'ARI');
  assert.equal(sea.opp_implied, 17);
});

test('a game already kicked off is ranked on the frozen close, not the in-game line, and is marked locked', () => {
  const den = rankDefenses(linesFor(2026, 3), { now: NOW }).find(r => r.team === 'DEN');
  assert.equal(den.opp_implied, 15.5, `DEN should read TEN's close (15.5), got ${den.opp_implied}`);
  assert.equal(den.line_basis, 'close');
  assert.equal(den.locked, true);
});

test('the board suggests the best unlocked free-agent defense, with the implied-point edge over mine', () => {
  const b = streamingBoard(league({ mine: [dst('HOU'), ...filler(15)] }), { season: 2026, week: 3, now: NOW, enabled: true });
  assert.equal(b.position, 'DEF');
  const teams = b.candidates.map(c => c.team);
  assert.ok(!teams.includes('NYG'), 'a defense rostered by another team is not a free agent');
  assert.ok(!teams.includes('HOU'), 'my own defense is not a candidate');
  assert.ok(!teams.includes('DEN'), 'a defense whose game has kicked off cannot be added');
  assert.equal(teams[0], 'SEA', `best free agent should be SEA, got ${teams[0]}`);
  assert.equal(b.candidates[0].edge, 2.75, 'edge = my defense\'s opponent implied (19.75) - candidate\'s (17)');
  assert.deepEqual(b.my_defenses.map(d => d.team), ['HOU']);
  assert.equal(b.suggestion.action, 'swap');
  assert.equal(b.suggestion.add.team, 'SEA');
  assert.equal(b.suggestion.drop.team, 'HOU');
  assert.equal(b.suggestion.edge, 2.75);
  assert.match(b.espn_add_url, /leagueId=424242/);
});

test('when my defense already has the best matchup, the suggestion is to hold', () => {
  const b = streamingBoard(league({ mine: [dst('SEA'), ...filler(15)] }), { season: 2026, week: 3, now: NOW, enabled: true });
  assert.equal(b.suggestion.action, 'hold');
  assert.ok(b.candidates.every(c => c.edge < MIN_EDGE), 'no candidate clears the minimum edge');
});

test('no defense on the roster: add only when there is an open roster spot', () => {
  const full = streamingBoard(league({ mine: filler(16) }), { season: 2026, week: 3, now: NOW, enabled: true });
  assert.equal(full.suggestion.action, null, 'a full 16-man roster has no room to add without a drop');
  assert.match(full.suggestion.why, /roster is full/i);
  const open = streamingBoard(league({ mine: filler(15) }), { season: 2026, week: 3, now: NOW, enabled: true });
  assert.equal(open.suggestion.action, 'add');
  assert.equal(open.suggestion.add.team, 'SEA');
});

test('an IR-slot player does not take a roster spot', () => {
  const b = streamingBoard(league({ mine: [...filler(15), ...filler(1, 21)] }), { season: 2026, week: 3, now: NOW, enabled: true });
  assert.equal(b.suggestion.action, 'add');
});

test('holding two defenses at the D/ST limit: the swap drops the one with the worse matchup', () => {
  const b = streamingBoard(league({ mine: [dst('HOU'), dst('CLE', 20), ...filler(13)], positionLimits: { 16: 2 } }),
    { season: 2026, week: 3, now: NOW, enabled: true });
  assert.equal(b.suggestion.action, 'swap');
  assert.equal(b.suggestion.drop.team, 'CLE', 'drop the defense I hold with the worse matchup (CAR 22.5 vs IND 19.75)');
});

test('my defense on bye is the drop, and the edge is not invented', () => {
  const b = streamingBoard(league({ mine: [dst('KC'), ...filler(15)] }), { season: 2026, week: 3, now: NOW, enabled: true });
  assert.equal(b.suggestion.action, 'swap');
  assert.equal(b.suggestion.drop.team, 'KC');
  assert.equal(b.suggestion.drop.on_bye, true);
  assert.equal(b.suggestion.edge, null);
});

test('my defense already locked cannot be dropped', () => {
  const b = streamingBoard(league({ mine: [dst('DEN'), ...filler(15)] }), { season: 2026, week: 3, now: NOW, enabled: true });
  assert.equal(b.suggestion.action, null);
  assert.match(b.suggestion.why, /already started/i);
});

test('a league that does not start a defense gets no board', () => {
  const b = streamingBoard(league({ mine: filler(16), slotCounts: { ...SLOT_COUNTS, 16: 0 },
    rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'K', 'FLEX'] }), { season: 2026, week: 3, now: NOW });
  assert.deepEqual(b.candidates, []);
  assert.match(b.note, /does not start a defense/i);
});

test('a week with no lines says so rather than returning an empty ranking as a finding', () => {
  const b = streamingBoard(league({ mine: [dst('HOU'), ...filler(15)] }), { season: 2026, week: 9, now: NOW });
  assert.deepEqual(b.candidates, []);
  assert.match(b.note, /no betting lines/i);
});

// ---------------------------------------------- Auditor (e): default-off flag
test('Auditor 2026-09-23 (e): WV01_STREAMING_BOARD_ENABLED defaults false, and nothing in this repo sets it true', () => {
  assert.equal(WV01_STREAMING_BOARD_ENABLED, false,
    'no 2026 forward weeks are computable yet (F002); STATS-METHOD.md rule 5 ships this default-off');
  const { execSync } = childProcess;
  const hits = execSync(
    "grep -rn 'WV01_STREAMING_BOARD_ENABLED[[:space:]]*[:=][[:space:]]*true' --include='*.js' --include='*.ts' --include='*.tsx' . " +
    "--exclude-dir=node_modules || true",
    { cwd: process.cwd() }).toString().trim();
  assert.equal(hits, '', `nothing may set the flag true in this repo: ${hits}`);
});

test('with the flag off (default), the board still ranks candidates but suggests no swap and makes no history claim', () => {
  const b = streamingBoard(league({ mine: [dst('HOU'), ...filler(15)] }), { season: 2026, week: 3, now: NOW });
  assert.ok(b.candidates.length > 0, 'board data (rankings) is still returned');
  assert.equal(b.candidates[0].team, 'SEA');
  assert.equal(b.suggestion.action, null, 'no swap is suggested while unconfirmed forward');
  assert.equal(b.suggestion.add, null);
  assert.equal(b.suggestion.drop, null);
  assert.equal(b.suggestion.why, null);
  assert.equal(b.unconfirmed_forward, false);
});

test('with the flag explicitly on, the suggestion is restored and labelled unconfirmed forward', () => {
  const b = streamingBoard(league({ mine: [dst('HOU'), ...filler(15)] }),
    { season: 2026, week: 3, now: NOW, enabled: true });
  assert.equal(b.suggestion.action, 'swap');
  assert.equal(b.suggestion.add.team, 'SEA');
  assert.equal(b.unconfirmed_forward, true);
});

// ------------------------------------------------------------------ the route
test('GET /api/trades/:leagueId/streams serves the board for a member', async () => {
  const { hashSessionToken } = await import('../server/platform/auth.js');
  const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
  const { default: tradesRouter } = await import('../server/routes/trades.js');
  run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (7701, 'streams-user', 'Reader')`);
  run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at) VALUES (7701, ?, datetime('now','+1 day'))`,
    hashSessionToken('streams-token'));
  const lg = league({ mine: [dst('HOU'), ...filler(15)], id: 77 });
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, roster_positions)
       VALUES (?, 'espn', ?, 2026, 'L77', ?, 2, '1', ?)`, lg.id, lg.league_id, lg.payload, lg.roster_positions);
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (77, 7701, 'member')`);
  const app = express();
  app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/trades/77/streams`,
      { headers: { authorization: 'Bearer streams-token' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.week, 3);
    assert.equal(body.position, 'DEF');
    // The fixture kickoffs are in 2099 except DEN's (2000), so against the real clock
    // SEA is still the best unlocked free agent, but WV01_STREAMING_BOARD_ENABLED is
    // default-off (no 2026 forward weeks, Auditor ruling (e)): the route still returns
    // the ranked board, but suggests no swap.
    assert.equal(body.candidates?.[0]?.team, 'SEA');
    assert.equal(body.suggestion?.action, null);
    assert.equal(body.suggestion?.add, null);
    assert.equal(body.unconfirmed_forward, false);
  } finally { server.close(); }
});

// ---------------------------------------------------------------- PREVIEW-01
// PREVIEW_ENV is imported with the other modules at the top: a top-level await placed
// after test() calls lets Node 22 run test.after (db.close) before these tests.
function withPreview(value, fn) {
  const saved = process.env[PREVIEW_ENV];
  if (value === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = saved;
  }
}

test('PREVIEW-01 off (unset): the board is byte-identical to the default-off board', () => {
  const lg = league({ mine: [dst('HOU'), ...filler(15)] });
  withPreview(undefined, () => {
    const b = streamingBoard(lg, { season: 2026, week: 3, now: NOW });
    assert.deepEqual(b.suggestion, { action: null, add: null, drop: null, edge: null, why: null });
    assert.equal(b.unconfirmed_forward, false);
    assert.equal('preview' in b, false);
    assert.equal('preview_reason' in b, false);
  });
});

test('PREVIEW-01 on: the swap suggestion is restored, labelled unconfirmed forward, preview:true', () => {
  const lg = league({ mine: [dst('HOU'), ...filler(15)] });
  withPreview('1', () => {
    const b = streamingBoard(lg, { season: 2026, week: 3, now: NOW });
    assert.equal(b.suggestion.action, 'swap');
    assert.equal(b.suggestion.add.team, 'SEA');
    assert.equal(b.unconfirmed_forward, true, 'the page prints its "unconfirmed forward" line');
    assert.equal(b.preview, true);
    assert.match(b.preview_reason, /unconfirmed forward/);
    assert.match(b.suggestion.why, /^Preview \(unconfirmed forward\): /);
  });
});

test('PREVIEW-01: an explicit enabled:false still wins over the preview switch', () => {
  const lg = league({ mine: [dst('HOU'), ...filler(15)] });
  withPreview('1', () => {
    const b = streamingBoard(lg, { season: 2026, week: 3, now: NOW, enabled: false });
    assert.equal(b.suggestion.action, null);
    assert.equal('preview' in b, false);
  });
});

test('PREVIEW-01 on: GET /api/trades/:leagueId/streams serves the suggestion with preview:true (route call site)', async () => {
  const { hashSessionToken } = await import('../server/platform/auth.js');
  const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
  const { default: tradesRouter } = await import('../server/routes/trades.js');
  run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (7702, 'streams-preview', 'Reader')`);
  run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at) VALUES (7702, ?, datetime('now','+1 day'))`,
    hashSessionToken('streams-preview-token'));
  const lg = league({ mine: [dst('HOU'), ...filler(15)], id: 78 });
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, roster_positions)
       VALUES (?, 'espn', '424278', 2026, 'L78', ?, 2, '1', ?)`, lg.id, lg.payload, lg.roster_positions);
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (78, 7702, 'member')`);
  const app = express();
  app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
  const server = app.listen(0);
  const saved = process.env[PREVIEW_ENV];
  process.env[PREVIEW_ENV] = '1';
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/trades/78/streams`,
      { headers: { authorization: 'Bearer streams-preview-token' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.suggestion?.action, 'swap');
    assert.equal(body.unconfirmed_forward, true);
    assert.equal(body.preview, true);
    assert.match(body.preview_reason, /unconfirmed forward/);
  } finally {
    server.close();
    if (saved === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = saved;
  }
});
