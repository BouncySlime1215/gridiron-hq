import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scorePythonArtifact, resolveResearchPython } from '../server/betting/nfl/forecast/python-artifact.js';
import { RESEARCH_ROOT } from '../server/platform/paths.js';

// This file dynamically imports spread-family-adapters.js below, which opens
// and migrates the database on import. Without a scratch path set first,
// that falls through to the real server/data.sqlite default (see
// server/db/index.js's DB_PATH), just as test/spread-family-adapters.test.js
// warns against. Mirror that file's guard.
const dbTemp = mkdtempSync(path.join(os.tmpdir(), 'gridiron-python-artifact-db-'));
process.env.GRIDIRON_DB_PATH = path.join(dbTemp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, dbPath } = await import('../server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH,
  'a python-artifact test must never be able to reach the real database');
after(() => { db.close(); rmSync(dbTemp, { recursive: true, force: true }); });

const python = resolveResearchPython();

test('Python worker is explicitly unavailable when executable is missing', async () => {
  const result = await scorePythonArtifact({}, { python: '/no/such/python' });
  assert.equal(result.available, false);
  assert.equal(result.qualified, false);
});

test('real Node/Python scoring boundary', { skip: python ? false : 'configure GRIDIRON_RESEARCH_PYTHON for Python integration' }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gridiron-python-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = JSON.parse(execFileSync(python, [path.join(RESEARCH_ROOT, 'betting/nfl/test_score_artifact.py'), '--fixture-root', root], { encoding: 'utf8' }));
  const options = { artifactRoot: root, python };
  const request = fixture.request;

  await t.test('Node and family adapter match direct Python; fresh workers replay identically', async () => {
    const before = structuredClone(request);
    const first = await scorePythonArtifact(request, options);
    assert.equal(first.available, true, first.reason);
    assert.equal(first.predicted_margin, fixture.direct);
    assert.equal(first.qualified, false);
    assert.equal(first.probabilities.available, false);
    assert.deepEqual(await scorePythonArtifact(request, options), first);
    assert.deepEqual(request, before);
    const { trainedMarginFamilyForecast } = await import('../server/betting/nfl/forecast/spread-family-adapters.js');
    const family = await trainedMarginFamilyForecast(request, options);
    assert.equal(family.family, 'trained_margin');
    assert.equal(family.observed, true);
    assert.equal(family.margin.predicted, fixture.direct);
    assert.equal(family.qualified, false);
  });

  await t.test('bad feature ordering, future-trained artifact and nonfinite input abstain', async () => {
    for (const change of [r => r.feature_names.reverse(), r => r.cutoff_at = '1900-01-01T00:00:00Z',
      r => r.features.home_rest = NaN, r => r.features.home_rest = Infinity]) {
      const bad = structuredClone(request); change(bad);
      const result = await scorePythonArtifact(bad, options);
      assert.equal(result.available, false);
      assert.equal(result.qualified, false);
    }
  });

  await t.test('missing executable, timeout and missing artifact report explicit failures', async () => {
    const missingPython = await scorePythonArtifact(request, { ...options, python: '/no/such/python' });
    assert.match(missingPython.reason, /python_worker_failed/);
    const timedOut = await scorePythonArtifact(request, { ...options, timeoutMs: 1 });
    assert.match(timedOut.reason, /python_worker_failed/);
    const missing = structuredClone(request); missing.artifact.run_id = 'absent';
    assert.equal((await scorePythonArtifact(missing, options)).available, false);
  });

  await t.test('artifact root cannot be escaped by traversal or symlink', async () => {
    const bad = structuredClone(request); bad.artifact.run_id = '../elsewhere';
    assert.equal((await scorePythonArtifact(bad, options)).available, false);
    symlinkSync(os.tmpdir(), path.join(root, 'outside'));
    bad.artifact.run_id = 'outside';
    assert.match((await scorePythonArtifact(bad, options)).reason, /escaped/);
  });

  await t.test('changed metadata and corrupted model are refused on the next process', async () => {
    const meta = path.join(fixture.directory, 'metadata.json');
    const original = readFileSync(meta);
    writeFileSync(meta, Buffer.concat([original, Buffer.from(' ')]));
    assert.match((await scorePythonArtifact(request, options)).reason, /metadata content hash/);
    writeFileSync(meta, original);
    writeFileSync(path.join(fixture.directory, 'model.joblib'), 'corrupt');
    assert.match((await scorePythonArtifact(request, options)).reason, /content hash mismatch/);
  });
});
