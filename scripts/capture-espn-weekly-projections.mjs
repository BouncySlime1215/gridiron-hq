#!/usr/bin/env node
/**
 * E-XGB phase 1: capture ESPN's weekly projections now, into the append-only
 * espn_weekly_projection_snapshots (server/services/espn-weekly-projection-capture.js).
 *
 * The refresh loop runs the same capture on its own schedule (scheduler job
 * espn_weekly_projection_capture). This entry point is for a one-off manual capture or
 * for running the scheduled check outside the loop. Prints counts only; never a cookie.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/capture-espn-weekly-projections.mjs --season 2026 --week 4 [--window manual] [--leagues 4,5]
 *   node --env-file-if-exists=.env scripts/capture-espn-weekly-projections.mjs --scheduled
 * The database is GRIDIRON_DB_PATH (as for every script). Exit 1 when any fetch failed.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';

export function parseArgs(argv) {
  const out = { season: null, week: null, window: 'manual', leagues: undefined, scheduled: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--season') out.season = Number(argv[++i]);
    else if (a === '--week') out.week = Number(argv[++i]);
    else if (a === '--window') out.window = String(argv[++i]);
    else if (a === '--leagues') out.leagues = String(argv[++i]).split(',').map(Number).filter(Number.isFinite);
    else if (a === '--scheduled') out.scheduled = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.scheduled && !(out.season > 0 && out.week > 0)) throw new Error('--season and --week are required (or --scheduled)');
  return out;
}

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const args = parseArgs(argv);
  await (await import('../server/db/migrate.js')).runMigrations();
  const cap = await import('../server/services/espn-weekly-projection-capture.js');
  const r = args.scheduled
    ? await cap.runEspnWeeklyProjectionCapture({ leagueRowIds: args.leagues })
    : await cap.captureWeek({ season: args.season, week: args.week, windowKey: args.window, leagueRowIds: args.leagues });
  for (const c of r.captures ?? []) {
    log(`espn_weekly_projection: ${c.scoring_key} w${c.week} ${c.window_key} ${c.status}`
      + ` rows ${c.rows} late ${c.late}${c.error ? ` (${c.error})` : ''}`);
  }
  log(`espn_weekly_projection_capture: ${JSON.stringify({ ...r, captures: undefined })}`);
  return r.failed ? 1 : 0;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) process.exit(await main());
