/**
 * TM-03: the target board per league-mate, served on GET /api/trades/:leagueId/brain/managers.
 *
 * Per manager: roster hole (weakest starting slot against the league, on the
 * Start/Sit week number), players he is down on (his own roster) and players of
 * Nick's he rates, openness and untouchables, tilt (last result + how he reacts
 * to losses in chat), active hours, observed accept rate, and LS-01 lineup
 * signals when that table exists. Every read carries its n and its source, and
 * any read under n=5 says THIN.
 *
 * The private chat DB is never read: GRIDIRON_CHAT_DB_PATH points at a fixture
 * built below with made-up names, and the whole path runs from it: fixture chat
 * DB -> buildManagerSignals -> stored rows -> route payload.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-target-board-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';

// ---------------------------------------------------------------- chat fixture
const CHAT_NAME = 'Hayden Brook';   // made up; the chat-side name must never reach the payload
{
  const chat = new DatabaseSync(CHAT_PATH);
  chat.exec(`
    CREATE TABLE manager_chat_profile(name TEXT, msgs, group_msgs, tapbacks, night_share, p_trade_talk,
      p_trash_talk, p_non_fantasy, confidence_mean, p_competitive, p_friendly, p_defensive, p_open_to_trade,
      p_reacting_to_loss, p_own_complaining, p_own_untouchable, first_msg, last_msg, computed_at);
    CREATE TABLE manager_player_sentiment(name TEXT, player TEXT, n, sentiment_mean, share_positive,
      share_negative, first_mention, last_mention, computed_at);
    CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT,
      is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
    CREATE TABLE jev_chat_signals (msg_id INTEGER NOT NULL, name TEXT, chat_kind TEXT, mentioned_player TEXT,
      question TEXT NOT NULL, probability REAL, evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, question));
  `);
  const prof = chat.prepare(`INSERT INTO manager_chat_profile VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  //           name        msgs grp tap night trade trash nonf conf comp frnd def  open  loss  cmpl  untch
  prof.run('ME',          900, 600, 50, 0.20, 0.30, 0.2, 0.3, 2.5, 0.3, 0.5, 0.1, 0.30, 0.05, 0.05, 0.02,
    '2026-01-01', '2026-09-15', '2026-09-17T20:00:00Z');
  prof.run(CHAT_NAME,     400, 300, 20, 0.62, 0.25, 0.3, 0.2, 2.2, 0.4, 0.4, 0.1, 0.34, 0.08, 0.10, 0.05,
    '2026-01-01', '2026-09-17', '2026-09-17T20:00:00Z');
  const sent = chat.prepare(`INSERT INTO manager_player_sentiment VALUES (?,?,?,?,0,0,'2026-08-01',?,datetime('now'))`);
  sent.run(CHAT_NAME, 'Down Back', 6, 1.2, '2026-09-16');       // his own, talked down, n>=5: buy low
  sent.run(CHAT_NAME, 'Hyped Wideout', 2, 3.5, '2026-09-17');   // Nick's, rated, n=2: THIN
  sent.run(CHAT_NAME, 'Flat Guy', 9, 2.0, '2026-09-10');        // Nick's, neutral: neither list
  sent.run(CHAT_NAME, 'Stranger', 7, 1.0, '2026-09-11');        // nobody's here: not a buy-low target
  sent.run(CHAT_NAME, 'Loved Back', 5, 3.8, '2026-09-12');      // his own, rated: not Nick's to sell
  chat.close();
}

// ------------------------------------------------------------------ app setup
const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
await import('../server/services/manager-archetypes.js'); // the real manager_archetypes DDL
const { buildManagerSignals } = await import('../server/services/manager-signals.js');
const { targetBoard, TARGET_BOARD_THIN_N } = await import('../server/services/target-board.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');

await runMigrations();
seedIfEmpty();
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
db.exec(`CREATE TABLE IF NOT EXISTS league_season_teams (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, roster_id TEXT NOT NULL,
  team_name TEXT, owner_name TEXT, espn_member_id TEXT,
  wins INTEGER, losses INTEGER, ties INTEGER, points_for REAL, points_against REAL,
  final_rank INTEGER, playoff_seed INTEGER, captured_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, roster_id))`);

run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (7801, 'target-board-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (7801, ?, datetime('now','+1 day'))`, hashSessionToken('tb-token'));

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const get = async url => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { authorization: 'Bearer tb-token' } });
  return { status: res.status, body: await res.json().catch(() => null), raw: null };
};

// ------------------------------------------------------------ league fixtures
const NICK = '{NICK-0000}';
const AIDEN = '{AIDEN-0000}';
const CARL = '{CARL-0000}';
const member = (id, firstName, lastName) => ({ id, firstName, lastName, displayName: `${firstName}${lastName}` });
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOT_ID = { QB: 0, RB: 2, WR: 4, TE: 6, BENCH: 20 };
const entry = (id, name, pos = 'WR', slot = pos) => ({
  lineupSlotId: SLOT_ID[slot], acquisitionType: 'DRAFT',
  playerPoolEntry: { player: { id, fullName: name, injuryStatus: 'ACTIVE', defaultPositionId: POS_ID[pos] } },
});
const team = (id, owner, { wins = 0, losses = 0, streak = ['WIN', 0], entries = [] } = {}) => ({
  id, name: `Team ${id}`, owners: [owner],
  record: { overall: { wins, losses, ties: 0, pointsFor: 100, pointsAgainst: 100,
    streakType: streak[0], streakLength: streak[1] } },
  roster: { entries },
});
function insertLeague(id, payload, positions) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, ?, ?, ?, '1', ?, 'secret-s2', 'secret-swid', 'connected')`,
  id, `espn-tb-${id}`, `TB${id}`, JSON.stringify(payload), payload.teams.length, JSON.stringify(positions));
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 7801, 'member')`, id);
}

// League 31: the chat league. Roster 2 is confirmed as the chat's Hayden Brook;
// roster 3's match is only `likely`, which is not a corpus.
insertLeague(31, {
  members: [member(NICK, 'Nick', 'Matta'), member(AIDEN, 'Aiden', 'Stone'), member(CARL, 'Carla', 'Delta')],
  teams: [
    team(1, NICK, { wins: 1, streak: ['WIN', 1], entries: [entry(801, 'Hyped Wideout'), entry(802, 'Flat Guy')] }),
    team(2, AIDEN, { losses: 1, streak: ['LOSS', 1], entries: [entry(811, 'Down Back', 'RB'), entry(812, 'Loved Back', 'RB')] }),
    team(3, CARL, { entries: [entry(821, 'Other Guy')] }),
  ],
  schedule: [
    { matchupPeriodId: 1, home: { teamId: 1, totalPoints: 120 }, away: { teamId: 2, totalPoints: 100 }, winner: 'HOME' },
  ],
}, ['QB', 'RB', 'WR', 'TE']);
run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name, chat_name,
       match_method, confidence) VALUES
     (31, '1', ?, 'Nick Matta', 'Team 1', 'ME', 'confirmed by Nick', 'confirmed'),
     (31, '2', ?, 'Aiden Stone', 'Team 2', ?, 'confirmed by Nick', 'confirmed'),
     (31, '3', ?, 'Carla Delta', 'Team 3', 'Carl Delta', 'last name + first-name prefix', 'likely')`,
NICK, AIDEN, CHAT_NAME, CARL);

// Roster 2: six decided offers (4 yes, 2 no) and five waiver moves, all at 03:xx UTC,
// so both the accept rate (bar: 5 decided) and the active-hours window (bar: 10 own
// actions) clear. Roster 3: two decided offers, under the bar, so the rate is withheld.
function tx(id, type, execution, status, teamId, at) {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at,
         team_id, items_json, first_seen_at, last_seen_at)
       VALUES (31, 2026, ?, ?, ?, ?, ?, ?, '[]', '2026-09-17T09:00:00Z', '2026-09-18T04:00:00Z')`,
  id, type, status, execution, at, teamId);
}
for (let i = 1; i <= 6; i++) tx(`a${i}`, i <= 4 ? 'TRADE_ACCEPT' : 'TRADE_DECLINE', 'EXECUTE', 'EXECUTED', 2, `2026-09-0${i}T03:10:00Z`);
for (let i = 1; i <= 5; i++) tx(`w${i}`, 'FREEAGENT', 'EXECUTE', 'EXECUTED', 2, `2026-09-0${i}T03:40:00Z`);
tx('c1', 'TRADE_ACCEPT', 'EXECUTE', 'EXECUTED', 3, '2026-09-03T15:00:00Z');
tx('c2', 'TRADE_DECLINE', 'EXECUTE', 'EXECUTED', 3, '2026-09-04T15:00:00Z');

const built = buildManagerSignals(31);
assert.ifError(built.error);

const board = async () => {
  const r = await get('/api/trades/31/brain/managers');
  assert.equal(r.status, 200);
  return r.body;
};
const tbFor = (body, rosterId) => body.managers.find(m => String(m.roster_id) === rosterId)?.target_board;

// -------------------------------------------------------------------- tests

test('every manager on /brain/managers carries a target board; the existing fields are unchanged', async () => {
  const body = await board();
  assert.equal(body.managers.length, 3);
  for (const m of body.managers) {
    assert.ok(['fair', 'hard', 'never'].includes(m.tradeability), 'the hand-set tier is still served');
    assert.ok(m.target_board && typeof m.target_board === 'object', `roster ${m.roster_id} has a target_board`);
  }
  assert.equal(body.target_board_meta?.thin_below, TARGET_BOARD_THIN_N);
  assert.equal(TARGET_BOARD_THIN_N, 5);
});

test('openness, untouchables and loss reaction come from the chat profile with n = messages and source chat', async () => {
  const tb = tbFor(await board(), '2');
  assert.deepEqual(
    { value: tb.openness.value, n: tb.openness.n, thin: tb.openness.thin, source: tb.openness.source },
    { value: 0.34, n: 400, thin: false, source: 'chat' });
  assert.equal(tb.untouchable.value, 0.05);
  assert.equal(tb.untouchable.n, 400);
  assert.equal(tb.tilt.reacting_to_loss.value, 0.08);
  assert.equal(tb.tilt.reacting_to_loss.source, 'chat');
});

test('tilt reads the last decided result: roster 2 lost by 20, a fact with n=1 from standings', async () => {
  const tb = tbFor(await board(), '2');
  assert.equal(tb.tilt.just_lost, true);
  assert.equal(tb.tilt.last_week_margin.value, -20);
  assert.equal(tb.tilt.last_week_margin.n, 1);
  assert.equal(tb.tilt.last_week_margin.source, 'standings');
  assert.equal(tb.tilt.streak.value, -1);
  // Roster 3 played no decided game: unknown, never "did not lose".
  assert.equal(tbFor(await board(), '3').tilt.just_lost, null);
});

test('down on = his own players he talks below neutral; rates yours = Nick\'s players he talks above neutral; THIN under n=5', async () => {
  const tb = tbFor(await board(), '2');
  assert.deepEqual(tb.down_on.map(p => [p.player, p.n, p.sentiment, p.thin, p.source]),
    [['Down Back', 6, 1.2, false, 'chat']]);
  assert.deepEqual(tb.rates_yours.map(p => [p.player, p.n, p.sentiment, p.thin, p.source]),
    [['Hyped Wideout', 2, 3.5, true, 'chat']]);
  // Neutral (2.0), not on his roster, and his own rated player are in neither list.
  const named = [...tb.down_on, ...tb.rates_yours].map(p => p.player);
  for (const absent of ['Flat Guy', 'Stranger', 'Loved Back']) assert.ok(!named.includes(absent), absent);
  assert.equal(tb.player_reads_state, 'present');
});

test('a manager with only a `likely` chat match has no corpus: chat reads say no_corpus, never a measured zero', async () => {
  const tb = tbFor(await board(), '3');
  assert.equal(tb.player_reads_state, 'no_corpus');
  assert.deepEqual(tb.down_on, []);
  assert.deepEqual(tb.rates_yours, []);
  assert.equal(tb.openness.state, 'no_corpus');
  assert.equal(tb.openness.value, null);
  assert.equal(tb.openness.thin, true);
});

test('observed accept rate is the stored tx_accept_rate; under 5 decided it is withheld with its n', async () => {
  const body = await board();
  const r2 = tbFor(body, '2').accept_rate;
  assert.deepEqual({ value: +r2.value.toFixed(4), n: r2.n, thin: r2.thin, source: r2.source },
    { value: 0.6667, n: 6, thin: false, source: 'tx' });
  const r3 = tbFor(body, '3').accept_rate;
  assert.equal(r3.value, null);
  assert.equal(r3.n, 2);
  assert.equal(r3.state, 'withheld_under_5');
  assert.equal(r3.thin, true);
});

test('active hours: night share from chat, busiest hour from his own transactions (timingRead)', async () => {
  const ah = tbFor(await board(), '2').active_hours;
  assert.equal(ah.night_share.value, 0.62);
  assert.equal(ah.night_share.n, 400);
  assert.equal(ah.busiest_hour_utc, 3);
  assert.equal(ah.actions_n, 11);
  assert.equal(ah.source, 'league_transactions_raw');
  assert.equal(ah.thin, false);
  const ah3 = tbFor(await board(), '3').active_hours;
  assert.equal(ah3.busiest_hour_utc, null);
  assert.equal(ah3.actions_n, 2);
  assert.equal(ah3.thin, true);
});

test('LS-01 lineup signals: table_absent until the table exists, then served with n (control first)', async () => {
  assert.equal(tbFor(await board(), '2').lineup_signals.read_state, 'table_absent');
  db.exec(`CREATE TABLE lineup_signals (league_id INTEGER, roster_id TEXT, player_name TEXT, week INTEGER,
    signal TEXT, evidence TEXT, n INTEGER)`);
  run(`INSERT INTO lineup_signals VALUES (31, '2', 'Down Back', 2, 'benched_usage_intact', 'x', 3)`);
  try {
    const ls = tbFor(await board(), '2').lineup_signals;
    assert.equal(ls.read_state, 'present');
    assert.deepEqual(ls.signals.map(s => [s.player, s.signal, s.week, s.n, s.thin]),
      [['Down Back', 'benched_usage_intact', 2, 3, true]]);
    assert.ok(!('evidence' in ls.signals[0]), 'free text stays in the table');
    assert.equal(tbFor(await board(), '3').lineup_signals.signals.length, 0);
  } finally { db.exec('DROP TABLE lineup_signals'); }
});

test('nothing private leaves: no chat-side name, no message text, no ESPN cookies in the payload', async () => {
  const raw = JSON.stringify(await board());
  assert.ok(!raw.includes(CHAT_NAME), 'the chat name is a join key, never served');
  assert.ok(!raw.includes('secret-s2') && !raw.includes('secret-swid'));
  assert.ok(!/"text"\s*:/.test(raw), 'no message text field');
});

// ------------------------------------------------------ roster hole (priced)
// The hole is priced on the Start/Sit week number through lineupDiff; the
// assets are injected exactly as test/lineup-surfaces-agree.test.js does.
test('roster hole = the starting slot furthest below the league median at that slot, with n = teams compared', () => {
  const pts = { 1: [20, 15, 14, 9], 2: [18, 16, 15, 3], 3: [22, 10, 16, 8] };
  const positions = ['QB', 'RB', 'WR', 'TE'];
  const assets = new Map();
  const teams = [];
  let pid = 1;
  for (const [rid, weekPts] of Object.entries(pts)) {
    const entries = [];
    weekPts.forEach((w, i) => {
      const id = pid++;
      const name = `P${rid}${positions[i]}`;
      assets.set(id, { id, name, position: positions[i], team_abbr: 'MID', espn_id: 9000 + id, available: true,
        current_week_ppg: w, adj_ppg: w, ppg: w, active_probability: 0.95, bye: 9, matchup: { opponent: 'OPP' } });
      entries.push(entry(9000 + id, name, positions[i]));
    });
    teams.push(team(Number(rid), NICK, { entries }));
  }
  insertLeague(32, { members: [member(NICK, 'Nick', 'Matta')], teams, schedule: [] }, positions);
  const lg = db.prepare('SELECT * FROM leagues WHERE id = 32').get();
  const out = targetBoard(lg, { assets });
  const h2 = out.managers.get('2').roster_hole;
  assert.deepEqual([h2.slot, h2.player, h2.week_points, h2.league_median, h2.gap, h2.n, h2.read_state],
    ['TE', 'P2TE', 3, 8, -5, 3, 'present']);
  assert.match(h2.source, /lineupDiff/);
  const h3 = out.managers.get('3').roster_hole;
  assert.deepEqual([h3.slot, h3.gap], ['RB', -5]);
});

test('roster hole on an unpriceable roster says not_priced with the reason, never a slot', async () => {
  // League 31's fixture players are not in the asset universe, so nothing prices.
  const h = tbFor(await board(), '2').roster_hole;
  assert.equal(h.read_state, 'not_priced');
  assert.equal(h.slot, null);
  assert.ok(h.reason && h.reason.length > 0);
});
