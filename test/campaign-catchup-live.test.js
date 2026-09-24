/**
 * CATCHUP-LIVE: the catch-up list and the speed curve read the live league state.
 *
 *   - sellers: managers under 5% title odds (out of contention) or checked out
 *     (activity.manager when its row exists, else the timing read), from the
 *     adapter's managers map, never a template
 *   - desperate moves: the best ranked plan through each seller, with the discount
 *     the plan's own price ladder finds
 *   - the speed curve: every lever (sequential, parallel, concede, package, all-in)
 *     priced on the planner's ranked paths; the deadline is a hard wall
 * Pure functions plus the planner on the made-up league (test/fixtures/campaign-league.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { sellersRead, desperateMoves, OUT_OF_CONTENTION } = await import('../server/services/campaign/catchup.js');
const { speedCurve, leverRoutes, parallelOutcomes, sequentialOutcomes, concededPlan, sideLevers, daysBy, CURVE_LEVERS }
  = await import('../server/services/campaign/speed.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { activityReads } = await import('../scripts/campaign/league-adapter.mjs');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const plan = (team, p, delta, extra = {}) => ({ p_complete: p, delta_final: delta, expected: p * delta, chained: false,
  steps: [{ team, give: [1], get: [team * 10], p, delta }], ...extra });

/* ------------------------------------------------------------ sellers */

test('sellers: out of contention under 5% title odds, checked out from the activity read, unknown odds never count', () => {
  assert.equal(OUT_OF_CONTENTION, 0.05);
  const managers = new Map([
    ['2', { title_now: 0.049 }],
    ['3', { title_now: 0.051 }],
    ['4', { title_now: null, checked_out: true, checked_out_source: 'activity.manager', p_checked_out: 0.82 }],
    ['5', { title_now: 0.001, blocked: true }],
    ['6', { title_now: undefined }],
  ]);
  const s = sellersRead(managers);
  assert.deepEqual(s.map(x => x.team), ['2', '4']);
  assert.equal(s[0].out_of_contention, true);
  assert.match(s[0].why[0], /4\.9%/);
  assert.equal(s[1].checked_out, true);
  assert.match(s[1].why[0], /activity\.manager: P 82%/);
});

test('desperate moves: the best plan through each seller, its discount on his own screen, unreached sellers kept apart', () => {
  const ranked = [plan(3, 0.4, 0.05), plan(2, 0.5, 0.02), plan(3, 0.6, 0.01)];
  const sellers = [{ team: '2', why: ['title odds 1.0%'], checked_out: false }, { team: '3', why: ['checked out (timing read)'], checked_out: true },
    { team: '9', why: ['title odds 0.0%'], checked_out: false }];
  // Nick gives player 1 (value 920); he gets 20 (value 1000, team 2) or 30 (value 800, team 3).
  const values = new Map([[1, 920], [20, 1000], [30, 800]]);
  const r = desperateMoves(ranked, sellers, { playerValue: id => values.get(id), pResponds: t => (t === '3' ? 0.05 : 0.5) });
  assert.deepEqual(r.items.map(x => x.team), ['3', '2', '9'], 'highest expected gain first, unreached sellers last');
  assert.equal(r.items[2].gain, null);
  assert.match(r.items[2].text, /no plan inside your sliders/);
  close(r.items[0].gain, 0.4 * 0.05);                       // the first ranked plan through team 3, not the later one
  assert.equal(r.items[0].discount_pct, 0);
  close(r.items[0].screen_pct, 15);
  assert.match(r.items[0].text, /market value or more/);
  assert.match(r.items[0].text, /answers 5% of the time/);
  close(r.items[1].discount_pct, 8);
  assert.match(r.items[1].text, /8% under his market screen, P\(yes\) 50%/);
  assert.deepEqual(r.unreached.map(s => s.team), ['9']);
  assert.equal(desperateMoves(ranked, sellers.slice(0, 1)).items[0].discount_pct, null, 'no values, no discount claimed');
  assert.equal(desperateMoves(ranked, sellers, { limit: 1 }).items.length, 2, 'limit applies to each group');
});

/* ------------------------------------------------------------ speed levers */

test('sequential route: one partner at a time on the clock, a repeat partner is skipped', () => {
  const ranked = [plan(2, 0.5, 0.04), plan(2, 0.9, 0.03), plan(3, 0.5, 0.02)];
  const r = sequentialOutcomes(ranked, 4, { daysPerStep: 2 });
  assert.equal(r.rounds, 2);
  close(r.outs[0].prob, 0.5); close(r.outs[1].prob, 0.25);
  assert.equal(String(r.outs[1].plan.steps[0].team), '3');
  assert.equal(sequentialOutcomes(ranked, 1, { daysPerStep: 2 }).outs.length, 0, 'nothing fits one day');
});

test('parallel lever: the best yes wins among different managers, then the rest runs in the time left', () => {
  const ranked = [plan(2, 0.5, 0.04), plan(3, 0.5, 0.02), plan(4, 0.5, 0.01)];
  const r = parallelOutcomes(ranked, 2, { daysPerStep: 2, k: 2 });
  assert.equal(r.parallel, 2);
  close(r.outs[0].prob, 0.5); close(r.outs[1].prob, 0.25);   // team 3 counts only when team 2 says no
  assert.equal(r.outs.length, 2, 'no time left for team 4');
  assert.equal(parallelOutcomes([plan(2, 0.5, 0.04)], 10, { daysPerStep: 2 }), null, 'one plan is not a parallel round');
});

test('concede lever: the walk-away price from the ladder raises P(yes) and lowers the gain', () => {
  const p = plan(2, 0.3, 0.05);
  const c = concededPlan(p, { walk_away: { give: [1, 7], p: 0.6, delta: 0.035 } });
  close(c.p_complete, 0.6); close(c.delta_final, 0.035);
  assert.deepEqual(c.steps[0].give, [1, 7]);
  assert.equal(concededPlan(p, { walk_away: { give: [1], p: 0.2, delta: 0.06 } }), null, 'a cheaper walk-away is no concession');
  assert.equal(concededPlan(p, null), null);
});

test('speed curve: every lever priced on the ranked paths, the winner per week, cost vs the unhurried route, the deadline a wall', () => {
  const ranked = [plan(2, 0.3, 0.06), plan(3, 0.4, 0.03), plan(4, 0.5, 0.02),
    { ...plan(5, 0.35, 0.05), steps: [{ team: 5, give: [1, 2], get: [50], p: 0.35, delta: 0.05 }] }];
  const conceded = concededPlan(ranked[0], { walk_away: { give: [1, 3], p: 0.7, delta: 0.045 } });
  const clock = { currentWeek: 4, deadlineWeek: 6, daysLeftInWeek: 2, daysPerStep: 2 };
  const curve = speedCurve({ ranked, conceded, allIn: null }, clock);
  assert.deepEqual(curve.map(c => c.arrive_by), [4, 5, 6]);
  assert.ok(curve.every(c => c.before_deadline));
  // Week 4 has one 2-day round: sequential lands the top plan 30% of the time; parallel sends three at once.
  const w4 = curve[0];
  const byLever = Object.fromEntries(w4.levers.map(l => [l.lever, l]));
  close(byLever.sequential.p_land, 0.3);
  close(byLever.parallel.p_land, 1 - 0.7 * 0.6 * 0.5);
  close(byLever.concede.p_land, 0.7);
  assert.ok(byLever.package, 'the 2-for-1 plan is priced');
  assert.equal(w4.lever, w4.levers.reduce((a, b) => (b.expected > a.expected ? b : a)).lever, 'week 4 has no earlier week to carry');
  // Cost falls (or holds) as the arrive-by week moves toward the deadline; never below 0 at the deadline.
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i].cost <= curve[i - 1].cost + 1e-12);
  assert.ok(curve[curve.length - 1].cost <= 1e-12);
  assert.ok(CURVE_LEVERS.includes(w4.lever));
  assert.equal(daysBy(3, clock), -1);
  // No deadline known: four weeks out, all marked before the (unknown) deadline.
  assert.equal(speedCurve({ ranked }, { currentWeek: 4, deadlineWeek: null }).length, 5);
});

test('all-in lever runs only when the all-in plan differs from the ranked head', () => {
  const ranked = [plan(2, 0.5, 0.02), plan(3, 0.1, 0.2)];
  const same = leverRoutes({ ranked, allIn: { ...ranked[0] } }, 10, { daysPerStep: 2 });
  assert.ok(!same.some(r => r.lever === 'all_in'));
  const diff = leverRoutes({ ranked, allIn: ranked[1] }, 10, { daysPerStep: 2 });
  assert.ok(diff.some(r => r.lever === 'all_in'));
});

test('side levers: waiver claims in points a game, wait-for-news with its option value', () => {
  const s = sideLevers({ free: [{ ppg_gain: 1.5 }, { ppg_gain: 0.4 }], waits: [{ flag: 'act' }, { flag: 'wait', days: 2, option_value: 0.006, option_value_basis: 'guess' }] });
  assert.deepEqual(s.map(x => x.lever), ['waiver', 'wait']);
  assert.match(s[0].text, /\+1\.5 pts a game/);
});

/* ------------------------------------------------------------ the planner, end to end */

test('planner: live sellers and the priced speed curve reach the served entry', () => {
  const a = makeAdapter({ managerExtra: { 3: { title_now: 0.02 }, 4: { checked_out: true, checked_out_source: 'timing read' } } });
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  assert.deepEqual(res.sellers.read.map(s => s.team).sort(), ['3', '4']);
  const desperate = res.catch_up.filter(c => c.kind === 'desperate');
  assert.ok(desperate.length >= 1);
  for (const d of desperate) assert.ok(['3', '4'].includes(d.team));
  // The old rule used 3%: a manager at 4% is out of contention now.
  const b = makeAdapter({ managerExtra: { 3: { title_now: 0.04 } } });
  const res2 = planLeague(b, { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  assert.deepEqual(res2.sellers.read.map(s => s.team), ['3']);
  assert.ok(res.speed.length >= 1);
  assert.ok(res.speed.every(s => Array.isArray(s.levers) && s.levers.length >= 1 && CURVE_LEVERS.includes(s.lever)));

  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
  assert.deepEqual(validateLeague(entry).errors ?? [], []);
  const served = entry.speed_curve.value[0];
  assert.ok(served.lever && served.p_land && Array.isArray(served.levers));
  const d = entry.catch_up.value.find(c => c.kind === 'desperate');
  assert.ok(d && d.partner && d.discount_pct);
});

/* ------------------------------------------------------------ adapter read */

test('adapter activity read: activity.manager rows win, the timing read is the labelled fallback', () => {
  const rows = [{ entity_id: '4:3', value: JSON.stringify({ state: 'checked_out', probs: { checked_out: 0.8 } }), lane: 'live' },
    { entity_id: '4:5', value: JSON.stringify({ state: 'engaged', probs: { checked_out: 0.05 } }), lane: 'live' }];
  const timing = new Map([['3', { read_state: 'present', actions_n: 3 }], ['6', { read_state: 'present', actions_n: 0 }], ['7', { read_state: 'absent' }]]);
  const r = activityReads(rows, timing, 4);
  assert.deepEqual(r.get('3'), { checked_out: true, source: 'activity.manager', p: 0.8, lane: 'live' });
  assert.equal(r.get('5').checked_out, false);
  assert.deepEqual(r.get('6'), { checked_out: true, source: 'timing read', p: null, lane: null });
  assert.equal(r.get('7'), undefined, 'no read, no claim');
});
