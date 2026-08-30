/**
 * The consolidation, tested as an enforcement mechanism rather than as a report.
 *
 * The value of this module is entirely in what it REFUSES. A capability map that
 * describes the platform accurately and lets a retired forecaster size a bet
 * anyway is decoration; these tests are aimed at the refusals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modelMap, ask, consensus, projectionHeads, stateOfTheModel, AUTHORITY
} from '../server/services/gridiron-model.js';

test('a capability with a failed sealed audit is retired regardless of what it claims', () => {
  const map = modelMap();
  const sim = map.capabilities.find(c => c.id === 'betting.simulator');
  assert.ok(sim, 'simulator capability missing');
  assert.equal(sim.authority, 'retired',
    'the simulator failed its ATS audit and must not be advisory');
  assert.deepEqual(sim.may, [], 'a retired capability may do nothing');
});

test('a retired capability refuses every purpose, including merely informing', () => {
  for (const purpose of ['inform', 'rank', 'size']) {
    const out = ask('betting.simulator', { purpose });
    assert.equal(out.permitted, false, `simulator was permitted to ${purpose}`);
    assert.ok(out.refusal.includes('retired'), 'the refusal should say why');
  }
});

test('an advisory capability may rank but may not size', () => {
  const rank = ask('fantasy.projection', { purpose: 'rank' });
  assert.equal(rank.permitted, true, 'an advisory model should be able to order a list');
  const size = ask('fantasy.projection', { purpose: 'size' });
  assert.equal(size.permitted, false, 'an advisory model must not size a stake');
  assert.ok(size.what_would_change_it, 'a refusal should say what would lift it');
});

test('only a passed sealed audit unlocks sizing', () => {
  const map = modelMap();
  for (const c of map.capabilities) {
    if (!c.may.includes('size')) continue;
    assert.equal(c.authority, 'authoritative', `${c.id} can size without being authoritative`);
    assert.ok(c.audit?.passed, `${c.id} can size with no passing sealed audit`);
  }
});

test('line shopping is authoritative — the one thing measured positive on outcomes', () => {
  const out = ask('betting.line_shopping', { purpose: 'size' });
  assert.equal(out.permitted, true);
  assert.ok(out.audit?.passed, 'its audit should be on the record and passing');
});

test('an unknown capability is an error, not a permissive default', () => {
  const out = ask('betting.definitely_not_real', { purpose: 'size' });
  assert.ok(out.error, 'an unknown capability must not fall through to allowed');
  assert.ok(Array.isArray(out.available) && out.available.length > 0);
});

test('a capability claiming an audit the registry does not have drops to research', () => {
  // Guards against the map drifting ahead of the record — naming an audit that
  // was never filed must not be treated as having passed one.
  const map = modelMap();
  for (const c of map.capabilities) {
    if (c.audit === null && c.why?.includes('registry has none')) {
      assert.equal(c.authority, 'research', `${c.id} claims a missing audit but is not research`);
    }
  }
});

test('the authority ladder is ordered and its permissions nest', () => {
  const order = ['retired', 'research', 'advisory', 'authoritative'];
  for (let i = 1; i < order.length; i++) {
    const lower = AUTHORITY[order[i - 1]], higher = AUTHORITY[order[i]];
    assert.ok(higher.rank > lower.rank, `${order[i]} should outrank ${order[i - 1]}`);
    for (const m of lower.may) {
      assert.ok(higher.may.includes(m),
        `${order[i]} should permit everything ${order[i - 1]} does, missing "${m}"`);
    }
  }
});

test('an estimate with no measured error gets zero weight', () => {
  const out = consensus([
    { source: 'measured', value: 10, rmse: 5 },
    { source: 'unmeasured', value: 100 }
  ]);
  assert.equal(out.value, 10, 'the unmeasured estimate must not move the answer');
  assert.equal(out.excluded.length, 1);
  assert.ok(out.excluded[0].why.includes('no measured error'));
});

test('precision weighting favours the more precise estimate', () => {
  const out = consensus([
    { source: 'precise', value: 10, rmse: 1 },
    { source: 'vague', value: 20, rmse: 10 }
  ]);
  const precise = out.contributors.find(c => c.source === 'precise');
  assert.ok(precise.weight > 0.98, `precise estimate got only ${precise.weight} of the weight`);
  assert.ok(out.value < 11, `answer ${out.value} was dragged by the vague estimate`);
});

test('the combination is never worse than the best single input', () => {
  const out = consensus([
    { source: 'a', value: 10, rmse: 6.5 },
    { source: 'b', value: 12, rmse: 6.4 }
  ]);
  assert.ok(out.combined_rmse_if_independent <= out.best_single_rmse,
    'inverse-variance weighting should not increase theoretical error');
  assert.ok(out.caveat.includes('correlated'),
    'the independence assumption must be disclosed with the result');
});

test('combining nothing measurable refuses rather than averaging guesses', () => {
  const out = consensus([{ source: 'a', value: 1 }, { source: 'b', value: 2 }]);
  assert.equal(out.value, null);
  assert.ok(out.refusal.includes('not a better estimate'));
});

test('consensus tolerates junk input without producing a number', () => {
  for (const bad of [[], null, undefined, [{ value: NaN, rmse: 1 }], [{ value: 1, rmse: 0 }],
    [{ value: 1, rmse: -3 }]]) {
    const out = consensus(bad ?? undefined);
    assert.ok(out.value == null, `produced ${out.value} from ${JSON.stringify(bad)}`);
  }
});

test('the projection heads come from the real out-of-sample validation', () => {
  const h = projectionHeads();
  if (h.error) return;                    // no validation on this machine yet
  assert.ok(h.heads.length > 0, 'no heads recorded');
  for (let i = 1; i < h.heads.length; i++) {
    assert.ok(h.heads[i].rmse >= h.heads[i - 1].rmse, 'heads should be sorted by error');
  }
  assert.ok(h.caveat.includes('market'),
    'forecast quality must not be presented as betting profitability');
});

test('the state summary counts match the map', () => {
  const s = stateOfTheModel();
  const map = modelMap();
  assert.equal(s.can_size_real_money.length, map.can_size.length);
  assert.equal(s.retired.length, (map.counts.retired ?? 0));
  assert.ok(s.why_not_one_number.includes('dead'),
    'the reason a single averaged output is wrong should be stated, not assumed');
});
