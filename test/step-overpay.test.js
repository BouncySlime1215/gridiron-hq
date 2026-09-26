/**
 * STEP-OVERPAY: Nick's overpay rule holds on EVERY served step of a War Room path, at today's
 * FantasyCalc prices, including a league the producer kept from an earlier run.
 *
 * The case (league 5, plans.json generated 09:35Z 2026-09-26, league 5 kept from its 07:01 run):
 * alternatives[3] is a two-step flip whose step 1 gives 5 (FC 919) + 327 (FC 5518) for 249 (FC 5162),
 * +24.7% on today's values (planned at +9.5% as a depth-only 2-for-1), and whose step 2 gives 176 + 249
 * for 197 (-17.4%). The chain's balance does not excuse step 1. alternatives[2] gives 280 (225) + 327
 * for 249: +11.3% with no depth premium (planned at or under the cap), also an overpay now.
 * Ids only (public repo).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { gateServedSteps, gatePlansFile, overpayCheck, ruleVerdict, STEP_OVERPAY_REASON } = await import('../server/services/campaign/never-give.js');

const FC = new Map(Object.entries({ 5: 919, 327: 5518, 249: 5162, 176: 2209, 197: 8921, 280: 225, 122: 583, 210: 6884, 11: 3000, 12: 3100 }));
const rules = { neverGive: new Set(), neverGet: new Set(), sold: new Set(), fc: FC, scoreOf: () => 70, closed: null };
const premium = { status: 'ok', source: 'plan.path', unit: 'market_value', value: { pct: 0.0953, cap: 0.12, lineup_points_delta: 3.75,
  title_odds_delta: 0.05, confirmed_lineup_points_delta: 3.43, confirmed_title_odds_delta: 0.0625, text: 'x' } };
const move = (id, steps) => ({ move_id: id, rank: 1, target: steps.at(-1).get[0], chained: steps.length > 1, steps });
const step = (partner, give, get, extra = {}) => ({ partner, give, get, ...extra });
const FLIP = move('L5-1c8c2yn', [step('5', ['5', '327'], ['249'], { depth_premium: premium }), step('10', ['176', '249'], ['197'])]);
const OTHER = move('L5-other', [step('5', ['280', '327'], ['249']), step('10', ['122', '249'], ['210'])]);
const LEGAL = move('L5-legal', [step('3', ['11'], ['12'])]);
const entry = () => ({ league: 5, me: '4',
  next_move: { status: 'ok', source: 'plan.path', value: LEGAL },
  alternatives: { status: 'ok', source: 'plan.path', value: [LEGAL, OTHER, FLIP] },
  risk_modes: { status: 'ok', source: 'plan.path', value: [
    { mode: 'all_in', first_step: { partner: '5', give: ['5', '327'], get: ['249'] }, expected: { status: 'ok', value: 0.02, source: 'plan.path' },
      if_complete: { status: 'ok', value: 0.06, source: 'plan.path' }, p_complete: { status: 'ok', value: 0.04, source: 'plan.path' } },
    { mode: 'balanced', first_step: { partner: '3', give: ['11'], get: ['12'] } }] },
  blue_chips: { status: 'ok', value: { rows: [{ player: '5', score: 60 }, { player: '327', score: 70 }, { player: '280', score: 40 }] } } });

test('the exact case: step 1 of the flip is +24.7% on FantasyCalc value, an overpay the depth exception cannot cover', () => {
  const o = overpayCheck(rules, { give: ['5', '327'], get: ['249'], premium: { points_delta: 3.43, title_delta: 0.0625 } });
  assert.equal(+o.over.toFixed(3), 0.247);
  assert.equal(o.breaks, true, 'past the +12% depth-only ceiling, whatever the deltas');
  assert.equal(overpayCheck(rules, { give: ['176', '249'], get: ['197'] }).breaks, false, 'step 2 is -17.4%');
  // The same verdict the one rule gate gives any other surface.
  assert.ok(ruleVerdict(rules, { give: ['5', '327'], get: ['249'], premium: { points_delta: 3.43, title_delta: 0.0625 } }).reasons.includes('overpay'));
});

test('every served step is checked: the flip and the premium-less 2-for-1 are withdrawn, the legal move stays', () => {
  const { entry: out, drops } = gateServedSteps(rules, entry());
  assert.deepEqual(out.alternatives.value.map(m => m.move_id), ['L5-legal']);
  assert.deepEqual(out.alternatives.value.map(m => m.rank), [1], 'ranks stay contiguous (the deck is best first)');
  assert.equal(out.next_move.status, 'ok', 'a legal next move is untouched');
  assert.deepEqual(drops.map(d => [d.where, d.step, d.overpay]).sort(), [
    ['alternatives[1]', 1, 0.1126], ['alternatives[2]', 1, 0.247], ['risk_modes.all_in.first_step', 1, 0.247]].sort());
  const allIn = out.risk_modes.value.find(m => m.mode === 'all_in');
  assert.equal(allIn.first_step, null);
  assert.equal(allIn.expected.status, 'unknown');
  assert.equal(allIn.expected.reason, STEP_OVERPAY_REASON);
  assert.deepEqual(out.risk_modes.value.find(m => m.mode === 'balanced').first_step.give, ['11']);
});

test('a breaking next move becomes unknown with the reason, never a silent swap', () => {
  const e = entry();
  e.next_move = { status: 'ok', source: 'plan.path', value: FLIP };
  const { entry: out } = gateServedSteps(rules, e);
  assert.deepEqual(out.next_move, { status: 'unknown', source: 'plan.path', reason: STEP_OVERPAY_REASON });
});

test('the depth exception still holds per step: a depth-only 2-for-1 up to +12% with both deltas up is served', () => {
  const fc = new Map([...FC, ['249', 5877]]);   // the planned +9.5%
  const { drops } = gateServedSteps({ ...rules, fc }, { league: 5, alternatives: { status: 'ok', value: [FLIP] } });
  assert.deepEqual(drops, []);
  const noRise = { ...premium, value: { ...premium.value, confirmed_title_odds_delta: -0.01 } };
  const flat = move('x', [step('5', ['5', '327'], ['249'], { depth_premium: noRise })]);
  assert.equal(gateServedSteps({ ...rules, fc }, { league: 5, alternatives: { status: 'ok', value: [flat] } }).drops.length, 1,
    'title odds on the confirm dice fell: no exception');
});

test('the whole file, kept leagues included; the producer gates before its one write', () => {
  const file = { leagues: [{ league: 4, alternatives: { status: 'ok', value: [LEGAL] } }, entry(), { league: 3, error: 'failed' }] };
  const g = gatePlansFile(file, league => (league === 3 ? null : rules));
  assert.equal(g.drops.length, 3);
  assert.ok(g.drops.every(d => d.league === 5));
  assert.equal(g.file.leagues[0], file.leagues[0], 'an untouched league is the same object');
  const src = fs.readFileSync(new URL('../scripts/campaign/produce-plans.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('gatePlansFile(merged');
  assert.ok(at > 0 && at < src.indexOf('const checked = validatePlans(written)'), 'every league is gated after mergeKept and before the write');
});
