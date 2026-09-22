/**
 * `scripts/build-manager-archetypes.mjs` calls the AI gateway (Jev) for real
 * when run with `--jev`, and `docs/tdd/paid-run-opt-in.tdd.md`'s own audit
 * table already named it: "exits 1 when AI_GATEWAY_API_KEY is unset, and
 * caps spend with JEV_MAX_USD... a key-presence check rather than a spend
 * opt-in, but it is a gate." An unset key or a budget the estimate exceeds
 * both refuse — but a run with a real key already exported (as this
 * project's own environment routinely has, for legitimate use) and a
 * reasonable estimate sails straight through with no opt-in at all. That is
 * the gap this closes, applying the same `scripts/paid-run-optin.mjs` guard
 * already proven on `run-news-event-impact.mjs` and
 * `build-negotiation-profiles.mjs`.
 *
 * THIS SCRIPT IS SHAPED DIFFERENTLY FROM BOTH EARLIER APPLICATIONS. `--jev`
 * is itself an OPT-IN flag (the default, no-flag invocation never spends —
 * it only measures draft-revealed preference and prints a report), and
 * `--jev --dry-run` is an existing no-cost preview mode, exactly like
 * `build-negotiation-profiles.mjs`'s `--dry-run`. So the guard only needs to
 * gate `--jev` runs that are NOT `--dry-run` — the default (no `--jev`) path
 * is untouched by this change and stays free of the opt-in requirement,
 * because it was never able to spend in the first place.
 *
 * Ordering: unlike the first two applications, this script opens the main
 * database unconditionally for every invocation (stage 1/2 measurement needs
 * it too, and is never billed), so "before the database opens" is not a
 * meaningful proof here. What's provable instead is that the guard is the
 * FIRST thing that runs once `--jev` is seen: refused, nothing after it in
 * the Jev block executes — not the eligibility query, not the cost
 * estimate, not the "--- Jev ---" header. The tests below run against a
 * freshly migrated, empty database (0 eligible managers), which makes every
 * case deterministic and never reaches a real `evaluate()` call regardless
 * of guard outcome or whatever AI_GATEWAY_API_KEY happens to be set to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAID_RUN_OPT_IN } from '../scripts/paid-run-optin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBJECT = path.join(ROOT, 'scripts/build-manager-archetypes.mjs');

// A real, freshly migrated, empty database — not a poisoned path. This
// script's stage 1/2 measurement runs on every invocation regardless of
// --jev, so a path that fails to open would fail every test case alike and
// prove nothing about the guard specifically. An empty DB instead makes
// "0 eligible managers" true everywhere, which is what keeps every case
// below safe: the Jev loop body (the only place that calls the gateway)
// never executes, whatever AI_GATEWAY_API_KEY is set to.
const TEMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-archetypes-paidrun-')), 'test.sqlite');

test.before(async () => {
  process.env.GRIDIRON_DB_PATH = TEMP_DB;
  const { runMigrations } = await import('../server/db/migrate.js');
  await runMigrations();
});

function run(args, envOverrides) {
  const env = { ...process.env, GRIDIRON_DB_PATH: TEMP_DB, ...envOverrides };
  return spawnSync(process.execPath, [SUBJECT, ...args, '--json'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 30_000
  });
}

test('--jev, no --dry-run, no opt-in: refuses with one line, before any Jev-specific work runs', () => {
  const env = {};
  delete env[PAID_RUN_OPT_IN];
  const child = run(['--jev'], env);

  assert.equal(child.status, 1, `expected exit 1, got ${child.status}\n${child.stderr}`);
  assert.match(child.stderr, new RegExp(PAID_RUN_OPT_IN));
  assert.match(child.stderr, /billed/i);
  assert.equal(child.stderr.trim().split('\n').length, 1, child.stderr);
  // Nothing from the Jev block ran: no estimate header, no manager count.
  assert.doesNotMatch(child.stdout, /--- Jev ---/);
});

test('--jev --dry-run, no opt-in: the guard does not fire, the existing no-cost preview still works', () => {
  const env = {};
  delete env[PAID_RUN_OPT_IN];
  const child = run(['--jev', '--dry-run'], env);

  assert.equal(child.status, 0, `expected exit 0, got ${child.status}\n${child.stderr}`);
  assert.doesNotMatch(child.stderr, new RegExp(PAID_RUN_OPT_IN),
    `--dry-run should never see the opt-in refusal:\n${child.stderr}`);
  assert.match(child.stdout, /--- Jev ---/);
  assert.match(child.stdout, /dry run/i);
});

test('--jev, opt-in set, no --dry-run: the guard does not fire, the run proceeds past it', () => {
  // This intentionally does NOT assert exit 0. Under the suite's own
  // test/offline-guard.mjs (loaded via NODE_OPTIONS for every npm test /
  // npm run check invocation, inherited here since it spawns a child), the
  // AI_GATEWAY_API_KEY set below is deliberately deleted at import time —
  // the same credential hygiene that strips every provider key from the
  // test environment, so a key present on the box can never leak into a
  // test run. That makes the placeholder key ineffective in that context,
  // and the script correctly refuses at ITS OWN pre-existing
  // AI_GATEWAY_API_KEY check a few lines after where this guard sits — a
  // real, different, already-existing gate, not this one. Run standalone
  // (no offline-guard), the placeholder key is honored and the script
  // completes. Both are correct; what must hold in either case is that the
  // opt-in guard itself is never the thing that stopped it, and that
  // execution got at least as far as the Jev block's own output.
  const env = { [PAID_RUN_OPT_IN]: '1', AI_GATEWAY_API_KEY: 'test-placeholder-not-a-real-key' };
  const child = run(['--jev'], env);

  assert.doesNotMatch(child.stderr, new RegExp(PAID_RUN_OPT_IN),
    `an accepted opt-in should never print its own refusal:\n${child.stderr}`);
  assert.match(child.stdout, /--- Jev ---/,
    `expected the run to reach the Jev block's own output:\n${child.stdout}\n${child.stderr}`);
});

test('no --jev at all: unaffected, opt-in never required for the default measure-only path', () => {
  const env = {};
  delete env[PAID_RUN_OPT_IN];
  const child = run([], env);

  assert.equal(child.status, 0, `expected exit 0, got ${child.status}\n${child.stderr}`);
  assert.doesNotMatch(child.stderr, new RegExp(PAID_RUN_OPT_IN));
  assert.doesNotMatch(child.stdout, /--- Jev ---/);
});
