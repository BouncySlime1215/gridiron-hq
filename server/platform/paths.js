/**
 * The project's roots, resolved once and explicitly.
 *
 * Codex plan section 10.3 asks for this module, and section 10.4 says to build
 * it FIRST, before any file moves: "First fix location assumptions.
 * `nfl-research-lab.js` computes its root from `../..` and reads
 * `server/data/*​/latest.json` plus `docs/CLAUDE-NEXT-STEPS.md`. A direct move
 * breaks these even if imports compile."
 *
 * That is the trap this exists to remove. Three services currently derive the
 * project root by walking two directories up from their own file:
 *
 *     const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
 *
 * It works, and it is invisible. `server/services/x.js` walks up to the
 * project root; `server/betting/nfl/forecast/x.js` -- the same file after the
 * ownership move section 10.2 proposes -- walks up to `server/betting`. The
 * imports still resolve, the build still succeeds, the tests still pass, and
 * at runtime the file quietly reads nothing. Section 10.4 names exactly this:
 * "A successful build alone does not test runtime file loading."
 *
 * Every root below is resolved from THIS module's own location and nothing
 * else. Not `process.cwd()`, which changes when the app is launched from
 * elsewhere; not a relative walk from each consumer, which changes when a
 * consumer moves. A file that imports `PROJECT_ROOT` can be moved anywhere in
 * the tree and keeps reading the same data.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `server/platform/` → `server/`. */
export const SERVER_ROOT = path.resolve(here, '..');

/** `server/` → the project root. The ONE place this walk is written. */
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

/**
 * Where generated data artifacts live.
 *
 * Section 10.4: "Keep existing data locations stable through the first
 * reorganization." This deliberately points at the location that exists today
 * rather than a tidier one, because moving stored artifacts and moving the code
 * that reads them are two separate changes and doing both at once means a
 * failure cannot be attributed to either.
 */
export const DATA_ROOT = path.join(SERVER_ROOT, 'data');

/** The documentation tree, including the single canonical plan. */
export const DOCS_ROOT = path.join(PROJECT_ROOT, 'docs');

/** The one active plan. Section 10.4: "Keep one active plan at docs/CLAUDE-NEXT-STEPS.md." */
export const CANONICAL_PLAN = path.join(DOCS_ROOT, 'CLAUDE-NEXT-STEPS.md');

/** Dated evidence. Never a work queue — see the plan's own section 10.4. */
export const EVIDENCE_ROOT = path.join(DOCS_ROOT, 'evidence');

/** Python research labs. */
export const RESEARCH_ROOT = path.join(PROJECT_ROOT, 'research');

/** Database migrations, discovered by filename order by `server/db/migrate.js`. */
export const MIGRATIONS_ROOT = path.join(SERVER_ROOT, 'migrations');

/*
 * `dataPath()` and `docsPath()` were here and are gone (2026-09-20). They were
 * `path.join(DATA_ROOT, ...)` and `path.join(DOCS_ROOT, ...)` and had no
 * caller anywhere in server, client, scripts or test.
 *
 * The argument for keeping an unused export in THIS module is the header
 * above: it exists so something can ask where things resolved to, and an
 * export nobody calls today may still be part of that surface. That argument
 * covers the ROOTS, and `resolvedRoots()` below is where it is discharged --
 * every root is named there and the module's test walks it. It does not cover
 * two convenience wrappers around `path.join`, which answer nothing about
 * resolution that `DATA_ROOT` and `DOCS_ROOT` do not already answer, and
 * which are both still exported.
 */

/**
 * Every root, with whether it actually exists on disk.
 *
 * Section 10.3's acceptance for this module is "Test launch from another
 * working directory and installed/packaged mode." A packaging test needs to be
 * able to ASK where things resolved to and whether they are there -- checking
 * that an import compiled proves nothing about a file read at runtime, which
 * is the whole failure mode this module removes.
 */
export function resolvedRoots() {
  const roots = {
    project: PROJECT_ROOT, server: SERVER_ROOT, data: DATA_ROOT, docs: DOCS_ROOT,
    evidence: EVIDENCE_ROOT, research: RESEARCH_ROOT, migrations: MIGRATIONS_ROOT,
    canonical_plan: CANONICAL_PLAN
  };
  return Object.fromEntries(Object.entries(roots)
    .map(([name, value]) => [name, { path: value, exists: existsSync(value) }]));
}
