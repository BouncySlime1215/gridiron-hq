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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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


/*
 * AND THE THREE THE GUARDS ABOVE COULD NOT CATCH, because every one of them asserts
 * the SHAPE OF A REGEX IN THIS FILE'S SOURCE rather than the answer the report gives.
 * Source-text assertions cannot see a walk that records the wrong thing. These run the
 * script against a fixture tree and read what it wrote:
 *
 *   6. A CALL SITE INSIDE AN ALREADY-UNREACHED FUNCTION counted as going away. The
 *      fixpoint records already-unreached symbols into the same `falls` map that
 *      insideFalling() reads, so any symbol whose last live caller sits inside a
 *      kept-but-unreached function was promoted from "decide separately" to "delete
 *      with its route". horizonValue() (waiver-brain.js:85) printed under "Falls with
 *      the deletion" at depth 3 with live sites at roster-risk.js:190 and
 *      waiver-brain.js:155, :181, :401, :434 — and :401 and :434 are inside sellHigh,
 *      which routes/trades.js:203 keeps deliberately.
 *   7. A SYMBOL TWO DYING ROUTES CALL named only one of them. walk() returns early on
 *      `falls.has(...)`, so the printed reason is whichever route was walked last, and
 *      "delete it in the same commit as its route" is unsatisfiable when the answer is
 *      four routes in three editors' files. freeAgents() printed one reason and has
 *      four production sites, one of them a direct route caller.
 *   8. A LOCAL CLOSURE listed as a module symbol. walk() recurses without the
 *      cross-module check the top-level loop applies, and functionBody's regex matches
 *      `const countAt =` anywhere in the file, so countAt — a closure inside
 *      waiverUpgrades, used twice inside it — was printed as a row of its own.
 *
 * All three were found by feature audit running the script with probes at its decision
 * points, not by this file. A report whose tests only read its own source is a report
 * with no tests.
 *
 * One more, noticed while building the fixture for 8 and not fixed here: functionBody
 * looks for the first `{` after the first `)` following the declaration, so an
 * expression-bodied arrow — `const f = (x) => x + 1;` — has no body it can find, and
 * the walk drops the symbol silently. The first draft of that fixture used one and the
 * test passed for the wrong reason. The closure below has a block body so it is
 * actually reachable by the parser. Written down rather than fixed, because it
 * under-reports and the three above over-report.
 */
const runOnFixture = (files, { pathPrefix } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-impact-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
  const out = path.join(dir, 'report.md');
  // NODE_OPTIONS is dropped on purpose. The suite runs with
  // `--import ./test/offline-guard.mjs`, a path relative to the repository root, and
  // this child runs with cwd inside the fixture tree, where it does not resolve — so
  // the child died and the three tests below passed alone and failed in the full run.
  // The guard is about the SUITE reaching the network; this child reads files and runs
  // git in a temporary directory.
  const { NODE_OPTIONS, ...env } = process.env;
  const PATH = pathPrefix ? `${pathPrefix}${path.delimiter}${env.PATH}` : env.PATH;
  execFileSync(process.execPath, [path.resolve('scripts/route-deletion-impact.mjs')],
    { cwd: dir, env: { ...env, PATH, OUT: out }, stdio: 'pipe' });
  const report = fs.readFileSync(out, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return report;
};

/**
 * Just the "Falls with the deletion" section, which is the one people cut from. It ends
 * at the next `## `, not at a named heading: the fix for 6 added a third section
 * between this one and "Already unreached", and a slice pinned to that heading quietly
 * grew to cover it.
 */
const fallsSection = (report) => {
  const from = report.indexOf('## Falls with the deletion');
  const next = report.indexOf('\n## ', from + 1);
  return report.slice(from, next === -1 ? undefined : next);
};

const VERDICTS = JSON.stringify({
  keep_statuses: ['kept-no-screen', 'kept-tombstone', 'external-caller',
    'orphaned-backend-of-deleted-page', 'already-removed'],
  verdicts: {},
});

const mapOf = (...routes) => JSON.stringify({
  findings: routes.map(([subject, evidence]) => ({ rule: 'route-no-caller', subject, evidence: [evidence] })),
});

test('a call site inside an already-unreached function is a survivor, not a casualty', () => {
  // keptButUnreached is declared BEFORE helper on purpose: the fixpoint walks the
  // exports of a file in source order, so it records keptButUnreached as
  // ALREADY-UNREACHED and then reads helper's call sites through a `falls` map that
  // already holds it. The answer depending on declaration order is itself the defect.
  const report = runOnFixture({
    'docs/wiring/wiring-map.json': mapOf(['GET /api/thing/dead', 'server/routes/app.js:3']),
    'docs/wiring/route-verdicts.json': VERDICTS,
    'server/routes/app.js': `import { helper } from '../services/svc.js';\n`
      + `export const router = {};\n`
      + `router.get('/api/thing/dead', (req, res) => {\n  res.json({ n: helper() });\n});\n`,
    'server/services/svc.js': `export function keptButUnreached() {\n  return helper() + 1;\n}\n`
      + `export function helper() {\n  return 1;\n}\n`,
  });
  assert.doesNotMatch(fallsSection(report), /\bhelper\(\)/,
    'helper is still called from keptButUnreached, which this deletion does not remove');
  // And it must not simply vanish: a caller that is itself unreached is a third answer,
  // not silence. Dropping the row is what made positionLiquidity — the case this report
  // was written for — disappear from it entirely.
  assert.match(report, /## Reached only from code that is itself unreached/);
  assert.match(report, /\bhelper\(\)/, 'it still has to appear somewhere');
  assert.match(report, /keptButUnreached\(\)/, 'and the row has to name what holds it up');
});

test('a symbol two dying routes reach names both of them', () => {
  // The order is the point. The route that calls `shared` DIRECTLY is walked first, and
  // at that moment `shared` still has a surviving caller — the one inside `mid`, which
  // nothing yet knows is falling — so nothing is recorded and that route has been and
  // gone. The chain route makes it fall a moment later and writes down its own reason.
  // Merging reasons as the walk goes cannot fix that; the question has to be asked
  // again from the other end once the fixpoint has settled. This is freeAgents(),
  // which is reached directly by the free-agents handler and through byePatches() by
  // bye-risk, and printed only the second one.
  const report = runOnFixture({
    'docs/wiring/wiring-map.json': mapOf(
      ['GET /api/thing/direct', 'server/routes/app.js:3'],
      ['GET /api/thing/chain', 'server/routes/app.js:6']),
    'docs/wiring/route-verdicts.json': VERDICTS,
    'server/routes/app.js': `import { shared, mid } from '../services/svc.js';\n`
      + `export const router = {};\n`
      + `router.get('/api/thing/direct', (req, res) => {\n  res.json({ n: shared() });\n});\n`
      + `router.get('/api/thing/chain', (req, res) => {\n  res.json({ n: mid() });\n});\n`,
    'server/services/svc.js': `export function mid() {\n  return shared() + 1;\n}\n`
      + `export function shared() {\n  return 1;\n}\n`,
  });
  const falls = fallsSection(report);
  assert.match(falls, /\bshared\(\)/, 'shared really does fall: both routes that reach it are dying');
  assert.match(falls, /GET \/api\/thing\/chain/);
  assert.match(falls, /GET \/api\/thing\/direct/,
    'a row naming one of two routes tells the other route\'s owner that they are done');
});

test('a closure declared inside a function is not a symbol of its module', () => {
  const report = runOnFixture({
    'docs/wiring/wiring-map.json': mapOf(['GET /api/thing/dead', 'server/routes/app.js:3']),
    'docs/wiring/route-verdicts.json': VERDICTS,
    'server/routes/app.js': `import { outer } from '../services/svc.js';\n`
      + `export const router = {};\n`
      + `router.get('/api/thing/dead', (req, res) => {\n  res.json({ n: outer() });\n});\n`,
    'server/services/svc.js': `export function outer() {\n`
      + `  const localClosure = (x) => {\n    return x + 1;\n  };\n`
      + `  return localClosure(1);\n}\n`,
  });
  assert.match(report, /\bouter\(\)/, 'outer itself falls, and must still be reported');
  assert.doesNotMatch(report, /localClosure/,
    'a closure inside the function being deleted goes with it and is not a row');
});


/*
 * 9. THE ANSWER DEPENDED ON WHICH COMPUTER RAN IT. Test 6 above failed on Nick's Mac
 *    and passed on CI and in the cloud, and three TDD records wrote it down as
 *    "pre-existing, not touched" (2026-09-23 ux-11, s19). The cause: call sites were
 *    found with `git grep -E '\bname\b'`, and git hands -E patterns to the platform's
 *    POSIX regex. glibc reads \b as a word boundary; macOS's regex does not (it is a
 *    literal "b"), so on a Mac every symbol had ZERO call sites, and everything a dying
 *    route touched was reported as falling with it. A deletion report that is only
 *    right on Linux is wrong on the one machine people delete from.
 *
 *    The shim below is that regex: it rewrites \b to b before handing the call to the
 *    real git, which is exactly what BSD regcomp does with it. With it on PATH this
 *    reproduces the Mac failure on Linux (test 6 goes 7/8, the recorded signature).
 */
const shimDir = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-git-shim-'));
  const realPath = process.env.PATH;
  fs.writeFileSync(path.join(dir, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const PATH = ${JSON.stringify(realPath)};
let args = process.argv.slice(2);
${body}
const r = spawnSync('git', args, { stdio: 'inherit', env: { ...process.env, PATH } });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  return dir;
};

const survivorFixture = {
  'docs/wiring/wiring-map.json': mapOf(['GET /api/thing/dead', 'server/routes/app.js:3']),
  'docs/wiring/route-verdicts.json': VERDICTS,
  'server/routes/app.js': `import { helper } from '../services/svc.js';\n`
    + `export const router = {};\n`
    + `router.get('/api/thing/dead', (req, res) => {\n  res.json({ n: helper() });\n});\n`,
  'server/services/svc.js': `export function keptButUnreached() {\n  return helper() + 1;\n}\n`
    + `export function helper() {\n  return 1;\n}\n`,
};

test('call sites are found the same way on macOS, whose regex has no word boundary', () => {
  const shim = shimDir(`args = args.map(a => a.replace(/\\\\b/g, 'b'));`);
  try {
    const report = runOnFixture(survivorFixture, { pathPrefix: shim });
    assert.doesNotMatch(fallsSection(report), /\bhelper\(\)/,
      'with BSD regex the old grep found no call sites at all, so helper "fell"');
    assert.match(report, /keptButUnreached\(\)/, 'the surviving caller is still named');
  } finally { fs.rmSync(shim, { recursive: true, force: true }); }
});

test('a git grep that fails is an error, not "no call sites"', () => {
  // `|| true` and a bare catch turned every git failure into an empty list, which this
  // report reads as "nothing else calls it" — the most dangerous answer it can give.
  // Exit 1 from git grep means no match; anything else must stop the report.
  const shim = shimDir(`if (args.includes('grep')) { process.stderr.write('fatal: simulated\\n'); process.exit(128); }`);
  try {
    assert.throws(() => runOnFixture(survivorFixture, { pathPrefix: shim }),
      'a report built on a failed search must not be written');
  } finally { fs.rmSync(shim, { recursive: true, force: true }); }
});
