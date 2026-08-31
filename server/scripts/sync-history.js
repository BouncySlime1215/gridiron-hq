/**
 * Backfill several seasons of weekly game logs.
 *
 * Opponent-split trends ("he goes off against the Bears") need more than the one
 * season the app shipped with — a single year gives you one game per opponent,
 * which is noise. Run this once: node server/scripts/sync-history.js 2021 2022 2023 2024 2025
 */
import { syncGameLogs } from '../routes/edge.js';

const seasons = process.argv.slice(2).map(Number).filter(Boolean);
if (!seasons.length) seasons.push(2021, 2022, 2023, 2024, 2025);

for (const s of seasons) {
  const t = Date.now();
  const out = await syncGameLogs(s, 400);
  console.log(`${s}: ${out.players} players, ${out.games} games (${((Date.now() - t) / 1000).toFixed(0)}s)`);
}
process.exit(0);
