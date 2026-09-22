#!/usr/bin/env node
/**
 * Reach grader for docs/inventory/CONTRACT.md.
 *
 * Answers one question about a module: which entry points reach it, and are
 * they all betting surfaces? That is the whole of the `wired` /
 * `wired-betting-only` split in CONTRACT.md section 2, and the split exists
 * because a `wired` count that quietly includes betting-only reach overstates
 * how much of the fantasy product is connected.
 *
 * The one thing this file must not do is stop at the first entry point it
 * finds. `reachableEntries` therefore walks the whole reverse import graph and
 * returns EVERY entry point, with a shortest representative path to each; the
 * grade is computed from the set. test/reach-grader-all-paths.test.js builds
 * the first-path-only version on purpose and shows it grading a two-entry
 * module `wired-betting-only`.
 *
 * Reachability in code is not reachability in data. A caller can exist whose
 * condition is never true against real rows, and only a query finds that.
 * Everything here is the code half; a row graded from this alone should say so.
 *
 * Usage:
 *   node scripts/reach-grade.mjs server/services/player-week-engine.js [...]
 *   node scripts/reach-grade.mjs --json server/services/contingency.js
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ts = createRequire(import.meta.url)('typescript');

/**
 * The betting surfaces CONTRACT.md names. Betting is out of scope for this
 * product, so a row reachable only through one of these is served somewhere the
 * product is not meant to be using.
 *
 * THE LIST IS THE TEST, and a mount path is evidence for adding to it, never
 * the test itself. Both directions are live in this repo: `routes/wong.js` is
 * mounted at `/api/betting/wong`, under the prefix, and `routes/execution-slate.js`
 * is mounted at `/api/execution-slate`, outside it — and both are betting. A
 * prefix rule catches the first and misses the second.
 *
 * Each entry says why, from the file's own header, so the list can be audited
 * rather than trusted.
 */
export const BETTING_ENTRY_POINTS = Object.freeze([
  'server/routes/nfl-market.js',
  'server/routes/nfl-betting.js',      // "NFL betting API"
  'server/routes/betting-hub.js',      // "the betting home page's data"
  'server/routes/wong.js',             // "the Wong teaser desk... a ledger of what was taken"
  'server/routes/execution-slate.js',  // the shopping board, teaser execution and the staking gate
]);

export function isBettingEntryPoint(file) {
  return BETTING_ENTRY_POINTS.includes(file);
}

/**
 * The other off-product surface (Auditor §R18.1).
 *
 * `/api/mlb` is not betting and it is not the fantasy product either. Folding
 * it into `wired-betting-only` would record a false fact, and leaving it in the
 * fantasy `wired` total hides the most droppable category of all — MLB is not
 * in the approved product. So it gets its own label, on the same explicit-list
 * precedent as the betting surfaces: the list is the test.
 */
export const MLB_ENTRY_POINTS = Object.freeze([
  'server/routes/mlb.js',
]);

/** 'betting' | 'mlb' | 'fantasy' — 'fantasy' is the default, so a new route counts as product. */
export function surfaceLabel(file) {
  if (BETTING_ENTRY_POINTS.includes(file)) return 'betting';
  if (MLB_ENTRY_POINTS.includes(file)) return 'mlb';
  return 'fantasy';
}

const SOURCE_EXT = /\.(js|mjs|ts|tsx)$/;
/** Build output is not a consumer: it is a copy of code already counted. */
const NOT_A_CONSUMER = f => f.startsWith('client/dist/');

/**
 * Reverse the import arrows: module -> the files that import it.
 *
 * Both forms count, because both are used in this codebase and only one of
 * them is what people grep for: `import ... from './x.js'` and
 * `await import('./x.js')` (server/index.js mounts every route with the
 * second). Only edges whose target is itself a tracked file are recorded, so
 * a typo cannot invent a node.
 */
export function buildImporterGraph({ files, read }) {
  const known = new Set(files);
  const importers = Object.create(null);
  for (const file of files) {
    if (NOT_A_CONSUMER(file)) continue;
    const src = read(file);
    if (typeof src !== 'string') continue;
    for (const m of src.matchAll(/(?:\bfrom|\bimport\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
      if (!known.has(target) || target === file) continue;
      (importers[target] ??= new Set()).add(file);
    }
  }
  return importers;
}

/**
 * Split the import edges by the mechanism that runs them (Auditor §R17.4).
 *
 * REQUEST REACH — an import at module scope, static or `await import(...)` at
 * the top level. It runs when the module loads, so any handler that loads the
 * module has it. `server/index.js` mounts every route this way.
 *
 * JOB REACH — an import inside a function body. It runs only when that function
 * is called, which for a scheduled job means only when the job runs.
 * `scheduler.js:1064` is the live case: `await import('./nfl-auto-picks.js')`
 * inside `refreshNflDecisionLedger()`, which is how a betting veto reads as
 * reachable from a fantasy route.
 *
 * The two are never summed. Naming this "via scheduler.js" would encode one
 * file where the mechanism is what matters, and the mechanism is in the syntax.
 * This repo: 1,687 module-scope imports against 240 inside function bodies.
 */
export function classifyImportEdges({ files, read }) {
  const known = new Set(files);
  const request = Object.create(null);
  const deferred = Object.create(null);
  for (const file of files) {
    if (NOT_A_CONSUMER(file)) continue;
    const src = read(file);
    if (typeof src !== 'string') continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const add = (bucket, spec) => {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!known.has(target) || target === file) return;
      (bucket[target] ??= new Set()).add(file);
    };
    const insideFunction = node => {
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)
            || ts.isArrowFunction(p) || ts.isMethodDeclaration(p)
            || ts.isConstructorDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) return true;
      }
      return false;
    };
    const visit = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
          && node.moduleSpecifier.text.startsWith('.')) {
        add(request, node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
          && node.arguments[0].text.startsWith('.')) {
        add(insideFunction(node) ? deferred : request, node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { request, deferred };
}

/**
 * The routers server/index.js actually mounts.
 *
 * Importing a router is not mounting it. An imported-but-unmounted router is
 * the orphaned-route case CONTRACT.md section 2 names, and treating the import
 * alone as an entry point would grade every orphan `wired` -- which is how a
 * first-cut wiring map gets the number wrong in the safe-looking direction.
 * So a route counts only when its bound identifier also appears in an
 * `app.use(...)` call.
 */
export function mountedRoutes(indexSource) {
  const bound = new Map();
  for (const m of indexSource.matchAll(
    /(?:const|let|var)\s*\{[^}]*\bdefault\s*:\s*(\w+)[^}]*\}\s*=\s*await\s+import\(\s*['"]\.\/(routes\/[^'"]+)['"]/g,
  )) {
    bound.set(m[1], `server/${m[2]}`);
  }
  const mounted = new Set();
  for (const m of indexSource.matchAll(/\bapp\.use\(([^;]*?)\)\s*;/gs)) {
    for (const [ident, file] of bound) {
      if (new RegExp(`\\b${ident}\\b`).test(m[1])) mounted.add(file);
    }
  }
  return mounted;
}

/**
 * server/index.js importing a route file grants that file nothing.
 *
 * A mounted route is already an entry point in its own right, so the walk
 * stops there and never needs the edge. An UNMOUNTED route is loaded at boot
 * and its handlers never run -- counting the boot import as a reach would
 * grade every orphaned route `wired` through server/index.js, which is the
 * same safe-looking overstatement `mountedRoutes` exists to prevent, arriving
 * by a different door. Found by running this grader against the repository,
 * not by reading it.
 */
export function dropRouteBootEdges(importers, { bootFile = 'server/index.js', isRoute = f => f.startsWith('server/routes/') } = {}) {
  const out = Object.create(null);
  for (const [target, set] of Object.entries(importers)) {
    const keep = [...set].filter(f => !(f === bootFile && isRoute(target)));
    if (keep.length) out[target] = new Set(keep);
  }
  return out;
}

/** Scripts wired into `npm run ...`. A script with no npm entry is hand-run, not wired. */
export function packageScriptEntries(packageJson) {
  const entries = new Set();
  for (const command of Object.values(packageJson.scripts || {})) {
    for (const m of String(command).matchAll(/\b((?:scripts|server)\/[\w./-]+\.(?:mjs|js))\b/g)) {
      entries.add(m[1]);
    }
  }
  return entries;
}

/**
 * Every entry point that reaches `start`, with a shortest path to each.
 *
 * Breadth-first over the reverse graph. Finding an entry point records it and
 * stops that branch -- it does NOT stop the search, which is the whole point.
 * Cycles terminate on the visited set.
 *
 * `maxDepth` is a guard, not a default: when it cuts a frontier that still had
 * nodes, the result is marked `truncated` and `gradeReach` refuses to grade it.
 * A truncated walk under-reports entry points, and under-reporting is exactly
 * what turns `wired` into `wired-betting-only` by accident.
 */
export function reachableEntries(importers, start, { isEntry, maxDepth = Infinity } = {}) {
  if (typeof isEntry !== 'function') throw new TypeError('reachableEntries requires an isEntry predicate');
  const up = node => {
    const v = importers instanceof Map ? importers.get(node) : importers[node];
    return v ? [...v] : [];
  };
  const entries = new Map();
  const seen = new Set([start]);
  // The subject may BE an entry point -- a mounted route is the thing that
  // serves, so it cannot be `unreached`. The walk only ever tests the nodes it
  // walks up to, so without this 19 of this repo's 31 route files came back
  // unreached. Found while diffing this grader against another thread's.
  if (isEntry(start)) entries.set(start, [start]);
  let frontier = [[start, [start]]];
  let depth = 0;
  let truncated = false;
  while (frontier.length) {
    if (depth >= maxDepth) { truncated = true; break; }
    const next = [];
    for (const [node, trail] of frontier) {
      for (const importer of up(node)) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        const path_ = [...trail, importer];
        if (isEntry(importer)) { entries.set(importer, path_); continue; }
        next.push([importer, path_]);
      }
    }
    frontier = next;
    depth += 1;
  }
  seen.delete(start);
  return { entries, truncated, visited: seen, visitedCount: seen.size };
}

/**
 * The grade, from the set of entry points.
 *
 * `wired-betting-only` needs ALL entry points to be betting surfaces. One
 * non-betting entry point makes the row `wired`; none at all makes it
 * `unreached` -- which is a statement about code, not about data.
 */
export function gradeReach(reach, { isBettingEntry = isBettingEntryPoint, label = surfaceLabel, isHandRunScript = () => false } = {}) {
  const entries = [...reach.entries.keys()].sort();
  const labelOf = e => (isBettingEntry(e) ? 'betting' : label(e));
  const betting = entries.filter(e => labelOf(e) === 'betting');
  const mlb = entries.filter(e => labelOf(e) === 'mlb');
  const fantasy = entries.filter(e => labelOf(e) === 'fantasy');
  const nonBetting = entries.filter(e => labelOf(e) !== 'betting');
  const base = { entries, betting, mlb, fantasy, nonBetting, handRun: [], paths: reach.entries, truncated: Boolean(reach.truncated) };

  if (reach.truncated) {
    return { ...base, grade: 'indeterminate', reason: 'the walk was truncated at the depth limit, so the entry-point set is incomplete' };
  }
  if (entries.length === 0) {
    const handRun = [...(reach.visited || [])].filter(isHandRunScript).sort();
    if (handRun.length) {
      return { ...base, grade: 'hand-run-script', handRun, reason: `reached only when a person types the command: ${handRun.join(', ')}` };
    }
    return { ...base, grade: 'unreached', reason: 'no entry point imports this module, directly or transitively' };
  }
  // Off-product reach: no fantasy entry point at all. Which off-product surface
  // is a sub-label, never a fold — §R18.1: recording an MLB-only module as
  // betting-only states a false fact the Phase A plan then reads.
  if (fantasy.length === 0) {
    if (mlb.length === 0) {
      return { ...base, grade: 'wired-betting-only', reason: `every entry point is a betting surface: ${betting.join(', ')}` };
    }
    if (betting.length === 0) {
      return { ...base, grade: 'wired-mlb-only', reason: `every entry point is an MLB surface: ${mlb.join(', ')}` };
    }
    return { ...base, grade: 'wired-offproduct-only', reason: `no fantasy entry point; reached from betting (${betting.join(', ')}) and MLB (${mlb.join(', ')})` };
  }
  const shown = fantasy.slice(0, 3).join(', ');
  const rest = fantasy.length > 3 ? ` (+${fantasy.length - 3} more)` : '';
  return { ...base, grade: 'wired', reason: `reached from the fantasy product via ${shown}${rest}` };
}

/** The real repository, as a graph plus the entry-point predicate that goes with it. */
export function repoGraph({ cwd = process.cwd() } = {}) {
  const files = execSync('git ls-files', { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').map(s => s.trim()).filter(f => SOURCE_EXT.test(f) && !NOT_A_CONSUMER(f));
  const read = f => {
    try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return null; }
  };
  const raw = buildImporterGraph({ files, read });
  const indexSource = read('server/index.js') || '';
  const mounted = mountedRoutes(indexSource);
  const scripts = packageScriptEntries(JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')));
  const importers = dropRouteBootEdges(raw);
  const isEntry = f => mounted.has(f) || scripts.has(f) || f.startsWith('client/src/');
  const isHandRun = f => !isEntry(f)
    && /^(scripts|server\/scripts)\//.test(f)
    && !(raw[f] && raw[f].size);
  return { files, importers, isEntry, isHandRun, mounted, scripts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const targets = argv.filter(a => !a.startsWith('--'));
  if (!targets.length) {
    console.error('usage: node scripts/reach-grade.mjs [--json] <repo-relative file> ...');
    process.exit(2);
  }
  const { importers, isEntry, isHandRun } = repoGraph();
  const report = targets.map(target => {
    const graded = gradeReach(reachableEntries(importers, target, { isEntry }), { isHandRunScript: isHandRun });
    return {
      file: target,
      grade: graded.grade,
      reason: graded.reason,
      entries: graded.entries,
      betting: graded.betting,
      handRun: graded.handRun,
      paths: Object.fromEntries([...graded.paths].map(([k, v]) => [k, v.join(' <- ')])),
    };
  });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const r of report) {
      console.log(`\n### ${r.file}\n  grade: ${r.grade}\n  why:   ${r.reason}`);
      for (const [entry, trail] of Object.entries(r.paths)) {
        console.log(`  ${isBettingEntryPoint(entry) ? 'BETTING' : 'entry  '} ${trail}`);
      }
    }
  }
  process.exit(report.some(r => r.grade === 'indeterminate') ? 1 : 0);
}
