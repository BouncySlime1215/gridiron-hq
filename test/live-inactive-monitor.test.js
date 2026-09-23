/**
 * RL-3-2 / SS-01: the live gameday-inactive source (Bluesky Jetstream).
 *
 * Pinned here:
 *   - the parser reads per-clause definitive statuses only, so "X is inactive, while Y
 *     is active" never flags Y, and a clause holding both words is refused;
 *   - names resolve against the player table on the FULL name (textMentionsFullName's
 *     rule), a shared name needs a team hint, and an unresolvable one is skipped;
 *   - the embed card's description is read too (Rotoworld headlines carry last names
 *     only; the card carries the full name);
 *   - the stored row carries claim fields and the at:// URI, never the post text;
 *   - a Jetstream delete retracts the claim (no row deleted), a later "active" claim
 *     supersedes an earlier "inactive" one, and re-delivery is idempotent;
 *   - the poll speaks Jetstream v2 (subscribeEvents, dids filter, cursor, kinds=commit).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-live-inactive-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const mon = await import('../server/services/live-inactive-monitor.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT OR IGNORE INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (901, 'NOX', 'New Orleans Saints', 'NFC', 'South'), (902, 'LVX', 'Las Vegas Raiders', 'AFC', 'West'),
     (903, 'DNX', 'Denver Broncos', 'AFC', 'West'), (904, 'LCX', 'Los Angeles Chargers', 'AFC', 'West')`);
const P = [
  [5001, 'Alvin Kamara', 'RB', 901], [5002, 'Brock Bowers', 'TE', 902], [5003, 'RJ Harvey', 'RB', 903],
  [5004, 'Marvin Mims Jr.', 'WR', 903], [5005, 'Mike Williams', 'WR', 904], [5006, 'Mike Williams', 'WR', 902],
  [5007, 'Jaylen Waddle', 'WR', 901], [5008, 'Tua Tagovailoa', 'QB', 901], [5009, 'Tyreek Hill', 'WR', 901]
];
for (const [id, name, pos, team] of P) run('INSERT INTO players (id, name, position, team_id) VALUES (?,?,?,?)', id, name, pos, team);

const WEEK = { season: 2026, week: 3 };
const DID = 'did:plc:lbe3b7ce6n7oa6cbl5jwoifo'; // rotoworld-fb.bsky.social, a watched account
let seq = 1;
function commit(text, { did = DID, rkey = `rk${seq}`, embed = null, op = 'create', time = '2026-09-27T15:30:00Z' } = {}) {
  const record = op === 'delete' ? undefined : {
    $type: 'app.bsky.feed.post', text, createdAt: time,
    ...(embed ? { embed: { $type: 'app.bsky.embed.external', external: { uri: 'http://dlvr.it/x', title: text, description: embed } } } : {})
  };
  return { $type: 'message', payload: { $type: 'network.bsky.jetstream.subscribeEvents#commit',
    did, seq: seq++, time, operation: op, collection: 'app.bsky.feed.post', rkey, ...(record ? { record } : {}) } };
}
const byName = claims => Object.fromEntries(claims.map(c => [c.player_name + '#' + c.player_id, c.status]));

test('clause parser: definitive statuses per clause; mixed clause refused', () => {
  const s = mon.parseStatusClauses('Actives/inactives:\n-- Raiders RB Alexander Mattison is inactive, as is Dolphins RB Raheem Mostert.\n-- Bucs RB Bucky Irving is active.\n-- Jets CB Sauce Gardner is inactive, while Allen Lazard is up.');
  const statusOf = sub => { const c = s.find(x => x.clause.includes(sub)); assert.ok(c, `no clause holds ${sub}`); return c.status; };
  assert.equal(statusOf('Alexander Mattison'), 'inactive');
  assert.equal(statusOf('Raheem Mostert'), 'inactive', 'as is inherits the previous status');
  assert.equal(statusOf('Bucky Irving'), 'active');
  assert.equal(statusOf('Sauce Gardner'), 'inactive');
  assert.equal(statusOf('Allen Lazard'), 'active', 'the while-clause is its own claim');
  assert.equal(mon.parseStatusClauses('Actives/inactives for Week 2').every(c => !c.status), true, 'a header is no claim');
  assert.equal(mon.parseStatusClauses('Jaylen Waddle is not active.')[0].status, 'inactive');
  assert.equal(mon.parseStatusClauses('Kamara is questionable and a game-time decision.')[0].status, null);
});

test('a watched post resolves full names, reads the card, stores no text', () => {
  const r = mon.ingestJetstreamEvent(commit('Kamara (knee) inactive for Week 3 against Detroit',
    { embed: 'Saints RB Alvin Kamara (knee) is inactive for Week 3 against the Lions.' }), WEEK);
  assert.equal(r.recorded, 1);
  const row = rows('SELECT * FROM live_inactive_claims WHERE player_id = 5001');
  assert.equal(row.length, 1);
  assert.equal(row[0].status, 'inactive');
  assert.equal(row[0].source_handle, 'rotoworld-fb.bsky.social');
  assert.match(row[0].source_uri, /^at:\/\/did:plc:lbe3b7ce6n7oa6cbl5jwoifo\/app\.bsky\.feed\.post\//);
  const cols = db.prepare('PRAGMA table_info(live_inactive_claims)').all().map(c => c.name);
  assert.equal(cols.some(c => /text|body|content/.test(c)), false, `no post-text column: ${cols}`);
  assert.equal(JSON.stringify(row[0]).includes('Detroit'), false, 'post text is not stored');
});

test('list posts, shared names, and a mixed post', () => {
  mon.ingestJetstreamEvent(commit('Harvey, Mims among Broncos inactives',
    { embed: 'Broncos declared RB RJ Harvey, WR Marvin Mims Jr., QB Sam Ehlinger inactive for Week 3 against the Jaguars.' }), WEEK);
  mon.ingestJetstreamEvent(commit('Mike Williams is inactive.'), WEEK); // two teamed players share the name, no hint
  mon.ingestJetstreamEvent(commit('Raiders WR Mike Williams is officially inactive.'), WEEK);
  mon.ingestJetstreamEvent(commit('Late-game active/inactives:\n— Dolphins WR Tyreek Hill is active.\n— Tua Tagovailoa and Jaylen Waddle are both inactive.'), WEEK);
  const got = byName(rows('SELECT * FROM live_inactive_claims WHERE retracted_at IS NULL'));
  assert.equal(got['RJ Harvey#5003'], 'inactive');
  assert.equal(got['Marvin Mims Jr.#5004'], 'inactive');
  assert.equal(got['Mike Williams#5006'], 'inactive', 'the team hint picks the Raider');
  assert.equal(got['Mike Williams#5005'], undefined, 'the unhinted Mike Williams is refused, not guessed');
  assert.equal(got['Tyreek Hill#5009'], 'active');
  assert.equal(got['Tua Tagovailoa#5008'], 'inactive');
  assert.equal(got['Jaylen Waddle#5007'], 'inactive');
});

test('unwatched accounts are ignored; redelivery is idempotent; delete retracts; later active supersedes', () => {
  const before = rows('SELECT COUNT(*) n FROM live_inactive_claims')[0].n;
  assert.equal(mon.ingestJetstreamEvent(commit('Brock Bowers is inactive.', { did: 'did:plc:someoneelse' }), WEEK).recorded, 0);
  const ev = commit('Brock Bowers (knee) will not play in Week 3.', { rkey: 'bowers1' });
  mon.ingestJetstreamEvent(ev, WEEK);
  mon.ingestJetstreamEvent(ev, WEEK); // at-least-once delivery
  assert.equal(rows('SELECT COUNT(*) n FROM live_inactive_claims')[0].n, before + 1);
  assert.equal(mon.liveInactiveClaims(WEEK).get(5002)?.status, 'inactive');

  mon.ingestJetstreamEvent(commit(null, { rkey: 'bowers1', op: 'delete' }), WEEK);
  assert.equal(mon.liveInactiveClaims(WEEK).has(5002), false, 'a deleted post no longer flags');
  assert.equal(rows('SELECT COUNT(*) n FROM live_inactive_claims')[0].n, before + 1, 'retracted, not deleted');

  assert.equal(mon.liveInactiveClaims(WEEK).get(5001)?.status, 'inactive');
  mon.ingestJetstreamEvent(commit('Saints RB Alvin Kamara is active.', { time: '2026-09-27T16:10:00Z' }), WEEK);
  assert.equal(mon.liveInactiveClaims(WEEK).has(5001), false, 'the later active claim wins');
  assert.equal(mon.liveInactiveClaims({ season: 2026, week: 4 }).size, 0, 'claims are scoped to their week');
});

test('poll: Jetstream v2 URL with dids filter and cursor; closes when idle', async () => {
  const opened = [];
  class FakeWS {
    constructor(url, protocols) {
      opened.push({ url, protocols });
      this.listeners = {};
      setTimeout(() => {
        this.emit('open');
        this.emit('message', { data: JSON.stringify(commit('Chargers WR Mike Williams is inactive.', { rkey: 'poll1' })) });
      }, 5);
    }
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
    emit(t, e = {}) { for (const f of this.listeners[t] ?? []) f(e); }
    close() { this.closed = true; setTimeout(() => this.emit('close'), 1); }
  }
  const now = Date.parse('2026-09-27T16:00:00Z');
  const out = await mon.pollJetstream({ WebSocketImpl: FakeWS, now, lookbackMinutes: 30, idleMs: 30, timeoutMs: 2000, ...WEEK });
  assert.equal(out.recorded, 1);
  const u = new URL(opened[0].url);
  assert.equal(u.host, 'jetstream.us-east.bsky.network');
  assert.equal(u.pathname, '/xrpc/network.bsky.jetstream.subscribeEvents');
  assert.equal(u.searchParams.get('kinds'), 'commit');
  assert.deepEqual(u.searchParams.getAll('collections'), ['app.bsky.feed.post']);
  assert.ok(u.searchParams.getAll('dids').includes(DID));
  assert.equal(Number(u.searchParams.get('cursor')), (now - 30 * 60_000) * 1000, 'cursor is unix microseconds');
  assert.equal(mon.liveInactiveClaims(WEEK).get(5005)?.status, 'inactive');
});
