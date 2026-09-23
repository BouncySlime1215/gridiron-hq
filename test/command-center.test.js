/**
 * SK-01 command center: one list across every league the signed-in user belongs
 * to, sorted by deadline, built ONLY from existing producers.
 *
 *   dead starters   trade-engine.js#lineupDiff (flagged_starters; SS-01's
 *                   dead_starters when that field is present)
 *   streaming swap  streaming-board.js#streamingBoard (WV-01, PR #176) when the
 *                   module exists on this build
 *   injury alerts   waiver-wire.js#waiverBoard().injury_alerts (WV-02, PR #178)
 *                   when the field is present
 *   no move yet     league_transactions_raw, my team, this scoring period = 0
 *
 * The producers are stubbed here (their own tests own their numbers); this file
 * owns the aggregation, the feature detection, the deadlines, the sort and the
 * route. Fixture league RED: an Out starter, a free streaming defense and an
 * injured starter must yield all three items.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-command-center-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const NOW = new Date('2026-09-23T15:00:00Z'); // a Wednesday of week 3
const COOKIE = 'SENTINEL-COOKIE-VALUE-never-in-output';

// Game lines for kickoffs (the same table WV-01 reads through gamescript.js#linesFor).
db.exec(`INSERT INTO game_lines (season, week, team, opponent, gameday, gametime)
  VALUES (2026, 3, 'KC', 'LV', '2026-09-27', '16:25'), (2026, 3, 'LV', 'KC', '2026-09-27', '16:25'),
         (2026, 3, 'BUF', 'MIA', '2026-09-24', '20:15'), (2026, 3, 'MIA', 'BUF', '2026-09-24', '20:15')`);

// ---------------------------------------------------------------- producer stubs
const producerOut = new Map(); // league id -> { diff, waivers, streams }
const te = await import('../server/services/trade-engine.js');
mock.module('../server/services/trade-engine.js', { namedExports: {
  ...te,
  tradeWeekContext: () => ({ season: 2026, week: 3 }),
  lineupDiff: lg => producerOut.get(Number(lg.id))?.diff ?? { flagged_starters: [], swaps: [] },
} });
const ww = await import('../server/services/waiver-wire.js');
mock.module('../server/services/waiver-wire.js', { namedExports: {
  ...ww,
  waiverBoard: lg => producerOut.get(Number(lg.id))?.waivers ?? { immediate: [] },
} });

const cc = await import('../server/services/command-center.js');
const router = (await import('../server/routes/command-center.js')).default;

// ---------------------------------------------------------------- fixture rows
function account(subject) {
  run(`INSERT INTO users (subject, display_name) VALUES (?, ?)`, subject, subject);
  return row('SELECT last_insert_rowid() AS id').id;
}
function league(name, userId, { myTeamId = '7', week = 3 } = {}) {
  run(`INSERT INTO leagues (platform, league_id, season, name, payload, team_count, my_team_id, current_week, espn_s2, swid)
       VALUES ('espn', ?, 2026, ?, '{"teams":[]}', 10, ?, ?, ?, ?)`, `id-${name}`, name, myTeamId, week, COOKIE, COOKIE);
  const id = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,'member')`, id, userId);
  return id;
}
const nick = account('nick');
const stranger = account('stranger');
const nobody = account('nobody');
const redLeague = league('Red fixture', nick);
const quietLeague = league('Quiet fixture', nick);
const strangersLeague = league('Not yours', stranger);

// The hand-created collector table (scripts/collect-league-transactions.mjs:21).
function createTxTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
    type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
    team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
    bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, tx_id))`);
}
function tx(leagueId, id, { type = 'FREEAGENT', status = 'EXECUTED', team = 7, period = 3, seen = '2026-09-23T12:00:00Z' } = {}) {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, team_id,
         scoring_period, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  leagueId, 2026, id, type, status, 'EXECUTE', team, period, seen, seen);
}

// Producer outputs in the shapes the producers return on their branches.
const outStarter = { id: 11, name: 'Out Starter', position: 'WR', team_abbr: 'KC', week_points: 14.2,
  injury_status: 'Out', espn_status: 'OUT', reason: 'on IR', espn_disagrees: false };
const redDiff = {
  flagged_starters: [outStarter],
  swaps: [{ slot: 'WR', in: { id: 12, name: 'Bench Wideout', position: 'WR', team_abbr: 'BUF', week_points: 9.4 },
    out: { ...outStarter, counts_for: 0, reason: 'on IR' }, gap: 9.4, p_right: 0.92, urgency: 'high' }],
};
const redStreams = {
  season: 2026, week: 3,
  suggestion: { action: 'swap', edge: 6.5,
    add: { team: 'KC', opponent: 'LV', opp_implied: 17.5, kickoff: '2026-09-27T20:25:00.000Z', locked: false },
    drop: { team: 'MIA', opponent: 'BUF', opp_implied: 24, kickoff: '2026-09-25T00:15:00.000Z', locked: false },
    why: 'KC faces LV (implied 17.5); MIA faces BUF (implied 24): 6.5 implied points easier.' },
};
const redWaivers = {
  immediate: [{ player: 'Wire Back', position: 'RB', projected_ppg: 11, upgrade: 3.1 }],
  injury_alerts: [{
    player: 'Hurt Runner', position: 'RB', team: 'BUF', lineup_slot: 2, designation: 'doubtful',
    designation_source: 'espn', status: 'DOUBTFUL', snap_share: 0.71,
    replacements: { same_team: [{ player: 'Backup Runner', position: 'RB', team: 'BUF', projected_ppg: 8.3, on_your_roster: false }],
      same_team_count: 1, order: 'projection', ranked_by: 'x', best_free_agent: null },
    claim_by: { known: true, day: 'THURSDAY', date: '2026-09-24', hour: 3, zone: 'America/New_York',
      zone_basis: 'guess: ESPN does not state the zone of waiverProcessHour' },
  }],
};

// ---------------------------------------------------------------- the builder
test('RED fixture: an Out starter, a free streaming defense and an injured starter yield all three items', () => {
  const items = cc.leagueItems({
    league: { id: redLeague, name: 'Red fixture' },
    diff: redDiff, waivers: redWaivers, streams: redStreams,
    moves: { state: 'present', count: 2 }, season: 2026, week: 3, now: NOW,
  });
  const kinds = items.map(i => i.kind).sort();
  assert.deepEqual(kinds, ['dead_starter', 'injury_alert', 'stream']);
  for (const i of items) {
    assert.equal(typeof i.what, 'string'); assert.ok(i.what.length > 0);
    assert.match(i.why, /\d/, `${i.kind} why must cite a number: ${i.why}`);
    assert.ok(i.action?.href?.startsWith('/'), `${i.kind} needs an action link`);
    assert.equal(i.league.id, redLeague);
  }
  const dead = items.find(i => i.kind === 'dead_starter');
  assert.match(dead.what, /Out Starter/);
  assert.match(dead.why, /9\.4/, 'names the bench swap and its projection');
  // KC kicks off 2026-09-27 16:25 ET = 20:25Z.
  assert.equal(dead.deadline, '2026-09-27T20:25:00.000Z');
  const stream = items.find(i => i.kind === 'stream');
  assert.match(stream.what, /KC/);
  assert.match(stream.why, /6\.5/);
  // The dropped defense locks first (MIA Thursday night), so that is the deadline.
  assert.equal(stream.deadline, '2026-09-25T00:15:00.000Z');
  const hurt = items.find(i => i.kind === 'injury_alert');
  assert.match(hurt.what, /Hurt Runner/);
  assert.match(hurt.why, /8\.3/);
  // Claim by Thursday 03:00 America/New_York = 07:00Z.
  assert.equal(hurt.deadline, '2026-09-24T07:00:00.000Z');
  assert.equal(hurt.deadline_guess, true, 'the waiver zone is a guess and says so');
});

test('an Out starter who also raises an injury alert is listed once, as the dead starter', () => {
  const dupWaivers = { ...redWaivers, injury_alerts: [{ ...redWaivers.injury_alerts[0], player: 'Out Starter', position: 'WR', team: 'KC' }] };
  const items = cc.leagueItems({ league: { id: 1, name: 'x' }, diff: redDiff, waivers: dupWaivers, streams: null,
    moves: { state: 'present', count: 1 }, season: 2026, week: 3, now: NOW });
  assert.deepEqual(items.map(i => i.kind), ['dead_starter']);
});

test('no move yet this week: nudges only when the collection is fresh and the count is zero', () => {
  const base = { league: { id: 1, name: 'x' }, diff: { flagged_starters: [] }, waivers: redWaivers && { immediate: redWaivers.immediate },
    streams: null, season: 2026, week: 3, now: NOW };
  const zero = cc.leagueItems({ ...base, moves: { state: 'present', count: 0, as_of: '2026-09-23T12:00:00Z' } });
  assert.deepEqual(zero.map(i => i.kind), ['no_move']);
  assert.match(zero[0].why, /0 /);
  assert.match(zero[0].why, /3\.1/, 'cites the best claim on the waiver board');
  assert.equal(cc.leagueItems({ ...base, moves: { state: 'present', count: 1 } }).length, 0);
  assert.equal(cc.leagueItems({ ...base, moves: { state: 'stale', count: 0 } }).length, 0);
  assert.equal(cc.leagueItems({ ...base, moves: { state: 'source_table_absent', count: null } }).length, 0);
});

test('sort: earliest deadline first, unknown deadlines last', () => {
  const a = { kind: 'no_move', deadline: null }, b = { kind: 'stream', deadline: '2026-09-25T00:15:00.000Z' },
    c = { kind: 'injury_alert', deadline: '2026-09-24T07:00:00.000Z' };
  assert.deepEqual([a, b, c].sort(cc.byDeadline).map(i => i.kind), ['injury_alert', 'stream', 'no_move']);
});

test('movesThisWeek reads league_transactions_raw: absent table, then zero, then a move; cancelled and lineup rows do not count', () => {
  assert.equal(cc.movesThisWeek({ id: redLeague, season: 2026, my_team_id: '7', current_week: 3 }, NOW).state, 'source_table_absent');
  createTxTable();
  tx(redLeague, 'lineup', { type: 'ROSTER' });
  tx(redLeague, 'cancelled', { type: 'WAIVER', status: 'CANCELED' });
  tx(redLeague, 'rival', { team: 3 });
  tx(redLeague, 'last-week', { period: 2 });
  const zero = cc.movesThisWeek({ id: redLeague, season: 2026, my_team_id: '7', current_week: 3 }, NOW);
  assert.deepEqual({ state: zero.state, count: zero.count }, { state: 'present', count: 0 });
  tx(redLeague, 'claim', { type: 'WAIVER', status: 'PENDING' });
  assert.equal(cc.movesThisWeek({ id: redLeague, season: 2026, my_team_id: '7', current_week: 3 }, NOW).count, 1);
  // Collected more than a day before `now`: we cannot say "no move", only "not looked".
  const later = new Date('2026-09-25T15:00:00Z');
  assert.equal(cc.movesThisWeek({ id: redLeague, season: 2026, my_team_id: '7', current_week: 3 }, later).state, 'stale');
});

// ---------------------------------------------------------------- the route
const app = express();
app.use((req, _res, next) => { req.auth = { userId: Number(req.get('x-test-user')) }; next(); });
app.use('/api/command-center', router);
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message ?? err) }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/command-center`;
test.after(() => server.close());

test('GET /api/command-center: the RED league yields three items, only the user\'s leagues, no cookies', async () => {
  producerOut.set(redLeague, { diff: redDiff, waivers: redWaivers });
  producerOut.set(strangersLeague, { diff: redDiff, waivers: redWaivers });
  cc.__setStreamingProducer(lg => (Number(lg.id) === redLeague ? redStreams : { suggestion: { action: 'hold', why: 'x' } }));
  cc.__setNow(() => NOW);
  tx(quietLeague, 'quiet-rival', { team: 3 }); // collected, fresh, none of them mine
  cc.__clearCache();
  const res = await fetch(base, { headers: { 'x-test-user': String(nick) } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(COOKIE), 'league cookies never leave the server');
  const body = JSON.parse(text);
  assert.deepEqual(body.leagues.map(l => l.id).sort(), [redLeague, quietLeague].sort());
  const red = body.items.filter(i => i.league.id === redLeague).map(i => i.kind).sort();
  assert.deepEqual(red, ['dead_starter', 'injury_alert', 'stream']);
  assert.ok(!body.items.some(i => i.league.id === strangersLeague));
  // Sorted by deadline across leagues.
  const known = body.items.filter(i => i.deadline).map(i => Date.parse(i.deadline));
  assert.deepEqual(known, [...known].sort((x, y) => x - y));
  // Quiet league: fresh collection, zero moves -> the nudge.
  assert.deepEqual(body.items.filter(i => i.league.id === quietLeague).map(i => i.kind), ['no_move']);
});

test('feature detection: no injury_alerts field and no streaming module read "not_merged", not "none"', async () => {
  producerOut.set(redLeague, { diff: { flagged_starters: [] }, waivers: { immediate: [] } });
  // undefined = real detection: import('./streaming-board.js') on this build.
  cc.__setStreamingProducer(undefined);
  cc.__clearCache();
  const body = await (await fetch(base, { headers: { 'x-test-user': String(nick) } })).json();
  const red = body.leagues.find(l => l.id === redLeague);
  assert.equal(red.sources.injury_alerts.state, 'not_merged');
  assert.equal(red.sources.streams.state, 'not_merged');
  assert.equal(red.sources.streams.waiting_on, 'WV-01 (PR #176)');
  assert.equal(red.sources.dead_starters.state, 'present');
  assert.equal(red.sources.dead_starters.producer, 'lineupDiff.flagged_starters');
});

test('a producer that throws marks that source "error" for that league and the rest still load', async () => {
  producerOut.set(redLeague, { diff: redDiff, waivers: redWaivers });
  cc.__setStreamingProducer(() => { throw new Error('lines table exploded'); });
  cc.__clearCache();
  const body = await (await fetch(base, { headers: { 'x-test-user': String(nick) } })).json();
  const red = body.leagues.find(l => l.id === redLeague);
  assert.equal(red.sources.streams.state, 'error');
  assert.ok(!red.sources.streams.message.includes('exploded'), 'the raw exception stays in the server log');
  assert.deepEqual(body.items.filter(i => i.league.id === redLeague).map(i => i.kind).sort(), ['dead_starter', 'injury_alert']);
});

test('empty: a user with no leagues gets no items and says why', async () => {
  cc.__clearCache();
  const body = await (await fetch(base, { headers: { 'x-test-user': String(nobody) } })).json();
  assert.deepEqual(body.items, []);
  assert.equal(body.empty_reason, 'no_leagues');
});
