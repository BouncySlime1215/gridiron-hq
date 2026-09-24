/**
 * valuation-map: for every manager and every player, what THAT manager thinks
 * he is worth, next to what we think he is worth.
 *
 * Master plan 00 D4: "The core object is a per-manager valuation map … The gap
 * on each player is the raw material of every trade."
 *
 * Gates pre-registered in
 * /private/tmp/claude-501/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/scratchpad/wa/valuation-map/GATE.md
 * before this file was written. Nothing here is a fitted model — every
 * multiplier is a hand-set, capped, NAMED adjustment on top of our own value —
 * so the guarantees are caps, provenance, cutoff safety and honest degradation,
 * not a season split.
 *
 *  G1 composition and caps: their_value = our_value x product of named factors;
 *     no factor over its own cap; the player clamped at PLAYER_VALUATION_CAP;
 *     the package still clamped at PERCEPTION_CAP; a manager we know nothing
 *     about returns exactly 1; the same evidence is never charged twice.
 *  G2 provenance: every factor names a source in VALUATION_SOURCES and carries
 *     n, cap and fitted; a source under its min_n is reported inert WITH ITS
 *     REASON rather than dropped.
 *  G3 cutoff safety: a week-w map does not read week-w data.
 *  G4 degradation: a chat-free league still gets a map from the sources it has;
 *     a league with no manager data says so instead of inventing one.
 *  G5 "how Nick looks": his offers to each manager, what the league knows he is
 *     shopping, and the veto votes against him — and he is never a counterparty.
 *  G7 ablation hook: zeroing a source really removes it.
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
import { fileURLToPath } from 'node:url';
import { withTableReplaced } from './helpers/with-table-replaced.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-valuation-map-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;
process.env.SCHEDULER_DISABLED = '1';

const SEASON = 2026;
const WEEK = 5; // late enough that the 4-week luck gate can be exercised both ways

// ---------------------------------------------------------------- chat fixture
function profileFor(overrides = {}) {
  return {
    headline: 'Trades a lot, rarely means no.',
    says_no: { how: 'jokes first', hard_no_looks_like: ['not happening'], soft_no_looks_like: ['eh'],
      does_his_no_hold: 'rarely', evidence: ['"not happening" then traded him'] },
    praise_means: { reading: 'marketing', why: 'praises before selling', hypes_before_selling: true,
      agrees_with_numbers: 'no', evidence: ['"league winner"'] },
    techniques: [{ name: 'anchor', how_he_does_it: 'asks high', evidence: ['"need two firsts"'], how_often: 'often' }],
    calibration: { enthusiasm_scale: 'loud', baseline_tone: 'friendly', inflation: 'heavy' },
    roster_read: { really_untouchable: [], quietly_available: [], overvalues: [], undervalues: [], reasoning: 'talk vs numbers' },
    what_moves_him: ['a win-now piece'],
    what_shuts_him_down: ['lowballs'],
    how_to_approach: 'Lead with a fair offer after a loss.',
    best_bait: 'Bench Guy',
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
    ['Carl Delta', 350, 250, 15, 0.3, 0.20, 0.1, 0.4, 2.1, 0.2, 0.6, 0.1, 0.20, 0.04, 0.04, 0.02],
    ['Danny Echo', 200, 150, 5, 0.2, 0.15, 0.1, 0.4, 2.0, 0.1, 0.7, 0.1, 0.15, 0.03, 0.02, 0.01],
  ];
  for (const p of people) prof.run(...p, '2026-01-01', '2026-09-17');

  const sent = chat.prepare(`INSERT INTO manager_player_sentiment VALUES (?,?,?,?,?,?,?,?,datetime('now'))`);
  // Hayden's own player, praised, and running HOT -> the sales-pitch read.
  sent.run('Hayden Brook', 'Hot Hype', 8, 3.4, 0.9, 0.0, '2026-08-01', '2026-09-16');
  // Hayden's own player, praised, no expectation gap at all -> raw sentiment only.
  sent.run('Hayden Brook', 'Quiet Star', 6, 3.6, 0.9, 0.0, '2026-08-01', '2026-09-16');
  // Carl's own player, running hot, NEVER discussed -> hype-vs-usage only.
  // (no sentiment row on purpose)
  // Nick's own talk about his own player: what the league knows he is shopping.
  sent.run('ME', 'Shopped Man', 9, 1.3, 0.0, 0.9, '2026-08-20', '2026-09-16');

  const msg = chat.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,0,0)`);
  const sig = chat.prepare(`INSERT INTO jev_chat_signals VALUES (?,?,?,?,?,?,?)`);
  // Hayden declares Quiet Star untouchable and never walks it back: his word holds.
  msg.run(1, 'group', 'League', 'h2', 'Hayden Brook', 0, '2026-09-05T12:00:00Z', 'Quiet Star is a league winner');
  sig.run(1, 'Hayden Brook', 'group', 'Quiet Star', 'own_roster.untouchable', 0.95, '2026-09-06');
  msg.run(2, 'group', 'League', 'h2', 'Hayden Brook', 0, '2026-09-07T12:00:00Z', 'still not moving him');
  sig.run(2, 'Hayden Brook', 'group', 'Quiet Star', 'own_roster.untouchable', 0.95, '2026-09-08');
  msg.run(3, 'group', 'League', 'h2', 'Hayden Brook', 0, '2026-09-09T12:00:00Z', 'no chance on Quiet Star');
  sig.run(3, 'Hayden Brook', 'group', 'Quiet Star', 'own_roster.untouchable', 0.95, '2026-09-10');

  const np = chat.prepare(`INSERT INTO negotiation_profiles VALUES (?,?,?,?,?,?)`);
  np.run('Hayden Brook', JSON.stringify(profileFor({
    roster_read: { really_untouchable: ['Quiet Star'], quietly_available: ['Bench Guy'],
      overvalues: ['Hot Hype (calls him a league winner)'], undervalues: ['Bench Guy'], reasoning: 'talk vs numbers' },
  })), 120, 'h1', 'claude-sonnet-5', '2026-09-18 05:00:00');
  np.run('ME', JSON.stringify(profileFor({
    headline: 'Sends a lot of offers.',
    roster_read: { really_untouchable: ['Quiet Star'],
      // The second entry is prose, not a name — exactly what the real `ME`
      // profile contains ("Olave-adjacent throw-ins when he had him").
      quietly_available: ['Shopped Man (offered to 6+ managers)', 'bench filler when he had it'],
      overvalues: [], undervalues: ['Shopped Man'], reasoning: 'he is tired of him' },
  })), 300, 'h2', 'claude-sonnet-5', '2026-09-18 05:50:00');
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

await runMigrations();
seedIfEmpty();
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// ------------------------------------------------------------ league fixtures
const NICK = '{VM-NICK}';
const HAY = '{VM-HAY}';
const CARL = '{VM-CARL}';
const DAN = '{VM-DAN}';
const member = (id, firstName, lastName) => ({ id, firstName, lastName, displayName: `${firstName}${lastName}` });
function rosterEntry(id, name, { slot = 0, acq = 'DRAFT', pos = 3 } = {}) {
  return { lineupSlotId: slot, acquisitionType: acq,
    playerPoolEntry: { player: { id, fullName: name, injuryStatus: 'ACTIVE', defaultPositionId: pos } } };
}
function team(id, owner, { wins = 0, losses = 0, pf = 0, streak = ['WIN', 0], entries = [] } = {}) {
  return { id, name: `Team ${id}`, owners: [owner], currentProjectedRank: id, draftDayProjectedRank: id,
    record: { overall: { wins, losses, ties: 0, pointsFor: pf, pointsAgainst: 0,
      streakType: streak[0], streakLength: streak[1] } },
    roster: { entries } };
}
function insertLeague(id, payload, { myTeamId = '1', name = `VM${id}` } = {}) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, ?, ?, ?, ?, ?, ?, 'secret-s2', 'secret-swid', 'connected')`,
  id, `espn-vm-${id}`, SEASON, name, payload == null ? null : JSON.stringify(payload),
  payload?.teams?.length ?? 0, myTeamId, JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
}

// League 21 — the chat league. Roster 1 is Nick.
insertLeague(21, {
  members: [member(NICK, 'Nick', 'Matta'), member(HAY, 'Hayden', 'Brook'),
    member(CARL, 'Carl', 'Delta'), member(DAN, 'Danny', 'Echo')],
  teams: [
    team(1, NICK, { wins: 3, losses: 1, pf: 500, streak: ['WIN', 2], entries: [
      rosterEntry(701, 'Shopped Man'), rosterEntry(702, 'Keeper Guy')] }),
    team(2, HAY, { wins: 1, losses: 3, pf: 400, streak: ['LOSS', 3], entries: [
      rosterEntry(711, 'Hot Hype'), rosterEntry(712, 'Quiet Star'), rosterEntry(713, 'Bench Guy')] }),
    team(3, CARL, { wins: 2, losses: 2, pf: 450, streak: ['WIN', 1], entries: [
      rosterEntry(721, 'Silent Riser'), rosterEntry(722, 'Plain Guy')] }),
    team(4, DAN, { wins: 2, losses: 2, pf: 440, streak: ['LOSS', 1], entries: [rosterEntry(731, 'Nobody Talks')] }),
  ],
  schedule: [
    { matchupPeriodId: 4, home: { teamId: 2, totalPoints: 80 }, away: { teamId: 3, totalPoints: 130 }, winner: 'AWAY' },
    { matchupPeriodId: 4, home: { teamId: 1, totalPoints: 140 }, away: { teamId: 4, totalPoints: 120 }, winner: 'HOME' },
  ],
});
run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name, chat_name,
       match_method, confidence) VALUES
     (21, '1', ?, 'Nick Matta', 'Team 1', 'ME', 'confirmed by Nick', 'confirmed'),
     (21, '2', ?, 'Hayden Brook', 'Team 2', 'Hayden Brook', 'confirmed by Nick', 'confirmed'),
     (21, '3', ?, 'Carl Delta', 'Team 3', 'Carl Delta', 'confirmed by Nick', 'confirmed')`, NICK, HAY, CARL);

// League 22 — no chat corpus at all, everything else present.
insertLeague(22, {
  members: [member(NICK, 'Nick', 'Matta'), member(HAY, 'Hayden', 'Brook'), member(CARL, 'Carl', 'Delta')],
  teams: [
    team(1, NICK, { wins: 2, losses: 2, pf: 460, streak: ['WIN', 1], entries: [rosterEntry(801, 'Shopped Man')] }),
    team(2, HAY, { wins: 0, losses: 4, pf: 380, streak: ['LOSS', 4], entries: [rosterEntry(811, 'Hot Hype')] }),
    team(3, CARL, { wins: 4, losses: 0, pf: 520, streak: ['WIN', 4], entries: [rosterEntry(821, 'Silent Riser')] }),
  ],
  schedule: [
    { matchupPeriodId: 4, home: { teamId: 2, totalPoints: 70 }, away: { teamId: 3, totalPoints: 150 }, winner: 'AWAY' },
  ],
}, { name: 'VM22 no chat' });

// League 23 — synced, but no manager data has ever been built for it.
insertLeague(23, {
  members: [member(NICK, 'Nick', 'Matta'), member(HAY, 'Hayden', 'Brook')],
  teams: [team(1, NICK, { entries: [rosterEntry(901, 'Shopped Man')] }),
    team(2, HAY, { entries: [rosterEntry(911, 'Hot Hype')] })],
  schedule: [],
}, { name: 'VM23 empty' });

// ---- expectation gaps: Hot Hype and Silent Riser are both far above expectation
const insFf = db.prepare(`INSERT INTO nfl_ffopportunity_weekly
  (season, week, player_gsis_id, player_name, team, position, expected_fantasy_points, actual_fantasy_points,
   source_release, ingested_at) VALUES (?,?,?,?,?,?,?,?,'test',datetime('now'))`);
for (let w = 1; w < WEEK; w++) {
  insFf.run(SEASON, w, `gsis-hot-${w}`, 'Hot Hype', 'KC', 'WR', 8, 14);          // +6.0 / game
  insFf.run(SEASON, w, `gsis-riser-${w}`, 'Silent Riser', 'KC', 'WR', 7, 13);    // +6.0 / game
  insFf.run(SEASON, w, `gsis-plain-${w}`, 'Plain Guy', 'KC', 'WR', 10, 10);      // flat
}
// Week WEEK itself exists and must never be read by a week-WEEK map (G3).
insFf.run(SEASON, WEEK, 'gsis-hot-now', 'Hot Hype', 'KC', 'WR', 8, 60);
insFf.run(SEASON, WEEK, 'gsis-riser-now', 'Silent Riser', 'KC', 'WR', 7, 60);

// ---- archetypes: luck for league 21, one with a real sample and one with n = 1
// The build stamps are PINNED and deliberately UNEQUAL. manager_archetypes is
// written only by scripts/build-manager-archetypes.mjs, by hand, and the luck
// half of it becomes `luck_self_view` — a term in the trade price. A fixture
// where every row shares one stamp cannot tell the newest build from the oldest,
// which is how a MIN-for-MAX mutation survives (docs/tdd/transactions-as-of.tdd.md).
const ARCH_BUILT_EARLY = '2026-09-18T01:38:39.383Z';
const ARCH_BUILT_AT = '2026-09-18T02:10:00.000Z';   // the newest — the real "as of"
const arch = (memberId, league, season, metric, value, n, source, builtAt = ARCH_BUILT_EARLY) =>
  run(`INSERT INTO manager_archetypes
  (member_id, league_id, season, metric, value, label, n, source, version, computed_at)
  VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'manager-archetypes-v1', ?)`,
  memberId, league, season, metric, value, n, source, builtAt);
arch(HAY, 21, SEASON, 'luck_wins', 1.6, 4, 'outcome');   // flattered, and enough weeks to count
arch(HAY, 21, SEASON, 'all_play', 0.3, 36, 'outcome');
arch(CARL, 21, SEASON, 'luck_wins', 1.6, 1, 'outcome');  // same flattery, ONE week — must stay inert
arch(CARL, 21, SEASON, 'all_play', 0.6, 9, 'outcome', ARCH_BUILT_AT);
arch(HAY, 22, SEASON, 'luck_wins', 1.6, 4, 'outcome');
arch(CARL, 22, SEASON, 'luck_wins', -1.2, 4, 'outcome');

// ---- transactions: Nick's offers, their answers, and a veto against him
function tx(leagueId, id, type, execution, status, teamId, { related = null, items = [], at = '2026-09-10T00:00:00Z' } = {}) {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at,
         team_id, related_tx_id, items_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  leagueId, SEASON, id, type, status, execution, at, teamId, related, JSON.stringify(items));
}
const swap = (a, b) => [{ fromTeamId: a, toTeamId: b, playerId: 1, type: 'TRADE' },
  { fromTeamId: b, toTeamId: a, playerId: 2, type: 'TRADE' }];
// Nick (roster 1) sends three offers to Hayden (roster 2): two declined, one accepted.
tx(21, 'n1', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 1, { items: swap(1, 2), at: '2026-09-01T00:00:00Z' });
tx(21, 'n1-dec', 'TRADE_DECLINE', 'EXECUTE', 'EXECUTED', 2, { related: 'n1', at: '2026-09-01T06:00:00Z' });
tx(21, 'n2', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 1, { items: swap(1, 2), at: '2026-09-08T00:00:00Z' });
tx(21, 'n2-dec', 'TRADE_DECLINE', 'EXECUTE', 'EXECUTED', 2, { related: 'n2', at: '2026-09-08T06:00:00Z' });
tx(21, 'n3', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 1, { items: swap(1, 2), at: '2026-09-14T00:00:00Z' });
tx(21, 'n3-acc', 'TRADE_ACCEPT', 'EXECUTE', null, 2, { related: 'n3', at: '2026-09-14T04:00:00Z' });
tx(21, 'n3-proc', 'TRADE_ACCEPT', 'PROCESS', 'EXECUTED', 1, { related: 'n3' });
// Two league members vetoed that deal of Nick's.
tx(21, 'n3-v1', 'TRADE_VETO', 'EXECUTE', 'EXECUTED', 3, { related: 'n3' });
tx(21, 'n3-v2', 'TRADE_VETO', 'EXECUTE', 'EXECUTED', 4, { related: 'n3' });
// One offer to Carl (roster 3), still pending.
tx(21, 'n4', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 1, { items: swap(1, 3), at: '2026-09-16T00:00:00Z' });
// An offer Nick RECEIVED — must never be counted as one he sent.
tx(21, 'h1', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 2, { items: swap(2, 1), at: '2026-09-15T00:00:00Z' });

// ---- build identities and signals through the real pipeline
identity.matchIdentities(21, { chatNames: ['ME', 'Hayden Brook', 'Carl Delta', 'Danny Echo'] });
identity.matchIdentities(22, { chatNames: [] });
const chatHandle = signals.openChatDb();
signals.buildManagerSignals(21, { chat: chatHandle });
signals.buildManagerSignals(22, { chat: null });
chatHandle?.close();

// ---------------------------------------------------------------- the universe
// These also go into `players`, because "is this string a real player" is a
// question selfRead has to be able to answer (see G5b2).
const PLAYERS = [
  { id: 701, name: 'Shopped Man', position: 'WR', value: 1000 },
  { id: 702, name: 'Keeper Guy', position: 'RB', value: 900 },
  { id: 711, name: 'Hot Hype', position: 'WR', value: 800 },
  { id: 712, name: 'Quiet Star', position: 'RB', value: 1200 },
  { id: 713, name: 'Bench Guy', position: 'TE', value: 200 },
  { id: 721, name: 'Silent Riser', position: 'WR', value: 600 },
  { id: 722, name: 'Plain Guy', position: 'WR', value: 500 },
  { id: 731, name: 'Nobody Talks', position: 'QB', value: 300 },
];
for (const p of PLAYERS) {
  run('INSERT INTO players (id, name, position, fantasy_relevant) VALUES (?,?,?,1)', p.id, p.name, p.position);
}
const NEEDS = new Map([
  ['1', { needs: new Set(['TE']), surplus: new Set(['WR']), window: 'contend' }],
  ['2', { needs: new Set(['QB']), surplus: new Set(['RB']), window: 'retool' }],
  ['3', { needs: new Set(['TE']), surplus: new Set(), window: 'contend' }],
  ['4', { needs: new Set(), surplus: new Set(), window: 'contend' }],
]);
const layerFor = (leagueId, opts = {}) =>
  pricing.counterpartyLayer(leagueId, { season: SEASON, week: WEEK, rosterContext: NEEDS, ...opts });
const mapFor = (leagueId, opts = {}) =>
  pricing.valuationMap(leagueId, { season: SEASON, week: WEEK, players: PLAYERS, rosterContext: NEEDS, ...opts });
const byName = (managerEntry, name) => managerEntry.players.get(name.toLowerCase());
const factorNames = v => (v?.factors ?? []).map(f => f.source).sort();

// =============================================================== G1 caps
test('G1a: a manager we know nothing about prices every player at exactly our number', () => {
  const map = mapFor(21);
  const danny = map.managers.get('4'); // Danny Echo: no trusted identity, no chat, no archetype
  assert.ok(danny, 'every roster but Nick is in the map');
  const v = byName(danny, 'Quiet Star');
  assert.equal(v.multiplier, 1, 'no information must be exactly 1, not 0.999');
  assert.equal(v.their_value, v.our_value);
  assert.deepEqual(v.factors, [], 'no factor may be invented for a manager we have nothing on');
});

test('G1b: no factor may exceed its own source cap, and the player is clamped at PLAYER_VALUATION_CAP', () => {
  const map = mapFor(21);
  let seen = 0;
  for (const m of map.managers.values()) {
    for (const v of m.players.values()) {
      for (const f of v.factors) {
        const cap = pricing.VALUATION_SOURCES[f.source].cap;
        assert.ok(Math.abs(f.effect) <= cap + 1e-9,
          `${f.source} moved ${f.effect}, cap ${cap}`);
        assert.equal(f.cap, cap);
        seen++;
      }
      assert.ok(Math.abs(v.multiplier - 1) <= pricing.PLAYER_VALUATION_CAP + 1e-9,
        `${v.player}: ${v.multiplier} outside the per-player cap`);
    }
  }
  assert.ok(seen >= 5, `the fixture must actually fire several factors (saw ${seen})`);
});

test('G1c: a player every source pushes the same way is clamped, and says he was clamped', () => {
  // A real profile in which every source pushes the same way at once: he talks
  // him up, his model read names him untouchable, his record is flattered, and
  // his declarations have always held. The flattered record is still in the
  // profile but no longer moves anything: luck_self_view was tested dead
  // (r46 IDEA-103), so three sources fire, and three still overrun the clamp.
  const loaded = {
    roster_id: '2', receptiveness: 1, roster_size: 3,
    owned: new Set(['quiet star']),
    players: new Map([['quiet star', { sentiment: 4, n: 20, last: '2026-09-16', multiplier: 1.12 }]]),
    reads: new Map(),
    gaps: new Map(),
    negotiation: { confidence: 'high', roster_read: { really_untouchable: ['Quiet Star'],
      quietly_available: [], overvalues: [], undervalues: [] } },
    negotiation_n: 400,
    luck: { value: 2.4, n: 6 },
    stance: { stance: 'respect', respect: new Set(['quiet star']), probe: new Set(),
      credibility: { credibility: 1, declarations: 6 } },
    needs: new Set(), surplus: new Set(),
  };
  const v = pricing.playerValuation(loaded, { name: 'Quiet Star', position: 'RB', value: 1000 });
  assert.ok(v.factors.length >= 3, `every live source should have fired (${v.factors.map(f => f.source)})`);
  assert.ok(!v.factors.some(f => f.source === 'luck_self_view'), 'a retired source never fires');
  assert.equal(v.capped, true);
  assert.equal(v.multiplier, 1 + pricing.PLAYER_VALUATION_CAP);
  assert.equal(v.their_value, 1000 * (1 + pricing.PLAYER_VALUATION_CAP));
});

test('G1d: the package cap is unchanged — a three-player package cannot stack three premiums', () => {
  const hayden = layerFor(21).get('2');
  const pkg = ['Hot Hype', 'Quiet Star', 'Bench Guy']
    .map(n => PLAYERS.find(p => p.name === n));
  const priced = pricing.perceivedValue(pkg, hayden);
  assert.ok(Math.abs(priced.multiplier - 1) <= pricing.PERCEPTION_CAP + 1e-9);
  // And the serialised map view answers the same as the layer it came from: a
  // page holding one must not be able to quote a different number.
  const view = mapFor(21).managers.get('2');
  assert.equal(pricing.perceivedValue(pkg, { ...hayden, needs: view.needs, surplus: view.surplus }).multiplier,
    priced.multiplier);
});

test('G1e: the same evidence is never charged twice — a talk read replaces the raw gap', () => {
  const map = mapFor(21);
  const hayden = map.managers.get('2');
  // Hot Hype: Hayden praises him AND he is +6/game over expectation -> one read, not two.
  const hot = factorNames(byName(hayden, 'Hot Hype'));
  assert.ok(hot.includes('talk_vs_model'), 'the crossed read must fire');
  assert.ok(!hot.includes('outscoring_usage'),
    'the expectation gap is the read\'s own discriminator — charging it again double-counts it');
  assert.ok(!hot.includes('chat_sentiment'),
    'raw sentiment is the fallback for the same evidence, not an addition to it');

  // Silent Riser: Carl owns him, he is just as hot, and nobody has ever discussed him.
  const carl = map.managers.get('3');
  const riser = factorNames(byName(carl, 'Silent Riser'));
  assert.ok(riser.includes('outscoring_usage'),
    'with no talk read the expectation gap is the only thing that prices him');
});

// ====================================================== G2 provenance and n
test('G2a: every factor names a real source and carries n, cap and whether it is fitted', () => {
  const map = mapFor(21);
  const keys = new Set(Object.keys(pricing.VALUATION_SOURCES));
  let total = 0;
  for (const m of map.managers.values()) {
    for (const v of m.players.values()) {
      for (const f of v.factors) {
        assert.ok(keys.has(f.source), `${f.source} is not a declared source`);
        assert.equal(typeof f.label, 'string');
        assert.equal(typeof f.why, 'string');
        assert.ok(f.why.length > 0, `${f.source} must say why`);
        assert.ok(Number.isFinite(f.n), `${f.source} must carry its sample size`);
        assert.equal(f.fitted, false, 'no multiplier in this map is fitted yet — it must say so');
        total++;
      }
    }
  }
  assert.ok(total > 0);
});

test('G2b: a source under its minimum sample is reported inert with its reason, not dropped', () => {
  const map = mapFor(21);
  // Carl's luck is as extreme as Hayden's but rests on ONE scored week.
  const carl = map.managers.get('3');
  const hayden = map.managers.get('2');
  // Four scored weeks clears min_n, but luck_self_view is retired (cap 0, r46
  // IDEA-103), so the sample is enough and the price still does not move.
  assert.ok(!factorNames(byName(hayden, 'Quiet Star')).includes('luck_self_view'),
    'a retired source prices nothing even with enough weeks');
  const riser = byName(carl, 'Silent Riser');
  assert.ok(!factorNames(riser).includes('luck_self_view'), 'one week of luck must not price anything');
  const inert = (riser.inert ?? []).find(i => i.source === 'luck_self_view');
  assert.ok(inert, 'the map must say the luck read exists and is not firing');
  // The sentence the min_n branch writes, whole. A pattern loose enough to take
  // "1 week" or "below" would pass on a reason that named neither the sample it
  // has nor the sample it needs.
  assert.equal(inert.reason, 'rests on 1 of the 4 needed (scored weeks in the archetype build)');
});

test('G2c: the source registry is the contract — caps, minimum samples and what each needs', () => {
  for (const [key, s] of Object.entries(pricing.VALUATION_SOURCES)) {
    // A cap of 0 is allowed only on a source that was tested and killed, and it
    // must say so: a zero cap without the verdict is a term silently switched off.
    if (s.tested) {
      assert.equal(s.cap, 0, `${key}: a retired source prices nothing`);
      assert.match(s.tested, /^dead \(.+, \d{4}-\d{2}-\d{2}\)$/, `${key}: the verdict names its test and date`);
      assert.match(s.why, /tested and killed/, `${key}: its reason says it was tested and killed`);
    } else {
      assert.ok(s.cap > 0 && s.cap <= 0.15, `${key}: cap out of range`);
    }
    assert.ok(Number.isFinite(s.min_n) && s.min_n >= 1, `${key}: needs a minimum sample`);
    assert.equal(typeof s.label, 'string');
    assert.equal(typeof s.needs, 'string');
    assert.equal(s.fitted, false);
  }
  assert.ok(pricing.PLAYER_VALUATION_CAP >= pricing.PERCEPTION_CAP,
    'a single player may move further than a whole package, never less');
});

// ============================================================ G3 cutoff safety
test('G3: a week-w map never reads week-w data', () => {
  // Week WEEK carries a 60-point explosion for Silent Riser. A week-WEEK map may
  // not see it; a week-(WEEK+1) map must, which is what proves the boundary is
  // the cutoff and not simply a missing row.
  const now = byName(mapFor(21).managers.get('3'), 'Silent Riser');
  const gapNow = now.factors.find(f => f.source === 'outscoring_usage');
  assert.ok(gapNow, 'the gap read must be firing at all for this to mean anything');
  assert.equal(gapNow.n, WEEK - 1, 'the gap may only rest on the weeks before this one');

  const next = pricing.valuationMap(21, { season: SEASON, week: WEEK + 1, players: PLAYERS, rosterContext: NEEDS });
  const gapNext = byName(next.managers.get('3'), 'Silent Riser').factors.find(f => f.source === 'outscoring_usage');
  assert.equal(gapNext.n, WEEK, 'a week later the same read sees one more week — the cutoff moved, not the data');
});

// ========================================================== G4 degradation
test('G4a: a league with no chat still gets a map, and names the sources it does not have', () => {
  const map = mapFor(22);
  assert.equal(map.available, true);
  assert.ok(map.managers.size > 0);
  for (const s of ['chat_sentiment', 'talk_vs_model', 'profile_roster_read', 'untouchable_credibility']) {
    const absent = map.sources_absent.find(a => a.source === s);
    assert.ok(absent, `${s} must be listed as absent, with a reason`);
    assert.match(absent.reason, /chat/i);
  }
  // Luck used to be the source this league "does have"; it is retired (r46
  // IDEA-103), so the map names it absent with the verdict. outscoring_usage is
  // the chat-free source that still fires here.
  assert.ok(map.sources_used.includes('outscoring_usage'), 'the sources it does have must still fire');
  assert.ok(!map.sources_used.includes('luck_self_view'), 'a retired source is never used');
  assert.match(map.sources_absent.find(a => a.source === 'luck_self_view')?.reason ?? '',
    /^retired: tested dead \(r46 IDEA-103/);
  const hayden = map.managers.get('2');
  assert.ok(factorNames(hayden.players.get('hot hype')).length > 0,
    'a chat-free league must still price differently from ours where it has evidence');
});

test('G4b: a league with no manager data says so instead of inventing a map', () => {
  const map = mapFor(23);
  assert.equal(map.available, false);
  assert.equal(map.managers.size, 0);
  // One producer, one sentence: counterparty-pricing.js's `empty(...)` call for
  // a league with no signal rows. It names the script that would build them,
  // which is the whole value of the sentence and the part a looser pattern drops.
  assert.equal(map.reason,
    'no manager signals for this league yet — scripts/build-manager-signals.mjs has not built it');
});

test('G4c: the chat league lists its chat sources as used', () => {
  const map = mapFor(21);
  assert.equal(map.available, true);
  for (const s of ['talk_vs_model', 'profile_roster_read', 'untouchable_credibility']) {
    assert.ok(map.sources_used.includes(s), `${s} must be reported as in use`);
  }
});

test('G4d: a manager without a priced universe is refused, not guessed at', () => {
  const map = pricing.valuationMap(21, { season: SEASON, week: WEEK, rosterContext: NEEDS });
  assert.equal(map.available, false);
  assert.match(map.reason, /player/i);
});

// ============================================== the sources actually do their job
test('the positional-need read raises what a manager pays at a position he is short', () => {
  const map = mapFor(21);
  const hayden = map.managers.get('2'); // needs QB, surplus RB
  const qb = byName(hayden, 'Nobody Talks'); // a QB he does not own
  const need = qb.factors.find(f => f.source === 'positional_need');
  assert.ok(need, 'a hole at the position must price a player he could fill it with');
  assert.ok(need.effect > 0);
  assert.ok(qb.their_value > qb.our_value);
});

test('RL-19-1: off by default, positional_need still charges the incumbent 8% cap '
  + 'and still discounts depth', () => {
  delete process.env.GRIDIRON_RL19_1_ENABLED;
  delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  const map = mapFor(21);
  const hayden = map.managers.get('2'); // needs QB, surplus RB
  const need = byName(hayden, 'Nobody Talks').factors.find(f => f.source === 'positional_need');
  assert.equal(need.effect, 0.08, 'the served default has not moved');
  const rb = byName(hayden, 'Keeper Guy'); // a RB Hayden does not own, and is surplus at
  const depth = rb.factors.find(f => f.source === 'positional_need');
  assert.ok(depth, 'depth must still price off the flag');
  assert.equal(depth.effect, -0.04, 'depth still discounts at -cap*0.5 off the flag');
});

test('RL-19-1: on the flag, positional_need caps at 0.02 and drops the depth discount', () => {
  process.env.GRIDIRON_RL19_1_ENABLED = '1';
  try {
    const map = mapFor(21);
    const hayden = map.managers.get('2');
    const need = byName(hayden, 'Nobody Talks').factors.find(f => f.source === 'positional_need');
    assert.ok(need, 'a hole at the position still prices, just smaller');
    assert.ok(need.effect <= 0.02 + 1e-9, `cap must be <= 0.02 on the flag, got ${need.effect}`);
    assert.equal(need.effect, 0.02);
    // Whatever this manager is surplus at must carry no positional_need factor
    // at all under the flag — the depth branch is removed, not just shrunk.
    for (const [, v] of hayden.players) {
      const f = v.factors.find(fx => fx.source === 'positional_need');
      if (f) assert.ok(f.effect > 0, 'no negative (depth) positional_need factor may be served under the flag');
    }
  } finally {
    delete process.env.GRIDIRON_RL19_1_ENABLED;
  }
});

test('a declared untouchable whose word has held costs more, and a bluffer\'s does not', () => {
  const map = mapFor(21);
  const star = byName(map.managers.get('2'), 'Quiet Star');
  const cred = star.factors.find(f => f.source === 'untouchable_credibility');
  assert.ok(cred, 'Hayden declared Quiet Star untouchable three times and never reversed');
  assert.ok(cred.effect > 0, 'a refusal that holds makes the player more expensive, never cheaper');
  // A player nobody has declared carries no such factor at all.
  assert.ok(!factorNames(byName(map.managers.get('2'), 'Bench Guy')).includes('untouchable_credibility'));
});

test('G10: with the corpus off the machine, a refusal is not priced as a refusal that held', () => {
  // THE DEPLOYED APP IS THIS CASE. `manager_player_view` lives in the app
  // database and survives; the declaration RECORD that says whether his refusals
  // hold lives in the Mac-only chat corpus and does not. So `declarationCredibility()`
  // comes back `available: false`, `untouchableStance` finds no entry for him, and
  // falls back to the prior 1 - PRIOR_BLUFF_RATE = 0.65 — which clears the 0.45
  // bar, lands him in `probe`, and PRICES the player up on a sentence that says
  // his word has held. Nothing about his word was ever read.
  const saved = process.env.GRIDIRON_CHAT_DB_PATH;
  process.env.GRIDIRON_CHAT_DB_PATH = path.join(os.tmpdir(), 'gridiron-vm-no-corpus.sqlite');
  try {
    const map = pricing.valuationMap(21, { season: SEASON, week: WEEK, players: PLAYERS, rosterContext: NEEDS });
    const star = byName(map.managers.get('2'), 'Quiet Star');
    const priced = (star?.factors ?? []).find(f => f.source === 'untouchable_credibility');
    assert.equal(priced, undefined,
      'an unread declaration record must not price a player as a refusal that held');
    const inert = (star?.inert ?? []).find(i => i.source === 'untouchable_credibility');
    assert.ok(inert, 'and it must be reported as not firing, not silently dropped');
    assert.match(inert.reason, /the chat corpus is not on this machine/,
      `the reason must name THIS absence — we asked and could not read it — got ${JSON.stringify(inert?.reason)}`);
    assert.doesNotMatch(inert.reason, /no confirmed chat identity/,
      'and it must not be the other absence, where no lookup was ever attempted');
  } finally { process.env.GRIDIRON_CHAT_DB_PATH = saved; }
  // And the fixture is restored: with the corpus present it prices again.
  const back = byName(mapFor(21).managers.get('2'), 'Quiet Star');
  assert.ok(back.factors.find(f => f.source === 'untouchable_credibility'),
    'the corpus is back and the measured refusal prices again');
});

test('G10b: with no trusted chat identity, a refusal is not priced either', () => {
  // THE OTHER HALF OF G10, and the one G10 missed. G10 covers the corpus being
  // absent, where declarationCredibility() answers `available: false`. This is
  // the case where the corpus is fine and there is no CONFIRMED identity for this
  // manager, so counterparty-pricing never asks at all: `identityMap(league).size`
  // is 0, `credibility` is null, and `declarations_read` was neither true nor
  // false.
  //
  // untouchableStance still finds his declarations — manager_player_view lives in
  // the app database — and with no credibility entry it falls back to
  // 1 - PRIOR_BLUFF_RATE = 0.65, which clears the 0.45 bar, lands him in `probe`
  // and prices the player up under the sentence "his word holds only 65% of the
  // time". Nothing about his word was read. "We asked and could not read it" and
  // "we never asked" are two absences and both must refuse to price.
  //
  // League 22 has no identity rows (matchIdentities(22, { chatNames: [] })), so
  // seeding his declarations here is the whole reproduction.
  run(`INSERT OR REPLACE INTO manager_player_view
         (league_id, roster_id, player_name, sentiment, n, last_mention, source)
       VALUES (22, '2', 'hot hype', 3.6, 6, date('now', '-2 days'), 'chat')`);
  try {
    const map = pricing.valuationMap(22, { season: SEASON, week: WEEK, players: PLAYERS, rosterContext: NEEDS });
    const hype = byName(map.managers.get('2'), 'Hot Hype');
    assert.ok(hype, 'his own player is in the map');
    const priced = (hype.factors ?? []).find(f => f.source === 'untouchable_credibility');
    assert.equal(priced, undefined,
      'a declaration record nobody looked up must not price a player as a refusal that held');
    const inert = (hype.inert ?? []).find(i => i.source === 'untouchable_credibility');
    assert.ok(inert, 'and it must be reported as not firing, not silently dropped');
    assert.match(inert.reason, /no confirmed chat identity for him/,
      `the reason must name THIS absence — nobody ever looked him up — got ${JSON.stringify(inert?.reason)}`);
    assert.doesNotMatch(inert.reason, /not on this machine/,
      'and it must not be the other absence, where the corpus was asked for and was missing');
  } finally {
    run(`DELETE FROM manager_player_view WHERE league_id = 22 AND player_name = 'hot hype'`);
  }
});

test('G10d: the mixed league — his roster is unconfirmed while the rest are not', () => {
  // THE CASE A LEAGUE-LEVEL FLAG CANNOT SEE, and the reason the guard reads the
  // credibility RECORD rather than a flag beside it. League 21 has a corpus and a
  // working credibility map; roster 4 (Danny Echo) has no confirmed identity row,
  // so untouchableStance finds no entry for HIM and falls back to the prior while
  // `declarations_read` for the league is perfectly true.
  //
  // Without this the mixed league is the one shape nothing covers: every test has
  // either all rosters confirmed or none, so a guard that keys on the league flag
  // passes them all and still prices a refusal nobody read.
  run(`INSERT OR REPLACE INTO manager_player_view
         (league_id, roster_id, player_name, sentiment, n, last_mention, source)
       VALUES (21, '4', 'nobody talks', 3.6, 6, date('now', '-2 days'), 'chat')`);
  try {
    const danny = pricing.valuationMap(21,
      { season: SEASON, week: WEEK, players: PLAYERS, rosterContext: NEEDS }).managers.get('4');
    assert.ok(danny, 'the unconfirmed manager is still in the map');
    const nobody = byName(danny, 'Nobody Talks');
    const priced = (nobody?.factors ?? []).find(f => f.source === 'untouchable_credibility');
    assert.equal(priced, undefined,
      'his word was never read, whatever the rest of the league\'s identities say');
    const inert = (nobody?.inert ?? []).find(i => i.source === 'untouchable_credibility');
    assert.ok(inert, 'and it is reported inert with its reason');

    // And the confirmed manager in the SAME league still prices, so the guard is
    // per-manager and not a switch that turned the source off for everyone.
    const star = byName(pricing.valuationMap(21,
      { season: SEASON, week: WEEK, players: PLAYERS, rosterContext: NEEDS }).managers.get('2'), 'Quiet Star');
    assert.ok((star?.factors ?? []).find(f => f.source === 'untouchable_credibility'),
      'the manager whose record WAS read still prices in the same league');
  } finally {
    run(`DELETE FROM manager_player_view WHERE league_id = 21 AND player_name = 'nobody talks'`);
  }
});

test('G10c: the two unread-declaration absences do not share one sentence', () => {
  // The rule the whole as-of family rests on: an absence must say WHICH absence
  // it is. If "the corpus is not on this machine" and "there is no confirmed
  // identity for him" read alike, a reader fixes the wrong one — one is a machine,
  // the other is a name Nick never confirmed.
  run(`INSERT OR REPLACE INTO manager_player_view
         (league_id, roster_id, player_name, sentiment, n, last_mention, source)
       VALUES (22, '2', 'hot hype', 3.6, 6, date('now', '-2 days'), 'chat')`);
  const saved = process.env.GRIDIRON_CHAT_DB_PATH;
  try {
    const noIdentity = (byName(pricing.valuationMap(22,
      { season: SEASON, week: WEEK, players: PLAYERS, rosterContext: NEEDS }).managers.get('2'), 'Hot Hype')
      .inert ?? []).find(i => i.source === 'untouchable_credibility');

    process.env.GRIDIRON_CHAT_DB_PATH = path.join(os.tmpdir(), 'gridiron-vm-no-corpus-2.sqlite');
    const noCorpus = (byName(pricing.valuationMap(21,
      { season: SEASON, week: WEEK, players: PLAYERS, rosterContext: NEEDS }).managers.get('2'), 'Quiet Star')
      .inert ?? []).find(i => i.source === 'untouchable_credibility');

    assert.ok(noIdentity && noCorpus, 'both absences report the source inert');
    assert.notEqual(noIdentity.reason, noCorpus.reason,
      'an unconfirmed identity and an absent corpus are different absences');
  } finally {
    process.env.GRIDIRON_CHAT_DB_PATH = saved;
    run(`DELETE FROM manager_player_view WHERE league_id = 22 AND player_name = 'hot hype'`);
  }
});

test('the negotiation profile\'s own over/undervalues list reaches the price', () => {
  const map = mapFor(21);
  const hayden = map.managers.get('2');
  const over = byName(hayden, 'Hot Hype').factors.find(f => f.source === 'profile_roster_read');
  assert.ok(over, 'the Sonnet read names Hot Hype as something he overvalues');
  assert.ok(over.effect > 0);
  const under = byName(hayden, 'Bench Guy').factors.find(f => f.source === 'profile_roster_read');
  assert.ok(under && under.effect < 0, 'and Bench Guy as something he undervalues');
});

test('a profile that says it is unsure moves the price less than one that is sure', () => {
  // 5 of the 10 real profiles came back `confidence: low`. A named player from
  // one of those must not be priced as hard as a named player from Raj's, which
  // came back `high` — the model's own statement about itself is evidence.
  const base = {
    roster_id: '9', receptiveness: 1, roster_size: 3, owned: new Set(['plain guy']),
    players: new Map(), reads: new Map(), gaps: new Map(), negotiation_n: 200,
    needs: new Set(), surplus: new Set(), luck: null, stance: null,
  };
  const withConfidence = c => pricing.playerValuation({ ...base,
    negotiation: { confidence: c, roster_read: { overvalues: ['Plain Guy'], undervalues: [],
      really_untouchable: [], quietly_available: [] } } },
  { name: 'Plain Guy', position: 'WR', value: 1000 })
    .factors.find(f => f.source === 'profile_roster_read').effect;

  const hi = withConfidence('high'), med = withConfidence('medium'), lo = withConfidence('low');
  assert.equal(hi, pricing.VALUATION_SOURCES.profile_roster_read.cap, 'a high-confidence read earns the whole cap');
  assert.ok(hi > med && med > lo && lo > 0, `expected high > medium > low > 0, got ${hi}/${med}/${lo}`);
  assert.equal(withConfidence(undefined), lo, 'a profile that does not state its confidence is treated as the weakest');
});

test('a manager who just lost is easier to reach — reported on the manager, not on a player', () => {
  const layer = layerFor(21);
  const hayden = layer.get('2'); // lost by 50 in the last decided week, 3-game losing streak
  const carl = layer.get('3');
  const post = hayden.receptiveness_factors.find(f => f.source === 'recency_post_loss');
  assert.ok(post, 'the post-loss window is a receptiveness read, not a valuation of a player');
  assert.ok(post.effect > 0);
  assert.ok(Math.abs(post.effect) <= pricing.VALUATION_SOURCES.recency_post_loss.cap + 1e-9);
  assert.ok(hayden.receptiveness > carl.receptiveness,
    'the manager who just lost badly should be the easier one to reach');
});

// ==================================================== G5 how Nick looks
test('G5a: how Nick looks — his offers to each manager, with how they answered', () => {
  const self = pricing.selfRead(21, { season: SEASON, week: WEEK });
  assert.equal(self.available, true);
  assert.equal(String(self.my_roster_id), '1');
  const hay = self.to_each_manager.get('2');
  assert.equal(hay.offers_sent, 3, 'three offers sent to Hayden — a received offer is not one of his');
  assert.equal(hay.declined, 2);
  assert.equal(hay.accepted, 1);
  assert.equal(hay.last_offer_at, '2026-09-14T00:00:00Z');
  assert.equal(hay.source, 'tx');
  const carl = self.to_each_manager.get('3');
  assert.equal(carl.offers_sent, 1);
  assert.equal(carl.declined + carl.accepted, 0, 'a pending offer is neither');
});

test('G5b: how Nick looks — what the league knows he is shopping, by source', () => {
  const self = pricing.selfRead(21, { season: SEASON, week: WEEK });
  const shopped = self.known_shopping.find(s => /shopped man/i.test(s.player));
  assert.ok(shopped, 'the player he has talked down 9 times is the one the league knows about');
  assert.ok(['chat', 'profile', 'chat+profile'].includes(shopped.source));
  assert.ok(Number.isFinite(shopped.n));
  assert.ok(!self.known_shopping.some(s => /keeper guy/i.test(s.player)),
    'a player he has never discussed is not something the league knows');
});

test('G5b2: a profile entry that is not a player never becomes one', () => {
  // Found on the real league-4 corpus 2026-09-18: the `ME` profile's
  // quietly_available list contains the prose entry "Olave-adjacent throw-ins
  // when he had him", which the first version of selfRead reported to Nick as a
  // player he is known to be shopping.
  const self = pricing.selfRead(21, { season: SEASON, week: WEEK });
  for (const s of self.known_shopping) {
    assert.ok(PLAYERS.some(p => p.name.toLowerCase() === s.player.toLowerCase()),
      `"${s.player}" is not a player — a prose line in a profile must not be listed as one`);
  }
  assert.ok(self.known_shopping.some(s => s.player === 'Shopped Man'),
    'and the real name in the same list must survive the check');
});

test('G5c: how Nick looks — the veto votes cast against his deals', () => {
  const self = pricing.selfRead(21, { season: SEASON, week: WEEK });
  assert.equal(self.veto_votes_against, 2);
  assert.deepEqual(self.veto_voters.map(v => String(v.roster_id)).sort(), ['3', '4']);
});

test('G5d: Nick is never a counterparty in his own league\'s map', () => {
  const map = mapFor(21);
  assert.ok(!map.managers.has('1'), 'his own roster must not be priced as somebody to trade with');
  assert.equal(String(map.my_roster_id), '1');
});

test('G5e: a league with no transactions and no chat says what it does not know', () => {
  const self = pricing.selfRead(23, { season: SEASON, week: WEEK });
  assert.equal(self.available, false);
  assert.ok(self.reason.length > 0);
  assert.equal(self.to_each_manager.size, 0);
});

/**
 * G5e asserts `reason.length > 0`, which is true of any sentence at all. The
 * sentence it actually gets is a positive claim about the league — "no captured
 * transactions for this league and no chat corpus" — and until 2026-09-22
 * `selfRead` made that claim on three different states, because
 * `catch { tx = []; }` turned "I could not look" into "there is nothing here".
 *
 * This is not hypothetical. `league_transactions_raw` is in no migration: it is
 * created by `scripts/collect-league-transactions.mjs` and nowhere else. On any
 * database where that hand-run capture has never run, the table does not exist,
 * the read throws, and Nick was told his league has no transaction history when
 * in fact nobody had ever collected it.
 *
 * Driven through raw SQL: no writer here can leave the table unreadable.
 */
test('G5e2: "no captured transactions" is a claim about the league, not about a read that failed', () => {
  const live = pricing.selfRead(23, { season: SEASON, week: WEEK });
  assert.equal(live.available, false);
  assert.match(live.reason, /no captured transactions/,
    'the table is there and it read, so G5e\'s sentence is true here');

  const absent = withTableReplaced({ rows, run }, 'league_transactions_raw', null,
    () => pricing.selfRead(23, { season: SEASON, week: WEEK }));
  const unreadable = withTableReplaced({ rows, run }, 'league_transactions_raw',
    'CREATE TABLE league_transactions_raw (league_id INTEGER NOT NULL)',
    () => pricing.selfRead(23, { season: SEASON, week: WEEK }));

  // The sentences first, because they are what Nick reads.
  assert.doesNotMatch(absent.reason, /no captured transactions for this league/,
    'the capture has never run against this database, which is a different fact about a '
    + 'different thing and the one he can act on');
  assert.doesNotMatch(unreadable.reason, /no captured transactions for this league/,
    'the table is there and would not read; telling him his league has no history is false');
  assert.notEqual(absent.reason, unreadable.reason,
    'a table nobody has ever built and a table that will not read are two different states, '
    + 'and one sentence for both sends him to fix the wrong one');

  // And the state each one is in, carried out with the answer.
  assert.equal(live.tx_read_state, 'read');
  assert.equal(absent.tx_read_state, 'absent');
  assert.equal(unreadable.tx_read_state, 'unreadable');

  assert.equal(pricing.selfRead(23, { season: SEASON, week: WEEK }).reason, live.reason,
    'the table must come back exactly as it was');
});

/**
 * The quieter half of the same defect. When something else IS available the
 * function returns `available: true` and `reason: null`, so the empty offer
 * history goes out with nothing attached to it — "he has sent nobody anything"
 * and "we could not read what he sent" are the same answer to a caller.
 */
test('G5e3: an offer history that could not be read is not an empty offer history', () => {
  const live = pricing.selfRead(21, { season: SEASON, week: WEEK });
  assert.equal(live.available, true);
  assert.ok(live.to_each_manager.size > 0, 'league 21 must have offers, or this pins nothing');
  assert.equal(live.tx_read_state, 'read');

  const blind = withTableReplaced({ rows, run }, 'league_transactions_raw',
    'CREATE TABLE league_transactions_raw (league_id INTEGER NOT NULL)',
    () => pricing.selfRead(21, { season: SEASON, week: WEEK }));
  assert.equal(blind.available, true, 'the chat corpus is still there, so the read is still available');
  assert.equal(blind.to_each_manager.size, 0, 'and it carries no offers');
  assert.equal(blind.tx_read_state, 'unreadable',
    'which is indistinguishable from a manager who has sent nothing, unless the read says which it is');

  assert.equal(pricing.selfRead(21, { season: SEASON, week: WEEK }).to_each_manager.size,
    live.to_each_manager.size, 'the table must come back exactly as it was');
});

// ====================================================== G7 the ablation hook
test('G7: zeroing a source removes exactly that source and changes the price', () => {
  const full = mapFor(21);
  const without = mapFor(21, { zero: ['profile_roster_read'] });
  const a = byName(full.managers.get('2'), 'Hot Hype');
  const b = byName(without.managers.get('2'), 'Hot Hype');
  assert.ok(factorNames(a).includes('profile_roster_read'));
  assert.ok(!factorNames(b).includes('profile_roster_read'));
  assert.notEqual(a.multiplier, b.multiplier, 'a source that changes nothing is not a source');
  assert.deepEqual(factorNames(b), factorNames(a).filter(s => s !== 'profile_roster_read'),
    'zeroing one source must not disturb the others');
});

test('G7b: the manager-level source can be zeroed too, or the ablation has a hole', () => {
  const on = layerFor(21).get('2');
  const offLayer = layerFor(21, { zero: ['recency_post_loss'] }).get('2');
  assert.ok(on.receptiveness_factors.some(f => f.source === 'recency_post_loss'));
  assert.ok(!offLayer.receptiveness_factors.some(f => f.source === 'recency_post_loss'));
  assert.ok(on.receptiveness > offLayer.receptiveness,
    'the post-loss window must actually be worth something in receptiveness');
});

// ======================================== one source of truth for the deal read
test('readDeal prices through the same valuation map the manager view shows', () => {
  const layer = layerFor(21);
  const hayden = layer.get('2');
  const give = [PLAYERS.find(p => p.name === 'Hot Hype')];
  const get = [PLAYERS.find(p => p.name === 'Shopped Man')];
  const read = pricing.readDeal({ theirGive: give, theirGet: get, managerProfile: hayden });
  assert.equal(read.perception_informed, true);
  const reason = read.perception_reasons.find(r => /hot hype/i.test(r.player));
  assert.ok(reason, 'the deal read must name the player it repriced');
  assert.ok(Array.isArray(reason.factors) && reason.factors.length > 0,
    'and carry the same named factors the map shows, not a bare multiplier');
  const mapped = byName(mapFor(21).managers.get('2'), 'Hot Hype');
  assert.equal(reason.multiplier, mapped.multiplier,
    'the deal read and the valuation map must not be able to disagree');
});

// ============================================ G9 a source that is not firing
// The header promises that "a source below its minimum sample is reported INERT
// WITH A REASON rather than dropped". G2b proves that for a reading that exists
// and is too small a sample. These four cover the states G2b does not reach, in
// which the served object says nothing at all — or, worse, says something false.
//
// League 24 is a league with managers and signals and NO archetype rows, which
// is the live shape of four of Nick's five leagues.
insertLeague(24, {
  members: [member(NICK, 'Nick', 'Matta'), member(HAY, 'Hayden', 'Brook')],
  teams: [team(1, NICK, { wins: 2, losses: 2, pf: 440, entries: [rosterEntry(701, 'Shopped Man')] }),
    team(2, HAY, { wins: 2, losses: 2, pf: 440, entries: [rosterEntry(712, 'Quiet Star')] })],
  schedule: [{ matchupPeriodId: 4, home: { teamId: 1, totalPoints: 100 },
    away: { teamId: 2, totalPoints: 99 }, winner: 'HOME' }],
}, { name: 'VM24 no archetypes' });
identity.matchIdentities(24, { chatNames: [] });
signals.buildManagerSignals(24, { chat: null });

const NEEDS_24 = new Map([
  ['1', { needs: new Set(), surplus: new Set(), window: 'contend' }],
  ['2', { needs: new Set(), surplus: new Set(), window: 'contend' }],
]);
const ownerOf = (extra = {}) => ({
  roster_id: '2', receptiveness: 1, roster_size: 3, owned: new Set(['quiet star']),
  players: new Map(), reads: new Map(), gaps: new Map(),
  needs: new Set(), surplus: new Set(), stance: null, negotiation: null, ...extra,
});
const QUIET_STAR = { name: 'Quiet Star', position: 'RB', value: 1200 };
const inertFor = (prof, source) => (pricing.playerValuation(prof, QUIET_STAR).inert ?? [])
  .find(i => i.source === source) ?? null;

test('G9a: a manager with no luck reading at all is reported, not passed over in silence', () => {
  // The archetype build produces no luck row for him — the week-2 case for four
  // of five live leagues. `luck: null` short-circuits the branch before `add` is
  // ever called, so nothing reaches `inert` and the page has no sentence to say.
  // "We have never measured his luck" and "we measured it and it says nothing"
  // are different facts and a reader acts on the second.
  const inert = inertFor(ownerOf({ luck: null }), 'luck_self_view');
  assert.ok(inert, 'a source with no reading must still be named as not firing');
  assert.equal(inert.reason, 'rests on 0 of the 4 needed (scored weeks in the archetype build)',
    'the reason must name the sample it has AND the sample it needs, not one of the two');
});

test('G9b: a reading below its sample is reported even when its effect rounds small', () => {
  // `add` returns on |effect| < 0.001 BEFORE it checks min_n, so smallness wins
  // over provenance: 0.05 * (0.01 / 2) = 0.00025. The reading is real, the
  // sample is one week, and the page is told nothing about either.
  const inert = inertFor(ownerOf({ luck: { value: 0.01, n: 1 } }), 'luck_self_view');
  assert.ok(inert, 'a real reading on too small a sample must be reported inert whatever its size');
  assert.equal(inert.reason, 'rests on 1 of the 4 needed (scored weeks in the archetype build)',
    'one week reads as one of four, not as a sentence that merely mentions weeks');
});

test('G9c: a manager exactly at expectation is a luck reading, not a missing one', () => {
  // value 0 is the most confident reading there is — his record is precisely
  // what his scores earn. It is also the one that disappears entirely.
  const inert = inertFor(ownerOf({ luck: { value: 0, n: 1 } }), 'luck_self_view');
  assert.ok(inert, 'a reading of exactly zero is a reading');
});

test('G9d: a league with no archetype rows is not told the data exists', () => {
  // valuationMap's last branch is an else: a source that is neither used, nor
  // chat-blocked, nor inert, nor positional_need is reported as "the data exists
  // but no player in this league matched it". For luck in a league with no
  // archetype rows that sentence is false in both halves.
  const map = pricing.valuationMap(24, { season: SEASON, week: WEEK, players: PLAYERS, rosterContext: NEEDS_24 });
  assert.equal(map.available, true, 'league 24 has signals, so it gets a map');
  assert.ok(!map.sources_used.includes('luck_self_view'), 'nothing can be pricing on luck here');
  const absent = map.sources_absent.find(a => a.source === 'luck_self_view');
  assert.ok(absent, 'luck must be listed as absent');
  assert.doesNotMatch(absent.reason, /the data exists/i,
    `a league with no archetype rows must not be told the data exists, got ${JSON.stringify(absent.reason)}`);
  // The source is retired now, and that verdict outranks the missing sample:
  // "0 of 4" would read as "wait for week 5", and week 5 will change nothing.
  assert.equal(absent.reason, 'retired: tested dead (r46 IDEA-103, 2026-09-24); it prices nothing',
    'a retired source names its verdict, not a sample it will never use');
});

test('G9g: the priced luck term says when the store behind it was built', () => {
  // `luck_self_view` is a TERM IN THE PRICE, and it comes from manager_archetypes,
  // which is written only by scripts/build-manager-archetypes.mjs — by hand,
  // off-server. A stale luck read priced into a trade is worse than a stale card,
  // because nothing on the card says the number moved the money.
  const layer = layerFor(21);
  const hayden = layer.get('2');
  assert.ok(hayden.archetypes, 'the manager entry carries the archetype build block');
  assert.equal(hayden.archetypes.as_of, ARCH_BUILT_AT,
    'as_of is the NEWEST build stamp in the store for this league-season');
  assert.match(hayden.archetypes.collected_by, /build-manager-archetypes\.mjs/);
  // And on the reading itself, which is what playerValuation is handed.
  assert.equal(hayden.luck.as_of, ARCH_BUILT_AT,
    'the luck reading carries the stamp of the build that produced it');

  // Through to the priced factor. This is the assertion the item was about; the
  // per-player valuations live on the MAP, not on the layer entry (whose
  // `players` is the chat sentiment index).
  // luck_self_view is retired (r46 IDEA-103), so there is no priced term left to
  // carry the stamp; the layer-level assertions above still pin the reading.
  const priced = byName(mapFor(21).managers.get('2'), 'Quiet Star')
    .factors.find(f => f.source === 'luck_self_view');
  assert.equal(priced, undefined, 'a retired source leaves no priced term');
});

test('G9h: a luck read that is NOT firing still says how old the store is', () => {
  // The state the live app is actually in: week 2, one scored week, luck inert
  // league-wide until week 5. "Not enough weeks yet" and "not enough weeks as of
  // a build three days ago" are different answers, and only the second tells him
  // whether running the build would change it.
  const carl = mapFor(21).managers.get('3');
  const inert = (byName(carl, 'Silent Riser')?.inert ?? []).find(i => i.source === 'luck_self_view');
  assert.ok(inert, 'one week of luck is inert, per G2b');
  assert.equal(inert.as_of, ARCH_BUILT_AT, 'an inert entry carries the build date too');
});

test('G9i: a league with no archetype store at all is not given a build date', () => {
  // League 24 has signals but no archetype rows. A stamp here would be borrowed
  // from another league, which is the whole defect class this pass is closing.
  const layer = pricing.counterpartyLayer(24, { season: SEASON, week: WEEK, rosterContext: NEEDS_24 });
  const entry = [...layer.values()][0];
  assert.ok(entry.archetypes, 'the block is served even when the store is empty for this league');
  assert.equal(entry.archetypes.as_of, null, 'no rows for this league-season is null, never borrowed');
  assert.equal(entry.archetypes.rows, 0);
  assert.ok(typeof entry.archetypes.reason === 'string' && entry.archetypes.reason.length > 0);
});

test('G9e: zeroing a source still suppresses it completely — no factor and no inert entry', () => {
  // The regression pin for G9a-d. The ablation in the valuation-map report
  // depends on `zero` removing a source from the arithmetic ENTIRELY; if the
  // fixes above start emitting an inert entry for a zeroed source, every
  // "deals repriced" count in that table silently changes meaning.
  // A source with ENOUGH sample: zeroing it must remove the factor.
  const firing = pricing.playerValuation(ownerOf({ luck: { value: 1.6, n: 4 } }),
    QUIET_STAR, { zero: ['luck_self_view'] });
  assert.ok(!(firing.factors ?? []).some(f => f.source === 'luck_self_view'), 'zeroed: no factor');
  assert.ok(!(firing.inert ?? []).some(i => i.source === 'luck_self_view'), 'zeroed: and no inert entry');

  // The case that actually pins the ORDER, and the first version of this test
  // missed it. A sample of 4 is not below min_n of 4, so that profile never
  // reaches the inert branch at all and passes however the checks are ordered —
  // mutating `off.has` to sit after min_n killed nothing. Below the sample and
  // zeroed is the only state where the two compete.
  for (const luck of [{ value: 1.6, n: 1 }, { value: 0.01, n: 1 }, null]) {
    const off = pricing.playerValuation(ownerOf({ luck }), QUIET_STAR, { zero: ['luck_self_view'] });
    assert.ok(!(off.inert ?? []).some(i => i.source === 'luck_self_view'),
      `zeroed and below its sample (${JSON.stringify(luck)}): still no inert entry`);
    assert.ok(!(off.factors ?? []).some(f => f.source === 'luck_self_view'),
      `zeroed and below its sample (${JSON.stringify(luck)}): still no factor`);
  }
});

test('G9f: a reading with enough sample of a retired source prices nothing, silently', () => {
  // Was "still prices, unchanged". luck_self_view is retired (cap 0, r46
  // IDEA-103): cap * strength is 0, and `add` drops a zero effect above min_n
  // without an inert entry, because inert means "not enough evidence" and four
  // weeks is enough. The map-level verdict lives in sources_absent (G9d).
  const on = pricing.playerValuation(ownerOf({ luck: { value: 1.6, n: 4 } }), QUIET_STAR);
  assert.ok(!(on.factors ?? []).some(x => x.source === 'luck_self_view'), 'four scored weeks no longer prices');
  assert.ok(!(on.inert ?? []).some(i => i.source === 'luck_self_view'), 'and is not filed as inert either');
});

test('G9j: luck_self_view is retired — +3 wins over 6 scored weeks prices exactly as no luck reading', () => {
  // r46 IDEA-103 killed the term: a ~2-win luck gap moves at most ~1.1 pp of how
  // a manager values his own players. A strongly flattered record on a full
  // sample, against the same owner with no luck row at all, must give the same
  // total. The other sources are held on so the comparison is not 1 === 1.
  const base = {
    players: new Map([['quiet star', { sentiment: 4, n: 20, last: '2026-09-16', multiplier: 1.06 }]]),
  };
  const lucky = pricing.playerValuation(ownerOf({ ...base, luck: { value: 3, n: 6 } }), QUIET_STAR);
  const none = pricing.playerValuation(ownerOf({ ...base, luck: null }), QUIET_STAR);
  assert.ok(lucky.factors.length > 0, 'another source is firing, so the totals are not trivially equal');
  assert.equal(lucky.multiplier, none.multiplier, 'the luck term moves the multiplier by nothing');
  assert.equal(lucky.their_value, none.their_value, 'and the total by nothing');
  assert.equal(pricing.VALUATION_SOURCES.luck_self_view.tested, 'dead (r46 IDEA-103, 2026-09-24)');
});

// ======================================================= G11 the Jev model read
//
// `manager_archetype_jev` has existed since the archetype build shipped and
// NOTHING in the trade path read it. It holds a model's answers to exactly the
// questions the trade engine wants about a person — does he overvalue his own
// roster, does he counter or decline outright, does he sell low after a bad week
// — and the trade path priced without ever looking.
//
// It is brought in DISPLAYED, not priced, and these gates are what make that
// claim mean something:
//
//  G11a the block carries the stamp of the JEV pass, per manager, and that stamp
//       is neither the league's newest nor the archetype build's;
//  G11b `basis` travels, so an answer with no evidence under it cannot read as a
//       measurement of him;
//  G11c a flat answer is reported as carrying no information rather than as a
//       33% chance of something;
//  G11d deleting the whole store moves no price, multiplier, factor or
//       receptiveness — the guarantee that this added no weight;
//  G11e a manager the pass never covered and a store that was never built are
//       different absences with different sentences;
//  G11f the read travels with the PERSON, across leagues, because that is what
//       the store is keyed by.
//
// The stamps below are pinned and deliberately unequal to each other AND to
// ARCH_BUILT_AT. The Jev pass is opt-in (`--jev`, needs a gateway key) while the
// archetype build is not, so the two run at different times by design — reusing
// the archetype stamp here would be the exact substitution this family of
// accessors exists to prevent.
const JEV_EVAL_HAY = '2026-09-18T03:00:00.000Z';
const JEV_EVAL_CARL = '2026-09-19T04:30:00.000Z';   // the NEWEST in league 21
const JEV_MODEL = 'test-model-v1';

function insertJevFixture() {
  const ins = (memberId, question, outcome, probability, basis, evaluatedAt,
    { nSeasons = 3, nPicks = 45 } = {}) =>
    run(`INSERT OR REPLACE INTO manager_archetype_jev
           (member_id, question, outcome, probability, basis, n_seasons, n_picks, model, state_chars, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 4000, ?)`,
    memberId, question, outcome, probability, basis, nSeasons, nPicks, JEV_MODEL, evaluatedAt);

  // Hayden: one answer with evidence and a clear lean, two without evidence and
  // flat — which is the honest shape of the live store, where five of the eight
  // questions are `inference_only`.
  for (const [outcome, p] of Object.entries(
    { rb_heavy: 0.60, wr_heavy: 0.10, qb_early: 0.10, te_early: 0.10, balanced: 0.10 })) {
    ins(HAY, 'position_bias', outcome, p, 'draft', JEV_EVAL_HAY);
  }
  for (const [outcome, p] of Object.entries({ counters: 0.34, binary: 0.33, never: 0.33 })) {
    ins(HAY, 'trade_style', outcome, p, 'inference_only', JEV_EVAL_HAY);
  }
  ins(HAY, 'sells_low_after_bad_week', 'true', 0.5, 'inference_only', JEV_EVAL_HAY);
  // A boolean that DOES lean, and still has no evidence under it. Stored as its
  // 'true' leg alone, like every boolean in this store, so it is also the row
  // that catches a reader who forgets the other leg exists: 0.8 against a
  // missing 'false' is a one-outcome distribution, which has no spread at all.
  ins(HAY, 'buys_high', 'true', 0.8, 'inference_only', JEV_EVAL_HAY);
  // A score question, which stores a 'mean' summary BESIDE its per-level
  // probabilities. The summary is not an outcome and must not be ranked as one.
  ins(HAY, 'risk_appetite', 'mean', 3.2, 'draft', JEV_EVAL_HAY);
  for (const [outcome, p] of Object.entries({ 0: 0.05, 1: 0.10, 2: 0.15, 3: 0.30, 4: 0.40 })) {
    ins(HAY, 'risk_appetite', outcome, p, 'draft', JEV_EVAL_HAY);
  }

  // Carl: evaluated a day later than Hayden, so the newest stamp in the league
  // belongs to somebody else. A league-wide MAX() reported on Hayden's block
  // would print Carl's date under Hayden's name.
  for (const [outcome, p] of Object.entries(
    { rb_heavy: 0.15, wr_heavy: 0.55, qb_early: 0.10, te_early: 0.10, balanced: 0.10 })) {
    ins(CARL, 'position_bias', outcome, p, 'draft', JEV_EVAL_CARL, { nSeasons: 2, nPicks: 30 });
  }
  // Danny (roster 4 of league 21) is deliberately NOT evaluated.
}
insertJevFixture();

const jevOf = (leagueId, rosterId, opts = {}) => layerFor(leagueId, opts).get(rosterId).jev;
const answerFor = (block, question) => (block?.answers ?? []).find(a => a.question === question);

test('G11a: each manager\'s model read carries HIS OWN evaluation date', () => {
  const hay = jevOf(21, '2');
  assert.ok(hay, 'the manager entry carries the Jev block');
  assert.equal(hay.as_of, JEV_EVAL_HAY, 'his own stamp');
  assert.notEqual(hay.as_of, JEV_EVAL_CARL,
    'not the newest evaluation in the league — that one is somebody else\'s');
  assert.notEqual(hay.as_of, ARCH_BUILT_AT,
    'and not the archetype build\'s stamp: the Jev pass is a separate, opt-in process');
  assert.match(hay.evaluated_by, /--jev/, 'the block names what would refresh it');
  assert.equal(hay.model, JEV_MODEL, 'and which model answered');
  assert.equal(jevOf(21, '3').as_of, JEV_EVAL_CARL, 'and the other manager carries his');
});

test('G11b: an answer with no evidence under it cannot read as a measurement of him', () => {
  const hay = jevOf(21, '2');
  const bias = answerFor(hay, 'position_bias');
  const style = answerFor(hay, 'trade_style');
  assert.ok(bias && style, 'both answers are served');

  assert.equal(bias.basis, 'draft');
  assert.equal(bias.measured, true, 'the draft record bears on positional habit');
  assert.equal(style.basis, 'inference_only');
  assert.equal(style.measured, false,
    'the store holds no trades at all, so trade style is a prior and not a reading');

  assert.match(style.why, /prior/i, 'and the sentence says so in words, not just in a flag');
  assert.doesNotMatch(bias.why, /prior/i,
    'a measured answer must not be described as a prior — the two must not read alike');
  assert.notEqual(style.why, bias.why);
});

test('G11c: a flat answer is reported as carrying no information, not as a 33% chance', () => {
  const hay = jevOf(21, '2');
  const style = answerFor(hay, 'trade_style');
  const sells = answerFor(hay, 'sells_low_after_bad_week');
  const bias = answerFor(hay, 'position_bias');

  // 0.34/0.33/0.33 is what "spread the probability evenly" looks like when a
  // model rounds. Served as three numbers it invites a page to draw a bar chart
  // of noise and a reader to conclude he counters slightly more often than not.
  assert.equal(style.informative, false, 'an even spread across three options says nothing');
  assert.equal(sells.informative, false, 'and a boolean at 0.5 is the same non-answer');
  assert.equal(bias.informative, true, '0.60 on one option is a real lean');
  // `shapeJevAnswer` writes two different flat sentences: this one, where there
  // was no evidence to begin with, and one for a draft record that WAS read and
  // still came back flat. A pattern matching either would pass on the wrong one,
  // and the difference is the whole point of the flag above.
  assert.match(style.why,
    /the answer came back an even spread across the options, which is the honest answer when there is no evidence/,
    `a flat prior must say it is flat BECAUSE there is nothing under it, got ${JSON.stringify(style.why)}`);
  assert.doesNotMatch(style.why, /his draft record bears on this question/,
    'and it must not borrow the sentence for a record that was read and came back flat');

  // The boolean's OTHER leg. A boolean is stored as its 'true' row alone, so a
  // reader that takes the stored rows as the whole distribution sees one
  // outcome, and one outcome has no spread to measure — every boolean in the
  // store would come back unmeasurable, the 0.5 non-answer and a real 0.8 lean
  // alike.
  assert.equal(sells.spread, 0, 'a boolean at 0.5 is exactly an even spread, not an unmeasurable one');
  assert.ok(sells.top, 'and it still has a leading outcome');
  const buys = answerFor(hay, 'buys_high');
  assert.equal(buys.spread, 0.3, '0.8 against its missing 0.2 leg');
  assert.equal(buys.informative, true, 'a lopsided answer says something');
  assert.match(buys.why, /prior/i, 'and it is still a prior — leaning is not evidence');
});

test('G11g: a score question\'s summary is not one of its outcomes', () => {
  // `risk_appetite` stores a 'mean' of 3.2 beside its five level probabilities.
  // Ranked as an outcome, 3.2 beats every real probability and the answer reads
  // as "most likely: mean".
  const risk = answerFor(jevOf(21, '2'), 'risk_appetite');
  assert.ok(risk, 'the score question is served');
  assert.equal(risk.score_mean, 3.2, 'the summary is served, under its own name');
  assert.equal(risk.top.outcome, '4', 'and the leading OUTCOME is a level, never the summary');
  assert.equal(risk.top.probability, 0.4);
});

test('G11d: the model read is DISPLAYED and never priced — deleting the store moves no number', () => {
  // The guarantee the whole item rests on. Half these answers are priors, and a
  // prior that moves a price is a number invented about a person. If anyone ever
  // wires `jev` into a factor, a cap or receptiveness, this goes red.
  const priced = () => {
    const managers = mapFor(21).managers;
    return JSON.stringify([...managers.entries()].map(([rid, entry]) => [rid,
      [...entry.players.entries()].map(([name, v]) =>
        [name, v.our_value, v.their_value, v.multiplier, factorNames(v),
          (v.inert ?? []).map(i => i.source).sort()])]));
  };
  const before = layerFor(21);
  assert.ok(answerFor(before.get('2').jev, 'position_bias'), 'precondition: there is a read to remove');
  assert.equal(before.get('2').jev.priced, false, 'the block says outright that it prices nothing');
  const pricedBefore = priced();
  const receptivenessBefore = [...before.entries()].map(([rid, e]) => [rid, e.receptiveness]);

  run('DELETE FROM manager_archetype_jev');
  try {
    const after = layerFor(21);
    assert.equal((after.get('2').jev.answers ?? []).length, 0, 'precondition: the read is gone');
    assert.equal(priced(), pricedBefore,
      'no price, multiplier, factor or inert entry may depend on the model read');
    assert.deepEqual([...after.entries()].map(([rid, e]) => [rid, e.receptiveness]), receptivenessBefore,
      'and receptiveness is untouched too — it is the other number a "style" read would tempt someone into');
  } finally {
    insertJevFixture();
  }
});

test('G11e: a manager the pass never covered and a store never built are different absences', () => {
  const danny = jevOf(21, '4');
  assert.ok(danny, 'the block is served even when there is nothing in it');
  assert.equal(danny.as_of, null, 'no stamp is borrowed from the managers who WERE evaluated');
  assert.equal((danny.answers ?? []).length, 0);
  assert.ok(typeof danny.reason === 'string' && danny.reason.length > 0);

  run('DELETE FROM manager_archetype_jev');
  try {
    const neverRun = jevOf(21, '4');
    assert.equal(neverRun.as_of, null);
    assert.notEqual(neverRun.reason, danny.reason,
      '"the pass has not covered him" and "the pass has never been run" send a reader to different fixes');
  } finally {
    insertJevFixture();
  }
});

test('G11f: the read travels with the person, not the league', () => {
  // `manager_archetype_jev` is keyed by member_id alone, deliberately: how a
  // person negotiates is a fact about him, and archetypesFor() already carries
  // the career profile across leagues for the same reason.
  const inTwentyOne = jevOf(21, '2');
  const inTwentyTwo = jevOf(22, '2');
  assert.equal(inTwentyTwo.as_of, inTwentyOne.as_of, 'same person, same evaluation');
  assert.equal(answerFor(inTwentyTwo, 'position_bias')?.top?.outcome,
    answerFor(inTwentyOne, 'position_bias')?.top?.outcome);
});
