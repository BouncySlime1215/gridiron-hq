/**
 * tactics-and-packages: the nine tactics, as RULES over the valuation map, and
 * the edge test that decides whether an idea is allowed to exist at all.
 *
 * Nick, 2026-09-18: "Trades are designed by the people they are being sent to
 * while finding an edge… if someone loves a player then abuse that, vice
 * versa… sneak a guy in… all the moves and mind games."
 *
 * Gates pre-registered in
 * /private/tmp/claude-501/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/scratchpad/wa/tactics-and-packages/GATE.md
 * before this file was written. Nothing here is a fitted model: the tactics are
 * hand-set, capped, NAMED rules over numbers that already exist, and the only
 * number this item adds to the engine is a REMOVAL (the edge test). So the
 * guarantees are the filter, provenance, sample gates and cutoff safety — not a
 * season split.
 *
 *  G1 THE EDGE TEST, non-negotiable: this week > 0, horizon-weighted gain > 0,
 *     positive after the value it costs, and POSITIVE WITHOUT the counterparty
 *     read — perception may reorder ideas, never promote one.
 *  G2 tactic tags present, grounded, sample-gated, ranked net of positional need.
 *  G3 no idea targets a credibly declared untouchable; a probe is flagged.
 *  G4 the ablation is a real re-run: findTrades takes `zero` and keys on it.
 *  G5 timing read from league_transactions_raw, gated on n, cutoff-safe on
 *     PARSED dates (a string compare leaks same-day rows — see G5c).
 *  G6 veto-proof uses each league's own ESPN vetoVotesRequired.
 *  G7 how Nick looks: pacing, never lead with what the league knows he shops,
 *     pressure points attributed only when the evidence names the manager.
 *  G8 runtime per league is reported on the result.
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-trade-tactics-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;
process.env.SCHEDULER_DISABLED = '1';

const SEASON = 2026;
const LEAGUE = 31;          // the chat league the engine really searches
const BARE = 32;            // same shape, no chat corpus and no veto history

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
// Side-effect imports: the same "~40 files create tables on import" wiring the
// rest of the suite relies on (test/find-trades.test.js, test/post-draft-plan.test.js).
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
await import('../server/services/manager-archetypes.js');
const identity = await import('../server/services/manager-identity.js');
const signals = await import('../server/services/manager-signals.js');
const pricing = await import('../server/services/counterparty-pricing.js');
const engine = await import('../server/services/trade-engine.js');
const tactics = await import('../server/services/trade-tactics.js');

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

// ------------------------------------------------------------ real players
// Real seeded players, so the asset universe prices them the way production
// does. The chat fixture below then talks about these exact names.
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const pool = pos => rows(`SELECT id, name, position FROM players
                          WHERE position = ? AND fantasy_relevant = 1 ORDER BY id LIMIT 30`, pos);
const QB = pool('QB'), RB = pool('RB'), WR = pool('WR'), TE = pool('TE');
assert.ok(QB.length >= 6 && RB.length >= 18 && WR.length >= 18 && TE.length >= 6,
  'the seed must carry enough players to build six real rosters');

const MEMBER = ['{TT-1}', '{TT-2}', '{TT-3}', '{TT-4}', '{TT-5}', '{TT-6}'];
const CHAT_NAME = ['ME', 'Hayden Brook', 'Carl Delta', 'Danny Echo'];

let fakeEspnId = 810000;
const entryFor = p => ({ lineupSlotId: 0, acquisitionType: 'DRAFT',
  playerPoolEntry: { player: { id: fakeEspnId++, fullName: p.name,
    injuryStatus: 'ACTIVE', defaultPositionId: POS_ID[p.position] } } });

// Deliberately lopsided rosters. Six identical teams produce no trade at all:
// every package is a straight downgrade for somebody, the value-skew prune
// throws it out, and the search returns nothing. Nick (team 1) is elite at WR
// and thin at RB; Hayden (team 2) is the mirror image. That is a real trade.
const SHAPE = [
  { qb: 3, rb: [9, 10, 11], wr: [0, 1, 2], te: 4 },     // 1 Nick — WR rich, RB poor
  { qb: 0, rb: [0, 1, 2], wr: [9, 10, 11], te: 0 },     // 2 Hayden — RB rich, WR poor
  { qb: 1, rb: [3, 4, 5], wr: [3, 4, 5], te: 1 },       // 3 Carl
  { qb: 2, rb: [6, 7, 8], wr: [6, 7, 8], te: 2 },       // 4 Danny
  { qb: 4, rb: [12, 13, 14], wr: [12, 13, 14], te: 3 }, // 5
  { qb: 5, rb: [15, 16, 17], wr: [15, 16, 17], te: 5 }, // 6
];
const ROSTERS = SHAPE.map(s => [QB[s.qb], ...s.rb.map(i => RB[i]), ...s.wr.map(i => WR[i]), TE[s.te]]);
const nameOn = (teamIdx, pos, k = 0) => ROSTERS[teamIdx].filter(p => p.position === pos)[k].name;

/** Round-robin fixtures for six teams; week 1 is played, and team 2 lost it by 40. */
function roundRobin(weeks) {
  const out = [];
  const ids = [1, 2, 3, 4, 5, 6];
  for (let w = 1; w <= weeks; w++) {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w - 1) % 5)])];
    for (let i = 0; i < 3; i++) {
      const home = rot[i], away = rot[5 - i];
      const played = w === 1;
      // The post-loss window has to come from the scoreboard, not from chat:
      // team 2 is 40 points down in the one week that has been played.
      const pts = id => (id === 2 ? 80 : 120);
      out.push({ matchupPeriodId: w,
        home: { teamId: home, totalPoints: played ? pts(home) : undefined },
        away: { teamId: away, totalPoints: played ? pts(away) : undefined } });
    }
  }
  return out;
}

function leaguePayload() {
  return {
    members: MEMBER.map((id, i) => ({ id, firstName: `First${i + 1}`, lastName: `Last${i + 1}`,
      displayName: `First${i + 1}Last${i + 1}` })),
    teams: ROSTERS.map((roster, i) => ({
      id: i + 1, name: `Team ${i + 1}`, owners: [MEMBER[i]],
      currentProjectedRank: i + 1, draftDayProjectedRank: i + 1,
      record: { overall: { wins: i % 3, losses: 2 - (i % 3), ties: 0, pointsFor: 400 + i * 10,
        pointsAgainst: 400, streakType: i === 1 ? 'LOSS' : 'WIN', streakLength: i === 1 ? 3 : 1 } },
      roster: { entries: roster.map(entryFor) },
    })),
    schedule: roundRobin(14),
    settings: { name: 'TT League', tradeSettings: { vetoVotesRequired: 3, revisionHours: 24 },
      scheduleSettings: { matchupPeriodCount: 14, matchupPeriodLength: 1, playoffTeamCount: 4,
        playoffMatchupPeriodLength: 1 } },
  };
}

function insertLeague(id, payload, myTeamId = '1') {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, ?, ?, ?, ?, ?, ?, 'secret-s2', 'secret-swid', 'connected')`,
  id, `espn-tt-${id}`, SEASON, `TT${id}`, JSON.stringify(payload), payload.teams.length, myTeamId,
  JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
}
insertLeague(LEAGUE, leaguePayload());
// The bare league: same rosters, a DIFFERENT veto threshold from its own ESPN
// settings, no chat identities and no transactions at all.
const barePayload = leaguePayload();
barePayload.settings.tradeSettings.vetoVotesRequired = 5;
insertLeague(BARE, barePayload);

// Market values. The seed carries none, and a valuation map over a league where
// every player is worth 0 would prove nothing — so the fixture prices them, on
// the same format key the engine derives for these leagues.
// Market values AND a season projection. The seed carries neither, and a
// valuation map over a league where every player is worth 0 and projects 0
// would prove nothing: the engine's first gate is a 0.4 ppg lineup gain.
const { deriveFormat } = await import('../server/services/format.js');
const FORMAT_KEY = deriveFormat(rows('SELECT * FROM leagues WHERE id = ?', LEAGUE)[0]).formatKey;
const PRICE = { QB: 4200, RB: 6800, WR: 6400, TE: 3200 };
const PROJ = { QB: [340, 9], RB: [300, 8], WR: [290, 7], TE: [200, 6] };
for (const [pos, list] of [['QB', QB], ['RB', RB], ['WR', WR], ['TE', TE]]) {
  list.forEach((p, i) => {
    p.value = Math.round(PRICE[pos] * (1 - i * 0.028));
    p.season_points = PROJ[pos][0] - i * PROJ[pos][1];
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank,
         fetched_at) VALUES (?,?,?,?,0,25,?,datetime('now'))`, FORMAT_KEY, p.id, p.value, p.value, i + 1);
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?,?,'projected',?,17,'{}',datetime('now'))`, p.id, SEASON, p.season_points);
  });
}

// -------------------------------------------------------------- chat fixture
// Named for the three managers we will confirm identities for. Team 2 =
// "Hayden Brook", team 3 = "Carl Delta", team 4 = "Danny Echo" (no chat rows).
const MY_SHOPPED = nameOn(0, 'WR', 0); // my best WR — the whole league knows he shops him
const CRUSH = nameOn(0, 'WR', 1);      // MY player, Hayden raves about him
const HIS_STAR = nameOn(1, 'RB', 0);   // HIS best RB, credibly untouchable
const SOUR = nameOn(1, 'RB', 2);       // HIS player, he has soured on him
const FILLER = nameOn(1, 'WR', 2);     // HIS player, his profile calls him filler
const CARL_PROBE = nameOn(2, 'RB', 0); // Carl says untouchable and never means it

function profileFor(overrides = {}) {
  return {
    headline: 'Trades a lot, rarely means no.',
    says_no: { how: 'jokes first', hard_no_looks_like: ['not happening'], soft_no_looks_like: ['eh'],
      does_his_no_hold: 'rarely', evidence: ['"not happening" then traded him'] },
    praise_means: { reading: 'belief', why: 'means it', hypes_before_selling: false,
      agrees_with_numbers: 'yes', evidence: ['"league winner"'] },
    techniques: [{ name: 'anchor', how_he_does_it: 'asks high', evidence: ['"need two firsts"'], how_often: 'often' }],
    calibration: { enthusiasm_scale: 'loud', baseline_tone: 'friendly', inflation: 'mild' },
    roster_read: { really_untouchable: [], quietly_available: [], overvalues: [], undervalues: [],
      reasoning: 'talk vs numbers' },
    what_moves_him: ['a win-now piece'],
    what_shuts_him_down: ['lowballs'],
    how_to_approach: 'Lead with a fair offer after a loss.',
    best_bait: 'a bench flier',
    confidence: 'high',
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
  for (const p of [
    ['ME', 900, 600, 50, 0.2, 0.30, 0.2, 0.3, 2.5, 0.3, 0.5, 0.1, 0.30, 0.05, 0.05, 0.02],
    ['Hayden Brook', 400, 300, 20, 0.1, 0.25, 0.3, 0.2, 2.2, 0.4, 0.4, 0.1, 0.34, 0.12, 0.10, 0.05],
    ['Carl Delta', 350, 250, 15, 0.3, 0.20, 0.1, 0.4, 2.1, 0.2, 0.6, 0.1, 0.20, 0.04, 0.04, 0.02],
  ]) prof.run(...p, '2026-01-01', '2026-09-17');

  const sent = chat.prepare(`INSERT INTO manager_player_sentiment VALUES (?,?,?,?,?,?,?,?,datetime('now'))`);
  sent.run('Hayden Brook', CRUSH, 9, 3.6, 0.95, 0.0, '2026-08-01', '2026-09-16');   // loves MY guy
  sent.run('Hayden Brook', SOUR, 7, 1.2, 0.0, 0.9, '2026-08-01', '2026-09-16');     // sour on HIS guy
  sent.run('Hayden Brook', HIS_STAR, 6, 3.5, 0.95, 0.0, '2026-08-01', '2026-09-16');
  sent.run('Carl Delta', CARL_PROBE, 5, 3.4, 0.9, 0.0, '2026-08-01', '2026-09-16');
  sent.run('ME', MY_SHOPPED, 9, 1.3, 0.0, 0.9, '2026-08-20', '2026-09-16');         // Nick talks him down

  const msg = chat.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,0,0)`);
  const sig = chat.prepare(`INSERT INTO jev_chat_signals VALUES (?,?,?,?,?,?,?)`);
  let id = 1;
  const declare = (who, player, day) => {
    msg.run(id, 'group', 'League', 'h', who, 0, `2026-09-${day}T12:00:00Z`, `${player} is not moving`);
    sig.run(id, who, 'group', player, 'own_roster.untouchable', 0.95, `2026-09-${day}`);
    id++;
  };
  // Hayden declares HIS_STAR untouchable three times and never trades him: his
  // word holds, so findTrades must not even ask.
  declare('Hayden Brook', HIS_STAR, '05'); declare('Hayden Brook', HIS_STAR, '07');
  declare('Hayden Brook', HIS_STAR, '09');
  // Carl declares CARL_PROBE untouchable and then trades him away twice.
  declare('Carl Delta', CARL_PROBE, '05'); declare('Carl Delta', CARL_PROBE, '07');
  declare('Carl Delta', CARL_PROBE, '09');

  const np = chat.prepare(`INSERT INTO negotiation_profiles VALUES (?,?,?,?,?,?)`);
  np.run('Hayden Brook', JSON.stringify(profileFor({
    roster_read: { really_untouchable: [HIS_STAR], quietly_available: [`${FILLER} (throw-in depth)`],
      overvalues: [`${CRUSH} — calls him a league winner`], undervalues: [SOUR], reasoning: 'talk vs numbers' },
    what_shuts_him_down: ['lowballs', 'being asked for his cornerstones'],
  })), 400, 'h1', 'claude-sonnet-5', '2026-09-18 05:00:00');
  np.run('ME', JSON.stringify(profileFor({
    headline: 'Sends a lot of offers.',
    roster_read: { really_untouchable: [], quietly_available: [`${MY_SHOPPED} (offered to 5 managers)`,
      'bench filler when he had it'], overvalues: [], undervalues: [MY_SHOPPED], reasoning: 'tired of him' },
    what_moves_him: [
      // Names a manager: this one is attributable to Hayden and to nobody else.
      'Being told he needs wins now (Hayden Brook used "u need wins now" and it visibly worked)',
      // Names nobody: league-wide, never attributed to a person.
      'A name he is fixated on being dangled',
    ],
    what_shuts_him_down: ['Opponents citing hard stat arguments'],
  })), 341, 'h2', 'claude-sonnet-5', '2026-09-18 05:54:00');
  chat.close();
}
buildChatFixture(CHAT_PATH);

run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name, chat_name,
       match_method, confidence) VALUES
     (?, '1', ?, 'First1Last1', 'Team 1', 'ME', 'confirmed by Nick', 'confirmed'),
     (?, '2', ?, 'First2Last2', 'Team 2', 'Hayden Brook', 'confirmed by Nick', 'confirmed'),
     (?, '3', ?, 'First3Last3', 'Team 3', 'Carl Delta', 'confirmed by Nick', 'confirmed')`,
LEAGUE, MEMBER[0], LEAGUE, MEMBER[1], LEAGUE, MEMBER[2]);

// ------------------------------------------------------------- transactions
function tx(leagueId, id, type, execution, teamId,
  { related = null, items = [], at = '2026-09-10T00:00:00Z' } = {}) {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type,
         proposed_at, team_id, related_tx_id, items_json, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,NULL,?,?,?,?,?,datetime('now'),datetime('now'))`,
  leagueId, SEASON, id, type, execution, at, teamId, related, JSON.stringify(items));
}
const swap = (a, b, pa, pb) => [{ fromTeamId: a, toTeamId: b, playerId: pa, type: 'TRADE' },
  { fromTeamId: b, toTeamId: a, playerId: pb, type: 'TRADE' }];

// Hayden (roster 2) decides fast: four offers, each answered within the hour.
const HAY_LAT = [0.25, 0.5, 0.75, 1.5];
HAY_LAT.forEach((h, i) => {
  const day = String(4 + i).padStart(2, '0');
  tx(LEAGUE, `o${i}`, 'TRADE_PROPOSAL', 'EXECUTE', 1,
    { items: swap(1, 2, 100 + i, 200 + i), at: `2026-09-${day}T18:00:00Z` });
  tx(LEAGUE, `o${i}-d`, i === 3 ? 'TRADE_ACCEPT' : 'TRADE_DECLINE', 'EXECUTE', 2,
    { related: `o${i}`, at: `2026-09-${day}T${String(18 + Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}:00Z` });
});
// Two owners vetoed the one Hayden accepted.
tx(LEAGUE, 'o3-v1', 'TRADE_VETO', 'EXECUTE', 4, { related: 'o3', at: '2026-09-07T20:00:00Z' });
tx(LEAGUE, 'o3-v2', 'TRADE_VETO', 'EXECUTE', 5, { related: 'o3', at: '2026-09-07T21:00:00Z' });
// Carl (roster 3) declined Nick 40 minutes ago — the "wait" rule.
tx(LEAGUE, 'c1', 'TRADE_PROPOSAL', 'EXECUTE', 1, { items: swap(1, 3, 130, 230), at: '2026-09-18T12:00:00Z' });
tx(LEAGUE, 'c1-d', 'TRADE_DECLINE', 'EXECUTE', 3, { related: 'c1', at: '2026-09-18T13:20:00Z' });
// An offer Nick RECEIVED — never one he sent.
tx(LEAGUE, 'in1', 'TRADE_PROPOSAL', 'EXECUTE', 2, { items: swap(2, 1, 300, 400), at: '2026-09-15T00:00:00Z' });
// The draft: sixteen picks for Hayden inside one league-wide sitting. These are
// NOT him being in the app on his own clock, and counting them gave every
// manager in a league the same "busiest hour" — the hour of the draft.
for (let i = 0; i < 16; i++) {
  tx(LEAGUE, `dr${i}`, 'DRAFT', 'EXECUTE', 2, { at: `2026-08-24T04:${String(i).padStart(2, '0')}:00Z` });
}
// …and the league clearing a waiver on its own clock, which is not him either.
tx(LEAGUE, 'wproc', 'WAIVER', 'PROCESS', 2, { at: '2026-09-10T11:00:00Z' });
// A row AFTER the cutoff used in G5c, written the way the collector writes them
// today (space-separated), which a string compare would sort BEFORE the cutoff.
tx(LEAGUE, 'late', 'TRADE_PROPOSAL', 'EXECUTE', 1, { items: swap(1, 2, 500, 600), at: '2026-09-18 23:00:00' });
tx(LEAGUE, 'late-d', 'TRADE_DECLINE', 'EXECUTE', 2, { related: 'late', at: '2026-09-19 23:00:00' });

identity.matchIdentities(LEAGUE, { chatNames: CHAT_NAME });
identity.matchIdentities(BARE, { chatNames: [] });
const handle = signals.openChatDb();
signals.buildManagerSignals(LEAGUE, { chat: handle });
signals.buildManagerSignals(BARE, { chat: null });
handle?.close();

const lgRow = id => rows('SELECT * FROM leagues WHERE id = ?', id)[0];
const LG = lgRow(LEAGUE);
const LG_BARE = lgRow(BARE);

// findTrades is the one entry point and it is expensive, so each arm is run
// once here and every test reads the same result.
const NOW = '2026-09-18T14:00:00Z';
const found = engine.findTrades(LG, { myTeamId: '1', requireMutual: false, limit: 100 });
const mutual = engine.findTrades(LG, { myTeamId: '1', requireMutual: true, limit: 100 });
const bare = engine.findTrades(LG_BARE, { myTeamId: '1', requireMutual: false, limit: 100 });
const everyDeal = [...found.deals, ...mutual.deals, ...bare.deals];

const dealNames = d => `${d.i_give.map(p => p.name).join('+')}>${d.i_get.map(p => p.name).join('+')}`;
const key = d => `${d.partner_id}|${dealNames(d)}`;

test('G2i: the fixture exercises the tactics end to end, not only as unit calls', () => {
  // A tactic that only ever fires in a hand-built unit test is a tactic that
  // could silently stop being wired into findTrades. Seven of the ten fire on
  // this league through the real entry point; consolidate_for_need, hype_window
  // and probe_declared are covered by G2f, G2g and G3b, and are reported ABSENT
  // here with their reasons rather than being quietly missing.
  const firing = new Set(found.deals.flatMap(d => d.tactics.map(t => t.key)));
  assert.ok(firing.size >= 6, `only ${firing.size} tactics fired through findTrades: ${[...firing]}`);
  for (const k of ['sell_the_crush', 'buy_the_sour', 'timing', 'veto_proof',
    'anchor_ladder', 'how_nick_looks']) {
    assert.ok(firing.has(k), `${k} never fired through the real entry point`);
  }
  const absent = new Set(found.deals.flatMap(d => d.tactics_absent.map(a => a.key)));
  for (const k of ['consolidate_for_need', 'hype_window']) {
    assert.ok(absent.has(k), `${k} must be reported absent with its reason where it does not fire`);
  }
  // Ranked net of positional need: the chat reads come first, and every tactic
  // carries the number it was ranked on.
  const top = found.deals.find(d => d.tactics.some(t => t.key === 'sell_the_crush'));
  assert.equal(top.tactics[0].key, 'sell_the_crush');
  assert.ok(top.tactics.every(t => Number.isFinite(t.rank_effect)));
});

// ========================================================= G1 THE EDGE TEST
test('G1a: perception may reorder ideas, never promote one that loses on our numbers', () => {
  const promoted = tactics.edgeTest({ ppgDelta: 0.9, horizonGain: 0.4,
    scoreSigned: 0.013, scoreUnperceived: -0.046 });
  assert.equal(promoted.passes, false, 'a deal that only wins on their perception is a gift, not a trade');
  assert.deepEqual(promoted.failed, ['not_only_perception']);
  const check = promoted.checks.find(c => c.name === 'not_only_perception');
  assert.equal(check.value, -0.046, 'the failing number is carried, not just the verdict');
  assert.ok(/perception/i.test(check.why));
});

test('G1b: a positive week does not excuse a negative horizon-weighted gain', () => {
  const winNowOnly = tactics.edgeTest({ ppgDelta: 0.51, horizonGain: -0.13,
    scoreSigned: 0.021, scoreUnperceived: 0.019 });
  assert.equal(winNowOnly.passes, false);
  assert.deepEqual(winNowOnly.failed, ['horizon']);
});

test('G1c: a clean deal passes and carries all four checks with their numbers', () => {
  const ok = tactics.edgeTest({ ppgDelta: 1.2, horizonGain: 0.9, scoreSigned: 0.7, scoreUnperceived: 0.65 });
  assert.equal(ok.passes, true);
  assert.deepEqual(ok.failed, []);
  assert.deepEqual(ok.checks.map(c => c.name).sort(),
    ['after_value_cost', 'horizon', 'not_only_perception', 'this_week']);
  for (const c of ok.checks) {
    assert.equal(typeof c.value, 'number');
    assert.equal(c.threshold, 0);
    assert.ok(c.why && c.why.length > 10, `${c.name} must explain itself`);
  }
});

test('G1d: every idea the engine surfaces passes the edge test, in both lists', () => {
  assert.ok(everyDeal.length > 0, 'the fixture must actually produce ideas');
  for (const d of everyDeal) {
    assert.ok(d.edge, `${key(d)} carries no edge block`);
    assert.equal(d.edge.passes, true, `${key(d)} was surfaced while failing ${d.edge.failed?.join()}`);
    assert.ok(d.me.ppg_delta > 0, `${key(d)} does not improve this week`);
    assert.ok(d.horizon.value > 0, `${key(d)} has a non-positive horizon gain`);
    assert.ok(d.score_signed > 0, `${key(d)} is not positive after the value it costs`);
    const np = d.edge.checks.find(c => c.name === 'not_only_perception');
    assert.ok(np.value > 0, `${key(d)} is positive only because of the counterparty read`);
  }
});

test('G1e: a deal is removed by the edge test, and how many is reported per league', () => {
  assert.equal(typeof found.edge_removed, 'number');
  assert.ok(Array.isArray(found.edge_removed_examples));
  for (const ex of found.edge_removed_examples) {
    assert.ok(ex.failed.length > 0, 'a removal must name the check it failed');
    assert.ok(ex.partner && ex.i_give && ex.i_get);
  }
});

// ================================================== G2 tactic tags, grounded
test('G2a: every surfaced idea carries tactic tags with provenance', () => {
  for (const d of everyDeal) {
    assert.ok(Array.isArray(d.tactics), `${key(d)} has no tactics array`);
    assert.ok(Array.isArray(d.tactics_absent), `${key(d)} has no tactics_absent array`);
    for (const t of d.tactics) {
      assert.ok(tactics.TACTICS[t.key], `unknown tactic ${t.key}`);
      assert.equal(t.fitted, false, 'no tactic here is fitted and every one must say so');
      assert.ok(Number.isFinite(t.n), `${t.key} must carry its sample size`);
      assert.ok(t.why && t.why.length > 15, `${t.key} must explain itself in a sentence`);
    }
    for (const a of d.tactics_absent) {
      assert.ok(tactics.TACTICS[a.key], `unknown absent tactic ${a.key}`);
      assert.ok(a.reason && a.reason.length > 10, `${a.key} must say WHY it is not firing`);
    }
    const keys = new Set(d.tactics.map(t => t.key));
    for (const a of d.tactics_absent) assert.ok(!keys.has(a.key), `${a.key} cannot be both firing and absent`);
  }
});

test('G2b: a tactic never names a player who is not in the deal', () => {
  for (const d of everyDeal) {
    const inDeal = new Set([...d.i_give, ...d.i_get].map(p => p.name));
    for (const t of d.tactics) {
      for (const p of t.players ?? []) {
        assert.ok(inDeal.has(p.player), `${t.key} on ${key(d)} names ${p.player}, who is not in the deal`);
      }
    }
  }
});

test('G2c: sell the crush fires on a player of ours he has talked up, and names the numbers', () => {
  const v = name => ({ name, position: 'WR', value: 1000, ros_ppg: 12 });
  const manager = { receptiveness: 1.1, owned: new Set(['sour guy']) };
  const valuationOf = p => (p.name === 'Crush'
    ? { player: 'Crush', our_value: 1000, their_value: 1100, multiplier: 1.1, owns: false,
      factors: [{ source: 'chat_sentiment', label: 'x', effect: 0.1, n: 9, cap: 0.12, fitted: false,
        why: 'he rates him (9 mentions)' }] }
    : { player: p.name, our_value: 1000, their_value: 1000, multiplier: 1, owns: false, factors: [] });
  const out = tactics.tacticsForDeal({ give: [v('Crush'), v('Plain')], get: [v('Theirs')],
    manager, valuationOf, partnerId: '2' });
  const hit = out.tactics.find(t => t.key === 'sell_the_crush');
  assert.ok(hit, 'the tactic must fire');
  assert.deepEqual(hit.players.map(p => p.player), ['Crush']);
  assert.equal(hit.players[0].our_value, 1000);
  assert.equal(hit.players[0].their_value, 1100);
  assert.equal(hit.players[0].factor.source, 'chat_sentiment');
  assert.equal(hit.players[0].centrepiece, true, 'the crush is the headline piece we send');
});

test('G2d: buy the sour fires on a player of HIS that he has priced below our number', () => {
  const v = (name, value) => ({ name, position: 'RB', value, ros_ppg: 11 });
  const valuationOf = p => (p.name === 'Sour'
    ? { player: 'Sour', our_value: 900, their_value: 810, multiplier: 0.9, owns: true,
      factors: [{ source: 'talk_vs_model', label: 'x', effect: -0.1, n: 7, cap: 0.10, fitted: false,
        why: 'he is down on him (7 mentions) and the usage agrees' }] }
    : { player: p.name, our_value: p.value, their_value: p.value, multiplier: 1, owns: false, factors: [] });
  const out = tactics.tacticsForDeal({ give: [v('Mine', 900)], get: [v('Sour', 900)],
    manager: { receptiveness: 1 }, valuationOf, partnerId: '2' });
  const hit = out.tactics.find(t => t.key === 'buy_the_sour');
  assert.ok(hit);
  assert.equal(hit.players[0].player, 'Sour');
  assert.ok(hit.players[0].gap_pct < 0, 'the gap is what he marks his own player down by');
});

test('G2e: sneak-in needs BOTH halves — filler to him, and cheap production to us', () => {
  const flat = p => ({ player: p.name, our_value: p.value, their_value: p.value, multiplier: 1,
    owns: true, factors: [] });
  const headline = { name: 'Headline', position: 'WR', value: 4000, ros_ppg: 14 };
  const sneak = { name: 'Sneak', position: 'RB', value: 800, ros_ppg: 9 };      // 11.3 vs 3.5 per 1k
  const dud = { name: 'Dud', position: 'RB', value: 800, ros_ppg: 2 };          // 2.5 per 1k
  const mine = { name: 'Mine', position: 'WR', value: 4500, ros_ppg: 15 };
  // The baseline is the median points-per-1,000 AT HIS OWN POSITION, because
  // price-per-point is not comparable across positions: a one-QB-league starter
  // scores like a WR1 at a quarter of the price. Measured against the headline
  // instead, the rule fired on 18 of 60 league-3 ideas, led by Jalen Hurts.
  const positionRate = new Map([['RB', 3.5], ['WR', 3.5], ['QB', 8.0]]);
  const fires = tactics.tacticsForDeal({ give: [mine], get: [headline, sneak],
    manager: { receptiveness: 1 }, valuationOf: flat, partnerId: '2', positionRate });
  const hit = fires.tactics.find(t => t.key === 'sneak_in');
  assert.ok(hit, 'a cheap high-rate throw-in he does not price up is the sneak-in');
  assert.deepEqual(hit.players.map(p => p.player), ['Sneak']);
  assert.equal(hit.players[0].position_median_rate_per_1k, 3.5);

  const quiet = tactics.tacticsForDeal({ give: [mine], get: [headline, dud],
    manager: { receptiveness: 1 }, valuationOf: flat, partnerId: '2', positionRate });
  assert.equal(quiet.tactics.find(t => t.key === 'sneak_in'), undefined,
    'a genuinely useless throw-in is not a tactic, it is padding');

  // A cheap quarterback beats every RB and WR on points per unit of price and
  // is NOT a sneak-in: against his own position he is ordinary.
  const qb = { name: 'Cheap QB', position: 'QB', value: 1200, ros_ppg: 9.6 };  // 8.0/1k = the QB median
  const withQb = tactics.tacticsForDeal({ give: [mine], get: [headline, qb],
    manager: { receptiveness: 1 }, valuationOf: flat, partnerId: '2', positionRate });
  assert.equal(withQb.tactics.find(t => t.key === 'sneak_in'), undefined,
    'a quarterback priced like every other quarterback is not a steal');

  // …and with no baseline at all the rule refuses rather than guessing.
  const blind = tactics.tacticsForDeal({ give: [mine], get: [headline, sneak],
    manager: { receptiveness: 1 }, valuationOf: flat, partnerId: '2' });
  assert.equal(blind.tactics.find(t => t.key === 'sneak_in'), undefined);
  assert.match(blind.tactics_absent.find(a => a.key === 'sneak_in').reason, /baseline/);
});

test('G2f: consolidate for need is 2-for-1 into a position he is short at', () => {
  const need = p => ({ player: p.name, our_value: p.value, their_value: p.value * 1.08, multiplier: 1.08,
    owns: false, factors: [{ source: 'positional_need', label: 'x', effect: 0.08, n: 15, cap: 0.08,
      fitted: false, why: 'he is short at RB' }] });
  const a = { name: 'Depth A', position: 'RB', value: 2000, ros_ppg: 10 };
  const b = { name: 'Depth B', position: 'RB', value: 1800, ros_ppg: 9 };
  const star = { name: 'Star', position: 'WR', value: 4200, ros_ppg: 16 };
  const out = tactics.tacticsForDeal({ give: [a, b], get: [star],
    manager: { receptiveness: 1, needs: new Set(['RB']) },
    valuationOf: p => (p.name === 'Star'
      ? { player: 'Star', our_value: 4200, their_value: 4200, multiplier: 1, owns: true, factors: [] }
      : need(p)), partnerId: '2' });
  const hit = out.tactics.find(t => t.key === 'consolidate_for_need');
  assert.ok(hit);
  assert.equal(hit.players.length, 2, 'both pieces we send are what his need is paying for');
  assert.ok(hit.numbers.need_premium_value > 0, 'the premium his need pays must be a number');
});

test('G2g: the hype window says it is off and why when the gap has fewer than two games', () => {
  const p = { name: 'Hot', position: 'WR', value: 2000, ros_ppg: 13 };
  const gaps = new Map([['hot', { games: 1, gap_per_game: 7.0, xfp_per_game: 6, actual_per_game: 13 }]]);
  const out = tactics.tacticsForDeal({ give: [p], get: [{ name: 'Theirs', position: 'WR', value: 2000, ros_ppg: 12 }],
    manager: { receptiveness: 1, gaps, players: new Map([['hot', { sentiment: 3.5, n: 6 }]]) },
    valuationOf: () => ({ our_value: 2000, their_value: 2000, multiplier: 1, owns: false, factors: [] }),
    partnerId: '2' });
  assert.equal(out.tactics.find(t => t.key === 'hype_window'), undefined);
  const absent = out.tactics_absent.find(a => a.key === 'hype_window');
  assert.ok(absent, 'an inert tactic is reported, never dropped');
  assert.match(absent.reason, /1 of the 2/);
});

test('G2h: tactics are ranked NET of positional need, which fires on everything', () => {
  const ranked = tactics.rankTactics([
    { key: 'consolidate_for_need', effect: 0.16, n: 15 },
    { key: 'sell_the_crush', effect: 0.10, n: 9 },
    { key: 'buy_the_sour', effect: 0.09, n: 7 },
  ]);
  assert.equal(ranked[0].key, 'sell_the_crush',
    'a bigger number built out of the blunt source does not outrank a real read');
  assert.ok(ranked.every(t => Number.isFinite(t.rank_effect)),
    'the number a tactic is ranked on is carried, so the order can be checked');
});

// ============================================ G3 credible untouchables
test('G3a: no idea asks for a player whose owner has credibly declared him untouchable', () => {
  const layer = pricing.counterpartyLayer(LEAGUE, { season: SEASON, week: engine.tradeWeekContext().week });
  let checked = 0;
  for (const d of [...found.deals, ...mutual.deals]) {
    const cp = layer.get(String(d.partner_id));
    const respect = cp?.stance?.respect ?? new Set();
    if (respect.size) checked++;
    for (const p of d.i_get) {
      assert.ok(!respect.has(p.name.toLowerCase()),
        `${key(d)} asks for ${p.name}, whom ${d.partner} has credibly declared untouchable`);
    }
  }
  assert.ok(checked > 0, 'the fixture must contain at least one manager whose word holds');
});

test('G3b: asking for a player he only bluffs about is allowed, and is flagged with the number', () => {
  const probes = [...found.deals, ...mutual.deals]
    .filter(d => (d.counterparty?.asking_for_declared ?? []).length);
  for (const d of probes) {
    const warn = d.tactics.find(t => t.key === 'probe_declared');
    assert.ok(warn, `${key(d)} asks for a declared player without flagging it`);
    assert.ok(/\d/.test(warn.why), 'the flag must carry his credibility number');
  }
  // Direct, so the rule is covered whether or not this week's search happens to
  // produce a package containing one of Carl's walked-back declarations.
  const probe = { name: CARL_PROBE, position: 'RB', value: 4000, ros_ppg: 13 };
  const out = tactics.tacticsForDeal({ give: [{ name: 'Mine', position: 'WR', value: 4000, ros_ppg: 13 }],
    get: [probe], partnerId: '3', partnerName: 'Team 3',
    manager: { receptiveness: 1, stance: { probe: new Set([CARL_PROBE.toLowerCase()]),
      respect: new Set(), credibility: { credibility: 0.2, declarations: 3 } } },
    valuationOf: p => ({ our_value: p.value, their_value: p.value, multiplier: 1, owns: false, factors: [] }) });
  const flagged = out.tactics.find(t => t.key === 'probe_declared');
  assert.ok(flagged, 'asking for a player he only bluffs about must be flagged');
  assert.equal(flagged.numbers.credibility, 0.2);
  assert.equal(flagged.numbers.declarations, 3);
  assert.match(flagged.why, /20% of the time/);
});

// =================================================== G4 a real ablation hook
test('G4a: findTrades takes `zero` and two arms cannot share a cache entry', () => {
  const a = engine.tradeIdeasFingerprint(LG, { myTeamId: '1' });
  const b = engine.tradeIdeasFingerprint(LG, { myTeamId: '1', zero: ['chat_sentiment'] });
  assert.notEqual(a, b, 'zeroing a source must change the cache fingerprint');
});

test('G4b: zeroing the chat changes what the ideas SAY, and it is a real re-run', () => {
  const zeroed = engine.findTrades(LG, { myTeamId: '1', requireMutual: false, limit: 100,
    zero: ['chat_sentiment', 'talk_vs_model', 'profile_roster_read', 'untouchable_credibility'] });
  const tacticKeys = list => new Set(list.deals.flatMap(d => d.tactics.map(t => t.key)));
  const before = tacticKeys(found), after = tacticKeys(zeroed);
  assert.ok(before.has('sell_the_crush') || before.has('buy_the_sour'),
    'the chat league must produce at least one chat-driven tactic to ablate');
  assert.ok(!after.has('sell_the_crush') && !after.has('buy_the_sour'),
    'with the chat zeroed, no chat-driven tactic may still fire');

  // …and it has to change the NUMBERS, not only the labels. `zero` reached
  // counterpartyLayer and playerValuation but stopped at readDeal, so a
  // suppressed source was still pricing every deal: measured on a copy of
  // production, zeroing all four chat sources moved 0 of 223 deal scores in
  // five leagues. An ablation that cannot move a score measures nothing.
  const scoreOf = list => new Map(list.deals.map(d => [key(d), d.score_signed]));
  const was = scoreOf(found), now = scoreOf(zeroed);
  const shared = [...was.keys()].filter(k => now.has(k));
  assert.ok(shared.length > 0, 'the two arms must share ideas to compare');
  assert.ok(shared.some(k => was.get(k) !== now.get(k)),
    'zeroing the chat changed no deal score at all — the suppression is not reaching the ranking');
});

// ============================================================== G5 timing
test('G5a: a response window needs decided offers, and says so when it does not have them', () => {
  const read = tactics.timingRead(LEAGUE, { season: SEASON, now: NOW });
  const hayden = read.get('2');
  assert.ok(hayden, 'a manager who has decided offers must be in the read');
  assert.equal(hayden.decisions_n, 4);
  assert.ok(hayden.median_hours > 0 && hayden.median_hours < 2);
  assert.equal(hayden.fastest_hours, 0.25);
  const quiet = read.get('6');
  assert.ok(!quiet || quiet.median_hours === null, 'no decisions, no median');
  if (quiet) assert.match(quiet.decisions_reason, /of the 3/);
  // The draft is not a habit. Hayden has 16 draft picks and one league-processed
  // waiver in the fixture; neither counts toward "when is he in the app", so he
  // stays under the gate and says why instead of reporting the draft hour.
  assert.ok(hayden.actions_n < 10, `draft picks leaked into the activity sample (${hayden.actions_n})`);
  assert.equal(hayden.busiest_hour, null);
  assert.match(hayden.active_hours_reason, /draft picks and league waiver processing do not count/);
});

test('G5b: "wait" after he has just declined, "now" when the window is open', () => {
  const read = tactics.timingRead(LEAGUE, { season: SEASON, now: NOW });
  const carl = read.get('3');
  assert.equal(carl.last_decline_at?.slice(0, 10), '2026-09-18');
  const send = tactics.sendWindow(carl, { now: NOW });
  assert.equal(send.when, 'wait');
  assert.ok(send.until, 'a wait must say until when');
  assert.match(send.why, /declined/i);
  const hayden = tactics.sendWindow(read.get('2'), { now: NOW });
  assert.equal(hayden.when, 'now');
});

test('G5c: the cutoff is a parsed date — a space-separated later row must not leak in', () => {
  // 'late' is written '2026-09-18 23:00:00'. A raw string compare sorts ' ' (0x20)
  // before 'T' (0x54), so `ts < '2026-09-18T14:00:00Z'` would wrongly include it.
  const asOf = tactics.timingRead(LEAGUE, { season: SEASON, now: NOW });
  const later = tactics.timingRead(LEAGUE, { season: SEASON, now: '2026-09-20T00:00:00Z' });
  assert.equal(asOf.get('2').decisions_n, 4, 'the later decline must not be read at 14:00 on the 18th');
  assert.equal(later.get('2').decisions_n, 5, 'and it must be read once the clock passes it');
});

// ============================================================== G6 veto
test('G6a: the veto threshold is each league\'s own ESPN setting, never a constant', () => {
  const here = tactics.vetoClimate(LG, { season: SEASON });
  const there = tactics.vetoClimate(LG_BARE, { season: SEASON });
  assert.equal(here.votes_required, 3);
  assert.equal(there.votes_required, 5);
  assert.equal(here.other_owners, 4, 'six teams, minus me and minus the partner');
});

test('G6b: the one package that drew votes is the reference, with its n printed', () => {
  const climate = tactics.vetoClimate(LG, { season: SEASON });
  assert.equal(climate.observed_max_votes, 2);
  assert.equal(climate.n, 1, 'one observed package, and the rule says so');
  const bareClimate = tactics.vetoClimate(LG_BARE, { season: SEASON });
  assert.equal(bareClimate.n, 0);
  assert.equal(bareClimate.observed_max_votes, 0);
  const risk = tactics.vetoRiskFor(bareClimate, { theirValuePct: 17 });
  assert.equal(risk.level, 'unknown');
  assert.match(risk.why, /never/i);
  assert.equal(risk.votes_required, 5, 'unknown risk still tells Nick what it would take');
});

test('G6c: a package at the skew the league has already voted against reads high', () => {
  const climate = { votes_required: 5, other_owners: 8, n: 1, observed_max_votes: 4,
    reference_skew_pct: 18.1, reference: { tx_id: 'x', votes: 4 } };
  assert.equal(tactics.vetoRiskFor(climate, { theirValuePct: 18.5 }).level, 'high');
  assert.equal(tactics.vetoRiskFor(climate, { theirValuePct: 12 }).level, 'watch');
  assert.equal(tactics.vetoRiskFor(climate, { theirValuePct: 3 }).level, 'low');
  assert.match(tactics.vetoRiskFor(climate, { theirValuePct: 18.5 }).why, /1 package/,
    'the sample behind the reference is in the sentence Nick reads');
});

test('G6d: the sample behind the reference is the packages we can PRICE, not every vetoed one', () => {
  // VERIFIER, 2026-09-18. G6 promised "the one multi-vote package is the
  // reference with n = 1 printed". On league 4 the live sentence reads "well
  // inside the 18% of the 4 packages this league has voted on" — 4 packages
  // drew a veto vote there, but only ONE of them has a proposal row with items
  // we can price, so exactly one supplies the 18%. Quoting 4 overstates the
  // evidence behind the number on a card Nick reads.
  const climate = tactics.vetoClimate(LG, { season: SEASON, priceOfPlayer: () => 1000 });
  assert.equal(climate.n, 1);
  assert.equal(climate.reference_n, 1, 'how many vetoed packages actually supply a skew');
  const live = { votes_required: 5, other_owners: 8, n: 4, reference_n: 1, observed_max_votes: 4,
    reference_skew_pct: 18.1 };
  for (const skew of [3, 12, 18.5]) {
    const why = tactics.vetoRiskFor(live, { theirValuePct: skew }).why;
    assert.doesNotMatch(why, /4 packages/,
      `the 18% reference comes from one package, not four: ${why}`);
    assert.match(why, /\b1 of 4\b/, `say how many of the vetoed packages we can price: ${why}`);
  }
  // Unchanged wording when every vetoed package is priceable.
  assert.match(tactics.vetoRiskFor({ ...live, n: 1, reference_n: 1 }, { theirValuePct: 3 }).why,
    /1 package this league has voted on/);
});

// ======================================================= G7 how Nick looks
test('G7a: never lead with a player the whole league knows he is shopping', () => {
  const self = pricing.selfRead(LEAGUE, { season: SEASON });
  assert.ok(self.known_shopping.some(s => s.player.toLowerCase() === MY_SHOPPED.toLowerCase()),
    'the fixture must make one player visibly shopped');
  const shopped = { name: MY_SHOPPED, position: 'RB', value: 5000, ros_ppg: 15 };
  const other = { name: 'Quiet Piece', position: 'WR', value: 2000, ros_ppg: 11 };
  const out = tactics.tacticsForDeal({ give: [shopped, other],
    get: [{ name: 'Target', position: 'WR', value: 6500, ros_ppg: 16 }],
    manager: { receptiveness: 1 }, self, partnerId: '2',
    valuationOf: p => ({ our_value: p.value, their_value: p.value, multiplier: 1, owns: false, factors: [] }) });
  const looks = out.tactics.find(t => t.key === 'how_nick_looks');
  assert.ok(looks, 'the tactic must fire when the headline piece is the shopped player');
  assert.equal(looks.numbers.avoid_leading_with, MY_SHOPPED);
  assert.equal(looks.numbers.lead_with, 'Quiet Piece');
});

test('G7b: pacing is his real offer history to that person', () => {
  const self = pricing.selfRead(LEAGUE, { season: SEASON });
  const to2 = self.to_each_manager.get('2');
  assert.equal(to2.offers_sent, 5, 'five offers to Hayden, and the one he SENT Nick is not one of them');
  const out = tactics.tacticsForDeal({ give: [{ name: 'A', position: 'WR', value: 1000, ros_ppg: 10 }],
    get: [{ name: 'B', position: 'WR', value: 1000, ros_ppg: 10 }],
    manager: { receptiveness: 1 }, self, partnerId: '2',
    valuationOf: () => ({ our_value: 1000, their_value: 1000, multiplier: 1, owns: false, factors: [] }) });
  const looks = out.tactics.find(t => t.key === 'how_nick_looks');
  assert.equal(looks.numbers.offers_sent, 5);
  assert.equal(looks.numbers.declined, 4);
  assert.equal(looks.numbers.accepted, 1);
});

test('G7c: a pressure point is attributed to a manager only when the evidence names him', () => {
  const self = pricing.selfRead(LEAGUE, { season: SEASON });
  const forHayden = tactics.selfPressurePoints(self, { managerName: 'Hayden Brook' });
  assert.equal(forHayden.attributed.length, 1);
  assert.match(forHayden.attributed[0].why, /wins now/);
  assert.equal(forHayden.league_wide.length, 1, 'the entry naming nobody stays league-wide');
  const forCarl = tactics.selfPressurePoints(self, { managerName: 'Carl Delta' });
  assert.deepEqual(forCarl.attributed, [], 'nothing is attributed to a manager the evidence never names');
});

// =============================================== G8 ladder, runtime, degradation
test('G8a: the anchor ladder is ask / fair / floor, all three still positive for Nick', () => {
  const rung = (giveValue, perception, score) => ({ give_value: giveValue, get_value: 5000,
    perception_delta: perception, score_signed: score,
    i_give: [{ name: `G${giveValue}`, value: giveValue }],
    i_get: [{ name: 'Target', value: 5000 }] });
  const ladder = tactics.anchorLadder([rung(3000, -12, 0.9), rung(4000, -2, 0.6),
    rung(4800, 6, 0.3), rung(5400, 14, 0.1)], { acceptRate: 0.2, acceptRateN: 30 });
  assert.ok(ladder.ask.give_value < ladder.fair.give_value);
  assert.ok(ladder.fair.give_value <= ladder.floor.give_value);
  for (const rungName of ['ask', 'fair', 'floor']) {
    assert.ok(ladder[rungName].score_signed > 0, `${rungName} must still be positive for Nick`);
  }
  assert.equal(ladder.anchor.accept_rate, 0.2);
  assert.equal(ladder.anchor.n, 30);
  assert.equal(ladder.anchor.calibrated, false, 'the band is an anchor, not a fitted probability');

  // The rungs are ranked on what the offer COSTS — what goes out minus what
  // comes back. Ranked on the gross give, a 2-for-2 that also returns a
  // throw-in looked like the dearest offer on the board: measured on league 4,
  // the ladder for D'Andre Swift printed "ask 3,669, floor 10,184" for the same
  // player, because the 10,184 rung was getting 6,000 back.
  // Twice the gross give of the 5,400 rung, but it also gets 9,000 back: it
  // costs LESS, so it cannot be the floor.
  const fat = { give_value: 9000, get_value: 9000, perception_delta: 3, score_signed: 0.5,
    i_give: [{ name: 'Big A', value: 5000 }, { name: 'Big B', value: 4000 }],
    i_get: [{ name: 'Target', value: 5000 }, { name: 'Throw-in', value: 4000 }] };
  const netted = tactics.anchorLadder([...[rung(3000, -12, 0.9), rung(5400, 14, 0.1)], fat],
    { acceptRate: 0.2, acceptRateN: 30 });
  assert.equal(netted.floor.i_give[0].name, 'G5400',
    'the dearest rung is the one that costs the most NET, not the one with the biggest give');
  assert.equal(netted.ask.net_cost, -2000, 'net cost is what goes out minus what comes back');
});

test('G8b: a league with no chat and no transactions still gets ideas, and says what is missing', () => {
  assert.ok(bare.deals.length > 0, 'the counterparty read is not a precondition for an idea');
  const absent = new Set(bare.deals.flatMap(d => d.tactics_absent.map(a => a.key)));
  assert.ok(absent.has('sell_the_crush') && absent.has('buy_the_sour'),
    'the chat tactics must be named as absent, not silently missing');
  for (const d of bare.deals) {
    const reason = d.tactics_absent.find(a => a.key === 'sell_the_crush').reason;
    assert.match(reason, /chat|profile/i);
  }
});

test('G8c: runtime per league is reported on the result', () => {
  for (const r of [found, mutual, bare]) {
    assert.ok(Number.isFinite(r.context.runtime_ms), 'findTrades must report how long it took');
    assert.ok(Number.isFinite(r.context.tactics_ms), 'and how much of that the tactics cost');
    assert.ok(r.context.tactics_ms <= r.context.runtime_ms);
  }
});

test('G8d: the tactic registry is complete and every entry declares what it needs', () => {
  assert.deepEqual(Object.keys(tactics.TACTICS).sort(), [
    'anchor_ladder', 'buy_the_sour', 'consolidate_for_need', 'how_nick_looks', 'hype_window',
    'probe_declared', 'sell_the_crush', 'sneak_in', 'timing', 'veto_proof',
  ], 'the nine tactics Nick named, plus the probe flag G3b requires');
  for (const [k, spec] of Object.entries(tactics.TACTICS)) {
    assert.ok(spec.label && spec.needs && spec.why, `${k} must say what it is, needs and why`);
    assert.equal(spec.fitted, false, `${k} is a hand-set rule and must say so`);
  }
});
