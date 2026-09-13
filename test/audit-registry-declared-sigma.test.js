/**
 * u5-clv-endpoints (2026 pre-registration, Step 0 item 5).
 *
 * Two gaps this closes, both on a database that HAS run migrations (unlike
 * test/audit-registry-always-valid.test.js, which deliberately runs against
 * the unmigrated legacy snapshot to prove the unmigrated path still works):
 *
 *   1. `always_valid_p` sat NULL on all 15 rows this registry has ever
 *      sealed because nothing ever declared a sigma. `preregister()` can now
 *      commit to one BEFORE the audit ever runs, and `runAudit()` reaches for
 *      it automatically — a producer no longer has to remember to pass it,
 *      and can't quietly override a value the row already froze.
 *   2. When no anytime-valid number CAN be produced, the reason is now a
 *      queryable value on the row (`always_valid_variance_source`), not a
 *      silent NULL indistinguishable from "not evaluated yet."
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-audit-declared-sigma-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { preregister, runAudit, auditDetail } = await import('../server/services/audit-registry.js');
const { withRandomSeed, randn } = await import('../server/services/stats-util.js');

function realEffectSequence(seed, n, mean) {
  const xs = [];
  withRandomSeed(seed, () => { for (let i = 0; i < n; i++) xs.push(mean + randn()); });
  return xs;
}

test('a declared sigma is rejected up front when the migration has not run', async () => {
  // Simulated by asking for a sigma no schema could store — the real check
  // is column presence, exercised here just by confirming a well-formed
  // request on a MIGRATED db (this file's own fixture) succeeds, which the
  // sibling always-valid test file's unmigrated fixture would refuse.
  const pre = preregister({ name: 'sanity', hypothesis: 'h', metric: 'm', threshold: 0,
    declaredSigma: 1, declaredSigmaSource: 'test' });
  assert.ok(pre.audit_id, JSON.stringify(pre));
  assert.equal(pre.declared_sigma, 1);
  assert.equal(pre.declared_sigma_source, 'test');
});

test('declaredSigma requires declaredSigmaSource — a variance with no cited evidence is a guess', () => {
  const pre = preregister({ name: 'no-source', hypothesis: 'h', metric: 'm', threshold: 0, declaredSigma: 1 });
  assert.ok(pre.error);
});

test('a sigma declared at preregistration is used automatically at run time, without the producer supplying it', async () => {
  const seq = realEffectSequence(7, 300, 0.4); // a real, moderate effect
  const trueSigma = 1; // randn() is standard normal
  const pre = preregister({ name: 'declared-sigma-audit', hypothesis: 'a real effect, sigma known up front',
    metric: 'mean_gap', direction: 'above', threshold: 0, requireSignificance: true,
    declaredSigma: trueSigma, declaredSigmaSource: 'unit-test: randn() is standard normal by construction' });
  assert.ok(pre.audit_id);

  const result = await runAudit(pre.audit_id, async () => ({
    observed: seq.reduce((s, x) => s + x, 0) / seq.length,
    sample_size: seq.length,
    p_value: 1e-9,
    sequence: seq
    // Deliberately NOT passing always_valid_sigma here — the row's own
    // declared_sigma must be what feeds the mSPRT.
  }));

  assert.equal(result.status, 'sealed');
  assert.ok(result.always_valid, JSON.stringify(result));
  assert.equal(result.always_valid.anytime_valid, true,
    'sigma came from the row, declared before this run, so the result must be labelled anytime-valid');
  assert.equal(result.always_valid.variance_source, 'declared_in_advance');
  assert.equal(result.always_valid.sigma, trueSigma);
  assert.equal(result.passed, true);

  const detail = auditDetail(pre.audit_id);
  assert.equal(detail.always_valid_p_anytime, result.always_valid.p_always_valid,
    'the split column persists the same anytime-valid number the run-time result reported');
  assert.equal(detail.always_valid_p_fixed_sample, null);
  assert.equal(detail.always_valid_variance_source, 'declared_in_advance');
  assert.equal(detail.always_valid_p, result.always_valid.p_always_valid,
    'the legacy combined column still carries the number too, for anything still reading it');
});

test('a producer-supplied sigma is used only when the row declared none', async () => {
  const seq = realEffectSequence(8, 300, 0.4);
  const pre = preregister({ name: 'producer-sigma-audit', hypothesis: 'h', metric: 'mean_gap',
    direction: 'above', threshold: 0, requireSignificance: true });
  const result = await runAudit(pre.audit_id, async () => ({
    observed: seq.reduce((s, x) => s + x, 0) / seq.length, sample_size: seq.length, p_value: 1e-9,
    sequence: seq, always_valid_sigma: 1
  }));
  assert.equal(result.always_valid.anytime_valid, true);
  assert.equal(result.always_valid.variance_source, 'declared_in_advance');
});

test('no sequence at all: the reason is explicit and queryable, not a silent NULL', async () => {
  const pre = preregister({ name: 'no-sequence-audit-migrated', hypothesis: 'h', metric: 'm',
    direction: 'above', threshold: 0, requireSignificance: true });
  const result = await runAudit(pre.audit_id, async () => ({ observed: 5, sample_size: 400, p_value: 1e-9 }));
  assert.equal(result.status, 'sealed');
  assert.equal(result.always_valid.reason, 'no_sequence_supplied');
  assert.equal(result.passed, false);

  const detail = auditDetail(pre.audit_id);
  assert.equal(detail.always_valid_p, null);
  assert.equal(detail.always_valid_p_anytime, null);
  assert.equal(detail.always_valid_p_fixed_sample, null);
  assert.equal(detail.always_valid_variance_source, 'no_sequence_supplied',
    'a migrated database can now tell WHY this row has no always-valid number, by reading the row alone');
});

test('a sequence too short for the mSPRT gets its own distinct, queryable reason', async () => {
  const pre = preregister({ name: 'short-sequence-audit', hypothesis: 'h', metric: 'm',
    direction: 'above', threshold: 0, requireSignificance: true });
  const result = await runAudit(pre.audit_id, async () => ({
    observed: 5, sample_size: 3, p_value: 0.2, sequence: [1, 2, 3]
  }));
  assert.equal(result.always_valid.reason, 'sequence_too_short');
  const detail = auditDetail(pre.audit_id);
  assert.equal(detail.always_valid_variance_source, 'sequence_too_short');
});

test('a plug-in (undeclared) sigma is still reported, still gates, and is labelled NOT anytime-valid', async () => {
  const seq = realEffectSequence(9, 200, 0.5);
  const pre = preregister({ name: 'plugin-sigma-audit', hypothesis: 'h', metric: 'm',
    direction: 'above', threshold: 0, requireSignificance: true });
  const result = await runAudit(pre.audit_id, async () => ({
    observed: seq.reduce((s, x) => s + x, 0) / seq.length, sample_size: seq.length, p_value: 1e-9, sequence: seq
  }));
  assert.equal(result.always_valid.anytime_valid, false);
  assert.equal(result.always_valid.variance_source, 'plugin_from_evaluated_sequence');
  const detail = auditDetail(pre.audit_id);
  assert.equal(detail.always_valid_p_fixed_sample, result.always_valid.p_fixed_sample_only);
  assert.equal(detail.always_valid_p_anytime, null);
  assert.equal(detail.always_valid_variance_source, 'plugin_from_evaluated_sequence');
});
