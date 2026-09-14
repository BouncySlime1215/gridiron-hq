import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-overfitting-gate-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { nflOperations } = await import('../server/services/nfl-research.js');
const { declareTrial, scoreTrial } = await import('../server/services/research-trials.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

// Regression for the exact gap the recovered research flagged: the
// deflated-Sharpe/effective-trial-count math (trial-statistics.js) was
// correct but connected to nothing that could block a promotion. These check
// the new overfitting_correction gate nfl-research.js's nflOperations() now
// carries.

test('overfitting-correction gate fails closed until enough live trials exist to compute it', () => {
  const result = nflOperations();
  const gate = result.gates.find(g => g.id === 'overfitting_correction');
  assert.ok(gate, 'expected an overfitting_correction gate in nflOperations()');
  assert.equal(gate.passed, false, 'must fail closed with no live trial history, not pass by default');
  assert.match(gate.actual, /0 live trial/);
});

test('overfitting-correction gate computes a real deflated Sharpe ratio once enough live trials exist', () => {
  // Seed 8 synthetic but internally-consistent live trials directly (the
  // path nflOperations({persist:true}) would populate over real time), then
  // confirm the gate reads them back and computes a bounded DSR rather than
  // just counting them.
  const sharpeValues = [0.05, 0.08, -0.02, 0.12, 0.03, 0.15, -0.05, 0.20];
  sharpeValues.forEach((sharpe, index) => {
    const key = `synthetic-${index}`;
    const at = new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
    const detail = { n: 50, skewness: 0, kurtosis: 3, source: 'test' };
    declareTrial({ kind: 'nfl_operations_sharpe', key, declaredAt: at, metric: 'sharpe', value: sharpe, status: 'scored', detail });
    scoreTrial('nfl_operations_sharpe', key, { scoredAt: at, metric: 'sharpe', value: sharpe, detail });
  });
  const result = nflOperations();
  const gate = result.gates.find(g => g.id === 'overfitting_correction');
  assert.match(gate.actual, /DSR=([0-9.]+) over/, `expected a computed DSR, got: ${gate.actual}`);
  const dsr = Number(gate.actual.match(/DSR=([0-9.]+)/)[1]);
  assert.ok(dsr >= 0 && dsr <= 1, `DSR must be a probability, got ${dsr}`);
  assert.equal(gate.passed, dsr >= 0.95, 'passed must follow directly from the computed DSR and its stated threshold');
});

test('overfitting-correction gate does not double-count a re-run against unchanged evidence', () => {
  // nflOperations({persist:true}) keys the live trial on the exact-policy
  // result's own content (bets/wins/losses/units), so calling it twice
  // against the same underlying data must register at most one new trial,
  // not one per call -- otherwise a dashboard refresh would silently
  // manufacture trial count.
  const before = nflOperations().gates.find(g => g.id === 'overfitting_correction').actual;
  nflOperations({ persist: true });
  nflOperations({ persist: true });
  const after = nflOperations().gates.find(g => g.id === 'overfitting_correction').actual;
  // No exact_policy overall exists on this empty fixture DB (no replay run
  // persisted), so persist:true has nothing real to register either time --
  // the count must stay exactly where it was, not increase from repeated
  // no-op calls.
  assert.equal(before, after);
});
