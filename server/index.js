import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db/index.js';
import { seedIfEmpty } from './db/seed/index.js';
import teamsRouter from './routes/teams.js';
import playersRouter from './routes/players.js';
import rankingsRouter from './routes/rankings.js';
import draftsRouter from './routes/drafts.js';
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

const app = express();
app.use(express.json());

seedIfEmpty();

// Nothing in this project used to refresh on its own, which is how the MLB board
// went sixteen days stale without failing. The timer keeps a long-running app
// current; routes additionally trigger a background refresh when data is stale,
// so an app that was closed all week catches up on the first page load.
startScheduler({ intervalMinutes: 30 });

app.use('/api/teams', teamsRouter);
app.use('/api/players', playersRouter);
app.use('/api/rankings', rankingsRouter);
app.use('/api/drafts', draftsRouter);
app.use('/api/espn', espnRouter);
app.use('/api/news', newsRouter);
app.use('/api/aggregates', aggregatesRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/leagues', leaguesRouter);
app.use('/api/nfl', nfldataRouter);
app.use('/api/stats', statsRouter);
app.use('/api/dev', devRouter);
app.use('/api/accolades', accoladesRouter);
app.use('/api/edge', edgeRouter);
app.use('/api/tradelab', tradelabRouter);
app.use('/api/trades', tradesRouter);
app.use('/api/espn-connect', espnConnectRouter);
app.use('/api/model', modelRouter);
app.use('/api/props', propsRouter);
app.use('/api/mlb', mlbRouter);
app.use('/api/nfl-market', nflMarketRouter);
app.use('/api/nfl-betting', nflBettingRouter);
app.use('/api/betting', bettingHubRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
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
