#!/usr/bin/env node
/**
 * EVAL-01: run the E1-E7 graders and store one run in `brain_report`.
 *
 * Run by the refresh loop (scripts/refresh-live-data.mjs, step `brain_report`),
 * never on the web request thread. Reads the app database the loop points at
 * (GRIDIRON_DB_PATH), runs migrations first so 078 exists, writes one run,
 * prints one summary line:
 *
 *   brain_report: 1 passing, 7 not_enough_data, 0 failing (run <id>)
 *
 * Exit 1 when any grader threw (its row is still written, as a grader_error
 * the fallback rule treats as blocking). Importing this file runs nothing.
 *
 * Usage: node --env-file-if-exists=.env scripts/eval/run-graders.mjs
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';

export async function main({ now = new Date(), log = console.log } = {}) {
  const { db } = await import('../../server/db/index.js');
  const { runMigrations } = await import('../../server/db/migrate.js');
  await runMigrations();
  const { runAll, writeReport } = await import('../../server/services/eval/index.js');
  const { results, errors } = runAll(db);
  const stored = writeReport(db, results, { now });
  const count = s => results.filter(r => r.status === s).length;
  for (const e of errors) log(`brain_report: ERROR ${e.check} ${e.message}`);
  log(`brain_report: ${count('passing')} passing, ${count('not_enough_data')} not_enough_data, `
    + `${count('failing')} failing (run ${stored.run_id})`);
  return { ok: errors.length === 0, stored };
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) {
  const { ok } = await main();
  process.exit(ok ? 0 : 1);
}
