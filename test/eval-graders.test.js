/**
 * EVAL-01 graders E1-E7, pure: each grader is fed seeded fixture rows and must
 *   - PASS a known-good control (the effect is there and the model is honest),
 *   - FAIL a known-nonzero fault (a planted miscalibration / loss it must detect),
 *   - say not_enough_data below its threshold, with "needs N more <unit>".
 * No database here; test/brain-report-store.test.js covers storage and loaders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rng, calibrationSlope, moreNeeded, bootstrapCI, mean } from '../server/services/eval/stats.js';
import * as E1 from '../server/services/eval/e1.js';
import * as E2 from '../server/services/eval/e2.js';
import * as E3 from '../server/services/eval/e3.js';
import * as E4 from '../server/services/eval/e4.js';
import * as E5 from '../server/services/eval/e5.js';
import * as E6 from '../server/services/eval/e6.js';
import * as E7 from '../server/services/eval/e7.js';

const normal = rand => () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

// ------------------------------------------------------------------ stats
test('stats: calibration slope ~1 on honest probabilities, ~-1 on inverted ones', () => {
  const rand = rng(1);
  const p = Array.from({ length: 3000 }, () => 0.05 + 0.9 * rand());
  const y = p.map(q => (rand() < q ? 1 : 0));
  const s = calibrationSlope(p, y);
  assert.ok(s > 0.85 && s < 1.15, `slope ${s}`);
  assert.ok(calibrationSlope(p.map(q => 1 - q), y) < -0.8);
  assert.equal(calibrationSlope([0.2, 0.3, 0.4], [1, 1, 1]), null, 'one class has no slope');
});

test('stats: bootstrap is deterministic for a seed; moreNeeded scales with width^2', () => {
  const xs = Array.from({ length: 50 }, (_, i) => i % 7);
  const f = idx => mean(idx.map(i => xs[i]));
  assert.deepEqual(bootstrapCI(50, f, { seed: 9 }), bootstrapCI(50, f, { seed: 9 }));
  assert.equal(moreNeeded(100, 0.4, 0.2), 300);
  assert.equal(moreNeeded(100, 0.1, 0.2), 1, 'already narrow enough still needs one more');
});

// ------------------------------------------------------------------ E1
function e1Offers(n, { invert = false, seed = 11 } = {}) {
  const rand = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const p = 0.05 + 0.9 * rand();
    const y = rand() < p;
    return { league_id: 1 + (i % 5), counterparty_team_id: String(i % 40), proposed_at: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`,
      model_p_accept: invert ? 1 - p : p, status: y ? 'accepted' : (i % 3 ? 'declined' : 'expired') };
  });
}

test('E1 control: honest informative P(accept) passes (slope in band, beats activity-only)', () => {
  const r = E1.grade(e1Offers(400));
  assert.equal(r.status, 'passing', JSON.stringify(r));
  assert.ok(r.metric > 0 && r.ci_low > 0);
  assert.ok(r.detail.slope > 0.8 && r.detail.slope < 1.2);
  assert.ok(r.detail.reliability.length >= 8);
  assert.equal(r.needs_text, null);
});

test('E1 fault: inverted P(accept) is failing', () => {
  const r = E1.grade(e1Offers(400, { invert: true }));
  assert.equal(r.status, 'failing');
  assert.ok(r.detail.why.length >= 1);
});

test('E1 small n: 30 resolved offers -> not_enough_data with the evidence so far; unresolved rows do not count', () => {
  const rows = [...e1Offers(30), { league_id: 1, counterparty_team_id: 'x', model_p_accept: 0.4, status: 'proposed' },
    { league_id: 1, counterparty_team_id: 'x', model_p_accept: 0.4, status: 'ignored' }];
  const r = E1.grade(rows);
  assert.equal(r.status, 'not_enough_data');
  assert.equal(r.n, 30);
  assert.ok(r.ci_low < r.metric && r.metric < r.ci_high, 'the evidence at n = 30 is reported, not withheld');
  assert.ok(r.needs_n >= 1);
  assert.match(r.needs_text, /^needs \d+ more offers/);
  assert.equal(r.detail.excluded.unanswered, 2);
  assert.equal(r.detail.historical_standin.slopes[0], 0.93);
});

test('E1: 60 offers all declined against P(accept) averaging 0.5 is failing without waiting for accepts', () => {
  const rows = e1Offers(60).map(o => ({ ...o, status: 'declined' }));
  const r = E1.grade(rows);
  assert.equal(r.status, 'failing');
  assert.ok(r.ci_high < 0);
});

test('E1 baseline is cutoff-safe: first offer to a counterparty gets the prior rate, not its own outcome', () => {
  const b = E1.activityBaseline([{ league_id: 1, counterparty_team_id: 'a', proposed_at: '1', y: 1 },
    { league_id: 1, counterparty_team_id: 'a', proposed_at: '2', y: 1 }]);
  assert.equal(b[0], 0.5);
  assert.ok(b[1] > 0.5 && b[1] < 1);
});

// ------------------------------------------------------------------ E2
function e2Offers({ nAt = 200, atTrue = 0.5, nBelow = 30, belowTrue = 0.2, seed = 21 } = {}) {
  const rand = rng(seed);
  const at = Array.from({ length: nAt }, (_, i) => ({ league_id: 1, counterparty_team_id: String(i % 30), model_p_accept: 0.5, price_band: 'at_point', status: rand() < atTrue ? 'accepted' : 'declined' }));
  const below = Array.from({ length: nBelow }, (_, i) => ({ league_id: 1, counterparty_team_id: String(i % 30), model_p_accept: 0.2, price_band: 'below', status: rand() < belowTrue ? 'accepted' : 'declined' }));
  return [...at, ...below];
}

test('E2 control: accept rate at the yes point matches the prediction -> passing', () => {
  const r = E2.grade(e2Offers());
  assert.equal(r.status, 'passing', JSON.stringify(r));
  assert.ok(r.ci_low <= 0 && r.ci_high >= 0);
});

test('E2 fault: 85% accepted where 50% predicted -> failing', () => {
  const r = E2.grade(e2Offers({ atTrue: 0.85 }));
  assert.equal(r.status, 'failing');
  assert.ok(r.metric > 0.2);
});

test('E2 fault: offers below the yes point mostly accepted -> failing', () => {
  const r = E2.grade(e2Offers({ belowTrue: 0.9, nBelow: 60 }));
  assert.equal(r.status, 'failing');
  assert.ok(r.detail.why.some(w => /below/.test(w)));
});

test('E2 small n: 12 offers at the yes point -> not_enough_data with its CS; no source -> says which', () => {
  const r = E2.grade(e2Offers({ nAt: 12 }));
  assert.equal(r.status, 'not_enough_data');
  assert.ok(r.ci_low <= 0 && r.ci_high >= 0 && r.ci_high - r.ci_low > E2.MAX_WIDTH);
  assert.match(r.needs_text, /^needs \d+ more offers/);
  const none = E2.grade([], { reason: 'trade_outcomes lacks column(s) sent_at' });
  const floor = E2.minOffersToDecide();
  assert.ok(floor > 1 && floor < 30, `floor ${floor}`);
  assert.match(none.needs_text, new RegExp(`needs ${floor} more offers \\(trade_outcomes lacks column\\(s\\) sent_at\\)`));
});

test('E2 sequential: a price model 40 points off is failing at 20 offers, not after 30', () => {
  const r = E2.grade(e2Offers({ nAt: 20, atTrue: 0.95, nBelow: 0 }));
  assert.equal(r.status, 'failing', JSON.stringify(r));
  assert.equal(r.n, 20);
});

// ------------------------------------------------------------------ E3
test('E3 historical row: stored Sleeper replay numbers, passing, n = 906, source historical_fixed', () => {
  const r = E3.historical();
  assert.equal(r.status, 'passing');
  assert.equal(r.n, 906);
  assert.equal(r.metric, 0.0018);
  assert.deepEqual([r.ci_low, r.ci_high], [0.0012, 0.0024]);
  assert.equal(r.source, 'historical_fixed');
  assert.equal(r.detail.brier_gain_playoffs, 0.026);
  assert.deepEqual([r.detail.slope_playoffs, r.detail.slope_title], [0.97, 0.94]);
});

test('E3 historical row: a stored result below zero would be failing (the status is computed, not asserted)', () => {
  const r = E3.historical({ ...E3.HISTORICAL, brier_gain_title: -0.002, brier_gain_title_ci: [-0.003, -0.001] });
  assert.equal(r.status, 'failing');
});

function e3Rows({ leagues = 20, teams = 10, invert = false, seed = 31 } = {}) {
  const rand = rng(seed);
  const out = [];
  for (let l = 0; l < leagues; l += 1) {
    for (let t = 0; t < teams; t += 1) {
      const p = 0.05 + 0.9 * rand();
      const made = rand() < p ? 1 : 0;
      for (const week of [3, 7, 9]) {
        out.push({ league_id: l, season: 2026, team_id: t, week, p_playoffs: week === 7 ? (invert ? 1 - p : p) : 0.5,
          p_title: p / 6, made_playoffs: made, won_title: null, baseline_p_playoffs: 0.5 });
      }
    }
  }
  return out;
}

test('E3-live control: informative honest odds beat standings-only -> passing; grades the week-7 snapshot', () => {
  const r = E3.gradeLive(e3Rows());
  assert.equal(r.status, 'passing', JSON.stringify(r));
  assert.equal(r.n, 200);
  assert.ok(r.ci_low > 0);
});

test('E3-live fault: inverted odds -> failing', () => {
  assert.equal(E3.gradeLive(e3Rows({ invert: true })).status, 'failing');
});

test('E3-live threshold: 3 leagues x 10 teams -> needs 10 more team-seasons', () => {
  const r = E3.gradeLive(e3Rows({ leagues: 3 }));
  assert.equal(r.status, 'not_enough_data');
  assert.match(r.needs_text, /^needs 10 more team-seasons/);
});

// ------------------------------------------------------------------ E4
function e4File({ n = 60, planner = 1, finder = 0.4, real = true, seed = 41 } = {}) {
  const z = normal(rng(seed));
  return { real_behavior_only: real, rows: Array.from({ length: n }, (_, i) => ({
    league_season: `ls${i}`, planner_gain: planner + 0.5 * z(), finder_gain: finder + 0.5 * z(), nothing_gain: 0 })) };
}

test('E4 control: planner beats both baselines -> passing', () => {
  const r = E4.grade(e4File());
  assert.equal(r.status, 'passing', JSON.stringify(r));
  assert.ok(r.detail.vs_finder.ci[0] > 0 && r.detail.vs_nothing.ci[0] > 0);
});

test('E4 fault: planner loses to the finder -> failing', () => {
  assert.equal(E4.grade(e4File({ planner: 0.2, finder: 1 })).status, 'failing');
});

test('E4: a replay that invents accepts is not graded; no file / 10 rows -> needs more league-seasons', () => {
  assert.match(E4.grade(e4File({ real: false })).needs_text, /invented accepts/);
  assert.match(E4.grade(null, { reason: 'x' }).needs_text, /^needs 30 more league-seasons/);
  assert.match(E4.grade(e4File({ n: 10 })).needs_text, /^needs 20 more league-seasons/);
});

// ------------------------------------------------------------------ E5
function e5Steps({ n = 30, pred = 1, real = 1, seed = 51 } = {}) {
  const z = normal(rng(seed));
  return Array.from({ length: n }, (_, i) => ({ league_id: i % 5, predicted_title_odds_gain: pred, realized_title_odds_gain: real + 0.6 * z() }));
}

test('E5 control: realized gain > 0 and matches predicted -> passing', () => {
  assert.equal(E5.grade(e5Steps()).status, 'passing');
});

test('E5 fault: predicted 3 points, realized 1 -> failing (promises off)', () => {
  const r = E5.grade(e5Steps({ pred: 3 }));
  assert.equal(r.status, 'failing');
  assert.ok(r.detail.why.some(w => /off the predicted/.test(w)));
});

test('E5 threshold: 9 rescored steps (unrescored ignored) -> needs 6 more steps', () => {
  const rows = [...e5Steps({ n: 9 }), { league_id: 1, predicted_title_odds_gain: 1, realized_title_odds_gain: null }];
  assert.match(E5.grade(rows).needs_text, /^needs 6 more steps/);
});

// ------------------------------------------------------------------ E6
function e6Rows({ weeks = 10, perWeek = 6, followedGain = 2, nearTie = true, seed = 61 } = {}) {
  const z = normal(rng(seed));
  const out = [];
  for (let w = 1; w <= weeks; w += 1) {
    for (let k = 0; k < perWeek; k += 1) {
      const followed = k % 2 === 0;
      // follow_ledger x rec_ledger join shape (FIX-09): outcome and near_tie
      // from the follow ledger, score from the graded call.
      out.push({ league_id: 1, season: 2026, week: w, outcome: followed ? 'follow' : 'ignore',
        near_tie: nearTie ? 1 : 0, score: (followed ? followedGain : 0) + z() });
    }
  }
  return out;
}

test('E6 control: following near-tie calls gains -> passing', () => {
  const r = E6.grade(e6Rows());
  assert.equal(r.status, 'passing', JSON.stringify(r));
  assert.equal(r.n, 60);
});

test('E6 fault: following near-tie calls loses -> failing', () => {
  assert.equal(E6.grade(e6Rows({ followedGain: -2 })).status, 'failing');
});

test('E6 is causal only: a big naive gap with no near-tie rows never passes', () => {
  const r = E6.grade(e6Rows({ nearTie: false }));
  assert.equal(r.status, 'not_enough_data');
  assert.ok(r.detail.naive_difference_not_causal.diff > 1);
  assert.match(r.needs_text, /^needs 20 more decisions/);
});

test('E6 threshold: enough decisions but only 5 weeks -> needs 3 more weeks', () => {
  const r = E6.grade(e6Rows({ weeks: 5, perWeek: 8 }));
  assert.match(r.needs_text, /^needs 3 more weeks/);
});

// ------------------------------------------------------------------ E7
function e7Rows({ weeks = 8, teams = 10, bias = 0, seed = 71 } = {}) {
  const z = normal(rng(seed));
  const out = [];
  for (let w = 1; w <= weeks; w += 1) {
    for (let t = 0; t < teams; t += 1) {
      const expected = 110 + 5 * z();
      out.push({ season: 2026, week: w, league_id: 1, team_id: t, expected_points: expected,
        optimal_expected_points: expected + Math.abs(3 * z()), actual_points: expected + bias + 8 * z() });
    }
  }
  return out;
}

test('E7 control: unbiased luck -> passing, latest week split shown', () => {
  const r = E7.grade(e7Rows());
  assert.equal(r.status, 'passing', JSON.stringify(r));
  assert.equal(r.detail.latest_week.week, '2026:08');
  assert.ok(r.detail.latest_week.mean_decision <= 0);
});

test('E7 fault: "luck" +12 points every week is bias -> failing', () => {
  const r = E7.grade(e7Rows({ bias: 12 }));
  assert.equal(r.status, 'failing');
  assert.match(r.detail.why, /biased/);
});

test('E7 threshold: 2 weeks -> needs 2 more weeks, latest week still shown', () => {
  const r = E7.grade(e7Rows({ weeks: 2 }));
  assert.match(r.needs_text, /^needs 2 more weeks/);
  assert.equal(r.detail.latest_week.week, '2026:02');
});
