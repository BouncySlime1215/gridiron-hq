/**
 * Codex plan section 10.3's acceptance for `server/platform/paths.js`:
 * "Test launch from another working directory and installed/packaged mode."
 *
 * Section 10.4 explains why this matters more than it sounds:
 *
 *     "`nfl-research-lab.js` computes its root from `../..` and reads
 *      `server/data/*​/latest.json` plus `docs/CLAUDE-NEXT-STEPS.md`. A direct
 *      move breaks these even if imports compile."
 *
 * And, separately: "A successful build alone does not test runtime file
 * loading." Both sentences describe failures that are invisible to a compiler,
 * a linter and a type checker, and visible only to something that actually
 * reads a file at runtime from somewhere other than the project directory.
 *
 * That is not hypothetical. While wiring `PROJECT_ROOT` into its three
 * consumers, an import was inserted into the middle of a multi-line import
 * specifier in `role-scenario-lab.js`. `node --check` PASSED on the result —
 * it does not validate ES module import placement — and only actually
 * importing the module surfaced it. The last test in this file is that check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-paths-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
test.after(() => { fs.rmSync(temp, { recursive: true, force: true }); });

const paths = await import('../server/platform/paths.js');

test('every declared root resolves to a real directory', () => {
  const roots = paths.resolvedRoots();
  for (const [name, info] of Object.entries(roots)) {
    assert.equal(info.exists, true, `${name} resolved to ${info.path}, which does not exist`);
    assert.ok(path.isAbsolute(info.path), `${name} must be absolute`);
  }
});

test('the roots do not depend on the working directory', () => {
  // The whole point. `process.cwd()` changes when the app is launched from
  // elsewhere; a root derived from it would change with it.
  const before = paths.PROJECT_ROOT;
  const originalCwd = process.cwd();
  try {
    process.chdir(os.tmpdir());
    assert.equal(paths.PROJECT_ROOT, before,
      'the project root must not move when the process does');
    assert.equal(paths.resolvedRoots().canonical_plan.exists, true,
      'and the canonical plan must still be findable from anywhere');
  } finally {
    process.chdir(originalCwd);
  }
});

test('the canonical plan is readable from another working directory', async () => {
  const originalCwd = process.cwd();
  try {
    process.chdir(os.tmpdir());
    const plan = fs.readFileSync(paths.CANONICAL_PLAN, 'utf8');
    assert.ok(plan.length > 1000);
    assert.match(plan.split('\n')[0], /^# Gridiron HQ/);
    assert.ok(plan.includes('## 0. Status register'),
      'the status register section 12 requires must be present');
  } finally {
    process.chdir(originalCwd);
  }
});

test('the research lab reads the plan through the shared root, from anywhere', async () => {
  // The exact consumer section 10.4 names. It used to walk `../..` from its
  // own file, which would have silently resolved to `server/betting` after the
  // section 10.2 ownership move.
  const lab = await import('../server/services/nfl-research-lab.js');
  const originalCwd = process.cwd();
  try {
    process.chdir(os.tmpdir());
    const plan = await lab.researchMasterPlan();
    assert.ok(plan.length > 1000, 'the plan is still readable after chdir');
    assert.match(plan.split('\n')[0], /^# Gridiron HQ/);
  } finally {
    process.chdir(originalCwd);
  }
});

test('the data root is unchanged by this refactor', () => {
  // Section 10.4: "Keep existing data locations stable through the first
  // reorganization." Moving stored artifacts and moving the code that reads
  // them are two changes, and doing both at once means a failure cannot be
  // attributed to either.
  assert.equal(paths.DATA_ROOT, path.join(paths.SERVER_ROOT, 'data'));
  assert.equal(path.basename(paths.SERVER_ROOT), 'server');
});

test('no service still derives the project root by walking ../.. itself', async () => {
  // The pattern this module exists to remove. A new occurrence would compile,
  // lint, typecheck and pass every other test in this suite, and would break
  // silently the moment its file moved.
  const servicesDir = path.join(paths.SERVER_ROOT, 'services');
  const offenders = [];
  for (const file of fs.readdirSync(servicesDir).filter(f => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(servicesDir, file), 'utf8');
    if (/path\.resolve\(\s*path\.dirname\(fileURLToPath\(import\.meta\.url\)\)\s*,\s*'\.\.\/\.\.'/.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [],
    'these files derive the project root from their own location and will break when moved; ' +
    'import PROJECT_ROOT from server/platform/paths.js instead');
});

test('every module touched by the paths refactor actually IMPORTS', async () => {
  // `node --check` passed on a file whose import had been inserted into the
  // middle of a multi-line import specifier: it does not validate ES module
  // import placement. Only importing the module found it. This is that check,
  // kept because the class of mistake is easy to repeat and invisible to
  // everything else in the pipeline.
  for (const module of ['nfl-research-lab.js', 'role-scenario-lab.js', 'nfl-news-event-impact.js']) {
    await assert.doesNotReject(() => import(`../server/services/${module}`),
      `${module} does not import cleanly`);
  }
});
