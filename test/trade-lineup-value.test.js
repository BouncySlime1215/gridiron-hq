/**
 * RL-9-3: a trade's LINEUP value charges the roster spot.
 *
 * The summed market value (value_delta) adds players up as if roster spots were
 * free, so a 2-for-1 always reads better for whoever gets more players. The
 * lineup value is the change in a team's best starting lineup over the remaining
 * weeks, where the side that frees a spot fills it from THAT league's wire (the
 * best free agent who helps most) and the side that needs a spot drops whoever
 * costs its lineup least. Reported next to value_delta, labelled not validated;
 * it changes no recommendation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineup-value-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '4';

const { evaluate, lineupValue, lineupValueContext } = await import('../server/services/trade-engine.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let nextId = 1;
const P = (name, position, ppg, value, extra = {}) => ({
  id: nextId++, name, position, team_abbr: 'AAA', adj_ppg: ppg, ppg, value, ...extra
});

// Team A (the 2-player side): deep at RB/WR, so two more starters barely move it.
const aStar = P('A Star RB', 'RB', 20, 6000);
const teamA = { roster_id: '1', owner: 'A', players: [
  P('A QB', 'QB', 20, 3000), aStar, P('A RB2', 'RB', 15, 2500),
  P('A WR1', 'WR', 16, 3000), P('A WR2', 'WR', 15, 2800), P('A TE', 'TE', 9, 1200),
  P('A WR3', 'WR', 14, 2400), P('A RB3', 'RB', 13, 2000), P('A bench', 'WR', 4, 100)
] };
// Team B (the 1-player side): sells two mid starters for the star.
const bMid1 = P('B Mid WR', 'WR', 11, 3600);
const bMid2 = P('B Mid RB', 'RB', 10, 3500);
const teamB = { roster_id: '2', owner: 'B', players: [
  P('B QB', 'QB', 18, 2500), P('B RB1', 'RB', 12, 2000), bMid2,
  P('B WR1', 'WR', 14, 2600), bMid1, P('B TE', 'TE', 8, 900),
  P('B RB3', 'RB', 3, 50), P('B WR3', 'WR', 3, 50), P('B TE2', 'TE', 2, 20)
] };
// This league's wire: a startable WR is free.
const faWR = P('Wire WR', 'WR', 10, 900);
const faTE = P('Wire TE', 'TE', 5, 300);
// The best fill is listed LAST, so a solver that takes the first free agent it sees fails.
const WIRE = [faTE, P('Wire RB', 'RB', 6, 400), P('Wire QB', 'QB', 14, 800), faWR];
const WEEKS = 14;

test('2-for-1: summed value favours the 2-player side, the lineup value favours the 1-player side', () => {
  const ev = evaluate({ team: teamA, gives: [aStar] }, { team: teamB, gives: [bMid1, bMid2] }, SLOTS,
    { lineupValue: { wire: WIRE, weeksLeft: WEEKS } });
  // The summed number the card calls "fair": A (gets two) is up 1,100.
  assert.ok(ev.me.value_delta > 0, `summed value favours A: ${ev.me.value_delta}`);
  assert.ok(ev.them.value_delta < 0);
  const a = ev.me.lineup_value, b = ev.them.lineup_value;
  assert.ok(a && b, 'lineup_value is on both sides of the evaluate payload');
  assert.equal(a.status, 'not yet validated');
  assert.equal(b.status, 'not yet validated');
  // B frees a spot and fills it from the wire; A needs a spot and drops.
  assert.equal(b.roster_spots, -1);
  assert.deepEqual(b.replacement.map(r => r.name), ['Wire WR']);
  assert.equal(a.roster_spots, 1);
  assert.deepEqual(a.dropped.map(r => r.name), ['A bench']);
  // A: 109 -> 102 (the 20-pt RB leaves; RB2 15 and RB3 13 start, the two arrivals sit)
  // = -7/wk. B: 76 -> 85 (+20 RB for the 10 RB, the wire WR 10 for the 11 WR) = +9/wk.
  assert.equal(a.per_week, -7);
  assert.ok(b.total > a.total, `lineup favours B: A ${a.total} vs B ${b.total}`);
  assert.equal(b.per_week, 9);
  assert.equal(b.total, 9 * WEEKS);
  assert.equal(a.weeks, WEEKS);
  // Control: without the wire fill B's lineup value would be lower (the RED this pins).
  assert.ok(b.per_week > ev.them.ppg_delta, `fill adds to B: ${b.per_week} vs unfilled ${ev.them.ppg_delta}`);
});

test('1-for-1: summed value and lineup value agree, nobody drops or adds', () => {
  const give = teamA.players.find(p => p.name === 'A TE');
  const get = teamB.players.find(p => p.name === 'B TE');
  const ev = evaluate({ team: teamA, gives: [give] }, { team: teamB, gives: [get] }, SLOTS,
    { lineupValue: { wire: WIRE, weeksLeft: WEEKS } });
  const a = ev.me.lineup_value;
  assert.equal(a.roster_spots, 0);
  assert.deepEqual(a.replacement, []);
  assert.deepEqual(a.dropped, []);
  // A sends a 9-pt TE worth 1,200 for an 8-pt TE worth 900: both numbers say A loses.
  assert.equal(Math.sign(ev.me.value_delta), -1);
  assert.equal(Math.sign(a.total), Math.sign(ev.me.value_delta));
  assert.equal(Math.sign(ev.them.lineup_value.total), Math.sign(ev.them.value_delta));
  // No spot changes hands, so it is exactly the existing lineup delta times the weeks.
  assert.equal(a.per_week, ev.me.ppg_delta);
  assert.equal(a.total, +(ev.me.ppg_delta * WEEKS).toFixed(1));
  // One producer for the season-scale lineup number: with no spot changing hands the
  // existing season_delta and lineup_value.total are the same number.
  assert.equal(ev.me.season_delta, a.total);
  assert.equal(ev.them.season_delta, ev.them.lineup_value.total);
  assert.equal(ev.me.season_delta_weeks, WEEKS);
  assert.equal(ev.me.season_delta_basis, 'weeks_remaining');
});

test('a bye THIS week is counted once, not in every week left', () => {
  // A's TE: 9 this week and after. B's TE: on bye this week (0), 8 a week after, so
  // adj_ppg (25% this week + 75% rest of season) is 6.
  const aTE = P('A TE bye-test', 'TE', 9, 1200, { current_week_ppg: 9, ros_ppg: 9 });
  const bTE = P('B TE bye-test', 'TE', 6, 900, { current_week_ppg: 0, ros_ppg: 8 });
  const tA = { ...teamA, players: [...teamA.players.filter(p => p.position !== 'TE'), aTE] };
  const tB = { ...teamB, players: [...teamB.players.filter(p => p.position !== 'TE'), bTE] };
  const ev = evaluate({ team: tA, gives: [aTE] }, { team: tB, gives: [bTE] }, SLOTS,
    { lineupValue: { wire: WIRE, weeksLeft: WEEKS } });
  const a = ev.me.lineup_value;
  assert.equal(a.per_week, ev.me.ppg_delta, 'per_week is still the ppg_delta number');
  assert.equal(a.per_week, -3);
  // By hand, week by week: this week 0 - 9, then 13 weeks of 8 - 9 = -9 - 13 = -22.
  // per_week x 14 would say -42.
  assert.equal(a.total, -22);
  assert.equal(ev.me.season_delta, -22);
});

test('without the weeks left, season_delta keeps the 17-week default and says so', () => {
  const ev = evaluate({ team: teamA, gives: [aStar] }, { team: teamB, gives: [bMid1, bMid2] }, SLOTS);
  assert.equal(ev.me.season_delta, +(ev.me.ppg_delta * 17).toFixed(1));
  assert.equal(ev.me.season_delta_weeks, 17);
  assert.equal(ev.me.season_delta_basis, 'full_season_default');
});

test('the needed spot costs the least-MISSED player, even when a starter is rated lower', () => {
  // The only TE (6) starts and is the lowest-rated player; the bench RB (8) sits.
  const out = P('C WR3', 'WR', 12, 1500);
  const team = { roster_id: '3', owner: 'C', players: [
    P('C QB', 'QB', 20, 3000), P('C RB1', 'RB', 15, 2500), P('C RB2', 'RB', 14, 2400),
    P('C WR1', 'WR', 15, 2600), P('C WR2', 'WR', 14, 2400), P('C TE', 'TE', 6, 800),
    out, P('C bench RB', 'RB', 8, 700)] };
  const gets = [P('In WR', 'WR', 13, 1600), P('In RB', 'RB', 9, 900)];
  const lv = lineupValue(team, [out], gets, SLOTS, { wire: WIRE, weeksLeft: WEEKS });
  assert.equal(lv.roster_spots, 1);
  assert.deepEqual(lv.dropped.map(p => p.name), ['C bench RB']);
  // FLEX 12 -> 13; the TE still starts.
  assert.equal(lv.per_week, 1);
});

test('no wire supplied: lineup_value is null, never a free roster spot', () => {
  const ev = evaluate({ team: teamA, gives: [aStar] }, { team: teamB, gives: [bMid1, bMid2] }, SLOTS);
  assert.equal(ev.me.lineup_value, null);
});

/** A minimal ESPN league whose rosters hold the named players. */
const espnLeague = (id, rosters) => ({
  id, platform: 'espn',
  payload: JSON.stringify({ teams: rosters.map((names, i) => ({ id: i + 1,
    roster: { entries: names.map(fullName => ({ playerPoolEntry: { player: { fullName } } })) } })) })
});

test('the replacement level reads THAT league\'s wire', async () => {
  const { leagueWire } = await import('../server/services/league-wire.js');
  const assets = new Map([...teamA.players, ...teamB.players, ...WIRE].map(p => [p.id, p]));
  const names = t => t.players.map(p => p.name);
  const l1 = espnLeague(1, [names(teamA), names(teamB)]);
  // League 2: a third team rosters the wire WR, so the best free WR is gone.
  const l2 = espnLeague(2, [names(teamA), names(teamB), ['Wire WR']]);
  assert.ok(leagueWire(l1, assets).some(p => p.name === 'Wire WR'), 'known-nonzero control: free in league 1');
  assert.ok(!leagueWire(l2, assets).some(p => p.name === 'Wire WR'), 'rostered in league 2');
  assert.ok(!leagueWire(l1, assets).some(p => p.name === 'A Star RB'), 'rostered players are never on the wire');

  const run = lg => {
    const ctx = lineupValueContext(lg, assets, [teamA, teamB]);
    return evaluate({ team: teamA, gives: [aStar] }, { team: teamB, gives: [bMid1, bMid2] }, SLOTS,
      { lineupValue: ctx }).them.lineup_value;
  };
  const b1 = run(l1), b2 = run(l2);
  assert.deepEqual(b1.replacement.map(r => r.name), ['Wire WR']);
  assert.notDeepEqual(b2.replacement.map(r => r.name), ['Wire WR']);
  assert.ok(b1.per_week > b2.per_week, `a deeper wire is worth more: ${b1.per_week} vs ${b2.per_week}`);
  // Week 4 on the default calendar: regular weeks 4-14 plus playoff weeks 15-17.
  assert.equal(b1.weeks, 14);
});
