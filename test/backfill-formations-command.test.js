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
 *
 * They also pin what it does once it runs, which is what the evidence file and
 * the runbook promise: it asks nflverse for exactly the season named, stores
 * that season's rows, exits 0; and on any download error (a 404 included) it
 * writes nothing and exits 1, so a person or a script running it sees the
 * failure. The command is spawned for real against a migrated temp database,
 * with fetch replaced by a stub preloaded through `node --import`, so nothing
 * reaches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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

// ---- What the command does once its guards pass ---------------------------

// Replaces fetch before the command's first line runs. It logs every URL asked
// for and answers with the status (and, for 200, the CSV file) the test names.
const STUB = `import fs from 'node:fs';
const status = Number(process.env.BACKFILL_STUB_STATUS);
globalThis.fetch = async url => {
  fs.appendFileSync(process.env.BACKFILL_STUB_LOG, String(url) + '\\n');
  if (status !== 200) return { ok: false, status, text: async () => 'Not Found', body: null };
  const text = fs.readFileSync(process.env.BACKFILL_STUB_CSV, 'utf8');
  return { ok: true, status: 200, text: async () => text, body: null };
};
`;
// The columns ingestFormations reads (nfl-formations.js), three plays.
const CSV = [
  'nflverse_game_id,play_id,possession_team,offense_formation,offense_personnel,defense_personnel,'
    + 'defenders_in_box,number_of_pass_rushers,time_to_throw,was_pressure,defense_man_zone_type,defense_coverage_type',
  '2025_01_KC_LAC,40,KC,SHOTGUN,"1 RB, 1 TE, 3 WR","4 DL, 2 LB, 5 DB",6,4,2.6,FALSE,ZONE_COVERAGE,COVER_3',
  '2025_01_KC_LAC,61,KC,SINGLEBACK,"1 RB, 2 TE, 2 WR","4 DL, 3 LB, 4 DB",7,,,FALSE,,',
  '2025_01_KC_LAC,85,LAC,EMPTY,"0 RB, 1 TE, 4 WR","4 DL, 1 LB, 6 DB",5,5,2.1,TRUE,MAN_COVERAGE,COVER_1',
].join('\n') + '\n';

function stubbedRun(season, status) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-backfill-run-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  const stub = path.join(dir, 'fetch-stub.mjs');
  const csv = path.join(dir, 'participation.csv');
  const log = path.join(dir, 'fetch.log');
  fs.writeFileSync(stub, STUB);
  fs.writeFileSync(csv, CSV);
  fs.writeFileSync(log, '');
  // The command loads into a database the server has already migrated; build
  // one the same way before it runs.
  const migrated = spawnSync(process.execPath, ['--input-type=module', '-e',
    "await (await import('./server/db/migrate.js')).runMigrations();"], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, GRIDIRON_DB_PATH: dbPath, SCHEDULER_DISABLED: '1' } });
  assert.equal(migrated.status, 0, `fixture migration failed: ${migrated.stderr}`);
  const clean = { ...process.env };
  delete clean.GRIDIRON_DB_PATH;
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, SCRIPT, String(season)], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...clean, SCHEDULER_DISABLED: '1', GRIDIRON_DB_PATH: dbPath,
      BACKFILL_STUB_STATUS: String(status), BACKFILL_STUB_CSV: csv, BACKFILL_STUB_LOG: log } });
  const database = new DatabaseSync(dbPath, { readOnly: true });
  const bySeason = Object.fromEntries(database.prepare(
    'SELECT season, COUNT(*) n FROM nfl_play_formations GROUP BY season').all().map(r => [r.season, r.n]));
  database.close();
  const requested = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(url => url.split('/').pop());
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, bySeason, requested };
}

test('a published season: asks for exactly that file, stores its rows, exits 0', () => {
  const run = stubbedRun(2025, 200);
  assert.equal(run.status, 0, `exit ${run.status}; stderr: ${run.stderr}`);
  assert.deepEqual(run.requested, ['pbp_participation_2025.csv'], 'one download, for the season named');
  assert.deepEqual(run.bySeason, { 2025: 3 }, 'the three plays land under 2025 and nowhere else');
  assert.match(run.stdout, /"plays_stored": 3/);
  assert.match(run.stdout, /FTN Data via nflverse/, 'the attribution the licence requires is printed');
});

test('a 404 writes nothing and exits 1, so the failure is seen', () => {
  const run = stubbedRun(2025, 404);
  assert.equal(run.status, 1, `a missing file is a failed backfill; exit ${run.status}; stderr: ${run.stderr}`);
  assert.deepEqual(run.requested, ['pbp_participation_2025.csv']);
  assert.deepEqual(run.bySeason, {}, 'no rows written');
  assert.match(run.stderr, /failed: participation for 2025 returned 404/);
});

test('any other download error exits 1 too', () => {
  const run = stubbedRun(2025, 503);
  assert.equal(run.status, 1, `exit ${run.status}; stderr: ${run.stderr}`);
  assert.deepEqual(run.bySeason, {});
  assert.match(run.stderr, /returned 503/);
});
