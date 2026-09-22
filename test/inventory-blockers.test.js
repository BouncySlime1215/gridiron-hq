/**
 * What the inventory cannot answer, and who can answer it.
 *
 * 597 of 880 rows are unresolved — 541 `unclassified` plus 56 model rows left
 * blank for the audit thread. That number on its own is useless: read as a
 * score it says the inventory failed, and read as a to-do list it says grind
 * harder. Neither is true. The rows are not one pile, they are six, and only
 * one of them is anyone's to grind at.
 *
 * 416 of them wait on a single fact this container cannot obtain — a row count
 * from the production database. `server/data.sqlite` here is a migrated dev
 * shell holding 218 of 327 tables, so a LOCAL count of 0 means "cannot be
 * confirmed here", never "empty in the app". No amount of static analysis
 * moves those rows, and any work that tries is wasted.
 *
 * THE INVARIANT THIS FILE EXISTS FOR: every unresolved row lands in exactly
 * one bucket, and the buckets sum to the unresolved total. A breakdown that
 * silently drops rows is worse than no breakdown, because it reads as
 * complete. The catch-all bucket is kept and reported even at zero, so a new
 * reason string shows up as a number rather than vanishing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { blockers } = await import('../scripts/inventory.mjs');

const row = (over = {}) => ({ id: 'x', kind: 'table', status: 'unclassified', reason: '', ...over });
const of = (out, who) => out.find((b) => b.who === who)?.count ?? 0;

test('a resolved row is not in the breakdown at all', () => {
  const out = blockers([
    row({ status: 'wired', reason: 'reads leagues, LOCAL 5 rows' }),
    row({ status: 'half_done' }),
    row({ status: 'dead' }),
  ]);
  assert.equal(out.reduce((s, b) => s + b.count, 0), 0);
});

test('a LOCAL 0 row waits on a production row count', () => {
  const out = blockers([row({ reason: 'reaches a live surface and reads game_lines, all LOCAL 0 rows' })]);
  assert.equal(of(out, 'a production row count'), 1);
});

test('a table absent from the local shell is the same blocker, not a new one', () => {
  // "not in the LOCAL database" and "LOCAL 0 rows" are one question asked two
  // ways: both are answered by reading production, and splitting them would
  // make the largest block look like two medium ones.
  const out = blockers([row({ reason: 'table auth_sessions is read by a live surface but is not in the LOCAL database' })]);
  assert.equal(of(out, 'a production row count'), 1);
});

test('a satellite table is a deployment question, not a row count', () => {
  const out = blockers([
    row({ reason: 'jev_luck lives in a separate database (table-in-another-database), not the app DB' }),
    row({ reason: 'adv_team_week is read at x.js:1 and created nowhere in this tree' }),
  ]);
  assert.equal(of(out, 'a deployment question: whether the image ships the file'), 2);
  assert.equal(of(out, 'a production row count'), 0);
});

test('a job waits on a run, whatever its reason says about tables', () => {
  const out = blockers([row({ kind: 'job', reason: 'job x is registered at s.js:1 on tier live' })]);
  assert.equal(of(out, 'a run: static analysis cannot say whether a job writes rows'), 1);
});

test('the model rows and the contested rows are somebody else, and are separated', () => {
  const out = blockers([
    row({ kind: 'model', status: '', reason: 'handed to the model-evidence audit thread — status set by the audit, not here' }),
    row({ reason: 'CONTESTED, not yet adjudicated. This map: unclassified' }),
    row({ kind: 'page', reason: 'page X.tsx is routed in the client, but what it renders is verified by the UI thread' }),
  ]);
  assert.equal(of(out, 'the model-evidence audit thread'), 1);
  assert.equal(of(out, 'adjudication between two threads'), 1);
  assert.equal(of(out, 'the UI thread'), 1);
});

test('every unresolved row lands in exactly one bucket', () => {
  const rows = [
    row({ reason: 'all LOCAL 0 rows' }),
    row({ kind: 'job' }),
    row({ kind: 'model', status: '', reason: 'handed to the model-evidence audit thread' }),
    row({ kind: 'page', reason: 'verified by the UI thread' }),
    row({ reason: 'CONTESTED, not yet adjudicated' }),
    row({ reason: 'lives in a separate database' }),
    row({ reason: 'something nobody has written a bucket for yet' }),
  ];
  const out = blockers(rows);
  assert.equal(out.reduce((s, b) => s + b.count, 0), rows.length);
});

test('an unrecognised reason is counted, not dropped', () => {
  const out = blockers([row({ reason: 'a reason string nobody has seen before' })]);
  assert.equal(of(out, 'unsorted: no bucket claims these yet'), 1);
});

test('the catch-all is reported even when it is empty', () => {
  // A bucket that disappears at zero is a bucket nobody checks. Keeping it
  // visible is what makes a new reason string show up as a number.
  const out = blockers([row({ reason: 'all LOCAL 0 rows' })]);
  assert.ok(out.some((b) => b.who === 'unsorted: no bucket claims these yet'),
    'the catch-all row is present at zero');
  assert.equal(of(out, 'unsorted: no bucket claims these yet'), 0);
});

test('buckets come back heaviest first, with the catch-all last', () => {
  const out = blockers([
    row({ kind: 'job' }), row({ kind: 'job' }), row({ kind: 'job' }),
    row({ reason: 'all LOCAL 0 rows' }),
  ]);
  assert.equal(out[0].who, 'a run: static analysis cannot say whether a job writes rows');
  assert.equal(out.at(-1).who, 'unsorted: no bucket claims these yet');
});
