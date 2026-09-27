/**
 * COACH-SHAPE-2: the served title odds of 0 and the one block of reasons.
 *
 * Pinned here:
 *   - title_now of exactly 0 (no title in any simulated season) is served without a false SE of 0,
 *     with the run count and the 95% upper bound, and the plans contract accepts it
 *   - a nonzero title_now is served as before
 *   - "If no:" / "Risk:" lines fold into the why block (the first as the last why line), the rest folded under more
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { titleNow } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { foldRisks, LIMITS } = await import('../server/services/coach/answer-shape.js');

test('title_now 0 is "none of n seasons", with its upper bound; never a certain 0.00% with an SE of 0', () => {
  const zero = titleNow({ title: 0, title_se: 0, title_95: [0, 0.0032], runs: 1200 });
  assert.equal(zero.status, 'ok');
  assert.equal(zero.value, 0);
  assert.equal('se' in zero, false, 'no SE of 0');
  assert.deepEqual([zero.zero_in_runs, zero.upper_95, zero.n], [true, 0.0032, 1200]);
  const some = titleNow({ title: 0.1175, title_se: 0.0093, title_95: [0.1, 0.13], runs: 1200 });
  assert.deepEqual([some.value, some.se, some.zero_in_runs, some.upper_95], [0.1175, 0.0093, undefined, undefined]);
  assert.equal(titleNow({ title: null }).status, 'unknown');
});

test('the plans contract accepts zero_in_runs / upper_95 and rejects bad values', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8'));
  const entry = structuredClone(fixture.leagues[0]);
  entry.destination.value.title_now = titleNow({ title: 0, title_se: 0, title_95: [0, 0.0032], runs: 1200 });
  const errs = validateLeague(entry).errors.filter(e => /title_now/.test(e.path));
  assert.deepEqual(errs, []);
  entry.destination.value.title_now = { ...entry.destination.value.title_now, upper_95: 2 };
  assert.ok(validateLeague(entry).errors.some(e => /title_now/.test(e.path)), 'an upper bound over 1 is refused');
});

test('fold: the first risk is the last why line, worded as a reason; the rest is kept under more', () => {
  const w = t => ({ text: t, cites: [] });
  let r = foldRisks([w('a'), w('b'), w('c')], [w('If no: offer less.'), w('Risk: injury.')]);
  assert.deepEqual(r.why.map(x => x.text), ['a', 'b', 'If they say no, offer less.']);
  assert.deepEqual(r.more.map(x => x.text), ['c', 'The risk: injury.']);
  assert.ok(r.why.length <= LIMITS.whyMax);
  r = foldRisks([w('a')], [w('Risk: injury.')]);
  assert.deepEqual(r.why.map(x => x.text), ['a', 'The risk: injury.']);
  assert.deepEqual(foldRisks([w('a')], []), { why: [w('a')], more: [] });
});
