/**
 * Exactly one thing may answer GET /api/health (2026-09-19).
 *
 * This test exists because of how the duplicate nearly shipped, which was not
 * a mistake anyone could see in a diff. Two branches independently added a
 * health route: one that reads the database and answers 503 when it cannot,
 * and one that was an unconditional 200. They touched different lines, so git
 * merged them with no conflict into a file that registered the path twice, and
 * Express answers with whichever handler was registered first. The merge was
 * clean, both branches' tests passed, and the outcome depended on line order.
 *
 * What that would have cost is specific: `fly.toml` now carries an HTTP check
 * on this path, replacing a TCP check that the kernel's listen backlog
 * answered while the event loop was blocked. If the always-200 handler won the
 * ordering, Fly would get a liveness check that reports healthy on a dead
 * database — the original bug restored, through a route added to fix it.
 *
 * So the assertion is on the source rather than on a response, deliberately.
 * A request can only ever reach the first registration, which means no amount
 * of HTTP testing can see a second one; the duplicate is invisible at runtime
 * and visible only in the text. A merge is a textual event, and this is the
 * seam where it goes wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

// `app.get('/api/health', ...)` and `router.get('/health', ...)` alike: any
// Express verb registered against a quoted path whose last segment is
// "health". Catching the bare '/health' form matters because a router mounted
// under /api would serve the same URL from a different file, which is how a
// second one would arrive next time rather than as another line in index.js.
const REGISTRATION = /\.(get|post|put|patch|delete|all|use)\(\s*(['"`])((?:\/[\w:-]+)*\/health)\2/g;

test('exactly one route in server/ is registered at a health path', () => {
  const found = [];
  for (const file of jsFiles(join(ROOT, 'server'))) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(REGISTRATION)) {
      const line = src.slice(0, match.index).split('\n').length;
      found.push({ where: `${relative(ROOT, file)} → ${match[3]}`, at: `${relative(ROOT, file)}:${line}` });
    }
  }
  // Compared on file and path, NOT on the line number. What this test is for
  // is a second registration arriving in a clean merge; which line the one
  // registration sits on says nothing about that, and pinning it made this
  // test fail for reasons that have nothing to do with what it guards. Both
  // branches hit that independently and from different directions — main from
  // an unrelated comment edit above the route, this branch from inserting a
  // router mount and an import higher up index.js — which is the argument for
  // the assertion being on file and path alone. The line is still reported,
  // because it is what a reader needs when this does fail.
  assert.deepEqual(
    found.map((f) => f.where),
    ['server/index.js → /api/health'],
    `expected one health registration, found ${found.length}:\n  ${found.map((f) => f.at).join('\n  ')}`,
  );
});

test("the one registration is the path fly.toml's http check probes", () => {
  const fly = readFileSync(join(ROOT, 'fly.toml'), 'utf8');
  const paths = [...fly.matchAll(/^\s*path\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(paths, ['/api/health']);

  // And it is an HTTP check, not the TCP check it replaced. A tcp_checks block
  // reappearing here would silently restore the original failure mode. Both
  // patterns are anchored to the start of a line so the comment above the
  // block, which names tcp_checks to explain why it is gone, is not read as
  // the block itself.
  assert.match(fly, /^\s*\[\[services\.http_checks\]\]/m);
  assert.doesNotMatch(fly, /^\s*\[\[services\.tcp_checks\]\]/m);
});

test('the health handler is never registered behind authentication', () => {
  const src = readFileSync(join(ROOT, 'server/index.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes("'/api/health'"));
  // A health check cannot hold a bearer token. If this line ever grows a
  // middleware array the host stops being able to tell a wedged machine from
  // an unauthenticated one, and both read as "down" in the same way.
  assert.equal(line.trim(), "app.get('/api/health', healthHandler());");
});
