import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Same isolated-DB pattern as test/phone-pairing.test.js.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-draft-ingest-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { parseFrame, decodeInit, decodeInitLedger, encodeInitLedger } = await import('../server/services/draft-frames.js');
const { espnCors, ESPN_ORIGINS } = await import('../server/platform/cors.js');
const { syncLiveDraft } = await import('../server/services/espn-draft.js');
const { default: draftsRouter, _resetIngestLimiter } = await import('../server/routes/drafts.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/drafts', draftsRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/drafts`;

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ setup */

run(`INSERT INTO leagues (platform, league_id, season, name) VALUES ('espn', '424242', 2026, 'Ingest League')`);
const leagueRowId = row(`SELECT id FROM leagues WHERE league_id = '424242'`).id;

function user(subject, role, token) {
  run('INSERT INTO users (subject, display_name) VALUES (?,?)', subject, subject);
  const userId = row('SELECT id FROM users WHERE subject = ?', subject).id;
  run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', leagueRowId, userId, role);
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now', '+1 day'))`, userId, hashSessionToken(token));
  return { userId, token };
}
const commissioner = user('ingest:commissioner', 'commissioner', 'commish-secret');
const member = user('ingest:member', 'member', 'member-secret');

const PICK_ORDER = [10, 20, 30, 40]; // ESPN team ids -> slots 1..4
const TEAM_COUNT = 4, ROUNDS = 3;
let draftCounter = 0;
function makeDraft() {
  draftCounter += 1;
  run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, status, league_row_id, espn_league_id, season, pick_order)
       VALUES (?, 'live', ?, ?, 2, 'active', ?, '424242', 2026, ?)`,
    `ingest draft ${draftCounter}`, TEAM_COUNT, ROUNDS, leagueRowId, JSON.stringify({ order: PICK_ORDER, team_names: {} }));
  return row('SELECT last_insert_rowid() AS id').id;
}

let playerCounter = 0;
function knownPlayer(espnId) {
  playerCounter += 1;
  run(`INSERT INTO players (name, position, fantasy_relevant, espn_id) VALUES (?, 'WR', 1, ?)`, `Ingest Player ${playerCounter}`, espnId);
  return row('SELECT last_insert_rowid() AS id').id;
}
const players = new Map(); // espnId -> local id
for (const id of [101, 102, 103, 104, 105, 106, 107, 108]) players.set(id, knownPlayer(id));
players.set(-16016, knownPlayer(-16016)); // a D/ST with a negative ESPN id

// node:sqlite rows are null-prototype objects; deepEqual against literals needs plain ones.
const plain = v => JSON.parse(JSON.stringify(v));
const json = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const auth = token => ({ Authorization: `Bearer ${token}` });
const ESPN = { Origin: 'https://fantasy.espn.com' };

async function mintKey(draftId) {
  const res = await fetch(`${base}/${draftId}/ingest-key`, json({}, auth(commissioner.token)));
  assert.equal(res.status, 200);
  return (await res.json()).key;
}

let seq = 0;
const frame = (data, dir = 'in') => ({ seq: ++seq, ts: Date.now(), dir, url: 'wss://fantasydraft.espn.com/x', data });
const capture = (draftId, key, captureId, frames, extra = {}) =>
  fetch(`${base}/${draftId}/capture`, json({ ingest_key: key, capture_id: captureId, frames, baseline: null, heartbeat: false, ...extra }, ESPN));

/* ---------------------------------------------------------- frame parsing */

test('parseFrame handles every documented frame type', () => {
  assert.deepEqual(parseFrame('SELECTED 10 101 4 {ABC-123}'), { type: 'SELECTED', teamId: 10, playerId: 101, slotId: 4, swid: '{ABC-123}' });
  assert.deepEqual(parseFrame('SELECTED 20 -16016 16'), { type: 'SELECTED', teamId: 20, playerId: -16016, slotId: 16, swid: null });
  assert.deepEqual(parseFrame('SELECTED 30 -1 0'), { type: 'SELECTED', teamId: 30, playerId: -1, slotId: 0, swid: null });
  assert.deepEqual(parseFrame('SELECTING 20 90000'), { type: 'SELECTING', teamId: 20, ms: 90000 });
  assert.deepEqual(parseFrame('CLOCK DRAFTING 45000 20'), { type: 'CLOCK', phase: 'DRAFTING', msRemaining: 45000, teamId: 20 });
  assert.deepEqual(parseFrame('CLOCK PRE 5000'), { type: 'CLOCK', phase: 'PRE', msRemaining: 5000, teamId: null });
  assert.deepEqual(parseFrame('AUTODRAFT 40 true'), { type: 'AUTODRAFT', teamId: 40, enabled: true });
  assert.deepEqual(parseFrame('AUTODRAFT 40 0'), { type: 'AUTODRAFT', teamId: 40, enabled: false });
  assert.deepEqual(parseFrame('UNDONE 7'), { type: 'UNDONE', pickNumber: 7 });
  assert.deepEqual(parseFrame('JOINED {SWID-1}'), { type: 'JOINED', member: '{SWID-1}' });
  assert.deepEqual(parseFrame('LEFT {SWID-1}'), { type: 'LEFT', member: '{SWID-1}' });
  assert.deepEqual(parseFrame('TOKEN eyJhbGci.secret.stuff'), { type: 'TOKEN', redacted: true });
  assert.deepEqual(parseFrame('STATE 3'), { type: 'STATE', state: 3 });
  assert.deepEqual(parseFrame('PING'), { type: 'PING' });
  assert.deepEqual(parseFrame('PONG'), { type: 'PONG' });
  assert.deepEqual(parseFrame('SELECT 101'), { type: 'SELECT', playerId: 101 });
  assert.deepEqual(parseFrame('INIT AAAA'), { type: 'INIT', data: 'AAAA' });
});

test('parseFrame never throws on junk and marks it UNKNOWN', () => {
  for (const junk of ['', '   ', 'WHATEVER 1 2', 'SELECTED x y z', 'UNDONE -3', 'UNDONE', 'SELECT abc', 'INIT !!!', null, undefined, 42, { a: 1 }]) {
    const out = parseFrame(junk);
    assert.equal(out.type, 'UNKNOWN', `junk ${JSON.stringify(junk)}`);
  }
  assert.equal(parseFrame('WHATEVER 1 2').raw, 'WHATEVER 1 2');
});

/* ------------------------------------------------------------ INIT decode */

function grid(filled) {
  // Full 4x3 snake grid; `filled` maps pickNumber -> playerId for made picks.
  const out = [];
  for (let n = 1; n <= TEAM_COUNT * ROUNDS; n++) {
    const round = Math.ceil(n / TEAM_COUNT), inRound = ((n - 1) % TEAM_COUNT) + 1;
    const slot = round % 2 === 1 ? inRound : TEAM_COUNT - inRound + 1;
    out.push({ teamId: PICK_ORDER[slot - 1], pickNumber: n, playerId: filled[n] ?? -1 });
  }
  return out;
}

test('decodeInit round-trips a synthetic 45-byte-stride ledger', () => {
  const records = grid({ 1: 101, 2: 102, 3: -16016 });
  const b64 = encodeInitLedger(424242, records);
  const ledger = decodeInitLedger(b64, { teamCount: TEAM_COUNT, rounds: ROUNDS });
  assert.equal(ledger.error, null);
  assert.equal(ledger.stride, 45);
  assert.equal(ledger.offset, 0);
  assert.equal(ledger.leagueId, 424242);
  assert.deepEqual(ledger.picks, records);
  assert.deepEqual(decodeInit(b64, { teamCount: TEAM_COUNT, rounds: ROUNDS }), records);
});

test('decodeInit copes with a header, an alternate stride, and stops at inconsistent records', () => {
  const records = grid({ 1: 101 });
  // 48-byte records behind a 7-byte header.
  const withHeader = Buffer.concat([Buffer.from('hdr-xyz'), Buffer.from(encodeInitLedger(424242, records, { stride: 48 }), 'base64')]).toString('base64');
  const ledger = decodeInitLedger(withHeader, { teamCount: TEAM_COUNT, rounds: ROUNDS });
  assert.equal(ledger.error, null);
  assert.equal(ledger.stride, 48);
  assert.equal(ledger.offset, 7);
  assert.deepEqual(ledger.picks, records);

  // A league id that changes mid-ledger truncates at the last consistent record.
  const mixed = [...records];
  const buf = Buffer.from(encodeInitLedger(424242, mixed), 'base64');
  buf.writeInt32BE(999, 5 * 45); // corrupt record 6's league id
  const truncated = decodeInitLedger(buf.toString('base64'), { teamCount: TEAM_COUNT, rounds: ROUNDS });
  assert.equal(truncated.picks.length, 5);
});

test('decodeInit returns [] with an error on garbage and never throws', () => {
  for (const garbage of ['', 'AAAA', Buffer.from('not a ledger at all, just some prose that is long enough to scan').toString('base64'), '###', null]) {
    const ledger = decodeInitLedger(garbage, { teamCount: TEAM_COUNT, rounds: ROUNDS });
    assert.deepEqual(ledger.picks, []);
    assert.ok(ledger.error, `expected an error for ${JSON.stringify(garbage)}`);
  }
  const random = Buffer.alloc(45 * 12);
  for (let i = 0; i < random.length; i++) random[i] = (i * 7919 + 13) & 0xff;
  assert.deepEqual(decodeInit(random.toString('base64'), { teamCount: TEAM_COUNT, rounds: ROUNDS }), []);
});

/* ------------------------------------------------------------------- CORS */

test('CORS preflight succeeds for ESPN origins and is denied for others', async () => {
  const draftId = makeDraft();
  for (const origin of ESPN_ORIGINS) {
    const res = await fetch(`${base}/${draftId}/capture`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
    });
    assert.equal(res.status, 204, origin);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
    assert.equal(res.headers.get('access-control-allow-headers'), 'content-type');
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(res.headers.get('access-control-max-age'), '600');
    assert.match(res.headers.get('vary') ?? '', /Origin/);
  }
  const denied = await fetch(`${base}/${draftId}/capture`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(denied.status, 204);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal(denied.headers.get('access-control-allow-private-network'), null);

  // The middleware alone, on a POST from an unknown origin: passes through with no allow headers.
  const set = {};
  let nexted = false;
  espnCors({ get: h => (h === 'origin' ? 'https://evil.example' : undefined), method: 'POST' }, { set: (k, v) => { set[k] = v; } }, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(set['Access-Control-Allow-Origin'], undefined);
  assert.equal(set.Vary, 'Origin');
});

/* ------------------------------------------------------------------- keys */

test('ingest-key mint: 401 anon, 403 non-commissioner, 200 commissioner; wrong/expired keys are 401', async () => {
  const draftId = makeDraft();
  assert.equal((await fetch(`${base}/${draftId}/ingest-key`, json({}))).status, 401);
  assert.equal((await fetch(`${base}/${draftId}/ingest-key`, json({}, auth(member.token)))).status, 403);
  const res = await fetch(`${base}/${draftId}/ingest-key`, json({}, auth(commissioner.token)));
  assert.equal(res.status, 200);
  const { key, expires_at } = await res.json();
  assert.match(key, /^gik_[A-Za-z0-9_-]{32}$/);
  assert.ok(Date.parse(expires_at) > Date.now() + 11 * 3600_000, 'no draft_at → now + 12h');
  const stored = row('SELECT ingest_key_hash FROM drafts WHERE id = ?', draftId).ingest_key_hash;
  assert.equal(stored, hashSessionToken(key), 'only the hash is persisted');

  assert.equal((await capture(draftId, 'gik_wrong', 'cap-1', [])).status, 401);
  assert.equal((await capture(draftId, undefined, 'cap-1', [])).status, 401);
  assert.equal((await capture(draftId, key, 'cap-1', [])).status, 200);

  run(`UPDATE drafts SET ingest_key_expires_at = ? WHERE id = ?`, new Date(Date.now() - 60_000).toISOString(), draftId);
  assert.equal((await capture(draftId, key, 'cap-1', [])).status, 401);

  // Re-minting replaces the key; the old one stops working.
  const fresh = await mintKey(draftId);
  assert.equal((await capture(draftId, key, 'cap-1', [])).status, 401);
  assert.equal((await capture(draftId, fresh, 'cap-1', [])).status, 200);
});

test('a scheduled draft gets a key that expires 8h after draft_at', async () => {
  const draftId = makeDraft();
  const draftAt = new Date(Date.now() + 2 * 3600_000).toISOString();
  run('UPDATE drafts SET draft_at = ? WHERE id = ?', draftAt, draftId);
  const { expires_at } = await (await fetch(`${base}/${draftId}/ingest-key`, json({}, auth(commissioner.token)))).json();
  assert.equal(Date.parse(expires_at), Date.parse(draftAt) + 8 * 3600_000);
});

test('repeated bad keys from one source are rate limited', async () => {
  _resetIngestLimiter();
  const draftId = makeDraft();
  let last;
  for (let i = 0; i < 11; i++) last = await capture(draftId, 'gik_nope', 'cap-rl', []);
  assert.equal(last.status, 429);
  _resetIngestLimiter();
});

/* ---------------------------------------------------------------- ingest */

test('a batch of SELECTED frames from baseline 0 creates picks with derived numbers and slots', async () => {
  const draftId = makeDraft();
  const key = await mintKey(draftId);
  const frames = [
    frame('TOKEN abc.def.ghi'),
    frame('STATE 2'),
    frame('SELECTING 10 90000'),
    frame('SELECT 101', 'out'),
    frame('SELECTED 10 101 4 {SWID-A}'),
    frame('CLOCK DRAFTING 90000 20'),
    frame('SELECTED 20 102 2'),
    frame('PING'),
    frame('SELECTED 30 -16016 16'),
    frame('SELECTED 40 -1 0'), // an empty sentinel — not a pick
    frame('JUNK frame here')
  ];
  const res = await capture(draftId, key, 'cap-a', frames, { baseline: { picks_on_board: 0 } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, 'espn-page');
  assert.equal(body.accepted, frames.length);
  assert.equal(body.duplicates, 0);
  assert.deepEqual(body.parse_errors, []);
  assert.deepEqual(body.new_picks, [1, 2, 3]);
  assert.equal(body.picks_on_espn, 3);
  assert.equal(body.picks_mirrored, 3);
  assert.equal(body.desynced, false);
  assert.equal(body.next_pick, 4);
  assert.equal(body.on_the_clock_slot, 4);
  assert.equal(body.my_slot, 2);
  assert.equal(body.my_turn, false);

  const picks = plain(rows('SELECT pick_number, team_slot, player_id, espn_team_id, source FROM draft_picks WHERE draft_id = ? ORDER BY pick_number', draftId));
  assert.deepEqual(picks, [
    { pick_number: 1, team_slot: 1, player_id: players.get(101), espn_team_id: 10, source: 'espn-page' },
    { pick_number: 2, team_slot: 2, player_id: players.get(102), espn_team_id: 20, source: 'espn-page' },
    { pick_number: 3, team_slot: 3, player_id: players.get(-16016), espn_team_id: 30, source: 'espn-page' }
  ]);
  // The session token never lands in the event store.
  const tokenEvent = row(`SELECT payload_json FROM draft_capture_events WHERE capture_id = 'cap-a' AND type = 'TOKEN'`);
  assert.ok(!tokenEvent.payload_json.includes('abc.def'));

  // Re-posting the same batch: all duplicates, no new rows.
  const again = await (await capture(draftId, key, 'cap-a', frames)).json();
  assert.equal(again.accepted, 0);
  assert.equal(again.duplicates, frames.length);
  assert.deepEqual(again.new_picks, []);
  assert.equal(rows('SELECT 1 FROM draft_picks WHERE draft_id = ?', draftId).length, 3);

  // A heartbeat keeps the capture alive and reports the board.
  const hb = await (await capture(draftId, key, 'cap-a', [], { heartbeat: true })).json();
  assert.equal(hb.heartbeat, true);
  assert.equal(hb.picks_mirrored, 3);
  assert.equal(hb.next_pick, 4);

  const status = await (await fetch(`${base}/${draftId}/ingest-status`, { headers: auth(member.token) })).json();
  assert.equal(status.active, true);
  assert.equal(status.capture_id, 'cap-a');
  assert.equal(status.frames_seen, frames.length);
  assert.equal(status.picks_from_capture, 3);
  assert.ok(status.last_seen_at);
  assert.equal((await fetch(`${base}/${draftId}/ingest-status`)).status, 401);
});

test('an unknown ESPN player id is quarantined, never invented, and does not shift later picks', async () => {
  const draftId = makeDraft();
  const key = await mintKey(draftId);
  const before = row('SELECT COUNT(*) AS n FROM players').n;
  const body = await (await capture(draftId, key, 'cap-q', [frame('SELECTED 10 101 4'), frame('SELECTED 20 777777 2'), frame('SELECTED 30 103 4')])).json();
  assert.deepEqual(body.new_picks, [1, 3]);
  assert.equal(body.failures.length, 1);
  assert.equal(body.failures[0].pick, 2);
  assert.equal(body.desynced, true);
  assert.equal(body.next_pick, 4, 'next pick follows the captured count, not the mirrored count');
  assert.equal(row('SELECT COUNT(*) AS n FROM players').n, before, 'no player row fabricated');
});

test('UNDONE removes the pick and the next SELECTED reuses its number', async () => {
  const draftId = makeDraft();
  const key = await mintKey(draftId);
  await capture(draftId, key, 'cap-u', [frame('SELECTED 10 101 4'), frame('SELECTED 20 102 2')]);
  const undone = await (await capture(draftId, key, 'cap-u', [frame('UNDONE 2')])).json();
  assert.deepEqual(undone.removed_picks, [2]);
  assert.equal(undone.picks_mirrored, 1);
  assert.equal(undone.next_pick, 2);
  assert.equal(rows('SELECT 1 FROM draft_picks WHERE draft_id = ?', draftId).length, 1);
  assert.equal(row(`SELECT COUNT(*) AS n FROM draft_pick_corrections WHERE draft_id = ? AND reason = 'removed-stale'`, draftId).n, 1);

  const redo = await (await capture(draftId, key, 'cap-u', [frame('SELECTED 20 103 2')])).json();
  assert.deepEqual(redo.new_picks, [2]);
  assert.equal(row('SELECT player_id FROM draft_picks WHERE draft_id = ? AND pick_number = 2', draftId).player_id, players.get(103));
});

test('an INIT ledger overrides sequential reconstruction', async () => {
  const draftId = makeDraft();
  const key = await mintKey(draftId);
  // Sequential picks first, in the wrong order relative to what the snapshot will say.
  await capture(draftId, key, 'cap-i', [frame('SELECTED 10 104 4'), frame('SELECTED 20 105 2')]);
  assert.equal(row('SELECT player_id FROM draft_picks WHERE draft_id = ? AND pick_number = 1', draftId).player_id, players.get(104));

  const init = encodeInitLedger(424242, grid({ 1: 101, 2: 102, 3: 103 }));
  const body = await (await capture(draftId, key, 'cap-i', [frame(`INIT ${init}`), frame('SELECTED 40 104 4')])).json();
  assert.deepEqual(body.parse_errors, []);
  assert.equal(body.picks_on_espn, 4);
  // Picks 1 and 2 change player; 3 and 4 (104 displaced from pick 1) are fresh inserts.
  assert.deepEqual(body.corrected_picks.sort(), [1, 2]);
  assert.deepEqual(body.new_picks, [3, 4]);
  const picks = plain(rows('SELECT pick_number, team_slot, player_id FROM draft_picks WHERE draft_id = ? ORDER BY pick_number', draftId));
  assert.deepEqual(picks, [
    { pick_number: 1, team_slot: 1, player_id: players.get(101) },
    { pick_number: 2, team_slot: 2, player_id: players.get(102) },
    { pick_number: 3, team_slot: 3, player_id: players.get(103) },
    { pick_number: 4, team_slot: 4, player_id: players.get(104) }
  ]);
  assert.equal(body.next_pick, 5);
  assert.equal(body.on_the_clock_slot, 4, 'round 2 snakes back');
});

test('a new tab with a baseline continues from the existing board without an INIT', async () => {
  const draftId = makeDraft();
  const key = await mintKey(draftId);
  await capture(draftId, key, 'cap-first-tab', [frame('SELECTED 10 101 4'), frame('SELECTED 20 102 2')]);
  const body = await (await capture(draftId, key, 'cap-second-tab', [frame('SELECTED 30 103 4')], { baseline: { picks_on_board: 2 } })).json();
  assert.deepEqual(body.new_picks, [3]);
  assert.deepEqual(body.removed_picks, []);
  assert.equal(body.picks_mirrored, 3);
});

test('a stale tab that trails the board is ignored rather than deleting picks', async () => {
  const draftId = makeDraft();
  const key = await mintKey(draftId);
  await capture(draftId, key, 'cap-live', [frame('SELECTED 10 101 4'), frame('SELECTED 20 102 2'), frame('SELECTED 30 103 4')]);
  const body = await (await capture(draftId, key, 'cap-stale', [frame('SELECTED 10 101 4')], { baseline: { picks_on_board: 0 } })).json();
  assert.equal(body.desynced, true);
  assert.ok(body.parse_errors.some(e => /trails/.test(e.error)));
  assert.equal(rows('SELECT 1 FROM draft_picks WHERE draft_id = ?', draftId).length, 3);
});

test('malformed batches are rejected with 400', async () => {
  const draftId = makeDraft();
  const key = await mintKey(draftId);
  assert.equal((await capture(draftId, key, '', [])).status, 400);
  assert.equal((await capture(draftId, key, 'cap-big', Array.from({ length: 201 }, () => frame('PING')))).status, 400);
  const res = await capture(draftId, key, 'cap-shape', [{ seq: 'x', dir: 'in', data: 'PING' }, { seq: 5, dir: 'sideways', data: 'PING' }, frame('PONG')]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.accepted, 1);
  assert.equal(body.parse_errors.length, 2);
});

/* ------------------------------------------------------- source of truth */

test('after a capture, POST /:id/sync is paused and never calls ESPN', async () => {
  const draftId = makeDraft();
  const key = await mintKey(draftId);
  await capture(draftId, key, 'cap-sot', [frame('SELECTED 10 101 4')]);

  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(base)) return realFetch(url, opts);
    throw new Error(`unexpected network call to ${url}`);
  };
  try {
    const res = await fetch(`${base}/${draftId}/sync`, json({}, auth(commissioner.token)));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'espn-page');
    assert.equal(body.paused, true);
    assert.equal(body.ok, true);
    assert.equal(body.picks_mirrored, 1);
    assert.equal(body.picks_on_espn, 1);
    assert.equal(body.next_pick, 2);
    assert.equal(body.on_the_clock_slot, 2);
    assert.equal(body.my_turn, true);

    // Once the capture goes quiet the poller resumes (and here, hits our throwing fetch).
    run('UPDATE drafts SET ingest_last_seen_at = ? WHERE id = ?', new Date(Date.now() - 60_000).toISOString(), draftId);
    await assert.rejects(syncLiveDraft(draftId), /unexpected network call/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
