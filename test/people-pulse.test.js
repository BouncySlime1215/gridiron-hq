/**
 * PULSE-01: the chat pulse labels league-mates' new messages (labels only), writes people
 * events, and asks for a target-league replan when a credible statement arrives.
 *
 * The private chat DB is never read: GRIDIRON_CHAT_DB_PATH points at a fixture built here,
 * with made-up speakers, players and messages.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-people-pulse-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { db, run, rows, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const P = await import('../server/services/people/pulse.js');
const J = await import('../server/services/people/pulse-jev.js');
const cli = await import('../scripts/people/pulse.mjs');
const jevCli = await import('../scripts/people/jev-pulse.mjs');

const LEAGUE = 4;
// Fictional players: espn id, name, position, owner roster.
const PLAYERS = [
  [9001, 'Zorblax Quendrick', 'WR', 1],
  [9002, 'Tavish Merrowind', 'RB', 1],
  [9003, 'Ulric Pembrose-Vantly', 'TE', 2],
  [9004, 'Xander Flintlocke', 'QB', 2],
  [9005, 'A.J. Oxleybrook', 'WR', 3],
];

function seed() {
  run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, payload) VALUES (?, 'espn', 'fx', 2026, 'Fixture', '{}')`, LEAGUE);
  for (const [roster, chatName, team] of [[1, 'Speaker One', 'Team Alpha'], [2, 'Speaker Two', 'Team Beta'], [3, 'Speaker Three', 'Team Gamma']]) {
    run(`INSERT OR REPLACE INTO league_member_identity (league_id, roster_id, espn_name, team_name, chat_name, confidence)
         VALUES (?, ?, ?, ?, ?, 'confirmed')`, LEAGUE, String(roster), `Espn ${roster}`, team, chatName);
  }
  for (const [id, name, pos, roster] of PLAYERS) {
    run(`INSERT INTO players (name, position, fantasy_relevant, espn_id) VALUES (?, ?, 1, ?)`, name, pos, id);
    run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, player_name, position,
           lineup_slot_id, is_starter, on_roster, source, first_seen_at, changed_at)
         VALUES (?, 2026, 3, ?, ?, ?, ?, 0, 1, 1, 'live', '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z')`, LEAGUE, roster, id, name, pos);
  }
}
seed();

const lexicon = () => P.buildLexicon(P.leaguePlayers(LEAGUE, db), { excludeWords: P.memberWords(LEAGUE, db) });

// pulse: {msg_id: {want_player, shop, urgency, refusal}} stored as the pulse's own Jev answers.
function makeChat(messages, pulse = {}) {
  if (fs.existsSync(CHAT_PATH)) fs.rmSync(CHAT_PATH);
  const chat = new DatabaseSync(CHAT_PATH);
  chat.exec(`CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT, is_from_me INTEGER,
      ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
    CREATE TABLE jev_chat_signals (msg_id INTEGER NOT NULL, name TEXT, chat_kind TEXT, mentioned_player TEXT, question TEXT NOT NULL,
      probability REAL, evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, question));`);
  const ins = chat.prepare('INSERT INTO messages VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0)');
  for (const m of messages) ins.run(m.id, m.kind ?? 'group', 'fixture chat', m.name, m.me ? 1 : 0, m.ts, m.text);
  J.ensurePulseJevTables(chat);
  const sig = chat.prepare('INSERT INTO jev_pulse_signals VALUES (?, ?, ?, ?, ?)');
  for (const [id, answers] of Object.entries(pulse)) {
    for (const [q, p] of Object.entries(answers)) sig.run(Number(id), q, p, J.PULSE_JEV_VERSION, '2026-09-21T00:00:00Z');
  }
  chat.close();
  return new DatabaseSync(CHAT_PATH, { readOnly: true });
}

/* ---------------------------------------------------------------- labeller */

test('initialisms match how league chats shorten names', () => {
  assert.equal(P.initialism('A.J. Brown'), 'AJB');
  assert.equal(P.initialism('Jaxon Smith-Njigba'), 'JSN');
  assert.equal(P.initialism('Christian McCaffrey'), 'CMC');
});

test('players resolve by full name, unique surname and initialism; a league-mate name never aliases', () => {
  const lex = lexicon();
  assert.deepEqual(P.resolvePlayers('thoughts on Zorblax Quendrick?', lex), [9001]);
  assert.deepEqual(P.resolvePlayers('merrowind looked slow', lex), [9002]);
  assert.deepEqual(P.resolvePlayers('AJO is a WR2 now', lex), [9005]);
  assert.deepEqual(P.resolvePlayers('ajo is a word here, not a name', lex), [], 'initialisms match in capitals only');
  const withMember = P.buildLexicon([...P.leaguePlayers(LEAGUE, db), { espn_id: 9100, name: 'Speaker Wobblethorpe', pos: 'RB', roster_id: 3 }],
    { excludeWords: P.memberWords(LEAGUE, db) });
  assert.deepEqual(P.resolvePlayers('speaker what do you think', withMember), [], 'a member first name is not a player');
});

test('WANT_PLAYER needs a named player the speaker does not own; SHOP and UNTOUCHABLE need his own', () => {
  const lex = lexicon();
  const want = P.labelMessage('would you trade Pembrose-Vantly? what would it take', { speakerRoster: 1, lexicon: lex });
  const w = want.find(s => s.type === 'WANT_PLAYER');
  assert.ok(w, 'a WANT_PLAYER');
  assert.deepEqual(w.players, [9003]);
  assert.equal(w.own, 0);
  assert.ok(!P.labelMessage('would you trade Quendrick?', { speakerRoster: 1, lexicon: lex }).some(s => s.type === 'WANT_PLAYER'),
    'asking about your own player is not a want');
  assert.ok(P.labelMessage('Quendrick is available, taking offers', { speakerRoster: 1, lexicon: lex }).some(s => s.type === 'SHOP'));
  const un = P.labelMessage('Merrowind is not going anywhere', { speakerRoster: 1, lexicon: lex });
  assert.ok(un.some(s => s.type === 'UNTOUCHABLE'));
  assert.ok(!un.some(s => s.type === 'SHOP'));
  assert.deepEqual(P.labelMessage('what time is the game', { speakerRoster: 1, lexicon: lex }), []);
});

test('ownership at the message time decides want vs shop (a player he acquired later was still a want)', () => {
  const lex = lexicon();
  const before = new Map([[9003, 2]]);
  const after = new Map([[9003, 1]]);
  const text = 'I want Pembrose-Vantly';
  assert.ok(P.labelMessage(text, { speakerRoster: 1, lexicon: lex, owners: before }).some(s => s.type === 'WANT_PLAYER'));
  assert.ok(!P.labelMessage(text, { speakerRoster: 1, lexicon: lex, owners: after }).some(s => s.type === 'WANT_PLAYER'));
});

test('the Jev reading adds recall: open_to_trade with a named player is a want or a shop', () => {
  const lex = lexicon();
  const jev = { open_to_trade: 0.9, trade_talk: 0.8, untouchable: 0, complaining: 0, praising: 0, positive: 0, negative: 0 };
  const text = 'Flintlocke hmm';
  assert.deepEqual(P.labelMessage(text, { speakerRoster: 1, lexicon: lex }), [], 'no rule fires on the text alone');
  assert.ok(P.labelMessage(text, { speakerRoster: 1, lexicon: lex, jev }).some(s => s.type === 'WANT_PLAYER'));
  assert.ok(P.labelMessage('Quendrick hmm', { speakerRoster: 1, lexicon: lex, jev }).some(s => s.type === 'SHOP'));
  const low = { ...jev, open_to_trade: 0.55 };
  assert.deepEqual(P.labelMessage(text, { speakerRoster: 1, lexicon: lex, jev: low }), [], 'below the 0.6 bar');
});

test('refusal style, trade reaction and position wants are labelled', () => {
  const lex = lexicon();
  const r = P.labelMessage('lol no', { speakerRoster: 2, lexicon: lex }).find(s => s.type === 'REFUSAL');
  assert.equal(r?.style, 'laugh_no');
  assert.equal(P.labelMessage('that trade is highway robbery', { speakerRoster: 2, lexicon: lex })
    .find(s => s.type === 'TRADE_REACTION')?.reaction, 'fleece');
  assert.equal(P.labelMessage('I need a WR badly', { speakerRoster: 2, lexicon: lex }).find(s => s.type === 'WANT_POS')?.pos, 'WR');
});

/* ------------------------------------------------------------------ weights */

test('weight = follow-through: CRED-01 when given, the pooled WANT_PLAYER prior otherwise, unknown for the rest', () => {
  const want = P.statementWeight('WANT_PLAYER', 1);
  assert.equal(want.weight, 17);
  assert.equal(want.credible, true);
  const shop = P.statementWeight('SHOP', 1);
  assert.equal(shop.weight, null, 'unproven types are unknown, never neutral');
  assert.equal(shop.credible, false);
  const cred = (roster, type) => (roster === 3 && type === 'SHOP' ? { lift: 2.2, n: 28, basis: 'shop -> moved 21d' } : null);
  assert.equal(P.statementWeight('SHOP', 3, cred).credible, true);
  assert.match(P.statementWeight('SHOP', 3, cred).basis, /^cred-01/);
  const noisy = (roster, type) => (type === 'WANT_PLAYER' ? { lift: 0.5, n: 20 } : null);
  assert.equal(P.statementWeight('WANT_PLAYER', 1, noisy).credible, false, 'a manager whose wants never follow through is not credible');
});

/* ------------------------------------------------------------ the pulse tick */

const T0 = '2026-09-21T12:00:00.000Z';
const BASE = [
  { id: 100, name: 'Speaker Two', ts: '2026-09-21T10:00:00Z', text: 'would you trade Quendrick? what would it take' },
  { id: 101, name: 'Speaker One', ts: '2026-09-21T10:05:00Z', text: 'lol no' },
  { id: 102, name: 'Stranger', ts: '2026-09-21T10:06:00Z', text: 'would you trade Quendrick' },
  { id: 103, me: true, name: null, ts: '2026-09-21T10:07:00Z', text: 'would you trade Flintlocke' },
];

test('pulseTick: first pass is a backfill (never replans); a new credible statement is live; re-runs add nothing', () => {
  const chat = makeChat(BASE);
  try {
    const first = P.pulseTick({ database: db, chat, leagueId: LEAGUE, now: T0, pulse02: true });
    assert.equal(first.backfill, true);
    assert.equal(first.read, 2, "a non-member and Nick's own message are never read");
    assert.equal(first.liveCredible.length, 0, 'a backfill never triggers a replan');
    assert.ok(first.statements >= 2);
    const again = P.pulseTick({ database: db, chat, leagueId: LEAGUE, now: T0, pulse02: true });
    assert.equal(again.read, 0);
    assert.equal(again.statements, 0);
  } finally { chat.close(); }

  // 104 has the pulse's Jev answer (the proven path); 106 has none, so rules alone label it and
  // the replan gate holds it back (rules-only WANT_PLAYER F1 < REPLAN_MIN_F1).
  const chat2 = makeChat([...BASE, { id: 104, name: 'Speaker Three', ts: '2026-09-21T13:00:00Z', text: 'I want Merrowind, what do you want for him' },
    { id: 106, name: 'Speaker Two', ts: '2026-09-21T13:01:00Z', text: 'I want Merrowind too, what would it take' }],
  { 104: { want_player: 0.9, shop: 0.05, urgency: 0.05, refusal: 0.05 } });
  try {
    const live = P.pulseTick({ database: db, chat: chat2, leagueId: LEAGUE, now: '2026-09-21T13:05:00Z', pulse02: true });
    assert.equal(live.backfill, false);
    assert.equal(live.read, 2);
    assert.equal(live.with_jev, 1);
    assert.equal(live.liveCredible.length, 1);
    assert.equal(live.liveCredible[0].type, 'WANT_PLAYER');
    assert.equal(live.liveCredible[0].roster_id, 3);
    assert.equal(live.liveCredible[0].source, 'jev');
    assert.equal(live.gated.length, 1, 'the rules-only want is gated');
    assert.equal(live.gated[0].roster_id, 2);
    assert.match(live.gated[0].reason, /F1 0\.651 < 0\.7 \(WANT_PLAYER, rules\)/);
  } finally { chat2.close(); }

  const stored = rows('SELECT * FROM people_pulse WHERE league_id = ? ORDER BY id', LEAGUE);
  const want = stored.find(r => r.msg_id === 104);
  assert.equal(want.statement_type, 'WANT_PLAYER');
  assert.equal(want.player_ids_json, '[9002]');
  assert.equal(want.credible, 1);
  assert.equal(want.live, 1);
  assert.equal(stored.find(r => r.msg_id === 100).live, 0);
  assert.equal(stored.find(r => r.msg_id === 106).credible, 1, 'a gated statement is still stored with its weight');
});

test('people_pulse holds labels only: no text column and no message text in any value', () => {
  const cols = rows('PRAGMA table_info(people_pulse)').map(c => c.name);
  for (const bad of ['text', 'body', 'message', 'name', 'chat_name', 'quote']) assert.ok(!cols.includes(bad), `column ${bad}`);
  const dump = JSON.stringify(rows('SELECT * FROM people_pulse')) + JSON.stringify(rows('SELECT * FROM people_pulse_runs'));
  for (const m of BASE) assert.ok(!dump.includes(m.text), 'a message text leaked into the table');
  assert.ok(!dump.includes('Speaker'), 'a speaker name leaked into the table');
});

test('ownershipTimeline replays executed moves before the snapshot and trusts the snapshot after it', () => {
  // The collector's own DDL (collect-league-transactions.mjs); no migration creates it.
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (league_id INTEGER NOT NULL, season INTEGER NOT NULL,
    tx_id TEXT NOT NULL, type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT, team_id INTEGER,
    member_id TEXT, related_tx_id TEXT, scoring_period INTEGER, bid_amount REAL, is_pending INTEGER, items_json TEXT,
    raw_json TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`);
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, processed_at, items_json, first_seen_at, last_seen_at)
       VALUES (?, 2026, 'd1', 'DRAFT', 'EXECUTED', '2026-07-30T01:00:00Z', '2026-07-30T01:00:00Z', ?, 'x', 'x')`,
  LEAGUE, JSON.stringify([{ type: 'DRAFT', playerId: 9003, toTeamId: 3 }]));
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, processed_at, items_json, first_seen_at, last_seen_at)
       VALUES (?, 2026, 't1', 'TRADE_ACCEPT', 'EXECUTED', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', ?, 'x', 'x')`,
  LEAGUE, JSON.stringify([{ type: 'TRADE', playerId: 9003, fromTeamId: 3, toTeamId: 2 }]));
  const tl = P.ownershipTimeline(LEAGUE, db);
  assert.equal(tl.at('2026-08-15T00:00:00Z').get(9003), 3, 'drafted by roster 3');
  assert.equal(tl.at('2026-09-05T00:00:00Z').get(9003), 2, 'traded to roster 2');
  assert.equal(tl.at('2026-08-15T00:00:00Z').get(9001), 1, 'a player the feed never moved falls back to the snapshot owner');
  assert.equal(tl.at('2026-09-22T00:00:00Z').get(9003), 2, 'after the snapshot: the snapshot');
});

/* ------------------------------------------------------------- the ticker */

test('recentPulse: the ticker reads labels and phrases, never a quote, newest first', () => {
  const r = P.recentPulse(LEAGUE, { database: db, now: '2026-09-21T15:00:00Z' });
  assert.equal(r.status, 'ok');
  assert.ok(r.items.length >= 2);
  assert.ok(r.items[0].as_of >= r.items.at(-1).as_of);
  const want = r.items.find(i => i.type === 'WANT_PLAYER' && i.roster_id === 3);
  assert.equal(want.phrase, 'in-market for Tavish Merrowind');
  assert.equal(want.team_name, 'Team Gamma');
  assert.equal(want.ago, '2h');
  assert.equal(want.credible, true);
  const dump = JSON.stringify(r);
  for (const m of BASE) assert.ok(!dump.includes(m.text));
  assert.equal(P.tickerPhrase({ type: 'WANT_POS', pos: 'WR', player_ids: [] }), 'looking for WR');
  assert.equal(P.tickerPhrase({ type: 'REFUSAL', player_ids: [] }), 'turned a deal down');
});

test('the pulse is default-off: GRIDIRON_PULSE_ENABLED or preview mode turns it on', () => {
  assert.equal(P.pulseEnabled({}), process.env.GRIDIRON_PREVIEW_UNCONFIRMED === '1');
  assert.equal(P.pulseEnabled({ GRIDIRON_PULSE_ENABLED: '1' }), true);
});

/* --------------------------------------------------------------- the replan */

test('requestReplan: no planner / War Room off are statuses; else it launches the producer once, through its lock', async () => {
  const empty = fs.mkdtempSync(path.join(temp, 'noplanner-'));
  assert.equal((await cli.requestReplan(4, { root: empty, flag: () => ({ enabled: true }) })).status, 'no_planner');
  const withPlanner = fs.mkdtempSync(path.join(temp, 'planner-'));
  fs.mkdirSync(path.join(withPlanner, 'scripts/campaign'), { recursive: true });
  fs.writeFileSync(path.join(withPlanner, cli.PLANNER), '');
  assert.equal((await cli.requestReplan(4, { root: withPlanner, flag: () => ({ enabled: false }) })).status, 'warroom_disabled');
  const files = { lock: path.join(withPlanner, 'plans.json.lock'), log: path.join(withPlanner, 'producer.log') };
  const calls = [];
  const launch = (cmd, args, opts) => { calls.push({ args, opts }); return 4242; };
  const on = {};
  const flag = () => ({ enabled: true });
  const r = await cli.requestReplan(4, { root: withPlanner, env: on, launch, files, flag });
  assert.equal(r.status, 'launched');
  assert.deepEqual(calls[0].args.slice(1), [cli.PLANNER], 'every league: a one-league run would drop the others from plans.json');
  assert.equal(calls[0].opts.log, files.log, 'the same log the warroom_plans step reads');
  fs.writeFileSync(files.lock, String(process.pid));
  const busy = await cli.requestReplan(4, { root: withPlanner, env: on, launch, files, flag });
  assert.equal(busy.status, 'already_running', 'a running producer is never doubled');
  assert.equal(calls.length, 1);
  fs.writeFileSync(files.lock, '999999');
  assert.equal((await cli.requestReplan(4, { root: withPlanner, env: on, launch, files, flag })).status, 'launched', 'a stale lock does not block');
});

test('runPulse: a live credible statement asks for a replan and the run row records the outcome', async () => {
  const chat = makeChat([...BASE, { id: 104, name: 'Speaker Three', ts: '2026-09-21T13:00:00Z', text: 'I want Merrowind, what do you want for him' },
    { id: 107, name: 'Speaker Two', ts: '2026-09-21T16:00:00Z', text: 'how much for AJO?' }]);
  chat.close();
  const lines = [];
  const asks = [];
  const replan = async (league, { env }) => { asks.push({ league, env }); return { status: 'launched', detail: 'pid 1' }; };
  const states = [];
  const evaluate = async ({ state, questions }) => {
    states.push(state);
    const want = /how much/.test(state.split('>>>')[1] ?? '') ? 0.9 : 0.05;
    return { answers: Object.fromEntries(Object.keys(questions).map(q => [q, { type: 'boolean', probability: q === 'want_player' ? want : 0.05 }])),
      usage: { inputTokens: 600, outputTokens: 70 } };
  };
  const classify = args => jevCli.classifyPending({ ...args, env: { GRIDIRON_PULSE_JEV: '1' }, evaluate });
  const summary = await cli.runPulse({ leagueId: LEAGUE, env: { GRIDIRON_PULSE_02: '1' }, now: '2026-09-21T16:05:00Z', log: l => lines.push(l), replan, classify });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.jev.status, 'ok');
  assert.equal(summary.jev.ok, 1, 'the one new message was classified before labelling');
  assert.equal(summary.with_jev, 1);
  for (const st of states) assert.ok(!/Speaker (One|Two|Three)/.test(st), 'no league-mate name is sent to Jev');
  assert.match(states[0], />>> SPEAKER: how much for AJO\?/);
  assert.match(states[0], /A\.J\. Oxleybrook \(on another team\)/);
  assert.equal(summary.live_credible, 1);
  assert.equal(summary.replan, 'launched');
  assert.deepEqual(asks.map(a => a.league), [LEAGUE], 'one replan request for the target league');
  assert.match(lines.at(-1), /^people_pulse: \{/);
  const runRow = row('SELECT replan_status, replan_detail FROM people_pulse_runs WHERE league_id = ? ORDER BY id DESC LIMIT 1', LEAGUE);
  assert.equal(runRow.replan_status, summary.replan);
  assert.match(runRow.replan_detail, /1 credible \(WANT_PLAYER\)/);
  const quiet = await cli.runPulse({ leagueId: LEAGUE, env: { GRIDIRON_PULSE_02: '1' }, now: '2026-09-21T16:10:00Z', log: () => {}, replan, classify });
  assert.equal(quiet.replan, 'not_needed');
  assert.equal(asks.length, 1, 'no new credible statement, no replan');
});

test('grading: per-type precision / recall against hand labels', () => {
  const universe = new Set([1, 2, 3, 4]);
  const predicted = new Map([[1, [{ type: 'WANT_PLAYER' }]], [2, [{ type: 'WANT_PLAYER' }]]]);
  const truth = new Map([[1, [{ type: 'WANT_PLAYER' }]], [3, [{ type: 'WANT_PLAYER' }]]]);
  const g = cli.gradeLabels(universe, predicted, truth, ['WANT_PLAYER']);
  assert.deepEqual(g.per.WANT_PLAYER, { tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5 });
  assert.equal(g.micro.f1, 0.5);
});

/* ------------------------------------------------------------ people events */

test('the engine adapter turns people_pulse rows into people.statement events (labels only)', async () => {
  const backfill = await import('../server/services/engine/backfill.js');
  const { getEvents } = await import('../server/services/engine/events.js');
  const r = backfill.backfillStream('people_pulse', { database: db });
  assert.equal(r.table_state, 'present');
  assert.ok(r.inserted >= 3, `inserted ${r.inserted}`);
  assert.equal(backfill.backfillStream('people_pulse', { database: db }).inserted, 0, 'a re-run appends nothing');
  const evs = getEvents({ asOf: '2026-09-30T00:00:00Z', leagueId: LEAGUE, types: ['people.statement'] });
  const want = evs.find(e => e.payload.statement_type === 'WANT_PLAYER' && e.payload.roster_id === 3);
  assert.ok(want, 'the live want is an event');
  assert.equal(want.league_id, LEAGUE);
  assert.equal(want.payload.credible, true);
  assert.deepEqual(want.payload.espn_player_ids, [9002]);
  const dump = JSON.stringify(evs);
  for (const m of BASE) assert.ok(!dump.includes(m.text));
});

test('wiring: the refresh loop runs the pulse after the chat step; the ticker route is league-checked', () => {
  const refresh = fs.readFileSync(path.join(root, 'scripts/refresh-live-data.mjs'), 'utf8');
  const chatStep = refresh.indexOf("step('league_chat'");
  const pulseStep = refresh.indexOf("step('people_pulse'");
  assert.ok(chatStep > 0 && pulseStep > chatStep, 'people_pulse runs right after league_chat');
  const trades = fs.readFileSync(path.join(root, 'server/routes/trades.js'), 'utf8');
  const route = trades.slice(trades.indexOf("r.get('/:leagueId/people/pulse'"));
  assert.match(route.slice(0, 400), /league\(req, res\)/, 'the route checks league membership');
  // Trades → People shows each manager's recent chatter on their card (the pulse, per manager).
  const board = fs.readFileSync(path.join(root, 'client/src/components/brain/ManagerBoard.tsx'), 'utf8');
  assert.match(board, /useApi<[^>]+>\(`\/trades\/\$\{leagueId\}\/people\/pulse`/);
  assert.match(board, /data-testid="manager-chatter"/);
});

test('FIX-316-3: a statement from a manager Nick marked unreachable or not trading is stored, never credible, never replans', () => {
  assert.match(P.nickMuted({ unreachable: true }), /unreachable/);
  assert.match(P.nickMuted({ deprioritised: true }), /not trading/);
  assert.equal(P.nickMuted({ in_active_pool: true }), null);
  assert.equal(P.nickMuted(null), null);
  const chat = makeChat([...BASE, { id: 104, name: 'Speaker Three', ts: '2026-09-21T13:00:00Z', text: 'I want Merrowind, what do you want for him' },
    { id: 990, name: 'Speaker Three', ts: '2026-09-21T14:00:00Z', text: 'I want Merrowind, what do you want for him now' }]);
  try {
    const muted = P.pulseTick({ database: db, chat, leagueId: LEAGUE, now: '2026-09-21T14:05:00Z',
      nickByRoster: new Map([['3', { unreachable: true }]]) });
    assert.equal(muted.liveCredible.length, 0, 'never asks for a replan');
    const row = rows('SELECT credible, weight_basis FROM people_pulse WHERE league_id = ? AND msg_id = 990', LEAGUE)[0];
    assert.equal(row.credible, 0);
    assert.match(row.weight_basis, /Nick's read: unreachable/);
  } finally { chat.close(); }
});

test('FIX-316-2: loadCredibility reads CRED-01 through readCredibility + pulseCredibility, else the pooled prior', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-cred-'));
  assert.equal((await cli.loadCredibility(LEAGUE, db, { root })).source, 'pooled_prior', 'no module on the tree');
  const real = await cli.loadCredibility(LEAGUE, db);
  assert.match(real.source, /^pooled_prior \(no people_credibility (run stored yet|table)/);
  assert.equal(real.fn, null);
});

/* ------------------------------------------------------------- PULSE-02 */

test('PULSE-02 gate: only a type proven at F1 >= 0.7 on the held-out labels may replan, per labelling path', () => {
  assert.equal(P.REPLAN_MIN_F1, 0.7);
  assert.deepEqual(P.replanGate('WANT_PLAYER', 'jev'), { ok: true, f1: P.LABEL_QUALITY.jev.WANT_PLAYER, reason: null });
  assert.equal(P.replanGate('WANT_PLAYER', 'rules').ok, false, 'rules alone are not proven for WANT_PLAYER');
  for (const type of ['SHOP', 'URGENCY']) {
    for (const source of ['jev', 'rules']) assert.equal(P.replanGate(type, source).ok, false, `${type} (${source}) is gated`);
  }
  assert.match(P.replanGate('NEW_TYPE', 'jev').reason, /unmeasured/);
  for (const source of ['jev', 'rules']) {
    for (const [type, f1] of Object.entries(P.LABEL_QUALITY[source])) {
      assert.equal(P.replanGate(type, source).ok, f1 >= 0.7, `${type} ${source} gate matches its measured F1`);
    }
  }
  // A proven type that later re-measures below the bar is gated again.
  const worse = { jev: { ...P.LABEL_QUALITY.jev, WANT_PLAYER: 0.69 } };
  assert.equal(P.replanGate('WANT_PLAYER', 'jev', worse).ok, false);
});

test('PULSE-02 labeller: a rule hit needs the Jev answer >= lo; Jev alone needs >= hi; a bare reply takes the thread\'s player', () => {
  const lex = lexicon();
  const cuts = { ...P.PULSE_CUTS, WANT_PLAYER: { lo: 0.35, hi: 0.9 }, SHOP: { lo: 0.5, hi: 0.6 } };
  const ask = 'would you trade Pembrose-Vantly?';
  const q = p => ({ want_player: p, shop: 0.05, urgency: 0.05, refusal: 0.05 });
  const wants = (text, pulse, extra = {}) => P.labelMessage(text, { speakerRoster: 1, lexicon: lex, pulse, cuts, ...extra })
    .filter(s => s.type === 'WANT_PLAYER');
  assert.equal(wants(ask, q(0.5))[0]?.source, 'jev');
  assert.deepEqual(wants(ask, q(0.2)), [], 'a rule hit Jev disagrees with is dropped');
  assert.deepEqual(wants('Pembrose-Vantly hmm', q(0.5)), [], 'no rule, Jev below hi');
  assert.deepEqual(wants('Pembrose-Vantly hmm', q(0.95))[0]?.players, [9003], 'Jev alone above hi');
  assert.deepEqual(wants('me', q(0.95), { contextPlayers: [9003, 9001] })[0]?.players, [9003],
    'a bare "me" takes the players named just before it that the speaker does not own');
  assert.equal(P.labelMessage(ask, { speakerRoster: 1, lexicon: lex }).find(s => s.type === 'WANT_PLAYER')?.source, 'rules',
    'no Jev answer: rules alone, as PULSE-01');
  const shop = P.labelMessage('anyone want him?', { speakerRoster: 1, lexicon: lex, cuts,
    pulse: { want_player: 0.05, shop: 0.8, urgency: 0.05, refusal: 0.05 }, contextPlayers: [9001] });
  assert.deepEqual(shop.find(s => s.type === 'SHOP')?.players, [9001]);
});

test('PULSE-02 lexicon: dotless full names, run-together hyphenated first names, lower-case consonant initialisms', () => {
  const four = [
    { espn_id: 1, name: 'A.J. Quillfeather', pos: 'WR', roster_id: 1 },
    { espn_id: 2, name: 'Amon-Ra St. Dorrance', pos: 'WR', roster_id: 2 },
    { espn_id: 3, name: 'Brock Tuvelle', pos: 'TE', roster_id: 3 },
    { espn_id: 4, name: 'DK Marrowgate', pos: 'WR', roster_id: 3 },
  ];
  const lex = P.buildLexicon(four, { pulse02: true });
  const off = P.buildLexicon(four, { pulse02: false });
  assert.deepEqual(P.resolvePlayers('gimme amonra', off), [], 'flag off: PULSE-01 aliases only');
  assert.deepEqual(P.resolvePlayers('ajq for bt?', off), [], 'flag off: no lower-case initialisms');
  assert.deepEqual(P.resolvePlayers('aj quillfeather for you', lex), [1]);
  assert.deepEqual(P.resolvePlayers('gimme amonra', lex), [2]);
  assert.deepEqual(P.resolvePlayers('st dorrance is a stud', lex), [2]);
  assert.deepEqual(P.resolvePlayers('ajq for bt?', lex), [1], 'ajq: one leading vowel, then consonants');
  assert.deepEqual(P.resolvePlayers('dk for ajq', lex).sort(), [1, 4]);
  assert.deepEqual(P.resolvePlayers('lol idk tbh', lex), [], 'chat shorthand never aliases');
});

test('PULSE-02 chatTime: the chat DB\'s zone-less ts_utc is UTC on every machine', () => {
  assert.equal(P.chatTime('2026-09-15T16:39:43').toISOString(), '2026-09-15T16:39:43.000Z');
  assert.equal(P.chatTime('2026-09-15 16:39:43').toISOString(), '2026-09-15T16:39:43.000Z');
  assert.equal(P.chatTime('2026-09-15T16:39:43Z').toISOString(), '2026-09-15T16:39:43.000Z');
  assert.equal(P.chatTime('2026-09-15T12:39:43-04:00').toISOString(), '2026-09-15T16:39:43.000Z');
});

test('PULSE-02 ownership: a trade the feed logged only as a proposal counts when a weekly snapshot shows it landed', () => {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, processed_at, items_json, first_seen_at, last_seen_at)
       VALUES (?, 2026, 'd4', 'DRAFT', 'EXECUTED', '2026-07-30T01:00:00Z', '2026-07-30T01:00:00Z', ?, 'x', 'x')`,
  LEAGUE, JSON.stringify([{ type: 'DRAFT', playerId: 9004, toTeamId: 3 }]));
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, processed_at, items_json, first_seen_at, last_seen_at)
       VALUES (?, 2026, 'p4', 'TRADE_PROPOSAL', 'CANCELED', '2026-09-10T00:00:00Z', NULL, ?, 'x', 'x')`,
  LEAGUE, JSON.stringify([{ type: 'TRADE', playerId: 9004, fromTeamId: 3, toTeamId: 2 }]));
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, processed_at, items_json, first_seen_at, last_seen_at)
       VALUES (?, 2026, 'p5', 'TRADE_PROPOSAL', 'CANCELED', '2026-09-15T00:00:00Z', NULL, ?, 'x', 'x')`,
  LEAGUE, JSON.stringify([{ type: 'TRADE', playerId: 9004, fromTeamId: 2, toTeamId: 1 }]));
  const tl = P.ownershipTimeline(LEAGUE, db, { pulse02: true });
  assert.equal(P.ownershipTimeline(LEAGUE, db, { pulse02: false }).at('2026-09-12T00:00:00Z').get(9004), 3,
    'flag off: a proposal-only trade is not inferred (PULSE-01 behaviour)');
  assert.equal(tl.at('2026-09-05T00:00:00Z').get(9004), 3, 'drafted by roster 3');
  assert.equal(tl.at('2026-09-12T00:00:00Z').get(9004), 2, 'the snapshot shows roster 2: the 09-10 proposal happened');
  assert.equal(tl.at('2026-09-18T00:00:00Z').get(9004), 2, 'no snapshot ever shows roster 1: that proposal did not');
});

test('PULSE-02 Jev state: SPEAKER / NICK / OTHER and whose team each player is on; spend stops at the daily cap', async () => {
  assert.equal(J.ownerTag(1, 1, 5), "on SPEAKER's team");
  assert.equal(J.ownerTag(5, 1, 5), "on NICK's team");
  assert.equal(J.ownerTag(2, 1, 5), 'on another team');
  assert.equal(J.ownerTag(undefined, 1, 5), 'not on a team');
  const st = J.pulseJevState({ chat_kind: 'dm', text: 'me' }, [{ who: 'NICK', text: 'anyone want X?' }], [{ name: 'X Y', tag: "on NICK's team" }]);
  assert.match(st, /private DM with NICK/);
  assert.match(st, /^NICK: anyone want X\?$/m);
  assert.match(st, /^>>> SPEAKER: me$/m);

  const chat = makeChat([{ id: 500, name: 'Speaker One', ts: '2026-09-22T10:00:00Z', text: 'hello' },
    { id: 501, name: 'Speaker Two', ts: '2026-09-22T10:01:00Z', text: 'hi' },
    { id: 502, name: 'Speaker Two', ts: '2026-09-22T10:02:00Z', text: 'hey' }]);
  chat.close();
  const w = new DatabaseSync(CHAT_PATH);
  let calls = 0;
  const evaluate = async () => { calls += 1; return { answers: { want_player: { probability: 0.1 } }, usage: { inputTokens: 1e6, outputTokens: 0 } }; };
  const at = () => new Date('2026-09-22T12:00:00Z');
  const first = await jevCli.classifyPulse({ chat: w, database: db, leagueId: LEAGUE, evaluate, now: at,
    msgs: jevCli.pendingMessages(w, ['Speaker One', 'Speaker Two'], { afterMsgId: 499 }).slice(0, 2), env: { GRIDIRON_PULSE_JEV_USD_DAY: '1' } });
  assert.equal(first.ok, 2);
  assert.equal(J.spentOn(w, '2026-09-22'), 0.084, 'two $0.042 calls are on the day\'s ledger');
  const second = await jevCli.classifyPulse({ chat: w, database: db, leagueId: LEAGUE, evaluate, now: at,
    msgs: jevCli.pendingMessages(w, ['Speaker One', 'Speaker Two'], { afterMsgId: 499 }), env: { GRIDIRON_PULSE_JEV_USD_DAY: '0.1' } });
  assert.equal(second.skipped_done, 2, 'answered messages are never re-sent');
  assert.equal(calls, 2, 'one more $0.042 call would pass the $0.10 cap: nothing is sent');
  assert.match(second.stopped, /daily cap/);
  w.close();
  assert.deepEqual(await jevCli.classifyPending({ leagueId: LEAGUE, database: db, env: {} }), { status: 'off' }, 'a paid call is opt-in');
  assert.deepEqual(await jevCli.classifyPending({ leagueId: LEAGUE, database: db, env: { GRIDIRON_PULSE_JEV: '1' } }), { status: 'no_key' });
  const quiet = await cli.runPulse({ leagueId: LEAGUE, env: { GRIDIRON_PULSE_02: '1' }, now: '2026-09-22T12:00:00Z', log: () => {}, replan: async () => ({ status: 'x' }) });
  assert.equal(quiet.jev.status, 'off', 'the pulse without the opt-in sends nothing');
});

test('PULSE-02 is grading only until GRIDIRON_PULSE_02=1: flag off, the tick labels and replans exactly as PULSE-01', () => {
  assert.equal(P.PULSE_02_FLAG, 'GRIDIRON_PULSE_02');
  assert.equal(P.pulse02On({}), false, 'default off');
  assert.equal(P.pulse02On({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false, 'preview mode never turns it on');
  assert.equal(P.pulse02On({ GRIDIRON_PULSE_02: '1' }), true);
  // 110: rules-only want (PULSE-02 would gate it). 111: a stored Jev answer that disagrees
  // (PULSE-02 would drop the rule hit); flag off never reads it.
  const cursor = P.lastCursor(LEAGUE, db);
  const chat = makeChat([...BASE,
    { id: cursor + 10, name: 'Speaker Two', ts: '2026-09-22T13:00:00Z', text: 'I want Merrowind, what would it take' },
    { id: cursor + 11, name: 'Speaker Three', ts: '2026-09-22T13:01:00Z', text: 'I want Quendrick, what do you want for him' }],
  { [cursor + 11]: { want_player: 0.05, shop: 0.05, urgency: 0.05, refusal: 0.05 } });
  try {
    const r = P.pulseTick({ database: db, chat, leagueId: LEAGUE, now: '2026-09-22T13:05:00Z', env: {} });
    assert.equal(r.read, 2);
    assert.equal(r.with_jev, 0, 'flag off: the pulse Jev answers are not read');
    assert.deepEqual(r.gated, [], 'flag off: no replan gate');
    assert.deepEqual(r.liveCredible.map(x => x.type), ['WANT_PLAYER', 'WANT_PLAYER'], 'both credible wants replan, as PULSE-01');
  } finally { chat.close(); }
  const stored = rows('SELECT labeller_version FROM people_pulse WHERE league_id = ? AND msg_id > ?', LEAGUE, cursor);
  assert.ok(stored.length >= 2);
  for (const s of stored) assert.equal(s.labeller_version, 'pulse-1');
  assert.equal(P.PULSE_VERSION, 'pulse-1');
  assert.equal(P.PULSE_02_VERSION, 'pulse-2');
});
