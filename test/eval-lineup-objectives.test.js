/**
 * The combined lineup check (scripts/eval-lineup-objectives.mjs): a lineup objective
 * that returns nothing to rank on must fail an eval, not ship.
 *
 * Every item on the week-2 branch was graded alone, against a snapshot of the others'
 * before-state; nothing graded the combined state that shipped, and "Protect the
 * floor" returned projection 0 with every margin a +0 coin flip in all five leagues.
 * The eval runs lineupCall for every league and objective on a database copy; this
 * file pins its pass/fail rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const E = await import('../scripts/eval-lineup-objectives.mjs').catch(error => ({ __importError: error }));

const slot = margin => ({ margin, player: { name: 'X' } });

test('imports without running the eval', () => {
  assert.ifError(E.__importError);
  assert.equal(typeof E.lineupObjectiveProblems, 'function');
});

test('the shipped floor bug is two problems: a zero total and all-tied margins', () => {
  const call = { objective: 'floor', objective_used: 'floor', projected_points: 0,
    lineup: [slot(0), slot(0), slot(0), slot(0), slot(null), slot(0), slot(0)] };
  const problems = E.lineupObjectiveProblems(call);
  assert.equal(problems.length, 2, JSON.stringify(problems));
  assert.ok(problems.some(p => /projected_points 0/.test(p)));
  assert.ok(problems.some(p => /6 of 6/.test(p)));
});

test('a real lineup, or an honest fallback, passes', () => {
  assert.deepEqual(E.lineupObjectiveProblems({ objective: 'mean', objective_used: 'week_points', projected_points: 83.75,
    lineup: [slot(4.1), slot(0), slot(2.2), slot(null)] }), []);
  assert.deepEqual(E.lineupObjectiveProblems({ objective: 'floor', objective_used: 'week_points', objective_fallback: 'every floor is 0',
    projected_points: 83.75, lineup: [slot(4.1), slot(1.2)] }), []);
});

test('half or fewer exact ties is fine; more than half is not', () => {
  const base = { objective: 'ceiling', objective_used: 'ceiling', projected_points: 180 };
  assert.deepEqual(E.lineupObjectiveProblems({ ...base, lineup: [slot(0), slot(0), slot(3), slot(4)] }), []);
  assert.equal(E.lineupObjectiveProblems({ ...base, lineup: [slot(0), slot(0), slot(0), slot(4)] }).length, 1);
});

test('an error from lineupCall is a problem', () => {
  assert.deepEqual(E.lineupObjectiveProblems({ error: 'league not synced yet' }), ['error: league not synced yet']);
});
