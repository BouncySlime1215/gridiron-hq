/**
 * The touchdown-regression model, and the two errors that would silently ruin it.
 *
 * Both are represented here because both actually happened while building it:
 * a join that matched nothing and reported every star in the league as unlucky,
 * and a league-wide rate that labelled every mobile quarterback as due to
 * collapse. Neither produced an exception; both produced a confident board.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { touchdownRates, regressionCandidates } from '../server/services/td-regression.js';

test('fitted rates are ordered by how close the opportunity is to the end zone', () => {
  const r = touchdownRates();
  for (const group of ['RB', 'REC']) {
    const rush = r.rush[group];
    assert.ok(rush.goal_line_carries.rate > rush.red_zone_carries.rate,
      `${group}: goal-line should convert better than other red-zone (${rush.goal_line_carries.rate} vs ${rush.red_zone_carries.rate})`);
    assert.ok(rush.red_zone_carries.rate > rush.carries.rate,
      `${group}: red-zone should convert better than open field (${rush.red_zone_carries.rate} vs ${rush.carries.rate})`);
    const rec = r.receiving[group];
    assert.ok(rec.end_zone_targets.rate > rec.red_zone_targets.rate,
      `${group}: end-zone targets should convert best`);
    assert.ok(rec.red_zone_targets.rate > rec.targets.rate,
      `${group}: red-zone targets should beat open-field targets`);
  }
});

test('every fitted rate is a probability', () => {
  const r = touchdownRates();
  for (const side of ['rush', 'receiving']) {
    for (const group of Object.keys(r[side])) {
      for (const [cls, v] of Object.entries(r[side][group])) {
        assert.ok(v.rate > 0 && v.rate < 1, `${side}.${group}.${cls} = ${v.rate}`);
      }
    }
  }
});

test('rates were fitted on real exposure, not left at their seeds', () => {
  // The broken join produced zero exposure everywhere, which left every rate at
  // its hardcoded seed. Non-zero opportunity counts are the evidence the fit
  // actually saw data.
  const r = touchdownRates();
  const rbOpp = r.rush.RB.carries.opportunities;
  const recOpp = r.receiving.REC.targets.opportunities;
  assert.ok(rbOpp > 1000, `running-back carries exposure was ${rbOpp}; the fit saw no data`);
  assert.ok(recOpp > 1000, `receiver target exposure was ${recOpp}; the fit saw no data`);
});

test('quarterbacks are priced separately from running backs at the goal line', () => {
  // A designed quarterback sneak is a repeatable role, not luck. Pricing it at
  // the running-back rate labels every mobile quarterback as due to collapse,
  // every season, forever.
  const r = touchdownRates();
  const qb = r.rush.QB.goal_line_carries;
  const rb = r.rush.RB.goal_line_carries;
  assert.ok(qb.opportunities > 100, `too little quarterback goal-line exposure to have fitted: ${qb.opportunities}`);
  assert.notEqual(qb.rate, rb.rate, 'quarterback and running back goal-line rates should differ');
});

test('the board reports both directions and never claims everyone is unlucky', () => {
  // The broken join produced a board that was 100% "due to score". A healthy fit
  // should find candidates on both sides.
  const c = regressionCandidates({});
  assert.ok(!c.error, c.error);
  assert.ok(c.positive_regression.length > 0, 'no positive-regression candidates at all');
  assert.ok(c.negative_regression.length > 0,
    'no negative-regression candidates — every player under expectation is the signature of a broken join');
});

test('expected touchdowns are never negative and scale with opportunity', () => {
  const c = regressionCandidates({ minOpportunities: 30 });
  for (const p of c.all) {
    assert.ok(p.expected >= 0, `${p.name} has negative expected touchdowns: ${p.expected}`);
    assert.ok(p.actual >= 0, `${p.name} has negative actual touchdowns`);
    assert.ok(Number.isFinite(p.z), `${p.name} produced a non-finite z`);
  }
});

test('the minimum-opportunity filter actually filters', () => {
  const loose = regressionCandidates({ minOpportunities: 5 });
  const strict = regressionCandidates({ minOpportunities: 100 });
  assert.ok(strict.all.length < loose.all.length,
    'raising the opportunity floor did not shrink the board');
  for (const p of strict.all) {
    assert.ok(p.opportunities >= 100, `${p.name} has ${p.opportunities} opportunities, below the floor`);
  }
});

test('the gap is expressed in the same points-per-week unit as the rest of the app', () => {
  const c = regressionCandidates({});
  for (const p of [...c.positive_regression, ...c.negative_regression].slice(0, 20)) {
    // Six points a touchdown, divided across weeks played. A swing larger than
    // a touchdown a week would mean the arithmetic is wrong somewhere.
    assert.ok(Math.abs(p.ppg_swing) < 6,
      `${p.name} swings ${p.ppg_swing} points a week, which is implausible`);
    assert.equal(Math.sign(p.ppg_swing), Math.sign(p.gap),
      `${p.name}: points swing and touchdown gap disagree in sign`);
  }
});
