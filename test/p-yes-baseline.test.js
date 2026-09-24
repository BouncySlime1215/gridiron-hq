/**
 * PYES-BASELINE: people/p-yes.js is the one producer of the served P(yes).
 * Flag GRIDIRON_PYES_BASELINE (default off, on under preview). On, the War Room
 * planner serves the E1 activity-only baseline and logs the clone band as the
 * shadow challenger. Made-up league and offers; no real data, no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const py = await import('../server/services/people/p-yes.js');
const { activityBaseline } = await import('../server/services/eval/e1.js');
const { scoreAsOf } = await import('../server/services/eval/e1-league.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');

const day = d => new Date(Date.parse('2026-09-01T00:00:00Z') + d * 864e5).toISOString();
// Invented decided offers in league 99: team 3 says yes often, team 2 never.
const OFFERS = [
  [2, 1, 0], [3, 2, 1], [2, 3, 0], [3, 4, 1], [4, 5, 0], [2, 6, 0], [3, 7, 0], [3, 8, 1], [2, 9, 0], [4, 10, 1],
  [3, 11, 1], [2, 12, 0],
].map(([team, d, y], i) => ({ league_id: 99, season: 2026, source: 'observed', proposer_team_id: '1', counterparty_team_id: String(team),
  proposed_at: day(d), resolved_at: day(d + 0.5), status: y ? 'accepted' : 'declined', y, espn_tx_id: `t${i}` }));
const NOW = Date.parse(day(20));
const withEnv = (vars, fn) => {
  const keep = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(keep)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
};
const objective = () => normaliseObjective({}, { leagueGoal: 'title' });
const stepsOf = res => [res.best, ...res.deck.map(c => c.plan)].filter(Boolean).flatMap(p => p.steps);

test('flag: off by default; =1 on; preview turns it on; =0 vetoes preview', () => {
  withEnv({ [py.PYES_ENV]: null, [PREVIEW_ENV]: null }, () => assert.equal(py.pYesFlag().on, false));
  withEnv({ [py.PYES_ENV]: '1', [PREVIEW_ENV]: null }, () => assert.deepEqual(py.pYesFlag(), { on: true, preview: false }));
  withEnv({ [py.PYES_ENV]: null, [PREVIEW_ENV]: '1' }, () => { const f = py.pYesFlag(); assert.equal(f.on, true); assert.equal(f.preview, true); });
  withEnv({ [py.PYES_ENV]: '0', [PREVIEW_ENV]: '1' }, () => assert.equal(py.pYesFlag().on, false));
});

test('the served number is exactly the E1 grader\'s activity baseline at the same cutoff', () => {
  // Scored as of each offer's proposal, the table must reproduce e1.js#activityBaseline row for row.
  const scored = scoreAsOf(OFFERS);
  const base = activityBaseline(scored, scored.map(o => o.prior));
  scored.forEach((o, i) => {
    const t = py.pYesTableFrom(OFFERS, 99, [o.counterparty_team_id], { now: Date.parse(o.proposed_at) });
    assert.ok(Math.abs(t.byTeam.get(o.counterparty_team_id).p - base[i]) < 1e-12, `offer ${i}`);
  });
  const t = py.pYesTableFrom(OFFERS, 99, null, { now: NOW });
  assert.deepEqual([...t.byTeam.keys()].sort(), ['2', '3', '4']);
  assert.ok(t.byTeam.get('3').p > t.unseen.p && t.unseen.p > t.byTeam.get('2').p, 'the eager trader is above the pooled rate, the refuser below');
  assert.deepEqual(t.pooled, { acc: 5, n: 12 });
});

test('servePYes: off serves the clone untouched; on serves the baseline with the clone as challenger; a passing challenger is served', () => {
  const table = py.pYesTableFrom(OFFERS, 99, null, { now: NOW });
  const clone = { p: 0.8, band: { low: 0.7, high: 0.9 }, basis: 'fixture' };
  assert.equal(py.servePYes({ team: '2', clone, table, on: false }), clone);
  const s = py.servePYes({ team: '2', clone, table, on: true });
  assert.equal(s.p, table.byTeam.get('2').p);
  assert.equal(s.band, null);
  assert.equal(s.label, py.PYES_LABEL);
  assert.equal(s.label, 'chance he says yes: activity baseline (clone not proven)');
  assert.deepEqual(s.challenger, { p: 0.8, band: { low: 0.7, high: 0.9 }, basis: 'fixture' });
  assert.equal(py.servePYes({ team: '9', clone, table, on: true }).p, table.unseen.p, 'a manager with no decided offers gets the pooled rate');
  assert.equal(py.servePYes({ team: '2', clone, table, on: true, challengerPassing: true }).p, 0.8);
  assert.equal(py.servePYes({ team: '2', clone, table: { error: 'x' }, on: true }), clone, 'a failed read never becomes a number');
});

test('planner, flag on: every step, flip leg and curve price reads p-yes.js; the clone is logged beside it', () => {
  const table = py.pYesTableFrom(OFFERS, 99, null, { now: NOW });
  const res = planLeague(makeAdapter(), { objective: objective(), pYes: { flag: { on: true }, table } });
  assert.equal(res.p_yes.status, 'ok');
  assert.equal(res.p_yes.served, py.PYES_BASIS);
  assert.equal(res.p_yes.label, py.PYES_LABEL);
  const steps = stepsOf(res);
  assert.ok(steps.length > 0);
  for (const st of steps) {
    const want = (table.byTeam.get(String(st.team)) ?? table.unseen).p;
    assert.equal(st.p, want, `step to team ${st.team}`);
    assert.equal(st.band, null);
    assert.ok(st.p_yes_challenger && Number.isFinite(st.p_yes_challenger.p), 'clone band logged as challenger');
    assert.equal(st.p_yes_challenger.basis, 'fixture');
  }
  for (const f of res.flip.realised.filter(f => f.legs)) {
    assert.equal(f.legs.p1, (table.byTeam.get(String(f.a)) ?? table.unseen).p);
    assert.equal(f.legs.p2, (table.byTeam.get(String(f.b)) ?? table.unseen).p);
  }
  for (const pb of res.playbook) if (pb.opening) assert.equal(pb.opening.p, (table.byTeam.get(String(res.best.steps[pb.step_index].team)) ?? table.unseen).p);
});

test('planner, flag off: the plan is the incumbent\'s, byte for byte', () => {
  const inc = planLeague(makeAdapter(), { objective: objective() });
  const off = planLeague(makeAdapter(), { objective: objective(), pYes: { flag: { on: false }, table: py.pYesTableFrom(OFFERS, 99, null, { now: NOW }) } });
  const strip = r => JSON.parse(JSON.stringify({ ...r, runtime_ms: 0, phases_ms: 0 }));
  assert.deepEqual(strip(off), strip(inc));
  assert.equal(off.p_yes, undefined);
  withEnv({ [py.PYES_ENV]: '1', [PREVIEW_ENV]: null }, () => {
    py.clearPYesTables();
    const none = planLeague(makeAdapter(), { objective: objective() });
    assert.equal(none.p_yes.status, 'unknown', 'flag on without a table: says so and serves the clone');
    assert.deepEqual(strip({ ...none, p_yes: undefined }), strip(inc));
  });
});

test('producer, flag on with the registered table: the plans file passes validatePlans and _run logs the challenger', async () => {
  const keep = [process.env[py.PYES_ENV], process.env[PREVIEW_ENV]];
  process.env[py.PYES_ENV] = '1'; delete process.env[PREVIEW_ENV];
  py.registerPYesTable(99, py.pYesTableFrom(OFFERS, 99, null, { now: NOW }));
  try {
    const file = await buildPlansFile([{ id: 99, load: async () => ({ adapter: makeAdapter() }) }],
      { generated_at: '2026-09-24T00:00:00.000Z', clock: () => 0 });
    assert.equal(validatePlans(file).ok, true, JSON.stringify(validatePlans(file).errors?.slice(0, 3)));
    const entry = file.leagues[0];
    assert.ok(!entry.error, entry.error);
    const next = entry._run.next_step;
    assert.ok(next.p_yes_challenger, 'the shadow challenger is logged with the next step');
    const served = entry.next_move.value.steps[0].p_yes;
    assert.equal(served.value, next.p, 'the War Room card shows the served number');
    assert.equal(next.p, (py.pYesTableFor(99).byTeam.get(String(next.team)) ?? py.pYesTableFor(99).unseen).p);
  } finally {
    py.clearPYesTables();
    for (const [k, v] of [[py.PYES_ENV, keep[0]], [PREVIEW_ENV, keep[1]]]) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
});
