#!/usr/bin/env node
/**
 * HISTORY-INGEST: does ESPN still hold past seasons' transactions for our
 * leagues? Probes both untried routes (server/services/league-history-tx.js) for
 * every ESPN league and each prior season in league-history.js's window, and
 * prints counts and date spans per league-season. Also prints what final
 * standings are already stored (league_season_teams), which league-history.js
 * fills on the scheduler.
 *
 * Read-only against ESPN with Nick's own cookies, paced 900 ms. Never prints
 * cookies, names or chat: league ids, seasons, counts and dates only.
 *
 * With --write AND GRIDIRON_HISTORY_INGEST=1, also stores the per-period rows of
 * every season that probed as existing into league_history_transactions
 * (migration 104). Without the flag, --write says it is off and writes nothing.
 *
 * Usage: npm run probe:history-tx -- [flags], or
 * node --env-file-if-exists=.env scripts/probe-league-history.mjs \
 *          [--league N] [--seasons 2023,2024] [--periods 1,5,9] [--write]
 */
process.env.SCHEDULER_DISABLED = '1';
const { db, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { historyLeagues, HISTORY_SEASON_WINDOW } = await import('../server/services/league-history.js');
const { BROWSER_HEADERS } = await import('../server/services/espn-draft.js');
const H = await import('../server/services/league-history-tx.js');

const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const list = v => v?.split(',').map(Number).filter(Number.isFinite) ?? null;
const ONLY = argOf('--league');
const SEASONS = list(argOf('--seasons'));
const PERIODS = list(argOf('--periods')) ?? H.REGULAR_PERIODS;
const WRITE = argv.includes('--write');

await runMigrations();
let failed = 0;
const summary = { existing: 0, not_existing: 0, unknown: 0 };
for (const lg of historyLeagues(ONLY ? [Number(ONLY)] : null)) {
  const seasons = SEASONS ?? Array.from({ length: HISTORY_SEASON_WINDOW - 1 }, (_, i) => lg.season - (HISTORY_SEASON_WINDOW - 1) + i);
  for (const season of seasons.filter(s => s !== lg.season)) {
    const standings = rows('SELECT COUNT(*) AS n, COUNT(final_rank) AS ranked FROM league_season_teams WHERE league_id = ? AND season = ?',
      lg.id, season)[0];
    let r;
    try {
      r = await H.probeLeagueSeason({ lg, season, periods: PERIODS, baseHeaders: BROWSER_HEADERS });
    } catch (e) {
      failed++;
      console.log(`league ${lg.id} ${season}: ERROR ${String(e?.message ?? e).slice(0, 160)}`);
      continue;
    }
    const p = r.period_route, c = r.communication_route;
    summary[r.exists === true ? 'existing' : r.exists === false ? 'not_existing' : 'unknown']++;
    console.log(`league ${lg.id} ${season}: exists=${r.exists} | standings stored ${standings.n} teams (${standings.ranked} ranked)`
      + ` | period route ${p.rows} rows in ${p.periods_with_rows.length}/${p.requests} periods ${p.earliest ?? '-'}..${p.latest ?? '-'}`
      + `${p.errors ? ` (${p.errors} errors: ${p.last_error})` : ''}`
      + ` | communication ${c.moves} moves ${c.earliest ?? '-'}..${c.latest ?? '-'}${c.error ? ` (error: ${c.error})` : ''}`);
    if (WRITE && r.exists === true && p.rows > 0) {
      try {
        const w = await H.ingestLeagueSeason(db, { lg, season, periods: PERIODS, baseHeaders: BROWSER_HEADERS });
        console.log(`league ${lg.id} ${season}: ingest ${w.state}${w.state === 'ran' ? `, ${w.written} new of ${w.seen}` : ` (${w.reason})`}`);
      } catch (e) {
        failed++;
        console.log(`league ${lg.id} ${season}: ingest ERROR ${String(e?.message ?? e).slice(0, 160)}`);
      }
    }
  }
}
console.log(`history probe: ${summary.existing} league-seasons with history, ${summary.not_existing} without, `
  + `${summary.unknown} unknown, ${failed} failed`);
process.exit(failed ? 1 : 0);
