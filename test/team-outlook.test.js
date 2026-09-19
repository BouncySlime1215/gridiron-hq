/**
 * Tests for the Team Outlook model. The rule is `docs/tdd/team-outlook.tdd.md`.
 *
 * These pin the things that are easy to get quietly wrong rather than the things that
 * throw. Two of them exist because the code they cover was actually broken in exactly
 * that way during this build:
 *
 *  - `solve` returned `row[n] / row[i][i]`, indexing into a number, so every coefficient
 *    came back NaN. Nothing threw, and the fit looked like a fit.
 *  - `signCheck` then PASSED that fit, because every comparison against NaN is false. A
 *    gate that reports a model of pure NaN as sound is worse than no gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTLOOK_FEATURES, EXPECTED_SIGNS, OUTLOOK_GATE, VERDICTS,
  featureRow, neutralFeatures, fitLogistic, fitOutlook, predictFrom, predictOutlook,
  coefficientsInFeatureUnits, signCheck, decompose, fitThresholds, verdictFor
} from '../server/services/team-outlook.js';

/**
 * A panel where the direction of every feature is known by construction.
 *
 * `win_pct` MUST NOT be built as a noisier copy of `all_play_pct`, and the first version of
 * this fixture was. Two collinear proxies for one latent strength let the fit use the noisier
 * one as a noise-canceller -- strength is recovered better from `2*all_play - win_pct` than
 * from either alone -- so week 2 came back with a win_pct coefficient of -1.50 and the sign
 * check correctly failed a model that was not wrong. On the real panel all seven weeks fit
 * win_pct between +0.99 and +4.53, because a real record carries information all-play does
 * not: seeding is decided by wins, so a lucky team really is closer to the playoffs.
 *
 * So the fixture makes the outcome depend on scoring AND on the record, as reality does.
 */
function panel({ weeks = [2, 3, 4, 5, 6, 7, 8], leagues = 40, teams = 10, seed = 7 } = {}) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  for (let l = 0; l < leagues; l++) {
    for (let t = 0; t < teams; t++) {
      const strength = rnd();                    // the team's latent scoring quality
      const luck = rnd();                        // schedule luck, independent of scoring
      // The record leans on luck as much as on scoring, which is what keeps it from being a
      // second measurement of the same thing. Correlated features do not have identified
      // individual signs, and a fixture that correlates them cannot test a sign.
      const record = Math.min(1, Math.max(0, 0.35 * strength + 0.65 * luck));
      const made = strength * 0.55 + record * 0.45 > 0.45 ? 1 : 0;
      for (const week of weeks) {
        const noise = (rnd() - 0.5) * 0.3;
        out.push({
          season: 2022, league_id: `L${l}`, roster_id: t, num_teams: teams, playoff_teams: teams / 2,
          week, games: week, weeks_left: 13 - week,
          points_z: 0, mean_points_z: +((strength - 0.5) * 2 + noise).toFixed(4),
          all_play_pct: Math.min(1, Math.max(0, strength + noise)),
          win_pct: Math.min(1, Math.max(0, record + noise * 0.5)),
          wins_so_far: Math.round(week * record), head_to_head_games: week,
          points_so_far: 100 * week, games_back: Math.round((0.6 - record) * 3),
          made_playoffs: made, champion: 0
        });
      }
    }
  }
  return out;
}

test('the fitted coefficients are finite, which is not a given', () => {
  const p = panel();
  const fit = fitOutlook({ panel: p, k: 7.6 });
  assert.ok(fit, 'a fit was produced');
  for (const week of OUTLOOK_GATE.weeks) {
    const wf = fit.byWeek[week];
    assert.ok(wf, `week ${week} fitted`);
    assert.ok(Number.isFinite(wf.intercept), `week ${week} intercept finite`);
    for (const cf of wf.coef) assert.ok(Number.isFinite(cf), `week ${week} coefficient finite`);
  }
});

test('a fit of NaN coefficients fails the sign check instead of passing it', () => {
  // The original defect: every comparison against NaN is false, so a check written only as
  // `got < 0` / `got > 0` reports NaN as correctly signed. This is the regression guard.
  const broken = {
    intercept: NaN, week: 4, n: 100,
    coef: OUTLOOK_FEATURES.map(() => NaN),
    mu: OUTLOOK_FEATURES.map(() => 0), sd: OUTLOOK_FEATURES.map(() => 1)
  };
  const sc = signCheck(broken);
  assert.equal(sc.pass, false, 'a NaN fit must not pass');
  assert.equal(sc.wrong.length, OUTLOOK_FEATURES.length, 'every feature is reported, not just the signed ones');
  for (const w of sc.wrong) assert.equal(w.expected, 'finite');
});

test('fitLogistic returns null rather than a non-finite fit', () => {
  // A column of Infinity drives the iteration non-finite. The contract is null, because a
  // NaN travelling downstream reads as a missing number rather than a broken one.
  const X = Array.from({ length: 60 }, (_, i) => [i % 2 ? Infinity : 1, i / 60]);
  const y = Array.from({ length: 60 }, (_, i) => i % 2);
  assert.equal(fitLogistic(X, y, { l2: 1 }), null);
});

test('fitLogistic recovers a known coefficient sign and beats the base rate', () => {
  // y depends on x1 positively and x2 negatively; the fit must say so.
  let s = 11;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const X = [], y = [];
  for (let i = 0; i < 800; i++) {
    const a = rnd() * 2 - 1, b = rnd() * 2 - 1;
    X.push([a, b]);
    y.push(1 / (1 + Math.exp(-(1.5 * a - 1.5 * b))) > rnd() ? 1 : 0);
  }
  const fit = fitLogistic(X, y, { l2: 0.5 });
  assert.ok(fit.coef[0] > 0, `x1 positive, got ${fit.coef[0]}`);
  assert.ok(fit.coef[1] < 0, `x2 negative, got ${fit.coef[1]}`);
});

test('the intercept is not penalised, so a lopsided base rate is reproduced', () => {
  // With no informative feature, the fitted probability must equal the observed rate. A
  // penalised intercept would drag it toward 0.5 and bias every prediction in a league
  // whose playoff share is not a half.
  const n = 1000, rate = 0.2;
  const X = Array.from({ length: n }, () => [0, 0]);
  const y = Array.from({ length: n }, (_, i) => (i < n * rate ? 1 : 0));
  const fit = fitLogistic(X, y, { l2: 100 });
  const p = 1 / (1 + Math.exp(-fit.intercept));
  assert.ok(Math.abs(p - rate) < 0.01, `fitted ${p.toFixed(4)} against observed ${rate}`);
});

test('every expected sign comes out right on a panel where the direction is known', () => {
  const fit = fitOutlook({ panel: panel(), k: 7.6 });
  for (const week of OUTLOOK_GATE.weeks) {
    const sc = signCheck(fit.byWeek[week]);
    assert.equal(sc.pass, true, `week ${week}: ${JSON.stringify(sc.wrong)}`);
  }
  // And the expectation itself is not vacuous: every named feature is a real feature.
  for (const name of Object.keys(EXPECTED_SIGNS)) assert.ok(OUTLOOK_FEATURES.includes(name));
});

test('a test row is standardised by the fit set, never by itself', () => {
  const fit = fitOutlook({ panel: panel(), k: 7.6 });
  const wf = fit.byWeek[4];
  // Doubling a feature must move the prediction, which it cannot do if the row were
  // standardised against its own (single-row, zero-variance) distribution.
  const base = { all_play_pct: 0.5, points_shrunk: 0, win_pct: 0.5, games_back: 0, weeks_left: 9, playoff_share: 0.5 };
  const better = { ...base, all_play_pct: 0.9, win_pct: 0.9 };
  assert.ok(predictFrom(wf, better) > predictFrom(wf, base));
});

test('a feature with no spread in the fit set does not produce NaN', () => {
  // Every row shares one playoff_share, so its deviation is zero. Dividing by it would
  // give NaN coefficients; the contract is that it contributes nothing instead.
  const p = panel({ leagues: 20 }).map(r => ({ ...r, playoff_teams: 5, num_teams: 10 }));
  const fit = fitOutlook({ panel: p, k: 7.6 });
  for (const week of OUTLOOK_GATE.weeks) {
    if (!fit.byWeek[week]) continue;
    for (const cf of fit.byWeek[week].coef) assert.ok(Number.isFinite(cf));
  }
});

test('the decomposition sums to the total exactly', () => {
  const p = panel();
  const fit = fitOutlook({ panel: p, k: 7.6 });
  let worst = 0;
  for (const row of p.filter(r => r.week === 4).slice(0, 200)) {
    const d = decompose(fit, row);
    worst = Math.max(worst, Math.abs(d.luck + d.noise + d.real - d.total));
  }
  // Rounded to four places in the report, so the residual can only be rounding.
  assert.ok(worst <= 2e-4, `worst residual ${worst}`);
});

test('the decomposition says what its remainder term is and what order it was taken in', () => {
  const p = panel();
  const fit = fitOutlook({ panel: p, k: 7.6 });
  const d = decompose(fit, p.find(r => r.week === 4));
  // A residual presented as "roster change" would be inventing a meaning for it.
  assert.match(d.real_is, /remainder/);
  assert.match(d.real_is, /not roster change/);
  assert.ok(d.order.length > 20, 'the ordering is stated, because a different order moves the parts');
});

test('luck is the record against the all-play record, in the direction it should be', () => {
  const fit = fitOutlook({ panel: panel(), k: 7.6 });
  const base = {
    season: 2022, league_id: 'X', roster_id: 1, num_teams: 10, playoff_teams: 5,
    week: 4, games: 4, weeks_left: 9, mean_points_z: 0.3, all_play_pct: 0.7,
    games_back: 0, made_playoffs: 0
  };
  // Same scoring, better record than deserved: luck must be positive.
  const lucky = decompose(fit, { ...base, win_pct: 1.0 });
  const unlucky = decompose(fit, { ...base, win_pct: 0.25 });
  assert.ok(lucky.luck > 0, `lucky team's luck ${lucky.luck}`);
  assert.ok(unlucky.luck < 0, `unlucky team's luck ${unlucky.luck}`);
  // A team whose record exactly matches its all-play record has no luck to speak of.
  const neutral = decompose(fit, { ...base, win_pct: 0.7 });
  assert.ok(Math.abs(neutral.luck) < 1e-3, `neutral luck ${neutral.luck}`);
});

test('the weight on results is the measured posterior weight, and rises with games played', () => {
  const fit = fitOutlook({ panel: panel(), k: 7.6 });
  const row = w => ({
    season: 2022, league_id: 'X', roster_id: 1, num_teams: 10, playoff_teams: 5,
    week: w, games: w, weeks_left: 13 - w, mean_points_z: 0.3, all_play_pct: 0.6,
    win_pct: 0.6, games_back: 0, made_playoffs: 0
  });
  const w2 = decompose(fit, row(2)), w8 = decompose(fit, row(8));
  assert.equal(w2.weight_on_results, +(2 / (2 + 7.6)).toFixed(4));
  assert.equal(w8.weight_on_results, +(8 / (8 + 7.6)).toFixed(4));
  assert.ok(w2.weight_on_results < w8.weight_on_results);
  // noise_share is its complement, not a second independent number.
  assert.ok(Math.abs(w2.weight_on_results + w2.noise_share - 1) < 1e-4);
});

test('a team with no games played carries no weight on results at all', () => {
  const fit = fitOutlook({ panel: panel(), k: 7.6 });
  const d = decompose(fit, {
    season: 2022, league_id: 'X', roster_id: 1, num_teams: 10, playoff_teams: 5,
    week: 4, games: 0, weeks_left: 13, mean_points_z: 2, all_play_pct: null,
    win_pct: null, games_back: 0, made_playoffs: 0
  });
  assert.equal(d.weight_on_results, 0);
  assert.equal(d.noise_share, 1);
});

test('act is never returned, at any probability', () => {
  const thresholds = { watch: 0.42, act_candidate: 0.20 };
  const seen = new Set();
  for (let p = 0; p <= 1.0001; p += 0.001) seen.add(verdictFor(p, thresholds));
  assert.deepEqual([...seen].sort(), ['act_candidate', 'fine', 'watch']);
  assert.ok(!seen.has('act'), 'the service may not emit act; a caller with the move half promotes it');
  assert.deepEqual([...VERDICTS].sort(), ['act_candidate', 'fine', 'watch']);
});

test('the verdict bands are ordered and closed at their boundaries', () => {
  const t = { watch: 0.42, act_candidate: 0.20 };
  assert.equal(verdictFor(0.20, t), 'act_candidate', 'the boundary belongs to the worse band');
  assert.equal(verdictFor(0.2001, t), 'watch');
  assert.equal(verdictFor(0.42, t), 'watch');
  assert.equal(verdictFor(0.4201, t), 'fine');
  assert.equal(verdictFor(null, t), null);
  assert.equal(verdictFor(0.5, null), null);
});

test('thresholds are quantiles of the fitted probabilities, not round numbers', () => {
  const p = panel();
  const fit = fitOutlook({ panel: p, k: 7.6 });
  const t = fitThresholds({ fit, panel: p });
  assert.ok(t.act_candidate < t.watch, `${t.act_candidate} < ${t.watch}`);
  assert.ok(t.watch > 0 && t.watch < 1);
  assert.match(t.basis, /quantiles/);
  // Roughly the requested share of the fit set falls at or below each cut.
  const probs = p.map(r => predictOutlook(fit, r)).filter(v => v != null);
  const below = probs.filter(v => v <= t.watch).length / probs.length;
  assert.ok(Math.abs(below - t.watch_quantile) < 0.05, `share below watch ${below.toFixed(3)}`);
});

test('a week the model has no fit for returns nothing rather than guessing', () => {
  const fit = fitOutlook({ panel: panel({ weeks: [4] }), k: 7.6, weeks: [4] });
  assert.ok(predictOutlook(fit, { week: 4, games: 4, num_teams: 10, playoff_teams: 5 }) != null);
  assert.equal(predictOutlook(fit, { week: 11, games: 11, num_teams: 10, playoff_teams: 5 }), null);
  assert.equal(decompose(fit, { week: 11, games: 11, num_teams: 10, playoff_teams: 5 }), null);
});

test('a week with too few rows to fit six features is skipped, not fitted badly', () => {
  const tiny = panel({ leagues: 1, teams: 4, weeks: [4] });
  assert.ok(tiny.length < OUTLOOK_FEATURES.length * 10);
  const fit = fitOutlook({ panel: tiny, k: 7.6, weeks: [4] });
  assert.equal(fit.byWeek[4], undefined);
  assert.deepEqual(fit.weeks, []);
});

test('a league format the fit never saw still produces a probability, in range', () => {
  const fit = fitOutlook({ panel: panel({ teams: 10 }), k: 7.6 });
  // A 14-team league taking 4, which no fit row resembles.
  const p = predictOutlook(fit, {
    week: 4, games: 4, weeks_left: 9, num_teams: 14, playoff_teams: 4,
    mean_points_z: 0.1, all_play_pct: 0.55, win_pct: 0.5, games_back: 1
  });
  assert.ok(p > 0 && p < 1, `probability ${p}`);
});

test('a missing signal falls back to neutral rather than to zero', () => {
  // Zero all-play would read as "outscored nobody", which is a claim; 0.5 is the absence
  // of a claim. The distinction decides what an unplayed week does to the verdict.
  const f = featureRow({ week: 2, games: 2, num_teams: 10, playoff_teams: 5, mean_points_z: 0 }, 7.6);
  assert.equal(f.all_play_pct, 0.5);
  assert.equal(f.win_pct, 0.5);
  const n = neutralFeatures({ week: 2, games: 2, num_teams: 10, playoff_teams: 5, mean_points_z: 2, all_play_pct: 0.9, win_pct: 0.9 }, 7.6);
  assert.equal(n.all_play_pct, 0.5);
  assert.equal(n.points_shrunk, 0);
  // Structure is kept in the neutral state: preseason still knows the league's format.
  assert.equal(n.playoff_share, 0.5);
});

test('the shrinkage in the feature row is the measured k, not a constant', () => {
  const row = { week: 4, games: 4, num_teams: 10, playoff_teams: 5, mean_points_z: 1.0, all_play_pct: 0.6, win_pct: 0.6, games_back: 0 };
  const tight = featureRow(row, 1).points_shrunk;    // small k: believe the results
  const loose = featureRow(row, 100).points_shrunk;  // large k: believe the prior
  assert.ok(tight > loose, `${tight} > ${loose}`);
  assert.ok(Math.abs(tight - 4 / 5) < 1e-9);
  assert.ok(Math.abs(loose - 4 / 104) < 1e-9);
});

test('coefficients are reported in feature units, so the sign check reads what it means', () => {
  const fit = fitOutlook({ panel: panel(), k: 7.6 });
  const wf = fit.byWeek[4];
  const inUnits = coefficientsInFeatureUnits(wf);
  OUTLOOK_FEATURES.forEach((name, j) => {
    assert.ok(Math.abs(inUnits[name] - wf.coef[j] / wf.sd[j]) < 1e-12, name);
  });
});

test('the gate constants are frozen, because changing one changes the rule', () => {
  assert.throws(() => { OUTLOOK_GATE.calibrationMax = 0.9; });
  assert.equal(OUTLOOK_GATE.calibrationMax, 0.03);
  assert.deepEqual([...OUTLOOK_GATE.weeks], [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...OUTLOOK_GATE.baselines], ['base_rate', 'all_play_pct', 'points_shrunk', 'win_pct']);
});

test('the no-results baseline is not named preseason, because it is not a preseason forecast', () => {
  const p = panel();
  const fit = fitOutlook({ panel: p, k: 7.6 });
  const d = decompose(fit, p.find(r => r.week === 4));

  // The field is the fitted model with every RESULT-derived feature at its neutral value.
  // It contains no projection of the roster and no preseason ranking -- there is none in
  // this payload to contain. A UI thread read `preseason` and wrote "the preseason
  // picture", which a reader takes as "our preseason projection". The name is the defect.
  assert.ok('no_results_yet' in d, 'the baseline field is named for what it is');
  assert.ok(!('preseason' in d), 'nothing may reintroduce the name that was misread');

  // And the identity the renamed field has to keep holding.
  assert.ok(Math.abs((d.now - d.no_results_yet) - d.total) <= 2e-4,
    'total is still now minus the no-results baseline');
});
