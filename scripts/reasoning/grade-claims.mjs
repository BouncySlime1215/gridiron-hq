#!/usr/bin/env node
/**
 * REASON-02: store the reasoning panels' claims as predictions, settle the ones
 * whose evidence has arrived, and print the C8 grade (share that came true).
 * Offline, after scripts/reasoning/run.mjs; never on a web request. No paid
 * calls. Runs migrations first so 089 exists on the database it is pointed at
 * (GRIDIRON_DB_PATH).
 *
 *   node scripts/reasoning/grade-claims.mjs [--plans <plans.json>] [--panels <panels.json>] [--league <id>]
 *
 * Defaults: --plans is warroom-flag.js#warRoomPlansPath(), --panels the
 * panels.json next to it (plan-reasoning.js#panelsCachePath).
 *
 * Behind preview mode (server/services/preview-mode.js): off, it writes
 * nothing and says so. A missing plans or panels file skips recording (and
 * says so); settling and grading still run over what is already stored.
 * Prints one JSON line. Importing this file runs nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
}

function readJson(file, label, notes) {
  if (!fs.existsSync(file)) { notes.push(`no ${label} file at ${file}; recording skipped`); return null; }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function main({ argv = process.argv, now = new Date(), log = console.log } = {}) {
  // FIX-08: the plans file is the War Room contract file, and panels.json is
  // the reuse cache the producer keeps next to it.
  const { warRoomPlansPath } = await import('../../server/services/warroom-flag.js');
  const plansPath = arg(argv, '--plans', warRoomPlansPath());
  // Same path as plan-reasoning.js#panelsCachePath, without importing the paid
  // producer (produce.js -> claude.js) into an offline grading command.
  const panelsPath = arg(argv, '--panels', path.join(path.dirname(path.resolve(plansPath)), 'panels.json'));
  const leagueId = arg(argv, '--league') == null ? null : Number(arg(argv, '--league'));

  const { db } = await import('../../server/db/index.js');
  const { runMigrations } = await import('../../server/db/migrate.js');
  await runMigrations();
  const { recordClaims } = await import('../../server/services/reasoning/claims.js');
  const { resolveOpenClaims } = await import('../../server/services/reasoning/resolve.js');
  const c8 = await import('../../server/services/reasoning/grade.js');

  if (!c8.reasoningGradingEnabled()) {
    log(JSON.stringify({ reasoning_grading: 'off', reason: c8.PREVIEW_REASON, report: c8.run(db, { leagueId }) }));
    return { ok: true };
  }
  const notes = [];
  const plans = readJson(plansPath, 'plans', notes);
  const panels = plans ? readJson(panelsPath, 'panels', notes) : null;
  const recorded = plans && panels ? recordClaims(db, { plans, panels, now, leagueId }) : null;
  const resolved = resolveOpenClaims(db, { now, leagueId });
  const stored = db.prepare(`SELECT kind, status, COUNT(*) n FROM reasoning_claims
    WHERE (? IS NULL OR league_id = ?) GROUP BY kind, status ORDER BY kind, status`).all(leagueId, leagueId);
  log(JSON.stringify({
    reasoning_grading: 'on', preview: true, league_id: leagueId, notes, recorded, resolved, stored,
    report: c8.run(db, { leagueId })
  }));
  return { ok: true };
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href;
  } catch (e) {
    if (e?.code === 'ENOENT') return false;
    throw e;
  }
})();
if (invokedDirectly) {
  const { ok } = await main();
  process.exit(ok ? 0 : 1);
}
