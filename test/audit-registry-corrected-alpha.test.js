/**
 * FINAL ORDER #4 item (c) (2026-09-16, RUNBOOK §10.4, migration 054).
 *
 * `runAudit()` has always tightened its significance bar for how many audits
 * were sealed before this one -- a Sidak step over the registry's own history
 * -- and then discarded both inputs. The sealed row recorded `significant`
 * but not the alpha it cleared nor the prior-test count that produced that
 * alpha, which made the correction unauditable in exactly the way a
 * preregistration registry exists to prevent: a reader could not tell whether
 * a "significant" result cleared 0.05 or 0.002, and could not reproduce the
 * decision without replaying the whole registry to recount.
 *
 * These tests pin that the two inputs are now persisted, and -- more
 * importantly -- that the bar genuinely TIGHTENS as the registry fills up,
 * which is the behaviour that makes a late audit harder to pass than an early
 * one and is completely invisible without these columns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-audit-corrected-alpha-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { preregister, runAudit } = await import('../server/services/audit-registry.js');

const sealOne = async (name, pValue) => {
  const pre = preregister({ name, hypothesis: 'h', metric: 'm', direction: 'above', threshold: 0 });
  assert.ok(pre.audit_id, JSON.stringify(pre));
  await runAudit(pre.audit_id, async () => ({ observed: 1, p_value: pValue, sample_size: 100 }));
  return row(`SELECT corrected_alpha_at_seal, prior_tests_at_seal, significant, p_value
              FROM audit_registry WHERE id = ?`, pre.audit_id);
};

test('migration 054 added both columns', () => {
  const columns = new Set(db.prepare(`PRAGMA table_info(audit_registry)`).all().map(c => c.name));
  assert.ok(columns.has('corrected_alpha_at_seal'));
  assert.ok(columns.has('prior_tests_at_seal'));
});

test('a sealed audit records the alpha it was judged against and how many tests preceded it', async () => {
  const sealed = await sealOne('first-audit', 0.01);
  assert.ok(Number.isFinite(sealed.corrected_alpha_at_seal),
    'the corrected alpha must be on the row, not recomputed from scratch by every reader');
  assert.ok(Number.isInteger(sealed.prior_tests_at_seal));
  // 1e-12 tolerance: with zero prior tests the Sidak step is
  // 1 - (1-0.05)^(1/1), which floating point returns as 0.050000000000000044.
  assert.ok(sealed.corrected_alpha_at_seal > 0 && sealed.corrected_alpha_at_seal <= 0.05 + 1e-12,
    `corrected alpha must be at or below the nominal 0.05, got ${sealed.corrected_alpha_at_seal}`);
});

test('the bar TIGHTENS as the registry fills — the whole point of recording it', async () => {
  const alphas = [];
  for (let i = 0; i < 5; i++) {
    const sealed = await sealOne(`tightening-${i}`, 0.0001);
    alphas.push({ alpha: sealed.corrected_alpha_at_seal, prior: sealed.prior_tests_at_seal });
  }
  for (let i = 1; i < alphas.length; i++) {
    assert.ok(alphas[i].prior >= alphas[i - 1].prior,
      `prior-test count must not go backwards: ${JSON.stringify(alphas)}`);
    assert.ok(alphas[i].alpha <= alphas[i - 1].alpha + 1e-12,
      `alpha must tighten or hold as prior tests accumulate: ${JSON.stringify(alphas)}`);
  }
  assert.ok(alphas[alphas.length - 1].alpha < alphas[0].alpha,
    'after several sealed audits the bar must be strictly stricter than it was for the first');
});

test('the recorded alpha is the one actually used — significance agrees with it', async () => {
  // A p-value deliberately between the nominal 0.05 and a tightened bar: the
  // row must not claim significance against a bar it did not clear.
  const sealed = await sealOne('borderline', 0.04);
  assert.equal(typeof sealed.p_value, 'number');
  const shouldBeSignificant = sealed.p_value < sealed.corrected_alpha_at_seal;
  assert.equal(Boolean(sealed.significant), shouldBeSignificant,
    `significant=${sealed.significant} must match p=${sealed.p_value} vs alpha=${sealed.corrected_alpha_at_seal}`);
});

test('an audit with no p-value seals without inventing significance, but still records the bar', async () => {
  const pre = preregister({ name: 'no-p-value', hypothesis: 'h', metric: 'm', direction: 'above', threshold: 0 });
  await runAudit(pre.audit_id, async () => ({ observed: 1, sample_size: 10 }));
  const sealed = row(`SELECT corrected_alpha_at_seal, prior_tests_at_seal, significant
                      FROM audit_registry WHERE id = ?`, pre.audit_id);
  assert.equal(sealed.significant, null, 'no p-value means no significance claim');
  assert.ok(Number.isFinite(sealed.corrected_alpha_at_seal),
    'the bar is still recorded, so a later reader knows what would have been required');
});
