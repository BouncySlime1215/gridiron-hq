/**
 * M7-TIMING (PEOPLE-WIRING module 7): urgency windows on campaign steps.
 * server/services/campaign/urgency.js (pure) + its wiring through the planner and
 * the War Room view. Made-up four-team fixture (test/fixtures/campaign-league.mjs);
 * no DB, no chat corpus, no real league data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const U = await import('../server/services/campaign/urgency.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry, validateEntry } = await import('../server/services/campaign/view.js');

const NOW = Date.parse('2026-09-24T12:00:00Z');
const DAY = 864e5;
const game = (period, homeId, awayId, winner, hp = 100, ap = 90) =>
  ({ matchupPeriodId: period, winner, home: { teamId: homeId, totalPoints: hp }, away: { teamId: awayId, totalPoints: ap } });

const withEnv = (vars, fn) => {
  const keep = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(keep)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
};

test('flag: off by default, on by its own switch, on under preview with the preview label', () => {
  withEnv({ [U.M7_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => {
    assert.deepEqual(U.m7Timing(), { on: false, preview: false });
  });
  withEnv({ [U.M7_ENV]: '1', GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => {
    assert.deepEqual(U.m7Timing(), { on: true, preview: false });
  });
  withEnv({ [U.M7_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => {
    assert.deepEqual(U.m7Timing(), { on: true, preview: true });
  });
});

test('loss streak counts consecutive decided losses from the latest game back', () => {
  const sched = [
    game(1, 2, 3, 'HOME'), // team 2 won
    game(2, 4, 2, 'HOME'), // team 2 lost (away)
    game(3, 2, 3, 'AWAY'), // team 2 lost (home)
    game(4, 2, 4, 'UNDECIDED'),
  ];
  assert.deepEqual(U.lossStreak(sched, '2'), { n: 2, through_period: 3 });
  assert.deepEqual(U.lossStreak(sched, '3'), { n: 0, through_period: 3 });
  assert.equal(U.lossStreak([], '2'), null, 'no decided games is unknown, not a zero streak');
});

test("'need a move' matcher: trade-move talk counts, position asks and other chatter do not", () => {
  for (const t of ['I need to make a move', 'gotta make a trade this week', 'need a trade bad', 'open to offers on anyone', 'who wants to trade']) {
    assert.equal(U.isNeedMove(t), true, t);
  }
  for (const t of ['need a QB for my kid team', 'nice move lol', 'I need a beer', 'trade deadline is when?', null]) {
    assert.equal(U.isNeedMove(t), false, String(t));
  }
});

test('managerUrgency reads his starters: injured starter, bye crunch now/next week', () => {
  const players = new Map([
    [1, { id: 1, name: 'A', injury: 1, bye: 9 }],
    [2, { id: 2, name: 'B', injury: 0, bye: 5 }],
    [3, { id: 3, name: 'C', injury: 0, bye: 5 }],
    [4, { id: 4, name: 'D', injury: 1, bye: 7 }], // bench: an injured bench player is not a spike
  ]);
  const u = U.managerUrgency({ roster: [1, 2, 3, 4], starters: new Set([1, 2, 3]), players,
    schedule: [game(3, 2, 3, 'AWAY'), game(2, 2, 4, 'AWAY')], team: '2', week: 4, needMove: 0 });
  assert.equal(u.inputs.starters_out.value, 1);
  assert.equal(u.inputs.loss_streak.value, 2);
  assert.equal(u.inputs.bye_crunch.value, 0);
  assert.equal(u.inputs.bye_crunch_next.value, 2);
  assert.equal(u.spike, true);
  assert.deepEqual(u.triggers.map(t => t.kind).sort(), ['loss_streak', 'starter_injured']);
  assert.ok(u.triggers.every(t => t.why && Number.isFinite(t.value)));
  assert.equal(u.upcoming[0].kind, 'bye_crunch');
});

test('missing inputs are typed unknown, never a quiet zero', () => {
  const u = U.managerUrgency({ roster: [], starters: new Set(), players: new Map(), schedule: null, team: '2', week: null, needMove: null });
  assert.equal(u.spike, false);
  assert.deepEqual(u.unknown.sort(), ['bye_crunch', 'loss_streak', 'need_move', 'starter_injured']);
});

test('sendWhen: spike -> now; bye crunch next week -> wait N days; recent decline still wins', () => {
  const base = { when: 'now', until: null, n: 3, fitted: false, why: 'he decides in about 5 hours (3 decided offers)' };
  const spike = U.urgencyRead({ starters_out: 0, loss_streak: 3, need_move: 0, bye_crunch: 0, bye_crunch_next: 0 });
  const s = U.sendWhen(base, spike, { now: NOW, daysLeftInWeek: 3 });
  assert.equal(s.when, 'now');
  assert.equal(s.days, 0);
  assert.match(s.why, /lost 3 straight/);
  assert.equal(s.source, 'm7');

  const next = U.urgencyRead({ starters_out: 0, loss_streak: 0, need_move: 0, bye_crunch: 0, bye_crunch_next: 2 });
  const w = U.sendWhen(base, next, { now: NOW, daysLeftInWeek: 3 });
  assert.equal(w.when, 'wait');
  assert.equal(w.days, 3);
  assert.equal(w.until, new Date(NOW + 3 * DAY).toISOString());
  assert.match(w.why, /2 starters on bye next week/);

  const declined = { when: 'wait', until: new Date(NOW + DAY).toISOString(), n: 3, fitted: false, why: 'he declined your last offer 23 hours ago' };
  const d = U.sendWhen(declined, spike, { now: NOW, daysLeftInWeek: 3 });
  assert.equal(d.when, 'wait', 'a recent decline outranks an urgency window');
  assert.equal(d.days, 1);
  assert.match(d.why, /declined/);

  const calm = U.urgencyRead({ starters_out: 0, loss_streak: 1, need_move: 0, bye_crunch: 0, bye_crunch_next: 0 });
  const c = U.sendWhen(base, calm, { now: NOW, daysLeftInWeek: 3 });
  assert.equal(c.when, 'now');
  assert.match(c.why, /no urgency spike/);
});

test("'need a move' count in the last 7 days is a trigger", () => {
  const r = U.urgencyRead({ starters_out: 0, loss_streak: 0, need_move: 2, bye_crunch: 0, bye_crunch_next: 0 });
  assert.equal(r.spike, true);
  assert.match(r.triggers[0].why, /2 'need a move' messages/);
});

test('gradeM7: P(trade within 7 days | spike) vs baseline, thin under n', () => {
  const trades = [{ at: NOW + 2 * DAY, parties: new Set(['2', '3']) }, { at: NOW + 40 * DAY, parties: new Set(['4', '5']) }];
  const spikes = [{ team: '2', at: NOW }, { team: '4', at: NOW }];
  const baseline = [{ team: '2', at: NOW - 30 * DAY }, { team: '3', at: NOW - 30 * DAY }, { team: '4', at: NOW - 30 * DAY }, { team: '5', at: NOW }];
  const g = U.gradeM7({ spikes, baseline, trades });
  assert.equal(g.spike.n, 2);
  assert.equal(g.spike.k, 1);
  assert.equal(g.baseline.n, 4);
  assert.equal(g.baseline.k, 0);
  assert.equal(g.verdict, 'thin');
  assert.ok(g.spike.ci[0] <= g.spike.p && g.spike.p <= g.spike.ci[1]);
});

test('planner: flag off leaves send_when exactly as the adapter set it', () => {
  withEnv({ [U.M7_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => {
    const a = makeAdapter();
    const res = planLeague(a, { objective: normaliseObjective({}) });
    assert.ok(res.playbook.length);
    assert.equal(res.playbook[0].send_when.source, undefined);
    assert.ok(!res.catch_up.some(c => c.kind === 'timing' && /urgency window/.test(c.text)));
  });
});

test('planner + view: a spiking partner gets send now with the reason, labelled preview, contract holds', () => {
  const a = makeAdapter();
  for (const m of a.managers.values()) {
    m.urgency = U.urgencyRead({ starters_out: 2, loss_streak: 0, need_move: 0, bye_crunch: 0, bye_crunch_next: 0 });
    m.send_when = U.sendWhen(m.send_when, m.urgency, { now: NOW, daysLeftInWeek: 3, preview: true });
  }
  const res = planLeague(a, { objective: normaliseObjective({}) });
  const sw = res.playbook[0].send_when;
  assert.equal(sw.when, 'now');
  assert.match(sw.why, /2 of his starters are injured/);
  assert.ok(res.catch_up.some(c => c.kind === 'timing' && /urgency window/.test(c.text)));
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T12:00:00Z' });
  assert.deepEqual(validateEntry(entry), []);
  const text = entry.view.next_move.value.send_when;
  assert.match(text, /^Preview \(unconfirmed forward\): now: /);
});

test('view: a wait carries its day count', () => {
  const a = makeAdapter();
  for (const m of a.managers.values()) {
    m.urgency = U.urgencyRead({ starters_out: 0, loss_streak: 0, need_move: 0, bye_crunch: 0, bye_crunch_next: 3 });
    m.send_when = U.sendWhen(m.send_when, m.urgency, { now: NOW, daysLeftInWeek: 2 });
  }
  const res = planLeague(a, { objective: normaliseObjective({}) });
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T12:00:00Z' });
  assert.match(entry.view.next_move.value.send_when, /^wait 2 days \(until 2026-09-26T12:00:00\.000Z\): /);
});
