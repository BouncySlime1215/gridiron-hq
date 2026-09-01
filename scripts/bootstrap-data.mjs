#!/usr/bin/env node
/**
 * First-run data pull.
 *
 * The seed ships static content (32 teams, schemes, depth charts) but none of the
 * live data the analytics run on — rosters, projections, market prices, and above
 * all the weekly boxscores that the matchup engine derives defence-vs-position and
 * opponent history from. Without this the Trade Lab still works, it just scores
 * every matchup as neutral.
 *
 * Driven over HTTP against a throwaway server rather than by importing each sync
 * function: the routes are the only place the ordering constraints live (Sleeper
 * ids must exist before FantasyCalc can match on them, and so on), and duplicating
 * that here would be a second source of truth.
 *
 * Usage:  node scripts/bootstrap-data.mjs [--quick]
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');
const SEASONS = QUICK ? [2025] : [2021, 2022, 2023, 2024, 2025];

const c = { g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };

/** An OS-assigned free port, so this never fights a copy of the app already running. */
const freePort = () => new Promise(resolve => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.js'],
  { cwd: ROOT, env: { ...process.env, API_PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });

const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(1); });

// Wait for it to answer before firing anything at it.
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(`${BASE}/api/teams`, { signal: AbortSignal.timeout(1000) })).ok; }
  catch { await new Promise(r => setTimeout(r, 500)); }
}
if (!up) { console.error('  Could not start the local server — skipping the data pull.'); stop(); process.exit(1); }

/** Each step is allowed to fail; a missing feed should not abort the whole install. */
async function run(label, pathname, ms = 240000) {
  process.stdout.write(`  ${label}… `);
  const t = Date.now();
  try {
    const res = await fetch(`${BASE}${pathname}`, { method: 'POST', signal: AbortSignal.timeout(ms) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    console.log(c.g(`done`) + c.dim(` (${((Date.now() - t) / 1000).toFixed(0)}s)`));
    return body;
  } catch (e) {
    console.log(c.y(`skipped`) + c.dim(` — ${e.message}`));
    return null;
  }
}

console.log('\n  Pulling live NFL data. This needs an internet connection and takes a minute or two.\n');

// Order matters: the player universe has to exist before anything keys off it,
// and schedules must land before the matchup engine can read a 2026 slate.
await run('Player universe (ESPN)', '/api/espn/sync-players');
await run('Schedules, depth charts, cap', '/api/nfl/sync-all');
// Season projections must land before the boxscore pull: that sync picks which
// players to fetch by ordering on projected points, so with an empty stats table
// it finds nothing to do and silently succeeds.
await run('Season projections', '/api/stats/sync');
await run('ADP, market values, news', '/api/aggregates/refresh-all');
for (const s of SEASONS) {
  await run(`Weekly boxscores ${s}`, `/api/edge/gamelogs/sync?season=${s}&limit=400`);
}
await run('Trending adds/drops', '/api/tradelab/trending/sync', 30000);
// The prediction engine's own feeds: nflverse usage, betting lines, and the fits
// derived from them. Last because it depends on the player universe existing.
await run('Prediction engine (PBP, player usage, advanced stats, lines, model fits)', '/api/model/sync', 1200000);
await run('NFL draft and combine rookie evidence', '/api/nfl-betting/roster/rookies/sync?from=2000', 300000);
if (!QUICK) {
  await run('Opponent-adjusted college rookie backfill',
    '/api/nfl-betting/roster/rookies/college-sync?from=2022&through=2025', 1200000);
}

// Report what the matchup engine actually ended up with, since that is the piece
// most likely to be thin and the one the trade scoring leans on hardest.
try {
  const dvp = await (await fetch(`${BASE}/api/trades/dvp?position=WR`)).json();
  console.log(`\n  ${c.g('✓')} Matchup model built from ${dvp.seasons?.join(', ') || 'no'} season(s), `
    + `${dvp.table?.length ?? 0} defences rated.`);
} catch { /* non-fatal */ }

stop();
console.log('');
