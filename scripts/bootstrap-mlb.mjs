#!/usr/bin/env node
/**
 * First-run MLB data pull — same idea as bootstrap-data.mjs, but for the
 * first-party MLB pipeline (server/services/mlb.js) instead of NFL.
 *
 * Usage: node scripts/bootstrap-mlb.mjs [startSeason] [endSeason]
 */
import { syncSeason, coverage } from '../server/services/mlb.js';

const start = Number(process.argv[2]) || 2022;
const end = Number(process.argv[3]) || 2025;

console.log(`\nPulling MLB data for ${start}-${end}. This hits the public MLB Stats API, no key needed.\n`);

for (let season = start; season <= end; season++) {
  const t = Date.now();
  process.stdout.write(`  ${season}… `);
  try {
    const r = await syncSeason(season);
    console.log(`done (${((Date.now() - t) / 1000).toFixed(0)}s) — `
      + `${r.schedule.games} games, ${r.pitchers.games} pitcher-games (${r.pitchers.players_ok} pitchers), `
      + `${r.batters.games} batter-games (${r.batters.players_ok} batters)`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
  }
}

console.log('\nCoverage:');
console.log(JSON.stringify(coverage(), null, 2));
