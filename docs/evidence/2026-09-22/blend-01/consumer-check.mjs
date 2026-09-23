// Consumer check on the local copy (not production): the page's number for 2026 week 3, per
// ESPN league, through the real assetUniverse and startSitWeekPoints on the branch head.
// Run from the repo root on a COPY of the app database:
//   GRIDIRON_DB_PATH=.local-db/data.sqlite NFL_SEASON=2026 node docs/evidence/2026-09-22/blend-01/consumer-check.mjs
const ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import(`${ROOT}/server/db/index.js`);
await (await import(`${ROOT}/server/db/migrate.js`)).runMigrations();
await import(`${ROOT}/server/routes/stats.js`); await import(`${ROOT}/server/routes/aggregates.js`);
await import(`${ROOT}/server/routes/tradelab.js`); await import(`${ROOT}/server/routes/nfldata.js`);
const { assetUniverse, tradeWeekContext } = await import(`${ROOT}/server/services/trade-engine.js`);
const { startSitWeekPoints } = await import(`${ROOT}/server/services/lineup-brain.js`);
const { deriveFormat } = await import(`${ROOT}/server/services/format.js`);
const target = tradeWeekContext();
console.log('week context', JSON.stringify(target));
for (const lg of rows(`SELECT id, platform, league_id, season, team_count, ppr, superflex, roster_positions, payload FROM leagues WHERE platform = 'espn' ORDER BY id`)) {
  const u = assetUniverse(lg, deriveFormat(lg).formatKey, target);
  const counts = {};
  let mismatchEspn = 0, mismatchPage = 0, blended = 0;
  for (const a of u.values()) {
    counts[a.week_blend.basis] = (counts[a.week_blend.basis] ?? 0) + 1;
    if (a.week_blend.basis === 'blend') {
      blended++;
      if (Math.abs(a.current_week_ppg - a.week_blend.espn_ppg) > 0.005) mismatchEspn++;
    }
    if (startSitWeekPoints(a, target.season, target.week).week_points !== a.current_week_ppg) mismatchPage++;
  }
  const c = u.context.week_blend;
  console.log(`league row ${lg.id}: ${JSON.stringify(counts)} | blend rows whose number is not ESPN's: ${mismatchEspn} of ${blended} | Start/Sit week_points != current_week_ppg: ${mismatchPage} | context on=${c.on} candidate=${c.candidate} verdict=${c.verdict} espn=${JSON.stringify(c.espn)}`);
}
