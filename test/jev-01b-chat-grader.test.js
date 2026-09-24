/**
 * JEV-01b: grading `jev_chat_signals` against what the league did later, and
 * the flag that blends the graded claim into manager_signals.
 *
 * Pre-registration: docs/evidence/2026-09-24/jev-01b-chat-preregistration.md.
 * Guarantees:
 *  - leak rule: a unit is graded only after its 14-day window closes and only
 *    inside transaction coverage; the claim reads messages before the cutoff,
 *    the outcome reads transactions after it;
 *  - `own_roster.untouchable` units exist only for a player the speaker owned at
 *    the message, and a drop inside the window grades the declaration as broken;
 *  - every absence is typed: no corpus, no trusted identity, no transactions,
 *    thin — never a default probability;
 *  - GRIDIRON_JEV_CHAT_BLEND off writes exactly what main writes; on, a measured
 *    question adds `jev_blend` rows, which are declared priceable: false.
 *
 * The private chat DB is never read: GRIDIRON_CHAT_DB_PATH points at a fixture
 * with made-up names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-jev01b-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;
process.env.SCHEDULER_DISABLED = '1';
delete process.env.GRIDIRON_JEV_CHAT_BLEND;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const DAY = 86400000;
const COVERAGE_START = Date.parse('2026-05-01T00:00:00Z');
const AS_OF = Date.parse('2026-09-24T00:00:00Z');
const iso = ms => new Date(ms).toISOString();
const NAMES = ['Alpha One', 'Bravo Two', 'Charlie Three', 'Delta Four'];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// ------------------------------------------------------------ chat fixture
const chat = new DatabaseSync(CHAT_PATH);
chat.exec(`
  CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT,
    is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
  CREATE TABLE jev_chat_signals (msg_id INTEGER NOT NULL, name TEXT, chat_kind TEXT, mentioned_player TEXT,
    question TEXT NOT NULL, probability REAL, evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, question));
  CREATE TABLE manager_chat_profile(name TEXT, msgs, group_msgs, tapbacks, night_share, p_trade_talk,
    p_trash_talk, p_non_fantasy, confidence_mean, p_competitive, p_friendly, p_defensive, p_open_to_trade,
    p_reacting_to_loss, p_own_complaining, p_own_untouchable, first_msg, last_msg, computed_at);
  CREATE TABLE manager_player_sentiment (name TEXT, player TEXT, sentiment_mean REAL, n INTEGER, last_mention TEXT);
`);
let msgId = 0;
const insMsg = chat.prepare(`INSERT INTO messages VALUES (?, 'group', 'league', 'h', ?, 0, ?, 'x', 0, 0)`);
const insSig = chat.prepare(`INSERT INTO jev_chat_signals VALUES (?, ?, 'group', ?, ?, ?, '2026-09-23')`);
function say(name, ms, question, p, player = null) {
  msgId++;
  insMsg.run(msgId, name, iso(ms));
  insSig.run(msgId, name, player, question, p);
  return msgId;
}

// Weekly cutoffs from the start of transaction coverage. Every manager says
// something each week two days before the cutoff; when he is keen (p > 0.6) he
// proposes a trade three days after it.
const trades = []; // { team, at }
const claims = new Map(); // `${team}|${k}` -> p
const r = rng(3);
for (let k = 0; COVERAGE_START + k * 7 * DAY < AS_OF; k++) {
  const t = COVERAGE_START + k * 7 * DAY;
  NAMES.forEach((name, i) => {
    const p = Math.round(r() * 100) / 100;
    claims.set(`${i + 1}|${k}`, p);
    say(name, t - 2 * DAY, 'open_to_trade', p);
    if (p > 0.6 && t + 3 * DAY < AS_OF) trades.push({ team: i + 1, at: t + 3 * DAY });
  });
}
// A later, louder message one hour after cutoff 5: it belongs to cutoff 6's
// lookback and must not raise cutoff 5's claim.
const LEAK_K = 5;
say(NAMES[0], COVERAGE_START + LEAK_K * 7 * DAY + 3600000, 'open_to_trade', 0.99);
// Serving: everyone spoke in the week before AS_OF.
NAMES.forEach(name => say(name, AS_OF - 2 * DAY, 'open_to_trade', 0.8));

// Declarations by Bravo Two (team 2), who owns Player A (espn 502) and Player B (503).
const DECL_BROKEN = say('Bravo Two', Date.parse('2026-08-01T12:00:00Z'), 'own_roster.untouchable', 0.9, 'Player A');
const DROP_A_AT = Date.parse('2026-08-05T12:00:00Z');
say('Bravo Two', Date.parse('2026-08-20T12:00:00Z'), 'own_roster.untouchable', 0.9, 'Player A'); // dropped: not his
say('Bravo Two', Date.parse('2026-08-10T12:00:00Z'), 'own_roster.untouchable', 0.8, 'Player B'); // held
say('Bravo Two', Date.parse('2026-08-11T12:00:00Z'), 'own_roster.untouchable', 0.7, 'Player Z'); // never his
say('Bravo Two', Date.parse('2026-09-20T12:00:00Z'), 'own_roster.untouchable', 0.9, 'Player B'); // unsettled
// Nick's own messages: roster 5's identity is 'ME', and he is never graded or served.
for (let k = 0; COVERAGE_START + k * 7 * DAY < AS_OF; k++) say('ME', COVERAGE_START + k * 7 * DAY - 2 * DAY, 'open_to_trade', 0.9);
say('ME', AS_OF - 2 * DAY, 'open_to_trade', 0.9);
chat.close();

// ------------------------------------------------------------ app fixture
const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
const signals = await import('../server/services/manager-signals.js');
const grader = await import('../server/services/jev/chat-grader.js');
const { openChatDb } = signals;

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const LEAGUE = 21;
const members = NAMES.map((n, i) => ({ id: `{M${i + 1}}`, firstName: n.split(' ')[0], lastName: n.split(' ')[1] }));
const nick = { id: '{M5}', firstName: 'Nick', lastName: 'Five' };
const payload = {
  scoringPeriodId: 4, members: [...members, nick],
  teams: [...members, nick].map((m, i) => ({ id: i + 1, name: `Team ${i + 1}`, owners: [m.id],
    record: { overall: { wins: 1, losses: 1, ties: 0, pointsFor: 200, pointsAgainst: 200 } }, roster: { entries: [] } })),
  schedule: [],
  // FIX-289-3: a 15-slot league (QB, 2 RB, 2 WR, TE, FLEX, D/ST, K, 6 bench) plus one IR slot,
  // which does not count toward roster size.
  settings: { rosterSettings: { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 6, 21: 1, 3: 0 } } },
};
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, roster_positions)
     VALUES (?, 'espn', 'espn-jev-21', 2026, 'L21', ?, 5, '5', '[]')`, LEAGUE, JSON.stringify(payload));
for (let i = 0; i < 4; i++) {
  run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name, chat_name,
         match_method, confidence) VALUES (?, ?, ?, ?, ?, ?, 'confirmed by Nick', 'confirmed')`,
  LEAGUE, String(i + 1), members[i].id, NAMES[i], `Team ${i + 1}`, NAMES[i]);
}
run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name, chat_name,
       match_method, confidence) VALUES (?, '5', '{M5}', 'Nick Five', 'Team 5', 'ME', 'confirmed by Nick', 'confirmed')`, LEAGUE);
let txn = 0;
function tx(type, execution, status, team, at, items = []) {
  txn++;
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at,
         processed_at, team_id, scoring_period, items_json, first_seen_at, last_seen_at)
       VALUES (?, 2026, ?, ?, ?, ?, ?, ?, ?, 1, ?, '2026-09-17', '2026-09-17')`,
  LEAGUE, `t${txn}`, type, status, execution, iso(at), iso(at), team, JSON.stringify(items));
}
tx('FREEAGENT', 'EXECUTE', 'EXECUTED', 3, COVERAGE_START, [{ type: 'ADD', playerId: 900, toTeamId: 3 }]);
for (const t of trades) tx('TRADE_PROPOSAL', 'EXECUTE', 'PENDING', t.team, t.at, []);
tx('FREEAGENT', 'EXECUTE', 'EXECUTED', 2, DROP_A_AT, [{ type: 'DROP', playerId: 502, fromTeamId: 2 }]);
for (const [espn, name] of [[502, 'Player A'], [503, 'Player B']]) {
  run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id,
         player_name, lineup_slot_id, is_starter, on_roster, source, first_seen_at, changed_at)
       VALUES (?, 2026, 1, 2, ?, ?, 0, 1, 1, 'final', '2026-09-18', '2026-09-18')`, LEAGUE, espn, name);
}

const withChat = fn => { const c = openChatDb(); try { return fn(c); } finally { c.close(); } };

test('open_to_trade units obey the leak rule and grade against the next 14 days', () => {
  const built = withChat(c => grader.buildUnits(LEAGUE, { chat: c, asOf: AS_OF }));
  const units = built.units.open_to_trade;
  assert.equal(built.coverage.start, iso(COVERAGE_START));
  assert.ok(units.length >= grader.MIN_N, `${units.length} units`);
  for (const u of units) {
    assert.ok(u.t + 14 * DAY <= AS_OF, 'window closed before as_of');
    assert.ok(u.t >= COVERAGE_START, 'inside coverage');
    const k = Math.round((u.t - COVERAGE_START) / (7 * DAY));
    const team = Number(u.roster_id);
    // the claim is the week before the cutoff, nothing after it: the loud
    // message an hour after cutoff LEAK_K is cutoff LEAK_K + 1's, not LEAK_K's
    const want = team === 1 && k === LEAK_K + 1 ? 0.99 : claims.get(`${team}|${k}`);
    assert.equal(u.claim, want, `claim ${team}|${k}`);
    const y = trades.some(x => x.team === team && x.at > u.t && x.at <= u.t + 14 * DAY) ? 1 : 0;
    assert.equal(u.y, y, `outcome ${team}|${k}`);
    assert.ok(u.inc > 0 && u.inc < 1);
  }
  assert.ok(units.some(u => u.roster_id === '1' && Math.round((u.t - COVERAGE_START) / (7 * DAY)) === LEAK_K));
  assert.ok(!units.some(u => u.roster_id === '5'), 'ME (roster 5) is never graded');
});

test('untouchable units need ownership at the message and a closed window', () => {
  const built = withChat(c => grader.buildUnits(LEAGUE, { chat: c, asOf: AS_OF }));
  const units = built.units['own_roster.untouchable'];
  assert.deepEqual(units.map(u => [u.player, u.y]).sort(), [['Player A', 0], ['Player B', 1]]);
  assert.equal(units.find(u => u.player === 'Player A').msg_id, DECL_BROKEN);
  for (const u of units) assert.ok(u.inc > 0 && u.inc < 1);
});

test('the grade: open_to_trade measured, untouchable a typed thin unknown', () => {
  const g = withChat(c => grader.gradeJevChatSignals(LEAGUE, { chat: c, asOf: AS_OF }));
  assert.equal(g.status, 'measured');
  const q = g.questions.open_to_trade;
  assert.equal(q.status, 'measured');
  assert.ok(q.weight >= 0 && q.weight <= 1);
  assert.ok(['jev', 'incumbent', 'undecided'].includes(q.leader));
  const u = g.questions['own_roster.untouchable'];
  assert.deepEqual({ status: u.status, reason: u.reason, n: u.n }, { status: 'unknown', reason: 'thin', n: 2 });
  assert.equal(u.weight, undefined);
  // no chat name leaves the grade: it is aggregates only
  const text = JSON.stringify(g);
  for (const n of NAMES) assert.ok(!text.includes(n), `${n} in the grade`);
});

test('every absence is typed', () => {
  assert.deepEqual(grader.gradeJevChatSignals(LEAGUE, { chat: null, asOf: AS_OF }).reason, 'no_chat_corpus');
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, roster_positions)
       VALUES (22, 'espn', 'espn-jev-22', 2026, 'L22', ?, 4, '1', '[]')`, JSON.stringify(payload));
  const g22 = withChat(c => grader.gradeJevChatSignals(22, { chat: c, asOf: AS_OF }));
  assert.equal(g22.status, 'unknown');
  assert.equal(g22.reason, 'no_trusted_identity');
  run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name, chat_name,
         match_method, confidence) VALUES (22, '1', '{M1}', 'x', 'Team 1', 'Alpha One', 'confirmed by Nick', 'confirmed')`);
  assert.equal(withChat(c => grader.gradeJevChatSignals(22, { chat: c, asOf: AS_OF })).reason, 'no_transactions');
});

const blendRows = () => rows(`SELECT roster_id, metric, value, n, source FROM manager_signals
                              WHERE league_id = ? AND source = 'jev_blend' ORDER BY roster_id, metric`, LEAGUE);

test('flag off: manager_signals gets no jev_blend rows', () => {
  delete process.env.GRIDIRON_JEV_CHAT_BLEND;
  const res = withChat(c => signals.buildManagerSignals(LEAGUE, { chat: c, asOf: AS_OF }));
  assert.equal(res.error, undefined);
  assert.deepEqual(blendRows(), []);
  assert.equal(res.jev_blend, undefined);
});

test('flag on: one blended row per chat manager, shadow only', () => {
  process.env.GRIDIRON_JEV_CHAT_BLEND = '1';
  try {
    const res = withChat(c => signals.buildManagerSignals(LEAGUE, { chat: c, asOf: AS_OF }));
    const got = blendRows();
    assert.deepEqual(got.map(x => [x.roster_id, x.metric]),
      ['1', '2', '3', '4'].map(id => [id, 'jev_p_trade_14d']));
    for (const x of got) assert.ok(x.value > 0 && x.value < 1 && x.n >= grader.MIN_N);
    assert.equal(res.jev_blend.open_to_trade, 'measured');
    assert.equal(res.jev_blend['own_roster.untouchable'], 'unknown:thin');
    assert.equal(signals.SIGNAL_SOURCES.jev_blend.priceable, false);
    const m = signals.managerSignalsFor(LEAGUE).get('1');
    assert.equal(m.metrics.jev_p_trade_14d, undefined, 'never on the pricing path');
    assert.ok(m.context.jev_p_trade_14d > 0);
  } finally { delete process.env.GRIDIRON_JEV_CHAT_BLEND; }
  // and off again removes them on the next build
  withChat(c => signals.buildManagerSignals(LEAGUE, { chat: c, asOf: AS_OF }));
  assert.deepEqual(blendRows(), []);
});

/* ------------------------------------------------ FIX-289-1: preview-mode routing */

test('GRIDIRON_JEV_CHAT_BLEND is read through preview-mode: off, on, and preview-only', () => {
  delete process.env.GRIDIRON_JEV_CHAT_BLEND;
  delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  const off = grader.jevChatBlendFields();
  assert.equal(off.enabled, false);
  assert.match(off.reason, /GRIDIRON_JEV_CHAT_BLEND=1/);
  assert.equal(grader.jevChatBlendEnabled(), false);
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    const pv = grader.jevChatBlendFields();
    assert.deepEqual([pv.enabled, pv.preview], [true, true]);
    assert.equal(pv.preview_reason, grader.JEV_CHAT_BLEND_OFF_REASON);
    const res = withChat(c => signals.buildManagerSignals(LEAGUE, { chat: c, asOf: AS_OF }));
    assert.equal(res.jev_blend.preview, true, 'the build summary says the rows are a preview');
    assert.equal(res.jev_blend.preview_reason, grader.JEV_CHAT_BLEND_OFF_REASON);
    assert.equal(res.jev_blend.open_to_trade, 'measured');
    assert.equal(blendRows().length, 4, 'preview mode writes the rows');
    process.env.GRIDIRON_JEV_CHAT_BLEND = '1';
    assert.deepEqual(grader.jevChatBlendFields(), { enabled: true }, 'the site flag wins over preview');
    const on = withChat(c => signals.buildManagerSignals(LEAGUE, { chat: c, asOf: AS_OF }));
    assert.equal(on.jev_blend.preview, undefined);
  } finally {
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    delete process.env.GRIDIRON_JEV_CHAT_BLEND;
  }
  withChat(c => signals.buildManagerSignals(LEAGUE, { chat: c, asOf: AS_OF }));
  assert.deepEqual(blendRows(), []);
  const pm = fs.readFileSync(new URL('../server/services/preview-mode.js', import.meta.url), 'utf8');
  assert.match(pm, /jev\/chat-grader\.js#jevChatBlendFields/, 'preview-mode.js lists the site');
  assert.match(pm, /GRIDIRON_JEV_CHAT_BLEND/);
});

/* ------------------------------------------------ FIX-289-2: identityMap in the report */

test('the grade report reads identities through identityMap, never the table', () => {
  const src = fs.readFileSync(new URL('../scripts/jev-grade-report.mjs', import.meta.url), 'utf8');
  assert.ok(!/league_member_identity/.test(src), 'no direct league_member_identity read in the report');
  assert.match(src, /identityMap/);
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = spawnSync(process.execPath, ['scripts/jev-grade-report.mjs', '--as-of', iso(AS_OF)], { cwd: root,
    env: { ...process.env, GRIDIRON_DB_PATH: process.env.GRIDIRON_DB_PATH, GRIDIRON_CHAT_DB_PATH: CHAT_PATH }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const l21 = out.leagues.find(l => l.league_id === LEAGUE);
  assert.ok(l21, 'league 21 (trusted identities) is graded');
  assert.equal(l21.questions.open_to_trade.status, 'measured');
  for (const n of NAMES) assert.ok(!r.stdout.includes(n), `${n} in the report`);
  // FIX-289-4: the report also prints the engine grade (read-only); no jev.* answers exist here.
  assert.equal(out.engine.questions.p_accept.units, 0);
  assert.equal(out.engine.questions.plays_sunday.blend.reason, 'thin');
});

/* ------------------------------------------------ FIX-289-3: the league's roster size */

test("roster size is the league's slots (starters + bench, IR out), never a constant 16", () => {
  assert.equal(grader.ROSTER_SIZE, undefined, 'the hard-coded 16 is gone');
  assert.deepEqual(grader.rosterSize(payload), { size: 15 });
  assert.deepEqual(grader.rosterSize({ settings: {} }), { status: 'unknown', reason: 'no_roster_size' });
  assert.deepEqual(grader.rosterSize({ settings: { rosterSettings: { lineupSlotCounts: { 21: 2 } } } }),
    { status: 'unknown', reason: 'no_roster_size' });
  // The held-player incumbent on the 15-slot fixture: Player A's declaration (08-01) has no
  // move-off before it, so P = exp(-14 * league * 28 / (days + 28)), league = 0.5 / (R * (teams * days + 14)).
  const built = withChat(c => grader.buildUnits(LEAGUE, { chat: c, asOf: AS_OF }));
  const a = built.units['own_roster.untouchable'].find(u => u.player === 'Player A');
  const days = (a.t - COVERAGE_START) / DAY;
  const inc = R => Math.exp(-14 * (0.5 / (R * (5 * days + 14))) * 28 / (days + 28));
  assert.ok(Math.abs(a.inc - inc(15)) < 1e-12, `inc ${a.inc} vs 15-slot ${inc(15)}`);
  assert.ok(Math.abs(a.inc - inc(16)) > 1e-9, 'not the 16-slot value');
});

test('a league with no roster slots grades untouchable as a typed unknown, not at 16', () => {
  const noSlots = { ...payload, settings: {} };
  run('UPDATE leagues SET payload = ? WHERE id = ?', JSON.stringify(noSlots), LEAGUE);
  try {
    const g = withChat(c => grader.gradeJevChatSignals(LEAGUE, { chat: c, asOf: AS_OF }));
    assert.deepEqual(g.questions['own_roster.untouchable'], { status: 'unknown', reason: 'no_roster_size' });
    assert.equal(g.questions.open_to_trade.status, 'measured', 'open_to_trade does not need roster size');
    process.env.GRIDIRON_JEV_CHAT_BLEND = '1';
    const res = withChat(c => signals.buildManagerSignals(LEAGUE, { chat: c, asOf: AS_OF }));
    assert.equal(res.jev_blend['own_roster.untouchable'], 'unknown:no_roster_size');
  } finally {
    delete process.env.GRIDIRON_JEV_CHAT_BLEND;
    run('UPDATE leagues SET payload = ? WHERE id = ?', JSON.stringify(payload), LEAGUE);
  }
});
