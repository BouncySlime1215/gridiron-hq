/**
 * STOPS-01: bye and injury stops with the priced trade-off.
 * Pre-registration: docs/tdd/2026-09-25-stops-01.tdd.md (S1-S6) and the PR body.
 * Made-up leagues only (test/fixtures/campaign-league.mjs and synthetic weekly samples); no DB, no simulation.
 * The week-11 cluster below is a synthetic team -> bye map; the real one is checked locally (PR "Needs local measurement").
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { STOPS_ENV, HOLE_MIN_PTS, stopsMode, findHoles, priceHoles, holeStop, byeClusters } = await import('../server/services/campaign/stops.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague, tradeoffKey, TRADEOFF_KEY } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter, makePlayers } = await import('./fixtures/campaign-league.mjs');

/* ------------------------------------------------------------ S1 the flag */

test('S1 flag: 1 serves, shadow computes only, unset is off even under preview', () => {
  assert.equal(stopsMode({ [STOPS_ENV]: '1' }), 'on');
  assert.equal(stopsMode({ [STOPS_ENV]: 'shadow' }), 'shadow');
  assert.equal(stopsMode({}), 'off');
  assert.equal(stopsMode({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), 'off');
  assert.equal(stopsMode({ [STOPS_ENV]: '0', GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), 'off');
});

/* ----------------------------------------------------- S2 finding holes */

// Deterministic paired noise: run r in week w gets the same wobble on every roster.
const wob = (w, r) => (((w * 7919 + r * 104729) % 2000) / 100) - 10;
const weeksOf = (fn, from = 4, to = 14, runs = 400) => Array.from({ length: to - from + 1 }, (_, i) => {
  const week = from + i;
  return { week, samples: Array.from({ length: runs }, (_, r) => fn(week) + wob(week, r)) };
});
const ROSTER = [
  { id: 1, name: 'QB One', starter: true, bye: 9, injury: 0 },
  { id: 2, name: 'RB Two', starter: true, bye: 11, injury: 0 },
  { id: 3, name: 'WR Three', starter: true, bye: 11, injury: 0 },
  { id: 4, name: 'WR Four', starter: true, bye: 6, injury: 1 },
  { id: 9, name: 'Bench Nine', starter: false, bye: 7, injury: 0 },
];

test('S2 holes: a week well under the median with starters on bye is a bye hole naming them', () => {
  const weeks = weeksOf(w => (w === 11 ? 100 : w === 9 ? 112 : 120));
  const holes = findHoles({ weeks, roster: ROSTER, currentWeek: 4 });
  assert.equal(holes[0].week, 11);
  assert.equal(holes[0].kind, 'bye');
  assert.deepEqual(holes[0].players, ['2', '3']);
  assert.ok(Math.abs(holes[0].drop - 20) < 1, `drop ${holes[0].drop}`);
  assert.equal(holes[1].week, 9, 'the 8-point week-9 QB bye is a hole too, second');
  assert.equal(holes.length, 2);
});

test('S2 holes: an unexplained dip, a bench bye, a dip under the bar and past weeks are not stops', () => {
  const weeks = weeksOf(w => (w === 8 ? 100 : w === 7 ? 100 : w === 9 ? 120 - (HOLE_MIN_PTS - 1) : w === 5 ? 90 : 120));
  const holes = findHoles({ weeks, roster: ROSTER.map(p => ({ ...p, injury: 0 })), currentWeek: 6 });
  assert.deepEqual(holes, [], JSON.stringify(holes));
});

test('S2 holes: a dip with an injured starter (no bye that week) is an injury hole', () => {
  const weeks = weeksOf(w => (w === 7 ? 108 : 120));
  const holes = findHoles({ weeks, roster: ROSTER, currentWeek: 4 });
  assert.equal(holes.length, 1);
  assert.equal(holes[0].kind, 'injury');
  assert.deepEqual(holes[0].players, ['4']);
});

test('S2 holes: stop keys follow the Coach tradeoffKey grammar', () => {
  const bye = holeStop({ kind: 'bye', week: 11 }), hurt = holeStop({ kind: 'injury', week: 7 });
  assert.equal(tradeoffKey({ type: 'add_stop', stop: bye }), 'add:cover_bye:11');
  assert.equal(tradeoffKey({ type: 'add_stop', stop: hurt }), 'add:custom:cover the week 7 injury hole');
  for (const s of [bye, hurt]) assert.ok(TRADEOFF_KEY.test(tradeoffKey({ type: 'add_stop', stop: s })));
});

/* ------------------------------------------------------ S3 pricing holes */

const plan = (score, lift11, steps = 1) => ({ score, expected: score, expected_se: 0.001, lift11, chained: steps > 1,
  steps: Array.from({ length: steps }, (_, i) => ({ team: String(2 + i), give: [10 + i], get: [20 + i] })) });

test('S3 pricing: the best-ranked plan that fills half the hole and lands in time is the cover; cost is the score gap', () => {
  const now = weeksOf(w => (w === 11 ? 100 : 120));
  const hole = findHoles({ weeks: now, roster: ROSTER, currentWeek: 4 })[0];
  const ranked = [plan(0.030, 2), plan(0.025, 15, 20), plan(0.020, 12), plan(0.010, 18)];
  const weeklyOf = p => weeksOf(w => (w === 11 ? 100 + p.lift11 : 120));
  const [row] = priceHoles({ holes: [hole], ranked, nowWeeks: now, weeklyOf, currentWeek: 4, daysLeftInWeek: 3 });
  assert.equal(row.status, 'ok');
  // ranked[1] fills 15 but its 20 chained steps land long after week 11; ranked[2] is the cover.
  assert.equal(row.cover.score, 0.020);
  assert.ok(Math.abs(row.cost - 0.010) < 1e-12);
  assert.ok(Math.abs(row.net + 0.010) < 1e-12);
  assert.equal(row.verdict, 'not_worth_it');
  assert.ok(Math.abs(row.cover.lift - 12) < 1e-9);
  assert.match(row.gain_text, /^Week 11 lineup: \+12\.0 pts on this path, against a 20\.0-point hole\.$/);
  assert.match(row.because, /^player 2, player 3 on bye; the detour costs more than the stop gains$/);
});

test('S3 pricing: when the best plan already covers, the stop costs 0 and is worth it', () => {
  const now = weeksOf(w => (w === 11 ? 100 : 120));
  const hole = findHoles({ weeks: now, roster: ROSTER, currentWeek: 4 })[0];
  const [row] = priceHoles({ holes: [hole], ranked: [plan(0.03, 11)], nowWeeks: now, currentWeek: 4,
    weeklyOf: p => weeksOf(w => (w === 11 ? 100 + p.lift11 : 120)) });
  assert.equal(row.cost, 0);
  assert.equal(row.verdict, 'close', 'net 0 sits inside the noise');
  assert.equal(row.new_next_move_changes, false);
});

test('S3 pricing: no plan fills the hole -> unreachable with the reason, never a made-up cost', () => {
  const now = weeksOf(w => (w === 11 ? 100 : 120));
  const hole = findHoles({ weeks: now, roster: ROSTER, currentWeek: 4 })[0];
  const [row] = priceHoles({ holes: [hole], ranked: [plan(0.03, 3), plan(0.02, 4)], nowWeeks: now, currentWeek: 4,
    weeklyOf: p => weeksOf(w => (w === 11 ? 100 + p.lift11 : 120)) });
  assert.equal(row.status, 'unreachable');
  assert.equal(row.cost, undefined);
  assert.match(row.because, /no searched path fills this week inside your rules/);
});

test("S3 pricing: a plan that gives a blocked id (untouchable, 160/80/277) is never the cover, even when ranked", () => {
  const now = weeksOf(w => (w === 11 ? 100 : 120));
  const hole = findHoles({ weeks: now, roster: ROSTER, currentWeek: 4 })[0];
  const bad = { ...plan(0.03, 15), steps: [{ team: '2', give: [160], get: [21] }] };
  const ok = plan(0.02, 12);
  const [row] = priceHoles({ holes: [hole], ranked: [bad, ok], nowWeeks: now, currentWeek: 4, blocked: new Set(['160', '80', '277']),
    weeklyOf: p => weeksOf(w => (w === 11 ? 100 + p.lift11 : 120)) });
  assert.equal(row.cover.score, 0.02);
  assert.deepEqual(row.cover.give, ['10']);
});

test('S3 pricing: covers come only from the ranked (rule-filtered) list', () => {
  const now = weeksOf(w => (w === 11 ? 100 : 120));
  const hole = findHoles({ weeks: now, roster: ROSTER, currentWeek: 4 })[0];
  const [row] = priceHoles({ holes: [hole], ranked: [], nowWeeks: now, currentWeek: 4, weeklyOf: () => { throw new Error('not called'); } });
  assert.equal(row.status, 'unreachable');
});

/* -------------------------------------------------- S4 the week-11 cluster */

test('S4 bye clusters: week -> teams, sorted; the six-team week reads as one cluster', () => {
  const byeWeek = new Map([['SEA', 11], ['ATL', 11], ['NE', 11], ['KC', 6], ['GB', 11], ['LAR', 11], ['CLE', 11], ['DAL', 10], ['XXX', null]]);
  const c = byeClusters(byeWeek);
  assert.deepEqual([...c.keys()], [6, 10, 11]);
  assert.deepEqual(c.get(11), ['ATL', 'CLE', 'GB', 'LAR', 'NE', 'SEA']);
});

/* -------------------------------------- S5 wiring: planner + view + schema */

// P2 (a starting RB, power 15) is on bye in week 6 of the made-up league.
const byeLeague = () => {
  const players = makePlayers();
  players.set(2, { ...players.get(2), bye: 6 });
  return makeAdapter({ players });
};
const names = a => a.names();
const run = (env, objective = {}) => {
  const a = byeLeague();
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced', ...objective }), env });
  return { res, entry: toEntry(res, { names: names(a), as_of: '2026-09-25T00:00:00Z' }) };
};

test('S5 off (default): no stops computed, the entry is byte-for-byte the incumbent', () => {
  const off = run({}), zero = run({ [STOPS_ENV]: '0' });
  assert.equal(off.res.stops, undefined);
  assert.equal(off.entry._run.inputs.stops, undefined);
  const strip = e => JSON.stringify({ ...e, _run: { ...e._run, runtime_ms: 0, phases_ms: {} } });
  assert.equal(strip(off.entry), strip(zero.entry));
});

test('S5 shadow: holes and priced rows go to _run.inputs.stops only; stop_tradeoffs is unchanged', () => {
  const off = run({}), sh = run({ [STOPS_ENV]: 'shadow' });
  const s = sh.entry._run.inputs.stops;
  assert.equal(s.mode, 'shadow');
  assert.ok(s.holes.some(h => h.week === 6 && h.kind === 'bye' && h.players.includes('2')), JSON.stringify(s.holes));
  assert.equal(s.rows.length, s.holes.length);
  assert.deepEqual(sh.entry.stop_tradeoffs, off.entry.stop_tradeoffs);
});

test('S5 on: every priced hole is served under its Coach key, the league passes its contract, unreachable ones are counted', () => {
  const { res, entry } = run({ [STOPS_ENV]: '1' });
  assert.deepEqual(validateLeague(entry), [], 'contract');
  const s = entry._run.inputs.stops;
  assert.equal(s.mode, 'on');
  assert.equal(s.priced + s.unreachable, s.holes.length);
  for (const r of res.stops.rows.filter(x => x.status === 'ok')) {
    const key = tradeoffKey({ type: 'add_stop', stop: r.stop });
    assert.equal(entry.stop_tradeoffs.status, 'ok');
    assert.equal(entry.stop_tradeoffs.value[key].stop_label, r.stop_label);
    assert.ok(Number.isFinite(entry.stop_tradeoffs.value[key].cost.value));
  }
});

/* ------------------------------------------------------- S6 Nick's rules */

test("S6 rules: with the bye starter untouchable, no served cover gives him or any blocked id", () => {
  const a = byeLeague();
  a.untouchable = new Set(['2', '3']);
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }), env: { [STOPS_ENV]: '1' } });
  assert.ok(res.stops.holes.some(h => h.week === 6), 'the week-6 hole is still found');
  for (const r of res.stops.rows.filter(x => x.status === 'ok')) {
    assert.ok(!r.cover.give.some(id => ['2', '3'].includes(id)), JSON.stringify(r.cover));
  }
});
