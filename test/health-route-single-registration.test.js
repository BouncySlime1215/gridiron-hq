/**
 * `GET /api/health` must be registered exactly once (2026-09-19).
 *
 * This is a tripwire for a collision that has already happened. PR #17 and PR
 * #14 each invented a health route independently, and they land far enough
 * apart in `server/index.js` that git merges BOTH in without reporting a
 * conflict. Express serves whichever is registered first, so the merged app
 * has two handlers and one of them is dead code that nobody can see is dead.
 *
 * It matters which one wins. #17's runs a synchronous `SELECT 1` and answers
 * 503 when SQLite cannot be reached, which is what `fly.toml`'s HTTP check
 * needs: the TCP check it replaced was answered by the kernel's listen backlog
 * and so passed happily against a wedged process. #14's is
 * `res.json({ ok: true })` and answers 200 unconditionally. If the ordering in
 * that file ever moves — one inserted route, one reshuffle — Fly's liveness
 * check silently becomes a check that passes on a dead database, which is the
 * exact failure the health check was added to cure. Nothing about that is
 * visible in either pull request's diff, because each is correct alone.
 *
 * WHY THIS TEST LIVES HERE, at the top of the scheduler stack, rather than in
 * the branch that removes the duplicate. A test written by the same change
 * that deletes the second route can never fail: it is a statement that the
 * author already did the thing. Standing here it is vacuous today and fires
 * the moment a second registration arrives — which is what a tripwire is for.
 * #14 retargets onto this branch, so this is the test its own CI runs.
 *
 * It reads the source rather than the route table because `server/index.js`
 * binds a port on import and cannot be loaded from a test. Crude, and exactly
 * matched to the failure: the bug is a second line in this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(repo, 'server', 'index.js'), 'utf8');

test('server/index.js registers GET /api/health exactly once', () => {
  const registrations = [...source.matchAll(/app\.get\(\s*['"`]\/api\/health['"`]/g)];

  assert.equal(registrations.length, 1,
    `found ${registrations.length} registrations of GET /api/health in server/index.js. ` +
    'Two handlers means Express serves whichever comes first and the other is invisible ' +
    'dead code. If this failed after a merge, the fix is to delete the handler that does ' +
    'not check the database — not to reorder them.');
});

test('the surviving handler is the one that can fail', () => {
  // A registration that cannot return a non-200 is the TCP check again. This
  // asserts the route delegates to the module that owns that behaviour, rather
  // than to an inline `res.json({ ok: true })`.
  assert.match(source, /app\.get\(\s*['"`]\/api\/health['"`]\s*,\s*healthHandler\(\)\s*\)/,
    'GET /api/health must be served by healthHandler() from server/platform/health.js, ' +
    'which reads from SQLite and answers 503 when it cannot');
});

test('no other route file claims /api/health either', () => {
  // The same collision can arrive through a router rather than a second line
  // in index.js, and it would look identical to whoever has to debug it.
  const routes = path.join(repo, 'server', 'routes');
  const offenders = fs.readdirSync(routes)
    .filter(f => f.endsWith('.js'))
    .filter(f => /\.get\(\s*['"`]\/health['"`]/.test(fs.readFileSync(path.join(routes, f), 'utf8')));

  assert.deepEqual(offenders, [],
    `these route files also define a /health endpoint: ${offenders.join(', ')}. ` +
    'Whether it collides depends on where they are mounted, which is not something ' +
    'a reader of either file can see.');
});
