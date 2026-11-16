/**
 * FIX-184-6 (tdd section 9 item 9): one availability-claim reader over both producers.
 *
 * `nfl_news_signals` (nfl-news-signal.js STATUS_RULES) and `live_inactive_claims`
 * (live-inactive-monitor.js) both turn text into "is he playing this week". Before this,
 * Start/Sit read only the second, so a later verified news "cleared to play" could not
 * cancel an earlier live "inactive". server/services/availability-claims.js reads both;
 * the latest definitive claim before the player's own kickoff wins, and the output names
 * the table and the source it came from.
 *
 * All names here are fictional fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-availability-claims-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const mon = await import('../server/services/live-inactive-monitor.js');
// Absent before FIX-184-6. Only a missing module is tolerated, so the RED run fails on
// the assertions rather than on the import.
let reader = null;
try { reader = await import('../server/services/availability-claims.js'); }
catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const WEEK = { season: 2026, week: 6 };
run(`INSERT OR IGNORE INTO nfl_teams (id, abbr, name, conference, division) VALUES (931, 'FXA', 'Fixture Anchors', 'NFC', 'South')`);
// Kickoff Sunday 2026-10-18 13:00 ET = 17:00Z.
run(`INSERT INTO game_lines (season, week, team, gameday, gametime) VALUES (2026, 6, 'FXA', '2026-10-18', '13:00')`);
const PLAYERS = [
  { id: 8101, name: 'Cleared Later', position: 'RB' },
  { id: 8102, name: 'Scratched Later', position: 'WR' },
  { id: 8103, name: 'Late News', position: 'WR' },
  { id: 8104, name: 'Late Post', position: 'TE' },
  { id: 8105, name: 'Quarantined Story', position: 'RB' }
].map(p => ({ ...p, team_abbr: 'FXA' }));
for (const p of PLAYERS) run('INSERT INTO players (id, name, position, team_id) VALUES (?,?,?,931)', p.id, p.name, p.position);

const live = (playerId, name, status, at, rkey) => mon.recordClaim({
  source_uri: mon.postUri('did:plc:lbe3b7ce6n7oa6cbl5jwoifo', rkey), player_id: playerId, player_name: name, status,
  season: WEEK.season, week: WEEK.week, source_handle: 'rotoworld-fb.bsky.social', source_did: 'did:plc:lbe3b7ce6n7oa6cbl5jwoifo',
  posted_at: at, first_seen_at: at });
let newsId = 700;
const news = (p, status, at, { verified = true } = {}) => run(`INSERT INTO nfl_news_signals
  (news_id, player_key, player_id, player_name, team, signal_type, status, confidence, published_at, source, source_url,
   evidence_span, extractor_version, verification_state, verification_reason)
  VALUES (?, ?, ?, ?, 'FXA', 'availability', ?, 0.8, ?, 'Fixture Wire', 'https://example.test/story', 'fixture', 'fixture-v1', ?, 'fixture')`,
newsId++, p.name.toLowerCase(), String(p.id), p.name, status, at, verified ? 'verified' : 'quarantined');

const [cleared, scratched, lateNews, latePost, quarantined] = PLAYERS;
live(cleared.id, cleared.name, 'inactive', '2026-10-18T14:00:00Z', 'a1');
news(cleared, 'available_positive', '2026-10-18T15:00:00Z');
news(scratched, 'available_positive', '2026-10-18T14:00:00Z');
live(scratched.id, scratched.name, 'inactive', '2026-10-18T15:30:00Z', 'a2');
live(lateNews.id, lateNews.name, 'inactive', '2026-10-18T15:00:00Z', 'a3');
news(lateNews, 'available_positive', '2026-10-18T17:30:00Z');
live(latePost.id, latePost.name, 'inactive', '2026-10-18T17:10:00Z', 'a4');
news(quarantined, 'out', '2026-10-18T15:00:00Z', { verified: false });

const read = () => reader.availabilityClaims({ ...WEEK, players: PLAYERS, now: Date.parse('2026-10-18T16:30:00Z') });

test('news says available later than a live inactive claim: available wins, source named', () => {
  assert.ok(reader, 'server/services/availability-claims.js exists');
  const c = read().get(cleared.id);
  assert.equal(c?.status, 'active');
  assert.equal(c.source, 'nfl_news_signals');
  assert.equal(c.source_name, 'Fixture Wire');
  assert.equal(c.at, '2026-10-18T15:00:00Z');
});

test('a live inactive claim later than the news: inactive wins, source named', () => {
  assert.ok(reader, 'server/services/availability-claims.js exists');
  const c = read().get(scratched.id);
  assert.equal(c?.status, 'inactive');
  assert.equal(c.source, 'live_inactive_claims');
  assert.equal(c.source_name, 'rotoworld-fb.bsky.social');
  assert.match(c.source_url, /^https:\/\/bsky\.app\/profile\//);
});

test('a claim after kickoff is ignored, from either producer; quarantined news is not a claim', () => {
  assert.ok(reader, 'server/services/availability-claims.js exists');
  const got = read();
  assert.equal(got.get(lateNews.id)?.status, 'inactive', 'news published after his kickoff cannot clear him');
  assert.equal(got.get(lateNews.id)?.source, 'live_inactive_claims');
  assert.equal(got.has(latePost.id), false, 'a live post first seen after his kickoff is not a pre-kickoff claim');
  assert.equal(got.has(quarantined.id), false, 'only verified news counts, as playerNewsSignal reads it');
});

test('the one-set hook: inactive winners only, each with its source, gated by the live-inactive flag', () => {
  assert.ok(reader, 'server/services/availability-claims.js exists');
  const on = reader.claimInactiveHook({ ...WEEK, players: PLAYERS, now: Date.parse('2026-10-18T16:30:00Z'), fields: { enabled: true } });
  assert.equal(on.covered, true);
  assert.deepEqual([...on.ids].sort(), [scratched.id, lateNews.id].sort());
  assert.equal(on.byId.get(scratched.id).source, 'live_inactive_claims');
  assert.match(on.byId.get(scratched.id).sentence, /rotoworld-fb\.bsky\.social/);
  const off = reader.claimInactiveHook({ ...WEEK, players: PLAYERS, fields: { enabled: false, reason: 'off: why' } });
  assert.equal(off.covered, false);
  assert.equal(off.ids.size, 0);
  assert.equal(off.reason, 'off: why');
});
