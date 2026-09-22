/**
 * A gate must not write the file it is gating on.
 *
 * `npm run check:wiring` is `node scripts/wiring-map.mjs --check`, and
 * `.github/workflows/ci.yml:70` runs it as a build step. It was also
 * REGENERATING all three artifacts on every invocation, because the write block
 * was gated on `--findings` alone:
 *
 *     if (!flag('findings')) {
 *       fs.writeFileSync(path.join(outDir, 'wiring-map.json'), …);
 *       fs.writeFileSync(path.join(outDir, 'WIRING-MAP.md'), …);
 *       fs.writeFileSync(path.join(outDir, 'MISSING-FEEDS.md'), …);
 *     }
 *
 * `--check` does not pass `--findings`, so it fell straight into it.
 *
 * WHY THIS IS WORTH A TEST rather than a one-line fix and a shrug. Three
 * separate costs, and the third is the one that bit:
 *
 *   1. A validate-only flag that writes leaves the repository dirty in CI. The
 *      gate reports on a tree it just modified.
 *   2. `generated_at` changes on every run, so the artifact is never
 *      byte-stable and "did the map change?" cannot be answered by diffing it.
 *   3. It is the exact unstaged, mid-run edit that this project's TREE-HASH
 *      RULE cannot see. That rule records `git write-tree` either side of a
 *      suite run — and `git write-tree` hashes the INDEX, so an unstaged write
 *      returns an identical hash. A gate that quietly writes is invisible to
 *      the guard meant to catch exactly this.
 *
 * The verdict itself is computed from `found`, which is built in memory before
 * either block runs. Nothing in the gate reads the files back, so not writing
 * them changes no outcome. Verified: no test asserts the write, and the CI step
 * consumes the exit status only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'wiring-map.mjs');

// ONE spawn, shared by every assertion in this file. Building the map over the
// whole repository takes about twelve seconds, and this file would otherwise
// pay that once per test for no additional coverage.
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-check-'));
// The gate reads its accept lists out of the --out directory. Give it the real
// ones: without them every baselined finding fires and the run is not the one
// CI performs.
fs.copyFileSync(
  path.join(REPO, 'docs', 'wiring', 'annotations.json'),
  path.join(outDir, 'annotations.json'));

const run = spawnSync(process.execPath, [SCRIPT, '--check', '--out', outDir],
  { encoding: 'utf8', cwd: REPO });

const written = fs.readdirSync(outDir).filter(f => f !== 'annotations.json').sort();
fs.rmSync(outDir, { recursive: true, force: true });

// The mirror image, and the reason it is in this file rather than assumed.
// Tightening the write condition can be "fixed" by never writing at all, and
// NOTHING ELSE IN THE SUITE WOULD NOTICE: every other test reads the COMMITTED
// docs/wiring artifacts, so they stay green whether or not the generator can
// still produce them. Measured, not guessed — the seven test files touching
// docs/wiring all read it, none regenerates it. So the generate path gets its
// own spawn, which is the second and last in this file.
const genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-generate-'));
fs.copyFileSync(
  path.join(REPO, 'docs', 'wiring', 'annotations.json'),
  path.join(genDir, 'annotations.json'));

const gen = spawnSync(process.execPath, [SCRIPT, '--out', genDir],
  { encoding: 'utf8', cwd: REPO });

const generated = fs.readdirSync(genDir).filter(f => f !== 'annotations.json').sort();
fs.rmSync(genDir, { recursive: true, force: true });

test('--check does not write the artifacts it is validating', () => {
  assert.deepEqual(written, [],
    `--check wrote ${written.join(', ')} into its --out directory. A gate that `
    + 'regenerates the artifact it is checking leaves the tree dirty in CI and '
    + 'is invisible to a tree-hash guard that reads the index.');
});

// Guard for the test above: deleting the whole `if (flag('check'))` block would
// also leave the directory empty. The gate has to still run.
test('--check still reaches a verdict rather than doing nothing', () => {
  assert.ok(run.status === 0 || run.status === 1,
    `the gate should exit 0 (clean) or 1 (findings), got ${run.status}. `
    + `stderr: ${String(run.stderr).slice(0, 400)}`);
  assert.match(`${run.stdout}${run.stderr}`, /STILL OPEN \(grandfathered/,
    'the gate prints its grandfathered entries on every run so the list cannot '
    + 'go quiet; absent output means the check block did not execute.');
});

test('the generate path still writes all three artifacts', () => {
  assert.equal(gen.status, 0,
    `plain generation should exit 0, got ${gen.status}. `
    + `stderr: ${String(gen.stderr).slice(0, 400)}`);
  assert.deepEqual(generated, ['MISSING-FEEDS.md', 'WIRING-MAP.md', 'wiring-map.json'],
    'narrowing the write condition must not stop `npm run map:wiring` writing. '
    + 'No other test in the suite regenerates these — they all read the '
    + 'committed copies — so this assertion is the only thing standing between '
    + 'a tightened condition and a generator that silently produces nothing.');
});
