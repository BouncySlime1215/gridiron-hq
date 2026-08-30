/**
 * The reasoning layer, tested on the two things that make it trustworthy:
 * that its attribution is real arithmetic rather than a plausible story, and
 * that it never presents descriptive context as a cause.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainPick } from '../server/services/pick-reasoning.js';
import { positionRequirements } from '../server/services/position-liquidity.js';

const basePick = {
  season: 2024, week: 12, home: 'CLE', away: 'PIT', market: 'spread',
  side: 'CLE', line: 3.5, model_margin: 3.4, market_margin: 3.5
};

test('attribution reconstructs the projection from the component weights', () => {
  const models = [
    { model: 'a', margin: 6, margin_weight: 2 },
    { model: 'b', margin: 0, margin_weight: 2 }
  ];
  // Weighted mean of 6 and 0 at equal weight is 3.
  const out = explainPick({ ...basePick, model_margin: 3 }, { models, includeContext: false });
  assert.equal(out.what_drove_it.available, true);
  assert.equal(out.what_drove_it.reconstructed, 3);
  assert.equal(out.what_drove_it.reconstruction_matches, true);
});

test('a reconstruction that does not match the projection is flagged, not hidden', () => {
  // This is the check that caught a real bug: a totals pick was being attributed
  // to margin components, which reconstructed to an unrelated number.
  const models = [{ model: 'a', margin: 20, margin_weight: 1 }];
  const out = explainPick({ ...basePick, model_margin: 3 }, { models, includeContext: false });
  assert.equal(out.what_drove_it.reconstruction_matches, false,
    'a mismatch between weights and projection must be visible');
});

test('a totals pick attributes from total components, not margin components', () => {
  const models = [
    { model: 'a', margin: -7, margin_weight: 1, total: 44, total_weight: 1 },
    { model: 'b', margin: -3, margin_weight: 1, total: 46, total_weight: 1 }
  ];
  const out = explainPick(
    { ...basePick, market: 'total', side: 'Over 44', line: 44, model_margin: 45, market_margin: 44 },
    { models, includeContext: false });
  assert.equal(out.what_drove_it.market, 'total');
  assert.equal(out.what_drove_it.reconstructed, 45, 'should reconstruct from totals, not margins');
  assert.equal(out.what_drove_it.reconstruction_matches, true);
});

test('a totals pick with no total weights refuses to attribute rather than using margins', () => {
  const models = [{ model: 'a', margin: -7, margin_weight: 1 }];
  const out = explainPick(
    { ...basePick, market: 'total', model_margin: 45, market_margin: 44 },
    { models, includeContext: false });
  assert.equal(out.what_drove_it.available, false,
    'naming margin models under a totals pick would be an invented rationale');
  assert.ok(out.what_drove_it.why?.includes('did not produce'));
});

test('causal and descriptive halves are labelled and never merged', () => {
  const out = explainPick(basePick, { models: null, includeContext: false });
  assert.equal(out.what_drove_it.causal, true);
  assert.equal(out.what_was_true.causal, false);
  assert.ok(out.what_was_true.note.includes('does not read'),
    'the descriptive half must say the model did not read it');
});

test('missing components produce an honest gap rather than a guess', () => {
  const out = explainPick(basePick, { models: null, includeContext: false });
  assert.equal(out.what_drove_it.available, false);
  assert.ok(out.english.includes('not attributed') || out.english.includes('not recorded'));
});

test('a pick without both numbers is refused', () => {
  assert.ok(explainPick({ ...basePick, model_margin: null }).error);
  assert.ok(explainPick({ ...basePick, market_margin: null }).error);
  assert.ok(explainPick(null).error);
});

test('the counter-case always includes the closing-line warning', () => {
  const out = explainPick(basePick, { models: null, includeContext: false });
  assert.ok(out.counter_case.some(c => /closing line/i.test(c)),
    'every trace should carry the measured fact that this model loses to the close');
});

test('a sub-point edge is called out as inside the model error', () => {
  const out = explainPick({ ...basePick, model_margin: 3.4, market_margin: 3.5 },
    { models: null, includeContext: false });
  assert.ok(out.counter_case.some(c => /under a point/i.test(c)));
});

test('wide component scatter against a narrow edge is called weak evidence', () => {
  const models = [
    { model: 'a', margin: 10, margin_weight: 1 },
    { model: 'b', margin: -4, margin_weight: 1 }
  ];
  const out = explainPick({ ...basePick, model_margin: 3, market_margin: 2.9 },
    { models, includeContext: false });
  assert.ok(out.english.includes('weak evidence'),
    'scatter wider than the edge means the blend is averaging noise');
});

test('a negative cover margin is described as missing the number, not beating it by a negative', () => {
  // Guards a phrasing bug that produced "beating it by an average of -7.0 points".
  const out = explainPick(basePick, { models: null, includeContext: true });
  const notes = out.what_was_true.notes.join(' ');
  assert.ok(!/beating it by an average of -/.test(notes),
    `negative cover margin phrased as a negative beat: ${notes}`);
});

test('flex slots are shared between eligible positions, not counted whole for each', () => {
  // Counting a single FLEX as a full slot for RB, WR and TE at once overstates
  // every requirement and makes every roster look like it has nothing spare.
  const req = positionRequirements(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']);
  assert.equal(req._dedicated.RB, 2, 'dedicated RB slots are the hard floor');
  assert.ok(req.RB > 2 && req.RB < 3, `RB requirement ${req.RB} should sit between the floor and floor+1`);
  const flexShare = (req.RB - 2) + (req.WR - 2) + (req.TE - 1);
  assert.ok(Math.abs(flexShare - 1) < 1e-9,
    `one flex slot should distribute exactly one body, distributed ${flexShare}`);
});
