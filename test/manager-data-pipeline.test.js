/**
 * manager-data-pipeline: who each manager is, what we know about him, and how
 * that reaches the trade finder — for all five leagues, not only the one with a
 * group chat.
 *
 * Guarantees (docs/tdd/manager-data-pipeline.tdd.md):
 *  - identities: every ESPN team gets a row; Nick's hand confirmations survive a
 *    re-run; leagues without a chat corpus never get a chat name; nothing is
 *    rewritten when nothing changed.
 *  - signals: every roster in every league gets labelled signals; chat and
 *    Nick's priors only where a trusted identity exists; transaction counts
 *    credit the manager who actually decided; draft/outcome come from the
 *    archetype store for this league-season only; a re-run with no new data
 *    writes nothing.
 *  - pricing: the "hard" tier is applied once (by the trade engine), perception
 *    is neutral when nothing is known about a player, negotiation profiles load
 *    through one validated reader, the dead untouchablesFor is gone.
 *  - bluff: credibility is cached against the chat data and invalidated by it.
 *  - script: one run over every league, idempotent, with a sync_log row.
 *
 * The private chat DB is never read here: GRIDIRON_CHAT_DB_PATH points at a
 * fixture built below, with made-up names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-manager-data-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;
process.env.SCHEDULER_DISABLED = '1';

// ---------------------------------------------------------------- chat fixture
function validProfile(overrides = {}) {
  return {
    headline: 'Trades a lot, rarely means no.',
    says_no: { how: 'jokes first', hard_no_looks_like: ['not happening'], soft_no_looks_like: ['eh'],
      does_his_no_hold: 'rarely', evidence: ['"not happening" then traded him'] },
    praise_means: { reading: 'marketing', why: 'praises before selling', hypes_before_selling: true,
      agrees_with_numbers: 'no', evidence: ['"league winner"'] },
    techniques: [{ name: 'anchor', how_he_does_it: 'asks high', evidence: ['"need two firsts"'], how_often: 'often' }],
    calibration: { enthusiasm_scale: 'loud', baseline_tone: 'friendly', inflation: 'heavy' },
    roster_read: { really_untouchable: ['Player A'], quietly_available: ['Player B'], overvalues: [], undervalues: [],
      reasoning: 'talk vs numbers' },
    what_moves_him: ['a win-now piece'],
    what_shuts_him_down: ['lowballs'],
    how_to_approach: 'Lead with a fair offer after a loss.',
    best_bait: 'Player C',
    confidence: 'medium',
    caveats: ['thin corpus'],
    ...overrides,
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
    ['Jake Stone', 300, 200, 10, 0.1, 0.10, 0.2, 0.5, 2.0, 0.2, 0.5, 0.1, 0.13, 0.02, 0.03, 0.01],
    ['Carl Delta', 350, 250, 15, 0.3, 0.20, 0.1, 0.4, 2.1, 0.2, 0.6, 0.1, 0.20, 0.04, 0.04, 0.02],
    ['Danny Echo', 200, 150, 5, 0.2, 0.15, 0.1, 0.4, 2.0, 0.1, 0.7, 0.1, 0.15, 0.03, 0.02, 0.01],
  ];
  for (const p of people) prof.run(...p, '2026-01-01', '2026-09-17');
  const sent = chat.prepare(`INSERT INTO manager_player_sentiment VALUES (?,?,?,?,?,?,?,?,datetime('now'))`);
  sent.run('Hayden Brook', 'Player A', 6, 3.4, 0.9, 0.0, '2026-08-01', new Date().toISOString().slice(0, 10));
  sent.run('Danny Echo', 'Player B', 4, 1.0, 0.0, 0.8, '2026-08-01', '2026-09-10');
  const msg = chat.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,0,0)`);
  const sig = chat.prepare(`INSERT INTO jev_chat_signals VALUES (?,?,?,?,?,?,?)`);
  // Danny declares Player B untouchable, then opens the door two days later.
  msg.run(1, 'group', 'League', 'h1', 'Danny Echo', 0, '2026-09-01T12:00:00Z', 'not moving him');
  sig.run(1, 'Danny Echo', 'group', 'Player B', 'own_roster.untouchable', 0.9, '2026-09-02');
  msg.run(2, 'group', 'League', 'h1', 'Danny Echo', 0, '2026-09-03T12:00:00Z', 'ok make me an offer');
  sig.run(2, 'Danny Echo', 'group', 'Player B', 'open_to_trade', 0.9, '2026-09-04');
  // Hayden declares Player A untouchable and it holds.
  msg.run(3, 'group', 'League', 'h2', 'Hayden Brook', 0, '2026-09-05T12:00:00Z', 'Player A is a league winner');
  sig.run(3, 'Hayden Brook', 'group', 'Player A', 'own_roster.untouchable', 0.95, '2026-09-06');
  const np = chat.prepare(`INSERT INTO negotiation_profiles VALUES (?,?,?,?,?,?)`);
  np.run('Hayden Brook', JSON.stringify(validProfile()), 120, 'h1', 'claude-sonnet-5', '2026-09-18 05:00:00');
  np.run('ME', JSON.stringify(validProfile({ headline: 'Sends a lot of offers.' })), 300, 'h2', 'claude-sonnet-5', '2026-09-18 05:50:00');
  np.run('Danny Echo', JSON.stringify(validProfile()), 80, 'h3', 'claude-sonnet-5', '2026-09-18 05:10:00');
  // The failure the builder script documented on 2026-09-18: tool-call markup
  // leaked into a string, so a nested section arrived as a string.
  np.run('Carl Delta', JSON.stringify(validProfile({ says_no: '\n<parameter name="how">He rejects' })), 90, 'h4',
    'claude-sonnet-5', '2026-09-18 05:20:00');
  chat.close();
}
buildChatFixture(CHAT_PATH);

// ------------------------------------------------------------------ app setup
const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
await import('../server/services/manager-archetypes.js'); // the real manager_archetypes DDL
const identity = await import('../server/services/manager-identity.js');
const signals = await import('../server/services/manager-signals.js');
const pricing = await import('../server/services/counterparty-pricing.js');
const bluff = await import('../server/services/bluff-detector.js');
const { findTrades } = await import('../server/services/trade-engine.js');

await runMigrations();
seedIfEmpty();
// Same DDL scripts/collect-league-transactions.mjs creates on the real DB.
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// ------------------------------------------------------------ league fixtures
const NICK = '{NICK-0000}';
const AIDEN = '{AIDEN-0000}';
function member(id, firstName, lastName) { return { id, firstName, lastName, displayName: `${firstName}${lastName}` }; }
function rosterEntry(id, name, { slot = 0, acq = 'DRAFT', injury = 'ACTIVE' } = {}) {
  return { lineupSlotId: slot, acquisitionType: acq,
    playerPoolEntry: { player: { id, fullName: name, injuryStatus: injury, defaultPositionId: 3 } } };
}
function team(id, owner, { wins = 0, losses = 0, pf = 0, streak = ['WIN', 0], entries = [] } = {}) {
  return {
    id, name: `Team ${id}`, owners: [owner], currentProjectedRank: id, draftDayProjectedRank: id,
    record: { overall: { wins, losses, ties: 0, pointsFor: pf, pointsAgainst: 0,
      streakType: streak[0], streakLength: streak[1] } },
    roster: { entries },
  };
}
function insertLeague(id, payload, { myTeamId = '1', name = `L${id}` } = {}) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, ?, ?, ?, ?, ?, 'secret-s2', 'secret-swid', 'connected')`,
  id, `espn-md-${id}`, name, payload == null ? null : JSON.stringify(payload),
  payload?.teams?.length ?? 0, myTeamId, JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
}

// League 11: the chat league. Roster 2 is the real-world trap in miniature —
// ESPN says "Aiden Stone", a chat name "Jake Stone" shares the surname, and
// Nick confirmed he is "Hayden Brook".
insertLeague(11, {
  members: [member(NICK, 'Nick', 'Matta'), member(AIDEN, 'Aiden', 'Stone'),
    member('{CARL}', 'Carl', 'Delta'), member('{DAN}', 'Dan', 'Echo')],
  teams: [
    team(1, NICK, { entries: [rosterEntry(501, 'Player C')] }),
    team(2, AIDEN, { entries: [rosterEntry(502, 'Player A')] }),
    team(3, '{CARL}', { entries: [rosterEntry(503, 'Player D')] }),
    team(4, '{DAN}', { entries: [rosterEntry(504, 'Player B')] }),
  ],
  schedule: [],
});
run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name, chat_name,
       match_method, confidence) VALUES
     (11, '1', ?, 'Nick Matta', 'Team 1', 'ME', 'confirmed by Nick', 'confirmed'),
     (11, '2', ?, 'Aiden Stone', 'Team 2', 'Hayden Brook', 'confirmed by Nick', 'confirmed')`, NICK, AIDEN);
const CHAT_NAMES = ['ME', 'Hayden Brook', 'Jake Stone', 'Carl Delta', 'Danny Echo'];

// League 12: no chat corpus. Nick and Aiden are the same ESPN members as in 11.
insertLeague(12, {
  scoringPeriodId: 2, // period 1 decided, period 2 in progress (see schedule)
  members: [member(NICK, 'Nick', 'Matta'), member(AIDEN, 'Aiden', 'Stone'),
    member('{EVE}', 'Eve', 'Fox'), member('{GUS}', 'Gus', 'Hill')],
  teams: [
    team(1, NICK, { wins: 1, losses: 0, pf: 120, streak: ['WIN', 1], entries: [
      rosterEntry(601, 'Q One', { slot: 0 }), rosterEntry(602, 'R Two', { slot: 20, acq: 'ADD' }),
      rosterEntry(603, 'W Three', { slot: 2, injury: 'OUT' })] }),
    team(2, AIDEN, { wins: 0, losses: 1, pf: 100, streak: ['LOSS', 1], entries: [rosterEntry(611, 'W Four')] }),
    team(3, '{EVE}', { wins: 1, losses: 0, pf: 130, streak: ['WIN', 1], entries: [rosterEntry(621, 'W Five')] }),
    team(4, '{GUS}', { wins: 0, losses: 1, pf: 90, streak: ['LOSS', 1], entries: [rosterEntry(631, 'W Six')] }),
  ],
  schedule: [
    { matchupPeriodId: 1, home: { teamId: 1, totalPoints: 120 }, away: { teamId: 2, totalPoints: 100 }, winner: 'HOME' },
    { matchupPeriodId: 1, home: { teamId: 3, totalPoints: 130 }, away: { teamId: 4, totalPoints: 90 }, winner: 'HOME' },
    { matchupPeriodId: 2, home: { teamId: 1, totalPoints: 0 }, away: { teamId: 3, totalPoints: 0 }, winner: 'UNDECIDED' },
  ],
});

// Transactions shaped exactly like ESPN's (verified on league_transactions_raw):
// an accepted trade leaves an EXECUTE accept under the RESPONDER and a PROCESS
// accept under the PROPOSER; a proposal's close-out is a TRADE_PROPOSAL/CANCEL
// record under the proposer; waiver claims leave CANCEL and FAILED rows too.
function tx(id, type, execution, status, teamId, related = null, items = [], period = 1) {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at,
         team_id, related_tx_id, scoring_period, items_json, first_seen_at, last_seen_at)
       VALUES (12, 2026, ?, ?, ?, ?, '2026-09-10T00:00:00Z', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  id, type, status, execution, teamId, related, period, JSON.stringify(items));
}
// An executed claim carries the ADD (and usually a DROP) item, as ESPN writes it.
const pickup = teamId => [{ type: 'ADD', fromTeamId: 0, toTeamId: teamId }, { type: 'DROP', fromTeamId: teamId, toTeamId: 0 }];
const swap = (a, b) => [{ fromTeamId: a, toTeamId: b }, { fromTeamId: b, toTeamId: a }];
tx('p1', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 1, null, swap(1, 2));
tx('p1-acc', 'TRADE_ACCEPT', 'EXECUTE', null, 2, 'p1');
tx('p1-proc', 'TRADE_ACCEPT', 'PROCESS', 'EXECUTED', 1, 'p1');
tx('p1-veto', 'TRADE_VETO', 'EXECUTE', 'EXECUTED', 4, 'p1');
for (let i = 2; i <= 5; i++) {
  tx(`p${i}`, 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 3, null, swap(3, 2));
  tx(`p${i}-dec`, 'TRADE_DECLINE', 'EXECUTE', 'EXECUTED', 2, `p${i}`);
  tx(`p${i}-close`, 'TRADE_PROPOSAL', 'CANCEL', 'CANCELED', 3, `p${i}`);
}
tx('p6', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 3, null, swap(3, 2));
tx('p6-acc', 'TRADE_ACCEPT', 'EXECUTE', null, 2, 'p6');
tx('p6-proc', 'TRADE_ACCEPT', 'PROCESS', 'EXECUTED', 3, 'p6');
tx('p7', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 3, null, swap(3, 4));
tx('p7-withdrawn', 'TRADE_PROPOSAL', 'CANCEL', 'CANCELED', 3, 'p7');
tx('w1', 'WAIVER', 'PROCESS', 'EXECUTED', 4, null, pickup(4));
tx('w2', 'WAIVER', 'CANCEL', 'CANCELED', 4, null, pickup(4));
tx('w3', 'WAIVER', 'PROCESS', 'FAILED_INVALIDPLAYERSOURCE', 4, null, pickup(4));
tx('f1', 'FREEAGENT', 'EXECUTE', 'EXECUTED', 4, null, pickup(4));

// Archetype rows: this league-season, plus a career row and another league's
// row for the same person, neither of which may leak into league 12.
const ARCH_BUILT_EARLY = '2026-09-18T01:38:39.383Z';
// The NEWEST row in league 12's store, and deliberately a metric ARCHETYPE_METRICS
// does not map. The reported build date must be this one: it is when the build
// last wrote, and which metrics one consumer happens to copy is not a fact about
// the store's age.
const ARCH_BUILT_AT = '2026-09-18T05:00:00.000Z';
const arch = (league, season, metric, value, n, source, builtAt = ARCH_BUILT_EARLY) =>
  run(`INSERT INTO manager_archetypes
  (member_id, league_id, season, metric, value, label, n, source, version, computed_at)
  VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'manager-archetypes-v1', ?)`,
  AIDEN, league, season, metric, value, n, source, builtAt);
arch(12, 2026, 'auto_draft_rate', 0, 16, 'draft');
arch(12, 2026, 'reach_rate', 0.25, 16, 'draft');
arch(12, 2026, 'luck_wins', 0.6, 1, 'outcome');
arch(12, 2026, 'all_play', 0.33, 3, 'outcome');
// Written by the same build run, in the same store, for the same league-season —
// and NOT in ARCHETYPE_METRICS, so the signal layer copies no value from it.
arch(12, 2026, 'beat_median_streak', 3, 4, 'outcome', ARCH_BUILT_AT);
// A LATER build, in the same league and the same store, for a DIFFERENT season.
// It is the newest row league 12 has, and it must not be this season-view's date:
// "the store was last built at 07:00" is true and useless if what was built was
// last year.
arch(12, 2025, 'all_play', 0.5, 14, 'outcome', '2026-09-18T07:00:00.000Z');
arch(0, 0, 'luck_wins', -2.5, 40, 'career');
arch(11, 2026, 'reach_rate', 0.9, 16, 'draft');

// League 13: connected but never synced.
insertLeague(13, null);

const sigRows = leagueId => rows(`SELECT roster_id, metric, value, n, source, computed_at FROM manager_signals
                                  WHERE league_id = ? ORDER BY roster_id, metric`, leagueId);
const metricOf = (leagueId, rosterId, metric) => rows(`SELECT value, n, source FROM manager_signals
  WHERE league_id = ? AND roster_id = ? AND metric = ?`, leagueId, String(rosterId), metric)[0] ?? null;

// ============================================================== identities
test('identity: a league with no chat corpus gets one row per ESPN team, no chat name, and no warnings', () => {
  const r = identity.matchIdentities(12, { chatNames: [] });
  assert.equal(r.rosters, 4);
  const stored = rows('SELECT * FROM league_member_identity WHERE league_id = 12 ORDER BY roster_id');
  assert.equal(stored.length, 4);
  for (const s of stored) {
    assert.equal(s.chat_name, null, `roster ${s.roster_id} must not get a chat name`);
    assert.equal(s.match_method, identity.NO_CHAT_METHOD);
    assert.equal(s.confidence, 'unmatched');
  }
  assert.equal(stored.find(s => s.roster_id === '2').espn_name, 'Aiden Stone');
  assert.deepEqual(identity.identityWarnings(12), [],
    'nothing to match is not a warning — there is no chat to attribute');
});

test('identity: a re-run keeps Nick\'s confirmations even when a name match disagrees', () => {
  identity.matchIdentities(11, { chatNames: CHAT_NAMES });
  const byRoster = new Map(rows('SELECT * FROM league_member_identity WHERE league_id = 11')
    .map(r => [r.roster_id, r]));
  assert.equal(byRoster.get('1').chat_name, 'ME');
  assert.equal(byRoster.get('1').confidence, 'confirmed');
  assert.equal(byRoster.get('2').chat_name, 'Hayden Brook', 'the surname match must not overwrite a confirmation');
  assert.equal(byRoster.get('2').confidence, 'confirmed');
  assert.match(byRoster.get('2').note ?? '', /Jake Stone/, 'the disagreement is recorded, not hidden');
  assert.equal(byRoster.get('3').chat_name, 'Carl Delta');
  assert.equal(byRoster.get('3').confidence, 'exact');
  assert.equal(byRoster.get('4').chat_name, 'Danny Echo');
  assert.equal(byRoster.get('4').confidence, 'likely');
});

test('identity: a re-run with nothing new does not rewrite rows (stable updated_at)', () => {
  run(`UPDATE league_member_identity SET updated_at = '2000-01-01 00:00:00' WHERE league_id IN (11, 12)`);
  identity.matchIdentities(11, { chatNames: CHAT_NAMES });
  identity.matchIdentities(12, { chatNames: [] });
  const stamps = rows('SELECT DISTINCT updated_at FROM league_member_identity WHERE league_id IN (11, 12)');
  assert.deepEqual(stamps.map(s => s.updated_at), ['2000-01-01 00:00:00']);
});

test('identity: only confirmed or exact matches are trusted for chat attribution', () => {
  const map = identity.identityMap(11);
  assert.deepEqual([...map.keys()].sort(), ['1', '2', '3']);
  assert.ok(!map.has('4'), 'a "likely" first-name-prefix match is surfaced, not used');
  assert.ok(identity.identityWarnings(11).some(w => w.roster_id === '4'));
});

// ================================================================= signals
test('signals: a league with no chat gets roster, standings, transaction, draft and outcome signals — never chat or priors', () => {
  const r = signals.buildManagerSignals(12);
  assert.ok(!r.error, r.error);
  const all = sigRows(12);
  const sources = new Set(all.map(s => s.source));
  for (const s of sources) assert.ok(s in signals.SIGNAL_SOURCES, `source "${s}" must be declared in SIGNAL_SOURCES`);
  assert.ok(!sources.has('chat') && !sources.has('nick'), 'no chat data exists for this league');
  for (const want of ['roster', 'standings', 'tx', 'draft', 'outcome']) {
    assert.ok(sources.has(want), `expected a "${want}" signal`);
  }
  assert.deepEqual([...new Set(all.map(s => s.roster_id))].sort(), ['1', '2', '3', '4']);
  assert.equal(signals.SIGNAL_SOURCES.draft.priceable, false,
    'no draft metric survived the repeatability test (study/features/archetypes.md)');
});

test('signals: trade decisions are credited to the manager who decided, not the proposer', () => {
  // Team 2 answered six offers: accepted p1 and p6, declined p2-p5.
  assert.equal(metricOf(12, 2, 'tx_decisions_made')?.value, 6);
  assert.equal(+metricOf(12, 2, 'tx_accept_rate')?.value.toFixed(3), 0.333);
  assert.equal(metricOf(12, 2, 'tx_offers_received')?.value, 6);
  // The proposers get no accept credit from ESPN's PROCESS rows.
  assert.equal(metricOf(12, 1, 'tx_decisions_made')?.value ?? 0, 0);
  assert.equal(metricOf(12, 3, 'tx_decisions_made')?.value ?? 0, 0);
  // Team 3 sent six real proposals; the five close-out records are not proposals.
  assert.equal(metricOf(12, 3, 'tx_proposals_sent')?.value, 6);
  assert.equal(+metricOf(12, 3, 'tx_proposal_withdrawn_rate')?.value.toFixed(3), 0.167);
  assert.equal(metricOf(12, 3, 'tx_proposal_cancel_rate'), null, 'the old conflated metric is gone');
  // Team 4: one veto vote; two players actually added (a canceled and a failed claim are not moves).
  assert.equal(metricOf(12, 4, 'tx_veto_votes')?.value, 1);
  assert.equal(metricOf(12, 4, 'tx_waiver_moves')?.value, 2);
});

test('signals: standings come from the synced ESPN record and the last decided matchup', () => {
  assert.equal(metricOf(12, 1, 'standing_wins')?.value, 1);
  assert.equal(metricOf(12, 2, 'standing_losses')?.value, 1);
  assert.equal(metricOf(12, 3, 'standing_points_for')?.value, 130);
  assert.equal(metricOf(12, 2, 'standing_streak')?.value, -1);
  assert.equal(metricOf(12, 1, 'last_week_margin')?.value, 20);
  assert.equal(metricOf(12, 2, 'last_week_margin')?.value, -20);
  assert.equal(metricOf(12, 2, 'last_week_margin')?.source, 'standings');
});

test('signals: draft and outcome come from this league-season only, labelled by source', () => {
  const auto = metricOf(12, 2, 'draft_auto_rate');
  assert.deepEqual(auto && { value: auto.value, n: auto.n, source: auto.source }, { value: 0, n: 16, source: 'draft' });
  assert.equal(metricOf(12, 2, 'draft_reach_rate')?.value, 0.25, 'not the 0.9 from his other league');
  const luck = metricOf(12, 2, 'outcome_luck_wins');
  assert.deepEqual(luck && { value: luck.value, source: luck.source }, { value: 0.6, source: 'outcome' });
  assert.ok(!rows(`SELECT 1 FROM manager_signals WHERE league_id = 12 AND value = -2.5`).length,
    'the career roll-up is not this season');
});

test('accessor: the pricing path is never handed a metric nothing may price on', () => {
  // The `priceable` flag lived only in routes/trades.js:446, in the HTTP layer.
  // managerSignalsFor — "everything the trade engine needs about one league's
  // managers, in one read" — returned every stored metric in one bag with no
  // flag, and it is what counterpartyLayer reads. Nothing priced on a draft
  // metric today, but nothing stopped it either: a reach for
  // m.metrics.draft_reach_rate would have compiled, run and been wrong.
  //
  // So the flag is not a flag any more. An unpriceable row is not in the bag the
  // pricing path reads, which is a property rather than a rule someone remembers.
  signals.buildManagerSignals(12);
  const layer = signals.managerSignalsFor(12);
  const two = layer.get('2');
  assert.ok(two, 'roster 2 has signals in league 12');

  // Stored, and readable by the page — see the route test below.
  assert.equal(metricOf(12, 2, 'draft_reach_rate')?.source, 'draft');

  for (const m of ['draft_auto_rate', 'draft_reach_rate', 'draft_pick_vs_consensus',
    'draft_name_brand_excess']) {
    assert.ok(!(m in two.metrics),
      `${m} comes from a source declared priceable: false, so it must not be in the pricing bag`);
  }
  const ctx = two.context ?? {};
  assert.ok('draft_reach_rate' in ctx, 'it is still readable, in the bag that says what it is');
  // All three branches of the pattern this replaces are inside the one sentence
  // `unpriceableReason` writes, so it asserted only that the sentence existed.
  assert.match(two.context_reasons?.draft_reach_rate ?? '',
    /is declared priceable: false — context only, never priced/,
    `and it carries why nothing may price on it, got ${JSON.stringify(two.context_reasons?.draft_reach_rate)}`);
  assert.doesNotMatch(two.context_reasons?.draft_reach_rate ?? '', /is not declared in SIGNAL_SOURCES/,
    'and it is the DECLARED-unpriceable reason, not the undeclared-source one');
});

test('accessor: an undeclared source fails closed — unpriceable until someone declares it', () => {
  // The broken copy. A source that is not in SIGNAL_SOURCES has no `priceable`
  // entry to read, and `spec?.priceable ?? false` in the old route helper got
  // that right. The accessor has to get it right too, in the same direction:
  // absent means NOT priceable, never priceable-by-default, or a metric added
  // without its registry entry silently becomes an input to a price.
  run(`INSERT OR REPLACE INTO manager_signals (league_id, roster_id, metric, value, n, source, computed_at)
       VALUES (12, '2', 'invented_metric', 0.9, 40, 'not_a_declared_source', datetime('now'))`);
  try {
    const two = signals.managerSignalsFor(12).get('2');
    assert.ok(!('invented_metric' in two.metrics),
      'an undeclared source must not reach the pricing bag');
    assert.ok('invented_metric' in (two.context ?? {}),
      'it is still surfaced, so a stray writer is visible rather than swallowed');
    assert.match(two.context_reasons?.invented_metric ?? '',
      /is not declared in SIGNAL_SOURCES, so nothing may price on it/,
      `the reason names the registry, which is what a reader has to go fix, got ${JSON.stringify(two.context_reasons?.invented_metric)}`);
    assert.match(two.context_reasons?.invented_metric ?? '', /not_a_declared_source/,
      'and names the offending source itself, so the fix does not start with a grep');
    assert.doesNotMatch(two.context_reasons?.invented_metric ?? '', /declared priceable: false/,
      'and it is the undeclared-source reason, not the declared-unpriceable one');
  } finally {
    run(`DELETE FROM manager_signals WHERE league_id = 12 AND metric = 'invented_metric'`);
  }
});

test('accessor: everything the pricing layer actually reads is still in the pricing bag', () => {
  // The regression pin for the two above. Partitioning the bag could starve
  // counterpartyLayer without any test noticing, because a missing metric there
  // reads as "we know nothing about him" — which is exactly the silent
  // degradation this whole branch is about. These are the names grepped out of
  // counterparty-pricing.js: every m.* it reads, plus the two postLossFactor
  // takes.
  // BOTH leagues, and the sources are asserted rather than assumed. The first
  // version of this pin read league 11 alone, and a mutation that wrongly
  // partitioned every `tx` metric out of the pricing bag did not fail it —
  // league 11 stores no `tx` rows, so the pin never reached the case it claimed
  // to protect. Same shape as the boundary fixture in
  // docs/tdd/luck-read-not-firing.tdd.md: a pin is only as strong as the rows
  // the fixture actually gives it.
  for (const leagueId of [11, 12]) {
    signals.buildManagerSignals(leagueId);
    const layer = signals.managerSignalsFor(leagueId);
    const present = new Set();
    for (const s of layer.values()) for (const k of Object.keys(s.metrics)) present.add(k);
    const priceableRows = sigRows(leagueId).filter(r => signals.SIGNAL_SOURCES[r.source]?.priceable);
    const stored = new Set(priceableRows.map(r => r.metric));
    assert.ok(stored.size > 0, `league ${leagueId} must store some priceable metrics`);
    for (const m of stored) {
      assert.ok(present.has(m),
        `${m} is priceable and stored in league ${leagueId}, so the pricing bag must still carry it`);
    }
  }
  // And the sources between them must cover every priceable one the registry
  // declares and these fixtures can produce, so "some priceable metric survived"
  // cannot pass on one source while another is quietly partitioned away.
  const seen = new Set([...sigRows(11), ...sigRows(12)].map(r => r.source));
  for (const want of ['roster', 'standings', 'tx', 'outcome']) {
    assert.ok(seen.has(want), `the fixtures must exercise the "${want}" source for this pin to mean anything`);
  }
});

test('signals: chat and player views only for trusted identities in the chat league', () => {
  signals.buildManagerSignals(11);
  const chatRosters = new Set(rows(`SELECT DISTINCT roster_id FROM manager_signals
                                    WHERE league_id = 11 AND source = 'chat'`).map(r => r.roster_id));
  assert.deepEqual([...chatRosters].sort(), ['1', '2', '3']);
  const views = rows('SELECT roster_id, player_name FROM manager_player_view WHERE league_id = 11');
  assert.deepEqual(views.map(v => `${v.roster_id}:${v.player_name}`), ['2:Player A'],
    'Danny Echo is only a "likely" match, so his opinions are not attributed to roster 4');
});

test('signals: a re-run with no new data writes nothing, and new data rewrites the league', () => {
  run(`UPDATE manager_signals SET computed_at = '2000-01-01 00:00:00' WHERE league_id = 12`);
  const keyBefore = pricing.counterpartyDataKey(12);
  const again = signals.buildManagerSignals(12);
  assert.equal(again.unchanged, true);
  assert.deepEqual(rows(`SELECT DISTINCT computed_at FROM manager_signals WHERE league_id = 12`)
    .map(r => r.computed_at), ['2000-01-01 00:00:00']);
  assert.equal(pricing.counterpartyDataKey(12), keyBefore, 'stable key when nothing changed');

  tx('p8', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 4, null, swap(4, 1));
  const changed = signals.buildManagerSignals(12);
  assert.equal(changed.unchanged, false);
  assert.equal(metricOf(12, 4, 'tx_proposals_sent')?.value, 1);
  assert.notEqual(pricing.counterpartyDataKey(12), keyBefore, 'new data must change the key');
});

test('signals: a chat league is never rebuilt without its chat DB (that would strip every chat read)', () => {
  const before = sigRows(11).length;
  const views = rows('SELECT COUNT(*) AS n FROM manager_player_view WHERE league_id = 11')[0].n;
  const saved = process.env.GRIDIRON_CHAT_DB_PATH;
  process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'gone.sqlite');
  try {
    const r = signals.buildManagerSignals(11);
    assert.match(r.error ?? '', /chat DB/);
  } finally { process.env.GRIDIRON_CHAT_DB_PATH = saved; }
  assert.equal(sigRows(11).length, before);
  assert.equal(rows('SELECT COUNT(*) AS n FROM manager_player_view WHERE league_id = 11')[0].n, views);
});

test('refresh: one call covers every league, uses chat names only where Nick confirmed a chat identity', () => {
  const r = signals.refreshManagerData();
  const byId = new Map(r.leagues.map(l => [l.league_id, l]));
  assert.equal(byId.get(11).chat_corpus, true);
  assert.equal(byId.get(12).chat_corpus, false);
  assert.equal(byId.get(11).identities.trusted, 3);
  assert.equal(byId.get(12).identities.with_chat_name, 0);
  assert.ok(byId.get(12).signals > 0);
  assert.equal(byId.get(13).skipped, 'league not synced');
  assert.equal(r.status, 'ok');
  assert.ok(!JSON.stringify(r).includes('secret-s2'), 'never echoes league credentials');
});

test('refresh: the reported archetype build date is the store\'s, not the newest metric this consumer maps', () => {
  // `archetypes_as_of` is served (routes/trades.js rebuild route) and printed by
  // scripts/build-manager-signals.mjs. It was accumulated INSIDE the row loop,
  // after a `continue` that drops any metric not in ARCHETYPE_METRICS — so the
  // date it reported was "newest stamp among the metrics this consumer maps", and
  // it would move if that map were edited. Editing a consumer's allowlist must not
  // change what a reader is told about when the data was built.
  const l12 = new Map(signals.refreshManagerData().leagues.map(l => [l.league_id, l])).get(12);
  assert.equal(l12.archetypes, 'present');
  assert.equal(l12.archetypes_as_of, ARCH_BUILT_AT,
    'the newest row in this league-season\'s store is the build date, mapped or not');
  assert.notEqual(ARCH_BUILT_AT, ARCH_BUILT_EARLY,
    'the fixture has two build stamps, or this assertion proves nothing');
  // And the season filter is load-bearing: league 12's newest row overall is a
  // 2025 build at 07:00, which is a true statement about the store and the wrong
  // answer to "how old is what this page is showing".
  assert.equal(rows(`SELECT MAX(computed_at) AS a FROM manager_archetypes WHERE league_id = 12`)[0].a,
    '2026-09-18T07:00:00.000Z', 'the fixture has a newer row in another season');
});

test('refresh: a chat table missing mid-rollup fails the chat league only; chat-free leagues still build', () => {
  // The rollup drops and recreates manager_chat_profile outside a transaction;
  // a crash between the two leaves it missing. That must not block the leagues
  // that have no chat at all.
  const midroll = path.join(temp, 'midroll.sqlite');
  fs.copyFileSync(CHAT_PATH, midroll);
  const c = new DatabaseSync(midroll); c.exec('DROP TABLE manager_chat_profile'); c.close();
  const chatRows = sigRows(11).length;
  const saved = process.env.GRIDIRON_CHAT_DB_PATH;
  process.env.GRIDIRON_CHAT_DB_PATH = midroll;
  let r;
  try { r = signals.refreshManagerData(); } finally { process.env.GRIDIRON_CHAT_DB_PATH = saved; }
  const byId = new Map(r.leagues.map(l => [l.league_id, l]));
  assert.match(byId.get(11).error ?? '', /manager_chat_profile/);
  assert.equal(byId.get(12).error, undefined);
  assert.ok(byId.get(12).signals > 0);
  assert.equal(r.status, 'error');
  assert.equal(sigRows(11).length, chatRows, 'the chat league keeps its stored rows');
});

// ================================================================= pricing
test('pricing: the counterparty layer does not apply the "hard" tier — the trade engine applies it once', () => {
  const fair = pricing.counterpartyLayer(12, { season: 2026, week: 2 }).get('3');
  run(`INSERT INTO manager_profiles (league_id, roster_id, tradeability) VALUES (12, '3', 'hard')`);
  const hard = pricing.counterpartyLayer(12, { season: 2026, week: 2 }).get('3');
  run(`DELETE FROM manager_profiles WHERE league_id = 12`);
  assert.equal(hard.tier, 'hard');
  assert.equal(hard.receptiveness, fair.receptiveness);
});

test('pricing: perception is neutral (null) when nothing is known about any player in the deal', () => {
  const profile = { receptiveness: 1, players: new Map(), reads: new Map() };
  const give = [{ name: 'X', value: 100 }];
  const get = [{ name: 'Y', value: 110 }];
  const blind = pricing.readDeal({ theirGive: give, theirGet: get, managerProfile: profile });
  assert.equal(blind.perception_delta, null, 'our own value gap is not his perception');
  assert.equal(blind.perception_shift, null);

  const informed = { ...profile, players: new Map([['y', { sentiment: 3.5, n: 5, multiplier: 1.1 }]]) };
  const read = pricing.readDeal({ theirGive: give, theirGet: get, managerProfile: informed });
  assert.equal(read.perception_delta, 21, '(110*1.1 - 100) / 100');
  assert.equal(read.perception_shift, 11, 'the part his view adds beyond our 10% value gap');
});

test('pricing: untouchablesFor is retired (bluff-detector owns declared untouchables)', () => {
  assert.equal(pricing.untouchablesFor, undefined);
});

test('pricing: one validated loader for negotiation profiles; ME is Nick\'s self-profile', () => {
  const r = pricing.negotiationProfilesFor(11);
  assert.equal(r.available, true);
  assert.deepEqual([...r.byRoster.keys()], ['2']);
  assert.equal(r.byRoster.get('2').name, 'Hayden Brook');
  assert.equal(r.byRoster.get('2').profile.says_no.does_his_no_hold, 'rarely');
  assert.equal(r.self?.name, 'ME');
  assert.equal(r.self.profile.headline, 'Sends a lot of offers.');
  assert.ok(!r.byRoster.has('1'), 'Nick is never his own counterparty');
  const bad = r.invalid.find(i => i.name === 'Carl Delta');
  assert.ok(bad, 'the malformed profile is reported');
  assert.ok(bad.errors.some(e => /leaked tool-call markup|expected object/.test(e)));
  assert.ok(r.unmapped.includes('Danny Echo'), 'a profile whose identity is only "likely" is not attached to a roster');

  const none = pricing.negotiationProfilesFor(12);
  assert.equal(none.available, false);
  assert.match(none.reason, /no chat/i);
  assert.equal(none.byRoster.size, 0);
});

test('pricing: the profile validator accepts the stored shape and names each violation', () => {
  assert.deepEqual(pricing.negotiationProfileErrors(validProfile()), []);
  const errs = pricing.negotiationProfileErrors(validProfile({ confidence: 7, extra: 1 }));
  assert.ok(errs.some(e => /confidence/.test(e)));
  assert.ok(errs.some(e => /unexpected key/.test(e)));
  assert.ok(pricing.negotiationProfileErrors({}).some(e => /headline: missing/.test(e)));
});

// =================================================================== bluff
test('bluff: credibility is cached against the chat data and invalidated when it changes', () => {
  const a = bluff.declarationCredibility();
  const b = bluff.declarationCredibility();
  assert.equal(a, b, 'unchanged chat data serves the cached result');
  assert.equal(a.available, true);
  // Danny Echo is only a "likely" identity match (asserted elsewhere in this file), and
  // since 2026-09-18 a declaration can only be verified against a TRUSTED identity's own
  // roster (fixes the relook finding that Raj's reversals included players he never owned)
  // - so an unconfirmed name like Danny now correctly contributes no credibility record at
  // all, rather than being trusted at face value. Hayden Brook (roster 2, confirmed, and
  // genuinely owns "Player A" per the league-11 fixture) is the verifiable one here.
  assert.ok(!a.byManager.has('Danny Echo'), 'an unconfirmed identity cannot have its declarations verified');
  assert.equal(a.byManager.get('Hayden Brook').declarations, 1);
  assert.equal(a.byManager.get('Hayden Brook').hard_reversals, 0, 'he has not reversed on Player A yet');
  assert.notEqual(bluff.declarationCredibility({ windowDays: 1 }), a, 'the window is part of the key');

  const w = new DatabaseSync(CHAT_PATH);
  w.prepare(`INSERT INTO messages VALUES (4,'group','League','h2','Hayden Brook',0,'2026-09-07T12:00:00Z','still not',0,0)`).run();
  w.prepare(`INSERT INTO jev_chat_signals VALUES (4,'Hayden Brook','group','Player A','own_roster.untouchable',0.9,'2026-09-08')`).run();
  w.close();
  const c = bluff.declarationCredibility();
  assert.notEqual(c, a);
  assert.equal(c.byManager.get('Hayden Brook').declarations, 2);
});

test('bluff: an absent chat DB returns the same shape as a present one', () => {
  const saved = process.env.GRIDIRON_CHAT_DB_PATH;
  process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'does-not-exist.sqlite');
  try {
    const r = bluff.declarationCredibility();
    assert.equal(r.available, false);
    assert.ok(r.byManager instanceof Map);
    assert.equal(r.byManager.size, 0);
    assert.deepEqual(r.events, []);
  } finally { process.env.GRIDIRON_CHAT_DB_PATH = saved; }
});

test('bluff: an untrusted identity never borrows a chat record', () => {
  // Built by hand so the check does not depend on which chat DB is read.
  const cred = { byManager: new Map([['Danny Echo', { name: 'Danny Echo', credibility: 0.3, declarations: 6,
    hard_reversals: 4, hedged: 0, held: 2, confidence: 'measured' }]]), events: [] };
  const stance = bluff.untouchableStance(11, '4', cred);
  assert.equal(stance.credibility, null, 'roster 4 is only a "likely" match for Danny Echo');
});

// ========================================================= trade engine seam
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
// Market values and projections, as test/trade-evidence.test.js seeds them:
// the lightweight seed prices every player at 0, so without this findTrades
// correctly finds nothing.
const { deriveFormat } = await import('../server/services/format.js');
function seedMarket(players) {
  const { formatKey } = deriveFormat({ team_count: 6, ppr: null, league_type: null, best_ball: 0, payload: null,
    roster_positions: JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']) });
  const now = new Date().toISOString();
  players.forEach((p, i) => {
    const proj = 320 - i * 3;
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?, 2026, 'projected', ?, 17, '{}', ?)
         ON CONFLICT(player_id, season, kind) DO UPDATE SET fantasy_points = excluded.fantasy_points`, p.id, proj, now);
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank, fetched_at)
         VALUES (?, ?, ?, ?, 0, 26, ?, ?)
         ON CONFLICT(format_key, player_id) DO UPDATE SET value = excluded.value, redraft_value = excluded.redraft_value`,
    formatKey, p.id, Math.round(proj * 3), Math.round(proj * 3), i + 1, now);
  });
}
function sixTeamLeague() {
  const pick = (pos, n) => rows(`SELECT id, name, position FROM players WHERE position = ? AND fantasy_relevant = 1
                                 ORDER BY id LIMIT ?`, pos, n);
  const qb = pick('QB', 6), rb = pick('RB', 18), wr = pick('WR', 18), te = pick('TE', 6);
  seedMarket([...qb, ...rb, ...wr, ...te]);
  let fakeId = 800000;
  const teams = [];
  for (let i = 0; i < 6; i++) {
    // Snake the tiers so every team has strengths and needs to trade on.
    const roster = [qb[i], rb[i], rb[i + 6], rb[i + 12], wr[i], wr[i + 6], wr[i + 12], te[i]].filter(Boolean);
    teams.push({ id: i + 1, name: `Team ${i + 1}`, owners: [`{M${i + 1}}`], roster: { entries: roster.map(p => ({
      playerPoolEntry: { player: { id: fakeId++, fullName: p.name, defaultPositionId: POS_ID[p.position] } } })) } });
  }
  return { teams, members: teams.map(t => member(t.owners[0], `First${t.id}`, `Last${t.id}`)), settings: { name: 'HT' } };
}

test('trade engine: with signals built, a "hard" manager is discounted by 0.55 exactly once', () => {
  insertLeague(301, sixTeamLeague());
  signals.buildManagerSignals(301);
  const lg = rows('SELECT * FROM leagues WHERE id = 301')[0];
  const keyOf = d => `${d.partner_id}:${d.i_give.map(p => p.id).sort()}>${d.i_get.map(p => p.id).sort()}`;
  const fair = findTrades(lg, { myTeamId: '1', requireMutual: false, limit: 200 });
  assert.ok(!fair.error, fair.error);
  const partner = fair.deals[0]?.partner_id;
  assert.ok(partner, 'the fixture must produce at least one deal');
  run(`INSERT INTO manager_profiles (league_id, roster_id, tradeability) VALUES (301, ?, 'hard')`, String(partner));
  const hard = findTrades(lg, { myTeamId: '1', requireMutual: false, limit: 200 });
  const hardByKey = new Map(hard.deals.map(d => [keyOf(d), d]));
  const pairs = fair.deals.filter(d => d.partner_id === partner && hardByKey.has(keyOf(d)));
  assert.ok(pairs.length > 0);
  for (const d of pairs) {
    const h = hardByKey.get(keyOf(d));
    const ratio = (h.score_signed + h.value_cost) / (d.score_signed + d.value_cost);
    assert.ok(Math.abs(ratio - 0.55) < 0.002, `expected 0.55, got ${ratio.toFixed(4)} (0.3025 = applied twice)`);
  }
});

// ================================================================== script
test('script: one run over every league writes a sync_log row; a second run changes nothing', () => {
  const runScript = () => spawnSync(process.execPath, ['scripts/build-manager-signals.mjs', '--json'], {
    cwd: REPO, env: process.env, encoding: 'utf8', timeout: 120000,
  });
  const first = runScript();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const summary = JSON.parse(first.stdout.trim().split('\n').at(-1));
  assert.ok(summary.leagues.some(l => l.league_id === 12 && l.signals > 0));
  assert.ok(!first.stdout.includes('secret-s2') && !first.stdout.includes('secret-swid'));
  const log = rows(`SELECT last_status, last_detail FROM sync_log WHERE job = 'manager_signals'`)[0];
  assert.equal(log?.last_status, 'ok');
  assert.ok(JSON.parse(log.last_detail).leagues.length >= 3);

  const second = runScript();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const again = JSON.parse(second.stdout.trim().split('\n').at(-1));
  for (const l of again.leagues.filter(x => !x.skipped)) {
    assert.equal(l.unchanged, true, `league ${l.league_id} must not be rewritten on an idle re-run`);
    assert.equal(l.identities.changed, 0);
  }
});
