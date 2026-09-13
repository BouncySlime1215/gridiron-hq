import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-research-trials-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { declareTrial, scoreTrial, listTrials, scoredTrialSequence, identityHash } =
  await import('../server/services/research-trials.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('declareTrial requires a real historical declaredAt, not a default', () => {
  assert.throws(() => declareTrial({ kind: 'unit-test', key: 'a', metric: 'x', value: 1 }),
    /requires a real declaredAt/);
});

test('declareTrial is idempotent on (kind, key): a re-run backfill does not inflate the count', () => {
  const first = declareTrial({ kind: 'unit-test', key: 'model-a', declaredAt: '2026-08-03T00:00:00Z',
    metric: 'materiality', detail: { name: 'Model A' } });
  assert.equal(first.already_existed, false);
  const second = declareTrial({ kind: 'unit-test', key: 'model-a', declaredAt: '2026-08-03T00:00:00Z',
    metric: 'materiality', detail: { name: 'Model A (re-run)' } });
  assert.equal(second.already_existed, true);
  assert.equal(second.id, first.id);
  const all = listTrials({ kind: 'unit-test' });
  assert.equal(all.filter(t => t.identity_hash === identityHash('unit-test', 'model-a')).length, 1);
});

test('scoreTrial refuses a scoredAt earlier than declaredAt', () => {
  declareTrial({ kind: 'unit-test', key: 'model-b', declaredAt: '2026-08-10T00:00:00Z', metric: 'roi' });
  assert.throws(() => scoreTrial('unit-test', 'model-b', { scoredAt: '2026-08-01T00:00:00Z', value: 0.1 }),
    /precedes declared_at/);
});

test('scoreTrial attaches a real outcome and merges detail', () => {
  declareTrial({ kind: 'unit-test', key: 'model-c', declaredAt: '2026-08-10T00:00:00Z', metric: 'roi',
    detail: { family: 'Rating systems' } });
  const scored = scoreTrial('unit-test', 'model-c',
    { scoredAt: '2026-08-27T00:00:00Z', value: -0.05, detail: { observed_bets: 199 } });
  assert.equal(scored.status, 'scored');
  assert.equal(scored.value, -0.05);
  const [row] = listTrials({ kind: 'unit-test' }).filter(t => t.identity_hash === identityHash('unit-test', 'model-c'));
  assert.equal(row.detail.family, 'Rating systems');
  assert.equal(row.detail.observed_bets, 199);
});

test('scoreTrial throws for a trial that was never declared', () => {
  assert.throws(() => scoreTrial('unit-test', 'never-declared', { scoredAt: '2026-08-27T00:00:00Z', value: 1 }),
    /no declared trial/);
});

test('scoredTrialSequence only includes scored trials with a finite normalized value, in scored_at order', () => {
  declareTrial({ kind: 'seq-test', key: 'x1', declaredAt: '2026-08-01T00:00:00Z', metric: 'roi' });
  scoreTrial('seq-test', 'x1', { scoredAt: '2026-08-05T00:00:00Z', value: 0.02 });
  declareTrial({ kind: 'seq-test', key: 'x2', declaredAt: '2026-08-02T00:00:00Z', metric: 'roi' });
  // x2 never scored -- must not appear in the sequence.
  declareTrial({ kind: 'seq-test', key: 'x3', declaredAt: '2026-08-03T00:00:00Z', metric: 'roi' });
  scoreTrial('seq-test', 'x3', { scoredAt: '2026-08-04T00:00:00Z', value: -0.01 });

  const seq = scoredTrialSequence({ kind: 'seq-test', normalize: t => t.value * 100 });
  const keys = seq.map(t => t.z);
  assert.deepEqual(keys, [-1, 2]); // x3 (scored 08-04) before x1 (scored 08-05)
});

test('the migration 038 trigger also enforces scored_at >= declared_at at the DB level', () => {
  declareTrial({ kind: 'trigger-test', key: 't1', declaredAt: '2026-08-10T00:00:00Z', metric: 'roi' });
  const hash = identityHash('trigger-test', 't1');
  assert.throws(() => db.prepare(`UPDATE research_trials SET scored_at=? WHERE identity_hash=?`)
    .run('2026-08-01T00:00:00Z', hash), /scored_at must be >= declared_at/);
});
