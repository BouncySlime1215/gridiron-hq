/**
 * NEWS-EDGE through Nick's rule gate (batch D item 8d). The news-edge route (news-lag-trader.js)
 * turns injury news into "buy the backup", "buy low", "claim" and "hold or sell" rows. Until this
 * unit it served them ungated, so the Trades area did not draw it (test/trades-area.test.js).
 *
 * What each row kind must pass, from Nick's side (campaign/never-give.js#ruleGate, the one gate):
 *   buy_beneficiary / buy_low   a trade: get = the target, from the target's owner. Every rule
 *                               (never get 290, no buy-back of a player he sold, 83+ floor, unscored
 *                               and unpriced fail closed). For another team's seat, only when Nick
 *                               owns the target (then he would be giving him: never give).
 *   claim_waiver                not a trade: never get 290, no buy-back, and fail closed when the
 *                               rules are unreadable. The 83+ floor and pricing are trade rules.
 *   hold_or_sell                selling Nick's player: never give (160 / 80 / 277), fail closed
 *                               when unreadable. No package is proposed, so no overpay check.
 *   already_held                no move: kept.
 *   a row whose player id did not resolve fails closed wherever a rule reads it.
 * Every dropped row is counted in dropped_by_rule, so the UI can show "N ideas hidden by your rules".
 * Made-up ids, names and values only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-news-edge-rules-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const plansFile = path.join(temp, 'plans.json');
process.env.GRIDIRON_WARROOM_PLANS = plansFile;
delete process.env.GRIDIRON_WARROOM_OBJECTIVES;

const { db, row, rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const NG = await import('../server/services/campaign/never-give.js');
const news = await import('../server/services/news-lag-trader.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const L = 4, ME = '5';
const DB = { row, rows };
const PLAYERS = [[80, 'Rb Pinned'], [160, 'Wr Pinned'], [277, 'Wr Maybe'], [290, 'Wr Sold'], [101, 'Alpha Chip'],
  [103, 'Charlie Low'], [104, 'Delta Depth'], [105, 'Echo Sold'], [107, 'Golf Mine'], [110, 'Hotel Unpriced']];
for (const [id, name] of PLAYERS) run('INSERT INTO players (id, name, position, espn_id) VALUES (?, ?, ?, ?)', id, name, 'WR', 7000 + id);
const FC = { 80: 5000, 160: 5000, 277: 3000, 290: 5000, 101: 4000, 103: 3000, 104: 1000, 105: 2000, 107: 2000 };
for (const [id, v] of Object.entries(FC)) run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)`, Number(id), v);
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, espn_s2, swid, connection_status)
     VALUES (?, 'espn', 'news-4', 2026, 'News League', '{"teams":[]}', 10, ?, 'x', 'y', 'connected')`, L, ME);
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`);
// Nick (5) sold 105 to team 2 this season.
run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, processed_at, items_json, first_seen_at, last_seen_at)
     VALUES (?, 2026, 'tx1', 'TRADE_ACCEPT', 'EXECUTED', 'PROCESS', '2026-09-10T12:00:00Z', ?, 'now', 'now')`, L,
JSON.stringify([{ playerId: 7105, fromTeamId: 5, toTeamId: 2, type: 'TRADE' }, { playerId: 7107, fromTeamId: 2, toTeamId: 5, type: 'TRADE' }]));
// Served blue-chip board: 101 is a Blue chip, 103 is not; 290, 105, 110 are off the board.
fs.writeFileSync(plansFile, JSON.stringify({ schema: 'warroom-plans/1', leagues: [{ league: L, me: ME,
  blue_chips: { status: 'ok', value: { rows: [[101, 90], [103, 70], [104, 50], [107, 85]]
    .map(([player, score]) => ({ player: String(player), score })) } } }] }));

/** One news row as newsOpportunities serves it (ids added by this unit). */
const opp = (kind, { target = null, owner = '2', subject = 107, subjectOwner = ME } = {}) => ({
  subject: { name: `S${subject}`, player_id: subject == null ? null : String(subject), owner_roster_id: subjectOwner },
  action: { kind, target: `T${target}`, target_id: target == null ? null : String(target), target_owner_roster_id: owner },
  age_hours: 1,
});
const gated = (list, teamId = ME) => news.gateNews(NG.ruleGate(DB, { leagueId: L, teamId }), { opportunities: list });
const kinds = out => out.opportunities.map(o => `${o.action.kind}:${o.action.target_id ?? o.subject.player_id}`);

test('buys pass every trade rule: 290, a sold player, below 83, unscored and unpriced are dropped and counted', () => {
  const out = gated([
    opp('buy_beneficiary', { target: 101 }), // Blue chip, priced: kept
    opp('buy_beneficiary', { target: 290 }), // never get
    opp('buy_low', { target: 105 }), // sold this season: no buy-back from any team
    opp('buy_low', { target: 103 }), // scores 70, below the Blue chip floor
    opp('buy_beneficiary', { target: 110 }), // unscored and unpriced: fails closed
    opp('buy_beneficiary', { target: null }), // the name did not resolve to a player: fails closed
  ]);
  assert.deepEqual(kinds(out), ['buy_beneficiary:101']);
  assert.equal(out.dropped_by_rule, 5);
});

test('claims: never 290, never a buy-back, an unresolved id fails closed; the 83+ floor is a trade rule', () => {
  const out = gated([
    opp('claim_waiver', { target: 103, owner: null }), // not a trade: kept though it scores 70
    opp('claim_waiver', { target: 290, owner: null }),
    opp('claim_waiver', { target: 105, owner: null }),
    opp('claim_waiver', { target: null, owner: null }),
  ]);
  assert.deepEqual(kinds(out), ['claim_waiver:103']);
  assert.equal(out.dropped_by_rule, 3);
});

test('hold or sell: never on 160, 80 or 277; another of Nick\'s players is kept; already held is kept', () => {
  const out = gated([
    opp('hold_or_sell', { target: null, subject: 160 }),
    opp('hold_or_sell', { target: null, subject: 80 }),
    opp('hold_or_sell', { target: null, subject: 277 }),
    opp('hold_or_sell', { target: null, subject: 107 }),
    opp('hold_or_sell', { target: null, subject: null }),
    opp('already_held', { target: 104, owner: ME }),
  ]);
  assert.deepEqual(kinds(out), ['hold_or_sell:107', 'already_held:104']);
  assert.equal(out.dropped_by_rule, 4);
});

test('another team\'s seat: a buy of Nick\'s untouchable is dropped (he would give him); their own moves are theirs', () => {
  const out = gated([
    opp('buy_beneficiary', { target: 160, owner: ME }), // team 2 buying Nick's 160: Nick gives 160
    opp('buy_beneficiary', { target: 103, owner: '3' }), // between two other teams: not Nick's rules
    opp('claim_waiver', { target: 290, owner: null }),
    opp('hold_or_sell', { target: null, subject: 101, subjectOwner: '2' }),
  ], '2');
  assert.deepEqual(kinds(out), ['buy_beneficiary:103', 'claim_waiver:290', 'hold_or_sell:101']);
  assert.equal(out.dropped_by_rule, 1);
});

test('unreadable rules drop every move, and an unknown row kind fails closed', () => {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, processed_at, items_json, first_seen_at, last_seen_at)
       VALUES (?, 2026, 'bad', 'TRADE_ACCEPT', 'EXECUTED', 'PROCESS', '2026-09-11T12:00:00Z', '{not json', 'now', 'now')`, L);
  try {
    const out = gated([opp('buy_beneficiary', { target: 101 }), opp('claim_waiver', { target: 103, owner: null }),
      opp('hold_or_sell', { subject: 107 }), opp('already_held', { target: 104, owner: ME })]);
    assert.deepEqual(kinds(out), ['already_held:104'], 'no move is served when the rules cannot be read');
    assert.equal(out.dropped_by_rule, 3);
  } finally { run(`DELETE FROM league_transactions_raw WHERE tx_id = 'bad'`); }
  const odd = gated([opp('mystery_kind', { target: 101 })]);
  assert.equal(odd.opportunities.length, 0);
  assert.equal(odd.dropped_by_rule, 1);
});

test('the served route answer is the gated one: dropped_by_rule rides on every answer, even an empty one', () => {
  const out = news.newsOpportunities(L, { myTeamId: ME, hours: 24 });
  assert.equal(out.dropped_by_rule, 0, 'no signals: nothing dropped, and the count is still served');
  assert.deepEqual(out.opportunities, []);
  // A league with no team of Nick's passes through the gate unchanged, with a zero count.
  const through = news.gateNews(NG.ruleGate(DB, { leagueId: 99 }), { opportunities: [opp('buy_beneficiary', { target: 290 })] });
  assert.equal(through.opportunities.length, 1);
  assert.equal(through.dropped_by_rule, 0);
});

test('end to end: served rows carry app player ids, and a claim of 290 is dropped while a clean claim is served', () => {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const put = db.prepare(`INSERT INTO nfl_news_signals (news_id, player_key, player_id, player_name, team, signal_type, status,
      confidence, published_at, evidence_span, extractor_version, verification_state, verification_reason)
      VALUES (?, ?, ?, ?, 'XXX', 'availability', 'active', 0.9, datetime('now', '-1 hours'), 'made-up clause', 'test', 'verified', 'test')`);
    put.run(1, 'k290', '290', 'Wr Sold');
    put.run(2, 'k103', '103', 'Charlie Low');
    const out = news.newsOpportunities(L, { myTeamId: ME, hours: 24 });
    assert.equal(out.signals_considered, 2);
    assert.deepEqual(kinds(out), ['claim_waiver:103'], 'unrostered positive news is a claim; 290 never comes back');
    assert.equal(out.dropped_by_rule, 1);
    const raw = news.newsOpportunitiesRaw(L, { myTeamId: ME, hours: 24 });
    assert.deepEqual(raw.opportunities.map(o => o.action.target_id).sort(), ['103', '290'], 'the raw rows carry players.id');
  } finally {
    // nfl_news_signals is append-only (a trigger refuses deletes); this is the file's last test and the DB is a temp file.
    db.exec('PRAGMA foreign_keys = ON');
  }
});
