import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated-DB pattern shared with the other suites (see test/props-saved-tickets.test.js,
// test/evidence-dataset.test.js) — a fresh temp SQLite file with migrations run against
// it, never the real server/data.sqlite.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-decision-inbox-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const applied = await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
const { publishRecommendation, toRecommendation } = await import('../server/routes/decision-inbox.js');

/*
 * THIS FILE USED TO DRIVE AN EXPRESS APP. The four routes were deleted on 2026-09-20
 * (nothing called them, in any tree), so every assertion that was really about the
 * MODULE now goes at the module directly, and the ones that were about the route layer
 * are gone. What went, and why none of it is a lost assertion:
 *
 *   - "a fresh install has no open recommendations", "list is sorted by urgency first",
 *     "summary counts open by urgency" — GET / and GET /summary did the filtering,
 *     ordering and counting. That code is deleted, so there is nothing left to assert
 *     about it. Ordering is now the job of whatever reads the table next.
 *   - "POST / requires an authenticated caller (a6-money-path)" — the gate was on the
 *     route. With no route there is no anonymous publish path to close: the only way
 *     in is importing the function, which needs no session. Keeping a 401 assertion
 *     against a deleted handler would be a green test guarding nothing.
 *   - the two resolve tests — `POST /:id/resolve` was the only writer of `status`,
 *     `resolved_at` and `outcome`. It had no caller either, so no row has ever been
 *     resolved; the tests were exercising a path the app could not reach. The
 *     module-level consequence that DOES still hold — a resolved row is never silently
 *     reopened — is asserted below against a row resolved directly in SQL.
 *
 * `openRows()` replaces `fetch(base)`: same shape, read from the table through the
 * same `toRecommendation` the publish path returns through, so the tests below still
 * fail if that mapping breaks.
 */
const openRows = () => rows(`SELECT * FROM decision_recommendations WHERE status = 'open'`)
  .map(toRecommendation);

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('020_decision_recommendations ran and created the table', () => {
  assert.ok(applied.includes('020_decision_recommendations'));
  assert.ok(row(`SELECT name FROM sqlite_master WHERE type='table' AND name='decision_recommendations'`));
});

/* ------------------------------------------------------- publish contract */

test('publishing persists the row and returns the shape its callers read', () => {
  const body = publishRecommendation({
    dedupKey: 'test:trade:1', sport: 'NFL', type: 'trade', title: 'Sell high on Player X',
    rationale: 'Market value is diverging from role.', urgency: 'medium',
    sourceModel: 'trade-engine', link: '/trade-lab'
  });
  assert.equal(body.title, 'Sell high on Player X');
  assert.equal(body.status, 'open');
  assert.equal(body.urgency, 'medium');
  assert.deepEqual(body.subjectIds, []);
  assert.equal(row(`SELECT COUNT(*) n FROM decision_recommendations WHERE dedup_key='test:trade:1'`).n, 1);
});

/*
 * The deleted POST route turned each of these into a 400. The validation itself was
 * never the route's — it is in `publishRecommendation`, which throws — so the same
 * four rules are asserted here, now against the thing that enforces them. An engine
 * calling this with a bad payload gets an exception, not a silently dropped row.
 */
test('a publish missing a required field throws rather than writing a partial row', () => {
  assert.throws(() => publishRecommendation({ dedupKey: 'x', sport: 'NFL', type: 'trade', sourceModel: 'x' }), /title/);
  assert.throws(() => publishRecommendation({ dedupKey: 'x', sport: 'NHL', type: 'trade', title: 'x', sourceModel: 'x' }), /invalid sport/);
  assert.throws(() => publishRecommendation({ sport: 'NFL', type: 'trade', title: 'x', sourceModel: 'x' }), /dedupKey/);
  assert.throws(() => publishRecommendation({ dedupKey: 'x', sport: 'NFL', type: 'trade', title: 'x' }), /sourceModel/);
  assert.equal(row(`SELECT COUNT(*) n FROM decision_recommendations WHERE dedup_key='x'`).n, 0);
});

test('an invalid urgency value falls back to medium rather than rejecting the publish', () => {
  const body = publishRecommendation({ dedupKey: 'test:urgency', sport: 'NFL', type: 'trade', title: 'x', sourceModel: 'x', urgency: 'critical' });
  assert.equal(body.urgency, 'medium');
});

test('publishing the same dedupKey again refreshes the open row instead of duplicating it', () => {
  run('DELETE FROM decision_recommendations');
  const first = publishRecommendation({ dedupKey: 'dupe-1', sport: 'NFL', type: 'x', title: 'v1', sourceModel: 'x', expectedValue: 1 });
  const second = publishRecommendation({ dedupKey: 'dupe-1', sport: 'NFL', type: 'x', title: 'v2', sourceModel: 'x', expectedValue: 2 });
  assert.equal(second.id, first.id, 'same dedup key while open must update in place, not create a new id');

  const list = openRows();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'v2');
  assert.equal(list[0].expectedValue, 2);
});

/*
 * The resolve ROUTE is gone and nothing resolves rows today, but the rule this guards
 * is in `publishRecommendation` itself — its dedup lookup is scoped to `status = 'open'`
 * precisely so resolution history survives a later republish. The row is resolved here
 * in SQL, which is what any future resolver will do underneath whatever calls it.
 */
test('a resolved row is never silently reopened by a later publish on the same key', () => {
  run('DELETE FROM decision_recommendations');
  const opened = publishRecommendation({ dedupKey: 'dupe-2', sport: 'NFL', type: 'x', title: 'first occurrence', sourceModel: 'x' });
  run(`UPDATE decision_recommendations SET status='actioned', resolved_at=datetime('now') WHERE id=?`, opened.id);

  const reopened = publishRecommendation({ dedupKey: 'dupe-2', sport: 'NFL', type: 'x', title: 'second occurrence', sourceModel: 'x' });
  assert.notEqual(reopened.id, opened.id, 'a resolved recommendation must not be silently reopened/overwritten');
  assert.equal(openRows().filter(r => r.id === opened.id).length, 0, 'the actioned row must not be open again');
  assert.equal(row('SELECT title FROM decision_recommendations WHERE id = ?', opened.id).title,
    'first occurrence', 'the resolved row keeps what it said when it was resolved');
});

/*
 * Expiry used to be swept on the read path, before every GET. With the routes gone the
 * sweep hangs off `publishRecommendation` instead, so this now asserts something it did
 * not before: that publishing ANY recommendation expires every other lapsed one. If
 * that call is ever removed, nothing marks a row expired again and every stale
 * recommendation reads as open forever.
 */
test('publishing expires every lapsed row, including ones it is not about', () => {
  run('DELETE FROM decision_recommendations');
  publishRecommendation({
    dedupKey: 'expired-1', sport: 'NFL', type: 'x', title: 'stale by now', sourceModel: 'x',
    expiresAt: new Date(Date.now() - 1000).toISOString()
  });
  assert.equal(row(`SELECT status FROM decision_recommendations WHERE dedup_key='expired-1'`).status,
    'open', 'its own publish cannot expire it: the sweep runs before the row exists');

  publishRecommendation({ dedupKey: 'unrelated', sport: 'NFL', type: 'x', title: 'a later, live one', sourceModel: 'x' });
  assert.equal(row(`SELECT status FROM decision_recommendations WHERE dedup_key='expired-1'`).status, 'expired');
  assert.deepEqual(openRows().map(r => r.title), ['a later, live one']);
});

/*
 * WHAT IS NOT HERE ANY MORE, and why, so nobody reads the gap as an oversight.
 *
 * This file used to end with two sections asserting that `lineupDiff()` and
 * `waiverUpgrades()` publish a row into the inbox — `sourceModel: 'lineup-brain'` and
 * `sourceModel: 'waiver-brain'`. Those publishers are being removed: with the router
 * retired (see test/decision-inbox-retired.test.js) the rows they wrote had no reader
 * at all, and a test that pins a publisher writing to a table nothing reads would
 * outlive the thing it was describing and fail the moment the publisher goes.
 *
 * What stays is the contract `publishRecommendation` keeps for whoever calls it next:
 * the required fields, the dedup-key upsert, the refusal to silently reopen a resolved
 * row, and the lazy expiry. That contract is the reason the module survives its own
 * routes, and it is tested through `toRecommendation`, the same mapping the publish
 * path returns through, so the shape a future reader gets is pinned here and not only
 * in the deleted routes.
 */
