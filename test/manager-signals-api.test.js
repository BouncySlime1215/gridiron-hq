/**
 * The measured manager layer, as the app serves it.
 *
 * manager-signals.js has built correct, multi-league signals since 2026-09-18 and
 * nothing in the running app read them or built them: no route exposed
 * SIGNAL_SOURCES, identityWarnings or the counterparty layer, and the only caller
 * of refreshManagerData was a script launched by hand. This covers the two routes
 * and the scheduler job that close that gap:
 *
 *  - GET  /api/trades/:leagueId/managers/signals — what has been MEASURED about
 *    each manager (as opposed to /brain/managers, which is the tier Nick typed),
 *    degrading honestly for a league with no signals and for one with no chat.
 *  - POST /api/trades/managers/rebuild — behind the administrator grant, with a
 *    per-league summary in which one failing league does not fail the call.
 *  - scheduler JOBS.manager_signals — registered, on the growth tier, and running
 *    the build in a worker thread so the event loop is free while it works.
 *
 * Guarantees, in the terms the layer itself uses:
 *  - a withheld metric (tx_accept_rate under five decided offers) never appears
 *    as if it had been measured;
 *  - every served signal carries its sample size and whether its source may
 *    price anything;
 *  - no Map or Set reaches the client as an empty object;
 *  - the honest `reason` for an unbuilt league is the sentence
 *    counterparty-pricing.js already gives, not an empty list.
 *
 * The private chat DB is never read: GRIDIRON_CHAT_DB_PATH points at a fixture
 * built below, with made-up names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-manager-api-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;
process.env.SCHEDULER_DISABLED = '1';

// ---------------------------------------------------------------- chat fixture
function negotiationProfile() {
  return {
    headline: 'Trades a lot, rarely means no.',
    says_no: { how: 'jokes first', hard_no_looks_like: ['not happening'], soft_no_looks_like: ['eh'],
      does_his_no_hold: 'rarely', evidence: ['"not happening" then traded him'] },
    praise_means: { reading: 'marketing', why: 'praises before selling', hypes_before_selling: true,
      agrees_with_numbers: 'no', evidence: ['"league winner"'] },
    techniques: [{ name: 'anchor', how_he_does_it: 'asks high', evidence: ['"need two firsts"'], how_often: 'often' }],
    calibration: { enthusiasm_scale: 'loud', baseline_tone: 'friendly', inflation: 'heavy' },
    roster_read: { really_untouchable: ['Player A'], quietly_available: [], overvalues: [], undervalues: [],
      reasoning: 'talk vs numbers' },
    what_moves_him: ['a win-now piece'],
    what_shuts_him_down: ['lowballs'],
    how_to_approach: 'Lead with a fair offer after a loss.',
    best_bait: 'Player C',
    confidence: 'medium',
    caveats: ['thin corpus'],
  };
}

function buildChatFixture(file) {
  const chat = new DatabaseSync(file);
  chat.exec(`
    CREATE TABLE manager_chat_profile(name TEXT, msgs, group_msgs, tapbacks, night_share, p_trade_talk,
      p_trash_talk, p_non_fantasy, confidence_mean, p_competitive, p_friendly, p_defensive, p_open_to_trade,
      p_reacting_to_loss, p_own_complaining, p_own_untouchable, first_msg, last_msg, computed_at);
    CREATE TABLE manager_player_sentiment(name TEXT, player TEXT, n, sentiment_mean, share_positive,
      share_negative, first_mention, last_mention, computed_at);
    CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT,
      is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
    CREATE UNIQUE INDEX messages_msg_id ON messages(msg_id);
    CREATE TABLE jev_chat_signals (msg_id INTEGER NOT NULL, name TEXT, chat_kind TEXT, mentioned_player TEXT,
      question TEXT NOT NULL, probability REAL, evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, question));
    CREATE TABLE negotiation_profiles (name TEXT PRIMARY KEY, profile_json TEXT NOT NULL, messages_read INTEGER,
      corpus_hash TEXT, model TEXT, built_at TEXT NOT NULL);
  `);
  const prof = chat.prepare(`INSERT INTO manager_chat_profile VALUES
    (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`);
  const people = [
    ['ME', 900, 600, 50, 0.2, 0.30, 0.2, 0.3, 2.5, 0.3, 0.5, 0.1, 0.30, 0.05, 0.05, 0.02],
    ['Hayden Brook', 400, 300, 20, 0.1, 0.25, 0.3, 0.2, 2.2, 0.4, 0.4, 0.1, 0.34, 0.08, 0.10, 0.05],
    ['Carl Delta', 350, 250, 15, 0.3, 0.20, 0.1, 0.4, 2.1, 0.2, 0.6, 0.1, 0.20, 0.04, 0.04, 0.02],
  ];
  for (const p of people) prof.run(...p, '2026-01-01', '2026-09-17');
  chat.prepare(`INSERT INTO manager_player_sentiment VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
    .run('Hayden Brook', 'Player A', 6, 3.4, 0.9, 0.0, '2026-08-01', '2026-09-17');
  const np = chat.prepare(`INSERT INTO negotiation_profiles VALUES (?,?,?,?,?,?)`);
  np.run('Hayden Brook', JSON.stringify(negotiationProfile()), 120, 'h1', 'claude-sonnet-5', '2026-09-18 05:00:00');
  chat.close();
}
buildChatFixture(CHAT_PATH);

// ------------------------------------------------------------------ app setup
const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
await import('../server/services/manager-archetypes.js'); // the real manager_archetypes DDL
const signals = await import('../server/services/manager-signals.js');
const { SIGNAL_SOURCES } = signals;
const { JOBS, refreshManagerSignalsOffThread } = await import('../server/services/scheduler.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');

await runMigrations();
seedIfEmpty();
// Same DDL scripts/collect-league-transactions.mjs creates on the real database.
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
// Same DDL migration 064_league_history_tables creates; it is the roster ->
// ESPN member map the archetype store is keyed by.
db.exec(`CREATE TABLE IF NOT EXISTS league_season_teams (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, roster_id TEXT NOT NULL,
  team_name TEXT, owner_name TEXT, espn_member_id TEXT,
  wins INTEGER, losses INTEGER, ties INTEGER, points_for REAL, points_against REAL,
  final_rank INTEGER, playoff_seed INTEGER, captured_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, roster_id))`);

// The one session every request uses, and the administrator grant that the
// rebuild route needs on top of it (migration 007's model:* permission).
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (7701, 'manager-api-user', 'Reader')`);
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (7702, 'manager-api-admin', 'Admin')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (7701, ?, datetime('now','+1 day'))`, hashSessionToken('reader-token'));
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (7702, ?, datetime('now','+1 day'))`, hashSessionToken('admin-token'));
run(`INSERT OR IGNORE INTO model_permissions(user_id, permission) VALUES (7702, 'model:*')`);

// Mounted exactly as server/index.js:103 mounts it — a bearer session and nothing
// more — so the admin gate under test is the route's own, not the mount's.
const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
const server = app.listen(0);
const port = server.address().port;

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const call = async (method, url, { token = 'reader-token', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// ------------------------------------------------------------ league fixtures
const NICK = '{NICK-0000}';
const AIDEN = '{AIDEN-0000}';
const CARL = '{CARL-0000}';
const GUS = '{GUS-0000}';
const member = (id, firstName, lastName) => ({ id, firstName, lastName, displayName: `${firstName}${lastName}` });
const rosterEntry = (id, name, { slot = 0, acq = 'DRAFT', injury = 'ACTIVE' } = {}) => ({
  lineupSlotId: slot, acquisitionType: acq,
  playerPoolEntry: { player: { id, fullName: name, injuryStatus: injury, defaultPositionId: 3 } },
});
const team = (id, owner, { wins = 0, losses = 0, pf = 0, streak = ['WIN', 0], entries = [] } = {}) => ({
  id, name: `Team ${id}`, owners: [owner], currentProjectedRank: id, draftDayProjectedRank: id,
  record: { overall: { wins, losses, ties: 0, pointsFor: pf, pointsAgainst: 0,
    streakType: streak[0], streakLength: streak[1] } },
  roster: { entries },
});
function insertLeague(id, payload, { myTeamId = '1', name = `L${id}` } = {}) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, ?, ?, ?, ?, ?, 'secret-s2', 'secret-swid', 'connected')`,
  id, `espn-api-${id}`, name, payload == null ? null : JSON.stringify(payload),
  payload?.teams?.length ?? 0, myTeamId, JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
}

// League 21: no chat corpus — four of Nick's five leagues look like this.
insertLeague(21, {
  members: [member(NICK, 'Nick', 'Matta'), member(AIDEN, 'Aiden', 'Stone'),
    member(CARL, 'Carl', 'Delta'), member(GUS, 'Gus', 'Hill')],
  teams: [
    team(1, NICK, { wins: 1, losses: 0, pf: 120, streak: ['WIN', 1], entries: [
      rosterEntry(601, 'Q One'), rosterEntry(602, 'R Two', { slot: 20, acq: 'ADD' }),
      rosterEntry(603, 'W Three', { slot: 2, injury: 'OUT' })] }),
    team(2, AIDEN, { wins: 0, losses: 1, pf: 100, streak: ['LOSS', 1], entries: [rosterEntry(611, 'W Four')] }),
    team(3, CARL, { wins: 1, losses: 0, pf: 130, streak: ['WIN', 1], entries: [rosterEntry(621, 'W Five')] }),
    team(4, GUS, { wins: 0, losses: 1, pf: 90, streak: ['LOSS', 1], entries: [rosterEntry(631, 'W Six')] }),
  ],
  schedule: [
    { matchupPeriodId: 1, home: { teamId: 1, totalPoints: 120 }, away: { teamId: 2, totalPoints: 100 }, winner: 'HOME' },
    { matchupPeriodId: 1, home: { teamId: 3, totalPoints: 130 }, away: { teamId: 4, totalPoints: 90 }, winner: 'HOME' },
  ],
}, { name: 'No Chat League' });

// League 22: the chat league. Roster 2 is confirmed as "Hayden Brook" by hand;
// roster 3's name match is only `likely`, which is a warning, not a corpus.
insertLeague(22, {
  members: [member(NICK, 'Nick', 'Matta'), member(AIDEN, 'Aiden', 'Stone'), member(CARL, 'Carla', 'Delta')],
  teams: [
    team(1, NICK, { entries: [rosterEntry(501, 'Player C')] }),
    team(2, AIDEN, { entries: [rosterEntry(502, 'Player A')] }),
    team(3, CARL, { entries: [rosterEntry(503, 'Player D')] }),
  ],
  schedule: [],
}, { name: 'Chat League' });
run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name, chat_name,
       match_method, confidence) VALUES
     (22, '1', ?, 'Nick Matta', 'Team 1', 'ME', 'confirmed by Nick', 'confirmed'),
     (22, '2', ?, 'Aiden Stone', 'Team 2', 'Hayden Brook', 'confirmed by Nick', 'confirmed'),
     (22, '3', ?, 'Carla Delta', 'Team 3', 'Carl Delta', 'last name + first-name prefix', 'likely')`,
NICK, AIDEN, CARL);

// League 23: synced, but its signals have never been built — the state every
// league on the deployed machine was in until these routes existed.
insertLeague(23, {
  members: [member(NICK, 'Nick', 'Matta'), member(GUS, 'Gus', 'Hill')],
  teams: [team(1, NICK, { entries: [rosterEntry(701, 'Z One')] }), team(2, GUS, { entries: [rosterEntry(702, 'Z Two')] })],
  schedule: [],
}, { name: 'Never Built League' });

// League 24: connected but never synced.
insertLeague(24, null, { name: 'Unsynced League' });

// Both fixture accounts belong to every fixture league. `league()` in trades.js is
// the one place a league-scoped route resolves its league, and it asks whether the
// caller is a member of it — so a session alone is not enough to read one, which is
// the point. `league_memberships` has existed since migration 006, so this seeds on
// this branch's own base too, where it is simply unread.
// League 999 is deliberately absent: it does not exist, and the 404 case needs the
// lookup to miss rather than the membership check to refuse.
for (const id of [21, 22, 23, 24]) {
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 7701, 'member')`, id);
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 7702, 'commissioner')`, id);
}

// Transactions in ESPN's real shape (manager-signals.js documents the
// de-duplication): roster 2 answers six offers, roster 4 answers two. Five
// decided offers is the bar for tx_accept_rate, so 2 clears it and 4 does not.
function tx(id, type, execution, status, teamId, related = null, items = []) {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at,
         team_id, related_tx_id, items_json, first_seen_at, last_seen_at)
       VALUES (21, 2026, ?, ?, ?, ?, '2026-09-10T00:00:00Z', ?, ?, ?, datetime('now'), datetime('now'))`,
  id, type, status, execution, teamId, related, JSON.stringify(items));
}
const swap = (a, b) => [{ fromTeamId: a, toTeamId: b }, { fromTeamId: b, toTeamId: a }];
for (let i = 1; i <= 6; i++) {
  tx(`o${i}`, 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 1, null, swap(1, 2));
  tx(`o${i}-ans`, i <= 2 ? 'TRADE_ACCEPT' : 'TRADE_DECLINE', 'EXECUTE', 'EXECUTED', 2, `o${i}`);
  if (i <= 2) tx(`o${i}-proc`, 'TRADE_ACCEPT', 'PROCESS', 'EXECUTED', 1, `o${i}`);
}
tx('g1', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 3, null, swap(3, 4));
tx('g1-ans', 'TRADE_ACCEPT', 'EXECUTE', 'EXECUTED', 4, 'g1');
tx('g2', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 3, null, swap(3, 4));
tx('g2-ans', 'TRADE_DECLINE', 'EXECUTE', 'EXECUTED', 4, 'g2');

// One archetype row per source, this league-season: `draft` is declared
// non-priceable (no draft metric survived the repeatability test) and `outcome`
// priceable, which is what the route has to report per signal.
const arch = (memberId, metric, value, n, source) => run(`INSERT INTO manager_archetypes
  (member_id, league_id, season, metric, value, label, n, source, version, computed_at)
  VALUES (?, 21, 2026, ?, ?, NULL, ?, ?, 'manager-archetypes-v1', '2026-09-18T01:38:39.383Z')`,
memberId, metric, value, n, source);
arch(AIDEN, 'auto_draft_rate', 0.25, 16, 'draft');
arch(AIDEN, 'luck_wins', 0.6, 3, 'outcome');
// The roster/member map archetypesFor joins on, for the `archetype` block.
run(`INSERT INTO league_season_teams (league_id, season, roster_id, espn_member_id, owner_name, team_name, captured_at)
     VALUES (21, 2026, '2', ?, 'Aiden Stone', 'Team 2', datetime('now'))`, AIDEN);
run(`INSERT INTO manager_archetypes (member_id, league_id, season, metric, value, label, n, source, version, computed_at)
     VALUES (?, 0, 0, 'seasons_observed', 4, NULL, 4, 'career', 'manager-archetypes-v1', '2026-09-18T01:38:39.383Z')`,
AIDEN);

// Nick's hand-set tier for one manager, so `tradeability_set` has both states.
run(`INSERT INTO manager_profiles (league_id, roster_id, owner, tradeability, notes)
     VALUES (21, '4', 'Gus Hill', 'hard', 'wants a first for everyone')`);

// Build the two leagues the read tests read. 23 is deliberately left unbuilt.
const built = signals.refreshManagerData({ leagueIds: [21, 22] });
assert.equal(built.status, 'ok', JSON.stringify(built.leagues));

const managerOf = (payload, rosterId) => payload.managers.find(m => m.roster_id === String(rosterId));
const metricOf = (manager, metric) => manager.signals.find(s => s.metric === metric) ?? null;

/**
 * A Map or a Set that reaches res.json() serialises as `{}` with a 200 — the bug
 * this payload is most exposed to, because counterpartyLayer hands back Maps of
 * Maps and a Set of owned players. So: every empty object in the response, minus
 * the few keyed collections that are genuinely empty here (a manager Nick wrote
 * no prior about, a metric with no label, an archetype with no Jev answers).
 * Anything else empty is data that lost its contents on the way out.
 */
const LEGITIMATELY_EMPTY = new Set(['priors', 'jev', 'labels', 'metrics', 'samples', 'sources']);
function emptyObjects(value, at = '$', found = []) {
  if (Array.isArray(value)) value.forEach((v, i) => emptyObjects(v, `${at}[${i}]`, found));
  else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length && !LEGITIMATELY_EMPTY.has(at.split('.').at(-1))) found.push(at);
    for (const k of keys) emptyObjects(value[k], `${at}.${k}`, found);
  }
  return found;
}

// ============================================================== the read route
test('read: a league with signals serves every manager, each signal with its sample and its source', async () => {
  const { status, body } = await call('GET', '/api/trades/21/managers/signals');
  assert.equal(status, 200);
  assert.deepEqual(body.league, { id: 21, name: 'No Chat League', season: 2026, week: body.league.week });
  assert.equal(body.available, true);
  assert.equal(body.reason, null);
  assert.ok(body.computed_at, 'computed_at is the stamp the build wrote');
  // SIGNAL_SOURCES as-is: the contract every row names.
  assert.deepEqual(body.sources, JSON.parse(JSON.stringify(SIGNAL_SOURCES)));
  assert.equal(body.managers.length, 4, 'every roster in the synced payload appears');
  assert.deepEqual(body.managers.map(m => m.owner),
    ['Nick Matta', 'Aiden Stone', 'Carl Delta', 'Gus Hill']);

  const two = managerOf(body, 2);
  assert.ok(two.signals.length > 5);
  for (const s of two.signals) {
    assert.ok(SIGNAL_SOURCES[s.source], `${s.metric} names an undeclared source ${s.source}`);
    assert.equal(s.priceable, SIGNAL_SOURCES[s.source].priceable);
    assert.ok(typeof s.why === 'string' && s.why.length > 0);
    assert.ok(Number.isFinite(s.value), `${s.metric} has no value`);
  }
  // Sample sizes are the point of the layer: a record from one game and one from
  // sixty must not look alike.
  assert.deepEqual(metricOf(two, 'standing_losses'), {
    metric: 'standing_losses', value: 1, n: 1, source: 'standings', priceable: true,
    why: `${SIGNAL_SOURCES.standings.label}; refreshed ${SIGNAL_SOURCES.standings.refreshed}`,
  });
  // The one declared source that may never price anything says so per signal.
  const draft = metricOf(two, 'draft_auto_rate');
  assert.equal(draft.source, 'draft');
  assert.equal(draft.priceable, false);
  assert.match(draft.why, /context only, never priced/);
  assert.equal(metricOf(two, 'outcome_luck_wins').priceable, true);
});

test('read: nothing in the payload is a Map or a Set, so nothing arrives as an empty object', async () => {
  const { body } = await call('GET', '/api/trades/21/managers/signals');
  const two = managerOf(body, 2);
  assert.ok(two.receptiveness, 'the receptiveness layer is served, not a Map');
  assert.equal(typeof two.receptiveness.value, 'number');
  assert.ok(Array.isArray(two.receptiveness.factors));
  assert.deepEqual(two.receptiveness.range, [0.7, 1.3]);
  assert.ok(two.archetype, 'the archetype block is a plain object');
  assert.equal(two.archetype.member_id, AIDEN);
  // Both of these are read out of Maps and must arrive with their contents.
  assert.equal(two.archetype.this_season.metrics.auto_draft_rate, 0.25);
  assert.ok(two.receptiveness.factors.some(f => f.source === 'observed_accept_rate'));
  assert.deepEqual(emptyObjects(body), [], 'an empty object here is a Map or a Set that lost its contents');
});

test('read: the hand-set tier is reported as set or unset, never defaulted to "fair"', async () => {
  const { body } = await call('GET', '/api/trades/21/managers/signals');
  assert.equal(managerOf(body, 4).tradeability_set, 'hard');
  assert.equal(managerOf(body, 2).tradeability_set, null, 'unset must not read as a judgement');
});

test('read: a metric withheld for sample size never appears as if it had been measured', async () => {
  const { body } = await call('GET', '/api/trades/21/managers/signals');
  const six = managerOf(body, 2);       // six decided offers — over the bar
  const twoDecided = managerOf(body, 4); // two decided offers — withheld
  assert.equal(metricOf(six, 'tx_decisions_made').value, 6);
  assert.deepEqual(metricOf(six, 'tx_accept_rate'), {
    metric: 'tx_accept_rate', value: 2 / 6, n: 6, source: 'tx', priceable: true,
    why: `${SIGNAL_SOURCES.tx.label}; refreshed ${SIGNAL_SOURCES.tx.refreshed}`,
  });
  assert.equal(metricOf(twoDecided, 'tx_decisions_made').value, 2);
  assert.equal(metricOf(twoDecided, 'tx_accept_rate'), null,
    'an acceptance rate from two decisions is withheld by the build and must not be served');
  assert.ok(!JSON.stringify(body).includes('"tx_accept_rate"')
    || body.managers.every(m => (metricOf(m, 'tx_accept_rate')?.n ?? 5) >= 5),
  'no served accept rate rests on fewer than five decided offers');
});

test('read: chat is attributed only to a trusted identity, and the untrusted match is a warning', async () => {
  const { status, body } = await call('GET', '/api/trades/22/managers/signals');
  assert.equal(status, 200);
  assert.equal(body.available, true);
  const confirmed = managerOf(body, 2);
  const likely = managerOf(body, 3);
  assert.equal(confirmed.corpus, true);
  assert.equal(likely.corpus, false, 'a "likely" name match is not a chat corpus');
  assert.ok(metricOf(confirmed, 'chat_msgs'), 'the confirmed identity gets chat signals');
  assert.equal(metricOf(likely, 'chat_msgs'), null);
  assert.equal(metricOf(confirmed, 'chat_open_to_trade').source, 'chat');
  // Nick's reads travel as priors with a deliberately small sample, not as facts.
  for (const s of confirmed.signals.filter(s => s.source === 'nick')) assert.equal(s.n, 3);
  assert.ok(body.identity_warnings.some(w => w.roster_id === '3' && w.confidence === 'likely'),
    'the untrusted match is surfaced for a human rather than used silently');
  assert.ok(confirmed.negotiation, 'the validated negotiation profile is served with the corpus it was read from');
  assert.equal(confirmed.negotiation.messages_read, 120);
  assert.equal(confirmed.negotiation.profile.confidence, 'medium');
  assert.equal(likely.negotiation, null);
});

test('read: a league whose signals have never been built says so, in the layer\'s own words', async () => {
  const { status, body } = await call('GET', '/api/trades/23/managers/signals');
  assert.equal(status, 200);
  assert.equal(body.available, false);
  assert.equal(body.reason,
    'no manager signals for this league yet — scripts/build-manager-signals.mjs has not built it');
  assert.equal(body.computed_at, null);
  // Not an empty page: the rosters are still named, with nothing measured on them.
  assert.equal(body.managers.length, 2);
  for (const m of body.managers) {
    assert.deepEqual(m.signals, []);
    assert.equal(m.receptiveness, null);
    assert.equal(m.corpus, false);
  }
});

test('read: an unsynced league is a 400, and an unknown one a 404', async () => {
  assert.equal((await call('GET', '/api/trades/24/managers/signals')).status, 400);
  assert.equal((await call('GET', '/api/trades/999/managers/signals')).status, 404);
});

test('read: never echoes a league credential', async () => {
  const { body } = await call('GET', '/api/trades/22/managers/signals');
  const text = JSON.stringify(body);
  assert.ok(!text.includes('secret-s2') && !text.includes('secret-swid'));
});

// =========================================================== the rebuild route
test('rebuild: a bearer session is not enough — it needs the administrator grant', async () => {
  assert.equal((await call('POST', '/api/trades/managers/rebuild', { token: null, body: {} })).status, 401);
  assert.equal((await call('POST', '/api/trades/managers/rebuild', { body: {} })).status, 403);
  const ok = await call('POST', '/api/trades/managers/rebuild', { token: 'admin-token', body: { league_ids: [21] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.requested, [21]);
  assert.deepEqual(ok.body.leagues.map(l => l.league_id), [21], 'league_ids narrows the run');
});

test('rebuild: the per-league summary says built, skipped or failed — and one failure fails no other league', async () => {
  // The rollup drops and recreates manager_chat_profile outside a transaction, so
  // a crash between the two leaves the chat league unbuildable. That must not
  // touch the four leagues that never had a chat.
  const midroll = path.join(temp, 'midroll.sqlite');
  fs.copyFileSync(CHAT_PATH, midroll);
  const c = new DatabaseSync(midroll); c.exec('DROP TABLE manager_chat_profile'); c.close();
  const chatRowsBefore = rows(`SELECT COUNT(*) AS n FROM manager_signals WHERE league_id = 22`)[0].n;
  assert.ok(chatRowsBefore > 0);

  const saved = process.env.GRIDIRON_CHAT_DB_PATH;
  process.env.GRIDIRON_CHAT_DB_PATH = midroll;
  let out;
  try { out = await call('POST', '/api/trades/managers/rebuild', { token: 'admin-token', body: {} }); }
  finally { process.env.GRIDIRON_CHAT_DB_PATH = saved; }

  assert.equal(out.status, 200, 'a failing league must not fail the call');
  assert.equal(out.body.status, 'error', 'the run reports itself honestly');
  const byId = new Map(out.body.leagues.map(l => [l.league_id, l]));
  assert.deepEqual([...byId.keys()].sort((a, b) => a - b), [21, 22, 23, 24]);

  assert.match(byId.get(22).error, /manager_chat_profile/);
  assert.equal(byId.get(22).chat_corpus, true);
  assert.equal(rows(`SELECT COUNT(*) AS n FROM manager_signals WHERE league_id = 22`)[0].n, chatRowsBefore,
    'a league that failed keeps the rows it had rather than being silently stripped');

  assert.equal(byId.get(21).error, null);
  assert.equal(byId.get(21).chat_corpus, false);
  assert.equal(byId.get(21).unchanged, true, 'nothing changed since the build above');
  assert.ok(byId.get(21).signals > 0);
  assert.ok(byId.get(21).rosters_with_signals > 0);
  assert.equal(byId.get(21).by_source.tx > 0, true);

  assert.equal(byId.get(23).error, null);
  assert.equal(byId.get(23).unchanged, false, 'the league nothing had built now builds');
  assert.ok(byId.get(23).signals > 0);

  assert.equal(byId.get(24).skipped, 'league not synced');
  assert.equal(byId.get(24).signals, 0);
});

test('rebuild: calling it again changes nothing, and a bad league_ids is a 400', async () => {
  const again = await call('POST', '/api/trades/managers/rebuild', { token: 'admin-token', body: {} });
  assert.equal(again.status, 200);
  for (const l of again.body.leagues.filter(l => !l.skipped)) {
    assert.equal(l.error, null);
    assert.equal(l.unchanged, true, `league ${l.league_id} was rewritten by an idle re-run`);
  }
  assert.equal((await call('POST', '/api/trades/managers/rebuild',
    { token: 'admin-token', body: { league_ids: 21 } })).status, 400);
  assert.equal((await call('POST', '/api/trades/managers/rebuild',
    { token: 'admin-token', body: { league_ids: [] } })).status, 400);
});

// ============================================================ the scheduler job
test('scheduler: the build is a registered job on the growth tier, not behind AUTO_HEAVY_SYNC', () => {
  const job = JOBS.manager_signals;
  assert.ok(job, 'nothing in the app builds the layer unless this job exists');
  // 'heavy' is gated on AUTO_HEAVY_SYNC; 'live' is the short tick for feeds that
  // move by the minute. This reads the database league_rosters already wrote.
  assert.equal(job.tier, 'growth');
  assert.equal(job.maxAgeMinutes, 60);
  assert.ok(JOBS.manager_archetypes, 'the draft/outcome half must be runnable by name too');
  assert.equal(JOBS.manager_archetypes.tier, 'heavy');
});

test('scheduler: the build runs in a worker thread, so the event loop is free while it works', async () => {
  const ticks = [];
  const heartbeat = setInterval(() => ticks.push(Date.now()), 5);
  let out;
  try { out = await refreshManagerSignalsOffThread({ leagueIds: [21] }); }
  finally { clearInterval(heartbeat); }
  assert.ok(ticks.length > 0,
    'the main thread served nothing while the build ran — it is not off-thread');
  // The leagueIds option exists on refreshManagerData and no caller had ever
  // used it; the job and the route are the first two.
  assert.deepEqual(out.leagues.map(l => l.league_id), [21]);
  assert.equal(out.status, 'ok');
  assert.equal(out.leagues[0].unchanged, true);
});

test('scheduler: the refresh loop can run the archetype build by name', async () => {
  const loop = await import('../scripts/refresh-live-data.mjs');
  assert.ok(loop.FANTASY_LIVE_JOBS.includes('manager_archetypes'),
    'the archetype build was in no allowlist at all, so draft/outcome never appeared');
  for (const name of loop.FANTASY_LIVE_JOBS) assert.ok(JOBS[name], `${name} is a registered scheduler job`);
  assert.ok(loop.FANTASY_LIVE_JOBS.indexOf('manager_archetypes') > -1);
});
