/**
 * Telling the rebuild who is who, so an uploaded corpus attaches to a league.
 *
 * Which league owns the chat corpus is derived, not configured: refreshManagerData
 * reads the distinct league_id from league_member_identity where confidence is
 * 'confirmed' and chat_name is not null. Those rows are only ever written by
 * matchIdentities, which only runs inside refreshManagerData — and on the
 * deployed machine that had never run. So the corpus could be uploaded, the
 * rebuild could report success, every league would be treated as chat-free, and
 * nothing downstream would use a single message. The upload would look like it
 * worked and change nothing.
 *
 * `confirmations` is the way in. A league named there is treated as a chat
 * league for that run, and matchIdentities stores its rows as 'confirmed', so
 * the derivation finds it by itself from then on. It only has to be said once.
 *
 * The private chat DB is never read: GRIDIRON_CHAT_DB_PATH points at a fixture
 * built here, with made-up names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-identity-seed-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;
process.env.SCHEDULER_DISABLED = '1';

const chat = new DatabaseSync(CHAT_PATH);
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
// The name this person posts under is nothing like their ESPN name, which is
// exactly why a name match cannot find them and a human has to say so once.
prof.run('MoonUnit', 420, 300, 22, 0.2, 0.31, 0.2, 0.3, 2.4, 0.35, 0.45, 0.1, 0.33, 0.06, 0.07, 0.03,
  '2026-01-01', '2026-09-17');
prof.run('ME', 800, 500, 40, 0.2, 0.28, 0.2, 0.3, 2.5, 0.30, 0.50, 0.1, 0.30, 0.05, 0.05, 0.02,
  '2026-01-01', '2026-09-17');
chat.prepare(`INSERT INTO manager_player_sentiment VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
  .run('MoonUnit', 'Player A', 7, 3.3, 0.85, 0.0, '2026-08-01', '2026-09-17');
chat.close();

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
await import('../server/services/manager-archetypes.js');
const { refreshManagerData } = await import('../server/services/manager-signals.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');

await runMigrations();
seedIfEmpty();

run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (8801, 'seed-admin', 'Admin')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (8801, ?, datetime('now','+1 day'))`, hashSessionToken('admin-token'));
run(`INSERT OR IGNORE INTO model_permissions(user_id, permission) VALUES (8801, 'model:*')`);

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const call = async (method, url, { token = 'admin-token', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const NICK = '{NICK-SEED}';
const MOON = '{MOON-SEED}';
const member = (id, first, last) => ({ id, firstName: first, lastName: last, displayName: `${first}${last}` });
const rosterEntry = (id, name) => ({
  lineupSlotId: 0, acquisitionType: 'DRAFT',
  playerPoolEntry: { player: { id, fullName: name, injuryStatus: 'ACTIVE', defaultPositionId: 3 } },
});
const team = (id, owner, entries) => ({
  id, name: `Team ${id}`, owners: [owner], currentProjectedRank: id, draftDayProjectedRank: id,
  record: { overall: { wins: 1, losses: 0, ties: 0, pointsFor: 110, pointsAgainst: 90,
    streakType: 'WIN', streakLength: 1 } },
  roster: { entries },
});
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, espn_s2, swid, connection_status)
     VALUES (31, 'espn', 'espn-seed-31', 2026, 'Transfer portal ', ?, 2, '1', ?, 's2', 'swid', 'connected')`,
JSON.stringify({
  members: [member(NICK, 'Nick', 'Matta'), member(MOON, 'Parth', 'Bedi')],
  teams: [team(1, NICK, [rosterEntry(801, 'Player C')]), team(2, MOON, [rosterEntry(802, 'Player A')])],
  schedule: [],
}), JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));

const chatRows = () => rows(`SELECT roster_id, chat_name, confidence FROM league_member_identity
                             WHERE league_id = 31 ORDER BY roster_id`);

test('an uploaded corpus attaches to nothing until someone says who is who', () => {
  const out = refreshManagerData({ leagueIds: [31] });
  assert.equal(out.status, 'ok');
  assert.equal(out.leagues[0].chat_corpus, false,
    'no confirmed identity exists, so the league is treated as chat-free');
  assert.equal(out.leagues[0].rosters_with_chat, 0);
  assert.ok((out.leagues[0].by_source ?? {}).chat == null,
    'not one chat-derived signal was built, however large the corpus is');
  assert.ok(chatRows().every(r => r.chat_name == null),
    'the name match cannot find "MoonUnit" from "Parth Bedi", which is the whole problem');
});

test('naming one person makes the league a chat league, and the corpus lands', async () => {
  const res = await call('POST', '/api/trades/managers/rebuild', {
    body: { league_ids: [31], confirmations: { 31: { 2: 'MoonUnit' } } },
  });
  assert.equal(res.status, 200);
  const lg = res.body.leagues.find(l => l.league_id === 31);
  assert.equal(lg.error, null, lg.error ?? '');
  assert.equal(lg.chat_corpus, true);
  assert.equal(lg.rosters_with_chat, 1, 'the confirmed roster now carries chat-derived signals');
  assert.ok((lg.by_source ?? {}).chat > 0, 'chat signals were built for the first time');

  const stored = chatRows().find(r => r.roster_id === '2');
  assert.equal(stored.chat_name, 'MoonUnit');
  assert.equal(stored.confidence, 'confirmed',
    'stored as confirmed, which is what the derivation reads on every later run');
});

test('it only has to be said once — a later rebuild finds the league by itself', () => {
  const out = refreshManagerData({ leagueIds: [31] });
  assert.equal(out.leagues[0].chat_corpus, true,
    'no confirmations passed this time, and the league is still a chat league');
  assert.equal(out.leagues[0].rosters_with_chat, 1);
});

test('confirming someone before the corpus is uploaded fails that league honestly', () => {
  const saved = process.env.GRIDIRON_CHAT_DB_PATH;
  process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'not-here.sqlite');
  try {
    const out = refreshManagerData({ leagueIds: [31] });
    assert.equal(out.chat_db, 'absent');
    assert.match(out.leagues[0].error, /no chat DB/);
    assert.match(out.leagues[0].error, /upload the corpus/,
      'the message says what to do, not just what is missing');
  } finally { process.env.GRIDIRON_CHAT_DB_PATH = saved; }
});

test('a malformed confirmations block is refused, not half-applied', async () => {
  const bad = [
    [{ confirmations: [] }, /object of league id/],
    [{ confirmations: { 31: 'MoonUnit' } }, /roster_id -> chat name/],
    [{ confirmations: { 31: { 2: '' } } }, /name that person posts under/],
    [{ confirmations: { 31: { 2: 7 } } }, /name that person posts under/],
  ];
  for (const [body, message] of bad) {
    const res = await call('POST', '/api/trades/managers/rebuild', { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, message);
  }
});

test('the chat source no longer names a league number that was never guaranteed', async () => {
  const { SIGNAL_SOURCES } = await import('../server/services/manager-signals.js');
  assert.equal(SIGNAL_SOURCES.chat.label, 'League chat (private)');
  assert.doesNotMatch(SIGNAL_SOURCES.chat.label, /league \d/i,
    'which league holds the corpus is derived from the data, so a label must not assert one');
});
