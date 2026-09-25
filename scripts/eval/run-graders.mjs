#!/usr/bin/env node
/**
 * EVAL-01: run the E1-E7 graders (and C8, REASON-02) and store one run in `brain_report`.
 *
 * Run by the refresh loop (scripts/refresh-live-data.mjs, step `brain_report`),
 * never on the web request thread. Reads the app database the loop points at
 * (GRIDIRON_DB_PATH), runs migrations first so 078 exists, writes one run,
 * prints one summary line:
 *
 *   brain_report: 1 passing, 8 not_enough_data, 0 failing (run <id>)
 *
 * Before the graders, with reasoning grading on (preview mode), one
 * `reasoning_claims:` line: REASON-02 claims recorded and settled for C8.
 *
 * Then one `living_gate:` line: the LIVING-01b re-gate's forward sim predictions
 * recorded this tick (eval/living-gate-record.js), or what they wait on.
 *
 * Exit 1 when any grader threw (its row is still written, as a grader_error)
 * or the reasoning-claims step failed (the graders still run). A grader_error row
 * is what the fallback rule treats as blocking. Importing this file runs nothing.
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
  // REASON-02: C8 grades stored reasoning claims, so record this tick's panels
  // and settle open claims first. Behind preview mode; off, it logs nothing.
  // A failure is logged and fails the run, and the graders still run.
  const { refreshReasoningClaims } = await import('../../server/services/reasoning/grading.js');
  let reasoningOk = true;
  try {
    const rc = refreshReasoningClaims(db, { now });
    if (rc.error) { reasoningOk = false; log(`reasoning_claims: ERROR ${rc.error}`); }
    else if (rc.enabled) {
      const settled = (rc.resolved?.true ?? 0) + (rc.resolved?.false ?? 0) + (rc.resolved?.void ?? 0);
      log(`reasoning_claims: ${rc.recorded?.inserted ?? 0} recorded, ${settled} settled, `
        + `${rc.resolved?.open ?? 0} open${rc.notes.length ? ` (${rc.notes.join('; ')})` : ''}`);
    }
  } catch (e) {
    reasoningOk = false;
    log(`reasoning_claims: ERROR ${String(e?.message ?? e).slice(0, 300)}`);
  }
  // LIVING-01b re-gate: record next week's paired sim predictions before the
  // graders, and hand the grader its optional models. Each waits, and says so,
  // until its unit (ACTIVITY-01 #334, LIVING-01b #261) is on this build. A failure
  // is logged and fails the run; the graders still run.
  let livingOk = true;
  let gateOpts = {};
  try {
    const { resolveGateModels, recordSimPredictions } = await import('../../server/services/eval/living-gate-record.js');
    const models = await resolveGateModels();
    gateOpts = { intensityFor: models.intensityFor };
    const rec = await recordSimPredictions(db, { predict: models.predict, now });
    for (const e of rec.errors) { livingOk = false; log(`living_gate: ERROR league ${e.league_id} ${e.message}`); }
    log(`living_gate: ${rec.state === 'waiting' ? `sim waiting (${rec.reason})` : `${rec.written} sim predictions recorded`}; `
      + `activity model ${models.intensityFor ? 'present' : 'waiting (ACTIVITY-01, #334, not on this build)'}`);
  } catch (e) {
    livingOk = false;
    log(`living_gate: ERROR ${String(e?.message ?? e).slice(0, 300)}`);
  }
  const { runAll, writeReport } = await import('../../server/services/eval/index.js');
  const { results, errors } = runAll(db, { 'L01B-GATE': gateOpts });
  const stored = writeReport(db, results, { now });
  const count = s => results.filter(r => r.status === s).length;
  for (const e of errors) log(`brain_report: ERROR ${e.check} ${e.message}`);
  log(`brain_report: ${count('passing')} passing, ${count('not_enough_data')} not_enough_data, `
    + `${count('failing')} failing (run ${stored.run_id})`);
  return { ok: errors.length === 0 && reasoningOk && livingOk, stored };
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) {
  const { ok } = await main();
  process.exit(ok ? 0 : 1);
}
