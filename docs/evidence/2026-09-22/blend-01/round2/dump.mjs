// Dump current_week_ppg, week_blend basis and ESPN value per player, 5 ESPN leagues + synthetic PPR league.
// Usage: GRIDIRON_DB_PATH=<copy> NFL_SEASON=2026 node dump.mjs <tree> <out.json>   (local copy, not production)
import fs from 'node:fs';
const [ROOT, OUT] = process.argv.slice(2);
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import(`${ROOT}/server/db/index.js`);
await (await import(`${ROOT}/server/db/migrate.js`)).runMigrations();
for (const m of ['stats', 'aggregates', 'tradelab', 'nfldata']) await import(`${ROOT}/server/routes/${m}.js`);
const { assetUniverse, tradeWeekContext } = await import(`${ROOT}/server/services/trade-engine.js`);
const { deriveFormat } = await import(`${ROOT}/server/services/format.js`);
const target = tradeWeekContext();
const leagues = rows(`SELECT id, platform, league_id, season, team_count, ppr, superflex, roster_positions, payload FROM leagues WHERE platform = 'espn' ORDER BY id`);
leagues.push({ id: 0, platform: 'sleeper', ppr: 1, team_count: 12, superflex: 0, roster_positions: null, payload: null, season: 2026 });
const out = { target, leagues: {} };
for (const lg of leagues) {
  const u = assetUniverse(lg, deriveFormat(lg).formatKey, target);
  const m = {};
  for (const [id, a] of u) m[id] = { pos: a.position, cw: a.current_week_ppg, basis: a.week_blend?.basis ?? null, espn: a.week_blend?.espn_ppg ?? null,
    p: a.active_probability, mult: a.matchup?.mult ?? null };
  out.leagues[lg.id] = { ctx: u.context.week_blend ?? null, players: m };
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('wrote', OUT, 'week', JSON.stringify(target));
