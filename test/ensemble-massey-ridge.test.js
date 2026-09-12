import test from 'node:test';
import assert from 'node:assert/strict';
import { __testables } from '../server/services/nfl-ensemble.js';

const { massey, MASSEY_RIDGE_LAMBDA } = __testables;

/*
 * The Massey component of the live spread ensemble is the paired-comparison
 * estimator: each game is a row with +1 in the home column, -1 in the away
 * column, and the observed margin as its response. These checks pin the three
 * properties that make the ridge form safe to carry — that it is opponent
 * ADJUSTED rather than opponent blind, that lambda = 0 is the historical
 * estimator exactly, and that lambda > 0 shrinks toward the prior without
 * moving the league's centre.
 *
 * They run on a constructed league rather than on history, because the point
 * being proved is algebraic: for a claim about whether a rating separates two
 * teams with identical raw margin, a schedule built to isolate that is better
 * evidence than a real season in which the two effects are entangled.
 */

/** A league where A and B have the SAME raw average margin on different schedules. */
function splitScheduleLeague() {
  const hist = [];
  const play = (home, away, margin) =>
    hist.push({ home, away, home_score: 24 + margin, away_score: 24 });
  const strong = ['S1', 'S2', 'S3', 'S4'], weak = ['W1', 'W2', 'W3', 'W4'];
  // A beats the strong half by 5 every time; B beats the weak half by 5 every
  // time. Both average exactly +5 per game.
  for (const s of strong) { play('A', s, 5); play(s, 'A', -5); }
  for (const w of weak) { play('B', w, 5); play(w, 'B', -5); }
  // The halves are not equal, and the schedule connects them.
  for (const s of strong) for (const w of weak) { play(s, w, 20); play(w, s, -20); }
  return hist;
}

const rawAverageMargin = (hist, team) => {
  let sum = 0, n = 0;
  for (const g of hist) {
    if (g.home === team) { sum += g.home_score - g.away_score; n++; }
    else if (g.away === team) { sum += g.away_score - g.home_score; n++; }
  }
  return sum / n;
};

test('the live estimator is opponent-adjusted, not a differenced average margin', () => {
  const hist = splitScheduleLeague();
  assert.equal(rawAverageMargin(hist, 'A'), rawAverageMargin(hist, 'B'),
    'the fixture is only meaningful if the raw averages are identical');

  const r = massey(hist);
  // A played the strong half and B the weak half, and the halves differ by 20
  // points a game, so the ratings must differ by that much. An opponent-blind
  // rating would score these two teams identically.
  assert.ok(r.get('A') - r.get('B') > 15,
    `expected the strength-of-schedule gap to survive, got ${r.get('A') - r.get('B')}`);
  assert.ok(r.get('S1') > r.get('W1'));
});

test('lambda = 0 reproduces the historical least-squares estimator exactly', () => {
  const hist = splitScheduleLeague();
  const shipped = massey(hist);                 // the module default
  const explicit = massey(hist, { lambda: 0 });
  assert.equal(MASSEY_RIDGE_LAMBDA, 0,
    'the shipped default is the measured one: the ridge improved the component but not the forecast');
  for (const [team, value] of shipped) assert.equal(value, explicit.get(team));

  // Sum-to-zero identification, which the pinned row imposes at lambda = 0.
  const total = [...shipped.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total) < 1e-6, `ratings should centre at zero, summed to ${total}`);
});

test('ridge shrinks toward the prior and leaves the league centre alone', () => {
  const hist = splitScheduleLeague();
  const ols = massey(hist, { lambda: 0 });
  const ridged = massey(hist, { lambda: 50 });

  // Every rating moves toward zero in magnitude.
  for (const [team, value] of ols) {
    const shrunk = ridged.get(team);
    assert.ok(Math.abs(shrunk) <= Math.abs(value) + 1e-9,
      `${team} grew under shrinkage: ${value} -> ${shrunk}`);
  }

  // Signs may flip, and that is the estimator working rather than failing.
  // (X'X + lambda*I)^-1 is not diagonal, so shrinkage is not applied
  // coordinate-wise. B's negative least-squares rating is ENTIRELY an
  // opponent-quality correction — its raw margin is +5 and only the weakness of
  // its schedule pushes it below zero — so as lambda removes that correction B
  // reverts toward its unadjusted record. A test that forbade this would be
  // asserting a property ridge regression does not have.
  assert.ok(ols.get('B') < 0 && ridged.get('B') > ols.get('B'),
    'shrinkage should walk B back toward its unadjusted record');
  // Centring survives regularisation without the pinned row.
  const total = [...ridged.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total) < 1e-6, `ridged ratings should still centre at zero, summed to ${total}`);
  // Heavier shrinkage is monotone.
  const heavier = massey(hist, { lambda: 500 });
  assert.ok(Math.abs(heavier.get('A')) < Math.abs(ridged.get('A')));
});

test('a prior pulls ratings toward itself, centred rather than shifted', () => {
  const hist = splitScheduleLeague();
  const neutral = massey(hist, { lambda: 50 });
  // An off-centre prior: its MEAN must not move the league, only its shape.
  const prior = new Map([['A', 100], ['B', 100], ['S1', 100], ['S2', 100],
    ['S3', 100], ['S4', 100], ['W1', 100], ['W2', 100], ['W3', 100], ['W4', 100]]);
  const flat = massey(hist, { lambda: 50, prior });
  for (const [team, value] of neutral) {
    assert.ok(Math.abs(value - flat.get(team)) < 1e-9,
      `${team} moved on a constant prior: ${value} -> ${flat.get(team)}`);
  }
  // A prior with real shape does pull.
  const shaped = new Map([...prior.keys()].map(t => [t, t === 'B' ? 60 : -4]));
  const pulled = massey(hist, { lambda: 50, prior: shaped });
  assert.ok(pulled.get('B') > neutral.get('B'),
    'a prior that likes B should raise B relative to the priorless fit');
});
