/**
 * The named backfill for completed participation seasons.
 *
 * The growth cycle only asks nflverse for the season being played, which is
 * never published until its post-season ends, so the scheduled job cannot fill
 * nfl_play_formations (writer: ingestFormations, nfl-formations.js:65). A
 * completed season is a ~50 MB CSV parsed in memory, the size class standing
 * rule 13 keeps off the timer, so completed seasons load through one command,
 * one season per run.
 *
 * These tests pin the command's guards, which run before any import or
 * download: it must refuse to guess a database (the server's default path is a
 * repo-relative file, and the live DB is not something to write by accident),
 * and it must refuse a season that is not one nflverse could have published.
 * The download itself is exercised on a local DB copy in the evidence file, not
 * here, because the test suite must not reach the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'backfill-formations.mjs');

function runCommand(args, env) {
  const clean = { ...process.env };
  delete clean.GRIDIRON_DB_PATH;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: { ...clean, SCHEDULER_DISABLED: '1', ...env } });
}

test('the command exists where the evidence file says it does', () => {
  assert.ok(fs.existsSync(SCRIPT), `${path.relative(ROOT, SCRIPT)} is the documented backfill command`);
});

test('it refuses to run without an explicit database path', () => {
  const result = runCommand(['2025'], {});
  assert.equal(result.status, 2, `exit ${result.status}; stderr: ${result.stderr}`);
  assert.match(result.stderr, /GRIDIRON_DB_PATH/);
});

test('it refuses a season nflverse could not have published', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-backfill-args-'));
  try {
    const env = { GRIDIRON_DB_PATH: path.join(temp, 'never-created.sqlite') };
    for (const bad of [[], ['2015'], ['twenty'], ['2025', '2024'], [String(new Date().getFullYear() + 1)]]) {
      const result = runCommand(bad, env);
      assert.equal(result.status, 2, `args ${JSON.stringify(bad)}: exit ${result.status}; stderr: ${result.stderr}`);
      assert.match(result.stderr, /usage/i, `args ${JSON.stringify(bad)} print the usage line`);
    }
    assert.equal(fs.existsSync(path.join(temp, 'never-created.sqlite')), false,
      'a refused run opens no database');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
