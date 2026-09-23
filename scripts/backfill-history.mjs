#!/usr/bin/env node
/**
 * PROJ-00 history backfill, one source and season per run.
 *
 *   GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node scripts/backfill-history.mjs pbp <season> <play_by_play_<season>.csv.gz>
 *   GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node scripts/backfill-history.mjs weather <season> [<season> ...]
 *
 * pbp: nflverse play-by-play into nfl_play_by_play. Mapping in
 *   ingestNflversePbpFile (server/services/nflverse-pbp.js); the rows are written by
 *   the table's one writer, storePlays (server/services/nfl-espn-pbp.js). Download
 *   the file first (curl -L the release URL); this command reads a local file and
 *   never fetches it, so what it loads is the file whose count was recorded.
 * weather: realized kickoff weather into nfl_game_weather through the canonical
 *   producer, syncGameWeather (server/services/nfl-weather.js, Open-Meteo archive).
 *
 * Refuses (exit 2, before opening any database) without GRIDIRON_DB_PATH, with bad
 * arguments, or when the licence file (docs/evidence/2026-09-23/proj-00-licences.md,
 * or GRIDIRON_LICENCE_FILE) is missing or does not mark the source usable.
 * Exit 1: the load failed.
 */
const USAGE = 'usage: GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node scripts/backfill-history.mjs '
  + '(pbp <season> <file.csv.gz> | weather <season> [<season> ...])';
const LICENCE_SOURCE = { pbp: 'nflverse_pbp', weather: 'open_meteo_archive' };
const refuse = msg => { console.error(`refused: ${msg}`); console.error(USAGE); process.exit(2); };

if (!process.env.GRIDIRON_DB_PATH) refuse('set GRIDIRON_DB_PATH to the database to load into; this command does not guess one.');
const [kind, ...rest] = process.argv.slice(2);
if (!LICENCE_SOURCE[kind]) refuse(`unknown source ${JSON.stringify(kind)}`);
const isSeason = v => /^\d{4}$/.test(v ?? '') && Number(v) >= 1999 && Number(v) <= new Date().getFullYear();

const { licenceDecision } = await import('../server/services/licence-gate.js');
const decision = licenceDecision(LICENCE_SOURCE[kind]);
if (!decision.usable) refuse(decision.reason);

let seasons, file;
if (kind === 'pbp') {
  if (rest.length !== 2 || !isSeason(rest[0])) refuse(`pbp takes one season and one file, got ${JSON.stringify(rest)}`);
  seasons = [Number(rest[0])]; file = rest[1];
  const fs = await import('node:fs');
  if (!fs.existsSync(file)) refuse(`no file at ${file}`);
} else {
  if (!rest.length || !rest.every(isSeason)) refuse(`weather takes seasons, got ${JSON.stringify(rest)}`);
  seasons = rest.map(Number);
}
process.env.SCHEDULER_DISABLED = process.env.SCHEDULER_DISABLED || '1';

const { rows } = await import('../server/db/index.js');
const started = Date.now();
let result;
try {
  if (kind === 'pbp') {
    const { ingestNflversePbpFile } = await import('../server/services/nflverse-pbp.js');
    result = await ingestNflversePbpFile(seasons[0], file);
  } else {
    const { syncGameWeather } = await import('../server/services/nfl-weather.js');
    result = await syncGameWeather({ seasons });
  }
} catch (error) {
  console.error(`failed: ${error.message}`);
  process.exit(1);
}
const table = kind === 'pbp' ? 'nfl_play_by_play' : 'nfl_game_weather';
const counts = rows(`SELECT season, COUNT(*) AS n FROM ${table} WHERE season IN (${seasons.map(() => '?').join(',')})
                     GROUP BY season ORDER BY season`, ...seasons);
console.log(JSON.stringify({ kind, seasons, licence: decision.line, result, counts,
  seconds: +((Date.now() - started) / 1000).toFixed(1),
  max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024) }, null, 2));
if (kind === 'weather' && result.failure_count > 0) process.exit(1);
