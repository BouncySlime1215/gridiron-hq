/**
 * The harness that would have caught the simulator's shape bugs.
 *
 * These run on constructed margin samples rather than on the engine, which is
 * deliberate and is why `nfl-sim-shape-calibration.js` takes its sampler as an
 * argument instead of importing the simulator. The question here is whether the
 * SCORER is right — whether a one-sided spike at +7 actually trips the check
 * that is supposed to see it — and a constructed sample answers that exactly,
 * deterministically, and in milliseconds, where driving the real engine would
 * answer it slowly and only for whatever the engine happens to do today.
 *
 * The engine's own end of it is covered by nfl-drive-tape.test.js and by
 * running `calibrationReport()` against a populated database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-sim-shape-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const {
  REFERENCE_MARGIN_MASS, smoothedPmf, corpusRealism, keyNumberCheck,
  signedSpikeCheck, tieMassCheck, documentedBucketScores, scoreAgainstMargins,
  walkForwardShapeCalibration, simulatorShapeReport
} = await import('../server/services/nfl-sim-shape-calibration.js');

/* ------------------------------------------------------------- generators */

/** Deterministic uniform stream, so every assertion below is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A margin sample with a realistic shape: a symmetric discrete base with key
 * numbers built in, exponentially tilted toward the home side. Tilting is the
 * form a home-field advantage and a spread both take, and the mirror-ratio
 * statistic is supposed to be blind to it — which is what the first assertion
 * below checks.
 */
function syntheticMargins({ n = 240000, tilt = 0.02, seed = 11,
  keyBoost = { 3: 3.1, 7: 1.9, 4: 1.15, 6: 1.2, 10: 1.35, 14: 1.3 } } = {}) {
  const lo = -60, hi = 60;
  const weights = [];
  for (let m = lo; m <= hi; m++) {
    const base = Math.exp(-(m * m) / (2 * 14 * 14));
    const boost = keyBoost[Math.abs(m)] ?? 1;
    weights.push({ m, w: base * boost * Math.exp(tilt * m) });
  }
  const total = weights.reduce((s, x) => s + x.w, 0);
  const random = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    let u = random() * total;
    for (const x of weights) { u -= x.w; if (u <= 0) { out.push(x.m); break; } }
    if (out.length < i + 1) out.push(0);
  }
  return out;
}

/** A sample whose |margin| masses match the documented reference table exactly. */
function referenceShapedMargins({ perSide = 100000 } = {}) {
  const ref = REFERENCE_MARGIN_MASS.abs_mass;
  const out = [];
  const documented = Object.keys(ref).map(Number);
  for (const k of documented) {
    const count = Math.round(ref[k] * perSide);
    for (let i = 0; i < count; i++) out.push(i % 2 ? k : -k);
  }
  // Everything else spread over the non-documented bins, symmetric.
  const used = documented.reduce((s, k) => s + Math.round(ref[k] * perSide), 0);
  const filler = [1, 2, 5, 8, 9, 11, 12, 13, 15, 16, 17, 18, 20, 21, 24, 27, 31];
  for (let i = 0; used + i < perSide; i++) {
    const k = filler[i % filler.length];
    out.push(i % 2 ? k : -k);
  }
  return out;
}

/* ----------------------------------------------------------------- tests */

test('the smoothed pmf is a probability distribution and never returns zero', () => {
  const pmf = smoothedPmf([0, 3, -3, 7, 7, -10]);
  let total = 0;
  for (let m = -90; m <= 90; m++) {
    const p = pmf.at(m);
    assert.ok(p > 0, `pmf at ${m} must be strictly positive for log scoring`);
    total += p;
  }
  assert.ok(Math.abs(total - 1) < 1e-9, `pmf must sum to 1, got ${total}`);
  // Outside the support it returns the floor rather than throwing or returning 0.
  assert.ok(pmf.at(500) > 0);
});

test('a one-sided spike at +7 is caught, and an ordinary tilted distribution is not', () => {
  const clean = syntheticMargins({ seed: 11 });
  const cleanCheck = signedSpikeCheck(clean);
  for (const c of cleanCheck) {
    assert.equal(c.pass, true,
      `an exponentially tilted distribution with real two-sided key numbers must not read as a ` +
      `one-sided artefact, but margin ${c.margin} scored z = ${c.z}`);
  }

  // The bug, reproduced: home-field advantage applied as one end-of-game coin
  // flip of a full touchdown adds probability at +7 and none at -7.
  const spiked = clean.slice();
  const sevens = clean.filter(m => m === 7).length;
  for (let i = 0; i < Math.round(sevens * 0.35); i++) spiked.push(7);
  const spikedCheck = signedSpikeCheck(spiked);
  const atSeven = spikedCheck.find(c => c.margin === 7);
  assert.equal(atSeven.pass, false, 'a one-sided +7 spike must fail the signed spike check');
  assert.ok(atSeven.z > atSeven.tolerance,
    `the spike is on the + side so z must be large and POSITIVE, got ${atSeven.z}`);
  // And it must not smear onto the other key number, which would make the
  // check useless for localising the fault.
  assert.equal(spikedCheck.find(c => c.margin === 3).pass, true);
});

test('the same spike is invisible to an absolute-margin view, which is why it shipped', () => {
  const clean = syntheticMargins({ seed: 12 });
  const spiked = clean.slice();
  const sevens = clean.filter(m => m === 7).length;
  for (let i = 0; i < Math.round(sevens * 0.35); i++) spiked.push(7);

  const absMass = sample => sample.filter(m => Math.abs(m) === 7).length / sample.length;
  const before = absMass(clean), after = absMass(spiked);
  // The |margin| view moves by about a point of mass — well inside any mass
  // tolerance, and indistinguishable from a slightly strong home field.
  assert.ok(after - before < 0.02,
    `folding the distribution in half hides the spike: |7| mass moved only ${(after - before).toFixed(4)}`);
  // The signed check, on the same two samples, does not miss it.
  assert.equal(signedSpikeCheck(clean).find(c => c.margin === 7).pass, true);
  assert.equal(signedSpikeCheck(spiked).find(c => c.margin === 7).pass, false);
});

test('key-number mass is graded on the documented ratio when no real corpus is attached', () => {
  const matching = referenceShapedMargins();
  for (const check of keyNumberCheck(matching)) {
    assert.equal(check.reference_from, 'documented 1999-2024 table');
    assert.ok(Math.abs(check.mass_gap) < 0.005, `${check.check} mass gap ${check.mass_gap}`);
    assert.equal(check.pass, true);
  }

  // A distribution with no key numbers at all — which is what a normal curve
  // gives you, and what the moment checks cannot distinguish from football.
  const flat = syntheticMargins({ seed: 13, keyBoost: {} });
  const flatChecks = keyNumberCheck(flat);
  assert.equal(flatChecks.find(c => c.margin === 3).pass, false);
  assert.ok(flatChecks.find(c => c.margin === 3).simulated_ratio < 1.5,
    'a smooth curve has no 3-versus-4 ratio to speak of');
});

test('a synthetic corpus is refused rather than scored against', () => {
  const fake = syntheticMargins({ seed: 14, keyBoost: {}, n: 1200 });
  const verdict = corpusRealism(fake);
  assert.equal(verdict.corpus_is_real, false);
  assert.match(verdict.disposition, /synthetic fixture/);

  const real = referenceShapedMargins({ perSide: 7000 });
  assert.equal(corpusRealism(real).corpus_is_real, true);
  assert.equal(corpusRealism(real).disposition, null);

  // Too small to judge is its own disposition, not a silent pass.
  assert.equal(corpusRealism(real.slice(0, 50)).corpus_is_real, false);
  assert.match(corpusRealism(real.slice(0, 50)).disposition, /needs a real corpus/);
});

test('tie mass grades against a real corpus and reports without grading otherwise', () => {
  // Overtime resolving nearly every tie: keep one tie in twenty, deterministically.
  let tieSeen = 0;
  const withOvertime = syntheticMargins({ seed: 15 }).filter(m => m !== 0 || (tieSeen++ % 20 === 0));
  const ungraded = tieMassCheck(withOvertime);
  assert.equal(ungraded.pass, null);
  assert.match(ungraded.disposition, /not graded/);

  // A simulator with no overtime piles regulation ties onto margin 0.
  const noOvertime = withOvertime.concat(new Array(8000).fill(0));
  const real = referenceShapedMargins({ perSide: 7000 });
  const graded = tieMassCheck(noOvertime, { actualMargins: real });
  assert.equal(graded.pass, false, 'a simulator with no overtime must fail the tie check');
  assert.ok(graded.simulated_tie_vs_neighbours > graded.reference_tie_vs_neighbours);
});

test('the documented-bucket score is zero excess for a matching distribution and grows otherwise', () => {
  const matching = documentedBucketScores(referenceShapedMargins());
  assert.ok(matching.excess_log_loss < 0.001,
    `a distribution matching the reference must carry essentially no excess surprise, got ${matching.excess_log_loss}`);
  assert.ok(matching.total_variation_distance < 0.01);

  const keyless = documentedBucketScores(syntheticMargins({ seed: 16, keyBoost: {} }));
  assert.ok(keyless.excess_log_loss > matching.excess_log_loss,
    'a distribution with no key numbers must score strictly worse against real football');
  assert.ok(keyless.key_mass_3_and_7 < matching.key_mass_3_and_7);
  assert.equal(matching.evidence, 'documented-buckets');
});

test('held-out scoring prefers the distribution the outcomes actually came from', () => {
  const truth = syntheticMargins({ seed: 17, n: 60000 });
  const observed = syntheticMargins({ seed: 18, n: 4000 });
  const wrong = syntheticMargins({ seed: 19, n: 60000, tilt: 0.2, keyBoost: {} });

  const right = scoreAgainstMargins(truth, observed);
  const bad = scoreAgainstMargins(wrong, observed);
  assert.ok(right.margin_pmf_log_likelihood_per_game > bad.margin_pmf_log_likelihood_per_game,
    `the true distribution must score higher log-likelihood: ${right.margin_pmf_log_likelihood_per_game} ` +
    `vs ${bad.margin_pmf_log_likelihood_per_game}`);
  assert.ok(right.margin_brier_per_game < bad.margin_brier_per_game);
  assert.equal(right.games, observed.length);
  for (const event of right.key_number_events) {
    assert.ok(Math.abs(event.calibration_error) < 0.03,
      `key number ${event.margin} calibration error ${event.calibration_error}`);
  }
});

test('both entry points refuse to run without a sampler rather than importing one', () => {
  assert.match(walkForwardShapeCalibration({}).error, /needs a margin sampler/);
  assert.match(simulatorShapeReport({}).error, /needs a margin sampler/);
});

test('the walk-forward harness reports null verdicts against an unverified corpus', () => {
  const sampler = ({ season }) => ({
    margins: syntheticMargins({ seed: 20 + (season ?? 0), n: 20000 }),
    totals: [], matchups: 4, trials_each: 5000,
    profile_season: season, profile_cutoff: `${season}-complete-season`
  });
  const query = () => ([
    { season: 2024, week: 1, spread: -3, team_score: 24, opp_score: 20 },
    { season: 2024, week: 2, spread: -3, team_score: 17, opp_score: 27 }
  ]);
  const out = walkForwardShapeCalibration({ sampler, from: 2024, to: 2024, query });
  assert.equal(out.evidence, 'held-out-against-unverified-corpus');
  assert.equal(out.calibrated, null, 'a two-game corpus cannot produce a calibration verdict');
  for (const check of out.checks) assert.equal(check.pass, null);
  assert.ok(out.documented_buckets.log_loss > 0,
    'the documented-bucket floor is still computable with no real corpus, which is its whole point');
});
