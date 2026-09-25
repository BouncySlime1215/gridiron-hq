#!/usr/bin/env node
/**
 * E-XGB exploratory: fetch ESPN's weekly PPR projections for PAST weeks, as ESPN serves
 * them TODAY, into a local JSON file for scripts/eval/exgb_models.py.
 *
 * RETROSPECTIVE, NOT FROZEN. These numbers are fetched after the games, exactly like the
 * Princeton thesis's ESPN baseline, so nothing proves they equal what ESPN showed before
 * kickoff. They may only be used for exploratory comparisons labelled that way; the
 * confirmatory test (docs/tdd/EXGB-PREREG.md) uses espn_weekly_projection_snapshots only.
 *
 * Writes no database. Public PPR defaults endpoint, no cookie.
 *
 * Usage:
 *   node scripts/eval/exgb-espn-retro.mjs --season 2025 --weeks 1-18 --out <file.json>
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BROWSER_HEADERS } from '../../server/services/espn-draft.js';
import { buildProjectionFilter, parseProjectionPayload, projectionUrl }
  from '../../server/services/espn-weekly-projection-capture.js';

export function parseArgs(argv) {
  const out = { season: null, weeks: [], out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--season') out.season = Number(argv[++i]);
    else if (a === '--weeks') {
      const [lo, hi] = String(argv[++i]).split('-').map(Number);
      for (let w = lo; w <= (hi ?? lo); w += 1) out.weeks.push(w);
    } else if (a === '--out') out.out = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!(out.season > 0) || !out.weeks.length || !out.out) throw new Error('--season, --weeks and --out are required');
  return out;
}

export async function main(argv = process.argv.slice(2), { log = console.log, fetchImpl = globalThis.fetch } = {}) {
  const args = parseArgs(argv);
  const rows = [];
  for (const week of args.weeks) {
    const filter = buildProjectionFilter(args.season, week);
    const resp = await fetchImpl(projectionUrl({ season: args.season, week }),
      { headers: { ...BROWSER_HEADERS, 'x-fantasy-filter': JSON.stringify(filter) }, signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new Error(`ESPN kona_player_info ${resp.status} for week ${week}`);
    const parsed = parseProjectionPayload(await resp.json(), { season: args.season, week });
    for (const r of parsed) rows.push({ season: args.season, week, ...r });
    log(`week ${week}: ${parsed.length} projections`);
  }
  fs.writeFileSync(args.out, JSON.stringify({ label: 'RETROSPECTIVE, not frozen', fetched_at: new Date().toISOString(),
    season: args.season, rows }));
  log(`wrote ${rows.length} rows to ${args.out}`);
  return 0;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) process.exit(await main());
