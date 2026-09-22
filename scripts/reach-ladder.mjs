#!/usr/bin/env node
/**
 * The reach ladder, as a command.
 *
 * docs/inventory/CONTRACT.md publishes a headline that, until this file, no
 * command produced. `183 wired`, the `116 / 67` route-versus-script split and
 * the `53 / 14` line were worked out per row inside a session and written
 * down only as prose. Nothing regenerated them; nobody could check them; they
 * were cited across the project for a day (Independent Auditor R51.3). The
 * contract's own test is that a rule with no consumer able to detect its
 * violation is decoration, and by that test its own headline was decoration.
 *
 * THIS FILE ADDS NO GRADING LOGIC. Every grade comes from reach-grade.mjs. A
 * ladder script that re-implemented the grader would agree with the grader's
 * bugs and validate nothing -- the same mistake a cross-check in this thread
 * already made once, when a script written to check symbol-reach.mjs
 * re-implemented its detection and so agreed with the defect it was meant to
 * find.
 *
 * TWO AXES, NEVER ONE NUMBER
 * --------------------------
 * The figures being replaced conflated two questions. Keeping them apart is
 * most of the point of this file.
 *
 *   EDGE MECHANISM -- is the import at module scope, so it runs when the
 *   module loads, or inside a function body, so it runs only if that function
 *   is called? This is CONTRACT.md's bracket. Its low end is the graph of
 *   module-scope edges alone (classifyImportEdges().request); its high end is
 *   the full importer graph, which adds the deferred edges a scheduler job
 *   executes. The two are never summed: they are one population counted under
 *   two definitions of "reaches".
 *
 *   ENTRY TYPE -- is the entry point that reaches this file a mounted route,
 *   or a package.json script? Asked of ONE graph, and it is not a bracket.
 *   Reporting it as one is what produced `116 / 67`.
 *
 * A reader handed a single number will assume it answered their question. So
 * both are printed, separately named, edge bracket first, and the entry table
 * carries "not the bracket" in its own words for anyone who reads only it.
 *
 * WHAT THIS DOES NOT ANSWER
 * -------------------------
 * Import reach, not call reach: an entry point that imports a module is not
 * an entry point that calls anything in it. Nothing here executes the app, so
 * a path that is statically reachable and dynamically never taken still
 * counts. "Job reach" means the in-process scheduler's deferred imports; it
 * is not the same notion as a package.json script being run by the scheduler,
 * which is a third thing and has its own row.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import {

  buildImporterGraph,
  classifyImportEdges,
  dropRouteBootEdges,
  gradeReach,
  mountedRoutes,
  packageScriptEntries,
  isBettingEntryPoint,
  reachableEntries,
} from './reach-grade.mjs';

const require = createRequire(import.meta.url);

/**
 * Fixed so two runs are comparable cell by cell. A tally carrying a grade
 * this does not name is an error rather than a dropped column: a new grade
 * appearing silently would change a column sum with nothing to notice.
 */
export const GRADE_ORDER = Object.freeze([
  'wired',
  'wired-betting-only',
  'wired-mlb-only',
  'wired-offproduct-only',
  'hand-run-script',
  'unreached',
]);

export const REQUIRED_TYPESCRIPT = '5.9.3';

const SOURCE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx)$/;

export const EDGE_AXIS = Object.freeze({
  name: 'EDGE MECHANISM (the bracket)',
  order: 0,
  isBracket: true,
  note: 'One population, two definitions of "reaches". The ends are never summed.',
});

export const ENTRY_AXIS = Object.freeze({
  name: 'ENTRY TYPE (not the bracket)',
  order: 1,
  isBracket: false,
  note: 'Route versus package.json script, over ONE graph. This is not the bracket, '
      + 'and must never be quoted as one: it answers which kind of entry point '
      + 'reaches a file, not whether the import runs at load or on call.',
});

/**
 * The toolchain gate. The grader parses with the TypeScript compiler, so a
 * different compiler is a different measurement -- and would show up as a
 * ladder that quietly disagrees with a published one rather than as an error.
 */
export function requireToolchain({ typescript, required = REQUIRED_TYPESCRIPT }) {
  if (typescript !== required) {
    throw new Error(
      `reach-ladder requires typescript ${required}, found ${typescript}. `
      + 'The grader parses with the TypeScript compiler, so a different compiler is a '
      + 'different measurement; a ladder measured on it is not comparable to a published one.',
    );
  }
  return true;
}

/**
 * One row of the ladder: every grade in GRADE_ORDER, plus the column sum.
 *
 * The sum is not decoration. CONTRACT.md:160-166 printed 178 for request-only
 * `wired` in a column that sums to 325 against a population of 319, and that
 * arithmetic is the whole evidence that the figure came from no run over that
 * population. A row that does not sum is refused here rather than printed.
 */
export function ladderRow({ tally, population }) {
  const unknown = Object.keys(tally).filter(g => !GRADE_ORDER.includes(g));
  if (unknown.length) {
    throw new Error(
      `reach-ladder: grade(s) not in GRADE_ORDER: ${unknown.join(', ')}. `
      + 'A new grade must be added to GRADE_ORDER deliberately -- dropping it would '
      + 'change a column sum with nothing able to notice.',
    );
  }
  const cells = GRADE_ORDER.map(g => tally[g] || 0);
  const sum = cells.reduce((a, b) => a + b, 0);
  if (sum !== population) {
    throw new Error(
      `reach-ladder: column sums to ${sum}, population is ${population}. `
      + 'A ladder row counts every file in its population exactly once; a row that '
      + 'does not sum did not come from a run over that population.',
    );
  }
  return { cells, sum };
}

/**
 * Route-reached versus script-only, over one graph.
 *
 * script-only means NO route entry reaches the file at all. A file reached by
 * both a route and a script is route-reached: the question is whether a
 * request can get there, and one route that can is enough.
 */
export function entrySplit({ perFile, isRouteEntry }) {
  let route = 0;
  let scriptOnly = 0;
  for (const entries of perFile.values()) {
    if (entries.some(isRouteEntry)) route += 1;
    else scriptOnly += 1;
  }
  return { route, scriptOnly };
}

/**
 * The third notion: package.json script entries the scheduler spawns.
 *
 * This is NOT "job reach". Job reach is the in-process scheduler's deferred
 * imports -- a function-body `import()` that runs when the job runs, inside
 * this process. This is the narrower, separate case where the scheduler
 * shells out: `scheduler.js:714-721` builds a path and hands it to `execFile`
 * as a child process. Two different mechanisms, and folding them together
 * would be the same conflation the two axes above exist to prevent.
 *
 * Derived by PARSING, not by grepping. An earlier version of this function
 * matched each script's basename anywhere in the scheduler source, which
 * reported five scripts including `server/index.js` -- a false positive from
 * the substring `index.js`. A loose matcher here is worse than no answer at
 * all: it is a heuristic wearing a command's clothes, which is the exact
 * defect this whole file exists to remove. It now collects string literals
 * matching `scripts/<name>.mjs` from the parsed source, so a path in a
 * comment or inside prose cannot count, and intersects them with the
 * package.json script entries.
 *
 * Returns null when the set cannot be derived. That is the point of the
 * function, and it was committed in advance: an underivable split is REPORTED
 * as underivable and script-only is printed as one number, never as a
 * hand-written list.
 *
 * What it does not see: a path assembled at runtime from variables. Named
 * here rather than left for someone to discover.
 */
export function schedulerInvokedScripts({ schedulerSource, scripts }) {
  if (typeof schedulerSource !== 'string' || !schedulerSource.length) return null;
  const ts = require('typescript');
  const sf = ts.createSourceFile('scheduler.js', schedulerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const literals = new Set();
  const visit = node => {
    if (ts.isStringLiteral(node) && /^scripts\/[\w.-]+\.mjs$/.test(node.text)) literals.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const invoked = [...literals].filter(f => scripts.has(f)).sort();
  return invoked.length ? new Set(invoked) : null;
}

/**
 * The route-entry predicate the ladder actually uses.
 *
 * Exported because `entrySplit` takes this as an argument, so a test of
 * `entrySplit` alone tests nothing about which predicate the ladder passes
 * it. A mutation that deleted the betting exclusion from the call site
 * survived the whole suite for exactly that reason -- the unit was pinned and
 * the wiring was not, which is how the first run of this script reported
 * 227 / 1 against the frozen 214 / 14.
 *
 * Betting entries are excluded, and only betting entries (Auditor R54.2
 * condition 4). MLB and off-product entries are not: the grade axis already
 * separates those, and excluding them here would apply one exclusion twice.
 */
export function routeEntryPredicate(mounted) {
  return e => mounted.has(e) && !isBettingEntryPoint(e);
}

/** The population CONTRACT.md's "summing to 319" refers to. */
export function ladderPopulation(files) {
  return files.filter(f => f.startsWith('server/services/') || f.startsWith('server/modeling/'));
}

function subtreeHash(cwd, dir) {
  try {
    return execSync(`git rev-parse HEAD:${dir}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function measure({ cwd = process.cwd() } = {}) {
  requireToolchain({ typescript: require('typescript').version });

  const files = execSync('git ls-files', { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').map(s => s.trim()).filter(f => SOURCE_EXT.test(f));
  const read = f => {
    try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return null; }
  };

  const indexSource = read('server/index.js') || '';
  const mounted = mountedRoutes(indexSource);
  const scripts = packageScriptEntries(JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')));
  const isEntry = f => mounted.has(f) || scripts.has(f) || f.startsWith('client/src/');
  const population = ladderPopulation(files);

  const graded = raw => {
    const importers = dropRouteBootEdges(raw);
    const isHandRun = f => !isEntry(f)
      && /^(scripts|server\/scripts)\//.test(f)
      && !(raw[f] && raw[f].size);
    const tally = {};
    const wiredEntries = new Map();
    for (const f of population) {
      const reach = reachableEntries(importers, f, { isEntry });
      const g = gradeReach(reach, { isHandRunScript: isHandRun });
      tally[g.grade] = (tally[g.grade] || 0) + 1;
      if (g.grade === 'wired') wiredEntries.set(f, [...reach.entries.keys()]);
    }
    return { row: ladderRow({ tally, population: population.length }), wiredEntries };
  };

  const requestOnly = graded(classifyImportEdges({ files, read }).request);
  const requestPlusJob = graded(buildImporterGraph({ files, read }));

  const split = entrySplit({
    perFile: requestPlusJob.wiredEntries,
    isRouteEntry: routeEntryPredicate(mounted),
  });
  const schedulerScripts = schedulerInvokedScripts({
    schedulerSource: read('server/services/scheduler.js'),
    scripts,
  });

  return {
    tree: {
      head: execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim(),
      writeTree: execSync('git write-tree', { cwd, encoding: 'utf8' }).trim(),
      // The hashes a figure from this command should actually be quoted with.
      // A commit sha and a `write-tree` both move when a DOCUMENT is edited, so
      // an evidence file citing either invalidates its own citation on the next
      // keystroke. These two move only when the measured code moves.
      servicesTree: subtreeHash(cwd, 'server/services'),
      modelingTree: subtreeHash(cwd, 'server/modeling'),
    },
    toolchain: { node: process.version, typescript: require('typescript').version },
    population: population.length,
    edge: { 'request-only': requestOnly.row, 'request+job': requestPlusJob.row },
    entry: split,
    schedulerInvokedScripts: schedulerScripts ? [...schedulerScripts] : null,
  };
}

function render(result) {
  const out = [];
  out.push(`commit    ${result.tree.head}  write-tree ${result.tree.writeTree}`);
  out.push(`measured  server/services ${result.tree.servicesTree}  server/modeling ${result.tree.modelingTree}`);
  out.push(`toolchain node ${result.toolchain.node}  typescript ${result.toolchain.typescript}`);
  out.push(`population ${result.population} (server/services + server/modeling)`);

  out.push('', `## ${EDGE_AXIS.name}`, EDGE_AXIS.note, '');
  out.push(`| definition | ${GRADE_ORDER.join(' | ')} | sum |`);
  out.push(`|---|${GRADE_ORDER.map(() => '---:').join('|')}|---:|`);
  for (const [k, row] of Object.entries(result.edge)) {
    out.push(`| ${k} | ${row.cells.join(' | ')} | ${row.sum} |`);
  }
  const lo = result.edge['request-only'].cells[0];
  const hi = result.edge['request+job'].cells[0];
  out.push('', `bracket: ${lo}-${hi} wired. Not a confidence interval -- two definitions.`);

  out.push('', `## ${ENTRY_AXIS.name}`, ENTRY_AXIS.note, '');
  out.push(`route-reached ${result.entry.route} · script-only ${result.entry.scriptOnly}`
    + ` · sum ${result.entry.route + result.entry.scriptOnly} (of the request+job wired count)`);

  out.push('', '## SCHEDULER-INVOKED PACKAGE SCRIPTS (a third notion)');
  out.push(result.schedulerInvokedScripts
    ? `${result.schedulerInvokedScripts.length}: ${result.schedulerInvokedScripts.join(', ')}`
    : 'NOT DERIVABLE BY COMMAND. script-only is reported above as one number, and the '
      + '53 / 14 split is not reproducible. No hand-written list is substituted here.');
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = measure();
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : render(result));
}
