/**
 * AN ACCEPT-LIST ENTRY THAT HAS OUTLIVED ITS REASON.
 *
 * `docs/wiring/annotations.json` says it in its own words, under
 * `_PERMANENT_ORPHAN_REASONS._why`: "If the condition is met and the module is
 * still listed, that is a defect in this file, not in the module." Nothing
 * checked it. The gate reported one half of that — an entry naming a file that
 * is not in the tree — and nothing at all about the other half, which is the
 * half that actually happens: the module gets wired, the finding it was
 * silencing disappears, and the entry stays behind saying a thing that is no
 * longer true. The next person reads it as a live decision.
 *
 * The retirement condition is exact rather than a heuristic, and it is taken
 * from the run's own output: an entry is spent when no finding in the orphan
 * family names it any more. "Imported by something now" would be the guess,
 * and it would be wrong for a module that gained an importer and still reaches
 * no surface — which is a different rule, and still silenced by this entry.
 *
 * Report, never gate, matching the posture the file-not-in-tree half already
 * has: an entry can legitimately run ahead of a branch, and failing a build on
 * a merge-order accident teaches people to delete the entry rather than land
 * the file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { staleOrphanEntries, acceptGuard } = await import('../scripts/wiring-map.mjs');

const has = (list, name) => list.some(s => s.entry === name);
const whyOf = (list, name) => list.find(s => s.entry === name)?.why ?? '';

test('an entry naming a file that is not in the tree is reported', () => {
  const stale = staleOrphanEntries({
    entries: ['module:server/services/cascade-grade.js'],
    exists: () => false,
    silences: () => false,
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].entry, 'server/services/cascade-grade.js');
  assert.match(whyOf(stale, 'server/services/cascade-grade.js'), /not in this tree/);
});

test('an entry still silencing a finding is left alone', () => {
  const stale = staleOrphanEntries({
    entries: ['module:client/src/pages/Model.tsx'],
    exists: () => true,
    silences: (e) => e === 'client/src/pages/Model.tsx',
  });
  assert.deepEqual(stale, []);
});

test('an entry whose module is wired now is reported, not silently kept', () => {
  const stale = staleOrphanEntries({
    entries: ['module:server/services/roster-risk.js'],
    exists: () => true,
    silences: () => false,
  });
  assert.equal(stale.length, 1);
  assert.match(whyOf(stale, 'server/services/roster-risk.js'), /silences nothing/);
});

test('table: and column: entries are not module paths and are skipped', () => {
  const stale = staleOrphanEntries({
    entries: ['table:espn_settings', 'column:league_draft_picks.round'],
    exists: () => false,
    silences: () => false,
  });
  assert.deepEqual(stale, []);
});

test('the module: prefix is stripped, and the bare form is accepted too', () => {
  const stale = staleOrphanEntries({
    entries: ['module:a/b.js', 'c/d.js'],
    exists: () => true,
    silences: () => false,
  });
  assert.deepEqual(stale.map(s => s.entry), ['a/b.js', 'c/d.js']);
});

test('an entry listed in both lists is reported once', () => {
  const stale = staleOrphanEntries({
    entries: ['module:a/b.js', 'a/b.js', 'module:a/b.js'],
    exists: () => true,
    silences: () => false,
  });
  assert.equal(stale.length, 1);
});

test('being reported as stale does not un-silence the entry', () => {
  // The two are independent on purpose. A spent entry is a note to a human;
  // turning the finding back on in the same run would fail the build for a
  // module that is now correctly wired, which is the opposite of the point.
  const entry = 'module:server/services/roster-risk.js';
  const stale = staleOrphanEntries({ entries: [entry], exists: () => true, silences: () => false });
  assert.equal(stale.length, 1);
  const { orphanOk } = acceptGuard({ accepted: [], orphans: [entry], found: [] });
  assert.ok(orphanOk.has(entry));
});
