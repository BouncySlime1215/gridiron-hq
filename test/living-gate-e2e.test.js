/**
 * LIVING-01b re-gate (#401 review finding 1): the END-TO-END path that broke on
 * 9/24, committed. Graders -> brain_report store -> War Room producer ->
 * validatePlans, on a real migrated (empty) database and the made-up four-team
 * league (test/fixtures/campaign-league.mjs). No real league data.
 *
 *  - shadow_only rows (L01B-ACT / -SIM / -GATE as graded): the plans file
 *    validates and the War Room brain_report section holds E1..C8 only.
 *  - the same stored rows forced to shadow_only=false: they reach the section and
 *    the file STILL validates (BRAIN_CHECK_IDS carries the L01B ids on its own).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-living-e2e-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_E4_REPLAY_JSON = path.join(temp, 'no-such-replay.json');

const { db } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { runAll, writeReport } = await import('../server/services/eval/index.js');
const { CHECK, ACT_CHECK, SIM_CHECK } = await import('../server/services/eval/living-gate.js');
const { readBrainReport, applyBrainReport } = await import('../server/services/campaign/brain-gate.js');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const L01B = [ACT_CHECK, SIM_CHECK, CHECK];
const database = db.db ?? db;

async function produce() {
  const read = readBrainReport(database);
  assert.equal(read.error, null);
  const brain = { read, applyBrainReport, numberHealth: () => null };
  const file = await buildPlansFile([{ id: 1, load: async () => ({ adapter: makeAdapter() }) }],
    { generated_at: new Date().toISOString(), brain });
  return { read, file };
}

test('graders -> store -> producer -> validatePlans: shadow-only L01B rows stay out of the War Room', async () => {
  const { results } = runAll(database);
  const ids = results.map(r => r.check);
  for (const id of L01B) assert.ok(ids.includes(id), `graders wrote ${id}`);
  for (const r of results.filter(r => L01B.includes(r.check))) assert.equal(r.detail?.shadow_only, true, r.check);
  writeReport(database, results);

  const { read, file } = await produce();
  assert.ok(read.report.checks.some(c => L01B.includes(c.check)), 'the stored run holds the L01B rows');
  assert.deepEqual(validatePlans(file).errors, []);
  const section = file.leagues[0].brain_report;
  assert.equal(section.status, 'ok');
  const shown = section.value.checks.map(c => c.id);
  assert.ok(shown.length > 0, 'the section is not empty');
  for (const id of L01B) assert.equal(shown.includes(id), false, `${id} is shadow-only`);
});

test('the same stored rows with shadow_only=false reach the section and the file still validates', async () => {
  const run = database.prepare('SELECT run_id FROM brain_report ORDER BY id DESC LIMIT 1').get().run_id;
  const rows = database.prepare('SELECT id, detail_json FROM brain_report WHERE run_id = ? AND check_id IN (?, ?, ?)')
    .all(run, ...L01B);
  assert.equal(rows.length >= 3, true);
  const upd = database.prepare('UPDATE brain_report SET detail_json = ? WHERE id = ?');
  for (const r of rows) upd.run(JSON.stringify({ ...JSON.parse(r.detail_json), shadow_only: false }), r.id);

  const { file } = await produce();
  assert.deepEqual(validatePlans(file).errors, [], 'the contract enum holds the L01B ids on its own');
  const shown = file.leagues[0].brain_report.value.checks.map(c => c.id);
  for (const id of L01B) assert.ok(shown.includes(id), `${id} shown once not shadow-only`);
});
