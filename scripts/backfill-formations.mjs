#!/usr/bin/env node
/**
 * Load one completed season of nflverse participation into nfl_play_formations.
 *
 *   GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node scripts/backfill-formations.mjs <season>
 *
 * Why a command and not the timer: the growth cycle asks only for the season
 * being played, which nflverse publishes only after its post-season, so the
 * scheduled job records that 404 as a skip and never fills this table
 * (nfl-model-growth.js, unpublishedSeasonSkip). A completed season is a
 * ~50 MB CSV that ingestFormations parses in memory, the size class standing
 * rule 13 keeps off the production timer. One season per run keeps each
 * download small; the output reports this process's peak memory so the cost is
 * measured where it runs.
 *
 * Writer: ingestFormations, server/services/nfl-formations.js (upsert on
 * game_id + play_id, so a re-run refreshes a season rather than duplicating it).
 *
 * Exit status: 0 stored, 1 the download or ingest failed (including a 404 for a
 * season that is not published), 2 refused before opening any database.
 *
 * Licence: CC BY-SA 4.0. Attribution "FTN Data via nflverse" (2023 onwards) or
 * "NFL NextGenStats via nflverse" (2022 and earlier), per nflreadr's
 * load_participation reference; read 2026-09-22, see
 * docs/tdd/2026-09-22-formations-404-skip.tdd.md.
 */
const USAGE = 'usage: GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node scripts/backfill-formations.mjs <season>'
  + '  (one season, 2016 through the current year)';
const FIRST_PUBLISHED = 2016;

// Guards first, before any import that opens a database. The server's default
// path is a repo-relative file; guessing it is how a backfill lands in the
// wrong database.
if (!process.env.GRIDIRON_DB_PATH) {
  console.error('refused: set GRIDIRON_DB_PATH to the database to load into; this command does not guess one.');
  console.error(USAGE);
  process.exit(2);
}
const args = process.argv.slice(2);
const season = args.length === 1 && /^\d{4}$/.test(args[0]) ? Number(args[0]) : NaN;
if (!Number.isInteger(season) || season < FIRST_PUBLISHED || season > new Date().getFullYear()) {
  console.error(`refused: ${JSON.stringify(args)} is not one season nflverse could have published.`);
  console.error(USAGE);
  process.exit(2);
}
process.env.SCHEDULER_DISABLED = process.env.SCHEDULER_DISABLED || '1';

const { rows } = await import('../server/db/index.js');
const { ingestFormations } = await import('../server/services/nfl-formations.js');
const { TRUSTED_HISTORY_START } = await import('../server/services/nfl-weekly-feature-store.js');

const attribution = season >= 2023 ? 'FTN Data via nflverse' : 'NFL NextGenStats via nflverse';
const countFor = value => Number(rows('SELECT COUNT(*) n FROM nfl_play_formations WHERE season=?', value)[0]?.n ?? 0);
const before = countFor(season);
const started = Date.now();
const result = await ingestFormations(season);
const seconds = +((Date.now() - started) / 1000).toFixed(1);
const maxRssMb = Math.round(process.resourceUsage().maxRSS / 1024);

console.log(JSON.stringify({ season, rows_before: before, result, seconds, max_rss_mb: maxRssMb,
  licence: 'CC BY-SA 4.0', attribution }, null, 2));

// The seasons the team feature history reads (TRUSTED_HISTORY_START onward),
// through the last completed one, plus the season just loaded.
const lastCompleted = Math.max(season, new Date().getFullYear() - 1);
console.log('\nnfl_play_formations rows by season:');
for (let value = TRUSTED_HISTORY_START; value <= lastCompleted; value++) {
  console.log(`  ${value}  ${String(countFor(value)).padStart(7)}`);
}

if (result?.error) {
  console.error(`\nfailed: ${result.error}${result.note ? ` (${result.note})` : ''}`);
  process.exit(1);
}
