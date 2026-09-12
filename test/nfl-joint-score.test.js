/**
 * Tests for the score-driven joint scoring model.
 *
 * Three kinds of claim live in this module and they need different proof.
 *
 * THE DISTRIBUTION CLAIMS are pinned against closed forms that exist
 * independently of this repository. If every scoring event is worth exactly one
 * point the compound machinery must collapse onto the textbook bivariate
 * Poisson, its margin must collapse onto the Skellam, and its covariance must
 * equal lambda_c exactly. Those are the strongest checks available: three
 * separate published formulas have to agree with three separate code paths
 * (Panjer recursion, shared-shock mixture, joint summary) at machine precision,
 * and no plausible bug survives all of them.
 *
 * THE GRADIENT CLAIM is the one the whole model hangs on, because the GAS
 * update IS the gradient. It is checked twice over: analytically, since for a
 * plain Poisson the score must reduce exactly to (observed - expected), and
 * numerically by central difference in the compound case where no closed form
 * is available. A wrong gradient would still produce a model that fits and
 * forecasts — just a worse one, silently — which is precisely the kind of bug
 * a passing backtest does not catch.
 *
 * THE ESTIMATION CLAIMS are known-answer: data is simulated from the model's
 * own process with parameters this file chose, and the fit has to find them
 * back. A recovery test whose true parameters are the optimiser's own starting
 * point proves nothing, so every target here is deliberately away from
 * `defaultStart()`.
 *
 * What is NOT tested here is whether any of this describes football. It cannot
 * be: the only populated database is out of reach of this suite and the fixture
 * is synthetic. See docs/evidence/2026-09-12/JOINT-SCORING-STAGE-3.md.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-joint-score-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run, dbPath } = await import('../server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH,
  'a joint-score test must never be able to reach the real database');
await (await import('../server/db/migrate.js')).runMigrations();
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const jsm = await import('../server/services/nfl-joint-score.js');
const {
  SEVERITY_VALUES, DEFAULT_SEVERITY, MAX_SCORE,
  besselIScaled, lgamma, skellamPmf, bivariatePoissonPmf,
  compoundPoissonPmf, jointScorePmf, jointSummary, coverProbabilityFromMargin,
  gameGradients, runFilter, nelderMead, fitSeverity, softmaxSeverity,
  fitJointScoreModel, forecastGame, defaultStart, packParams, unpackParams
} = jsm;

const bt = await import('../server/services/joint-score-backtest.js');
const {
  discreteCrps, logScore, empiricalMarginPmf, scoreSet, compareOn,
  fitAnchorWeight, expectedSeverity, intersect
} = bt;

/** Every scoring event worth one point: the model's degenerate Poisson case. */
const UNIT = SEVERITY_VALUES.map(v => (v === 1 ? 1 : 0));

/** Deterministic PRNG, so a failing test fails the same way twice. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const poisson = (rand, lambda) => {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
};
const drawSeverity = (rand, severity) => {
  let u = rand();
  for (let i = 0; i < SEVERITY_VALUES.length; i++) {
    u -= severity[i];
    if (u <= 0) return SEVERITY_VALUES[i];
  }
  return SEVERITY_VALUES.at(-1);
};

/* ==================================================== distribution identities */

test('special functions agree with their defining values', () => {
  // lgamma(n) = log((n-1)!)
  assert.ok(Math.abs(lgamma(1)) < 1e-12);
  assert.ok(Math.abs(lgamma(5) - Math.log(24)) < 1e-10);
  assert.ok(Math.abs(lgamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-10);
  // I_0(0) = 1, I_n(0) = 0 for n > 0.
  assert.equal(besselIScaled(0, 0), 1);
  assert.equal(besselIScaled(3, 0), 0);
  // exp(-x) I_0(x) is decreasing in x and stays in (0, 1].
  assert.ok(besselIScaled(0, 2) < 1 && besselIScaled(0, 2) > 0);
  assert.ok(besselIScaled(0, 5) < besselIScaled(0, 2));
});

test('with unit severity the joint collapses onto the textbook bivariate Poisson', () => {
  // The single strongest check in this file: Panjer recursion, shared-shock
  // mixture and the ladder all have to conspire to reproduce a closed form that
  // is computed by a completely different route (a binomial convolution sum).
  for (const [l1, l2, l3] of [[2.3, 1.7, 0.6], [4.0, 4.0, 0.0], [1.0, 6.0, 1.4]]) {
    const joint = jointScorePmf(l1, l2, l3, UNIT, { maxScore: 30 });
    let worst = 0;
    for (let x = 0; x <= 16; x++) {
      for (let y = 0; y <= 16; y++) {
        worst = Math.max(worst, Math.abs(joint.at(x, y) - bivariatePoissonPmf(x, y, l1, l2, l3)));
      }
    }
    assert.ok(worst < 1e-12, `bivariate Poisson mismatch ${worst} at (${l1}, ${l2}, ${l3})`);
  }
});

test('with unit severity the margin collapses onto the Skellam, and lambda_c cancels', () => {
  const l1 = 2.3, l2 = 1.7;
  // The textbook identity: the common shock does not appear in the margin law
  // of a bivariate Poisson. Two very different lambda_c must give the same
  // margin distribution, and both must equal Skellam(l1, l2).
  const summaries = [0.0, 1.1].map(l3 =>
    jointSummary(jointScorePmf(l1, l2, l3, UNIT, { maxScore: 40 })));
  for (const s of summaries) {
    for (let d = -12; d <= 12; d++) {
      const got = s.margin_pmf[d + s.margin_offset];
      assert.ok(Math.abs(got - skellamPmf(d, l1, l2)) < 1e-12,
        `Skellam mismatch at d=${d}: ${got} vs ${skellamPmf(d, l1, l2)}`);
    }
  }
  for (let d = -12; d <= 12; d++) {
    assert.ok(Math.abs(summaries[0].margin_pmf[d + summaries[0].margin_offset]
      - summaries[1].margin_pmf[d + summaries[1].margin_offset]) < 1e-12,
    'lambda_c must not move the unit-severity margin');
  }
});

test('covariance equals lambda_c times E[V] squared, which is the dependence mechanism', () => {
  const ev = expectedSeverity(DEFAULT_SEVERITY);

  // Independence must be EXACT, not approximate. This is the assertion that
  // caught the un-normalised-grid bug: before `jointSummary` renormalised, an
  // exactly independent pair reported a covariance of +0.076, which would have
  // been published as this model's same-game correlation.
  for (const severity of [DEFAULT_SEVERITY, UNIT]) {
    const s = jointSummary(jointScorePmf(3.9, 4.4, 0, severity, { maxScore: MAX_SCORE }));
    assert.ok(Math.abs(s.covariance) < 1e-9, `independent scores must have zero covariance, got ${s.covariance}`);
    assert.ok(Math.abs(s.correlation) < 1e-9);
  }

  // With dependence, the covariance is the theoretical one MINUS whatever the
  // score grid truncates. Covariance is a second moment, so it loses far more
  // to the tail than the mean does, and the size of that loss is asserted here
  // rather than tolerated silently: under 1% at an inflated rate, and an order
  // of magnitude smaller at a realistic NFL one.
  const shortfall = (lh, la, l3) => {
    const s = jointSummary(jointScorePmf(lh, la, l3, DEFAULT_SEVERITY, { maxScore: MAX_SCORE }));
    return (l3 * ev * ev - s.covariance) / (l3 * ev * ev);
  };
  // Measured: 57.6 combined points loses 2.46%, 43.2 loses 0.26%, 39.9 loses
  // 0.13%. So at the rates football actually produces, the reported same-game
  // correlation is understated by about a quarter of one percent.
  const inflated = shortfall(3.9, 4.4, 1.2);   // ~57.6 combined points per game
  const realistic = shortfall(3.6, 3.6, 0.4);  // ~43.2, the real NFL scoring rate
  assert.ok(inflated > 0 && inflated < 0.03,
    `grid truncation should cost under 3% of the covariance at an inflated rate, cost ${inflated}`);
  assert.ok(realistic > 0 && realistic < 0.005,
    `and under half a percent at a realistic rate, got ${realistic}`);
  assert.ok(realistic < inflated / 5,
    'and the loss must fall steeply as the scoring rate drops, or the grid is too tight');
});

test('the compound Poisson has the mean and variance the compounding implies', () => {
  // This is the decision the whole model turns on: points are overdispersed
  // relative to a Poisson by exactly E[V^2]/E[V], and if that arithmetic were
  // wrong the distribution would be confidently the wrong width.
  const lambda = 4.3;
  const ev = expectedSeverity(DEFAULT_SEVERITY);
  const ev2 = SEVERITY_VALUES.reduce((s, v, i) => s + v * v * DEFAULT_SEVERITY[i], 0);
  const pmf = compoundPoissonPmf(lambda, DEFAULT_SEVERITY, MAX_SCORE);
  let mass = 0, m1 = 0, m2 = 0;
  for (let s = 0; s <= MAX_SCORE; s++) { mass += pmf[s]; m1 += s * pmf[s]; m2 += s * s * pmf[s]; }
  // The grid stops at MAX_SCORE, so the moments are the truncated ones. The
  // shortfall is asserted to be small rather than zero, because pretending a
  // truncated distribution is complete is how a tail error becomes invisible.
  assert.ok(mass > 1 - 2e-4 && mass <= 1, `pmf mass ${mass}`);
  assert.ok(Math.abs(m1 - lambda * ev) / (lambda * ev) < 1e-3, `mean ${m1} != ${lambda * ev}`);
  assert.ok(Math.abs((m2 - m1 * m1) - lambda * ev2) / (lambda * ev2) < 5e-3,
    `variance ${m2 - m1 * m1} != ${lambda * ev2}`);
  // And the whole point of the design: the variance/mean ratio is far above 1,
  // where a Poisson on points would force it to be exactly 1.
  assert.ok((m2 - m1 * m1) / m1 > 3.5,
    'a points-level Poisson would be dispersion 1; the compound layer exists to avoid that');
});

test('a score of 1 is reachable only through the escape-hatch severity value', () => {
  // Real football cannot produce a score of 1. With P(V=1) forced to zero the
  // model must say so exactly, which is what makes the fitted P(V=1) a usable
  // diagnostic of whether a data source is on the football lattice.
  const lattice = [0, 0.03, 0.37, 0.05, 0.51, 0.04];
  const total = lattice.reduce((s, v) => s + v, 0);
  const pmf = compoundPoissonPmf(4.2, lattice.map(v => v / total), 20);
  assert.equal(pmf[1], 0, 'score 1 must be impossible when P(V=1) = 0');
  assert.ok(pmf[3] > 0 && pmf[7] > 0 && pmf[5] > 0, 'but 3, 5 and 7 must all be reachable');
});

/* ============================================================== the gradient */

test('for a plain Poisson the score reduces exactly to observed minus expected', () => {
  // The reassurance that the GAS update generalises the obvious update rule.
  for (const [x, y, l1, l2] of [[5, 2, 2.3, 1.7], [0, 9, 4.0, 3.1], [12, 12, 5.5, 5.5]]) {
    const g = gameGradients(x, y, l1, l2, 1e-9, UNIT);
    assert.ok(Math.abs(g.uHome - (x - l1)) < 1e-6, `uHome ${g.uHome} != ${x - l1}`);
    assert.ok(Math.abs(g.uAway - (y - l2)) < 1e-6, `uAway ${g.uAway} != ${y - l2}`);
  }
});

test('the compound-case gradient matches a central difference of the log-likelihood', () => {
  // No closed form exists here, so the check is numerical. A wrong gradient
  // still produces a model that fits and forecasts, just a worse one, which is
  // exactly the bug a passing backtest would not catch.
  const eps = 1e-5;
  for (const [x, y, lh, la, lc] of [[24, 17, 4.3, 3.8, 0.4], [3, 31, 2.0, 5.6, 0.9], [0, 0, 4.0, 4.0, 0.2]]) {
    const g = gameGradients(x, y, lh, la, lc, DEFAULT_SEVERITY);
    const up = gameGradients(x, y, lh * Math.exp(eps), la, lc, DEFAULT_SEVERITY).logLik;
    const down = gameGradients(x, y, lh * Math.exp(-eps), la, lc, DEFAULT_SEVERITY).logLik;
    const numeric = (up - down) / (2 * eps);
    assert.ok(Math.abs(numeric - g.uHome) < 1e-4 * Math.max(1, Math.abs(numeric)),
      `d/dlog lambda_home: analytic ${g.uHome} vs numeric ${numeric}`);

    const aUp = gameGradients(x, y, lh, la * Math.exp(eps), lc, DEFAULT_SEVERITY).logLik;
    const aDown = gameGradients(x, y, lh, la * Math.exp(-eps), lc, DEFAULT_SEVERITY).logLik;
    const aNumeric = (aUp - aDown) / (2 * eps);
    assert.ok(Math.abs(aNumeric - g.uAway) < 1e-4 * Math.max(1, Math.abs(aNumeric)),
      `d/dlog lambda_away: analytic ${g.uAway} vs numeric ${aNumeric}`);
  }
});

test('the gradient has the sign a rating update needs', () => {
  // Scoring more than expected must push the attack up; scoring less must push
  // it down. A sign error here would train every rating backwards.
  const over = gameGradients(38, 20, 4.3, 4.3, 0.4, DEFAULT_SEVERITY);
  const under = gameGradients(6, 20, 4.3, 4.3, 0.4, DEFAULT_SEVERITY);
  assert.ok(over.uHome > 0, 'a blowout win on offence must raise the home attack');
  assert.ok(under.uHome < 0, 'a shutout-ish performance must lower it');
});

test('the log-likelihood of the joint pmf agrees with the gradient routine', () => {
  // Two code paths compute the same number by different routes: the full
  // matrix, and the truncated single-cell ladder the fit actually uses. They
  // must agree, or the fit is optimising something other than what it reports.
  for (const [x, y] of [[24, 17], [0, 3], [45, 38]]) {
    const joint = jointScorePmf(4.3, 3.8, 0.4, DEFAULT_SEVERITY, { maxScore: MAX_SCORE });
    const direct = Math.log(joint.at(x, y));
    const viaGradients = gameGradients(x, y, 4.3, 3.8, 0.4, DEFAULT_SEVERITY).logLik;
    assert.ok(Math.abs(direct - viaGradients) < 1e-9, `${direct} vs ${viaGradients} at (${x}, ${y})`);
  }
});

/* ============================================================== the optimiser */

test('Nelder-Mead finds a known minimum away from its starting point', () => {
  // Rosenbrock: minimum at (1, 1), value 0, and famously awkward.
  const rosenbrock = ([x, y]) => (1 - x) ** 2 + 100 * (y - x * x) ** 2;
  const fit = nelderMead(rosenbrock, [-1.2, 1], { maxIterations: 4000, tolerance: 1e-12 });
  assert.ok(Math.abs(fit.x[0] - 1) < 1e-3 && Math.abs(fit.x[1] - 1) < 1e-3,
    `found (${fit.x}) rather than (1, 1)`);
  assert.ok(fit.value < 1e-6);
});

test('the parameter links round-trip', () => {
  const target = { mu: 1.4, eta: 0.08, lambdaC: 0.42, aAttack: 0.031, bAttack: 0.94,
    aDefence: 0.019, bDefence: 0.88, seasonCarry: 0.63 };
  const back = unpackParams(packParams(target));
  for (const [k, v] of Object.entries(target)) {
    assert.ok(Math.abs(back[k] - v) < 1e-10, `${k}: ${back[k]} != ${v}`);
  }
});

/* ============================================================= known answers */

test('the severity fit recovers a value distribution it was not started at', () => {
  // The default start is a football-shaped prior. The truth here is
  // deliberately NOT that: it is field-goal heavy, so a fit that simply returns
  // its starting point fails.
  const truth = [0, 0.02, 0.70, 0.04, 0.20, 0.04];
  const rand = mulberry32(4242);
  const scores = [];
  for (let i = 0; i < 6000; i++) {
    let s = 0;
    const n = poisson(rand, 5.0);
    for (let k = 0; k < n; k++) s += drawSeverity(rand, truth);
    scores.push(Math.min(s, MAX_SCORE));
  }
  const fit = fitSeverity(scores, { maxIterations: 3000 });
  assert.ok(fit.fitted);
  assert.ok(Math.abs(fit.lambda - 5.0) < 0.6, `lambda ${fit.lambda} != 5.0`);
  // Field goals must come back as the dominant event, and touchdowns second.
  const fg = fit.severity[SEVERITY_VALUES.indexOf(3)];
  const td = fit.severity[SEVERITY_VALUES.indexOf(7)];
  assert.ok(fg > 0.55 && fg < 0.85, `P(V=3) recovered as ${fg}, truth 0.70`);
  assert.ok(td > 0.10 && td < 0.32, `P(V=7) recovered as ${td}, truth 0.20`);
  assert.ok(fg > td, 'the recovered distribution must be field-goal heavy like the truth');
});

test('the severity fit reports a lattice violation instead of hiding it', () => {
  // The escape-hatch value exists so the likelihood stays finite off the
  // football lattice, and so that the fit SAYS SO when it is off it. A score of
  // exactly 1 is unreachable from {2, 3, 6, 7, 8}, so a source that produces
  // ones must force mass onto V = 1 — which is exactly what happened when this
  // model was pointed at the repository's Gaussian fixture, where P(V=1) came
  // back at 0.14 and P(V=7) at 0.
  const rand = mulberry32(99);
  const lattice = [], withOnes = [];
  for (let i = 0; i < 4000; i++) {
    let s = 0;
    const n = poisson(rand, 4.2);
    const onLatticeSeverity = [0, 0.03, 0.37, 0.05, 0.51, 0.04];
    const norm = onLatticeSeverity.reduce((acc, v) => acc + v, 0);
    for (let k = 0; k < n; k++) s += drawSeverity(rand, onLatticeSeverity.map(v => v / norm));
    lattice.push(Math.min(s, MAX_SCORE));
    withOnes.push(rand() < 0.3 ? 1 : Math.min(s, MAX_SCORE));
  }
  const onLattice = fitSeverity(lattice, { maxIterations: 2000 });
  const offLattice = fitSeverity(withOnes, { maxIterations: 2000 });
  assert.ok(onLattice.severity[0] < 0.05,
    `lattice data should need almost no P(V=1), got ${onLattice.severity[0]}`);
  assert.ok(offLattice.severity[0] > 0.1,
    `data containing an impossible score must push real mass onto V=1, got ${offLattice.severity[0]}`);
  assert.ok(offLattice.severity[0] > onLattice.severity[0] + 0.05,
    'and it must be clearly distinguishable from a clean lattice source');
});

test('the filter recovers team strengths it was never told', () => {
  // A known-answer test for the GAS recursion: two teams are given true
  // attacking strengths far apart, and the filter must rank them correctly
  // having seen nothing but scores.
  const severity = DEFAULT_SEVERITY;
  const rand = mulberry32(7);
  const teams = ['STRONG', 'MID', 'WEAK'];
  const trueAttack = { STRONG: 0.32, MID: 0, WEAK: -0.32 };
  const games = [];
  for (let week = 1; week <= 300; week++) {
    for (const [h, a] of [['STRONG', 'MID'], ['MID', 'WEAK'], ['STRONG', 'WEAK']]) {
      const lh = Math.exp(Math.log(4.3) + trueAttack[h]);
      const la = Math.exp(Math.log(4.3) + trueAttack[a]);
      const draw = lam => {
        let s = 0;
        const n = poisson(rand, lam);
        for (let k = 0; k < n; k++) s += drawSeverity(rand, severity);
        return Math.min(s, MAX_SCORE);
      };
      games.push({ season: 2000 + Math.floor(week / 20), week, home: h, away: a,
        home_score: draw(lh), away_score: draw(la) });
    }
  }
  const theta = packParams({ mu: Math.log(4.3), eta: 0, lambdaC: 0.01,
    aAttack: 0.02, bAttack: 0.995, aDefence: 0.02, bDefence: 0.995, seasonCarry: 1 });
  const { states, n } = runFilter(games, theta, severity, { scaling: 'unit' });
  assert.equal(n, games.length);
  const a = t => states.attack.get(t) ?? 0;
  assert.ok(a('STRONG') > a('MID'), `STRONG ${a('STRONG')} should exceed MID ${a('MID')}`);
  assert.ok(a('MID') > a('WEAK'), `MID ${a('MID')} should exceed WEAK ${a('WEAK')}`);
  assert.ok(a('STRONG') - a('WEAK') > 0.2,
    `the filter should recover most of the 0.64 true spread, got ${a('STRONG') - a('WEAK')}`);
});

test('the fit recovers dynamic parameters simulated from its own process', () => {
  // Data generated by the model itself, with a home edge and a shared shock
  // this file chose. Both must come back. The targets are away from
  // defaultStart() so that returning the starting point fails.
  const severity = DEFAULT_SEVERITY;
  const truth = { mu: Math.log(4.1), eta: 0.14, lambdaC: 0.7 };
  const rand = mulberry32(20260912);
  const teams = ['A', 'B', 'C', 'D', 'E', 'F'];
  const attack = new Map(teams.map((t, i) => [t, (i - 2.5) * 0.09]));
  const games = [];
  // 150 weeks x 3 games is enough to identify these three parameters to the
  // tolerances asserted below, and keeps this file from dominating the suite's
  // wall clock. Raising it tightens the recovery but buys no extra assurance.
  for (let week = 1; week <= 150; week++) {
    for (let p = 0; p < 3; p++) {
      const h = teams[(p + week) % 6], a = teams[(p + week + 3) % 6];
      if (h === a) continue;
      const lh = Math.exp(truth.mu + truth.eta + attack.get(h));
      const la = Math.exp(truth.mu + attack.get(a));
      const shared = poisson(rand, truth.lambdaC);
      const draw = lam => {
        let s = 0;
        const n = poisson(rand, lam) + shared;
        for (let k = 0; k < n; k++) s += drawSeverity(rand, severity);
        return Math.min(s, MAX_SCORE);
      };
      games.push({ season: 2000 + Math.floor((week - 1) / 20), week, home: h, away: a,
        home_score: draw(lh), away_score: draw(la) });
    }
  }
  // One scaling, not all three: this test is about whether the eight static
  // parameters are identified, and searching the scaling family as well triples
  // the runtime without touching that question. Scaling selection is exercised
  // end-to-end by the walk-forward report instead.
  const model = fitJointScoreModel(games, { severity, maxIterations: 350, scalings: ['unit'] });
  // mu shifts to absorb the shared shock's contribution to the mean, so the
  // identified quantity is the total expected rate, not mu alone.
  const totalRate = Math.exp(model.params.mu) + model.params.lambdaC;
  assert.ok(Math.abs(totalRate - (Math.exp(truth.mu) + truth.lambdaC)) < 0.6,
    `expected scoring rate ${totalRate} != ${Math.exp(truth.mu) + truth.lambdaC}`);
  assert.ok(model.params.eta > 0.05 && model.params.eta < 0.25,
    `home edge recovered as ${model.params.eta}, truth 0.14`);
  assert.ok(model.params.lambdaC > 0.2,
    `a genuine shared shock of 0.7 must not be fitted away to zero, got ${model.params.lambdaC}`);
});

test('a league generated with NO shared shock is not given one', () => {
  // The other half of the previous test, and the more important half: the model
  // must be able to say "no dependence here". Without this, a positive
  // lambda_c would be an artefact of the parametrisation rather than a finding.
  const severity = DEFAULT_SEVERITY;
  const rand = mulberry32(31337);
  const teams = ['A', 'B', 'C', 'D'];
  const games = [];
  for (let week = 1; week <= 150; week++) {
    for (const [h, a] of [[teams[0], teams[1]], [teams[2], teams[3]]]) {
      const draw = lam => {
        let s = 0;
        const n = poisson(rand, lam);
        for (let k = 0; k < n; k++) s += drawSeverity(rand, severity);
        return Math.min(s, MAX_SCORE);
      };
      games.push({ season: 2000 + Math.floor((week - 1) / 20), week, home: h, away: a,
        home_score: draw(4.3), away_score: draw(4.3) });
    }
  }
  const model = fitJointScoreModel(games, { severity, maxIterations: 300, scalings: ['unit'] });
  assert.ok(model.params.lambdaC < 0.25,
    `independent scores must not produce a large shared shock, got ${model.params.lambdaC}`);
});

/* ================================================================= no lookahead */

test('a forecast cannot depend on its own result or on any later one', () => {
  // The property that makes the whole walk-forward meaningful. The filter is
  // run twice on histories that are identical up to game k and arbitrary after
  // it; every forecast up to and including k must be bit-identical.
  const severity = DEFAULT_SEVERITY;
  const theta = defaultStart();
  const base = [];
  const rand = mulberry32(555);
  for (let i = 0; i < 200; i++) {
    base.push({ season: 2000 + Math.floor(i / 40), week: (i % 40) + 1,
      home: `H${i % 7}`, away: `A${i % 5}`,
      home_score: Math.round(rand() * 40), away_score: Math.round(rand() * 40) });
  }
  const tampered = base.map((g, i) => (i >= 120 ? { ...g, home_score: 59, away_score: 0 } : g));

  const collect = list => {
    const out = [];
    runFilter(list, theta, severity, {
      scaling: 'unit',
      onPredict: (g, p) => out.push(`${g.season}|${g.week}|${p.lambdaHome.toFixed(12)}|${p.lambdaAway.toFixed(12)}`)
    });
    return out;
  };
  const a = collect(base), b = collect(tampered);
  assert.equal(a.length, b.length);
  for (let i = 0; i <= 120; i++) {
    assert.equal(a[i], b[i], `forecast ${i} changed when only games from 120 onward were altered`);
  }
  assert.notEqual(a[199], b[199], 'and the later forecasts must actually have moved, or the test is vacuous');
});

/* ============================================================ scoring rules */

test('discrete CRPS has its known values', () => {
  const offset = 10;
  const point = k => { const p = new Float64Array(21); p[k + offset] = 1; return p; };
  // A point mass on the truth scores zero; a point mass k away scores k.
  assert.ok(Math.abs(discreteCrps(point(0), offset, 0)) < 1e-12);
  assert.ok(Math.abs(discreteCrps(point(3), offset, 0) - 3) < 1e-12);
  assert.ok(Math.abs(discreteCrps(point(-4), offset, 0) - 4) < 1e-12);
  // And a distribution centred on the truth beats one displaced from it.
  const spread = new Float64Array(21);
  spread[offset - 1] = 0.25; spread[offset] = 0.5; spread[offset + 1] = 0.25;
  assert.ok(discreteCrps(spread, offset, 0) < discreteCrps(point(3), offset, 0));
  assert.ok(discreteCrps(spread, offset, 0) > 0, 'but a spread distribution is not free');
});

test('log score rewards mass on the observed value and floors the impossible', () => {
  const offset = 10;
  const pmf = new Float64Array(21);
  pmf[offset] = 0.5; pmf[offset + 3] = 0.5;
  assert.ok(Math.abs(logScore(pmf, offset, 0) - Math.log(2)) < 1e-12);
  assert.ok(logScore(pmf, offset, 7) > 25, 'an unreachable outcome must be expensive, not infinite');
  assert.ok(Number.isFinite(logScore(pmf, offset, 7)));
});

test('the empirical margin law preserves its mean and its lattice', () => {
  const errors = [-7, -3, 0, 0, 3, 3, 7];
  const law = empiricalMarginPmf(errors, 2.5, 40);
  let mass = 0, m1 = 0;
  for (let i = 0; i < law.pmf.length; i++) { mass += law.pmf[i]; m1 += (i - law.offset) * law.pmf[i]; }
  assert.ok(Math.abs(mass - 1) < 1e-12, `mass ${mass}`);
  const expected = 2.5 + errors.reduce((s, v) => s + v, 0) / errors.length;
  assert.ok(Math.abs(m1 - expected) < 1e-9, `mean ${m1} != ${expected}`);
  // A whole-number forecast must land exactly on the lattice, with no smearing.
  const whole = empiricalMarginPmf(errors, 2, 40);
  assert.ok(Math.abs(whole.pmf[2 + 3 + whole.offset] - 2 / 7) < 1e-12,
    'two of seven errors are +3, so margin 5 must carry exactly 2/7');
});

test('cover probability splits pushes and integrates the margin law', () => {
  const s = jointSummary(jointScorePmf(4.3, 3.9, 0.4, DEFAULT_SEVERITY, { maxScore: MAX_SCORE }));
  // A half-point line has no push, so the two sides must sum to exactly one.
  const over = coverProbabilityFromMargin(s.margin_pmf, s.margin_offset, 2.5);
  const under = 1 - over;
  assert.ok(over > 0 && over < 1 && Math.abs(over + under - 1) < 1e-12);
  // A whole-number line has push mass, and splitting it must leave the two
  // sides summing to one as well.
  const whole = coverProbabilityFromMargin(s.margin_pmf, s.margin_offset, 3);
  const push = s.margin_pmf[3 + s.margin_offset];
  assert.ok(push > 0, 'a whole-number line must have push mass on this lattice');
  // jointSummary renormalises, so the margin law is proper and the push mass
  // needs no further scaling before it is split.
  let marginMass = 0;
  for (let i = 0; i < s.margin_pmf.length; i++) marginMass += s.margin_pmf[i];
  assert.ok(Math.abs(marginMass - 1) < 1e-9, `margin law must be proper, got ${marginMass}`);
  assert.ok(Math.abs(whole - (coverProbabilityFromMargin(s.margin_pmf, s.margin_offset, 3.5) + 0.5 * push)) < 1e-9);
  // Monotone: a bigger number to beat is harder to beat.
  assert.ok(coverProbabilityFromMargin(s.margin_pmf, s.margin_offset, 10.5)
    < coverProbabilityFromMargin(s.margin_pmf, s.margin_offset, -10.5));
});

/* ===================================================== harness safety rails */

test('the anchor weight recovers a shrinkage it was given, with no intercept', () => {
  // A model whose departure from the market is half-right must earn a weight
  // near 0.5; one whose departure is pure noise must earn a weight near zero.
  const rand = mulberry32(808);
  const half = [], noise = [];
  for (let i = 0; i < 1200; i++) {
    const market = (rand() - 0.5) * 10;
    const departure = (rand() - 0.5) * 12;
    half.push({ market, forecast: market + departure, actual: market + 0.5 * departure + (rand() - 0.5) * 8 });
    noise.push({ market, forecast: market + departure, actual: market + (rand() - 0.5) * 8 });
  }
  assert.ok(Math.abs(fitAnchorWeight(half).weight - 0.5) < 0.12,
    `half-right departures should earn ~0.5, got ${fitAnchorWeight(half).weight}`);
  assert.ok(Math.abs(fitAnchorWeight(noise).weight) < 0.12,
    `noise departures should earn ~0, got ${fitAnchorWeight(noise).weight}`);
  assert.equal(fitAnchorWeight(half.slice(0, 10)).weight, null, 'too little data must return no weight');
});

test('the intersection rule really does restrict every entrant to shared games', () => {
  const mk = (s, w, h, a) => ({ season: s, week: w, home: h, away: a, forecast: 0, actual: 0 });
  const out = intersect({
    x: [mk(2024, 1, 'KC', 'BAL'), mk(2024, 2, 'SF', 'SEA')],
    y: [mk(2024, 1, 'KC', 'BAL'), mk(2024, 3, 'GB', 'DET')]
  });
  assert.equal(out.x.length, 1);
  assert.equal(out.y.length, 1);
  assert.equal(out.x[0].week, 1);
  assert.equal(out.y[0].week, 1);
});

test('the degeneracy guards refuse a verdict on differences of size zero', () => {
  // The exact situation that produced a spurious p = 0.0009 on the first run of
  // this bake-off: two forecasts differing in the ninth decimal, consistently.
  // The jitter matters: a PERFECTLY constant difference has zero variance and
  // Diebold-Mariano cannot score it at all, which is a different degeneracy.
  // This is the harder case — a difference that varies, is consistently signed,
  // and is nine orders of magnitude too small to mean anything.
  const a = [], b = [];
  for (let i = 0; i < 300; i++) {
    const e = (i % 17) - 8;
    a.push({ week_key: `2024|${i % 20}`, forecast: e, actual: 0, crps: 1 + i * 1e-3 });
    b.push({ week_key: `2024|${i % 20}`, forecast: e, actual: 0, crps: 1 + i * 1e-3 + 1e-11 * (1 + (i % 7)) });
  }
  const dm = compareOn(a, b, 'crps');
  assert.ok(dm.ok);
  assert.equal(dm.degenerate, 'difference below numerical tolerance',
    'a consistent but vanishing difference must not be reported as a win');
});

test('the degeneracy guards refuse a verdict when one cluster carries everything', () => {
  // The other failure the first run produced: the incumbent departed from the
  // market in exactly one of 51 weeks, and clustered DM returned |DM*| = 1.000.
  const a = [], b = [];
  for (let i = 0; i < 300; i++) {
    const sameWeek = `2024|${i % 30}`;
    const differs = (i % 30) === 4;
    a.push({ week_key: sameWeek, forecast: 0, actual: 0, crps: 5 });
    b.push({ week_key: sameWeek, forecast: 0, actual: 0, crps: differs ? 9 : 5 });
  }
  const dm = compareOn(a, b, 'crps');
  assert.ok(dm.ok);
  assert.ok(String(dm.degenerate).startsWith('difference confined to 1 of'),
    `expected a one-cluster degeneracy, got ${dm.degenerate}`);
});

test('a real, well-spread difference still gets a verdict', () => {
  // The guards must not be a blanket excuse. A difference that is both large
  // and spread across clusters has to come through as significant.
  const rand = mulberry32(4);
  const a = [], b = [];
  for (let i = 0; i < 300; i++) {
    const base = 5 + rand() * 2;
    a.push({ week_key: `2024|${i % 30}`, forecast: 0, actual: 0, crps: base });
    b.push({ week_key: `2024|${i % 30}`, forecast: 0, actual: 0, crps: base + 0.5 + (rand() - 0.5) * 0.4 });
  }
  const dm = compareOn(a, b, 'crps');
  assert.ok(dm.ok);
  assert.equal(dm.degenerate, null, 'the guards must not suppress a real, well-spread difference');
  assert.ok(dm.pTwoSided < 0.01 && dm.statistic < 0);
});

test('scoreSet reports nothing it cannot compute', () => {
  const s = scoreSet([
    { forecast: 1, actual: 0, crps: null, log_score: null, cover_outcome: null, cover_probability: null },
    { forecast: -1, actual: 0, crps: null, log_score: null, cover_outcome: null, cover_probability: null }
  ]);
  assert.equal(s.n, 2);
  assert.equal(s.rmse, 1);
  assert.equal(s.crps, null);
  assert.equal(s.cover_brier, null, 'an ungradeable cover must be null, never 0');
});

/* ============================================================ wiring hygiene */

test('the joint model is not wired into any production path', () => {
  // Stage 3 is evidence, not a shipped forecast. If this ever fails, someone
  // has connected an unvalidated model to a route and the assertion is the
  // reminder that the gate in JOINT-SCORING-STAGE-3.md was never cleared.
  const roots = ['server/routes', 'server/betting', 'client/src'];
  const offenders = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (/\.(?:js|mjs|ts|tsx)$/.test(item.name)
        && /nfl-joint-score|joint-score-backtest/.test(fs.readFileSync(full, 'utf8'))) {
        offenders.push(full);
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, [], `joint score model referenced from production paths: ${offenders}`);
});

test('forecastGame returns a coherent joint object', () => {
  const rand = mulberry32(11);
  const games = [];
  for (let week = 1; week <= 120; week++) {
    games.push({ season: 2000 + Math.floor(week / 20), week, home: 'A', away: 'B',
      home_score: 17 + Math.round(rand() * 14), away_score: 13 + Math.round(rand() * 14) });
  }
  const model = fitJointScoreModel(games, { severity: DEFAULT_SEVERITY, maxIterations: 120, scalings: ['unit'] });
  const f = forecastGame(model, 'A', 'B', { maxScore: 60 });
  // `mass` is the pre-normalisation grid coverage, so it is below 1 by whatever
  // the 60-point cap cut off. The laws derived from it must nonetheless be
  // proper, which is the property everything downstream depends on.
  assert.ok(f.mass > 0.98 && f.mass <= 1, `joint grid coverage ${f.mass}`);
  let marginMass = 0;
  for (let i = 0; i < f.margin_pmf.length; i++) marginMass += f.margin_pmf[i];
  assert.ok(Math.abs(marginMass - 1) < 1e-9, `margin law must be proper, got ${marginMass}`);
  assert.ok(Math.abs(f.margin_mean - (f.home_mean - f.away_mean)) < 1e-9);
  assert.ok(Math.abs(f.total_mean - (f.home_mean + f.away_mean)) < 1e-9);
  assert.ok(f.correlation >= -1 && f.correlation <= 1);
  assert.ok(f.margin_sd > 0 && f.home_sd > 0);
  // Neutral site must remove the home edge, never add to it.
  const neutral = forecastGame(model, 'A', 'B', { neutral: true, maxScore: 60 });
  assert.ok(neutral.lambdaHome <= f.lambdaHome + 1e-12);
});
