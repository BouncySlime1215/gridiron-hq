/*
 * The decision inbox's four routes were deleted on 2026-09-20 and its module kept.
 *
 * WHY A TEST AND NOT A COMMENT. Nothing else can catch this. Both existing
 * decision-inbox tests mount the router on an express app they build themselves, so
 * they pass whether or not `server/index.js` mounts it — the boot path has no test at
 * all. The deletion therefore had three ways to rot, each silent:
 *
 *   1. Someone re-adds a route to the router, and the mount is gone, so it answers
 *      nothing and no test notices.
 *   2. Someone removes the routes but leaves the import, which keeps the module on the
 *      boot path with nothing using it — the exact shape this sweep exists to remove.
 *   3. Someone deletes the module outright because "it has no routes", which breaks
 *      `waiver-brain.js` and `trade-engine.js`: both import `publishRecommendation`
 *      from it, and that function is the live half of the file.
 *
 * The three assertions below are those three failures, in that order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mod = await import('../server/routes/decision-inbox.js');

test('the decision-inbox router defines no routes', () => {
  const routes = (mod.default.stack ?? []).filter(l => l.route)
    .map(l => `${Object.keys(l.route.methods).join('/')} ${l.route.path}`);
  assert.deepEqual(routes, [], 'decision-inbox still defines routes: ' + routes.join(', '));
});

test('server/index.js neither imports nor mounts the decision inbox', async () => {
  const index = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(index, /decision-inbox/,
    'the mount or the import came back; a router with no routes must not be on the boot path');
  assert.doesNotMatch(index, /decisionInboxRouter/);
});

test('publishRecommendation survives, because two live services import it', async () => {
  assert.equal(typeof mod.publishRecommendation, 'function');
  for (const consumer of ['../server/services/waiver-brain.js', '../server/services/trade-engine.js']) {
    const text = await readFile(new URL(consumer, import.meta.url), 'utf8');
    assert.match(text, /publishRecommendation/, `${consumer} should still import it`);
  }
});
