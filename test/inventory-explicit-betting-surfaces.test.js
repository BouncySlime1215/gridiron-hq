/**
 * The betting surface test is an EXPLICIT list of route files, not a prefix rule.
 *
 * Auditor R17/R18 settled it: a mount prefix is evidence for ADDING a surface to
 * the list, never the test itself. The prefix rule got two things right by
 * accident and one wrong on the merits:
 *
 *   right   `/api/betting/wong` -- wong.js is under the betting hub's prefix
 *   right   `/api/nfl-market`, `/api/nfl-betting`
 *   WRONG   execution-slate.js is mounted at `/api/execution-slate`, which no
 *           betting prefix matches, so a module served only by it graded `wired`
 *
 * and it has no way to express `routes/mlb.js`, which is a third label -- neither
 * betting nor fantasy -- rather than a betting surface or a fantasy one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { SURFACE_LABELS, familyLabels, bettingOnly } =
  await import('../scripts/inventory.mjs');

const map = JSON.parse(readFileSync('docs/wiring/wiring-map.json', 'utf8'));

test('the list is the six files the Auditor named, each with a label', () => {
  assert.deepEqual([...SURFACE_LABELS.entries()].sort(), [
    ['server/routes/betting-hub.js', 'betting'],
    ['server/routes/execution-slate.js', 'betting'],
    ['server/routes/mlb.js', 'mlb'],
    ['server/routes/nfl-betting.js', 'betting'],
    ['server/routes/nfl-market.js', 'betting'],
    ['server/routes/wong.js', 'betting'],
  ]);
});

test('every listed file is actually mounted, so the list cannot go stale in silence', () => {
  const mounted = new Set((map.mounts ?? []).map((m) => m.file));
  for (const f of SURFACE_LABELS.keys()) {
    assert.ok(mounted.has(f), `${f} is on the betting surface list but nothing mounts it`);
  }
});

test('family labels come from what is mounted, not from the family name', () => {
  const labels = familyLabels(map.mounts ?? []);
  assert.equal(labels.get('/api/nfl-market'), 'betting');
  assert.equal(labels.get('/api/nfl-betting'), 'betting');
  // betting-hub.js AND wong.js both land in this family; both are betting.
  assert.equal(labels.get('/api/betting'), 'betting');
  // The case the prefix rule could not reach.
  assert.equal(labels.get('/api/execution-slate'), 'betting');
  // Its own label: a module served only here is not betting-only BY DEFINITION.
  assert.equal(labels.get('/api/mlb'), 'mlb');
  // Everything else is unlabelled, which is what makes a row fantasy-wired.
  assert.equal(labels.get('/api/model'), undefined);
  assert.equal(labels.get('/api/players'), undefined);
});

test('a family with any unlisted file mounted under it is not betting', () => {
  const labels = familyLabels([
    { prefix: '/api/betting', file: 'server/routes/betting-hub.js' },
    { prefix: '/api/betting/somethingelse', file: 'server/routes/somethingelse.js' },
  ]);
  assert.equal(labels.get('/api/betting'), undefined);
});

test('execution-slate reach alone is betting-only', () => {
  const labels = familyLabels(map.mounts ?? []);
  assert.equal(bettingOnly({ route_families: [{ name: '/api/execution-slate', hops: 1 }] },
    new Set(), labels), true);
});

test('mlb reach alone is NOT betting-only, and not fantasy either', () => {
  const labels = familyLabels(map.mounts ?? []);
  assert.equal(bettingOnly({ route_families: [{ name: '/api/mlb', hops: 1 }] },
    new Set(), labels), false);
});

test('a betting family plus an unlabelled one is not betting-only', () => {
  const labels = familyLabels(map.mounts ?? []);
  assert.equal(bettingOnly({ route_families: [
    { name: '/api/nfl-betting', hops: 1 }, { name: '/api/model', hops: 2 }] },
    new Set(), labels), false);
});
