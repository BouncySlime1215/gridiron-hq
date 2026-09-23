// waiverBoard for each ESPN league (named columns only; never a league's cookies) (local copy, not production). Usage: GRIDIRON_DB_PATH=<copy> NFL_SEASON=2026 node waivers.mjs <tree> <out.json>
import fs from 'node:fs';
const [ROOT, OUT] = process.argv.slice(2);
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import(`${ROOT}/server/db/index.js`);
await (await import(`${ROOT}/server/db/migrate.js`)).runMigrations();
for (const m of ['stats', 'aggregates', 'tradelab', 'nfldata']) await import(`${ROOT}/server/routes/${m}.js`);
const { waiverBoard } = await import(`${ROOT}/server/services/waiver-wire.js`);
const out = {};
for (const lg of rows(`SELECT id, platform, league_id, season, my_team_id, team_count, ppr, superflex, roster_positions, payload FROM leagues WHERE platform = 'espn' ORDER BY id`)) {
  const b = waiverBoard(lg, { myTeamId: lg.my_team_id });
  out[lg.id] = b;
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('wrote', OUT);
