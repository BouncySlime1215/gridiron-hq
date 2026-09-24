#!/usr/bin/env node
/**
 * E3-ESPN: replay the season sim as of week 7 on each past ESPN league-season
 * (server/services/eval/e3-espn.js) and store the row in `brain_report`.
 *
 * Runs on a COPY of the app database, never the live file:
 *
 *   sqlite3 ~/gridiron-local/data.sqlite ".backup '.local-db/data.sqlite'"
 *   SCHEDULER_DISABLED=1 node scripts/eval/e3-espn-replay.mjs --db .local-db/data.sqlite [--write] [--json out.json]
 *
 * Prints aggregates only (no league, team or manager names). With --write it
 * stores one brain_report run holding every E1-E7 grader row plus E3-ESPN, so
 * the latest run stays a complete report card. Reads no credentials: leagues
 * are selected as (id, platform, payload) only.
 *
 * Importing this file runs nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export const LIVE_DB = path.join(os.homedir(), 'gridiron-local', 'data.sqlite');

export function parseArgs(argv) {
  const out = { db: null, write: false, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db') out.db = argv[++i];
    else if (argv[i] === '--write') out.write = true;
    else if (argv[i] === '--json') out.json = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out.db) throw new Error('--db <copy of the app database> is required');
  if (path.resolve(out.db) === path.resolve(LIVE_DB)) throw new Error('refusing the live database; pass a .backup copy');
  return out;
}

export async function main(argv = process.argv.slice(2), { log = console.log, now = new Date() } = {}) {
  const args = parseArgs(argv);
  process.env.SCHEDULER_DISABLED = '1';
  process.env.GRIDIRON_DB_PATH = path.resolve(args.db);
  const { db } = await import('../../server/db/index.js');
  const e3espn = await import('../../server/services/eval/e3-espn.js');
  const row = e3espn.run(db);
  const d = row.detail;
  log(`E3-ESPN: ${d.n_league_seasons ?? 0} league-seasons, ${row.n} team-seasons (${d.low_power})`);
  for (const t of ['playoffs', 'title']) {
    const x = d[t];
    if (!x) continue;
    log(`  ${t}: Brier sim ${x.brier_sim} vs standings-only ${x.brier_base}; gain ${x.brier_gain} `
      + `CI ${JSON.stringify(x.brier_gain_ci)}; slope ${x.slope} CI ${JSON.stringify(x.slope_ci)}; base rate ${x.base_rate}`);
  }
  log(`  sanity: ${d.sanity ?? 'n/a'}; ${d.slope_flag ?? ''}; format-consistent league-seasons: ${d.format_consistent_league_seasons ?? 0}; excluded ${JSON.stringify(d.excluded)}`);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(row, null, 1));
  if (args.write) {
    const { runAll, writeReport } = await import('../../server/services/eval/index.js');
    const { results } = runAll(db);
    const stored = writeReport(db, [...results.filter(r => r.check !== e3espn.CHECK), row], { now });
    log(`  brain_report: wrote run ${stored.run_id} (${stored.rows} rows, E3-ESPN included)`);
  }
  return row;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) await main();
