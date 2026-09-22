/**
 * The inventory generator's WRITE PATH was exercised by nothing.
 *
 * Four test files name `scripts/inventory.mjs` — data-lineage-inventory,
 * inventory-blockers, inventory-route-callers, inventory-table-locality — and
 * every one of them IMPORTS a named helper out of it. None runs it. Importing
 * `blockers` never causes the generator to write a byte, so the whole of
 * `buildRows` → `check` → `writeFileSync` could stop producing output and all
 * four files would stay green, reading the artifact committed weeks earlier.
 *
 * This is the same shape as the wiring-map gate fixed alongside it, inverted:
 * there the consumer was verified and the producer was not. "Verify the
 * consumer, not the producer" is a rule about where to look for a defect, not
 * permission to leave the producer unwatched.
 *
 * WHY THIS TEST NEEDED A CODE CHANGE FIRST. `inventory.mjs` wrote to two
 * hardcoded paths under `docs/inventory/`. Running it from a test would have
 * overwritten the committed artifacts mid-suite — dirtying the tree, moving
 * `generated_at`, and being invisible to a `git write-tree` guard, which is the
 * exact defect just fixed in the sibling script. So the generator takes `--out`
 * now, the way `wiring-map.mjs` already did, and this test points it at a temp
 * directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'inventory.mjs');

// One spawn for the whole file: building the inventory reads the map and the
// local database and is not cheap.
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-out-'));

const committed = ['docs/inventory/inventory.json', 'docs/inventory/INVENTORY.md']
  .map(p => path.join(REPO, p));
const before = committed.map(p => fs.statSync(p).mtimeMs);

const run = spawnSync(process.execPath, [SCRIPT, '--out', outDir],
  { encoding: 'utf8', cwd: REPO });

const after = committed.map(p => fs.statSync(p).mtimeMs);
const produced = fs.readdirSync(outDir).sort();
const json = produced.includes('inventory.json')
  ? JSON.parse(fs.readFileSync(path.join(outDir, 'inventory.json'), 'utf8'))
  : null;
fs.rmSync(outDir, { recursive: true, force: true });

test('the inventory generator writes both artifacts', () => {
  assert.equal(run.status, 0,
    `generation should exit 0, got ${run.status}. `
    + `stderr: ${String(run.stderr).slice(0, 500)}`);
  assert.deepEqual(produced, ['INVENTORY.md', 'inventory.json'],
    'nothing else in the suite runs this generator, so this assertion is the '
    + 'only thing standing between it and silently producing nothing.');
});

test('--out is honoured, so generating never touches the committed copies', () => {
  assert.deepEqual(after, before,
    'running the generator modified docs/inventory/. A generator a test can '
    + 'run must be able to write somewhere else, or the test dirties the tree '
    + 'mid-suite — unstaged, and therefore invisible to a git write-tree guard.');
});

test('the generated inventory is a real inventory, not an empty shell', () => {
  assert.ok(json, 'inventory.json was not written at all');
  assert.ok(Array.isArray(json.rows) && json.rows.length > 100,
    `expected a substantial row set, got ${json.rows?.length ?? 'none'}. `
    + 'A generator that writes an empty file passes a mere existence check.');
  // Every row carries a legal status and evidence-or-reason. That is what
  // `--check` enforces; asserting it here means the WRITTEN artifact is
  // checked, not just the in-memory rows the gate happened to look at.
  const statuses = new Set(json.rows.map(r => r.status));
  for (const s of statuses) {
    assert.match(s, /^(wired|half_done|dead_or_stale|silently_broken|phantom_table|unclassified)$/,
      `illegal status "${s}" in the written artifact`);
  }
  for (const r of json.rows) {
    assert.ok(r.evidence || r.reason,
      `row ${r.id} was written with neither evidence nor a reason`);
  }
});
