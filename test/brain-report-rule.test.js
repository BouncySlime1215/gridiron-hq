/**
 * EVAL-01 fallback rule (server/services/eval/brain-rule.js), pure:
 * any failing check -> BALANCED and testing-tier signals off; a missing,
 * stale or errored report fails closed the same way; SAFE is never raised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { brainReportRule, RISK_MODES, REPORT_MAX_AGE_HOURS } from '../server/services/eval/brain-rule.js';

const now = new Date('2026-10-05T12:00:00Z');
const report = (statuses, extra = {}) => ({
  computed_at: '2026-10-05T11:45:00Z',
  checks: statuses.map((status, i) => ({ check: `E${i + 1}`, name: `check ${i + 1}`, status, detail: {} })),
  ...extra,
});

test('no failing check: the requested mode stands; testing tier only in all_in', () => {
  const ok = report(['passing', 'not_enough_data', 'not_enough_data']);
  const allIn = brainReportRule({ requestedMode: RISK_MODES.ALL_IN, report: ok, now });
  assert.deepEqual([allIn.mode, allIn.testing_tier_enabled, allIn.fell_back], ['all_in', true, false]);
  const bal = brainReportRule({ requestedMode: RISK_MODES.BALANCED, report: ok, now });
  assert.deepEqual([bal.mode, bal.testing_tier_enabled], ['balanced', false]);
});

test('one failing check: all_in falls back to balanced, testing tier off, and it says which check', () => {
  const r = brainReportRule({ requestedMode: RISK_MODES.ALL_IN, report: report(['passing', 'failing', 'not_enough_data']), now });
  assert.equal(r.mode, 'balanced');
  assert.equal(r.testing_tier_enabled, false);
  assert.equal(r.fell_back, true);
  assert.deepEqual(r.blocking.map(b => b.check), ['E2']);
  assert.match(r.reason, /Fell back to balanced.*E2 check 2 is failing/);
});

test('SAFE is never raised to BALANCED by a failing check', () => {
  const r = brainReportRule({ requestedMode: RISK_MODES.SAFE, report: report(['failing']), now });
  assert.equal(r.mode, 'safe');
  assert.equal(r.fell_back, false);
  assert.equal(r.testing_tier_enabled, false);
});

test('fails closed: no report, a stale report, or a grader error all block the testing tier', () => {
  for (const rep of [null, { computed_at: now.toISOString(), checks: [] },
    report(['passing'], { computed_at: new Date(now.getTime() - (REPORT_MAX_AGE_HOURS + 1) * 3_600_000).toISOString() }),
    report(['passing'], { computed_at: '2026-12-25T00:00:00Z' }),
    { computed_at: now.toISOString(), checks: [{ check: 'E4', status: 'not_enough_data', detail: { grader_error: 'bad json' } }] }]) {
    const r = brainReportRule({ requestedMode: RISK_MODES.ALL_IN, report: rep, now });
    assert.equal(r.mode, 'balanced', JSON.stringify(rep));
    assert.equal(r.testing_tier_enabled, false);
    assert.ok(r.blocking.length >= 1);
  }
});

test('not_enough_data alone never triggers the fallback', () => {
  const r = brainReportRule({ requestedMode: RISK_MODES.ALL_IN, report: report(Array(8).fill('not_enough_data')), now });
  assert.equal(r.mode, 'all_in');
  assert.equal(r.testing_tier_enabled, true);
});

test('an unknown mode or a missing clock throws instead of guessing', () => {
  assert.throws(() => brainReportRule({ requestedMode: 'yolo', report: null, now }), /unknown risk mode/);
  assert.throws(() => brainReportRule({ requestedMode: 'balanced', report: null }), /valid Date/);
});
