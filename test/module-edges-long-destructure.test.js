/**
 * A destructured dynamic import longer than 220 characters lost every name.
 *
 * `moduleEdges` reads the names of `const { a, b } = await import('./x.js')`
 * by looking BACKWARDS from the `import(` for a destructuring pattern, and it
 * looked back through a fixed 220-character window:
 *
 *   const before = code.slice(Math.max(0, m.index - 220), m.index);
 *   const destructured = before.match(/(?:const|let|var)\s*(\{[^}]*\})\s*=\s*(?:await\s*)?$/);
 *
 * `test/draft-abstention-audit.test.js:17` destructures fourteen names across
 * four lines. From `const` to `import(` is **231 characters**. The window cut
 * the opening brace off, the pattern matched nothing, and the import was
 * recorded as a file edge carrying no names at all.
 *
 * The consequence is a wrong RULE, not just a missing one. Those fourteen
 * exports were reported as `export-imported-by-nothing` — "exported and never
 * imported" — when the map's own `export-only-tested` is the accurate finding
 * and already exists. A reader deleting on that evidence deletes working code
 * that a test imports.
 *
 * Found by an independent import scan written from scratch against the same
 * tree, not by reading this function: 25 of 843 `export-imported-by-nothing`
 * findings were contradicted, across five files, every one of them a
 * destructure over the window.
 *
 * The fix is the same shape as the one `bodyRange` needed the same night: a
 * fixed-size window standing in for a balanced walk. Walk back to the matching
 * brace and the length stops mattering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { moduleEdges } = await import('../scripts/wiring-map.mjs');

const namesFor = (src, spec) => {
  const imp = moduleEdges(src).imports.find((i) => i.spec === spec);
  return (imp?.names ?? []).slice().sort();
};

test('a short destructured dynamic import keeps its names', () => {
  const names = namesFor(`const { alpha, beta } = await import('./x.js');`, './x.js');
  assert.deepEqual(names, ['alpha', 'beta']);
});

test('a destructure longer than 220 characters keeps its names too', () => {
  const long = [
    'const {',
    '  seasonSlotTruth, gradePick, buildAbstentionPanel, fitGate, gateFlags, applyGate,',
    '  clusterTwoSampleDiff, wilson, twoProportion, draftAbstentionAudit,',
    '  REPLACEMENT_SLOT, TIER_BANDS, GATE_FLAGS, MIN_SLICE_SAMPLE',
    "} = await import('./x.js');",
  ].join('\n');
  assert.ok(long.indexOf("import('") > 220, 'the fixture must actually exceed the old window');
  const names = namesFor(long, './x.js');
  for (const n of ['seasonSlotTruth', 'gradePick', 'MIN_SLICE_SAMPLE', 'TIER_BANDS']) {
    assert.ok(names.includes(n), `${n} should be an imported name`);
  }
  assert.equal(names.length, 14);
});

test('an aliased name inside a long destructure is read under both spellings', () => {
  const long = [
    'const {',
    '  padPadPadPadPadPadPadPadPadPad, morePadMorePadMorePadMorePadMorePad,',
    '  yetMorePaddingYetMorePaddingYetMorePadding, andStillMorePaddingHereToo,',
    '  syncAll as syncNflverse',
    "} = await import('./x.js');",
  ].join('\n');
  assert.ok(long.indexOf("import('") > 220);
  const imp = moduleEdges(long).imports.find((i) => i.spec === './x.js');
  assert.ok(imp.names.includes('syncAll'), 'the exported name');
  assert.ok(imp.aliases.some((a) => a.imported === 'syncAll' && a.local === 'syncNflverse'),
    'and the local alias the calls are written under');
});

test('a dynamic import with no destructure before it still takes no names from one further up', () => {
  // The walk must stop at the import it belongs to. Two imports in a row, the
  // first destructured and the second not, must not share names.
  const src = [
    "const { alpha, beta } = await import('./first.js');",
    "await import('./second.js');",
  ].join('\n');
  assert.deepEqual(namesFor(src, './first.js'), ['alpha', 'beta']);
  assert.deepEqual(namesFor(src, './second.js'), []);
});

test('an object literal that is not a destructure is not read as one', () => {
  const src = "const cfg = { a: 1, b: 2 };\nawait import('./x.js');";
  assert.deepEqual(namesFor(src, './x.js'), []);
});

test('the real file that exposed this reports its fourteen names', async () => {
  const src = await readFile(
    new URL('../test/draft-abstention-audit.test.js', import.meta.url), 'utf8');
  const names = namesFor(src, '../server/services/draft-abstention-audit.js');
  assert.ok(names.includes('draftAbstentionAudit'));
  assert.ok(names.includes('MIN_SLICE_SAMPLE'));
  assert.equal(names.length, 14);
});
