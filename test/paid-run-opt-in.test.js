/**
 * `scripts/run-news-event-impact.mjs` spends money the moment it is invoked.
 * Its own header says so: "it makes real, billed calls to the Anthropic API
 * (Haiku 4.5 ... a batch of `--limit` stories runs a handful of cents)". The
 * default command is `impact`, so `node scripts/run-news-event-impact.mjs`
 * with no arguments at all is a valid invocation, and `npm run
 * news:event-impact` is one keystroke away from an `extract` that bills.
 *
 * Nothing stands between a mistyped command and that bill. There is no
 * confirmation, no dry-run default, and no environment opt-in — the script
 * runs migrations and then calls the API.
 *
 * The standing R&D rule is NOTHING PAID, EVER. A script that can only be run
 * deliberately does not violate it; a script that can be run by accident does.
 * So the refusal has to be the default, and the opt-in has to be explicit.
 *
 * TWO PROPERTIES, and the second is the one that is easy to get wrong.
 *
 * 1. Absent the opt-in, the script exits non-zero with a one-line reason, and
 *    it does so BEFORE it touches the database or imports the services that
 *    hold the API client.
 *
 * 2. The guard reads the opt-in variable's PRESENCE and nothing else. This
 *    project has had three key-exposure incidents. A guard that echoed the
 *    value it read — into a log, an error message, or a test assertion —
 *    would be a fourth, and the opt-in sits in the same environment as the
 *    keys. Presence is all the guard is entitled to know.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAID_RUN_OPT_IN, paidRunOptIn } from '../scripts/paid-run-optin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBJECT = path.join(ROOT, 'scripts/run-news-event-impact.mjs');

test('an unset opt-in is a refusal, and the reason names the variable', () => {
  const verdict = paidRunOptIn({}, 'SOME_OPT_IN');
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /SOME_OPT_IN/);
  assert.match(verdict.reason, /billed/i);
});

test('an empty or whitespace opt-in is not an opt-in', () => {
  assert.equal(paidRunOptIn({ SOME_OPT_IN: '' }, 'SOME_OPT_IN').allowed, false);
  assert.equal(paidRunOptIn({ SOME_OPT_IN: '   ' }, 'SOME_OPT_IN').allowed, false);
});

test('a set opt-in allows the run, whatever it is set to', () => {
  assert.equal(paidRunOptIn({ SOME_OPT_IN: '1' }, 'SOME_OPT_IN').allowed, true);
  assert.equal(paidRunOptIn({ SOME_OPT_IN: 'yes' }, 'SOME_OPT_IN').allowed, true);
});

test('the verdict never carries the value it read', () => {
  const secret = 'sk-ant-do-not-echo-me';
  const verdict = paidRunOptIn({ SOME_OPT_IN: secret }, 'SOME_OPT_IN');
  assert.equal(JSON.stringify(verdict).includes(secret), false);
  assert.equal(JSON.stringify(verdict).includes('do-not-echo-me'), false);
});

test('the script refuses to run without the opt-in, before it reaches the database', () => {
  const env = { ...process.env };
  delete env[PAID_RUN_OPT_IN];

  const child = spawnSync(process.execPath, [SUBJECT, 'impact'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 30_000
  });

  assert.equal(child.status, 1, `expected exit 1, got ${child.status}\n${child.stderr}`);
  assert.match(child.stderr, new RegExp(PAID_RUN_OPT_IN));
  assert.match(child.stderr, /billed/i);
  // The refusal is one line, not a stack trace.
  assert.equal(child.stderr.trim().split('\n').length, 1, child.stderr);
  // Nothing was produced on stdout: the run did not begin.
  assert.equal(child.stdout, '');
});
