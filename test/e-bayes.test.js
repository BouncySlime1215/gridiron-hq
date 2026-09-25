/**
 * E-BAYES (shadow): pooled hierarchical acceptance model, per manager with partial pooling across
 * leagues, graded forward against the served blend. It never moves a served number.
 * Pre-registration: docs/tdd/2026-09-25-e-bayes.tdd.md. Made-up leagues, teams and offers only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const E = await import('../server/services/eval/e-bayes.js');
const { pYesFor, pYesTableFrom, pYesBasis, stepPYes } = await import('../server/services/p-yes.js');
const { minOffersToDecide } = await import('../server/services/eval/e1.js');

const NOW = Date.UTC(2026, 9, 1);
const day = d => new Date(Date.UTC(2026, 8, d)).toISOString();
const offer = (league, team, d, y) =>
  ({ league_id: league, counterparty_team_id: team, proposed_at: day(d), resolved_at: day(d + 1), y });
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* ------------------------------------------------------------ the model */

test('no data: everyone gets the global prior 0.5', () => {
  const m = E.fitPooled([], { now: NOW });
  const r = E.predict(m, '4', '2');
  assert.equal(r.p, 0.5);
  assert.equal(r.level, 'global');
  assert.equal(r.n, 0);
});

test('posterior mean is the hand-computed beta-binomial with fixed kappas', () => {
  // League 4: team 2 said yes 1 of 3, team 3 said yes 1 of 1. League 1: 0 of 2.
  const offers = [offer('4', '2', 1, 1), offer('4', '2', 2, 0), offer('4', '2', 3, 0), offer('4', '3', 4, 1),
    offer('1', '5', 5, 0), offer('1', '5', 6, 0)];
  const m = E.fitPooled(offers, { now: NOW, kappa: { league: 10, manager: 4 } });
  const muG = (2 + 1) / (6 + 2);
  const muL = (2 + 10 * muG) / (4 + 10);
  assert.ok(near(m.global.mu, muG));
  assert.ok(near(m.leagues.get('4').mu, muL));
  assert.ok(near(E.predict(m, '4', '2').p, (1 + 4 * muL) / (3 + 4)));
  assert.equal(E.predict(m, '4', '2').level, 'manager');
});

test('partial pooling: 0 of 1 is pulled toward the league, not to 0 and not left at the league rate', () => {
  const offers = [offer('4', '2', 1, 1), offer('4', '2', 2, 1), offer('4', '3', 3, 0)];
  const m = E.fitPooled(offers, { now: NOW });
  const p = E.predict(m, '4', '3').p;
  const muL = m.leagues.get('4').mu;
  assert.ok(p > 0.02 && p < muL, `p ${p} vs league ${muL}`);
});

test('unseen manager gets the league rate; unseen league gets the global rate', () => {
  const offers = [offer('4', '2', 1, 1), offer('4', '2', 2, 1), offer('1', '5', 3, 0)];
  const m = E.fitPooled(offers, { now: NOW });
  const u = E.predict(m, '4', '9');
  assert.equal(u.level, 'league');
  assert.ok(near(u.p, m.leagues.get('4').mu));
  const g = E.predict(m, '7', '9');
  assert.equal(g.level, 'global');
  assert.ok(near(g.p, m.global.mu));
});

test('no future leak: an answer resolved at or after the cutoff is not read', () => {
  const offers = [offer('4', '2', 1, 1), offer('4', '2', 10, 0)]; // second resolves day 11
  const before = E.fitPooled(offers, { now: Date.parse(day(11)) });
  assert.equal(before.global.n, 1);
  const after = E.fitPooled(offers, { now: Date.parse(day(11)) + 1 });
  assert.equal(after.global.n, 2);
  // An unresolved offer (no y) is never counted.
  const open = E.fitPooled([{ league_id: '4', counterparty_team_id: '2', proposed_at: day(1) }], { now: NOW });
  assert.equal(open.global.n, 0);
});

test('fitted kappa tracks the data: split managers fit a smaller kappa than identical ones', () => {
  const split = [], same = [];
  let d = 1;
  for (let k = 0; k < 12; k++) {
    split.push(offer('4', 'a', d, 1), offer('4', 'b', d, 0), offer('1', 'c', d, 1), offer('1', 'e', d++, 0));
    same.push(offer('4', 'a', d, k % 2), offer('4', 'b', d, (k + 1) % 2), offer('1', 'c', d, k % 2), offer('1', 'e', d++, (k + 1) % 2));
  }
  const ks = E.fitPooled(split, { now: NOW }).kappa.manager;
  const kh = E.fitPooled(same, { now: NOW }).kappa.manager;
  assert.ok(ks < kh, `split ${ks} vs same ${kh}`);
  assert.ok(ks <= 2, `split managers should barely pool, got ${ks}`);
});

test('kappa falls back to the fixed default with fewer than two groups', () => {
  const m = E.fitPooled([offer('4', '2', 1, 1)], { now: NOW });
  assert.equal(m.kappa.league, E.DEFAULT_KAPPA.league);
  assert.equal(m.kappa.manager, E.DEFAULT_KAPPA.manager);
});

/* ------------------------------------------------------------ the forward grade */

test('gradeForward: each offer is scored only on answers before its proposal', () => {
  const offers = [offer('4', '2', 1, 1), offer('4', '2', 3, 1), offer('4', '3', 5, 0)];
  const g = E.gradeForward(offers);
  assert.equal(g.n, 3);
  // First offer: nothing known yet, so E-BAYES says 0.5.
  assert.ok(near(g.rows[0].p.e_bayes, 0.5));
  // Second: fitted on the first only.
  const m = E.fitPooled(offers, { now: Date.parse(offers[1].proposed_at) });
  assert.ok(near(g.rows[1].p.e_bayes, E.predict(m, '4', '2').p));
  for (const r of g.rows) for (const k of ['e_bayes', 'blend', 'baseline']) assert.ok(r.p[k] > 0 && r.p[k] < 1);
});

test('gradeForward verdict: never PASS below the decisive n; the CS rule decides', () => {
  const few = E.gradeForward([offer('4', '2', 1, 1), offer('4', '2', 3, 1)]);
  assert.equal(few.verdict, 'not_decided');
  assert.equal(few.min_n, minOffersToDecide());
  assert.equal(E.verdictOf({ n: 1000, ci: [0.02, 0.05], gain: 0.03 }), 'pass');
  assert.equal(E.verdictOf({ n: 1000, ci: [0.001, 0.01], gain: 0.005 }), 'not_decided'); // below MIN_GAIN
  assert.equal(E.verdictOf({ n: 1000, ci: [-0.05, -0.01], gain: -0.03 }), 'fail');
  assert.equal(E.verdictOf({ n: 1000, ci: [-0.01, 0.02], gain: 0.005 }), 'not_decided');
  assert.equal(E.verdictOf({ n: 3, ci: [0.02, 0.05], gain: 0.03 }), 'not_decided');
  assert.equal(E.verdictOf({ n: 0, ci: null, gain: null }), 'not_decided');
});

/* ------------------------------------------------------------ shadow: nothing served moves */

const POOL = [offer('4', '2', 1, 1), offer('4', '2', 2, 0), offer('4', '3', 3, 0), offer('1', '5', 4, 1),
  offer('4', '2', 5, 1), offer('4', '3', 6, 0)];

test('flag reader: on only when GRIDIRON_EBAYES_SHADOW is exactly 1; preview mode does not turn it on', () => {
  assert.equal(E.eBayesShadowOn({}), false);
  assert.equal(E.eBayesShadowOn({ GRIDIRON_EBAYES_SHADOW: 'true' }), false);
  assert.equal(E.eBayesShadowOn({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false);
  assert.equal(E.eBayesShadowOn({ GRIDIRON_EBAYES_SHADOW: '1' }), true);
});

test('flag on: the table carries shadow_e_bayes; every served field is identical to flag off', () => {
  for (const mode of ['blend', 'baseline']) {
    const off = pYesTableFrom(POOL, '4', ['2', '3', '8'], { now: NOW, mode, env: {} });
    const on = pYesTableFrom(POOL, '4', ['2', '3', '8'], { now: NOW, mode, env: { GRIDIRON_EBAYES_SHADOW: '1' } });
    assert.equal(off.shadow_e_bayes, undefined);
    assert.ok(on.shadow_e_bayes.byTeam.get('2').p > 0);
    assert.equal(on.shadow_e_bayes.byTeam.get('8').level, 'league');
    assert.deepEqual(pYesBasis(on), pYesBasis(off));
    for (const team of ['2', '3', '8']) {
      for (const edge of [{ passes: true }, { passes: false }]) {
        const a = pYesFor({ counterparty: { counterparty_data: true }, edge, team, table: off, on: true });
        const b = pYesFor({ counterparty: { counterparty_data: true }, edge, team, table: on, on: true });
        assert.deepEqual(b, a);
        assert.deepEqual(stepPYes(b), stepPYes(a));
        assert.equal(JSON.stringify(b).includes('e_bayes'), false);
      }
    }
  }
});
