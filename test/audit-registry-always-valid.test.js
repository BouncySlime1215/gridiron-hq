import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The audit registry's Šidák correction and the always-valid (mSPRT) check
// answer different questions and are both required when an audit declares
// requireSignificance: Šidák corrects across every audit ever filed; the
// always-valid check guards against re-asking the SAME question against a
// growing paired sequence. This suite verifies the wiring: both gates must
// pass, a producer that doesn't supply a sequence can't slip through on the
// raw p_value alone, and a real, strong, growing effect clears both.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-audit-av-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { preregister, runAudit } = await import('../server/services/audit-registry.js');
const { withRandomSeed, randn } = await import('../server/services/stats-util.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

function realEffectSequence(seed, n, mean) {
  const xs = [];
  withRandomSeed(seed, () => { for (let i = 0; i < n; i++) xs.push(mean + randn()); });
  return xs;
}

test('an audit with a real growing sequence and a real p-value passes both gates', async () => {
  const seq = realEffectSequence(1, 400, 0.5); // theta=0.5, sigma~1: clearly real
  const pre = preregister({ name: 'real-effect-audit', hypothesis: 'this model beats baseline',
    metric: 'mean_gap', direction: 'above', threshold: 0, requireSignificance: true });
  assert.ok(pre.audit_id);
  const result = await runAudit(pre.audit_id, async () => ({
    observed: seq.reduce((s, x) => s + x, 0) / seq.length,
    sample_size: seq.length,
    p_value: 1e-12, // a real, strong fixed-N p-value to match
    sequence: seq
  }));
  assert.equal(result.status, 'sealed');
  assert.ok(result.always_valid, 'expected an always-valid result to be computed from the supplied sequence');
  assert.equal(result.always_valid.significant, true);
  assert.equal(result.significant, true);
  assert.equal(result.passed, true);
});

test('an audit that declares requireSignificance but supplies no sequence cannot pass on the raw p-value alone', async () => {
  const pre = preregister({ name: 'no-sequence-audit', hypothesis: 'this model beats baseline',
    metric: 'mean_gap', direction: 'above', threshold: 0, requireSignificance: true });
  const result = await runAudit(pre.audit_id, async () => ({
    observed: 5, sample_size: 400, p_value: 1e-12 // no `sequence` supplied
  }));
  assert.equal(result.status, 'sealed');
  assert.equal(result.significant, true, 'the raw p-value gate alone should still report significant');
  assert.equal(result.passed, false, 'without a sequence the always-valid gate cannot be evaluated, so the stronger requirement is not met');
  assert.equal(result.always_valid.p_always_valid, null);
});

test('an audit whose sequence is pure noise (no real effect) fails the always-valid gate even with an implausibly small reported p-value', async () => {
  const seq = realEffectSequence(2, 400, 0); // theta=0: no real effect
  const pre = preregister({ name: 'noise-with-fake-p-audit', hypothesis: 'this model beats baseline',
    metric: 'mean_gap', direction: 'above', threshold: -100, requireSignificance: true });
  const result = await runAudit(pre.audit_id, async () => ({
    observed: 1, sample_size: seq.length,
    p_value: 1e-9, // a mis-specified/naive p-value pretending to be significant
    sequence: seq
  }));
  assert.equal(result.status, 'sealed');
  assert.equal(result.always_valid.significant, false, 'a genuinely null sequence should not clear the always-valid gate');
  assert.equal(result.passed, false, 'both gates are required; the always-valid gate blocks this pass even though the raw p-value looked significant');
});

test('an audit without requireSignificance is unaffected by the always-valid gate', async () => {
  const pre = preregister({ name: 'no-significance-required-audit', hypothesis: 'observed exceeds threshold',
    metric: 'raw_metric', direction: 'above', threshold: 0, requireSignificance: false });
  const result = await runAudit(pre.audit_id, async () => ({ observed: 3.2, sample_size: 40 }));
  assert.equal(result.status, 'sealed');
  assert.equal(result.passed, true);
  assert.equal(result.always_valid, null);
});
