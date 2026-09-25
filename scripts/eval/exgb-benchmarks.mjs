#!/usr/bin/env node
/**
 * E-XGB: print the weekly grade table (exgb_weekly_grades, latest row per week/position/arm)
 * as Markdown, BENCHMARKS-style. Read-only. Rows before the outcome freeze say provisional.
 *
 *   GRIDIRON_DB_PATH=<db> node scripts/eval/exgb-benchmarks.mjs [--season 2026]
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const i = argv.indexOf('--season');
  const season = i >= 0 ? Number(argv[i + 1]) : 2026;
  const { benchmarksMarkdown } = await import('../../server/services/exgb-grader.js');
  log(benchmarksMarkdown(season));
  return 0;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) process.exit(await main());
