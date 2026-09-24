/**
 * FEAS-140-ESPN: the 140 card on ESPN's projected-lineup scale (espn-lineup.js +
 * feasibility.js#espnPointsFeasibility). A made-up two-team ESPN payload; no DB, no real data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const E = await import('../server/services/campaign/espn-lineup.js');
const F = await import('../server/services/campaign/feasibility.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const ON = { [F.POINTS_FEASIBILITY_ENV]: '1' };
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, 'D/ST': 16 };
const SEASON = 2026;

// A player: ros per game, posted weeks { w: pts }, pro team, status.
let nextId = 1;
const pl = (pos, ros, { weeks = {}, team = 1, status = 'ACTIVE' } = {}) => ({
  playerId: nextId, playerPoolEntry: { player: {
    id: nextId++, fullName: `${pos} ${nextId}`, defaultPositionId: POS_ID[pos], proTeamId: team, injuryStatus: status,
    stats: [
      { seasonId: SEASON, statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, appliedAverage: ros, appliedTotal: ros * 17 },
      { seasonId: SEASON, statSourceId: 1, statSplitTypeId: 2, scoringPeriodId: 0, appliedAverage: ros + 5 },  // other split: ignored
      { seasonId: SEASON - 1, statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 99 },     // last season: ignored
      { seasonId: SEASON, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 77 },         // actual: ignored
      ...Object.entries(weeks).map(([w, t]) => ({ seasonId: SEASON, statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: Number(w), appliedTotal: t })),
    ] } } });

// Team 5: a sub-140 roster with an OUT back, an IR receiver and a bye pair. Week 3 posted.
const nick = [
  pl('QB', 20, { weeks: { 3: 18 } }), pl('QB', 10),
  pl('RB', 15, { weeks: { 3: 16 }, team: 2 }), pl('RB', 14, { weeks: { 3: 0 }, status: 'OUT' }), pl('RB', 9),
  pl('WR', 16, { team: 2 }), pl('WR', 12), pl('WR', 11), pl('WR', 30, { status: 'INJURY_RESERVE' }),
  pl('TE', 10), pl('TE', 4),
  pl('K', 8), pl('D/ST', 5),
];
// Team 1: a 155-a-game team.
const strong = [
  pl('QB', 25), pl('RB', 18), pl('RB', 17), pl('WR', 20), pl('WR', 19), pl('TE', 12), pl('RB', 16), pl('WR', 15),
  pl('K', 9), pl('D/ST', 8), pl('WR', 3),
];
const payload = { seasonId: SEASON, scoringPeriodId: 3, teams: [{ id: 5, roster: { entries: nick } }, { id: 1, roster: { entries: strong } }] };
const byes = new Map([[2, 5]]);   // pro team 2 on bye in week 5
const ctx = E.espnLineupContext(payload, { byes });
const weeks = [3, 4, 5, 6];
const sim = (vals, spread = [-6, -2, 2, 6]) => weeks.map((week, i) => ({ week, samples: spread.map(d => vals[i] + d) }));
const title = normaliseObjective({});

test('lineup: best legal 10 (QB, 2 RB, 2 WR, TE, 2 FLEX, K, D/ST); FLEX takes the best RB/WR/TE left', () => {
  const l = E.bestLineup([
    ...['QB:20', 'QB:19', 'RB:15', 'RB:14', 'RB:13', 'WR:16', 'WR:12', 'WR:11', 'TE:10', 'TE:9', 'K:8', 'D/ST:5', 'K:7']
      .map(s => { const [position, pts] = s.split(':'); return { position, points: Number(pts) }; }),
  ]);
  assert.equal(l.starters.length, 10);
  assert.deepEqual(l.starters.map(s => s.slot), ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'K', 'D/ST']);
  assert.deepEqual(l.starters.filter(s => s.slot === 'FLEX').map(s => s.points), [13, 11]);
  close(l.total, 20 + 15 + 14 + 16 + 12 + 10 + 13 + 11 + 8 + 5);
  assert.equal(E.LINEUP.reduce((s, [, , n]) => s + n, 0), 10);
});

test('weekly totals: posted week from split 1, else ROS per game; bye, OUT this week and IR score 0', () => {
  const v = ctx.forTeam(5);
  const [w3, w4, w5] = v.weeks([3, 4, 5]);
  // week 3 posted: QB 18, RB 16, RB(OUT) 0 -> RB 9, WR 16 / 12, TE 10, FLEX WR 11 + TE 4, K 8, D/ST 5; IR WR 0.
  close(w3.total, 18 + 16 + 9 + 16 + 12 + 10 + 11 + 4 + 8 + 5);
  assert.equal(w3.posted, true);
  // week 4, not posted: ROS per game; the OUT back returns (OUT is this week only); IR stays 0 (return unknown).
  close(w4.total, 20 + 15 + 14 + 16 + 12 + 10 + 11 + 9 + 8 + 5);
  assert.equal(w4.posted, false);
  // week 5: pro team 2 on bye (RB 15, WR 16) -> next men up.
  close(w5.total, 20 + 14 + 9 + 12 + 11 + 10 + 4 + 0 + 8 + 5);
  // ROS per game: ESPN's per-game numbers, no byes or status zeroes (the IR WR at 30 starts).
  close(v.ros_per_game, 20 + 15 + 14 + 30 + 16 + 10 + 12 + 11 + 8 + 5);
  assert.equal(v.label, 'ESPN projected lineup points (10 starters)');
  assert.equal(ctx.forTeam(99), null);
});

test('byes from the NFL schedule: the one week 1-18 a pro team does not play', () => {
  const rows = [];
  for (let w = 1; w <= 18; w++) { if (w !== 7) rows.push({ abbr: 'ATL', week: w }); if (w !== 9) rows.push({ abbr: 'BUF', week: w }); }
  const b = E.byesFromSchedule(rows);
  assert.equal(b.get(1), 7);    // ESPN proTeamId 1 = ATL
  assert.equal(b.get(2), 9);    // 2 = BUF
  assert.equal(b.has(3), false);
});

test('loader: reads only the payload and the schedule through the given db helpers', () => {
  const seen = [];
  const db = {
    row: (sql, ...a) => { seen.push(sql); return { platform: 'espn', season: SEASON, current_week: 3, payload: JSON.stringify(payload) }; },
    rows: (sql, ...a) => { seen.push(sql); return []; },
  };
  const c = E.loadEspnLineup(db, 4);
  assert.ok(c.forTeam(5));
  assert.ok(seen.every(s => !/espn_s2|swid|\*/i.test(s)), 'no cookie columns, no SELECT *');
  assert.equal(E.loadEspnLineup({ row: () => ({ platform: 'sleeper', payload: '{}' }), rows: () => [] }, 1), null);
});

test('p_hit takes only the spread from the sim: P(espn + (run - sim_mean) x espn/sim >= target)', () => {
  // runs 60/70/80/90 (mean 75), ESPN 150 -> k = 2 -> 120/140/160/180 vs 140 -> 3 of 4.
  close(F.espnHitProbability(150, [60, 70, 80, 90], 140), 0.75);
  assert.equal(F.espnHitProbability(150, [], 140), null);
  assert.equal(F.espnHitProbability(150, null, 140), null);
});

test('card: ESPN scale, labelled; baseline on ESPN weeks; the sim level never enters status', () => {
  const nowWeeks = sim([70, 72, 60, 72]);   // sim far below 140, as in league 4
  const f = F.sidePanelFeasibility({ objective: title, nowWeeks, plans: [], roster: [], currentWeek: 3, env: ON,
    espn: { now: ctx.forTeam(5) } });
  assert.equal(f.scale, 'espn_projected_lineup');
  assert.equal(f.scale_label, 'ESPN projected lineup points (10 starters)');
  const w3 = f.now.per_week.find(w => w.week === 3).mean;
  close(w3, 109);
  const espnMean = f.now.season_mean;
  close(espnMean, (109 + 120 + 93 + 120) / 4);
  assert.equal(f.status, 'out_of_reach');
  close(f.now.ros_per_game, 141);
  assert.ok(f.p_reach != null && f.p_reach >= 0 && f.p_reach <= 1);

  const g = F.sidePanelFeasibility({ objective: title, nowWeeks: sim([80, 80, 80, 80]), plans: [], roster: [], currentWeek: 3, env: ON,
    espn: { now: ctx.forTeam(1) } });
  close(g.now.season_mean, 25 + 18 + 17 + 20 + 19 + 12 + 16 + 15 + 9 + 8);   // 159, no byes on pro team 1
  assert.equal(g.status, 'on_track');
  assert.equal(g.arrive_week, 3);
  assert.equal(g.cost.basis, 'already on track');
  close(g.p_reach, 1);   // 159 x (74..86)/80 >= 140 in every run
});

test('card: a plan is priced on its post-trade roster; an unpriced plan carries no probability', () => {
  const nowWeeks = sim([70, 72, 60, 72]);
  const plans = [
    { label: 'swap', expected: 0.04, p_complete: 0.5, arrive_week: 4, give: [nick[5].playerId], steps: 1, weeks: sim([80, 82, 80, 82]),
      roster_after: strong.map(e => e.playerId) },
    { label: 'blind', expected: 0.05, p_complete: 0.9, arrive_week: 4, give: [1], steps: 1, weeks: sim([90, 90, 90, 90]) },
  ];
  const forPlan = p => (p.roster_after ? ctx.forRoster(p.roster_after) : null);
  const f = F.sidePanelFeasibility({ objective: title, nowWeeks, plans, roster: [], currentWeek: 3, env: ON,
    espn: { now: ctx.forTeam(5), forPlan } });
  assert.equal(f.status, 'reachable');
  const swap = f.options.find(o => o.label === 'swap');
  assert.equal(swap.priced, true);
  close(swap.season_mean_after, 159);
  assert.equal(swap.first_week_at_target, 4);
  assert.equal(f.arrive_week, 4);
  assert.equal(f.options[0].label, 'swap');
  const blind = f.options.find(o => o.label === 'blind');
  assert.equal(blind.priced, false);
  assert.equal(blind.p_average_hits, null);
  assert.equal(blind.season_mean_after, null);
  assert.equal(f.cost.players, 1);
  close(f.cost.title_odds, 0.01);
});

test('without an ESPN context the card is the incumbent sim-scale report, unchanged', () => {
  const f = F.sidePanelFeasibility({ objective: title, nowWeeks: sim([150, 150, 150, 150]), plans: [], roster: [], currentWeek: 3, env: ON });
  assert.equal(f.scale, undefined);
  assert.equal(f.scale_label, undefined);
  assert.equal(f.status, 'on_track');
});

test('validatePlans: an ESPN-scale card (with and without a probability) passes the plans contract', async () => {
  const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
  const { planLeague } = await import('../server/services/campaign/planner.js');
  const { toEntry } = await import('../server/services/campaign/view.js');
  const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
  const a = makeAdapter();
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }), env: ON });
  for (const nowWeeks of [sim([70, 72, 60, 72]), weeks.map(week => ({ week, samples: [] }))]) {
    const side = F.sidePanelFeasibility({ objective: title, nowWeeks, plans: [], roster: [], currentWeek: 3, env: ON,
      espn: { now: ctx.forTeam(5) } });
    const entry = toEntry({ ...res, feasibility_points: side }, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
    assert.deepEqual(validateLeague(entry).errors, []);
    assert.equal(entry._run.feasibility_points_detail.scale_label, 'ESPN projected lineup points (10 starters)');
  }
});
