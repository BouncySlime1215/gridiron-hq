/**
 * What code produced this answer?
 *
 * Codex correction C01 (2026-09-10): the decision tape accepted `codeHash`
 * and `dataHash` as arbitrary strings from whoever called it. A caller could
 * pass `'abc'`, or nothing at all, and the tape would content-address a
 * decision as though the identity of the software that made it had been
 * established. The plan's words: "The producer must supply checked payloads
 * and real identities, not arbitrary trusted hash strings."
 *
 * This module computes a real one, by reading the actual source files that a
 * decision depends on and hashing their contents.
 *
 * Two things it deliberately does NOT do, both of which are the existing
 * `trainingAuditCodeHash` in nfl-replay.js getting them wrong (Codex
 * correction C08, still open at the time of writing):
 *
 *   1. **It never shells out to git.** A predicate's identity must not depend
 *      on whether the software is running inside a working tree, or on a
 *      packaged install where `.git` does not exist at all. Nor may it fail
 *      open: a git call that errors there returns nothing, and a missing
 *      identity was being accepted.
 *
 *   2. **It never reads `process.cwd()`.** Launching the server from a
 *      different directory must not change what the model is claimed to be.
 *      Every path here is resolved from this file's own location via
 *      `import.meta.url`, which is fixed at build time and survives being
 *      started from anywhere.
 *
 * It also hashes only what a decision actually imports, walked transitively
 * from a declared root. Editing a documentation file, a fantasy draft screen
 * or any unrelated service therefore does not change the spread model's
 * identity, which is the specific failure C08 describes: "unrelated docs
 * edits do not change predicate identity."
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The repository's server root, resolved from this module's own location.
 * `server/platform/code-identity.js` → `server/`. Everything reported by this
 * module is named relative to here, so the same checkout produces the same
 * identity whether it lives under a developer's home directory, a packaged
 * app bundle, or a CI runner's temporary path.
 */
export const SERVER_ROOT = path.resolve(__dirname, '..');

/**
 * Static relative imports only. Bare specifiers (`node:crypto`, npm packages)
 * are deliberately excluded: their versions belong in a dependency lock, which
 * is a different artifact with a different update cadence, and following them
 * would drag `node_modules` into every hash. `import.meta.url` self-references
 * and dynamic `import()` with a computed specifier cannot be resolved
 * statically; where a module uses one, it is reported in `unresolved` rather
 * than silently ignored, so a caller can see that the closure is incomplete
 * instead of trusting a hash that quietly missed a dependency.
 */
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const BARE_DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const COMPUTED_DYNAMIC_IMPORT = /\bimport\s*\(\s*(?!['"])/;

function specifiersIn(source) {
  const found = new Set();
  for (const m of source.matchAll(STATIC_IMPORT)) found.add(m[1]);
  for (const m of source.matchAll(BARE_DYNAMIC_IMPORT)) found.add(m[1]);
  return [...found];
}

/**
 * Walk the module graph from one or more roots and return every repository
 * file it reaches, with the SHA-256 of each file's exact bytes.
 *
 * Sorted by path so the result depends only on the set of files and their
 * contents, never on the order the walk happened to visit them in.
 */
export function moduleClosure(rootRelativePaths) {
  const seen = new Map();
  const unresolved = [];
  const missing = [];
  const queue = [...rootRelativePaths];

  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(SERVER_ROOT, rel);
    let source;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      // A root or import that does not exist on disk is a real integrity
      // problem, not something to skip quietly. It is recorded and surfaced
      // to the caller, which refuses to build an identity from it.
      missing.push(rel);
      continue;
    }
    seen.set(rel, createHash('sha256').update(source).digest('hex'));

    if (COMPUTED_DYNAMIC_IMPORT.test(source)) unresolved.push(rel);

    for (const spec of specifiersIn(source)) {
      if (!spec.startsWith('.')) continue; // bare specifier — see STATIC_IMPORT
      const resolved = path.relative(SERVER_ROOT, path.resolve(path.dirname(abs), spec));
      if (resolved.startsWith('..')) continue; // outside server/ — not ours to hash
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }

  const files = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([file, sha256]) => ({ file, sha256 }));
  return { files, unresolved: unresolved.sort(), missing: missing.sort() };
}

/**
 * One hex SHA-256 standing for "exactly this code", plus the manifest it was
 * computed from. Throws rather than returning a degraded value when a
 * declared root or one of its imports is missing from disk: an identity that
 * silently means "most of the model" is worse than no identity, because it
 * still looks authoritative in the evidence.
 */
export function codeIdentity(rootRelativePaths, label) {
  const closure = moduleClosure(rootRelativePaths);
  if (closure.missing.length) {
    throw new Error(`cannot establish ${label} code identity — missing source: ${closure.missing.join(', ')}`);
  }
  const manifest = {
    schema_version: 'code-identity-v1',
    label,
    roots: [...rootRelativePaths].sort(),
    files: closure.files,
    // Carried INTO the hash, not merely reported alongside it: a module that
    // gained a computed dynamic import has a genuinely less complete manifest
    // than one that did not, and that difference must change the identity.
    unresolved_dynamic_imports: closure.unresolved
  };
  return {
    id: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    manifest,
    file_count: closure.files.length,
    complete: closure.unresolved.length === 0
  };
}

/**
 * The spread decision path: the board that ranks candidates, the policy that
 * gates them, and the pipeline that opens contracts from the result. Their
 * transitive imports pull in the ensemble, calibration, devig, findings and
 * forecast-identity modules, which is the point — this is "the complete
 * forecast/dependency identity" C01 asks the tape to hash, resolved by
 * following what the code actually imports rather than by maintaining a
 * hand-written list that drifts.
 *
 * Cached: the files cannot change while the process runs, and every decision
 * in a weekly board would otherwise re-read and re-hash the same tree.
 */
const SPREAD_DECISION_ROOTS = [
  'services/nfl-auto-picks.js',
  'services/nfl-policy.js',
  'services/nfl-execution-pipeline.js'
];

let _spreadDecisionIdentity;
export function spreadDecisionCodeIdentity() {
  _spreadDecisionIdentity ??= codeIdentity(SPREAD_DECISION_ROOTS, 'nfl-spread-decision');
  return _spreadDecisionIdentity;
}

/** Test-only: drop the cache so a fixture can rewrite a file and re-measure. */
export function resetCodeIdentityCache() {
  _spreadDecisionIdentity = undefined;
}
