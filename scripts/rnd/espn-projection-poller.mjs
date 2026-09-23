#!/usr/bin/env node
/**
 * R&D poller for RL-10-2 (rnd/loop/r10-external-espn-zero-is-the-inactive-feed.md
 * section 6, the W4/W5 zero-flip timing test).
 *
 * This is research tooling, not app code: it does NOT call ESPN itself. It reads
 * `leagues.payload`, the JSON the existing hourly ESPN league sync already wrote
 * (server/services/league-sync path used by scripts/refresh-live-data.mjs), the
 * same stored payload `scripts/collect-roster-snapshots.mjs`'s live pass already
 * reads (collect-roster-snapshots.mjs:92 `periodPoints`). No new network call, no
 * new external source. It never selects or prints `leagues.espn_s2` / `leagues.swid`.
 *
 * Every run appends one JSONL row per rostered player to
 * <out-dir>/<YYYY-MM-DD>.jsonl:
 *   {ts, league, player_id, projected_points, injury_status}
 * `player_id` is ESPN's id (`playerId`/`playerPoolEntry.player.id`), because the
 * timing question is about ESPN's own feed, before any join to our `players` table.
 *
 * Usage (dry run against a fixture DB):
 *   GRIDIRON_DB_PATH=/path/to/fixture.sqlite \
 *     node scripts/rnd/espn-projection-poller.mjs --out-dir /tmp/espn-flip-timing
 *
 * On Sunday 2026-09-27 (week 3) and 2026-10-04 (week 4), run every 10 minutes
 * across the kickoff windows (documented, not scheduled — see
 * docs/tdd/2026-09-23-espn-flip-timing-poller.tdd.md section "Command to run"):
 *   for i in $(seq 1 6); do
 *     node scripts/rnd/espn-projection-poller.mjs
 *     sleep 600
 *   done
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_OUT_DIR = path.join(
  process.env.HOME ?? '', 'gridiron-local/rnd/loop/data/espn-flip-timing');

/** This period's applied projection from ESPN's stat list (statSourceId 1 = projection). */
function projectedPoints(stats, season, period) {
  const hit = (stats ?? []).find(s => s.seasonId === season && s.scoringPeriodId === period
    && s.statSourceId === 1 && s.statSplitTypeId === 1);
  return hit && Number.isFinite(Number(hit.appliedTotal)) ? Number(hit.appliedTotal) : null;
}

/**
 * One row per rostered player (starter or bench — the timing question does not
 * care which) in one league's stored ESPN payload, for the payload's own current
 * scoring period.
 */
export function rowsFromPayload(payload, { league, ts }) {
  const season = Number(payload?.seasonId);
  const period = Number(payload?.scoringPeriodId);
  const out = [];
  if (!Number.isFinite(season) || !Number.isInteger(period) || period < 1) return out;
  for (const t of payload?.teams ?? []) {
    for (const e of t.roster?.entries ?? []) {
      const ppe = e.playerPoolEntry ?? {};
      const pl = ppe.player ?? {};
      const playerId = Number(e.playerId ?? pl.id ?? ppe.id);
      if (!Number.isFinite(playerId)) continue;
      out.push({
        ts,
        league,
        player_id: playerId,
        projected_points: projectedPoints(pl.stats, season, period),
        injury_status: pl.injuryStatus ?? null,
      });
    }
  }
  return out;
}

/** Rows for every ESPN league that has been synced (payload present), skipping the rest. */
export function collectRows(leagues, ts) {
  const out = [];
  for (const lg of leagues ?? []) {
    if (!lg.payload) continue;
    let payload;
    try { payload = JSON.parse(lg.payload); } catch { continue; }
    out.push(...rowsFromPayload(payload, { league: lg.id, ts }));
  }
  return out;
}

function parseArgs(argv) {
  const args = { outDir: DEFAULT_OUT_DIR, now: new Date().toISOString() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir') args.outDir = argv[++i];
    else if (argv[i] === '--now') args.now = argv[++i];
  }
  return args;
}

/**
 * One poll: read every ESPN league's stored payload (no network) and append its
 * rostered players' projection/status to today's JSONL file. Returns the file
 * written and how many rows were appended.
 */
export async function poll({ outDir = DEFAULT_OUT_DIR, now = new Date().toISOString() } = {}) {
  process.env.SCHEDULER_DISABLED = process.env.SCHEDULER_DISABLED ?? '1';
  const { rows } = await import('../../server/db/index.js');
  // Never select espn_s2 / swid (standing rule 12) — this script makes no network call.
  const leagues = rows(`SELECT id, payload FROM leagues WHERE platform = 'espn'`);
  const out = collectRows(leagues, now);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${now.slice(0, 10)}.jsonl`);
  const text = out.map(r => JSON.stringify(r)).join('\n') + (out.length ? '\n' : '');
  fs.appendFileSync(file, text);
  return { file, count: out.length, leagues: leagues.length };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await poll(args);
  console.log(`espn-projection-poller: wrote ${result.count} rows (${result.leagues} leagues) to ${result.file}`);
  return 0;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) process.exit(await main());
