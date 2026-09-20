/*
 * The four ways this report was confidently wrong before it was right.
 *
 * `scripts/route-deletion-impact.mjs` tells somebody which functions die when they
 * delete a route. Acting on it is irreversible, so each guard below is a specific
 * wrong answer it gave during the hour it was written, pinned so it cannot come back:
 *
 *   1. A COMMENT counted as a caller. A paragraph in scripts/wiring-map.mjs describing
 *      the positionLiquidity chain was read as a call site, so the report said nothing
 *      fell — on the exact chain it was written for.
 *   2. AN IMPORT counted as a use. Matching the bare name picked up the `import { x }`
 *      line in the very file whose handler was dying, and the falling count went from
 *      36 to 0. A clean, confident, entirely wrong answer.
 *   3. `name(` MISSED a function passed as a value. `requireAuthenticated` is express
 *      middleware and never appears with a paren after it, so the report listed a
 *      function on the authentication path as unreached.
 *   4. AN EXPORTED CONST counted as a function. `export const db = new DatabaseSync()`
 *      has no `db(` anywhere, so the database handle the whole server uses was
 *      reported unreached, along with 80 other rows of the same shape.
 *
 * And the fifth, which is not a parsing bug but a judgement one: a route its owner
 * ruled KEPT is not dying. The first run announced that requirePlatformAdmin() falls
 * with POST /api/trades/managers/rebuild, which Trade Brain had already ruled kept.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../scripts/route-deletion-impact.mjs', import.meta.url), 'utf8');

test('a comment and an import are not call sites', () => {
  assert.match(src, /!\/\^\\s\*\(\\\/\\\/\|\\\*\|\\\/\\\*\)\//,
    'comment lines must be filtered out of call sites');
  assert.match(src, /\!\/\^\\s\*\(import\|export\)\\b\//,
    'import and export lines must be filtered out of call sites');
});

test('call sites match the bare name, because a function passed as a value is used', () => {
  assert.match(src, /git grep -n -E '\\\\b\$\{name\}\\\\b'/,
    'matching `name(` misses express middleware and every other callback');
});

test('only a function counts as an exported function', () => {
  const decl = src.slice(src.indexOf('const EXPORT_DECL'), src.indexOf('let changed = true'));
  assert.match(decl, /=>/, 'an exported const must be followed by a function form to count');
  assert.match(decl, /function\\b/);
});

test('a route its owner ruled kept is excluded from the dying set', async () => {
  assert.match(src, /KEEP\.has\(statusOf\(f\.subject\)\)/,
    'the dying set must exclude kept verdicts, or the report names live code as falling');
  const verdicts = JSON.parse(await readFile(new URL('../docs/wiring/route-verdicts.json', import.meta.url), 'utf8'));
  // The two that named this guard, with the owner that ruled each.
  assert.equal(verdicts.verdicts['POST /api/trades/managers/rebuild'].status, 'external-caller');
  assert.equal(verdicts.verdicts['POST /api/model/registry/experiments/:id/promote'].status, 'kept-no-screen');
  for (const s of ['kept-no-screen', 'kept-tombstone', 'external-caller',
    'orphaned-backend-of-deleted-page', 'already-removed'])
    assert.ok(verdicts.keep_statuses.includes(s), `${s} must mean the route is not deleted`);
});

test('the fixpoint looks at every module a dying handler imports, not only files already falling', () => {
  assert.match(src, /const candidateFiles = new Set/);
  assert.match(src, /for \(const d of doomed\) for \(const \[, target\] of repoImports\(d\.file\)\)/,
    'positionLiquidity is only found because the candidate set includes imported modules');
});
