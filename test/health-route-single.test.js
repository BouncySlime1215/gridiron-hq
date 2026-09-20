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

/*
 * THE LINE NUMBER IS NOT PART OF THE CLAIM, and it used to be in the fixture.
 *
 * The assertion read `['server/index.js:86 → /api/health']`, so deleting two unrelated
 * lines higher up the file failed this test with "expected one health registration,
 * found 1" — a message that reads like a contradiction, on a change that had nothing
 * to do with health. It cost a full gate cycle on 2026-09-20 to find that the only
 * difference was 86 against 85.
 *
 * Dropping the offset weakens nothing. The guarantee is "one registration, in this
 * file, at this path", and a second one still lands as a second array element and
 * still fails, whether it is in index.js or a router mounted under /api. The line is
 * kept in the failure message, which is where a person actually needs it.
 *
 * THREE BRANCHES FIXED THIS THE SAME WAY ON THE SAME NIGHT, independently: the
 * scheduler's 63ca21e strips the offset with a regex before the comparison, this one
 * builds two arrays (one compared, one for the message), and Coach's 73e0760 compares
 * file and path. All three assert "exactly one registration, in index.js, at
 * /api/health" and keep the line in the failure text, so no behaviour differs between
 * them and taking any one of them costs nothing. The branch-pair sweep should report
 * that as a KNOWN resolve, not a new conflict.
 *
 * The rule the three of them are evidence for: a test that breaks on unrelated edits is
 * reported to its owner once, not fixed in place by each thread that trips over it.
 * Three threads each spent a gate cycle discovering the same two-digit difference.
 */
test('exactly one route in server/ is registered at a health path', () => {
  const found = [], where = [];
  for (const file of jsFiles(join(ROOT, 'server'))) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(REGISTRATION)) {
      const line = src.slice(0, match.index).split('\n').length;
      found.push(`${relative(ROOT, file)} → ${match[3]}`);
      where.push(`${relative(ROOT, file)}:${line} → ${match[3]}`);
    }
  }
  assert.deepEqual(
    found,
    ['server/index.js → /api/health'],
    `expected one health registration, found ${found.length}:\n  ${where.join('\n  ')}`,
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
