/**
 * TM-34 DEADLINE MODE: countdown, send_by, last-call offers, hold list, who goes quiet, cost of waiting.
 * Pre-registration: docs/tdd/2026-09-25-tm-34-deadline.tdd.md (D1-D8) and the PR body.
 * Made-up leagues only (test/fixtures/campaign-league.mjs and synthetic paths); no DB, no simulation.
 * League 4's real clock numbers (deadline ms, review hours) are the ONE-PLAN spot-check values.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  DEADLINE_ENV, HIS_WINDOW_HOURS, QUIET_DAYS, deadlineMode, deadlineClock, stepSendBy, lastCall, holdList, quietRead,
  waitValue, breaksRules,
} = await import('../server/services/campaign/deadline-mode.js');
const { PINNED_NEVER_GIVE, PINNED_NEVER_GET } = await import('../server/services/campaign/never-give.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

const DEADLINE_MS = 1796230800000; // league 4 deadlineDate, ONE-PLAN spot-check 8
const LAST_SEND = '2026-11-30T17:00:00.000Z';
const DAY = 864e5;
const at = s => Date.parse(s);

/* ------------------------------------------------------------ D1 the flag */

test('D1 flag: 1 and shadow compute (shadow only), unset or anything else is off, even under preview', () => {
  assert.equal(deadlineMode({ [DEADLINE_ENV]: '1' }), 'shadow');
  assert.equal(deadlineMode({ [DEADLINE_ENV]: 'shadow' }), 'shadow');
  assert.equal(deadlineMode({}), 'off');
  assert.equal(deadlineMode({ [DEADLINE_ENV]: '0' }), 'off');
  assert.equal(deadlineMode({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), 'off');
});

/* ------------------------------------------------------------ D2 the clock */

test('D2 clock: league 4 deadline Wed 12/02 17:00 UTC, last real send Mon 11/30 17:00 UTC', () => {
  const c = deadlineClock({ deadlineAt: DEADLINE_MS, now: at('2026-09-25T18:00:00Z'), reviewHours: 24 });
  assert.equal(c.status, 'ok');
  assert.equal(c.deadline_at, '2026-12-02T17:00:00.000Z');
  assert.equal(c.last_send_at, LAST_SEND);
  assert.equal(c.buffer_hours, 24 + HIS_WINDOW_HOURS);
  assert.equal(c.review_basis, 'league settings');
  assert.equal(c.phase, 'normal');
  assert.ok(Math.abs(c.days_to_deadline - 67.96) < 0.1, String(c.days_to_deadline));
});

test('D2 clock phases: normal -> deadline -> last_call -> closed -> past', () => {
  const ph = s => deadlineClock({ deadlineAt: DEADLINE_MS, now: at(s), reviewHours: 24 }).phase;
  assert.equal(ph('2026-11-17T00:00:00Z'), 'normal');
  assert.equal(ph('2026-11-20T00:00:00Z'), 'deadline');    // 12.7 days to the deadline, 10.7 to the last send
  assert.equal(ph('2026-11-24T00:00:00Z'), 'last_call');   // 6.7 days to the last send
  assert.equal(ph('2026-12-01T00:00:00Z'), 'closed');      // past the last send, before the deadline
  assert.equal(ph('2026-12-02T17:00:00Z'), 'past');
});

test('D2 clock: no deadline is unknown with a reason; no review hours uses the stated default', () => {
  const u = deadlineClock({ deadlineAt: null, now: 0 });
  assert.equal(u.status, 'unknown');
  assert.match(u.reason, /no trade deadline/);
  const d = deadlineClock({ deadlineAt: '2026-12-02T17:00:00Z', now: at('2026-09-25T00:00:00Z') });
  assert.equal(d.last_send_at, LAST_SEND);
  assert.match(d.review_basis, /default 24 h/);
});

/* -------------------------------------------------------- D3 send_by per step */

const clockAt = s => deadlineClock({ deadlineAt: DEADLINE_MS, now: at(s), reviewHours: 24 });
const step = (team, give, get) => ({ team, give, get });

test('D3 send_by: independent steps all go by the last send; a chained path leaves 2 days per later leg', () => {
  const c = clockAt('2026-11-20T00:00:00Z');
  const indep = stepSendBy({ chained: false, steps: [step('2', [4], [11]), step('3', [7], [21])] }, c);
  assert.deepEqual(indep.map(x => x.send_by), [LAST_SEND, LAST_SEND]);
  const chain = stepSendBy({ chained: true, steps: [step('3', [4], [21]), step('2', [21], [11]), step('4', [7], [31])] }, c);
  assert.deepEqual(chain.map(x => x.send_by), ['2026-11-26T17:00:00.000Z', '2026-11-28T17:00:00.000Z', LAST_SEND]);
  assert.ok(chain.every(x => at(x.send_by) <= at(LAST_SEND) && !x.too_late));
  const late = stepSendBy({ chained: true, steps: [step('3', [4], [21]), step('2', [21], [11]), step('4', [7], [31])] },
    clockAt('2026-11-27T00:00:00Z'));
  assert.deepEqual(late.map(x => x.too_late), [true, false, false]);
});

/* ------------------------------------------------ D4 last call, Nick's rules */

const plan = (steps, expected, extra = {}) => ({ steps, expected, p_complete: 0.4, delta_final: expected / 0.4, chained: false, ...extra });

test("D4 last call: one per reachable partner, never an excluded one, never a rule-breaking or too-late path", () => {
  const c = clockAt('2026-11-27T00:00:00Z'); // 3.7 days to the last send: a 3-leg chain is too late
  const never = PINNED_NEVER_GIVE[0], olave = PINNED_NEVER_GET[0];
  const blocked = new Set([never, olave]);
  const ranked = [
    plan([step('2', [never], [11])], 0.05),                                      // gives a never-give id
    plan([step('2', [4], [olave])], 0.04),                                       // gets a never-get id
    plan([step('2', [4], [21]), step('3', [21], [11]), step('4', [7], [31])], 0.03, { chained: true }), // too late
    plan([step('2', [4], [12])], 0.02),                                          // the pick for roster 2
    plan([step('3', [7], [22])], 0.01),
    plan([step('4', [5], [33])], 0.03),
  ];
  const rows = lastCall({ ranked, clock: c, blocked,
    partners: [{ team: '2', excluded: false }, { team: '3', excluded: false }, { team: '4', excluded: true }, { team: '5', excluded: false }] });
  assert.equal(rows.find(r => r.team === '4'), undefined, 'an excluded manager never gets a last call');
  const r2 = rows.find(r => r.team === '2');
  assert.equal(r2.status, 'ok');
  assert.deepEqual([r2.give, r2.get], [['4'], ['12']]);
  assert.equal(r2.rule_dropped, 2);
  assert.equal(r2.too_late, 1);
  assert.equal(rows.find(r => r.team === '5').status, 'none');
  for (const r of rows.filter(x => x.status === 'ok')) {
    assert.ok(!breaksRules(r.plan, blocked), JSON.stringify(r.give));
    assert.ok(r.send_by_steps.every(s => at(s) <= at(LAST_SEND) && at(s) >= c.now_ms));
  }
  assert.deepEqual(rows.map(r => r.team), ['2', '3', '5'], 'offers first, best first');
});

/* --------------------------------------------------------------- D5 hold */

test('D5 hold: rule-blocked players are held even if a path sells them; players a good offer sells are not', () => {
  const offers = [{ status: 'ok', expected: 0.02, give: ['4', '160'] }, { status: 'ok', expected: -0.01, give: ['7'] }];
  const hold = holdList({ roster: [160, 4, 5, 7], blocked: new Set(['160']), offers });
  assert.deepEqual(hold, [
    { player: '160', reason: 'rule' }, { player: '5', reason: 'no_deal_beats_keeping' }, { player: '7', reason: 'no_deal_beats_keeping' },
  ]);
});

/* -------------------------------------------------------------- D6 quiet */

test('D6 quiet: checked out or no own move in QUIET_DAYS is quiet; no record is unknown, never active', () => {
  const now = at('2026-11-20T00:00:00Z');
  const m = new Map([
    ['2', { last_action_at: '2026-11-18T00:00:00Z' }],
    ['3', { last_action_at: new Date(now - (QUIET_DAYS + 1) * DAY).toISOString() }],
    ['4', { checked_out: true, checked_out_source: 'activity.manager', p_checked_out: 0.8, last_action_at: '2026-11-19T00:00:00Z' }],
    ['5', {}],
    ['6', { blocked: true }],
  ]);
  const q = quietRead(m, { now, excluded: x => !!x.blocked });
  assert.deepEqual(q.map(r => [r.team, r.status]), [['2', 'active'], ['3', 'quiet'], ['4', 'quiet'], ['5', 'unknown']]);
  assert.equal(q.find(r => r.team === '4').p_checked_out, 0.8);
  assert.equal(q.find(r => r.team === '2').days_since_action, 2);
});

/* ---------------------------------------------------- D7 cost of waiting */

test('D7 wait: waiting costs landing value while rounds remain; with one round left it costs nothing; option value is 0, labelled', () => {
  // Five partners: one round reaches at most PARALLEL_MAX (3) of them, so later rounds carry value.
  const ranked = ['2', '3', '4', '5', '6'].map((t, i) => plan([step(t, [4 + i], [11 + i])], 0.02 - i * 0.002));
  const early = waitValue({ ranked, clock: clockAt('2026-11-10T00:00:00Z'), currentWeek: 10 });
  assert.equal(early.status, 'ok');
  assert.ok(early.wait_cost > 0, JSON.stringify(early));
  assert.equal(early.verdict, 'send_now');
  assert.equal(early.option_value, 0);
  assert.match(early.option_value_basis, /IDEA-151/);
  const late = waitValue({ ranked, clock: clockAt('2026-11-27T00:00:00Z'), currentWeek: 12 }); // 3.7 days: one round
  assert.equal(late.rounds_now, 1);
  assert.equal(late.wait_cost, 0);
  assert.equal(late.verdict, 'no_cost_to_wait');
  const gone = waitValue({ ranked, clock: clockAt('2026-11-29T12:00:00Z'), currentWeek: 12 });
  assert.equal(gone.status, 'unknown');
  assert.match(gone.reason, /less than one negotiation round/);
  const three = waitValue({ ranked: ranked.slice(0, 3), clock: clockAt('2026-11-10T00:00:00Z'), currentWeek: 10 });
  assert.equal(three.wait_cost, 0, 'three partners all fit in one parallel round: waiting costs nothing on this model');
  assert.equal(waitValue({ ranked: [], clock: clockAt('2026-11-10T00:00:00Z'), currentWeek: 10 }).status, 'unknown');
});

/* ------------------------------------------------- D8 planner + plans.json */

const run = (env, { now = '2026-11-24T00:00:00Z', tweak = a => a } = {}) => {
  const a = tweak(makeAdapter());
  a.league = { ...a.league, deadline_at: new Date(DEADLINE_MS).toISOString(), review_hours: 24 };
  a.managers.get('2').last_action_at = '2026-11-22T00:00:00Z';
  a.managers.get('3').last_action_at = '2026-11-01T00:00:00Z';
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }), env, now: at(now) });
  return { res, entry: toEntry(res, { names: a.names(), as_of: '2026-11-24T00:00:00Z' }) };
};
const strip = e => JSON.stringify({ ...e, _run: { ...e._run, runtime_ms: 0, phases_ms: {} } });

test('D8 off (default): nothing computed, the entry is byte-for-byte the incumbent', () => {
  const off = run({}), zero = run({ [DEADLINE_ENV]: '0' });
  assert.equal(off.res.deadline, undefined);
  assert.equal(off.entry._run.inputs.deadline_mode, undefined);
  assert.equal(strip(off.entry), strip(zero.entry));
});

test('D8 shadow: the report lands in _run.inputs only, served sections unchanged, contract passes, 0 steps after the last send', () => {
  const off = run({}), sh = run({ [DEADLINE_ENV]: 'shadow' });
  assert.deepEqual(validateLeague(sh.entry).errors, [], 'contract');
  const d = sh.entry._run.inputs.deadline_mode;
  assert.equal(d.mode, 'shadow');
  assert.equal(d.status, 'ok');
  assert.equal(d.clock.last_send_at, LAST_SEND);
  assert.equal(d.clock.phase, 'last_call');
  assert.equal(d.deck_steps, sh.res.deck.reduce((s, c) => s + c.plan.steps.length, 0));
  assert.ok(d.deck_steps > 0, 'the fixture serves a deck');
  assert.equal(d.deck_steps_after_last_send, 0);
  assert.ok(d.last_call.some(r => r.status === 'ok'), JSON.stringify(d.last_call));
  assert.equal(d.last_call.every(r => !('plan' in r)), true, 'no path objects in plans.json');
  assert.deepEqual(d.quiet.map(r => [r.team, r.status]), [['2', 'active'], ['3', 'quiet'], ['4', 'unknown']]);
  assert.equal(d.wait.status, 'ok');
  const served = e => { const { _run, ...rest } = e; return JSON.stringify(rest); };
  assert.equal(served(sh.entry), served(off.entry), 'no served number moves');
});

test("D8 rules: with Nick's starters untouchable, no last-call offer gives them and both are on the hold list as 'rule'", () => {
  const { res } = run({ [DEADLINE_ENV]: '1' }, { tweak: a => ({ ...a, untouchable: new Set(['2', '3']) }) });
  for (const r of res.deadline.last_call.filter(x => x.status === 'ok')) {
    assert.ok(!r.give.some(id => ['2', '3'].includes(id)), JSON.stringify(r.give));
  }
  const hold = new Map(res.deadline.hold.map(h => [h.player, h.reason]));
  assert.equal(hold.get('2'), 'rule');
  assert.equal(hold.get('3'), 'rule');
});

test('D8 no deadline in the league settings: shadow says unknown with the reason, nothing else is invented', () => {
  const a = makeAdapter();
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }), env: { [DEADLINE_ENV]: '1' }, now: at('2026-11-24T00:00:00Z') });
  const e = toEntry(res, { names: a.names(), as_of: '2026-11-24T00:00:00Z' });
  assert.deepEqual(e._run.inputs.deadline_mode, { mode: 'shadow', status: 'unknown', reason: 'no trade deadline in the league settings' });
});
