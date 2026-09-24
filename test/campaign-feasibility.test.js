/**
 * FEAS-140: the 140-points side panel (server/services/campaign/feasibility.js) and the
 * wait-or-act kill switch (server/services/campaign/wait-or-act.js). Made-up numbers and
 * the four-team fixture league only; no DB, no real league data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const F = await import('../server/services/campaign/feasibility.js');
const { normaliseObjective, DEFAULT_SIDE_POINTS } = await import('../server/services/campaign/objectives.js');
const { waitOrAct, waitOrActOn, WAIT_OR_ACT_ENV } = await import('../server/services/campaign/wait-or-act.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const ON = { [F.POINTS_FEASIBILITY_ENV]: '1' };
const flat = (weeks, v) => weeks.map(week => ({ week, samples: [v, v, v, v] }));
const now = [{ week: 5, samples: [120, 130, 140, 150] }, { week: 6, samples: [100, 110, 120, 130] }, { week: 7, samples: [125, 135, 145, 155] }];
const roster = [{ id: 6, name: 'P6', starter: true, bye: 6 }, { id: 3, name: 'P3', starter: true, injury: 1 }, { id: 9, name: 'P9', starter: false, bye: 7 }];
const plans = [
  { expected: 0.05, p_complete: 0.6, arrive_week: 6, give: [7], steps: 1, weeks: flat([5, 6, 7], 138) },
  { expected: 0.03, p_complete: 0.5, arrive_week: 6, give: [7, 8], steps: 2, weeks: flat([5, 6, 7], 150) },
];
const title = normaliseObjective({});

test('flag: default off, on under the preview switch, explicit value wins', () => {
  assert.deepEqual(F.pointsFeasibilityFlag({}), { on: false, preview: false });
  assert.deepEqual(F.pointsFeasibilityFlag({ [PREVIEW_ENV]: '1' }), { on: true, preview: true });
  assert.deepEqual(F.pointsFeasibilityFlag({ [PREVIEW_ENV]: '1', [F.POINTS_FEASIBILITY_ENV]: '0' }), { on: false, preview: false });
  assert.deepEqual(F.pointsFeasibilityFlag(ON), { on: true, preview: false });
  assert.equal(F.sidePanelFeasibility({ objective: title, nowWeeks: now, plans, roster, currentWeek: 5, env: {} }), null);
});

test('target: 140 by default, configurable per league from the objectives file', () => {
  assert.equal(DEFAULT_SIDE_POINTS, 140);
  assert.equal(title.side_points_per_week, 140);
  assert.equal(normaliseObjective({ side_points_per_week: 125 }).side_points_per_week, 125);
  assert.equal(normaliseObjective({ side_points_per_week: -3 }).side_points_per_week, 140);
  assert.equal(F.sidePointsTarget({}), 140);
});

test('side panel on a title league: p_reach, arrive_week, cost in players and title odds, bye and injury warnings', () => {
  const f = F.sidePanelFeasibility({ objective: title, nowWeeks: now, plans, roster, currentWeek: 5, env: ON });
  assert.equal(f.kind, 'points');
  assert.equal(f.side_panel, true);
  assert.equal(f.league_objective, 'title');
  assert.equal(f.target, 140);
  assert.equal(f.status, 'reachable');                 // now: 135 / 115 / 140 -> mean 130; plan 2 lands at 150
  // plan 2 (the title plan's runner-up) reaches 140 for sure if done: 0.5 x 1 + 0.5 x P(now hits) (runs average 115/125/135/145 -> 1/4).
  close(f.p_reach, 0.625);
  assert.equal(f.options[0].label, 'plan 2');
  assert.equal(f.arrive_week, 6);
  assert.equal(f.cost.players, 2);
  assert.equal(f.cost.steps, 2);
  close(f.cost.title_odds, 0.02);                      // 0.05 best title plan - 0.03
  close(f.options.find(o => o.label === 'plan 1').title_odds_cost, 0);
  assert.ok(f.warnings.some(w => w.kind === 'bye' && w.week === 6 && w.players.includes(6)));
  assert.ok(!f.warnings.some(w => w.kind === 'bye' && w.players.includes(9)), 'bench byes are not warnings');
  assert.ok(f.warnings.some(w => w.kind === 'injury' && w.players.includes(3)));
  assert.deepEqual(f.warnings_count, { bye: 1, injury: 1 });
  assert.equal(f.preview, undefined);
  const p = F.sidePanelFeasibility({ objective: title, nowWeeks: now, plans, roster, currentWeek: 5, env: { [PREVIEW_ENV]: '1' } });
  assert.equal(p.preview, true);
  assert.match(p.preview_reason, /FEAS-140/);
});

test('side panel: on track costs nothing; a points league keeps its own card; no weekly points -> null', () => {
  const f = F.sidePanelFeasibility({ objective: normaliseObjective({ side_points_per_week: 100 }), nowWeeks: now, plans, roster, currentWeek: 5, env: ON });
  assert.equal(f.status, 'on_track');
  assert.equal(f.arrive_week, 5);
  assert.deepEqual({ players: f.cost.players, title_odds: f.cost.title_odds }, { players: 0, title_odds: 0 });
  assert.equal(F.sidePanelFeasibility({ objective: normaliseObjective({ kind: 'points', points_per_week: 120 }), nowWeeks: now, plans, env: ON }), null);
  assert.equal(F.sidePanelFeasibility({ objective: title, nowWeeks: null, plans, env: ON }), null);
  const none = F.sidePanelFeasibility({ objective: title, nowWeeks: now, plans: [], roster, currentWeek: 5, env: ON });
  assert.equal(none.status, 'out_of_reach');
  assert.equal(none.cost.basis, 'no plan to price');
});

test('the side panel renders as an ok, schema-valid feasibility section on a title league (wiring check)', () => {
  const a = makeAdapter();
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  assert.equal(res.feasibility, null);                  // today: title league -> no points card
  const W = a.world(a.seed);
  const me = a.league.me;
  const nowWeeks = W.weekly(a.rosters.get(me));
  const side = F.sidePanelFeasibility({ objective: res.objective, nowWeeks, plans, roster, currentWeek: a.league.week, env: ON });
  const entry = toEntry({ ...res, feasibility: side }, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
  assert.deepEqual(validateLeague(entry).errors, []);
  assert.equal(entry.feasibility.status, 'ok');
  assert.equal(entry.feasibility.value.points_per_week, 140);
  assert.equal(entry._run.feasibility_detail.side_panel, true);
});

test('wait-or-act: off unless GRIDIRON_WAIT_OR_ACT=1; off, pending news reads act and names the kill', () => {
  assert.equal(waitOrActOn({}), false);
  assert.equal(waitOrActOn({ [PREVIEW_ENV]: '1' }), false, 'the preview switch does not revive a killed idea');
  assert.equal(waitOrActOn({ [WAIT_OR_ACT_ENV]: '1' }), true);
  const players = new Map([[31, { name: 'P31', injury: 1 }], [32, { name: 'P32', trend_kind: 'role_up' }], [21, { name: 'P21', injury: 0 }]]);
  for (const get of [[31], [32]]) {
    const off = waitOrAct({ get, delta: 0.04 }, players, { enabled: waitOrActOn({}) });
    assert.equal(off.flag, 'act');
    assert.equal(off.untested, undefined);
    assert.match(off.reason, /R&D r24/);
  }
  assert.deepEqual(waitOrAct({ get: [21], delta: 0.04 }, players, { enabled: false }),
    { flag: 'act', days: 0, option_value: 0, reason: 'no pending news on the players you get' });
});

test('wait-or-act: any wait that remains is labelled untested', () => {
  const players = new Map([[31, { name: 'P31', injury: 1 }]]);
  for (const w of [waitOrAct({ get: [31], delta: 0.04 }, players, { enabled: true }), waitOrAct({ get: [31], delta: 0.04 }, players)]) {
    assert.equal(w.flag, 'wait');
    assert.equal(w.untested, true);
    assert.match(w.reason, /^untested/);
    close(w.option_value, 0.3 * 0.04);
  }
});
