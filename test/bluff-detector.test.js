/**
 * Bluff detector: a declared "untouchable" only means something as a claim about
 * the speaker's OWN roster.
 *
 * Found in the 2026-09-18 structural relook: `declarations()`/`openings()` joined
 * speaker to mentioned_player with no ownership check. Real example from the live
 * chat DB: Raj's "5 of 5 hard reversals" included Achane and Chase Brown, which are
 * NICK's players, not Raj's — Raj was talking about someone else's roster, and the
 * code scored it as if he had declared and then reversed his own. This test pins
 * the fix: only a declaration about a player the speaker owns AT THE TIME (from
 * `league_roster_snapshots`, the same weekly-captured roster history the rest of the
 * app already uses) counts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-bluff-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { declarationCredibility } = await import('../server/services/bluff-detector.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function buildChat() {
  if (fs.existsSync(CHAT_PATH)) fs.rmSync(CHAT_PATH);
  const chat = new DatabaseSync(CHAT_PATH);
  chat.exec(`
    CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT,
      is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
    CREATE UNIQUE INDEX messages_msg_id ON messages(msg_id);
    CREATE TABLE jev_chat_signals (msg_id INTEGER NOT NULL, name TEXT, chat_kind TEXT, mentioned_player TEXT,
      question TEXT NOT NULL, probability REAL, evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, question));
  `);
  const msg = chat.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,0,0)`);
  const sig = chat.prepare(`INSERT INTO jev_chat_signals VALUES (?,?,?,?,?,?,?)`);

  // Raj declares "Own Guy" (which Raj actually owns) untouchable, then opens the
  // door 2 days later — a real hard reversal, must still count after the fix.
  msg.run(1, 'group', 'League', 'h1', 'Raj', 0, '2026-09-01T12:00:00Z', 'Own Guy is not going anywhere');
  sig.run(1, 'Raj', 'group', 'Own Guy', 'own_roster.untouchable', 0.9, '2026-09-02');
  msg.run(2, 'group', 'League', 'h1', 'Raj', 0, '2026-09-03T12:00:00Z', 'ok make an offer on him');
  sig.run(2, 'Raj', 'group', 'Own Guy', 'open_to_trade', 0.9, '2026-09-04');

  // Raj also says "Rival Star" (owned by Nick, not Raj) is not going anywhere,
  // then later says he's open to trading for him (from Nick, obviously) - this
  // is Raj talking about SOMEONE ELSE'S roster, not declaring his own untouchable,
  // and must NOT count as a Raj declaration or a Raj reversal at all.
  msg.run(3, 'group', 'League', 'h1', 'Raj', 0, '2026-09-05T12:00:00Z', 'Rival Star is not going anywhere for you');
  sig.run(3, 'Raj', 'group', 'Rival Star', 'own_roster.untouchable', 0.85, '2026-09-06');
  msg.run(4, 'group', 'League', 'h1', 'Raj', 0, '2026-09-07T12:00:00Z', 'ok I would take Rival Star actually');
  sig.run(4, 'Raj', 'group', 'Rival Star', 'open_to_trade', 0.85, '2026-09-08');

  chat.close();
}

function buildRosterHistory() {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, team_count, my_team_id, roster_positions)
       VALUES (4, 'espn', 'espn-bluff-4', 2026, 'Bluff test league', 2, '5', '[]')`);
  // league_roster_snapshots is the app's own weekly-captured roster history
  // (migration 058) — the same source everything else in the app uses for "who
  // owns whom, as of when." Roster 10 = Raj (owns "Own Guy"), roster 5 = Nick
  // (owns "Rival Star"), both captured before every message above.
  run(`INSERT INTO league_roster_snapshots
       (league_id, season, scoring_period_id, team_id, espn_player_id, player_id, player_name,
        position, espn_position_id, pro_team_id, lineup_slot_id, lineup_slot, is_starter,
        injury_status, pregame_injury_status, acquisition_type, lineup_locked, projected_points,
        actual_points, on_roster, source, first_seen_at, changed_at)
       VALUES (4, 2026, 1, '10', 900, NULL, 'Own Guy', 'RB', 2, 1, 2, 'RB', 1,
               'ACTIVE', NULL, 'DRAFT', 0, 10, 10, 1, 'live', '2026-08-25', '2026-08-25'),
              (4, 2026, 1, '5', 901, NULL, 'Rival Star', 'RB', 2, 2, 2, 'RB', 1,
               'ACTIVE', NULL, 'DRAFT', 0, 12, 12, 1, 'live', '2026-08-25', '2026-08-25')`);
  run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name,
         chat_name, match_method, confidence)
       VALUES (4, '10', '{RAJ}', 'Raj', 'Raj Team', 'Raj', 'confirmed by Nick', 'confirmed')`);
}

test('a declaration about a player the speaker does NOT own is not a self-declaration, and cannot be a bluff', () => {
  buildChat();
  buildRosterHistory();
  const { byManager, events } = declarationCredibility();
  const raj = byManager.get('Raj');
  assert.ok(raj, 'Raj has a credibility record from his real declaration');
  assert.equal(raj.declarations, 1, 'only "Own Guy" counts - "Rival Star" is not his to declare');
  assert.equal(raj.hard_reversals, 1, 'the real reversal on his own player still counts');
  const players = Object.keys(raj.players);
  assert.deepEqual(players, ['Own Guy']);
  assert.ok(!events.some(e => e.name === 'Raj' && String(e.player).toLowerCase() === 'rival star'),
    'no event is recorded for a player Raj never owned');
});

test('a chat name with no roster link anywhere cannot have its declarations verified, and none are trusted at face value', () => {
  // Reuses the same chat DB as test 1 (buildChat() is not called again - a genuinely
  // fresh chat/app DB pair per test would need full isolation this suite does not have,
  // and the point survives without it): "Unlinked Manager" appears in jev_chat_signals
  // exactly like Raj did, but gets no league_member_identity row and no roster_snapshot
  // row anywhere, so ownedPlayersByChatName() can never resolve what he owns.
  const chat = new DatabaseSync(CHAT_PATH);
  const msg = chat.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,0,0)`);
  const sig = chat.prepare(`INSERT INTO jev_chat_signals VALUES (?,?,?,?,?,?,?)`);
  msg.run(5, 'group', 'League', 'h1', 'Unlinked Manager', 0, '2026-09-09T12:00:00Z', 'Some Guy is not going anywhere');
  sig.run(5, 'Unlinked Manager', 'group', 'Some Guy', 'own_roster.untouchable', 0.9, '2026-09-10');
  chat.close();
  const { byManager } = declarationCredibility();
  assert.ok(!byManager.has('Unlinked Manager'),
    'a manager we cannot map to a roster contributes no declaration, rather than being trusted at face value');
});

test('fallback: a manager with no roster-snapshot history yet is checked against the current live roster instead', () => {
  const chat = new DatabaseSync(CHAT_PATH);
  const msg = chat.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,0,0)`);
  const sig = chat.prepare(`INSERT INTO jev_chat_signals VALUES (?,?,?,?,?,?,?)`);
  msg.run(6, 'group', 'League', 'h1', 'Lars', 0, '2026-09-11T12:00:00Z', 'Live Roster Guy is not going anywhere');
  sig.run(6, 'Lars', 'group', 'Live Roster Guy', 'own_roster.untouchable', 0.9, '2026-09-12');
  msg.run(7, 'group', 'League', 'h1', 'Lars', 0, '2026-09-13T12:00:00Z', 'Someone Elses Guy is not going anywhere');
  sig.run(7, 'Lars', 'group', 'Someone Elses Guy', 'own_roster.untouchable', 0.9, '2026-09-14');
  chat.close();
  // No league_roster_snapshots row for Lars's roster (id 20) at all, but the current
  // ESPN payload lists "Live Roster Guy" on his team - the fallback source.
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, roster_positions)
       VALUES (9, 'espn', 'espn-bluff-9', 2026, 'Fallback league', ?, 2, '21', '[]')`,
    JSON.stringify({ teams: [{ id: 20, roster: { entries: [
      { playerPoolEntry: { player: { fullName: 'Live Roster Guy' } } } ] } }] }));
  run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name,
         chat_name, match_method, confidence)
       VALUES (9, '20', '{LARS}', 'Lars', 'Lars Team', 'Lars', 'confirmed by Nick', 'confirmed')`);
  const { byManager } = declarationCredibility();
  const lars = byManager.get('Lars');
  assert.ok(lars, 'the live-roster fallback found Lars a roster');
  assert.equal(lars.declarations, 1, 'only the player on his current live roster counts');
  assert.deepEqual(Object.keys(lars.players), ['Live Roster Guy']);
});
