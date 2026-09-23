/**
 * `scripts/build-negotiation-profiles.mjs` bills the Anthropic API by default,
 * the same shape of defect `scripts/run-news-event-impact.mjs` had
 * (docs/tdd/paid-run-opt-in.tdd.md): it imports `server/services/claude.js`
 * and calls `callClaude` at two sites, and its only cost-related flag,
 * `--dry-run`, is an OPT-OUT — a plain invocation with no flags is a valid,
 * billed one. The standing R&D rule is NOTHING PAID, EVER, so this applies
 * the same `scripts/paid-run-optin.mjs` guard here.
 *
 * ONE DIFFERENCE FROM THE FIRST APPLICATION: this script already has a
 * legitimate no-cost mode, `--dry-run`, which prints what it would send
 * instead of calling the API. That mode must keep working WITHOUT the
 * opt-in — a guard that also blocked `--dry-run` would make the one flag
 * that exists specifically to avoid spending unusable without first opting
 * into spending, which defeats its purpose.
 *
 * So there are two properties to prove, not one:
 *
 * 1. Without `--dry-run` and without the opt-in, the script refuses before
 *    it opens any database — same ordering discipline as the first
 *    application, and the same reason it matters: a guard placed after a
 *    database module loads has already done the thing it claims to prevent.
 * 2. With `--dry-run`, the guard does not fire even though the opt-in is
 *    unset — proven here by pointing the chat database this script opens
 *    (`data/derived/league_chat.sqlite`, overridable via
 *    `GRIDIRON_CHAT_DB_PATH` — the same variable name
 *    `server/services/manager-signals.js:85` already uses for the identical
 *    path) at a path whose parent is a file. If the guard's refusal fired,
 *    the process would exit 1 with the one clean refusal line and nothing
 *    else would run. If the guard was skipped as `--dry-run` requires, the
 *    process instead reaches `new DatabaseSync(...)` on the poisoned path
 *    and crashes there instead — a different, longer failure that proves
 *    the run got past the guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAID_RUN_OPT_IN } from '../scripts/paid-run-optin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBJECT = path.join(ROOT, 'scripts/build-negotiation-profiles.mjs');
// A file, not a directory, as the parent — DatabaseSync (or any mkdir before
// it) fails on this regardless of who is running, including root, the same
// discriminating path shape docs/tdd/paid-run-opt-in.tdd.md's own test uses
// for the equivalent reason.
const POISONED_CHAT_DB = path.join(ROOT, 'package.json/league_chat.sqlite');

function run(args, env) {
  return spawnSync(process.execPath, [SUBJECT, ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 30_000
  });
}

test('no opt-in, no --dry-run: refuses with one line, before the chat database opens', () => {
  const env = { ...process.env, GRIDIRON_CHAT_DB_PATH: POISONED_CHAT_DB };
  delete env[PAID_RUN_OPT_IN];

  const child = run([], env);

  assert.equal(child.status, 1, `expected exit 1, got ${child.status}\n${child.stderr}`);
  assert.match(child.stderr, new RegExp(PAID_RUN_OPT_IN));
  assert.match(child.stderr, /billed/i);
  assert.equal(child.stderr.trim().split('\n').length, 1, child.stderr);
  assert.equal(child.stdout, '');
});

test('no opt-in, --dry-run: the opt-in guard does not fire, and the run reaches the database', () => {
  const env = { ...process.env, GRIDIRON_CHAT_DB_PATH: POISONED_CHAT_DB };
  delete env[PAID_RUN_OPT_IN];

  const child = run(['--dry-run'], env);

  assert.notEqual(child.status, 0, 'the poisoned chat DB path should still fail the run');
  assert.doesNotMatch(child.stderr, new RegExp(PAID_RUN_OPT_IN),
    `--dry-run should never see the opt-in refusal:\n${child.stderr}`);
  // The real failure is the poisoned path being read past the guard, not a
  // one-line refusal — proof the DatabaseSync call, not assertPaidRunOptIn,
  // is what stopped this run.
  assert.ok(child.stderr.trim().split('\n').length > 1 || /ENOTDIR|ENOENT/.test(child.stderr),
    `expected a database-open failure, not a clean refusal:\n${child.stderr}`);
});

test('opt-in set, no --dry-run: the opt-in guard does not fire either', () => {
  const env = { ...process.env, GRIDIRON_CHAT_DB_PATH: POISONED_CHAT_DB, [PAID_RUN_OPT_IN]: '1' };

  const child = run([], env);

  assert.notEqual(child.status, 0, 'the poisoned chat DB path should still fail the run');
  assert.doesNotMatch(child.stderr, new RegExp(PAID_RUN_OPT_IN),
    `an accepted opt-in should never print its own refusal:\n${child.stderr}`);
  assert.ok(child.stderr.trim().split('\n').length > 1 || /ENOTDIR|ENOENT/.test(child.stderr),
    `expected a database-open failure, not a clean refusal:\n${child.stderr}`);
});
