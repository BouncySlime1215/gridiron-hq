import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortAvailable } from './platform/port-guard.js';
import { startLoopWatchdog, watchdogArmingMiddleware, armLoopWatchdog } from './platform/loop-watchdog.js';
import { healthHandler } from './platform/health.js';

// This process is the web server: it reads engine tables and never writes them. Set in
// code, before any module that could reach the engine is imported (every database-opening
// import below is dynamic), so no launcher, Docker image or installer can leave it unset:
// writeState/appendEvents refuse any role but engine/script/test (services/engine/role.js).
process.env.GRIDIRON_PROCESS_ROLE = 'web';

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
// Route dependencies prepare statements at import time against migrated tables.
// A fresh install must finish migrations before importing any of those consumers.
await runMigrations();
const { seedIfEmpty } = await import('./db/seed/index.js');
const { default: teamsRouter } = await import('./routes/teams.js');
const { default: playersRouter } = await import('./routes/players.js');
const { default: rankingsRouter } = await import('./routes/rankings.js');
const { default: draftsRouter, startDraftClockJob, startDraftFinalizeJob } = await import('./routes/drafts.js');
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
const { default: commandCenterRouter } = await import('./routes/command-center.js');
const { default: espnConnectRouter } = await import('./routes/espn-connect.js');
const { default: leagueChatRouter } = await import('./routes/league-chat.js');
const { default: modelRouter } = await import('./routes/model.js');
const { default: dataFreshnessRouter } = await import('./routes/data-freshness.js');
const { default: nflMarketRouter } = await import('./routes/nfl-market.js');
const { default: nflBettingRouter } = await import('./routes/nfl-betting.js');
const { default: bettingHubRouter } = await import('./routes/betting-hub.js');
const { default: wongRouter } = await import('./routes/wong.js');
const { default: localAuthRouter } = await import('./routes/local-auth.js');
const { default: googleAuthRouter } = await import('./routes/google-auth.js');
const { default: draftCaptureRouter, serveCaptureScript } = await import('./routes/draft-capture.js');
const { default: executionSlateRouter } = await import('./routes/execution-slate.js');
const { default: gatesRouter } = await import('./routes/gates.js');
const { startScheduler } = await import('./services/scheduler.js');
const { legacyAuthenticated, legacyAdmin } = await import('./platform/legacy-access.js');
const { default: coachRouter } = await import('./routes/coach.js');
const { default: engineRouter } = await import('./routes/engine.js');

const app = express();
// First, so that ANY completed response arms the watchdog -- including a 404
// or a 401. The question it answers is "has this process ever served an HTTP
// response", not "has it served a useful one". See platform/loop-watchdog.js.
app.use(watchdogArmingMiddleware);
app.use(express.json());

seedIfEmpty();

// Nothing in this project used to refresh on its own, which is how the MLB board
// went sixteen days stale without failing. The timer keeps a long-running app
// current; routes additionally trigger a background refresh when data is stale,
// so an app that was closed all week catches up on the first page load.
// The evidence daemon has a T-15m horizon. Other jobs retain their own stale
// thresholds, so a five-minute scheduler tick does not make heavy ingestion run
// more often; it simply lets due capture windows fire on time.
// `onBootComplete` arms the event-loop watchdog. It is the second half of a
// fix whose first half is that the host's liveness probe no longer arms it:
// fly.toml polls /api/health every 15 seconds, so that probe was arming the
// watchdog in the middle of this boot pass and a pass that blocked the thread
// past the threshold became SIGKILL, restart, same pass, forever. Arming from
// here instead means the watchdog starts watching when the boot work is
// actually over, with no request needed -- so an app nobody has visited yet is
// still protected. See server/platform/loop-watchdog.js.
startScheduler({ intervalMinutes: 5, onBootComplete: armLoopWatchdog });
// Server-owned draft pick clock: survives reconnects and server restarts,
// since it's driven by drafts.turn_deadline in SQLite rather than any client's
// setTimeout. Without this, a draft only advanced past the clock while a
// browser tab with the Draft Room open was watching it count down.
startDraftClockJob();
// ESPN-mirrored live drafts otherwise never auto-finalize once the
// bookmarklet tab stops sending captures — see finalizeStaleDrafts
// (draft-ingest.js) for why.
startDraftFinalizeJob();

app.get('/api/health', healthHandler());

// Public only on the loopback interface. It removes the fresh-install token
// paste step while all protected route families remain bearer-authenticated.
app.use('/api/auth', localAuthRouter);
// Google sign-in, for the hosted deployment where loopback provisioning can
// never apply. Mounted alongside rather than instead of the router above:
// the Mac install keeps working exactly as it does today, and a session
// established either way is the same `auth_sessions` row underneath.
app.use('/api/auth', googleAuthRouter);

app.use('/api/teams', ...legacyAuthenticated, teamsRouter);
app.use('/api/players', ...legacyAuthenticated, playersRouter);
app.use('/api/rankings', ...legacyAuthenticated, rankingsRouter);
// Mounted before draftsRouter so /:id/capture-bookmarklet is matched here first;
// everything else falls through to the draft room routes.
app.use('/api/drafts', draftCaptureRouter);
app.use('/api/drafts', draftsRouter);
// The bookmarklet loader fetches this from the ESPN tab; served from source so
// it also works in dev, where client/dist does not exist.
app.get('/draft-capture.js', serveCaptureScript);
app.use('/api/espn', ...legacyAuthenticated, espnRouter);
app.use('/api/news', ...legacyAuthenticated, newsRouter);
app.use('/api/aggregates', ...legacyAuthenticated, aggregatesRouter);
app.use('/api/analysis', ...legacyAuthenticated, analysisRouter);
app.use('/api/leagues', ...legacyAuthenticated, leaguesRouter);
app.use('/api/nfl', ...legacyAuthenticated, nfldataRouter);
app.use('/api/stats', ...legacyAuthenticated, statsRouter);
app.use('/api/dev', ...legacyAdmin, devRouter);
app.use('/api/accolades', ...legacyAuthenticated, accoladesRouter);
app.use('/api/edge', ...legacyAuthenticated, edgeRouter);
app.use('/api/tradelab', ...legacyAuthenticated, tradelabRouter);
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use('/api/command-center', ...legacyAuthenticated, commandCenterRouter);
app.use('/api/espn-connect', espnConnectRouter);
app.use('/api/league-chat', ...legacyAuthenticated, leagueChatRouter);
// Gated as a family. Individual mutations already carried
// requireModelPermission, but every read beside them — /status, /accuracy,
// /availability, /state, /map and a dozen more — answered anyone at all. That
// is invisible on a Mac bound to loopback and wide open the moment the same
// process is reachable at a public URL.
app.use('/api/model', ...legacyAuthenticated, modelRouter);
// Reads the served tables themselves rather than the sync log, replacing the
// banner that called a job which ran and wrote zero rows "healthy". Gated like
// the rest: whether the data is current is an answer about this install's own
// contents, not a liveness check. The unauthenticated probe stays
// platform/health.js's alone.
app.use('/api/data-freshness', ...legacyAuthenticated, dataFreshnessRouter);
// Beat-the-dumb-baseline gates (plan item C12). Read-only: each gate is computed by
// its weekly scheduler job off the request thread and stored; a request reads it.
app.use('/api/gates', ...legacyAuthenticated, gatesRouter);
// /api/props and /api/props-tickets, the MLB props board and its saved slips, used
// to mount here. MLB was removed from the product in #128; no client page has
// called either path since the UI teardown 1694694c, 2026-09-19, so SY-06
// (2026-09-22) deleted both routers, as #128 deleted the MLB router itself.
// Their tables, props_auto_picks and saved_prop_tickets, stay
// on disk with no reader or writer (test/mlb-removed.test.js pins both halves).
app.use('/api/nfl-market', ...legacyAuthenticated, nflMarketRouter);
app.use('/api/nfl-betting', ...legacyAuthenticated, nflBettingRouter);
app.use('/api/betting/wong', ...legacyAuthenticated, wongRouter);
app.use('/api/betting', ...legacyAuthenticated, bettingHubRouter);
app.use('/api/execution-slate', ...legacyAuthenticated, executionSlateRouter);
// Coach applies its own auth and rate limit per route (server/routes/coach.js:37),
// so it is mounted bare rather than behind legacyAuthenticated.
app.use('/api/coach', coachRouter);
// ONE ENGINE reader (ENGINE-00a, EA-00): read-only world state for pages and Coach, with typed status.
app.use('/api/engine', ...legacyAuthenticated, engineRouter);

app.use((err, req, res, next) => {
  // AuthenticationError/AuthorizationError (server/platform/auth.js) set a real
  // status (401/403); every route that throws them was getting a 500 back
  // because this handler ignored it, turning "forbidden" into "internal error".
  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

/**
 * Installed mode: serve the built client from the same process, so a user who ran
 * the installer has one command and one port instead of a dev server pair. In dev
 * this directory does not exist and Vite handles the frontend on 5178 as before.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  // Vite names every bundle by content hash, so /assets/* can be cached for good;
  // only index.html (which points at the current hashes) must be revalidated.
  // Over a tunnel to a phone this turns three ~300ms round trips into zero.
  app.use('/assets', express.static(path.join(DIST, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(DIST, { index: false, maxAge: 0 }));
  // SPA fallback — client-side routes like /trade-lab must not 404 on refresh.
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

// Loopback-only by default (see the note at scripts/start.mjs's URL constant
// for why 127.0.0.1, never "localhost"). A real host — Fly.io, any reverse
// proxy — connects over the network, not through the container's loopback
// interface, so it needs HOST=0.0.0.0; local/Mac use is unaffected since
// nothing sets HOST there.
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Gridiron HQ listening on http://${HOST}:${PORT}`);
  // A blocked event loop cannot answer /api/health, and a failing health check
  // does not restart a Fly machine -- only a process exit does. So this is the
  // half that turns "the host can see we are wedged" into "the host replaces
  // us". It watches nothing until the first response has actually been served,
  // which matters here because boot continues well past this point: the
  // scheduler fires twenty boot jobs twenty seconds from now, on this thread.
  // See platform/loop-watchdog.js.
  startLoopWatchdog();
  // Warm the evidence layers (career lines, preseason curve, offseason
  // adjustments, in-house projections) off the request path: cold they cost
  // ~4.5s on the first board read, which on draft night would land on the
  // first poll after a restart. Failures are logged, never fatal.
  setImmediate(async () => {
    const started = Date.now();
    try {
      const { enrichWithEvidence, boardState } = await import('./services/draft-assist.js');
      const { rows } = await import('./db/index.js');
      const live = rows(`SELECT id FROM drafts WHERE league_row_id IS NOT NULL AND status = 'active' ORDER BY id DESC LIMIT 1`)[0];
      if (live) {
        const state = boardState(live.id);
        await enrichWithEvidence(state.available.slice(0, 12));
      }
      console.log(`Evidence layers warm in ${Date.now() - started}ms`);
    } catch (e) { console.warn(`Evidence warm-up skipped: ${e.message}`); }
  });
});
