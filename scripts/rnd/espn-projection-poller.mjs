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
 *   {ts, source_fetched_at, league, player_id, projected_points, injury_status}
 * `ts` is the poll time; `source_fetched_at` is leagues.fetched_at, when the payload was
 * actually pulled from ESPN (writer: server/routes/leagues.js syncEspnLeague, on the
 * hourly `league_rosters` job, scheduler.js:1253). The payload does not change between
 * syncs, so timing resolution is the sync cadence (<= 60 min), NOT the 10-minute poll;
 * the 10-minute poll only guarantees every hourly payload is captured before the next
 * sync overwrites it. The analysis times flips by `source_fetched_at`.
 *
 * Why not league_roster_snapshots.changed_at: that row is updated in place and
 * changed_at moves on ANY tracked change (incl. actual_points during the game), so the
 * time of the first flip is overwritten; this JSONL keeps every sync's reading.
 * `projected_points` uses the shared periodPoints (scripts/lib/espn-period-points.mjs),
 * the same reader and round2 contract as league_roster_snapshots.projected_points.
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
import { pathToFileURL } from 'node:url';
import { periodPoints } from '../lib/espn-period-points.mjs';

export const DEFAULT_OUT_DIR = path.join(
  process.env.HOME ?? '', 'gridiron-local/rnd/loop/data/espn-flip-timing');

/** leagues.fetched_at is SQLite datetime('now') text, UTC with no zone: 'YYYY-MM-DD HH:MM:SS'. */
export function fetchedAtIso(t) {
  if (!t) return null;
  const s = String(t);
  const ms = Date.parse(s.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * One row per rostered player (starter or bench — the timing question does not
 * care which) in one league's stored ESPN payload, for the payload's own current
 * scoring period.
 */
export function rowsFromPayload(payload, { league, ts, sourceFetchedAt = null }) {
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
        source_fetched_at: sourceFetchedAt,
        league,
        player_id: playerId,
        projected_points: periodPoints(pl.stats, season, period, 1),
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
    try {
      payload = JSON.parse(lg.payload);
    } catch (err) {
      console.error(`espn-projection-poller: league ${lg.id} payload is not JSON, skipped (${err.message})`);
      continue;
    }
    out.push(...rowsFromPayload(payload, { league: lg.id, ts, sourceFetchedAt: fetchedAtIso(lg.fetched_at) }));
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
  const leagues = rows(`SELECT id, payload, fetched_at FROM leagues WHERE platform = ?`, 'espn');
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
