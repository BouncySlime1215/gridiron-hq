#!/usr/bin/env node
/**
 * Freeze the weekly feature vector for 2021-2025 so it can be graded.
 *
 * Why this writes to a copy by default
 * -----------------------------------
 * The v2 vector is 4,515 features for a team-week and 1,164 for a player-week.
 * Frozen for 2021-2025 that is roughly 350MB of team vectors and 860MB of
 * player vectors -- more than the whole 675MB production database. Production
 * is written every fifteen minutes by a refresh loop and has already had one
 * WAL blowup (see the note in server/db/index.js), so a research backfill does
 * not belong in it. `VACUUM INTO` takes a consistent snapshot of production
 * even while that loop is running, and the backfill lands in the copy.
 *
 * Production still gets the vector where it actually needs one: the live
 * weekly freeze (freezeWeeklyFeatureState) writes the current week only, which
 * is ~1,500 rows a week, not 22,000.
 *
 * Pass --in-place to backfill the production database instead.
 *
 * Why the trusted-history floor moves
 * -----------------------------------
 * TRUSTED_HISTORY_START defaults to 2022, which would leave every 2021 target
 * week with zero prior observations and no vector at all -- and 2021 is a fit
 * season. The floor is an environment knob for exactly this; it is set to 2021
 * here and recorded in the run summary so the vectors say what they were built
 * from.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/backfill-feature-store.mjs
 *   node --env-file-if-exists=.env scripts/backfill-feature-store.mjs --in-place
 *   node ... scripts/backfill-feature-store.mjs --seasons 2024,2025 --teams-only
 */
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = argv.find(item => item.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTION_DB = path.join(REPO_ROOT, 'server', 'data.sqlite');
export const STUDY_DB = path.join(REPO_ROOT, 'data', 'derived', 'feature-store-study.sqlite');

const seasons = String(option('seasons', '2021,2022,2023,2024,2025')).split(',').map(Number);
const startWeek = Number(option('start-week', 5));
const endWeek = Number(option('end-week', 18));
const inPlace = flag('in-place');
const target = inPlace ? PRODUCTION_DB : STUDY_DB;

const megabytes = file => existsSync(file) ? (statSync(file).size / 1e6).toFixed(0) : '0';
const since = start => `${((Date.now() - start) / 1000).toFixed(1)}s`;

if (!inPlace && !existsSync(target)) {
  // VACUUM INTO, not cp: production is open in WAL mode with a writer on a
  // fifteen-minute cadence, and a byte copy of a live WAL database is a
  // corrupt database. VACUUM INTO serialises a consistent snapshot.
  console.log(`snapshotting ${PRODUCTION_DB} (${megabytes(PRODUCTION_DB)}MB) -> ${target}`);
  const started = Date.now();
  const source = new DatabaseSync(PRODUCTION_DB, { readOnly: true });
  source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  source.close();
  console.log(`  snapshot done in ${since(started)} (${megabytes(target)}MB)`);
}

process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_DB_PATH = target;
process.env.NFL_TRUSTED_HISTORY_START = process.env.NFL_TRUSTED_HISTORY_START || '2021';

const { db } = await import('../server/db/index.js');
const store = await import('../server/services/nfl-weekly-feature-store-v2.js');

console.log(`\ntarget database   ${target}`);
console.log(`store version     ${store.WEEKLY_FEATURE_STORE_VERSION}`);
console.log(`trusted history   ${store.TRUSTED_HISTORY_START}`);
console.log(`seasons           ${seasons.join(', ')} weeks ${startWeek}-${endWeek}\n`);

// Warm the satellite caches once and report what they found, before any
// timing below is attributed to the vector build itself.
{
  const started = Date.now();
  const coverage = store.satelliteCoverage(seasons);
  console.log(`satellites warmed in ${since(started)}`);
  console.log(`  participation: ${coverage.participation_plays_scanned.toLocaleString()} plays scanned, ` +
    `${coverage.participation_plays_with_shell_label.toLocaleString()} with a coverage-shell label`);
  if (Object.keys(coverage.errors).length) console.log(`  satellite errors: ${JSON.stringify(coverage.errors)}`);
  console.log('  season  adv_team  part_team  part_player  ol_cont  apm      man/zone receivers (stable split)');
  for (const item of coverage.per_season) {
    console.log(`  ${item.season}    ${String(item.adv_team_week.observations).padStart(6)}` +
      `    ${String(item.participation_team.observations).padStart(7)}` +
      `      ${String(item.participation_player.observations).padStart(7)}` +
      `  ${String(item.ol_continuity.observations).padStart(7)}` +
      `  ${String(item.player_value.observations).padStart(7)}` +
      `  ${String(item.man_zone_split.receivers_with_routes).padStart(5)}` +
      ` (${item.man_zone_split.stable_split} with >=${item.man_zone_split.minimum_routes_each} routes vs both)`);
  }
}

/**
 * One transaction per season-week.
 *
 * node:sqlite's DatabaseSync has no .transaction() helper, so the boundaries
 * are explicit. They are per week rather than per season because the whole
 * backfill in one transaction would hold well over a gigabyte in the WAL
 * before a single commit -- which is the failure this script exists to avoid.
 */
function chunked(label, callback) {
  const started = Date.now();
  const totals = { targets: 0, frozen: 0, existing: 0, failures: 0 };
  const failureReasons = new Map();
  for (const season of seasons) {
    const seasonStarted = Date.now();
    const seasonTotals = { targets: 0, frozen: 0, failures: 0 };
    for (let week = startWeek; week <= endWeek; week++) {
      db.exec('BEGIN');
      let result;
      try { result = callback(season, week); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      totals.targets += result.targets; totals.frozen += result.frozen;
      totals.existing += result.existing; totals.failures += result.failures.length;
      seasonTotals.targets += result.targets; seasonTotals.frozen += result.frozen;
      seasonTotals.failures += result.failures.length;
      for (const failure of result.failures) {
        failureReasons.set(failure.error, (failureReasons.get(failure.error) ?? 0) + 1);
      }
    }
    console.log(`  ${label} ${season}: ${seasonTotals.frozen} frozen of ${seasonTotals.targets} targets` +
      `, ${seasonTotals.failures} without prior evidence, ${since(seasonStarted)}`);
  }
  console.log(`  ${label} total: ${totals.frozen} frozen, ${totals.existing} already present, ` +
    `${totals.failures} skipped, ${since(started)}`);
  if (failureReasons.size) console.log(`    skip reasons: ${JSON.stringify(Object.fromEntries(failureReasons))}`);
  return totals;
}

if (!flag('players-only')) {
  console.log('\nteam vectors');
  chunked('team', (season, week) => store.backfillTeamFeatureVectors({
    seasons: [season], startWeek: week, endWeek: week }));
}

if (!flag('teams-only')) {
  console.log('\nplayer vectors');
  chunked('player', (season, week) => store.backfillPlayerFeatureVectors({
    seasons: [season], startWeek: week, endWeek: week }));
}

console.log('\nfrozen state');
const status = store.weeklyFeatureStoreStatus();
console.log(`  dictionary: ${JSON.stringify(status.dictionary)}`);
console.log('  team vectors   ' + JSON.stringify(status.team_vectors));
console.log('  player vectors ' + JSON.stringify(status.player_vectors));
console.log(`\ndatabase now ${megabytes(target)}MB`);
process.exit(0);
