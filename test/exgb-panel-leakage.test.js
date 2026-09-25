// E-XGB phase 1: the panel's leakage test runs with the rest of the suite.
// scripts/eval/test_exgb_panel.py builds a synthetic database and proves that no feature of
// week w moves when every outcome from week w on is changed, and that the check catches a
// planted same-game feature. It needs python3 with numpy; without them this is skipped and
// says why, rather than passing silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = spawnSync('python3', ['-c', 'import numpy'], { encoding: 'utf8' });
const reason = probe.error ? `python3 not available (${probe.error.code})`
  : probe.status !== 0 ? 'python3 has no numpy' : null;

test('E-XGB panel: lagged-only features, availability rows, leakage check', { skip: reason ?? false }, () => {
  const r = spawnSync('python3', ['-m', 'unittest', 'scripts/eval/test_exgb_panel.py'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran 7 tests/);
});
