/**
 * LIVE-BLEND: the served P(yes) is an online-weighted blend of the activity baseline and the clone,
 * default on, weights earned on graded offers; Nick's hard rules read the gate p, never the blend.
 * Pre-registration: docs/tdd/2026-09-25-live-blend.tdd.md. Made-up teams, players and offers only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const B = await import('../server/services/p-yes-blend.js');
const { pYesFor, pYesTableFrom, pYesBasis, stepPYes, BLEND_BASIS } = await import('../server/services/p-yes.js');
const { acceptanceBand } = await import('../server/services/trade-acceptance.js');
const { confirmGate, planLeague } = await import('../server/services/campaign/planner.js');
const { rankPlans, scorePlan } = await import('../server/services/campaign/modes.js');
const { makeScorer, searchTarget, newOverpaySink } = await import('../server/services/campaign/search.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

const NOW = Date.UTC(2026, 9, 1);
const day = d => new Date(Date.UTC(2026, 8, d)).toISOString();
const offer = (league, team, d, y, extra = {}) =>
  ({ league_id: league, counterparty_team_id: team, proposed_at: day(d), resolved_at: day(d + 1), y, ...extra });

/* ------------------------------------------------------------ the weights */

test('no graded offer: the served weights are the prior, clone 0.25', () => {
  const s = B.blendState([], '4', { now: NOW });
  assert.deepEqual(s.weights, { baseline: 0.75, clone: 0.25 });
  assert.equal(s.pooled.n, 0);
});

test('one graded offer: the weights are the Bayes update of the prior, by hand', () => {
  // Hand-fed predictions (hedge takes graded rows directly): baseline said 0.2, clone 0.6, he said yes.
  const h = B.hedge([{ y: 1, p: { baseline: 0.2, clone: 0.6 } }]);
  const wb = 0.75 * 0.2, wc = 0.25 * 0.6;
  assert.ok(Math.abs(h.weights.clone - wc / (wb + wc)) < 1e-12);
  assert.equal(h.record.clone.wins, 1);
  assert.equal(h.record.clone.losses, 0);
  assert.equal(h.record.clone.n, 1);
});

test('the clamp: 200 offers the clone gets wrong cannot take it below 0.05, nor 200 right above 0.95', () => {
  const lose = Array.from({ length: 200 }, () => ({ y: 0, p: { baseline: 0.1, clone: 0.9 } }));
  const win = Array.from({ length: 200 }, () => ({ y: 1, p: { baseline: 0.1, clone: 0.9 } }));
  assert.ok(Math.abs(B.hedge(lose).weights.clone - 0.05) < 1e-12);
  assert.ok(Math.abs(B.hedge(win).weights.clone - 0.95) < 1e-12);
  // And it comes back: the clamp keeps the loser alive.
  assert.ok(B.hedge([...lose, ...win.slice(0, 5)]).weights.clone > 0.5);
});

const POOL = [
  offer('4', '2', 1, 1), offer('4', '2', 3, 0), offer('4', '2', 5, 1), offer('4', '3', 7, 0), offer('4', '3', 9, 0),
  offer('2', '7', 2, 1), offer('2', '7', 4, 1), offer('3', '5', 6, 0),
];

test('forward only: weights move when, and only when, a newly settled offer is graded', () => {
  const a = B.blendState(POOL, '4', { now: NOW });
  // An offer answered AFTER now changes nothing.
  const late = [...POOL, { ...offer('4', '2', 29, 0), resolved_at: new Date(NOW + 864e5).toISOString() }];
  assert.deepEqual(B.blendState(late, '4', { now: NOW }).weights, a.weights);
  // Time passing with no new answer changes nothing.
  assert.deepEqual(B.blendState(POOL, '4', { now: NOW + 7 * 864e5 }).weights, a.weights);
  // A new settled answer does move them.
  const more = [...POOL, offer('4', '3', 20, 1)];
  assert.notDeepEqual(B.blendState(more, '4', { now: NOW }).weights, a.weights);
  assert.equal(B.blendState(more, '4', { now: NOW }).pooled.n, POOL.length + 1);
});

test('pooled across leagues, shrunk per league: lambda = n / (n + 20)', () => {
  const s = B.blendState(POOL, '4', { now: NOW });
  assert.equal(s.pooled.n, 8, 'every league counts');
  assert.equal(s.league.n, 5);
  assert.ok(Math.abs(s.lambda - 5 / 25) < 1e-12);
  const want = B.clampWeights({ baseline: s.lambda * s.league.weights.baseline + (1 - s.lambda) * s.pooled.weights.baseline,
    clone: s.lambda * s.league.weights.clone + (1 - s.lambda) * s.pooled.weights.clone });
  assert.deepEqual(s.weights, want);
  // A league with no offers of its own is served the pool's weights.
  assert.deepEqual(B.blendState(POOL, '9', { now: NOW }).weights, B.clampWeights(s.pooled.weights));
});

/* ------------------------------------------------------------ the served p */

const CP = { counterparty_data: true, receptiveness: 1.1, perception_delta: 0.02 };
const EDGE = { passes: true };

test('served p = weight x baseline + weight x clone; p_gate is the baseline; the ledger keeps the clone', () => {
  const table = pYesTableFrom(POOL, '4', ['2', '3'], { now: NOW, mode: 'blend' });
  const clone = acceptanceBand({ counterparty: CP, edge: EDGE });
  const a = pYesFor({ counterparty: CP, edge: EDGE, team: '2', table, on: true });
  const w = table.blend.weights, base = table.byTeam.get('2').p;
  assert.equal(a.basis, BLEND_BASIS);
  assert.ok(Math.abs(a.band.mid - (w.baseline * base + w.clone * clone.band.mid)) < 1e-12);
  assert.ok(a.band.low <= a.band.mid && a.band.mid <= a.band.high);
  assert.equal(a.p_gate, base);
  assert.deepEqual(a.challenger, { band: clone.band, basis: clone.basis }, 'trade-outcomes logs the clone (CHECK-safe)');
  const st = stepPYes(a);
  assert.equal(st.p, a.band.mid);
  assert.equal(st.p_gate, base);
  assert.ok(st.probe >= 0);
});

test('no decided offer: the blend fails closed to the clone band, never a 0.5', () => {
  const table = pYesTableFrom([], '4', ['2'], { now: NOW, mode: 'blend' });
  const a = pYesFor({ counterparty: CP, edge: EDGE, team: '2', table, on: true });
  assert.deepEqual(a.band, acceptanceBand({ counterparty: CP, edge: EDGE }).band);
  assert.ok(a.pyes_fallback);
  assert.equal(pYesBasis(table).source, 'clone.accept');
});

test('an idea that fails the edge test still carries no number', () => {
  const table = pYesTableFrom(POOL, '4', ['2'], { now: NOW, mode: 'blend' });
  assert.equal(pYesFor({ counterparty: CP, edge: { passes: false }, team: '2', table, on: true }).band, null);
});

/* ------------------------------------------------------------ plans.json */

test('plans.json p_yes_basis: each model with weight, prior, record vs baseline and n; validates', () => {
  const table = pYesTableFrom(POOL, '4', ['2', '3'], { now: NOW, mode: 'blend' });
  const b = pYesBasis(table);
  assert.equal(b.source, 'blend.accept');
  const clone = b.models.find(m => m.id === 'clone');
  assert.equal(clone.prior_weight, 0.25);
  assert.equal(clone.n, 8);
  assert.equal(clone.wins + clone.losses <= 8, true);
  assert.ok(clone.weight >= 0.05 && clone.weight <= 0.95);
  assert.equal(b.n_graded, 8);

  const a = makeAdapter();
  a.pYesBasis = b;
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  const entry = toEntry(res, { names: a.names(), as_of: '2026-10-01T00:00:00Z' });
  assert.equal(entry.p_yes_basis.status, 'ok');
  assert.equal(entry.p_yes_basis.source, 'blend.accept');
  const v = validateLeague(entry);
  assert.ok(v.ok, JSON.stringify(v.errors.slice(0, 5)));
});

/* ---------------------------------- Nick's hard rules stay outside the model */

// A 2-step path whose first step costs Nick points: whether it beats doing nothing depends on p.
const path = (p1, p2, g1, g2) => ({ steps: [
  { team: 2, give: [1], get: [2], p: p1, p_gate: g1, delta: -0.02, se: 0.001 },
  { team: 3, give: [3], get: [4], p: p2, p_gate: g2, delta: 0.03, se: 0.001 },
] });

test('confirm dice: the served p cannot flip "beats doing nothing"; the gate p decides it', () => {
  const grid = [0.05, 0.2, 0.4, 0.6, 0.8, 0.95];
  for (const [g1, g2] of [[0.9, 0.2], [0.3, 0.9], [0.5, 0.5]]) {
    const failed = new Set();
    for (const p1 of grid) for (const p2 of grid) {
      const v = confirmGate(path(p1, p2, g1, g2), path(p1, p2, g1, g2));
      failed.add(v.verdict === 'failed');
      assert.equal(v.gate, 'p_gate');
    }
    assert.equal(failed.size, 1, `gate (${g1}, ${g2}): one verdict whatever the served p`);
  }
  // Without the gate the served p WOULD flip it: this is what the gate protects.
  const noGate = (p1, p2) => ({ steps: path(p1, p2).steps.map(({ p_gate, ...s }) => s) });
  assert.equal(confirmGate(noGate(0.9, 0.2), noGate(0.9, 0.2)).verdict, 'failed');
  assert.equal('gate' in confirmGate(noGate(0.9, 0.2), noGate(0.9, 0.2)), false, 'clone path: the verdict object is unchanged');
  assert.notEqual(confirmGate(noGate(0.3, 0.9), noGate(0.3, 0.9)).verdict, 'failed');
});

test('all-in floor: eligibility reads the gate p, so the blend cannot drop or admit a plan', () => {
  const lo = path(0.9, 0.9, 0.1, 0.1), hi = path(0.05, 0.05, 0.9, 0.9);
  assert.equal(scorePlan(lo, 'all_in').eligible, false);
  assert.equal(scorePlan(hi, 'all_in').eligible, true);
});

// The tiny linear world of test/campaign-no-overpay.test.js: Nick = team 1, target 21 on team 2.
const VALUES = { 11: 60, 12: 50, 13: 100, 14: 95, 21: 100, 22: 5 };
function world(priceStep) {
  const rosters = new Map([[1, [11, 12, 13, 14]], [2, [21, 22]]]);
  const players = new Map(Object.entries(VALUES).map(([id, value]) => [Number(id), { name: `p${id}`, position: 'WR', value }]));
  const adapter = { league: { me: 1 }, players, rosters, managers: new Map([[1, {}], [2, {}]]), untouchable: new Set(),
    searchOpts: { twoForOne: true, fillers: 0 }, priceStep };
  const d = (team, ids) => {
    const base = new Set(rosters.get(team));
    let s = 0;
    for (const id of ids) if (!base.has(id)) s += (id === 21 ? 5 : 1) * VALUES[id] * 1e-4;
    for (const id of base) if (!ids.includes(id)) s -= VALUES[id] * 1e-5;
    return s;
  };
  const block = (state, t) => (t == null ? null
    : { title_delta: d(t, state.get(t) ?? rosters.get(t)), title_delta_se: 0.0001, title_delta_clears_noise: true, title_before: 0.1 });
  const S = makeScorer({ rescore: (state, a, b) => ({ me: block(state, a), them: block(state, b) }) }, adapter);
  const vals = { tradable: id => (players.get(id)?.value ?? 0) > 0, addN: new Map(), lossN: new Map(),
    lossO: new Map([[21, { team: 2 }], [22, { team: 2 }]]) };
  return { adapter, S, vals };
}
const key = p => p.steps.map(s => `${s.team}:${s.give.map(Number).sort()}>${s.get.map(Number).sort()}`).join('|');
// Served p per package: two blends that disagree hard. The gate (baseline) is one number per partner.
const served = w => (team, theyGive, theyGet) => {
  const clone = theyGet.length > 1 ? 0.9 : 0.1;
  return { p: w * 0.4 + (1 - w) * clone, basis: BLEND_BASIS, p_gate: 0.4, probe: Math.abs(clone - 0.4) };
};

test('search and rank: the same moves pass every filter under any blend; only order and p differ', () => {
  const runs = [0.95, 0.05].map(w => {
    const { adapter, S, vals } = world(served(w));
    const sink = newOverpaySink(0);
    const plans = searchTarget(S, adapter, vals, { kind: 'title', goal: 'title' }, 21, { overpaySink: sink });
    const byMode = Object.fromEntries(['safe', 'balanced', 'all_in'].map(m => {
      const r = rankPlans(plans, m, { max_assets: 9, max_offers_per_manager_week: 9, max_give_per_step: 3, max_downside_per_step: 1 },
        { untouchables: ['14'] });
      return [m, { kept: r.ranked.map(key).sort(), dropped: r.dropped.map(x => `${key(x.plan)}:${x.why}`).sort() }];
    }));
    return { keys: plans.map(key).sort(), sink: { rejected: sink.rejected, closest: sink.closest }, byMode,
      p: plans.map(p => p.steps[0].p) };
  });
  assert.ok(runs[0].keys.length > 0);
  assert.deepEqual(runs[0].keys, runs[1].keys, 'the planned moves');
  assert.deepEqual(runs[0].sink, runs[1].sink, 'the overpay cap');
  assert.deepEqual(runs[0].byMode, runs[1].byMode, 'every mode: kept and dropped, with the reason');
  assert.ok(runs[0].byMode.balanced.dropped.some(d => d.includes('untouchable')), 'the untouchable rule fired');
  assert.notDeepEqual(runs[0].p, runs[1].p, 'the shown P(yes) did change');
});

test('the whole planner: under two blends the rules see the same numbers', () => {
  const run = w => {
    const a = makeAdapter();
    const base = a.priceStep;
    a.priceStep = (t, g, h) => {
      const r = base(t, g, h);
      return { ...r, p: w * r.p + (1 - w) * (1 - r.p), basis: BLEND_BASIS, p_gate: r.p };
    };
    return planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  };
  // w = 1 serves the gate p itself (what GRIDIRON_PYES_BLEND=0 serves); 0.95 and 0.7 reorder the deck.
  const runs = [1, 0.95, 0.7].map(run);
  const [x, y] = runs;
  for (const r of runs.slice(1)) {
    assert.deepEqual(r.untouchable, x.untouchable);
    assert.deepEqual({ r: r.no_overpay.rejected, c: r.no_overpay.closest }, { r: x.no_overpay.rejected, c: x.no_overpay.closest });
  }
  // candidates_scored may differ: the search's beam is ranked on the served p (ranking, not a rule).
  for (const res of runs) {
    assert.ok(res.deck.length > 0);
    for (const c of res.deck) {
      assert.notEqual(c.confirm.verdict, 'failed', 'no served move loses to doing nothing on the gate');
      assert.equal(c.confirm.gate, 'p_gate');
    }
  }
  const gx = new Map(x.deck.map(c => [key(c.plan), c.confirm.gate_expected]));
  let shared = 0;
  for (const c of y.deck) {
    if (!gx.has(key(c.plan))) continue;
    shared++;
    assert.ok(Math.abs(gx.get(key(c.plan)) - c.confirm.gate_expected) < 1e-12, 'same plan, same gate number');
  }
  assert.ok(shared > 0);
});

/* ------------------------------------------------------------ probes */

test('probes: information gain is 0 when the models agree, larger when they disagree', () => {
  const w = { baseline: 0.5, clone: 0.5 };
  assert.ok(B.probeEIG(w, { baseline: 0.3, clone: 0.3 }) < 1e-12);
  assert.ok(B.probeEIG(w, { baseline: 0.1, clone: 0.9 }) > B.probeEIG(w, { baseline: 0.3, clone: 0.5 }));
  assert.equal(B.probesOn({}), false, 'shadow: off by default');
  assert.equal(B.probesOn({ [B.PROBES_ENV]: '1' }), true);
});

test('probes break exact score ties only, and never change the kept set', () => {
  const mk = (probe, d) => ({ steps: [{ team: 2, give: [d], get: [9], p: 0.5, delta: 0.01, se: 0.001, probe }] });
  const plans = [mk(0.01, 1), mk(0.3, 2), { steps: [{ team: 2, give: [3], get: [9], p: 0.5, delta: 0.02, se: 0.001, probe: 0 }] }];
  const tol = { max_assets: 9, max_offers_per_manager_week: 9, max_give_per_step: 3, max_downside_per_step: 1 };
  const off = rankPlans(plans, 'balanced', tol, {}).ranked.map(key);
  const on = rankPlans(plans, 'balanced', tol, { probes: true }).ranked.map(key);
  assert.equal(on[0], off[0], 'the higher score still wins');
  assert.deepEqual([...on].sort(), [...off].sort());
  assert.equal(on[1], '2:2>9', 'the tie goes to the more informative offer');
});

/* ------------------------------------------------------------ the pre-registered metric */

test('prequential: each offer is scored with weights from answers known before it was proposed', () => {
  const r = B.prequential(POOL);
  assert.equal(r.n, POOL.length);
  assert.ok(Number.isFinite(r.gain) && r.ci[0] <= r.gain && r.gain <= r.ci[1]);
  assert.ok(Math.abs(r.gain - (r.log_loss_baseline - r.log_loss_blend)) < 1e-12);
  // The first offer has nothing before it: the prior blend scores it.
  const one = B.prequential(POOL.slice(0, 1));
  assert.equal(one.n, 1);
  assert.deepEqual(B.prequential([]), { n: 0, log_loss_blend: null, log_loss_baseline: null, gain: null, ci: null });
});
