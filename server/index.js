import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { seedIfEmpty } from './db/seed/index.js';
import teamsRouter from './routes/teams.js';
import playersRouter from './routes/players.js';
import rankingsRouter from './routes/rankings.js';
import draftsRouter, { startDraftClockJob } from './routes/drafts.js';
import espnRouter from './routes/espn.js';
import newsRouter from './routes/news.js';
import aggregatesRouter from './routes/aggregates.js';
import analysisRouter from './routes/analysis.js';
import leaguesRouter from './routes/leagues.js';
import nfldataRouter from './routes/nfldata.js';
import statsRouter from './routes/stats.js';
import devRouter from './routes/dev.js';
import accoladesRouter from './routes/accolades.js';
import edgeRouter from './routes/edge.js';
import tradelabRouter from './routes/tradelab.js';
import tradesRouter from './routes/trades.js';
import espnConnectRouter from './routes/espn-connect.js';
import modelRouter from './routes/model.js';
import propsRouter from './routes/props.js';
import mlbRouter from './routes/mlb.js';
import nflMarketRouter from './routes/nfl-market.js';
import nflBettingRouter from './routes/nfl-betting.js';
import bettingHubRouter from './routes/betting-hub.js';
import { startScheduler } from './services/scheduler.js';
import { legacyAuthenticated, legacyAdmin } from './platform/legacy-access.js';
import { startEspnDraftSyncJob } from './services/espn-draft.js';

const app = express();
app.use(express.json());

await runMigrations();
seedIfEmpty();

// Nothing in this project used to refresh on its own, which is how the MLB board
// went sixteen days stale without failing. The timer keeps a long-running app
// current; routes additionally trigger a background refresh when data is stale,
// so an app that was closed all week catches up on the first page load.
// The evidence daemon has a T-15m horizon. Other jobs retain their own stale
// thresholds, so a five-minute scheduler tick does not make heavy ingestion run
// more often; it simply lets due capture windows fire on time.
startScheduler({ intervalMinutes: 5 });
// Server-owned draft pick clock: survives reconnects and server restarts,
// since it's driven by drafts.turn_deadline in SQLite rather than any client's
// setTimeout. Without this, a draft only advanced past the clock while a
// browser tab with the Draft Room open was watching it count down.
startDraftClockJob();
// ESPN mirroring is server-owned. The immediate first tick catches up drafts after
// browser, server, or machine downtime; persisted retry state governs later ticks.
startEspnDraftSyncJob();

app.use('/api/teams', teamsRouter);
app.use('/api/players', ...legacyAuthenticated, playersRouter);
app.use('/api/rankings', rankingsRouter);
app.use('/api/drafts', draftsRouter);
app.use('/api/espn', espnRouter);
app.use('/api/news', ...legacyAuthenticated, newsRouter);
app.use('/api/aggregates', aggregatesRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/leagues', ...legacyAuthenticated, leaguesRouter);
app.use('/api/nfl', nfldataRouter);
app.use('/api/stats', statsRouter);
app.use('/api/dev', ...legacyAdmin, devRouter);
app.use('/api/accolades', accoladesRouter);
app.use('/api/edge', edgeRouter);
app.use('/api/tradelab', ...legacyAuthenticated, tradelabRouter);
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use('/api/espn-connect', espnConnectRouter);
app.use('/api/model', modelRouter);
app.use('/api/props', propsRouter);
app.use('/api/mlb', mlbRouter);
app.use('/api/nfl-market', nflMarketRouter);
app.use('/api/nfl-betting', nflBettingRouter);
app.use('/api/betting', bettingHubRouter);

app.use((err, req, res, next) => {
  const status = Number(err?.status) >= 400 && Number(err?.status) < 600 ? Number(err.status) : 500;
  console.error({ name: err?.name, code: err?.code, status,
    message: status === 500 ? 'request failed' : err?.message });
  res.status(status).json({ error: status === 500 ? 'internal server error' : err.message, code: err?.code });
});

/**
 * Installed mode: serve the built client from the same process, so a user who ran
 * the installer has one command and one port instead of a dev server pair. In dev
 * this directory does not exist and Vite handles the frontend on 5178 as before.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST));
  // SPA fallback — client-side routes like /trade-lab must not 404 on refresh.
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

const PORT = process.env.API_PORT || 5177;
app.listen(PORT, () => console.log(`Gridiron HQ listening on http://localhost:${PORT}`));
