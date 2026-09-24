/**
 * Which process is this, and may it write engine tables? (ENGINE-ARCHITECTURE.md §9.1, D8)
 *
 * Fail closed: `appendEvents` and `writeState` refuse unless GRIDIRON_PROCESS_ROLE is
 * explicitly one of WRITE_ROLES. An unset role is refused, because the launcher, Docker
 * and the installers set nothing, and a guard that is off by default is off in production.
 *
 *   engine        the engine daemon: the one writer of engine tables
 *   script        R&D and backfill scripts (scripts/engine-backfill.mjs), on DB copies
 *   test          the test suite
 *   web           the web server (server/index.js sets it in code before any import): reads only
 *   refresh       the refresh job: never imports services/engine/*
 *   engine-child  nightly/weekly children: emit JSON, write nothing
 *
 * The role is read on every call (not cached), so it cannot be captured at import time.
 */
export const WRITE_ROLES = Object.freeze(['engine', 'script', 'test']);
export const KNOWN_ROLES = Object.freeze(['engine', 'script', 'test', 'web', 'refresh', 'engine-child']);

export function processRole() {
  const r = process.env.GRIDIRON_PROCESS_ROLE;
  return typeof r === 'string' && r ? r : null;
}

export function canWriteEngine() {
  return WRITE_ROLES.includes(processRole());
}

/** Throws unless this process may write engine tables. `what` names the refused call. */
export function assertWriteRole(what) {
  const r = processRole();
  if (!WRITE_ROLES.includes(r)) {
    throw new Error(`${what}: engine tables are written only by roles ${WRITE_ROLES.join('/')}; `
      + `this process role is ${r == null ? 'unset' : `"${r}"`} (set GRIDIRON_PROCESS_ROLE)`);
  }
}
