#!/usr/bin/env node
/**
 * Stage 2 entry point (Giant Plan Step 4b — bottom-up team total).
 *
 *   node scripts/audit-bottom-up-team-total.mjs
 *
 * Self-contained and safe to run any time: builds a small /tmp snapshot of
 * the real, live database (read-only source, see _prepare-validation-db.mjs
 * for exactly why a byte-for-byte copy is not used and a plain `readOnly`
 * connection to server/db/index.js is not an option), then runs the
 * walk-forward worker against that snapshot only. The real data.sqlite is
 * never opened for writing anywhere in this path.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const VALIDATION_DB = '/tmp/gridiron-insane-bottom-up-validation/validation.sqlite';
const OUT_JSON = path.join(REPO_ROOT, 'scripts', '.bottom-up-team-total-results.json');

console.log('[audit] preparing validation database (real data.sqlite read-only, never written)...');
execFileSync('node', ['scripts/_prepare-validation-db.mjs', VALIDATION_DB], { cwd: REPO_ROOT, stdio: 'inherit' });

console.log('\n[audit] running walk-forward worker against the validation snapshot...');
execFileSync('node', ['scripts/_bottom-up-team-total-worker.mjs', OUT_JSON], {
  cwd: REPO_ROOT, stdio: 'inherit',
  env: { ...process.env, GRIDIRON_DB_PATH: VALIDATION_DB }
});
