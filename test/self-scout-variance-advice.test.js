/**
 * RL-15-2: selfScout() must not tell a bubble or longshot team to "chase variance".
 *
 * trade-engine.js selfScout() used to end its fixes list with a "Roster shape" entry
 * keyed only on this week's projected-lineup rank: ranks 1-3 were told "You are ahead —
 * trade ceiling for floor", every other rank "You need variance — target boom-rate
 * players over steady ones". In 21,946 Sleeper team-seasons (2021-2024; R&D r15,
 * rnd/loop/r15-internal-scout-tells-most-teams-chase-variance.md, pre-registered) the
 * teams that rule calls "bubble" won FEWER titles at higher weekly variance:
 * -0.138 log-odds per SD [-0.214, -0.067], about -1.0 pp on an 8.8% base. The
 * contender half had no support either (-0.040 [-0.125, +0.036]). The range and rank
 * the entry repeated are already on the TeamScout header (TeamScout.tsx:40-55), so the
 * fix has nothing factual left to say that is not shown elsewhere.
 *
 * Fixture: a 10-team, one-WR league where every WR plays this week and has a weekly
 * model (so lineupSpread() coverage is 1 and the Roster shape branch's precondition
 * holds). player-week-engine.js is mocked with a real WR params shape (copied from
 * test/asset-universe-bye-week-range.test.js) so lineupSpread() samples real weeks.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-self-scout-variance-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '3';

const wrParams = targets => ({
  position: 'WR', attempts: 0, carries: 0, targets, dispersion: 10,
  ypa: 7, pass_td_rate: 0.045, int_rate: 0.025, ypc: 4.2, rush_td_rate: 0.03,
  catch_rate: 0.68, ypt: 8, rec_td_rate: 0.05
});
// Ten WRs, ids 1001..1010, projecting 10, 12, ..., 28 ppg: strictly ordered so the
// served rank is fixed by construction.
const IDS = Array.from({ length: 10 }, (_, i) => 1001 + i);
const PPG = id => 10 + 2 * (id - 1001);
const realWeekEngine = await import('../server/services/player-week-engine.js');
mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    ...realWeekEngine,
    buildPlayerWeekEngine: () => new Map(IDS.map(id => [id, {
      ppg: PPG(id), params: wrParams(4 + (id - 1001)), ensemble_shift: 0, volume: { target_share: 0.15 }
    }])),
    playerWeekDistribution: () => ({ p10: 8, p90: 32, mean: 20, boom_rate: 0.22, bust_rate: 0.11 })
  }
});

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { selfScout } = await import('../server/services/trade-engine.js');
const { hashSessionToken, requireAuthenticated } = await import('../server/platform/auth.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const express = (await import('express')).default;

// The consumer: GET /api/trades/:leagueId/scout (routes/trades.js), which My Team
// (MyTeam.tsx:58) and PostDraftPlan read, driven over HTTP by a league member.
run(`INSERT INTO users (subject, display_name) VALUES ('rl152', 'rl152')`);
const userId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 day'))`,
  userId, hashSessionToken('rl152-token'));
const app = express();
app.use('/api/trades', requireAuthenticated, tradesRouter);
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/trades`;

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (1, 'AAA', 'Alpha', 'AFC', 'East'), (2, 'BBB', 'Beta', 'NFC', 'West')`);
for (let w = 1; w <= 14; w++) {
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 1, ?, 'BBB', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 2, ?, 'AAA', 0)`, w);
}
for (const id of IDS) {
  run(`INSERT INTO players (id, name, position, team_id) VALUES (?, ?, 'WR', ?)`, id, `WR ${id}`, id % 2 ? 1 : 2);
}

const espnEntry = id => ({ playerPoolEntry: { player: { id: 70000 + id, fullName: `WR ${id}`, defaultPositionId: 3 } } });
// Team k (1..10) rosters WR 1000+k, so team 10 has the best WR and team 1 the worst.
const league = () => ({
  id: 1, platform: 'espn', team_count: 10, ppr: 1, best_ball: 0, league_type: null, my_team_id: '1',
  roster_positions: JSON.stringify(['WR']),
  payload: JSON.stringify({ teams: IDS.map((id, i) => ({
    id: i + 1, name: `Team ${i + 1}`, roster: { entries: [espnEntry(id)] }
  })) })
});
// Rank of team k on this week's projection is 11 - k.
const BUBBLE = '6';    // rank 5 of 10 -> the old code's "bubble"
const LONGSHOT = '1';  // rank 10 of 10 -> "longshot"
const CONTENDER = '10'; // rank 1 of 10 -> "contender"

const VARIANCE = /chase variance|You need variance|boom-rate/i;
// Everything TeamScout renders for a fix (area, issue and action), so banned wording in
// any rendered field fails, not only in action.
const rendered = fixes => fixes.map(f => `${f.area} ${f.issue} ${f.action}`);

test('control: the fixture puts each team where the old rule would bucket it, with a modelled range', () => {
  const b = selfScout(league(), BUBBLE);
  assert.equal(b.rank, 5, `bubble fixture must rank 5th, got ${b.rank}`);
  assert.equal(selfScout(league(), LONGSHOT).rank, 10);
  assert.equal(selfScout(league(), CONTENDER).rank, 1);
  // The Roster shape branch only ran when floor != null && coverage > 0.5; without this
  // control a pass below could just mean the branch never fired.
  assert.ok(b.spread.floor != null, `the weekly range must be modelled, got floor ${b.spread.floor}`);
  assert.ok(b.spread.coverage > 0.5, `lineupSpread coverage must exceed 0.5, got ${b.spread.coverage}`);
});

test('RED: a bubble team is not told to chase variance', () => {
  const hits = rendered(selfScout(league(), BUBBLE).fixes).filter(a => VARIANCE.test(a));
  assert.deepEqual(hits, [], `bubble team got variance advice: ${JSON.stringify(hits)}`);
});

test('RED: a longshot team is not told to chase variance', () => {
  const hits = rendered(selfScout(league(), LONGSHOT).fixes).filter(a => VARIANCE.test(a));
  assert.deepEqual(hits, [], `longshot team got variance advice: ${JSON.stringify(hits)}`);
});

test('RED: no team gets the unmeasured Roster shape imperative (contender half had no support either)', () => {
  for (const team of [BUBBLE, LONGSHOT, CONTENDER]) {
    const shape = selfScout(league(), team).fixes.filter(f => f.area === 'Roster shape');
    assert.deepEqual(shape, [], `team ${team} still gets a Roster shape fix: ${JSON.stringify(shape)}`);
  }
  const ahead = rendered(selfScout(league(), CONTENDER).fixes).filter(a => /You are ahead|ceiling for floor/i.test(a));
  assert.deepEqual(ahead, [], `contender got "You are ahead": ${JSON.stringify(ahead)}`);
});

test('RED (consumer): the scout route serves the chosen bubble team without variance advice', async () => {
  const lg = league();
  run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, roster_positions)
       VALUES (?, 'espn', 'rl152', 2026, 'RL-15-2 fixture', ?, 10, '1', ?)`, lg.id, lg.payload, lg.roster_positions);
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?, ?, 'commissioner')`, lg.id, userId);
  const res = await fetch(`${base}/${lg.id}/scout?team_id=${BUBBLE}`, { headers: { Authorization: 'Bearer rl152-token' } });
  assert.equal(res.status, 200, `scout route status ${res.status}`);
  const body = await res.json();
  assert.equal(body.team.roster_id, BUBBLE, `route must scout the requested team, got ${body.team.roster_id}`);
  assert.equal(body.rank, 5);
  assert.ok(body.spread.floor != null, 'control: the served range is modelled');
  const hits = rendered(body.fixes).filter(a => VARIANCE.test(a));
  assert.deepEqual(hits, [], `route served variance advice: ${JSON.stringify(hits)}`);
});

test('control: the other fixes still fire (the longshot WR is a weakness and gets a trade fix)', () => {
  const s = selfScout(league(), LONGSHOT);
  const wr = s.fixes.find(f => f.area === 'WR' && f.priority === 'high');
  assert.ok(wr, `expected a high-priority WR weakness fix, got ${JSON.stringify(s.fixes)}`);
  assert.match(wr.action, /for a starting WR/);
});
