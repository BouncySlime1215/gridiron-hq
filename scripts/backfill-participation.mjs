#!/usr/bin/env node
/**
 * PROJ-00: load one season of nflverse participation players into
 * nfl_play_participation_players (migration 074).
 *
 *   GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node scripts/backfill-participation.mjs <season> <pbp_participation_<season>.csv>
 *
 * Writer: ingestParticipationFile, server/services/nfl-participation.js (upsert on
 * game_id + play_id + gsis_id, so a re-run refreshes). Reads a local file that was
 * downloaded first; it never fetches. Prints participationStatus for the season,
 * including the player_week_snaps match share.
 *
 * Refuses (exit 2, before opening any database) without GRIDIRON_DB_PATH, with bad
 * arguments, or when the licence file does not mark nflverse_participation usable.
 * Licence: CC BY-SA 4.0, "FTN Data via nflverse" (2023 on) or "NFL NextGenStats via
 * nflverse" (2022 and earlier). Only aggregates go in the repo.
 */
const USAGE = 'usage: GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node scripts/backfill-participation.mjs <season> <file.csv>';
const refuse = msg => { console.error(`refused: ${msg}`); console.error(USAGE); process.exit(2); };

if (!process.env.GRIDIRON_DB_PATH) refuse('set GRIDIRON_DB_PATH to the database to load into; this command does not guess one.');
const { licenceDecision } = await import('../server/services/licence-gate.js');
const decision = licenceDecision('nflverse_participation');
if (!decision.usable) refuse(decision.reason);
const args = process.argv.slice(2);
if (args.length !== 2 || !/^\d{4}$/.test(args[0]) || Number(args[0]) < 2016) refuse(`bad arguments ${JSON.stringify(args)}`);
const season = Number(args[0]);
const fs = await import('node:fs');
if (!fs.existsSync(args[1])) refuse(`no file at ${args[1]}`);
process.env.SCHEDULER_DISABLED = process.env.SCHEDULER_DISABLED || '1';

const { ingestParticipationFile, participationStatus } = await import('../server/services/nfl-participation.js');
const started = Date.now();
let result;
try {
  result = await ingestParticipationFile(season, args[1]);
} catch (error) {
  console.error(`failed: ${error.message}`);
  process.exit(1);
}
console.log(JSON.stringify({ result, status: participationStatus({ season }).seasons[0] ?? null,
  licence: decision.line, seconds: +((Date.now() - started) / 1000).toFixed(1),
  max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024) }, null, 2));
