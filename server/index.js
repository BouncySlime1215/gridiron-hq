import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortAvailable } from './platform/port-guard.js';

const PORT = Number(process.env.API_PORT) || 5177;
try {
  await assertPortAvailable(PORT);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// Keep every database-opening import below the port guard. Static imports are
// evaluated before any top-level code, which was why the previous EADDRINUSE
// crash still ran migrations, seed reconciliation and schedulers first.
const { default: express } = await import('express');
const { runMigrations } = await import('./db/migrate.js');
const { seedIfEmpty } = await import('./db/seed/index.js');
const { default: teamsRouter } = await import('./routes/teams.js');
const { default: playersRouter } = await import('./routes/players.js');
const { default: rankingsRouter } = await import('./routes/rankings.js');
const { default: draftsRouter, startDraftClockJob } = await import('./routes/drafts.js');
const { default: espnRouter } = await import('./routes/espn.js');
const { default: newsRouter } = await import('./routes/news.js');
const { default: aggregatesRouter } = await import('./routes/aggregates.js');
const { default: analysisRouter } = await import('./routes/analysis.js');
const { default: leaguesRouter } = await import('./routes/leagues.js');
const { default: nfldataRouter } = await import('./routes/nfldata.js');
const { default: statsRouter } = await import('./routes/stats.js');
const { default: devRouter } = await import('./routes/dev.js');
const { default: accoladesRouter } = await import('./routes/accolades.js');
const { default: edgeRouter } = await import('./routes/edge.js');
const { default: tradelabRouter } = await import('./routes/tradelab.js');
const { default: tradesRouter } = await import('./routes/trades.js');
const { default: espnConnectRouter } = await import('./routes/espn-connect.js');
const { default: modelRouter } = await import('./routes/model.js');
const { default: propsRouter } = await import('./routes/props.js');
const { default: mlbRouter } = await import('./routes/mlb.js');
const { default: nflMarketRouter } = await import('./routes/nfl-market.js');
const { default: nflBettingRouter } = await import('./routes/nfl-betting.js');
const { default: bettingHubRouter } = await import('./routes/betting-hub.js');
const { default: localAuthRouter } = await import('./routes/local-auth.js');
const { startScheduler } = await import('./services/scheduler.js');
const { legacyAuthenticated, legacyAdmin } = await import('./platform/legacy-access.js');

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

// Public only on the loopback interface. It removes the fresh-install token
// paste step while all protected route families remain bearer-authenticated.
app.use('/api/auth', localAuthRouter);
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

app.listen(PORT, () => console.log(`Gridiron HQ listening on http://localhost:${PORT}`));
