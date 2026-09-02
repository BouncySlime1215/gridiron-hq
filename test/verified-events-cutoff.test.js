import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Week-by-week news discipline: nothing from a later week, and nothing
// published after a game's kickoff, can reach that game's pregame read.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-events-cutoff-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
const archive = await import('../server/services/nfl-event-archive.js');
const { nflKickoffDate } = await import('../server/services/date-util.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const V = archive.VERIFIED_EVENT_ARCHIVE_VERSION;
function event({ type, week, team, name, status, available, version = V }) {
  run(`INSERT INTO nfl_verified_events (event_key,event_type,season,week,team,player_id,player_name,position,status_after,
      occurred_at,available_at,time_precision,source,source_url,verification_state,payload_json,archive_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  `${type}|${week}|${team}|${name}|${status}|${available}|${version}`, type, 2023, week, team, name.toLowerCase(), name, 'WR', status,
  available, available, 'timestamp', 'test', 'https://example.test', 'verified', '{}', version, '2026-01-01T00:00:00Z');
}

// Week 1: KC hosts on Thursday 2023-09-07 20:20 ET; Week 2: KC plays Sunday 2023-09-17 13:00 ET.
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
     VALUES (2023,1,'KC','DET',1,-4.5,53,28,'test',datetime('now'),'2023-09-07','20:20')`);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
     VALUES (2023,2,'KC','JAX',0,-3,51,27,'test',datetime('now'),'2023-09-17','13:00')`);
const week1Kickoff = nflKickoffDate('2023-09-07', '20:20').toISOString();

event({ type: 'official_injury_report', week: 1, team: 'KC', name: 'Travis Kelce', status: 'Questionable', available: '2023-09-06T21:00:00Z' });
event({ type: 'official_injury_report', week: 1, team: 'KC', name: 'Travis Kelce', status: 'Out', available: '2023-09-08T00:30:00Z' }); // ten minutes after the 00:20Z kickoff
event({ type: 'weekly_roster_status_change', week: 2, team: 'KC', name: 'Chris Jones', status: 'ACT', available: '2023-09-17T15:30:00Z' });
event({ type: 'official_injury_report', week: 2, team: 'KC', name: 'Chris Jones', status: 'Out', available: '2023-09-13T21:00:00Z' });
event({ type: 'trade', week: null, team: 'KC', name: 'Mecole Hardman', status: 'KC', available: '2023-09-08T12:00:00Z' }); // traded on game day; known next morning
event({ type: 'official_injury_report', week: 1, team: 'KC', name: 'Legacy Row', status: 'Out', available: '2023-09-06T12:00:00Z', version: 'nfl-verified-event-archive-v1' });

test('a week-1 pregame read sees only week-1 facts published before that kickoff', () => {
  const seen = archive.verifiedEventsForTeam('KC', { before: week1Kickoff, sinceDays: 10 });
  const names = seen.map(e => `${e.player_name}:${e.status_after}`);
  assert.deepEqual(names, ['Travis Kelce:Questionable']);
  assert.ok(!names.some(n => n.startsWith('Chris Jones')), 'week-2 injury and week-2 roster status are invisible to week 1');
  assert.ok(!names.includes('Travis Kelce:Out'), 'a report modified after kickoff is invisible');
  assert.ok(!names.includes('Mecole Hardman:KC'), 'a game-day trade is known the next morning, so it is invisible to that evening kickoff');
  assert.ok(!names.includes('Legacy Row:Out'), 'rows from the earlier archive version are ignored');
  const vector = archive.teamEventVector('KC', { before: week1Kickoff, sinceDays: 10 });
  assert.equal(vector.events, 1);
  assert.equal(vector.injury_burden, 0.4, 'Questionable weighs 0.4; nothing else contributes');
});

test('the same facts become visible for week 2, in the order they were published', () => {
  const week2Kickoff = nflKickoffDate('2023-09-17', '13:00').toISOString();
  const seen = archive.verifiedEventsForTeam('KC', { before: week2Kickoff, sinceDays: 10 });
  const names = seen.map(e => `${e.player_name}:${e.status_after}`);
  assert.ok(names.includes('Chris Jones:Out'), 'the Wednesday week-2 report is in');
  assert.ok(names.includes('Chris Jones:ACT'), 'the week-2 inactive list is stamped ninety minutes before kickoff, so a kickoff cutoff sees it');
  assert.ok(names.includes('Mecole Hardman:KC'));
  assert.ok(names.includes('Travis Kelce:Out'), 'last week\'s post-kickoff correction is now history');
  const vector = archive.teamEventVector('KC', { before: week2Kickoff, sinceDays: 10 });
  assert.equal(vector.active_player_states.find(e => e.player_name === 'Travis Kelce').status_after, 'Out',
    'the newest state per player wins, and it is the newest BEFORE the cutoff');
});
