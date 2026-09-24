/**
 * CAMPAIGN-01 producer (scripts/campaign/produce-plans.mjs + server/services/campaign/*):
 * pure functions and the planner on a made-up four-team league (test/fixtures/campaign-league.mjs).
 * No DB, no simulation, no real league data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague, deckOf } = await import('../server/services/campaign/planner.js');
const { normaliseObjective, weeklySummary, pointsFeasibility, targetFeasibility } = await import('../server/services/campaign/objectives.js');
const { rankPlans, tolerancesFor, toleranceViolation, scorePlan } = await import('../server/services/campaign/modes.js');
const { pathExpectation, pathOutcomes } = await import('../server/services/campaign/paths.js');
const { orderCatchUp, CATCHUP_ORDER, freeMoves } = await import('../server/services/campaign/catchup.js');
const { confirmSeed, confirmVerdict } = await import('../server/services/campaign/confirm.js');
const { priceLadder, replyTable } = await import('../server/services/campaign/playbook.js');
const { chatLabels, skipWeights, planSkipWeight, pResponds } = await import('../server/services/campaign/partners.js');
const { diffNextMove } = await import('../server/services/campaign/replan.js');
const { rankAttention } = await import('../server/services/campaign/attention.js');
const { waitOrAct } = await import('../server/services/campaign/wait-or-act.js');
const { stopTradeOff, speedCurve, arrivalWeek } = await import('../server/services/campaign/itinerary.js');
const { toEntry, validateEntry, plansFile, SECTIONS } = await import('../server/services/campaign/view.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const run = (mode, opts = {}, obj = {}) => {
  const a = makeAdapter(opts);
  return { a, res: planLeague(a, { objective: normaliseObjective({ risk_mode: mode, ...obj }) }) };
};
const firstKey = res => JSON.stringify(res.best?.steps[0] && [res.best.steps[0].team, res.best.steps[0].give, res.best.steps[0].get]);

/* ------------------------------------------------------------ risk modes */

test('the risk mode changes the plan on the same dice', () => {
  const s = run('safe'), b = run('balanced'), f = run('all_in');
  // Same league state, same planning seed, same confirm seed: only the objective function differs.
  assert.deepEqual(s.a.worldsBuilt, b.a.worldsBuilt);
  assert.deepEqual(b.a.worldsBuilt, f.a.worldsBuilt);
  const keys = new Set([firstKey(s.res), firstKey(b.res), firstKey(f.res)]);
  assert.equal(keys.size, 3, `expected three different next moves, got ${[...keys].join(' | ')}`);
  // All-in chases the bigger landing (P(title) if it lands) at a lower expected gain than Balanced.
  assert.ok(f.res.best.delta_final > b.res.best.delta_final);
  assert.ok(f.res.best.expected < b.res.best.expected);
  // The same-dice comparison the risk-mode sheet shows has one row per mode, from one plan pool.
  assert.deepEqual(b.res.risk_modes.map(m => m.mode), ['safe', 'balanced', 'all_in']);
  assert.deepEqual(b.res.risk_modes, f.res.risk_modes);
});

test('mode scoring: safe penalises spread, all-in scores the landing, balanced the expectation', () => {
  const sure = { steps: [{ team: '2', give: [1], get: [9], p: 0.9, delta: 0.02, se: 0.001 }] };
  const shot = { steps: [{ team: '3', give: [1], get: [8], p: 0.1, delta: 0.30, se: 0.001 }] };
  const ctx = { originalIds: [1, 2, 3] };
  const best = mode => rankPlans([sure, shot], mode, tolerancesFor(mode), ctx).ranked[0].steps[0].team;
  assert.equal(best('safe'), '2');
  assert.equal(best('balanced'), '3');       // 0.03 expected beats 0.018
  assert.equal(best('all_in'), '3');
  const longShot = { steps: [{ team: '4', give: [1], get: [7], p: 0.02, delta: 0.9 }] };
  assert.equal(scorePlan(longShot, 'all_in').eligible, false, 'all-in still refuses a plan that almost never lands');
});

/* ------------------------------------------------------------ fatigue cap */

test('the offer-fatigue cap is respected: a manager at his weekly cap gets no step', () => {
  const free = run('balanced');
  const busy = free.res.best.steps[0].team;
  const capped = run('balanced', { sent: { [busy]: tolerancesFor('balanced').max_offers_per_manager_week } });
  for (const card of capped.res.deck) {
    assert.ok(card.plan.steps.every(s => s.team !== busy), `deck still offers Team ${busy}`);
  }
  assert.notEqual(capped.res.best.steps[0].team, busy);
});

test('fatigue counts offers already sent plus the plan\'s own offers to the same manager', () => {
  const plan = { steps: [{ team: '2', give: [1], get: [9], p: 0.5, delta: 0.01 }, { team: '2', give: [2], get: [8], p: 0.5, delta: 0.02 }] };
  const tol = tolerancesFor('balanced', { max_offers_per_manager_week: 2 });
  assert.equal(toleranceViolation(plan, tol, { originalIds: [1, 2], sentThisWeek: { 2: 0 } }), null);
  assert.match(toleranceViolation(plan, tol, { originalIds: [1, 2], sentThisWeek: { 2: 1 } }), /3 offers this week \(limit 2\)/);
  assert.match(toleranceViolation(plan, tolerancesFor('balanced', { max_assets: 1 }), { originalIds: [1, 2] }), /spends 2/);
  assert.match(toleranceViolation({ steps: [{ team: '2', give: [1], get: [9], p: 0.5, delta: -0.05 }] }, tol, { originalIds: [1] }), /below today/);
});

/* ------------------------------------------------------------ feasibility */

test('points feasibility: season-average hit rate, first week at target, cost, bye and injury warnings', () => {
  const now = [{ week: 5, samples: [100, 110, 120, 130] }, { week: 6, samples: [80, 90, 100, 110] }];
  const s = weeklySummary(now, 105);
  close(s.per_week[0].mean, 115); close(s.per_week[1].mean, 95);
  close(s.p_average_hits, 2 / 4);           // run averages 90, 100, 110, 120
  const opt = { label: 'plan 1', p_complete: 0.5, arrive_week: 5, give: [7], steps: 1,
    weeks: [{ week: 5, samples: [120, 120, 120, 120] }, { week: 6, samples: [110, 110, 110, 110] }] };
  const roster = [{ id: 6, name: 'P6', starter: true, bye: 6 }, { id: 3, name: 'P3', starter: true, injury: 1 }];
  const f = pointsFeasibility({ target: 106, now, options: [opt], roster, currentWeek: 5 });
  assert.equal(f.status, 'reachable');
  close(f.options[0].p_average_hits, 0.5 * 1 + 0.5 * 0.5);
  close(f.how_likely, 0.75);
  assert.equal(f.by_when, 5);
  assert.deepEqual(f.at_what_cost, { players: 1, give: [7], steps: 1 });
  assert.ok(f.warnings.some(w => w.kind === 'bye' && w.week === 6));
  assert.ok(f.warnings.some(w => w.kind === 'injury'));
  assert.equal(pointsFeasibility({ target: 90, now, currentWeek: 5 }).status, 'on_track');
  assert.equal(pointsFeasibility({ target: 200, now, currentWeek: 5 }).status, 'out_of_reach');
});

test('player feasibility: how likely = P(path completes), by when from the step clock, deadline warning', () => {
  const plan = { chained: true, p_complete: 0.2, expected: 0.03, steps: [{ give: [1] }, { give: [9] }, { give: [2] }] };
  const f = targetFeasibility({ target: '11', plan, currentWeek: 4, deadlineWeek: 4, daysLeftInWeek: 3, injured: true });
  close(f.how_likely, 0.2);
  assert.equal(f.by_when, arrivalWeek(plan, 4, { daysLeftInWeek: 3 }));
  assert.equal(f.by_when, 5);               // 3 legs x 2 days = 6 days > 3 left this week
  assert.ok(f.warnings.some(w => w.kind === 'deadline'));
  assert.ok(f.warnings.some(w => w.kind === 'injury'));
  assert.equal(targetFeasibility({ target: '11', plan: null, currentWeek: 4 }).status, 'out_of_reach');
});

test('points objective runs end to end on the fixture', () => {
  const { a, res } = run('balanced', {}, { kind: 'points', points_per_week: 95 });
  assert.equal(res.feasibility.kind, 'points');
  assert.ok(['on_track', 'reachable', 'out_of_reach'].includes(res.feasibility.status));
  assert.deepEqual(validateEntry(toEntry(res, { names: a.names(), as_of: 't' })), []);
});

/* ------------------------------------------------------------ catch-up */

test('catch-up list: free moves, then flips, then desperate managers, then big swings, then timing', () => {
  const items = [
    { kind: 'timing', gain: 0.5, text: 't' }, { kind: 'swing', gain: 0.9, text: 's' }, { kind: 'flip', gain: 0.01, text: 'f1' },
    { kind: 'free', gain: null, text: 'fr' }, { kind: 'desperate', gain: 0.2, text: 'd' }, { kind: 'flip', gain: 0.05, text: 'f2' },
    { kind: 'nonsense', gain: 9, text: 'x' },
  ];
  const out = orderCatchUp(items);
  assert.deepEqual(out.map(x => x.text), ['fr', 'f2', 'f1', 'd', 's', 't']);
  assert.deepEqual(out.map(x => x.rank), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(CATCHUP_ORDER, ['free', 'flip', 'desperate', 'swing', 'timing']);
  const fm = freeMoves([{ id: 9, name: 'FA', position: 'WR', ros_ppg: 10 }], [{ id: 1, name: 'S', position: 'WR', ros_ppg: 7 }]);
  close(fm[0].ppg_gain, 3);
  const { res } = run('balanced');
  const kinds = res.catch_up.map(x => CATCHUP_ORDER.indexOf(x.kind));
  assert.deepEqual(kinds, [...kinds].sort((x, y) => x - y), 'planner output keeps the kind order');
});

/* ------------------------------------------------------------ fresh dice */

test('confirm-on-fresh-dice re-prices on a different, derived seed', () => {
  const { a, res } = run('balanced');
  assert.equal(a.worldsBuilt.length, 2);
  const [planSeed, freshSeed] = a.worldsBuilt;
  assert.equal(planSeed, a.seed);
  assert.notEqual(freshSeed, planSeed);
  assert.equal(freshSeed, confirmSeed(planSeed, 99, 'fixture'));
  assert.equal(res.confirm.seed, freshSeed);
  assert.equal(res.confirm.plan_seed, planSeed);
  for (const c of res.deck) assert.ok(['holds', 'shrank'].includes(c.confirm.verdict));
  for (let s = 1; s < 500; s++) assert.notEqual(confirmSeed(s, 1, 'x'), s >>> 0);
});

test('confirm verdicts: holds, shrank (the winner\'s curse measured), failed', () => {
  const o = { expected: 0.05, expected_se: 0.005 };
  assert.equal(confirmVerdict(o, { expected: 0.045, expected_se: 0.005 }).verdict, 'holds');
  assert.equal(confirmVerdict(o, { expected: 0.02, expected_se: 0.005 }).verdict, 'shrank');
  assert.equal(confirmVerdict(o, { expected: -0.001, expected_se: 0.005 }).verdict, 'failed');
});

/* ------------------------------------------------------------ playbook */

test('price ladder: opening below his indifference point, walk-away where the backup plan wins', () => {
  const curve = [
    { give: ['a'], his_pct: -10, p: 0.2, nick_gain: 0.030 },
    { give: ['b'], his_pct: 1, p: 0.35, nick_gain: 0.028 },
    { give: ['c'], his_pct: 15, p: 0.5, nick_gain: 0.020 },
    { give: ['d'], his_pct: 30, p: 0.7, nick_gain: 0.009 },
  ];
  const L = priceLadder(curve, { batna: 0.01 });
  assert.deepEqual(L.indifference.give, ['b']);
  assert.deepEqual(L.opening.give, ['a']);
  assert.deepEqual(L.walk_away.give, ['c']);      // 'd' is worth less than the backup (0.009 < 0.01)
  assert.deepEqual(priceLadder(curve, { batna: 0.01, mode: 'all_in' }).opening.give, ['b']);
  assert.equal(priceLadder(curve, { batna: 0.5 }).walk_away, null);
});

test('reply table covers accept, decline, counter and silence', () => {
  const step = { team: '3', give: [4], get: [21] };
  const rows = replyTable(step, { next: null, backup: { step: { team: '4', give: [5], get: [31] }, expected: 0.01 },
    ladder: priceLadder([{ give: [4], his_pct: 0, p: 0.4, nick_gain: 0.02 }, { give: [5], his_pct: 10, p: 0.5, nick_gain: 0.015 }]) });
  assert.deepEqual(rows.map(r => r.kind), ['accept', 'decline', 'counter', 'silence']);
  assert.equal(rows[1].next.partner, '4');
  assert.ok(rows[2].counter_rules.walk_away_if);
});

test('the message states only engine facts and lists each one', () => {
  const { res } = run('balanced');
  const pb = res.playbook[0];
  assert.equal(pb.message.checked, true);
  for (const f of pb.message.facts) assert.ok(['asset.ros_ppg', 'counterparty.needs'].includes(f.field));
  assert.doesNotMatch(pb.message.text, /title|odds|%/i, 'never tells him our title odds');
});

/* ------------------------------------------------------------ partners, skips, replan, attention, wait */

test('chat labels are optional: absent chat reads unknown, present chat gives labels only', () => {
  const none = chatLabels();
  assert.equal(none.status, 'unknown');
  assert.equal(none.engagement, 'unknown');
  const some = chatLabels({ profile: { msgs: 250, p_competitive: 0.6, p_friendly: 0.3, p_open_to_trade: 0.4 },
    negotiation: { says_no: { does_his_no_hold: 'rarely' } }, sentiment: [{ player: '11', sentiment_mean: 3.5, n: 4 }, { player: '31', sentiment_mean: 0.5, n: 3 }] });
  assert.deepEqual([some.engagement, some.tone, some.open_to_trade, some.no_holds], ['high', 'competitive', 'high', 'rarely']);
  assert.deepEqual([some.loves, some.hates], [['11'], ['31']]);
  assert.equal(pResponds({ checked_out: true }).p, 0.05);
  assert.equal(pResponds({ blocked: true }).p, 0);
});

test('skip log down-weights skipped players and managers; "not now" fades after a week', () => {
  const now = Date.parse('2026-09-24T00:00:00Z');
  const w = skipWeights([
    { league: 99, player: 11, reason: 'player', at: '2026-09-23T00:00:00Z' },
    { league: 99, manager: 3, reason: 'manager', at: '2026-09-23T00:00:00Z' },
    { league: 99, player: 21, reason: 'not_now', at: '2026-09-01T00:00:00Z' },
    { league: 7, player: 22, reason: 'player', at: '2026-09-23T00:00:00Z' },
  ], 99, now);
  close(w.player.get('11'), 0.5);
  close(w.manager.get('3'), 0.4);
  assert.equal(w.player.has('21'), false);
  assert.equal(w.player.has('22'), false);
  close(planSkipWeight({ steps: [{ team: '3', give: [1], get: [11] }] }, w), 0.2);
  const plain = run('balanced');
  const skipped = plain.res.best.steps[0];
  const a = makeAdapter();
  const res = planLeague(a, { objective: normaliseObjective({}),
    skips: skipWeights([{ league: 99, manager: skipped.team, reason: 'manager', at: new Date().toISOString() },
      { league: 99, manager: skipped.team, reason: 'manager', at: new Date().toISOString() }], 99) });
  assert.notEqual(firstKey(res), firstKey(plain.res), 'a twice-skipped manager no longer leads the deck');
});

test('replan diff flags a changed next move with a reason, and stays quiet when it did not change', () => {
  const s1 = { team: '3', give: [4], get: [21] }, s2 = { team: '4', give: [4], get: [31] };
  assert.deepEqual(diffNextMove(null, { next_step: s1 }).changed, true);
  assert.equal(diffNextMove({ next_step: s1 }, { next_step: { ...s1, give: [4] } }).changed, false);
  const d = diffNextMove({ next_step: s1, roster_key: 'a' }, { next_step: s2, roster_key: 'b' });
  assert.equal(d.changed, true);
  assert.match(d.reason, /rosters changed/);
  assert.match(diffNextMove({ next_step: s1, risk_mode: 'safe' }, { next_step: s2, risk_mode: 'all_in' }).reason, /risk mode/);
  assert.match(diffNextMove({ next_step: s1 }, { next_step: null }).reason, /no move/);
});

test('attention budget ranks leagues by leverage and says why', () => {
  const r = rankAttention([{ league: 1, expected: 0.01 }, { league: 2, expected: 0.02, weeksToDeadline: 1 }, { league: 3, error: 'x' }]);
  assert.deepEqual(r.map(x => x.league), [2, 1, 3]);
  assert.match(r[0].why, /deadline/);
});

test('wait-or-act: a flagged incoming player waits, with the option value labelled a guess', () => {
  const players = new Map([[31, { name: 'P31', injury: 1 }], [21, { name: 'P21', injury: 0 }]]);
  const w = waitOrAct({ get: [31], delta: 0.04 }, players);
  assert.equal(w.flag, 'wait');
  close(w.option_value, 0.3 * 0.04);
  assert.match(w.option_value_basis, /guess/);
  assert.equal(waitOrAct({ get: [21], delta: 0.04 }, players).flag, 'act');
});

test('stop trade-off and speed curve', () => {
  const without = { score: 0.05, steps: [{ team: '3' }] }, withStop = { score: 0.03, steps: [{ team: '2' }, { team: '3' }] };
  const t = stopTradeOff({ label: 'Get P11', without, with: withStop, gain: 0.01, se: 0.001 });
  close(t.cost, 0.02); close(t.net, -0.01);
  assert.equal(t.verdict, 'not_worth_it');
  assert.equal(t.extra_steps, 1);
  assert.equal(stopTradeOff({ label: 'x', without, with: null }).status, 'unreachable');
  const fast = { score: 0.02, expected: 0.02, sd: 0.01, chained: false, steps: [{ team: '3' }] };
  const slow = { score: 0.05, expected: 0.05, sd: 0.02, chained: true, steps: [{ team: '2' }, { team: '3' }, { team: '4' }] };
  const curve = speedCurve([slow, fast], { currentWeek: 4, deadlineWeek: 6, daysLeftInWeek: 3 });
  assert.equal(curve[0].arrive_by, 4); close(curve[0].cost, 0.03);    // only the one-step plan lands this week
  assert.equal(curve[1].arrive_by, 5); close(curve[1].cost, 0);
});

/* ------------------------------------------------------------ path math */

test('path outcomes sum to 1 and reproduce the prototype expectation', () => {
  const steps = [{ p: 0.5, delta: 0.01, se: 0.002 }, { p: 0.4, delta: 0.05, se: 0.003 }];
  const outs = pathOutcomes(steps);
  close(outs.reduce((s, o) => s + o.prob, 0), 1);
  const e = pathExpectation(steps);
  close(e.expected, 0.5 * 0.6 * 0.01 + 0.2 * 0.05);
  close(e.p_complete, 0.2);
  assert.ok(e.sd > 0);
});

/* ------------------------------------------------------------ the JSON contract */

test('the plans JSON matches the War Room contract (WAR-ROOM-UI.md 2-4)', () => {
  const { a, res } = run('balanced');
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z', changed: { changed: true, reason: 'first plan' } });
  assert.deepEqual(validateEntry(entry), []);
  for (const s of SECTIONS) assert.ok(entry.view[s], `section ${s}`);
  const nm = entry.view.next_move.value;
  assert.equal(entry.view.next_move.status, 'ok');
  assert.equal(nm.step_index, 0);
  assert.ok(nm.give.every(x => typeof x === 'string'));
  assert.equal(nm.p_yes.guess, true);
  assert.equal(nm.p_yes.source, 'clone.accept');
  assert.equal(nm.message.source, 'plan.template');
  assert.ok(nm.walk_away?.max_give?.length);
  assert.equal(entry.view.deck.value.length, res.deck.length);
  assert.ok(entry.view.deck.value.length <= 5);
  assert.equal(entry.view.number_health.status, 'unknown');
  assert.equal('value' in entry.view.number_health, false);
  assert.deepEqual(entry.view.replies.value.map(r => r.kind), ['accept', 'decline', 'counter', 'silence']);
  // WR-1's adapter (war-room-view.js#normalisePlans) reads { producer, leagues[] } and acq.best / acq.title_now.
  const file = plansFile([entry], { generated_at: 't' });
  assert.equal(Array.isArray(file.leagues), true);
  assert.equal(file.producer, 'campaign-producer');
  assert.equal(file.study, true);
  assert.ok(Array.isArray(file.leagues[0].acq.best.steps));
  assert.equal(typeof file.leagues[0].acq.title_now, 'number');
  assert.ok(file.leagues[0].acq.alternatives.length <= 4);
  // No manager names anywhere in the output: teams are ids.
  assert.doesNotMatch(JSON.stringify(file), /"owner_name"|"team_name"|"manager_name"/);
});

test('a failed league is a failed field with no digits, never a guess', () => {
  const entry = toEntry({ league: 5, me: '1', error: 'world failed: no schedule' }, { as_of: 't' });
  assert.deepEqual(validateEntry(entry), []);
  for (const s of SECTIONS) {
    assert.equal(entry.view[s].status, 'failed');
    assert.equal('value' in entry.view[s], false);
  }
  const broken = { league: 1, view: { next_move: { status: 'unknown', value: 3, producer: 'x', producer_version: '1', source: 'plan.path' } } };
  assert.ok(validateEntry(broken).some(e => /carries a value/.test(e)));
});

test('the deck is the top alternatives with distinct first moves', () => {
  const p = (t, g) => ({ steps: [{ team: t, give: [g], get: [9] }] });
  const d = deckOf([p('2', 1), p('2', 1), p('3', 1), p('4', 2), p('2', 2), p('3', 3), p('4', 4)], 5);
  assert.equal(d.length, 5);
  assert.equal(new Set(d.map(x => JSON.stringify(x.steps[0]))).size, 5);
});
