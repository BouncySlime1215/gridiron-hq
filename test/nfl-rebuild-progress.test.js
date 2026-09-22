/**
 * nflRebuildProgress had no test at all — two bare `catch {}` blocks around
 * reads of nfl_rebuild_progress/nfl_rebuild_checkpoints (both created only by
 * nfl-2022-2025-rebuild.mjs, on its first run) turned "the script has never
 * been run on this machine" and "something is actually broken" into the same
 * silent empty answer. CLAUDE.md: "if a layer goes inert, the surface must
 * say so" — this pins the fix, same treatment as manager-signals.js's
 * txIndex: a named `*_present: false` for the honest "never run yet" case,
 * and a real read fault now throws instead of vanishing.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rebuild-progress-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { nflRebuildProgress } = await import('../server/services/nfl-rebuild-progress.js');

test('neither table exists yet: both are reported absent, not a swallowed error', () => {
  const result = nflRebuildProgress('some-run-key');
  assert.equal(result.progress_present, false);
  assert.equal(result.checkpoints_present, false);
  assert.deepEqual(result.progress, []);
  assert.deepEqual(result.checkpoints, []);
  assert.equal(result.active, null);
});

test('once the rebuild script has created and populated both tables, real rows come back', () => {
  run(`CREATE TABLE nfl_rebuild_progress (
    run_key TEXT, phase TEXT, current INTEGER, total INTEGER, unit TEXT,
    status TEXT, detail_json TEXT, updated_at TEXT)`);
  run(`CREATE TABLE nfl_rebuild_checkpoints (
    run_key TEXT, phase TEXT, status TEXT, started_at TEXT, finished_at TEXT, error TEXT)`);
  run(`INSERT INTO nfl_rebuild_progress (run_key,phase,current,total,unit,status,detail_json,updated_at)
       VALUES ('run-1','backfill',30,120,'games','running','{"note":"ok"}','2026-09-20T00:00:00Z')`);
  run(`INSERT INTO nfl_rebuild_checkpoints (run_key,phase,status,started_at,finished_at,error)
       VALUES ('run-1','backfill','running','2026-09-20T00:00:00Z',NULL,NULL)`);

  const result = nflRebuildProgress('run-1');
  assert.equal(result.progress_present, true);
  assert.equal(result.checkpoints_present, true);
  assert.equal(result.progress.length, 1);
  assert.equal(result.progress[0].percent, 25);
  assert.deepEqual(result.progress[0].detail, { note: 'ok' });
  assert.equal(result.active.phase, 'backfill');
});

test('a real read fault throws once the table exists, rather than reading as absent', () => {
  // detail_json here is not valid JSON, but that only affects the `parse`
  // helper (which already tolerates bad JSON by design, same as elsewhere in
  // this codebase) — to force an actual query-layer fault, drop a required
  // column so the SELECT itself fails.
  run(`DROP TABLE nfl_rebuild_checkpoints`);
  run(`CREATE TABLE nfl_rebuild_checkpoints (run_key TEXT)`); // missing phase/status/etc columns
  assert.throws(() => nflRebuildProgress('run-1'), /no such column/i);
});
