/**
 * THE RESOLVER'S IGNORANCE, RATCHETED.
 *
 * `unresolvedReceivers` reports every query run on a handle the file was
 * handed rather than one it opened. It exists because naming an unrecognised
 * receiver instead of assuming the app trades a visible false positive for an
 * invisible false negative: the table is reclassified to
 * `table-in-another-database`, which is `context`, and the gate prints
 * grandfathered, refused, stale and blocking findings but never context. So the
 * report was the whole safeguard, and a report with nothing behind it drifts —
 * 19 today, 25 next week, and nobody notices which five are new.
 *
 * This is the same ratchet `accepted_missing_feeds` is: the ones that were
 * there when the check went on are baselined, and the build fails on the NEXT
 * one. Not on all 19 on day one, which would teach people to rename their
 * variable `db` to make the build pass, which is the failure mode this whole
 * rule exists to catch.
 *
 * KEYED BY FILE AND RECEIVER, NOT BY LINE. A line number moves on every edit
 * above it, so a line-keyed baseline would fail builds for changes that touch
 * nothing it cares about, and the noise would get the whole thing deleted. The
 * count per (file, receiver) pair still catches a genuinely new site in a file
 * that already has one.
 *
 * A pair whose count DROPS is reported, never failed: somebody resolved a
 * handle, and the stale baseline line is now the thing that is out of date.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const {
  receiverRatchet, receiverKey, staleOrphanEntries, receiverBaseline, preRegisteredEntries,
} = await import('../scripts/wiring-map.mjs');

const site = (file, line, receiver) => ({ file, line, receiver, tables: ['t'] });
const keysOf = list => list.map(b => b.key).sort();

test('the key is the file and the receiver, and never the line', () => {
  assert.equal(receiverKey(site('a/b.js', 12, 'rdb')), 'a/b.js rdb');
  assert.equal(receiverKey(site('a/b.js', 900, 'rdb')), 'a/b.js rdb');
});

test('a baselined pair at its baselined count does not block', () => {
  const r = receiverRatchet({
    found: [site('a/b.js', 1, 'rdb'), site('a/b.js', 2, 'rdb')],
    baseline: { 'a/b.js rdb': 2 },
  });
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.loosened, []);
});

test('a receiver that is not baselined at all blocks', () => {
  const r = receiverRatchet({ found: [site('new/file.js', 4, 'other')], baseline: {} });
  assert.deepEqual(keysOf(r.blocking), ['new/file.js other']);
  assert.equal(r.blocking[0].was, 0);
  assert.equal(r.blocking[0].now, 1);
});

test('a baselined pair that grows blocks, and says by how much', () => {
  const r = receiverRatchet({
    found: [site('a/b.js', 1, 'rdb'), site('a/b.js', 2, 'rdb'), site('a/b.js', 3, 'rdb')],
    baseline: { 'a/b.js rdb': 2 },
  });
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].was, 2);
  assert.equal(r.blocking[0].now, 3);
});

test('a new site in a file that already has a baselined receiver still blocks', () => {
  // The whole reason the count is kept rather than just the pair name.
  const r = receiverRatchet({
    found: [site('a/b.js', 1, 'rdb'), site('a/b.js', 77, 'rdb')],
    baseline: { 'a/b.js rdb': 1 },
  });
  assert.deepEqual(keysOf(r.blocking), ['a/b.js rdb']);
});

test('the same receiver in a different file is a different entry', () => {
  const r = receiverRatchet({
    found: [site('a/b.js', 1, 'rdb'), site('c/d.js', 1, 'rdb')],
    baseline: { 'a/b.js rdb': 1 },
  });
  assert.deepEqual(keysOf(r.blocking), ['c/d.js rdb']);
});

test('a line number moving does not block', () => {
  const r = receiverRatchet({ found: [site('a/b.js', 4000, 'rdb')], baseline: { 'a/b.js rdb': 1 } });
  assert.deepEqual(r.blocking, []);
});

test('a pair that shrinks is reported, not failed', () => {
  const r = receiverRatchet({ found: [site('a/b.js', 1, 'rdb')], baseline: { 'a/b.js rdb': 3 } });
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(keysOf(r.loosened), ['a/b.js rdb']);
  assert.equal(r.loosened[0].was, 3);
  assert.equal(r.loosened[0].now, 1);
});

test('a pair that disappears entirely is reported as gone, not failed', () => {
  const r = receiverRatchet({ found: [], baseline: { 'a/b.js rdb': 3 } });
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(keysOf(r.loosened), ['a/b.js rdb']);
  assert.equal(r.loosened[0].now, 0);
});

test('no found sites and no baseline is quiet', () => {
  const r = receiverRatchet({});
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.loosened, []);
});

/**
 * THE OTHER HALF: a report that invites the reader to break something.
 *
 * `staleOrphanEntries` reports an accept-list entry naming a file that is not
 * in the tree. One of those entries is deliberate — `cascade-grade.js` is
 * pre-registered for PR #72, and `_PERMANENT_ORPHAN_REASONS` says so in full,
 * with an owner and a retirement condition. The report said the same sentence
 * for it as for a genuinely rotted entry, so the obvious reading is "delete
 * this line", which would undo a correct decision. Deleting a correct entry
 * looks exactly like tidying up, which is why the report has to say which case
 * it is looking at rather than leaving it to whoever reads it next.
 */
test('a pre-registered entry is reported as pre-registered, not as rot', () => {
  const stale = staleOrphanEntries({
    entries: ['server/services/cascade-grade.js'],
    exists: () => false,
    preRegistered: e => e === 'server/services/cascade-grade.js',
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].kind, 'pre-registered');
  assert.match(stale[0].why, /not in this tree yet/);
  assert.match(stale[0].why, /leave it/i);
});

test('an entry naming a missing file with no pre-registration still reads as rot', () => {
  const stale = staleOrphanEntries({
    entries: ['server/services/gone.js'],
    exists: () => false,
    preRegistered: () => false,
  });
  assert.equal(stale[0].kind, 'missing');
  assert.doesNotMatch(stale[0].why, /leave it/i);
});

test('the wired-now half is unchanged and carries its own kind', () => {
  const stale = staleOrphanEntries({
    entries: ['server/services/here.js'],
    exists: () => true,
    silences: () => false,
  });
  assert.equal(stale[0].kind, 'silences-nothing');
  assert.match(stale[0].why, /wired now/);
});

/**
 * THE CALL SITE, WHICH A UNIT TEST OF THE UNIT DOES NOT REACH.
 *
 * The mutation sweep for this change killed every mutation inside
 * `receiverRatchet` and `staleOrphanEntries` and **survived both mutations at
 * the call site**: pass `{}` as the baseline instead of the annotation key, and
 * pass `() => false` instead of the pre-registered predicate. Both leave all
 * thirteen tests above green while turning the checker off — one makes the
 * ratchet fail on everything, the other makes the stale report tell a reader to
 * delete a correct entry.
 *
 * `--check` is a CLI branch no test runs, so the fix is not a bigger test, it
 * is a smaller branch: the two decisions live in pure functions now and the
 * branch is left holding a call.
 */
test('the baseline comes from accepted_unresolved_receivers, by that name', () => {
  assert.deepEqual(receiverBaseline({ accepted_unresolved_receivers: { 'a/b.js rdb': 2 } }), { 'a/b.js rdb': 2 });
  // A file with no baseline block yields an empty baseline, not undefined —
  // receiverRatchet would treat undefined as "no key at all" and block on
  // everything, which is the red-on-day-one this list exists to avoid.
  assert.deepEqual(receiverBaseline({}), {});
  assert.deepEqual(receiverBaseline(), {});
});

test('the baseline is not read from some other key that happens to look right', () => {
  assert.deepEqual(receiverBaseline({ unresolved_receivers: { 'a/b.js rdb': 2 } }), {});
});

test('PRE-REGISTERED in the reason text is what marks an entry deliberate', () => {
  const isPre = preRegisteredEntries({
    _PERMANENT_ORPHAN_REASONS: {
      'server/services/cascade-grade.js': 'PRE-REGISTERED: the file is not in this tree yet, it arrives with PR #72.',
      'server/services/other.js': 'Deliberately unwired research. RETIRE THIS ENTRY WHEN a surface reads it.',
    },
  });
  assert.equal(isPre('server/services/cascade-grade.js'), true);
  assert.equal(isPre('server/services/other.js'), false);
  assert.equal(isPre('server/services/not-listed-at-all.js'), false);
});

test('an annotations file with no reasons block marks nothing pre-registered', () => {
  assert.equal(preRegisteredEntries({})('anything.js'), false);
  assert.equal(preRegisteredEntries()('anything.js'), false);
});

test('every baselined receiver in the real annotations file carries an owner and a retirement condition', () => {
  // The list's own discipline, pinned: a line can be added to the baseline, but
  // not without saying who owns it and what would retire it. That is the whole
  // difference between this file and a junk drawer.
  const ann = JSON.parse(fs.readFileSync(new URL('../docs/wiring/annotations.json', import.meta.url), 'utf8'));
  const baseline = receiverBaseline(ann);
  const reasons = ann._UNRESOLVED_RECEIVERS_REASONS ?? {};
  assert.ok(Object.keys(baseline).length > 0, 'the baseline block is missing from annotations.json');
  for (const key of Object.keys(baseline)) {
    assert.ok(Number.isInteger(baseline[key]) && baseline[key] > 0, `${key} is not a positive count`);
    assert.match(key, /^\S+ \S+$/, `${key} is not "<file> <receiver>" — a line number would rot on every edit`);
    const why = reasons[key];
    assert.ok(why, `${key} has no entry in _UNRESOLVED_RECEIVERS_REASONS`);
    assert.match(why, /RETIRES WHEN/, `${key} has no retirement condition`);
    assert.match(why, /Owner:/, `${key} has no owner`);
  }
});
