import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// decay-watch.js's job: an already-approved finding (a coordinator weight, a
// calibration gate) can be true when it ships and stop being true later —
// McLean & Pontiff (2016) found published return predictors decay 26-58%
// out-of-sample; the sports-betting analogue is the same crowding/repricing
// mechanism (Levitt 2004; Springer 2023 on NFL line-movement visibility).
// audit-registry.js's sealed audits cannot re-check this by design (that
// would be p-hacking the ORIGINAL approval) — decay-watch.js is a genuinely
// separate mechanism that grades an already-shipped, frozen artifact against
// data strictly after its approval boundary, using the always-valid
// sequential test so it can be checked again every day without inflating the
// false-positive rate.
//
// This suite injects synthetic findings (the same "producer function"
// pattern audit-registry's own tests use for runAudit) so it never has to
// touch the real, expensive fantasy-coordinator/prop-calibration pipelines —
// it proves the MONITOR's logic, not the specific pipelines it happens to
// watch in production.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-decay-watch-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runDecayWatch, decayWatchStatus, decayWatchHistory } = await import('../server/services/decay-watch.js');
const { withRandomSeed, randn } = await import('../server/services/stats-util.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

/**
 * A per-unit signed sequence in the exact shape decay-watch's real
 * computeSequence functions produce: `baselineError - modelError`, positive
 * when the approved finding still beats the pre-finding baseline. `trueMean`
 * is the finding's REAL post-approval effect — 0 means the effect that was
 * approved has completely vanished on fresh, out-of-sample data (mirrors the
 * "no edge" shape used elsewhere in this session's tests), a positive value
 * means it is still real.
 */
function postApprovalSequence(seed, n, trueMean) {
  const xs = [];
  withRandomSeed(seed, () => { for (let i = 0; i < n; i++) xs.push(trueMean + randn()); });
  return xs;
}

test('a finding whose true effect has vanished after approval is flagged as decayed', async () => {
  const vanished = {
    vanished_finding: {
      label: 'Synthetic finding whose real effect vanished post-approval',
      computeSequence: async () => ({
        approvedAt: '2025-01-01T00:00:00Z',
        sequence: postApprovalSequence(1, 400, 0) // true post-approval effect: exactly zero
      })
    }
  };
  const result = await runDecayWatch({ minN: 30, alpha: 0.05, findings: vanished });
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.finding_key, 'vanished_finding');
  assert.equal(finding.status, 'decayed', `expected status 'decayed', got '${finding.status}' (${finding.reason})`);
  assert.equal(finding.flag, true, 'a vanished post-approval effect must be flagged for human review');
  assert.deepEqual(result.flagged, ['vanished_finding']);

  // The status view (what a human/agent would actually check) must surface it too.
  const status = decayWatchStatus({ findings: vanished });
  assert.equal(status.needs_review, true);
  assert.deepEqual(status.flagged, ['vanished_finding']);
  assert.equal(status.findings[0].status, 'decayed');

  // And it must be a monitor, never a corrector: nothing about this result
  // instructs any caller to unpromote or change behavior automatically.
  assert.match(result.policy, /monitor, not a corrector/);
});

test('a finding whose real effect persists after approval is NOT falsely flagged', async () => {
  const persisting = {
    persisting_finding: {
      label: 'Synthetic finding whose real effect held up post-approval',
      computeSequence: async () => ({
        approvedAt: '2025-01-01T00:00:00Z',
        // A real, moderate, persisting positive effect — comparable in size
        // to the ~3% MAE reduction fantasy-coordinator.js documents as its
        // own real, validated result (theta well above noise for n=400).
        sequence: postApprovalSequence(2, 400, 0.5)
      })
    }
  };
  const result = await runDecayWatch({ minN: 30, alpha: 0.05, findings: persisting });
  const finding = result.findings[0];
  assert.equal(finding.status, 'holding', `expected status 'holding', got '${finding.status}' (${finding.reason})`);
  assert.equal(finding.flag, false, 'a real, persisting effect must not be flagged as decayed');
  assert.deepEqual(result.flagged, []);

  const status = decayWatchStatus({ findings: persisting });
  assert.equal(status.needs_review, false);
});

test('a finding whose effect reverses sign after approval is flagged, distinctly from a merely vanished one', async () => {
  const reversed = {
    reversed_finding: {
      label: 'Synthetic finding that now actively hurts vs. the pre-finding baseline',
      computeSequence: async () => ({
        approvedAt: '2025-01-01T00:00:00Z',
        sequence: postApprovalSequence(3, 400, -0.5) // significantly negative, not just flat
      })
    }
  };
  const result = await runDecayWatch({ minN: 30, alpha: 0.05, findings: reversed });
  const finding = result.findings[0];
  assert.equal(finding.status, 'reversed');
  assert.equal(finding.flag, true);
});

test('a finding with too few fresh post-approval observations is neither flagged nor judged', async () => {
  const young = {
    young_finding: {
      label: 'Synthetic finding approved too recently to have enough fresh data',
      computeSequence: async () => ({ approvedAt: '2026-08-01T00:00:00Z', sequence: postApprovalSequence(4, 10, 0.5) })
    }
  };
  const result = await runDecayWatch({ minN: 30, findings: young });
  const finding = result.findings[0];
  assert.equal(finding.status, 'insufficient_data');
  assert.equal(finding.flag, false);
});

test('a finding with no post-approval window yet (computeSequence reports an error) is not_applicable, not flagged', async () => {
  const none = {
    unripe_finding: {
      label: 'Synthetic finding with no season after its approval boundary yet',
      computeSequence: async () => ({ error: 'no season after the approved fit exists yet', approvedAt: '2026-01-01T00:00:00Z' })
    }
  };
  const result = await runDecayWatch({ findings: none });
  const finding = result.findings[0];
  assert.equal(finding.status, 'not_applicable');
  assert.equal(finding.flag, false);
});

test('a finding whose computeSequence throws is recorded as an error, not silently dropped', async () => {
  const broken = {
    broken_finding: {
      label: 'Synthetic finding whose sequence computation fails',
      computeSequence: async () => { throw new Error('boom'); }
    }
  };
  const result = await runDecayWatch({ findings: broken });
  assert.equal(result.findings[0].status, 'error');
  assert.equal(result.findings[0].flag, false);
  assert.match(result.findings[0].reason, /boom/);
});

test('every run is persisted and readable back through decayWatchHistory', async () => {
  const finding = {
    persisted_check: {
      label: 'Synthetic finding for the persistence check',
      computeSequence: async () => ({ approvedAt: '2025-01-01T00:00:00Z', sequence: postApprovalSequence(5, 400, 0) })
    }
  };
  await runDecayWatch({ findings: finding });
  const history = decayWatchHistory(500);
  const mine = history.filter(h => h.finding_key === 'persisted_check');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'decayed');
  assert.equal(mine[0].flag, true);
  assert.ok(mine[0].checked_at);
});
