/**
 * Is the engine actually connected to itself?
 *
 * This project has a recurring failure mode that is worth naming, because it
 * has cost more than any modelling mistake: things get built, tested, and then
 * never wired to anything. `bestExecution()` sat unused for months. So did
 * `findTeaserLegs()` and the entire snapshot-reading path. A verified 32-team
 * newswire wrote prose nobody read. The scheduler silently never ran fourteen
 * of twenty jobs. In every case the code was correct and the value was zero.
 *
 * The pattern is invisible in normal use because nothing errors — a module that
 * is never imported simply sits there, passing its tests, doing nothing. So
 * this makes it visible on demand: build the import graph, and report every
 * module that nothing reaches.
 *
 * Two different questions, and the distinction matters:
 *
 *   ORPHANED     nothing imports it at all. Dead weight until wired.
 *   UNREACHABLE  something imports it, but no HTTP route can reach it. Live
 *                code that no user can trigger.
 *
 * Neither is automatically a bug — a module can be legitimately staged ahead of
 * a feature — but both should be a deliberate choice rather than a discovery.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const SERVICES = join(ROOT, 'services');
const ROUTES = join(ROOT, 'routes');

/** Every module specifier a file imports, static or dynamic, as a bare filename. */
function importsOf(file) {
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { return new Set(); }
  const out = new Set();
  for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) out.add(basename(m[1]));
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]/g)) out.add(basename(m[1]));
  return out;
}

const jsFiles = dir => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.js')).sort() : []);

/**
 * Report which service modules are wired into the running application and which
 * are not.
 *
 * @param expectedOrphans  modules deliberately left unwired, so the report can
 *   distinguish "known and intentional" from "nobody noticed".
 */
export function connectivityAudit({ expectedOrphans = [] } = {}) {
  const services = jsFiles(SERVICES);
  const routes = jsFiles(ROUTES);

  const importedBy = Object.fromEntries(services.map(s => [s, []]));
  const record = (dir, files) => {
    for (const f of files) {
      for (const dep of importsOf(join(dir, f))) {
        if (importedBy[dep]) importedBy[dep].push(f);
      }
    }
  };
  record(SERVICES, services);
  record(ROUTES, routes);
  if (existsSync(join(ROOT, 'index.js'))) record(ROOT, ['index.js']);

  // Anything transitively reachable from a route is reachable by a user.
  const reachable = new Set();
  const walk = (file, seen = new Set()) => {
    if (seen.has(file)) return;
    seen.add(file); reachable.add(file);
    for (const dep of importsOf(join(SERVICES, file))) {
      if (services.includes(dep)) walk(dep, seen);
    }
  };
  for (const r of routes) {
    for (const dep of importsOf(join(ROUTES, r))) if (services.includes(dep)) walk(dep);
  }

  const expected = new Set(expectedOrphans);
  const orphans = services.filter(s => importedBy[s].length === 0);
  const unreachable = services.filter(s => !reachable.has(s));

  const describe = list => list.map(f => {
    let title = null;
    try {
      const head = readFileSync(join(SERVICES, f), 'utf8').split('\n').slice(0, 6).join(' ');
      title = (head.match(/\*\s*([A-Z][^*.]{10,90})/)?.[1] ?? '').trim() || null;
    } catch { /* fine */ }
    return { module: f, imported_by: importedBy[f], expected: expected.has(f), summary: title };
  });

  const unexpectedOrphans = orphans.filter(o => !expected.has(o));

  return {
    service_modules: services.length,
    route_modules: routes.length,
    reachable_from_a_route: reachable.size,
    orphaned: describe(orphans),
    unreachable_from_routes: describe(unreachable),
    counts: {
      orphaned: orphans.length,
      orphaned_unexpected: unexpectedOrphans.length,
      unreachable: unreachable.length
    },
    healthy: unexpectedOrphans.length === 0,
    verdict: unexpectedOrphans.length === 0
      ? 'Every service module is either wired into the application or explicitly listed as ' +
        'deliberately unwired.'
      : `${unexpectedOrphans.length} module(s) nothing imports and nobody declared: ` +
        unexpectedOrphans.join(', ') + '. Wire them, list them as intentional, or delete them.',
    note: 'Static analysis of import statements, including dynamic import(). A module reachable ' +
      'only through a string built at runtime would be missed, so this under-reports connectivity ' +
      'rather than over-reporting it — the safe direction for a check whose job is finding dead code.'
  };
}
