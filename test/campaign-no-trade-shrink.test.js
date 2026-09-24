/**
 * NO-TRADE-SHRINK (ONE-PLAN 4d night 2 + spot-check row 6): an explicit "no trade" row in every risk
 * mode, and pre-rank shrinkage of plan gains toward doing nothing (the optimizer's curse), SHADOW only.
 *
 * Pre-registered bar: every mode row carries the no-trade option (expected 0, lands 100%) and says
 * which of plan / no trade its own objective picks; the shrinkage is computed and reported under
 * `_run.shrink` with status 'shadow' and moves NO served number (ranking, deck, risk_modes numbers).
 * Made-up plans and the made-up four-team league (test/fixtures/campaign-league.mjs); no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { rankPlans, tolerancesFor, compareModes, MODES, NO_TRADE, shrinkPrior, shrinkExpected, shrinkFactor, shadowShrink } =
  await import('../server/services/campaign/modes.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');

const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const plan = (team, p, delta, se) => ({ target: team, steps: [{ team, give: [1], get: [Number(team) * 10], p, delta, se }] });
const ctx = { originalIds: [1, 2, 3] };
const ctxFor = mode => ({ tol: tolerancesFor(mode), ctx });

/* ------------------------------------------------------------ the shrinkage rule (pure) */

test('shrinkage prior: method of moments around 0 (the no-trade gain), floored at 0', () => {
  // Gains e = 0.03, 0.01 with SEs 0.01, 0.01: mean(e^2) = 0.0005, mean(se^2) = 0.0001 -> tau^2 = 0.0004.
  const pr = shrinkPrior([{ expected: 0.03, expected_se: 0.01 }, { expected: 0.01, expected_se: 0.01 }]);
  close(pr.tau2, 0.0004);
  assert.equal(pr.n, 2);
  // All the spread is noise -> tau^2 = 0: every gain shrinks to doing nothing.
  assert.equal(shrinkPrior([{ expected: 0.001, expected_se: 0.01 }]).tau2, 0);
  // Plans without an SE are not counted; none counted -> no prior.
  assert.equal(shrinkPrior([{ expected: 0.02, expected_se: null }]).tau2, null);
});

test('shrunk gain = gain x tau^2 / (tau^2 + se^2); unknown SE or prior -> null', () => {
  close(shrinkExpected(0.03, 0.01, 0.0004), 0.03 * 0.8);
  close(shrinkExpected(0.03, 0, 0.0004), 0.03);
  assert.equal(shrinkExpected(0.03, 0.01, 0), 0);
  assert.equal(shrinkExpected(0.03, null, 0.0004), null);
  assert.equal(shrinkExpected(0.03, 0.01, null), null);
});

test('shadow: a noisy winner loses to a precise runner-up after shrinkage, served order unchanged', () => {
  // A: 0.020 expected at SE 0.02 (noisy); B: 0.015 at SE 0.002 (precise). Both land 100%.
  const A = plan('2', 1, 0.020, 0.02), B = plan('3', 1, 0.015, 0.002);
  const served = rankPlans([A, B], 'balanced', tolerancesFor('balanced'), ctx).ranked;
  assert.equal(served[0].target, '2', 'served ranking stays on the point estimate');
  const sh = shadowShrink([A, B], ctxFor);
  assert.equal(sh.status, 'shadow');
  const bal = sh.modes.find(m => m.mode === 'balanced');
  assert.equal(bal.best, '2|1|20');
  assert.equal(bal.shrunk_best, '3|1|30');
  assert.equal(bal.reorders, true);
  assert.ok(bal.best_shrunk_expected < bal.shrunk_best_expected);
  // rankPlans' output carries no shadow key (nothing served reads it).
  assert.equal('shrunk_expected' in served[0], false);
});

/* ------------------------------------------------------------ the no-trade row */

test('every mode carries the no-trade option: expected 0, lands for sure', () => {
  const rows = compareModes([plan('2', 0.5, 0.02, 0.001)], ctxFor);
  assert.deepEqual(rows.map(r => r.mode), MODES);
  for (const r of rows) {
    assert.deepEqual(r.no_trade, { ...NO_TRADE, pick: r.no_trade.pick, why: r.no_trade.why });
    assert.equal(r.no_trade.expected, 0);
    assert.equal(r.no_trade.p_complete, 1);
  }
});

test("the mode's own objective picks plan or no trade", () => {
  // Balanced: 0.5 x 0.02 = +0.01 > 0 -> plan. Safe: 0.01 - spread 0.01 = 0 -> no trade (not better than holding).
  const rows = Object.fromEntries(compareModes([plan('2', 0.5, 0.02, 0.001)], ctxFor).map(r => [r.mode, r]));
  assert.equal(rows.balanced.no_trade.pick, 'plan');
  assert.equal(rows.all_in.no_trade.pick, 'plan');
  assert.equal(rows.safe.no_trade.pick, 'no_trade');
  // No plan fits -> no trade, with the reason.
  const none = compareModes([], ctxFor);
  for (const r of none) { assert.equal(r.no_trade.pick, 'no_trade'); assert.match(r.no_trade.why, /No plan fits/); }
  // A losing plan -> no trade.
  const lose = compareModes([plan('2', 0.9, -0.005, 0.001)], ctxFor).find(r => r.mode === 'balanced');
  assert.equal(lose.no_trade.pick, 'no_trade');
});

/* ------------------------------------------------------------ the producer and the contract */

test('planner: risk_modes rows carry no_trade, _run.shrink is shadow, entry validates', () => {
  const a = makeAdapter();
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  assert.equal(res.risk_modes.length, 3);
  for (const r of res.risk_modes) assert.ok(['plan', 'no_trade'].includes(r.no_trade.pick));
  assert.equal(res.shrink.status, 'shadow');
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
  assert.deepEqual(validateLeague(entry).errors, []);
  for (const r of entry.risk_modes.value) {
    assert.equal(r.no_trade.expected.value, 0);
    assert.equal(r.no_trade.p_complete.value, 1);
    assert.ok(['plan', 'no_trade'].includes(r.no_trade.pick));
  }
  assert.equal(entry._run.shrink.status, 'shadow');
});

/* ------------------------------------------------------------ review fixes (PR #383 review) */

test('review 1: the pick agrees with the served move in every mode (priced on the confirm dice)', () => {
  for (const mode of MODES) {
    const res = planLeague(makeAdapter(), { objective: normaliseObjective({ risk_mode: mode }) });
    const row = res.risk_modes.find(r => r.mode === mode);
    assert.equal(row.no_trade.pick, res.best ? 'plan' : 'no_trade',
      `${mode}: served move ${res.best ? 'present' : 'absent'} but pick ${row.no_trade.pick}`);
    // A served move beats doing nothing under its own mode on the confirm dice.
    if (res.best) assert.ok(res.best.score > 0, `${mode}: served best scores ${res.best.score}`);
    for (const c of res.deck) assert.ok(c.score > 0, `${mode}: a deck card scores ${c.score}`);
  }
});

test('review 1: Safe never serves a move whose own score is at or below doing nothing', () => {
  const res = planLeague(makeAdapter(), { objective: normaliseObjective({ risk_mode: 'safe' }) });
  const row = res.risk_modes.find(r => r.mode === 'safe');
  assert.ok(!(res.best && row.no_trade.pick === 'no_trade'));
});

test('review 2: a best plan without an SE makes reorders unknown, never a false true', () => {
  const noSe = plan('2', 1, 0.05, null), b = plan('3', 1, 0.01, 0.001), c = plan('4', 1, 0.02, 0.001);
  const bal = shadowShrink([noSe, b, c], ctxFor).modes.find(m => m.mode === 'balanced');
  assert.equal(bal.best, '2|1|20');
  assert.equal(bal.reorders, null);
});

test('review 3: all-in shrinks the if-it-lands gain with its own prior and the last step SE', () => {
  const shot = plan('2', 0.1, 0.2, 0.1), sure = plan('3', 1, 0.01, 0.001);
  const pool = [shot, sure];
  const sh = shadowShrink(pool, ctxFor);
  const ai = sh.modes.find(m => m.mode === 'all_in');
  const pf = shrinkPrior([{ expected: 0.2, expected_se: 0.1 }, { expected: 0.01, expected_se: 0.001 }]);
  assert.equal(ai.best, '2|1|20');
  close(ai.best_shrunk_if_complete, 0.2 * pf.tau2 / (pf.tau2 + 0.01), 1e-12);
  assert.ok(ai.best_shrunk_if_complete < 0.2 * 0.6, 'a 0.1-SE landing gain is shrunk hard, not ~1%');
});

test('review minor: an exact gain (se 0) is not shrunk, even with tau^2 = 0', () => {
  assert.equal(shrinkFactor(0, 0), 1);
  assert.equal(shrinkFactor(0, 0.0004), 1);
});
