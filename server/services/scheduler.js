/**
 * Keeping the data current without anyone remembering to.
 *
 * Until now nothing in this project refreshed on its own — every sync happened
 * because someone ran a script. That is fine for a backfill and useless for a
 * board meant to show tonight's games, which is how the MLB page ended up
 * sixteen days stale without failing.
 *
 * Two mechanisms, deliberately different:
 *
 *  - A timer, so a long-running app stays current on its own.
 *  - A staleness check on read, so an app that was closed all week catches up
 *    the moment you open the page rather than showing yesterday until the
 *    first timer tick.
 *
 * The second matters more for a local app that is not always running. Both are
 * cheap: the MLB schedule is one request for a whole season, and refreshes are
 * skipped entirely when the data is already fresh.
 */
import { Worker } from 'node:worker_threads';
import { db, rows, run, row } from '../db/index.js';

/**
 * True while any linked league's draft is likely happening on ESPN itself,
 * whether or not our own mirror page is open.
 *
 * Investigated 2026-09-06/07: Nick's ESPN browser session kept getting
 * kicked during a real draft. The first theory was our own 4s live-draft
 * poll — but the audit trail showed our mirror's last sync was 90 minutes
 * BEFORE that draft started (he wasn't on our page at all; he drafted
 * straight on ESPN.com). The actual overlap: `league_rosters`, the hourly
 * job that sweeps all 7 connected leagues, fired at 23:49:54 UTC — squarely
 * inside the draft window (23:00-00:21 UTC, 192 picks). espnCookies() is one
 * global lookup, so that sweep hit ESPN with the SAME espn_s2/SWID his
 * browser was actively using to draft, from a server, mid-draft. That is a
 * real "concurrent use of one session" signature independent of whether our
 * mirror was open — so the gate has to key off the draft's SCHEDULED window
 * (draft_at), not our own poll activity, or it misses exactly this case.
 */
const DRAFT_WINDOW_BEFORE_MIN = 15;   // commissioners start late more often than early
const DRAFT_WINDOW_AFTER_HOURS = 4;   // generous — a slow 16-round snake can run long
function liveDraftActive() {
  // draft_at is stored ISO8601 ("...T23:00:00.000Z"); datetime('now', ...) is
  // space-separated with no 'Z'. Comparing those two formats as raw strings
  // is a lexicographic trap — 'T' (0x54) sorts after a space (0x20), so an
  // unnormalized comparison silently gets the wrong answer on same-day
  // boundaries (verified with a throwaway in-memory table before trusting
  // this). datetime(draft_at) normalizes both sides to the same format.
  //
  // Guarded: `drafts` is one of the ad-hoc tables created at import time by
  // routes/drafts.js rather than a migration (see db/index.js's comment on
  // migrate()), so a narrow test harness that never imports that route has
  // no `drafts` table at all — this must never take down an unrelated job
  // over that, so "can't tell" reads as "no live draft", not an error.
  try {
    return !!row(`SELECT 1 FROM drafts WHERE league_row_id IS NOT NULL
                  AND status = 'active' AND draft_at IS NOT NULL
                  AND datetime(draft_at) <= datetime('now', '+${DRAFT_WINDOW_BEFORE_MIN} minutes')
                  AND datetime(draft_at) >= datetime('now', '-${DRAFT_WINDOW_AFTER_HOURS} hours')`);
  } catch { return false; }
}

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

export function lastRun(job) {
  return rows('SELECT * FROM sync_log WHERE job = ?', job)[0] ?? null;
}

/**
 * Records a completed sync into the same log the scheduler's own timed jobs
 * use, so a source that only ever runs on demand (nflverse, ESPN, aggregates,
 * ...) shows up in staleness reporting exactly like a scheduled one. See
 * source-registry.js, which is what actually reads this for every source —
 * scheduled or not.
 */
export function recordSync(job, status, detail) { record(job, status, detail); }

function record(job, status, detail) {
  run(`INSERT INTO sync_log (job, last_run_at, last_status, last_detail, runs)
       VALUES (?,?,?,?,1)
       ON CONFLICT(job) DO UPDATE SET
         last_run_at=excluded.last_run_at, last_status=excluded.last_status,
         last_detail=excluded.last_detail, runs=sync_log.runs+1`,
    job, nowIso(), status, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

/** Minutes since a job last ran, or Infinity if it never has. */
export function minutesSince(job) {
  const l = lastRun(job);
  if (!l?.last_run_at) return Infinity;
  return (Date.now() - new Date(l.last_run_at).getTime()) / 60000;
}

/* -------------------------------------------------------------------- jobs */

/**
 * The MLB schedule for the current season, which now includes games that have
 * not been played yet. One request, so this is cheap enough to run often.
 */
async function refreshMlbSchedule() {
  const { syncSeasonSchedule } = await import('./mlb.js');
  const season = new Date().getFullYear();
  return syncSeasonSchedule(season);
}

/**
 * Player game logs — roughly 1,500 requests, so this runs far less often and
 * only matters once games have finished.
 */
async function refreshMlbLogs() {
  const { syncPitcherGameLogs, syncBatterGameLogs } = await import('./mlb.js');
  const season = new Date().getFullYear();
  const p = await syncPitcherGameLogs(season);
  const b = await syncBatterGameLogs(season);
  return { pitchers: p.games, batters: b.games };
}

/**
 * Settle the last completed slate cheaply. This is deliberately separate from
 * season-wide player-log ingestion: fifteen boxscore requests beat thousands
 * of player requests and make a missing result stay Pending, never falsely Void.
 */
async function refreshMlbBoxscores() {
  const { syncFinalBoxscores } = await import('./mlb.js');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return syncFinalBoxscores(yesterday);
}

/**
 * Player roster/team assignments. This was the actual cause of players
 * showing up on the wrong team — not a sync bug, a MISSING sync: this
 * function was correct and already existed, but only ran when someone
 * clicked "Repull rosters" by hand. A trade or release made after the last
 * manual click stayed wrong until the next click, indefinitely. Scheduled
 * now like every other data source in this file.
 */
async function refreshPlayerRosters() {
  if (liveDraftActive()) return { skipped: 'live draft in progress — see liveDraftActive()' };
  const { syncPlayersFromESPN } = await import('../routes/espn.js');
  return syncPlayersFromESPN();
}

/**
 * ESPN's own per-team roster feed (roster_players — separate from the
 * players table refreshPlayerRosters above updates). Registered in
 * source-registry.js's MANUAL_SOURCES as "daily-ish — cuts and signings",
 * but nothing ever actually called it on a timer: it only ran from the
 * "Refresh data" button or the first-run installer, so a roster synced once
 * on install just sat there — measured live, over five weeks stale (last
 * fetched 2026-07-29, still 2026-07-29 after a normal day of use). Same
 * missing-sync class of bug as refreshPlayerRosters above, same fix.
 */
async function refreshEspnRosters() {
  const { syncRosters } = await import('../routes/nfldata.js');
  return syncRosters();
}

/**
 * Each connected league's OWN roster payload (who owns which player on THAT
 * fantasy team — a trade, a waiver claim, a drop) — a completely different
 * thing from refreshEspnRosters above (which real NFL team a player is on).
 * This only ever ran from a user manually clicking "Sync" on a specific
 * league, so a real trade made in the actual ESPN/Sleeper league never
 * reached Trade Lab (loadRosters() in trade-engine.js reads `leagues.payload`
 * directly, no caching of its own — it was never stale from a code bug, the
 * payload underneath it just never refreshed itself). Same missing-schedule
 * class of bug as every other "silently stopped updating" fix this session.
 */
async function refreshLeagueRosters() {
  const skipEspn = liveDraftActive();
  const { syncEspnLeague, syncSleeperLeague } = await import('../routes/leagues.js');
  const leagues = rows('SELECT * FROM leagues');
  const results = [];
  for (const lg of leagues) {
    // Only ESPN shares Nick's browser session cookie — Sleeper has no such
    // conflict, so only ESPN leagues pause while a draft is being polled.
    if (skipEspn && lg.platform !== 'sleeper') { results.push({ league_id: lg.id, ok: true, skipped: true }); continue; }
    try {
      const detail = lg.platform === 'sleeper' ? await syncSleeperLeague(lg) : await syncEspnLeague(lg);
      run(`UPDATE leagues SET connection_status='connected', sync_error=NULL WHERE id=?`, lg.id);
      results.push({ league_id: lg.id, ok: true, detail });
    } catch (e) {
      run(`UPDATE leagues SET connection_status='sync_failed', sync_error=? WHERE id=?`,
        String(e.message ?? e).slice(0, 500), lg.id);
      results.push({ league_id: lg.id, ok: false, error: e.message });
    }
  }
  return { leagues: results.length, failed: results.filter(r => !r.ok).length };
}

/**
 * The X's & O's writeups. Self-limiting by design (see refreshStaleAnalyses):
 * only teams with news newer than their last analysis actually spend an AI
 * call, so scheduling this does not mean refreshing 32 teams every cycle —
 * most cycles it does nothing. This is what actually fixes stale write-ups
 * like "Deebo Samuel's hybrid role continues" surviving a trade; the
 * detector for that already existed (GET /analysis/validate) but nothing
 * ever acted on what it found until now.
 */
async function refreshTeamAnalyses() {
  const { refreshStaleAnalyses } = await import('../routes/analysis.js');
  return refreshStaleAnalyses();
}

/** NFL lines for the current season, including scores as games go final. */
async function refreshNflLines() {
  const { syncCurrentLines, clearGameScriptCache } = await import('./gamescript.js');
  const season = Number(process.env.NFL_SEASON) || new Date().getFullYear();
  const out = await syncCurrentLines(season, 18);
  clearGameScriptCache();
  return out;
}

/**
 * Settle forward picks shortly after each game goes final, the same "settle
 * the last completed slate cheaply" pattern as refreshMlbBoxscores above.
 * Until now settleForwardPicks() was manual-only (a POST route), which meant
 * a real CLV-grading window between a game going final and someone thinking
 * to click the button — during which forward-ledger's read of
 * game_lines.spread/total (now closing_spread/closing_total) could still be
 * stale or, before that fix, actively wrong. A cheap SQLite scan on a live
 * cadence closes that window without anyone remembering to do it.
 */
async function refreshForwardSettlement() {
  const { settleForwardPicks } = await import('./forward-ledger.js');
  return settleForwardPicks();
}

/**
 * Confirmed starting pitchers for the next few days. This is what makes the
 * strikeout picks mean anything — without it, the board ranked a team's whole
 * rotation by talent and picked the ace regardless of whether he was actually
 * pitching that day, which is why those picks could never settle.
 */
async function refreshMlbProbables() {
  const { syncProbableStarters } = await import('./mlb.js');
  return syncProbableStarters(5);
}

/**
 * Locks in tomorrow's five picks as soon as there is enough to work with,
 * rather than waiting for someone to open the page after midnight. Cheap to
 * run often — ensurePicksFor is idempotent, so an already-locked slate just
 * returns immediately.
 */
async function prepareTomorrowPicks() {
  const { ensurePicksFor } = await import('./mlb-auto-picks.js');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const picks = ensurePicksFor(tomorrow);
  return { date: tomorrow, picks: picks.length };
}

/**
 * Multi-book line snapshots — the raw material for closing line value.
 *
 * CLV needs a number captured when a bet was placed and another near kickoff.
 * Nothing was capturing on a timer before this, which is why the snapshot table
 * held exactly one timestamp and CLV was unmeasurable.
 *
 * The Odds API free tier is 500 credits a month and each market costs one per
 * call, so this asks for spreads and totals only (2 credits) and runs twice a
 * day: about 120 credits a month, leaving the rest for props and on-demand
 * shopping. The reserve check matters more than the cadence — running out
 * mid-season would silently stop the measurement rather than fail loudly.
 */
async function refreshNflLineSnapshots() {
  const { snapshotLines } = await import('./line-shopping.js');
  const { usage } = await import('./odds-api.js');
  const left = usage().requests_remaining;
  if (left != null && left < 60) {
    return { skipped: true, reason: `holding ${left} API credits in reserve for on-demand pricing` };
  }
  const snap = await snapshotLines({ markets: 'spreads,totals' });
  if (snap?.error) return snap;
  const { gradeClosingLineValue } = await import('./clv-core.js');
  // Grade as soon as a fresh capture exists: a bet becomes gradeable the moment
  // its game kicks off, and the last capture before that is its close.
  const result = { ...snap, clv: gradeClosingLineValue() };
  // A fresh snapshot is exactly the moment open tweet-watches can be checked
  // for movement — running it here means it never waits on a separate timer.
  const { checkTweetLineMovement } = await import('./nfl-tweet-line-correlation.js');
  result.tweet_line_check = await checkTweetLineMovement();
  return result;
}

/**
 * SportsGameOdds — a second, free multi-book source on its own budget. A
 * no-op until SPORTSGAMEODDS_API_KEY is set; it never touches the Odds API
 * reserve, so it can run at a normal cadence even while that reserve is held.
 */
async function refreshSportsGameOdds() {
  const { hasKey, captureSportsGameOddsSnapshot } = await import('./sportsgameodds.js');
  if (!hasKey()) return { skipped: true, reason: 'no SPORTSGAMEODDS_API_KEY configured' };
  return captureSportsGameOddsSnapshot();
}

/**
 * Free multi-book feeds (Pinnacle guest, OddsTrader aggregator, Kambi, Bovada) —
 * split into two jobs on deliberately different cadences.
 *
 * Pinnacle and OddsTrader are the "API-like" half: Pinnacle's own documented
 * commercial API rate limit is 10 requests/second for reads (github.com/
 * pinnacleapi/pinnacleapi-documentation), and this project's guest endpoint is
 * the same infrastructure nfl-sharp.js already treats as the sharp reference —
 * built for frequent machine consumption, not a page a human refreshes. Kalshi
 * (~30 req/s on public market data) and Polymarket (Gamma ~400 req/s, CLOB
 * ~900 req/s per their published docs) are in the same tier below for the same
 * reason. A poll every 5 minutes uses a vanishingly small fraction of any of
 * those budgets, so it moves here instead of the hourly cadence the fragile
 * scrapes below still use.
 *
 * Kambi and Bovada are undocumented consumer-site endpoints with no published
 * rate limit anywhere — real research turned up general warnings about books
 * detecting and soft-blocking syndicate-like automated traffic (captchas, IP
 * bans), but no actual number to size a cadence against. That is an honest
 * judgment call, not a researched one: left at the existing hourly cadence
 * rather than guessing a tighter number has no real backing.
 */
async function refreshBookFeedsFast() {
  const { captureBookFeeds } = await import('./book-feeds.js');
  return captureBookFeeds({ providers: ['oddstrader', 'pinnacle'] });
}

/** The fragile-scrape half of the free book feeds — see refreshBookFeedsFast's header. */
async function refreshBookFeedsSlow() {
  const { captureBookFeeds } = await import('./book-feeds.js');
  return captureBookFeeds({ providers: ['kambi', 'bovada', 'fanduel'] });
}

/** Rotowire (incl. Circa) and SBR game lines — the only free Circa source. */
async function refreshExtraBookFeeds() {
  const { captureExtraBookFeeds } = await import('./book-feeds-extra.js');
  return captureExtraBookFeeds();
}

/** nfelo's QB-adjusted Elo, per-game HFA, pre-regression line and public splits (free CSVs). */
async function refreshNfelo() {
  const { syncNfelo } = await import('./nfelo.js');
  return syncNfelo();
}

/** ESPN FPI (weekly snapshot — no history endpoint) and TeamRankings predictive (Wednesday snapshots). */
async function refreshExternalRatings() {
  const { syncFpi, syncTeamRankings } = await import('./nfl-external-ratings.js');
  const fpi = await syncFpi().catch(error => ({ error: error.message }));
  const teamrankings = await syncTeamRankings({ seasons: [], current: true }).catch(error => ({ error: error.message }));
  return { fpi, teamrankings };
}

/** What the wind forecast said N days before each past kickoff (Open-Meteo previous-runs); fills in newly played games. */
async function refreshForecastHistory() {
  const { syncForecastHistory } = await import('./nfl-weather-history.js');
  const season = Number(process.env.NFL_SEASON) || new Date().getUTCFullYear();
  return syncForecastHistory({ seasons: [season - 1, season] });
}

/** Free player-prop feeds (Action Network, Underdog). No credits, no key. */
async function refreshPropFeeds() {
  const { capturePropFeeds } = await import('./prop-feeds.js');
  return capturePropFeeds();
}

/** Polymarket implied spread/total per game, logged whenever it moves — the line-movement source. */
async function refreshPolymarketLineWatch() {
  const { refreshPolymarketLineWatch: poll } = await import('./polymarket-lines.js');
  return poll();
}

/** Weekly QBR (nflverse) and kickoff-hour weather (Open-Meteo) for the study and the qb_state role. */
async function refreshQbrAndWeather() {
  const { syncQbr } = await import('./nfl-qbr.js');
  const { syncGameWeather } = await import('./nfl-weather.js');
  const season = Number(process.env.NFL_SEASON) || new Date().getUTCFullYear();
  const qbr = await syncQbr({ seasons: [season - 1, season] }).catch(error => ({ error: error.message }));
  const weather = await syncGameWeather({ seasons: [season - 1, season] }).catch(error => ({ error: error.message }));
  return { qbr, weather };
}

/** Beat the close: signal snapshots, zero-unit shadow decisions at the best reachable price, CLV settlement. */
async function refreshBeatTheClose() {
  const { runBeatTheClose } = await import('./beat-the-close.js');
  // Kickoff-hour wind forecasts change as the week goes on; refresh them
  // before the signal snapshot below reads gameWeather() so wind_total sees
  // the current forecast, not whatever was true the last time this ran.
  const { syncForecastWeather } = await import('./nfl-weather.js');
  const forecast = await syncForecastWeather().catch(error => ({ error: error.message }));
  return { forecast, ...runBeatTheClose() };
}

/** Heavy reports (abstention audit, diagnostic, walk-forward, calibration, football-first fit) in worker threads. */
async function refreshReports() {
  const { refreshStaleReports } = await import('./report-cache.js');
  return refreshStaleReports();
}

/**
 * Multi-horizon, pre-event evidence captures. This stays light: it only runs
 * windows that are due and groups requests by NFL week / MLB slate date.
 */
async function runEvidenceDaemon() {
  const { runEvidenceDaemon: capture } = await import('./evidence-daemon.js');
  return capture();
}

/** Capture pregame fantasy forecasts, settle old ones, and test a challenger. */
async function refreshWeeklyLearning() {
  const { runWeeklyLearningCycle } = await import('./weekly-learning.js');
  return runWeeklyLearningCycle();
}

/**
 * Refit the fantasy coordinator (fantasy-coordinator.js) on real historical
 * data through the last fully-settled season. A ~30-40s walk-forward-style
 * example build + ridge fit, verified live — this belongs here, never
 * inline in a trade-lab page load, which only ever reads the persisted
 * result via activeFantasyCoordinatorFit().
 */
async function refreshFantasyCoordinator() {
  const { refitFantasyCoordinator } = await import('./fantasy-coordinator.js');
  return refitFantasyCoordinator();
}

/**
 * Pre-warms trade-engine.js#assetUniverse — by far the most expensive pure
 * function in the fantasy half of the app (a weekly projection engine, VOR
 * board, volatility table and a 400-run distribution per player). It's a
 * fingerprint cache, not a TTL, so it's already correct forever between real
 * data changes — but that also means every roster sync, injury pull or news
 * ingest quietly invalidates it, and the next person to open Trade Lab pays
 * a real 5-6 second cold build for work nobody asked them to wait on.
 * Rebuilding it here, off the request path, for every league someone
 * actually has a membership in, means that cost is almost never paid live.
 */
async function refreshTradeAssetUniverse() {
  const { assetUniverse } = await import('./trade-engine.js');
  const { deriveFormat } = await import('./format.js');
  const leagues = rows(`SELECT DISTINCT l.* FROM leagues l JOIN league_memberships m ON m.league_id = l.id`);
  const results = [];
  for (const lg of leagues) {
    try {
      const { formatKey } = deriveFormat(lg);
      assetUniverse(lg, formatKey);
      results.push({ league_id: lg.id, ok: true });
    } catch (e) { results.push({ league_id: lg.id, ok: false, error: e.message }); }
  }
  return { leagues_warmed: results.filter(r => r.ok).length, failures: results.filter(r => !r.ok) };
}

/**
 * Per-manager behavioural signals for every ESPN league — the counterparty half
 * of the trade engine (manager-signals.js#refreshManagerData).
 *
 * NOTHING IN THE RUNNING APP CALLED THIS UNTIL NOW. The only caller was
 * scripts/build-manager-signals.mjs, launched by hand (or by the off-server
 * refresh loop, which shares this job's `manager_signals` sync_log row and so
 * keeps this one from repeating work it has already done). On the deployed
 * machine that meant the measured manager layer was never built at all: the
 * trade finder's counterparty block — and now
 * GET /api/trades/:leagueId/managers/signals — had nothing to read.
 *
 * IN A WORKER THREAD, AND THAT IS THE WHOLE POINT. node:sqlite is synchronous
 * (server/db/index.js) and this build is CPU-bound by construction: it
 * JSON.parses each league's whole ESPN payload and rolls it up per roster. Run
 * on the main thread it would hold the event loop for the length of that work
 * across five leagues, once per background tick — the exact shape that has
 * already made this app unresponsive (see startScheduler's SCHEDULER_DISABLED
 * note and report-cache.js's header). report-worker.js is the generic "import a
 * module, run one exported function off-thread, post the JSON result" entry
 * point report-cache.js already uses; it opens its own SQLite connection, which
 * WAL allows alongside this thread's. What is left on the main thread is
 * starting the thread and writing one sync_log row.
 */
export function refreshManagerSignalsOffThread({ leagueIds = null, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./report-worker.js', import.meta.url), {
      // `module` is resolved inside report-worker.js, which sits beside manager-signals.js.
      workerData: { module: './manager-signals.js', fn: 'refreshManagerData', args: [{ leagueIds }] },
      env: process.env,
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The build is idempotent and writes one league per transaction, so
      // abandoning a slow run loses at most the leagues it had not reached yet.
      worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(
      `the manager-signals build exceeded its ${Math.round(timeoutMs / 1000)}s budget and was abandoned`)), timeoutMs);
    timer.unref?.();
    worker.once('message', msg => finish(msg?.error ? new Error(msg.error) : null, msg?.value ?? null));
    worker.once('error', e => finish(e));
    // Reached before a message only when the thread died without posting one.
    worker.once('exit', code => finish(new Error(`the manager-signals worker exited with code ${code}`)));
  });
}

/**
 * Every ESPN league's identities and signals, rebuilt where an input moved.
 *
 * A league that fails is isolated by the service itself, so the summary carries
 * every league either way; this then throws when any of them failed, because
 * `runIfStale` records a thrown message as the job's error and a partial build
 * recorded as 'ok' is exactly how a silently empty counterparty layer survives.
 * Nothing is lost by throwing: the message names every failing league.
 */
async function refreshManagerSignals() {
  const out = await refreshManagerSignalsOffThread();
  const leagues = out?.leagues ?? [];
  const detail = {
    chat_db: out?.chat_db ?? null, build_ms: out?.ms ?? null,
    leagues: leagues.map(l => ({
      league_id: l.league_id, name: l.name ?? null, skipped: l.skipped ?? null, error: l.error ?? null,
      chat_corpus: l.chat_corpus ?? null, unchanged: l.unchanged ?? null, signals: l.signals ?? null,
    })),
  };
  const failed = leagues.filter(l => l.error);
  if (failed.length) {
    throw new Error(`manager signals: ${failed.map(l => `league ${l.league_id} — ${l.error}`).join('; ')}`);
  }
  return detail;
}

/**
 * The archetype half of the same layer: draft-revealed preference and the
 * all-play/luck outcomes, which manager-signals.js copies into `manager_signals`
 * as its `draft` and `outcome` sources. Nothing ran this either, so those two
 * sources never appeared for any league.
 *
 * A child process, not an import: scripts/build-manager-archetypes.mjs owns the
 * three-stage order (it runs scripts/luck-panel.mjs for the outcome half), and
 * `execFile` keeps all of it off this thread — the event loop stays free while
 * it runs, though the box's CPU does not, which is why this sits in `heavy`
 * rather than beside the signals job. `--jev` is deliberately not passed: that
 * stage calls a paid gateway and needs AI_GATEWAY_API_KEY, so it stays opt-in
 * (`npm run build:manager-archetypes -- --jev`).
 */
async function refreshManagerArchetypes() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const path = await import('node:path');
  const { PROJECT_ROOT } = await import('../platform/paths.js');
  const script = path.join(PROJECT_ROOT, 'scripts/build-manager-archetypes.mjs');
  const { stdout } = await promisify(execFile)(process.execPath, [script, '--json'],
    { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: 9 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  // The script's --json tail is the whole report; only its summary belongs in a
  // sync_log row, small enough that the Data Health page can show it.
  let report = null;
  try { report = JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch { report = null; }
  const s = report?.summary ?? null;
  return s
    ? { league_seasons: s.league_seasons, managers: s.managers, rows_written: s.rows_written,
      draft_manager_seasons: s.draft_manager_seasons, outcome_manager_seasons: s.outcome_manager_seasons,
      jev: 'not run — opt-in, needs AI_GATEWAY_API_KEY' }
    : { error: 'the archetype build printed no JSON summary',
      tail: stdout.trim().split('\n').at(-1)?.slice(0, 200) ?? null };
}

/**
 * Does an already-approved finding still work on fresh, out-of-sample data?
 * See decay-watch.js's header for why this is a genuinely separate check
 * from audit-registry.js's sealed audits (it never re-runs one) and from
 * nfl-model-watch.js's discovery loop (it watches shipped things, not
 * candidates). Report-only: it flags for human review, never reverts.
 */
async function refreshDecayWatch() {
  const { runDecayWatch } = await import('./decay-watch.js');
  return runDecayWatch();
}

/** Refit the TD calibrator on fixed chronological eras; promotion still requires replication. */
async function refreshNflPropCalibration() {
  const { propReplayRows } = await import('./nfl-props.js');
  const { auditTdCalibration } = await import('./nfl-prop-calibration.js');
  const replay = seasons => propReplayRows(seasons, { useCache: false }).rows;
  return auditTdCalibration({
    trainRows: replay([2022, 2023]), discoveryRows: replay([2024]),
    validationRows: replay([2025]), persist: true
  });
}

/**
 * Insider tweets, budget-capped.
 *
 * The spend cap is enforced inside twitterapi-io.js on every call, not just
 * here — this scheduled job is the normal path, but the guard has to hold
 * even if something calls ingestTwitterInsiders directly. Runs the typed
 * extractor immediately after so a fresh tweet gets a claim on the same
 * cycle it lands, rather than waiting for nfl_news_signals' own run.
 */
async function refreshTwitterInsiders() {
  const { ingestTwitterInsiders } = await import('../news/twitter-ingest.js');
  const { hasKey, twitterSpendStatus } = await import('./twitterapi-io.js');
  if (!hasKey()) return { skipped: true, reason: 'no TWITTERAPI_IO_KEY configured' };
  const ingested = await ingestTwitterInsiders();
  if (ingested.stored > 0) {
    const { syncStructuredNewsSignals } = await import('./nfl-news-signal.js');
    ingested.typed = syncStructuredNewsSignals({ sinceDays: 1 });
  }
  ingested.spend = twitterSpendStatus();
  return ingested;
}

/** Public publisher RSS, normalized and typed on the same cycle. */
async function refreshRssNews() {
  const { ingestAllSources } = await import('../news/ingest.js');
  const { syncStructuredNewsSignals } = await import('./nfl-news-signal.js');
  const { enqueueRecentNewsTriggers } = await import('./nfl-capture-dispatch.js');
  const sources = await ingestAllSources();
  return {
    sources,
    typing: syncStructuredNewsSignals({ sinceDays: 14, limit: 1500 }),
    capture_triggers: enqueueRecentNewsTriggers()
  };
}

/**
 * ESPN's free public news API. Pull the league feed every run and rotate four
 * team feeds, covering all 32 teams every four hours without a 33-request burst.
 */
async function refreshEspnNews() {
  const { syncGeneralNews, syncTeamNewsFeed } = await import('../routes/espn.js');
  const { syncStructuredNewsSignals } = await import('./nfl-news-signal.js');
  const { enqueueRecentNewsTriggers } = await import('./nfl-capture-dispatch.js');
  const teams = ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC',
    'LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'];
  const batchSize = 4;
  const cursor = (Number(lastRun('espn_news')?.runs ?? 0) * batchSize) % teams.length;
  const selected = Array.from({ length: batchSize }, (_, index) => teams[(cursor + index) % teams.length]);
  const general = await syncGeneralNews();
  const teamResults = await Promise.allSettled(selected.map(team => syncTeamNewsFeed(team)));
  return {
    general,
    teams: selected.map((team, index) => teamResults[index].status === 'fulfilled'
      ? { team, added: teamResults[index].value }
      : { team, error: teamResults[index].reason?.message ?? String(teamResults[index].reason) }),
    typing: syncStructuredNewsSignals({ sinceDays: 14, limit: 1500 }),
    capture_triggers: enqueueRecentNewsTriggers()
  };
}

/**
 * Official practice reports. syncInjuries() already existed — pulling
 * nflverse's injuries_{season}.csv.gz release, the real weekly practice
 * report — but was never scheduled, so it only ever ran when someone
 * remembered to trigger it manually. Verified live: 2026's file doesn't
 * exist upstream yet (404) because the season hasn't reached Week 1 —
 * nflverse publishes it once real practice reports start, so this job
 * starts returning real rows the moment that happens, with no code change
 * needed then.
 */
async function refreshNflInjuries() {
  const { syncInjuries } = await import('./nfl-advanced.js');
  const season = Number(process.env.NFL_SEASON) || new Date().getFullYear();
  return syncInjuries([season]);
}

/**
 * Per-team-season head-coach history (nfl-coaches.js). A real, exported sync
 * with no automatic path to ever run: the only route touching this data
 * (GET /research/coaches in nfl-betting.js) reads nfl_team_coaches but never
 * calls syncCoaches, so a table that boom-bust.js, football-context.js and
 * nfl-roster-strength.js all read live for coachChanges/coachFor just sat
 * however stale it was on the last manual run — measured 8 days stale with
 * zero refresh path. Coaching changes are rare and slow-moving (a handful a
 * year, mostly around the coaching carousel in January), so this runs daily,
 * same 'growth' tier as the other low-frequency structural feeds.
 */
async function refreshCoaches() {
  const { syncCoaches } = await import('./nfl-coaches.js');
  return syncCoaches();
}

/**
 * ffopportunity's weekly expected-fantasy-points benchmark (ffopportunity.js).
 * Consumed live by player-week-engine.js projections and nfl-profitability.js,
 * but its only caller anywhere was a standalone manual CLI script
 * (scripts/sync-ffopportunity.mjs) — never wired to the scheduler or any
 * route. Confirmed: exactly one run ever logged, and the table tops out at
 * 2025/week 22 with zero 2026-season rows, because nothing was ever going to
 * add any without this. Tracks the same weekly-usage rhythm as
 * nflverse_weekly_usage (settles a day or two after each week's games), so it
 * gets the same 3-day budget.
 */
async function refreshFfOpportunity() {
  const { syncFfOpportunity } = await import('./ffopportunity.js');
  const season = Number(process.env.NFL_SEASON) || new Date().getFullYear();
  return syncFfOpportunity([season - 3, season - 2, season - 1, season]);
}

/** The transaction wire — signings, releases, IR moves, from ESPN's public transactions API. */
async function refreshNflTransactions() {
  const { syncTransactions } = await import('./nfl-transactions.js');
  const result = await syncTransactions();
  if (result.stored > 0) {
    const { syncStructuredNewsSignals } = await import('./nfl-news-signal.js');
    result.typed = syncStructuredNewsSignals({ sinceDays: 1 });
  }
  return result;
}

/** Key-free annual rookie sources; cheap enough to check weekly in draft season. */
async function refreshNflRookiePublic() {
  const { syncPublicRookieEvidence } = await import('./nfl-rookie-ingest.js');
  return syncPublicRookieEvidence({ fromSeason: 2000,
    throughSeason: Number(process.env.NFL_SEASON) || new Date().getFullYear() });
}

/**
 * CFBD college usage-share + PPA signal for the incoming rookie class only.
 * syncCfbdSeason had zero callers — cfbd_player_season was always empty, so
 * draft-assist.js's college_signal (wired on the read side already) silently
 * returned null for every rookie forever.
 *
 * Scoped to one season deliberately, not a historical backfill: draft-assist
 * only ever looks up a player with experience === 0 at `draft_year - 1` (see
 * cfbd.js), and a rookie's draft_year is the current NFL season — so the only
 * college season that can ever be read right now is last season's. Widen this
 * only if something starts needing CFBD signal for OLDER draft classes too;
 * syncCfbdSeason fetches every FBS player for one season per call, so a
 * multi-decade sync on a recurring timer would be needless load for a feature
 * that only ever reads the newest class. Graceful no-op, same convention as
 * every other optional-key feed here, when CFBD_API_KEY is not configured.
 */
async function refreshCfbdRookieSeason() {
  const { syncCfbdSeason, hasKey } = await import('./cfbd.js');
  if (!hasKey()) return { skipped: true, reason: 'CFBD_API_KEY not configured' };
  const season = (Number(process.env.NFL_SEASON) || new Date().getFullYear()) - 1;
  const result = await syncCfbdSeason(season);
  return result ?? { skipped: true, reason: 'no data returned' };
}

/** Capture the live prop market, and settle anything the week has now decided. */
async function refreshPropCapture() {
  const { capturePropMarket, settlePropQuotes, finalizeClosingSnapshots, propClvStatus,
    reconcilePropQuoteMatches } = await import('./nfl-prop-clv.js');
  const { currentNflWeek } = await import('./weekly-learning.js');
  const status = propClvStatus();
  if (!status.has_key) return { skipped: true, reason: 'no ODDS_API_KEY; prop CLV archive stays empty' };
  const season = Number(process.env.NFL_SEASON) || new Date().getFullYear();
  const current = currentNflWeek(season);
  const captured = await capturePropMarket({ season, week: current.week, scheduled: true });
  const closing = finalizeClosingSnapshots();
  const due = rows(`SELECT DISTINCT season,week FROM nfl_prop_clv
                    WHERE settled=0 AND season IS NOT NULL AND week IS NOT NULL
                      AND commence_time <= ?`, new Date().toISOString());
  const settlement = due.map(x => ({ ...x, ...settlePropQuotes(x) }));
  // Deliberately routine (force defaults to false): only re-touches rows still
  // NULL/'legacy_unclassified' so every tick stays cheap. To re-run today's
  // matcher against rows a since-fixed matcher bug stamped with some other
  // terminal status, run scripts/backfill-prop-quote-reconcile.mjs once —
  // do not flip this to force:true, that would force-rescan the whole table
  // every tick.
  return { captured, closing, settlement, reconciliation: reconcilePropQuoteMatches(), archive: propClvStatus() };
}

/**
 * The free-provider counterpart: captureFreePropMarket() reads the quotes
 * prop-feeds.js already stored (Action Network, Underdog), matches them to
 * the model and devigs them into nfl_prop_clv. No key, no credits, so this
 * runs regardless of whether refreshPropCapture is skipped for lack of one.
 */
async function refreshFreePropClv() {
  const { captureFreePropMarket, settlePropQuotes, reconcilePropQuoteMatches, propClvStatus } = await import('./nfl-prop-clv.js');
  const captured = captureFreePropMarket();
  const due = rows(`SELECT DISTINCT season,week FROM nfl_prop_clv
                    WHERE settled=0 AND season IS NOT NULL AND week IS NOT NULL
                      AND commence_time <= ?`, new Date().toISOString());
  const settlement = due.map(x => ({ ...x, ...settlePropQuotes(x) }));
  // See the comment on the same call in refreshPropCapture above: routine,
  // non-forced, by design. Use scripts/backfill-prop-quote-reconcile.mjs for
  // a one-time force:true re-pass after a matcher fix.
  return { captured, settlement, reconciliation: reconcilePropQuoteMatches(), archive: propClvStatus() };
}

/** Turn fresh reporting into typed, cutoff-safe context shared by fantasy and betting. */
async function refreshNflNewsSignals() {
  const { syncStructuredNewsSignals, syncAiNewsSignals, newsSignalCoverage } = await import('./nfl-news-signal.js');
  const rules = syncStructuredNewsSignals({ sinceDays: 14 });
  const ai = await syncAiNewsSignals({ sinceDays: 7, limit: 20 });
  return { rules, ai, coverage: newsSignalCoverage() };
}

/**
 * Re-shop every currently open spread/total pick against the live multi-book
 * snapshot and log the result — see nfl-pick-watch.js's header for the full
 * scope (a monitoring/alert board, not a bet router; every row stays at
 * recommended_stake_units=0 until model-governance.js says a champion is
 * actually in production for that market).
 */
async function refreshPickWatch() {
  const { reshopOpenPicks } = await import('./nfl-pick-watch.js');
  return reshopOpenPicks();
}

/** Run the report-only evaluation pass. */
async function refreshModelWatch() {
  const { runModelWatch } = await import('./nfl-model-watch.js');
  // Head discovery is the expensive part and only changes when a season lands;
  // the drift checks are what justify a daily cadence.
  const r = runModelWatch({ includeHeadSearch: false });
  return { alerts: r.alerts, findings: r.findings.length, production_eligible: r.production_eligible };
}

/**
 * Turn each newly finalized NFL week into cutoff-safe features, settled labels,
 * and a recorded next-week fit. The service checks the warehouse first, so the
 * expensive downloads run once per published week rather than once per timer.
 */
async function refreshNflModelGrowth() {
  const { runNflModelGrowthCycle } = await import('./nfl-model-growth.js');
  return runNflModelGrowthCycle();
}

/**
 * The independent half of the offseason-blackout fix (nfl-offseason-cycle.js):
 * depth charts and injury reports must not wait for "a game just finalized,"
 * because nothing finalizes for ~6 months every year. Checked on a short,
 * flat tick like every other job here, but the function itself decides
 * whether real work is actually due under its own calendar-aware cadence —
 * so this entry being "live tier" means "check often," not "refetch often."
 */
async function refreshNflOffseasonDepthInjury() {
  const { refreshNflOffseasonDepthAndInjuries } = await import('./nfl-offseason-cycle.js');
  return refreshNflOffseasonDepthAndInjuries();
}

/**
 * The forward decision ledger for the CURRENT week, unattended.
 *
 * Until now the only writer of `nfl_pick_decisions`, the pregame snapshots and
 * the expert council's forward rows was a human clicking a button. A frozen
 * forward ledger that depends on someone remembering to click is not frozen.
 * This job derives the live week from the schedule, records every decision
 * (including every abstention) under the production policy, freezes pregame
 * context, and captures the council. It stakes nothing and locks no picks.
 *
 * Stage 2 engine unification: this job used to call BOTH `persistPickDecisions`
 * (an independent UPSERT straight from `board`) AND `recordDecisionRun` --
 * two writes derived from the same board rather than one derived from the
 * other. `persistPickDecisions` is gone; `recordDecisionRun` is now the only
 * write this job makes, and it regenerates `nfl_pick_decisions` itself from
 * the tape rows it just wrote (see nfl-decision-tape.js's "ONE WRITER" note).
 * `dataIdentityStatus` stays 'unfrozen_live_tables': this job runs on a
 * staleness timer against the current week, not against one game's T-60
 * cutoff, so it has no frozen packet to cite (that path is t60-runner.js's).
 * The observation identity is stamped with this tick's own wall-clock time so
 * a later tick whose board genuinely changed (a line moved) is recorded as a
 * new observation rather than colliding with an old one under a shared key --
 * recordDecisionRun throws on exactly that collision, by design.
 */
async function refreshNflDecisionLedger() {
  const { currentNflWeek } = await import('./weekly-learning.js');
  const { autoPickDecisionBoard } = await import('./nfl-auto-picks.js');
  const { recordDecisionRun } = await import('./nfl-decision-tape.js');
  const { NFL_PRODUCTION_POLICY } = await import('./nfl-policy.js');
  const { capturePregameSnapshots } = await import('./nfl-pregame.js');
  const { captureForwardExpertWeek } = await import('./nfl-expert-council.js');
  const { season, week } = currentNflWeek();
  if (!Number.isInteger(week) || week < 1 || week > 18) return { skipped: true, reason: 'no regular-season week is upcoming' };
  const board = autoPickDecisionBoard(season, week);
  const decidedAt = new Date().toISOString();
  let tape = null;
  try {
    tape = recordDecisionRun(season, week, board, {
      observation: {
        experimentId: 'nfl-decision-ledger-scheduled-v1', horizon: 'scheduled_forward_ledger',
        cutoffAt: decidedAt, jobId: 'scheduler:refreshNflDecisionLedger',
        observationId: `ledger:${season}:${week}:${NFL_PRODUCTION_POLICY.id}:${NFL_PRODUCTION_POLICY.version}:${decidedAt}`
      },
      policyId: NFL_PRODUCTION_POLICY.id, policyVersion: NFL_PRODUCTION_POLICY.version,
      computationStatus: board.decisions?.length ? 'complete' : 'unavailable',
      dataIdentityStatus: 'unfrozen_live_tables',
      decidedAt, computationEndedAt: decidedAt,
      note: 'scheduler.js refreshNflDecisionLedger'
    });
  } catch (e) { tape = { error: e.message }; }
  let pregame = null, council = null;
  try { pregame = capturePregameSnapshots(season, week); } catch (e) { pregame = { error: e.message }; }
  try { council = captureForwardExpertWeek(season, week, { horizon: 'scheduled' }); } catch (e) { council = { error: e.message }; }
  return { season, week, decisions: board.decisions?.length ?? null, selected: board.selected?.length ?? 0,
    abstention_reasons: board.abstention_reasons ?? null, decision_run: tape,
    pregame, expert_council: council,
    staking: 'zero units; this ledger records decisions, it does not place or size bets' };
}

/**
 * Each job carries how stale it is allowed to get. These are tuned to how fast
 * the underlying data actually changes — a schedule shifts hourly during a
 * slate, box scores only settle after games end, and NFL lines move all week.
 */
/**
 * The experiment this runner's observations belong to. Declared here rather
 * than generated per pass, because a prospective observation's identity has to
 * be stable across restarts -- an experiment id that changed on every boot
 * would make every pass look like a new experiment with no history.
 */
const T60_EXPERIMENT_ID = 'nfl-spread-t60-prospective-v1';

export const JOBS = {
  mlb_schedule: { run: refreshMlbSchedule, maxAgeMinutes: 60, tier: 'live', label: 'MLB schedule and results' },
  mlb_logs: { run: refreshMlbLogs, maxAgeMinutes: 6 * 60, tier: 'heavy', label: 'MLB player game logs' },
  mlb_boxscores: { run: refreshMlbBoxscores, maxAgeMinutes: 30, tier: 'live', label: 'MLB final boxscore settlement' },
  mlb_probables: { run: refreshMlbProbables, maxAgeMinutes: 90, tier: 'live', label: 'MLB probable starters' },
  mlb_tomorrow_picks: { run: prepareTomorrowPicks, maxAgeMinutes: 90, tier: 'heavy', label: "Tomorrow's MLB picks" },
  player_rosters: { run: refreshPlayerRosters, maxAgeMinutes: 3 * 60, tier: 'live',
    label: 'Player team assignments — the actual fix for stale roster spots' },
  espn_rosters: { run: refreshEspnRosters, maxAgeMinutes: 24 * 60, tier: 'growth',
    label: 'ESPN per-team roster feed (cuts, signings, practice-squad moves)' },
  league_rosters: { run: refreshLeagueRosters, maxAgeMinutes: 60, tier: 'live',
    label: "Each connected league's own roster (trades, waivers, drops) — was manual-only" },
  // Free (ESPN scoreboard). Hourly, so the last stored line before kickoff is a
  // usable closing reference for settlement and so finals land within the hour.
  nfl_lines: { run: refreshNflLines, maxAgeMinutes: 60, tier: 'live', label: 'NFL betting lines and finals (ESPN, free)' },
  nfl_forward_settle: { run: refreshForwardSettlement, maxAgeMinutes: 30, tier: 'live',
    label: 'Settle forward picks (CLV grading) shortly after a game goes final' },
  nfl_line_snapshots: { run: refreshNflLineSnapshots, maxAgeMinutes: 12 * 60, tier: 'metered', label: 'Multi-book line snapshots (CLV)' },
  nfl_sgo_snapshot: { run: refreshSportsGameOdds, maxAgeMinutes: 30, tier: 'metered',
    label: 'SportsGameOdds multi-book snapshot (free, opt-in, own budget)' },
  // Measured live on 2026-09-19 (SLOW_JOB_WARN_MS instrumentation): this job
  // alone took 19.7-28.6s per run, on a 60-minute staleness budget. Sitting in
  // 'live' meant it was still CHECKED every 90s, and whenever due it ran
  // inline in the middle of that tight tier's sequential loop, stalling the
  // genuinely time-critical live jobs (pick watch, play-by-play, line watch)
  // behind it. 'metered' is checked every few minutes instead, which such an
  // hour-scale budget can't tell apart from 90s — see beat_the_close below,
  // the live tier's other big contributor to the same measured stall.
  nfl_prop_feeds: { run: refreshPropFeeds, maxAgeMinutes: 60, tier: 'metered',
    label: 'Free player-prop quotes: Action Network, Underdog' },
  nfl_book_feeds_extra: { run: refreshExtraBookFeeds, maxAgeMinutes: 60, tier: 'live',
    label: 'Free game lines: Rotowire (Circa, DK, FD, MGM, Caesars, BetRivers, Fanatics, theScore, Betr) and SBR (bet365, Hard Rock)' },
  nfelo_sync: { run: refreshNfelo, maxAgeMinutes: 6 * 60, tier: 'growth',
    label: 'nfelo: QB-adjusted Elo, per-game HFA, pre-regression line, public splits' },
  nfl_external_ratings: { run: refreshExternalRatings, maxAgeMinutes: 24 * 60, tier: 'growth',
    label: 'ESPN FPI weekly snapshot and TeamRankings predictive (Wednesday)' },
  nfl_forecast_history: { run: refreshForecastHistory, maxAgeMinutes: 24 * 60, tier: 'heavy',
    label: 'Open-Meteo previous-runs: what the wind forecast said before each played kickoff' },
  nfl_book_feeds_fast: { run: refreshBookFeedsFast, maxAgeMinutes: 5, tier: 'live',
    label: 'Free multi-book quotes (API-like, polled fast): Pinnacle, OddsTrader (11 books)' },
  nfl_book_feeds_slow: { run: refreshBookFeedsSlow, maxAgeMinutes: 60, tier: 'live',
    label: 'Free multi-book quotes (undocumented scrapes, kept conservative): BetRivers (Kambi), Bovada, FanDuel (direct)' },
  nfl_qbr_weather: { run: refreshQbrAndWeather, maxAgeMinutes: 24 * 60, tier: 'growth',
    label: 'Weekly ESPN QBR and kickoff-hour weather for the current and prior season' },
  // Measured live 2026-09-19: 20.2-22.0s per run, also on an hour-scale
  // budget (maxAgeMinutes: 60) — see nfl_prop_feeds above for why that
  // combination belongs on the 'metered' cadence, not 'live'. Together these
  // two jobs were the majority of the live tier's 67.4s-per-pass total.
  beat_the_close: { run: refreshBeatTheClose, maxAgeMinutes: 60, tier: 'metered',
    label: 'Beat the close: signal snapshots, zero-unit shadow decisions, CLV settlement' },
  // Pure SQLite reads plus rankBooks (no network call of its own), so this
  // rides the live tier's 90-second tick at a genuinely short cadence — the
  // market snapshots it reads are refreshed no faster than every 5 minutes
  // anyway (nfl_book_feeds_fast above), so anything shorter would just
  // re-log an unchanged comparison.
  nfl_pick_watch: { run: refreshPickWatch, maxAgeMinutes: 5, tier: 'live',
    label: 'Re-shop every open pick against the live market and log the result (monitoring only, see nfl-pick-watch.js)' },
  /**
   * The durable T-60 operation (Codex plan section 7, correction C12).
   *
   * The correction's finding was that `cutoffBatches`/`sequentialCapacity` had
   * no production caller at all -- "a GET packet route is not a scheduled
   * collector." This is the caller. It runs on the LIVE tier because a cutoff
   * is a moment: a pass that arrives thirty minutes late has missed every
   * cutoff in between, and the runner will correctly record those as missed
   * prospective observations rather than capture them late.
   *
   * It reads the schedule, opens an observation ahead of each cutoff, freezes
   * the packet when the cutoff arrives, and marks anything still uncaptured
   * afterwards as missed. It does NOT place bets and does not grant any
   * forecast authority; it records what was knowable and when.
   */
  nfl_t60_runner: {
    run: async () => {
      const [m, { currentNflWeek }] = await Promise.all([
        import('../betting/nfl/strategy/t60-runner.js'),
        import('./weekly-learning.js')
      ]);
      const { season, week } = currentNflWeek();
      if (!Number.isFinite(season) || !Number.isFinite(week)) {
        return { skipped: 'no current NFL week resolved' };
      }
      return m.runT60Pass({ season, week, experimentId: T60_EXPERIMENT_ID });
    },
    maxAgeMinutes: 5, tier: 'live',
    label: 'T-60 prospective capture: open, freeze and account for every scheduled game\'s cutoff' },
  nfl_learned_shadow: {
    run: async () => {
      const [m, { currentNflWeek }] = await Promise.all([
        import('../betting/nfl/strategy/learned-shadow-runner.js'), import('./weekly-learning.js')
      ]);
      const { season, week } = currentNflWeek();
      if (!Number.isFinite(season) || !Number.isFinite(week)) return { skipped: 'no current NFL week resolved' };
      const result = await m.runLearnedShadowPass({ season, week });
      if (!result.ok) throw new Error(result.reason ?? 'learned shadow pass has failed observations');
      return result;
    },
    maxAgeMinutes: 60, tier: 'growth', timeoutMs: 240_000,
    label: 'Weekly trained margin model: frozen pregame shadow forecasts, zero stake' },
  // Polymarket's own published limits (Gamma ~400 req/s, CLOB ~900 req/s —
  // docs.polymarket.com/api-reference/rate-limits) leave enormous headroom
  // over a poll this infrequent; tightened from 15 to 3 minutes so a real
  // move shows up on this project's live board closer to when it happens.
  polymarket_line_watch: { run: refreshPolymarketLineWatch, maxAgeMinutes: 3, tier: 'live',
    label: 'Polymarket implied spread/total movement (line-movement source)' },
  // Free — ESPN's public scoreboard, no key and no quota — so this runs far more
  // often than the metered jobs. It is the trigger that tells the paid capture
  // above when a credit is actually worth spending.
  espn_line_watch: { run: () => import('./nfl-espn-line-watch.js').then(m => m.refreshEspnLineWatch()),
    maxAgeMinutes: 15, tier: 'live', label: 'Reference-line movement detector (free, no quota)' },
  // Also free and unmetered. It only fetches games that are actually in
  // progress, so on a Tuesday this costs one scoreboard request and stops. On a
  // Sunday it keeps the live simulator fed with real game state, and every play
  // it stores also sharpens the team profiles the pregame model runs on.
  nfl_play_by_play: { run: () => import('./nfl-espn-pbp.js').then(m => m.pollLiveGames({})),
    maxAgeMinutes: 3, tier: 'live', label: 'Live NFL play-by-play (free, no quota)' },
  // Free and unauthenticated, like the ESPN feeds. Kalshi is an order book
  // rather than a bookmaker's number, and its trade tape carries size and
  // aggressor side — information no sportsbook feed exposes.
  // Kalshi publishes a ~30 req/s budget for public market data
  // (docs.kalshi.com/getting_started/rate_limits) — a poll every few minutes
  // is negligible against that, so this moved from 20 minutes to 3.
  prediction_markets: { run: () => import('./prediction-markets.js').then(async m => ({
    quotes: await m.captureKalshi({}), flow: await m.captureKalshiFlow({}) })),
  maxAgeMinutes: 3, tier: 'live', label: 'Prediction market quotes and trade tape (free)' },
  // Free, no key. Polymarket is the only venue measured cheaper than Kalshi,
  // and its hourly price history is the only source here that can show how a
  // price moved around a news event after the fact. Polymarket's published
  // Gamma/CLOB rate limits (see polymarket_line_watch above) leave the same
  // headroom, so this also moved from 30 minutes to 3.
  polymarket: { run: () => import('./polymarket.js').then(async m => ({
    markets: await m.ingestPolymarketNfl({ maxPages: 4 }),
    books: await m.captureOrderBooks({ minVolume: 1000, limit: 40 }) })),
  maxAgeMinutes: 3, tier: 'live', label: 'Polymarket NFL markets and order books (free)' },
  // Free and keyless for discovery. Transcription shells out to yt-dlp, which
  // is why this sits on a slow cadence rather than the 90-second tick.
  press_conferences: { run: () => import('./press-conference.js').then(async m => {
    const teams = Object.keys(m.TEAM_CHANNEL_HANDLES);
    let pressers = 0, statements = 0;
    for (const t of teams) {
      const d = await m.discoverVideos(t);
      if (d.error) continue;
      pressers += d.pressers ?? 0;
      for (const v of (d.found ?? []).filter(x => x.is_presser).slice(0, 1)) {
        const tr = await m.fetchTranscript(v.video_id);
        if (!tr.error) statements += (m.extractAvailability(v.video_id).statements ?? 0);
      }
    }
    return { teams: teams.length, pressers, statements };
  }), maxAgeMinutes: 6 * 60, tier: 'heavy', label: 'Team press conferences (YouTube, transcribed)' },
  evidence_daemon: { run: runEvidenceDaemon, maxAgeMinutes: 5, tier: 'live', label: 'Forward evidence capture windows' },
  nfl_weekly_learning: { run: refreshWeeklyLearning, maxAgeMinutes: 6 * 60, tier: 'heavy',
    label: 'Fantasy weekly snapshot, settlement, and challenger retraining' },
  // Enabled by default, unlike broad heavy research sweeps. Most checks are a
  // few SQLite reads; downloads and fitting only start when a newly finalized
  // week is ahead of the feature warehouse.
  nfl_model_growth: { run: refreshNflModelGrowth, maxAgeMinutes: 6 * 60, tier: 'growth',
    label: 'NFL finalized-week ingest, shadow settlement, and next-week fit' },
  // Checked every 6h like model_growth, but genuinely decoupled from it — this
  // is what actually runs during the offseason, when model_growth's own
  // "newly finalized week" gate is never true for months at a time.
  nfl_offseason_depth_injury: { run: refreshNflOffseasonDepthInjury, maxAgeMinutes: 6 * 60, tier: 'growth',
    label: 'Depth chart / injury refresh on a calendar-aware cadence, independent of game finalization' },
  nfl_decision_ledger: { run: refreshNflDecisionLedger, maxAgeMinutes: 3 * 60, tier: 'growth',
    label: 'NFL current-week decision ledger, pregame snapshots, and expert council freeze (zero units)' },
  nfl_reports: { run: refreshReports, maxAgeMinutes: 3 * 60, tier: 'growth',
    label: 'Heavy dashboard reports computed off-thread (worker) and served from SQLite' },
  nfl_prop_calibration: { run: refreshNflPropCalibration, maxAgeMinutes: 24 * 60, tier: 'heavy',
    label: 'NFL chronological prop calibration registry' },
  fantasy_coordinator_refit: { run: refreshFantasyCoordinator, maxAgeMinutes: 24 * 60, tier: 'heavy',
    label: 'Fantasy coordinator refit (ensemble/game-script blend, walk-forward validated)' },
  // 'growth' tier, not 'live' — this is a background warm-up for a cache
  // that is already correct indefinitely on its own; the point is only to
  // move a ~5-6s cold build off of someone's real page load. maxAgeMinutes
  // below the tier's own ~30-minute tick just means it never gets skipped as
  // "not stale yet" — it runs every tick, well ahead of how often the
  // fantasy side's own inputs actually change (injuries every 6h, news hourly).
  trade_asset_universe_warm: { run: refreshTradeAssetUniverse, maxAgeMinutes: 20, tier: 'growth',
    label: 'Pre-warm the trade engine\'s asset universe for every league in use' },
  /*
   * The measured manager layer. 'growth', not 'heavy', deliberately:
   *   - it makes no network request at all — it reads the league payload
   *     league_rosters has already stored, the transaction rows beside it, and
   *     the chat DB read-only — so there is nothing here to meter;
   *   - it computes in a worker thread (refreshManagerSignalsOffThread), so the
   *     event loop is never held while it runs, and the reason the `heavy` tier
   *     exists — long compute ON THE MAIN THREAD — does not apply to it;
   *   - `heavy` is gated behind AUTO_HEAVY_SYNC, and a signal layer that only
   *     builds behind a flag is the "silently never runs" failure this file has
   *     already had to fix twice (see decay_watch and nfl_model_growth).
   * maxAgeMinutes matches league_rosters, its main input. The sync_log row is
   * shared with scripts/build-manager-signals.mjs, so an off-server build counts
   * as this job having run and neither path repeats the other's work.
   */
  manager_signals: { run: refreshManagerSignals, maxAgeMinutes: 60, tier: 'growth', timeoutMs: 150_000,
    label: 'Who each manager is and what we have measured about him, every ESPN league (worker thread)' },
  /*
   * The archetype half: 24 h, because a draft happens once a season and the
   * outcome metrics move once a week. 'heavy' because it spawns a child process
   * that replays every league-season — off this thread, but not off this box.
   * The off-server refresh loop runs it by name whatever its tier
   * (scripts/refresh-live-data.mjs FANTASY_LIVE_JOBS).
   */
  manager_archetypes: { run: refreshManagerArchetypes, maxAgeMinutes: 24 * 60, tier: 'heavy', timeoutMs: 10 * 60_000,
    label: 'Manager archetypes: draft-revealed preference and all-play/luck outcomes (child process)' },
  /*
   * Prop quote capture. Every hour during a slate, because a prop line that is
   * only observed once cannot yield closing-line value — CLV needs the price
   * when the bet would have been placed AND the price at close.
   *
   * This is the job that unblocks the central open question. Spreads are a
   * settled negative (0 of 21 models beat 15,096 closing lines); props have
   * never been measured against a real price at all, because this archive has
   * always been empty. No key configured means it no-ops harmlessly.
   */
  nfl_prop_capture: { run: refreshPropCapture, maxAgeMinutes: 60, tier: 'metered',
    label: 'NFL prop market capture (CLV evidence)' },
  nfl_prop_clv_free: { run: refreshFreePropClv, maxAgeMinutes: 60, tier: 'live',
    label: 'Free prop quotes matched to the model and devigged into CLV evidence' },
  rss_news: { run: refreshRssNews, maxAgeMinutes: 15, tier: 'live',
    label: 'Publisher RSS news, normalized and typed' },
  espn_news: { run: refreshEspnNews, maxAgeMinutes: 30, tier: 'live',
    label: 'ESPN league and rotating team news feeds (free)' },
  nfl_news_signals: { run: refreshNflNewsSignals, maxAgeMinutes: 60, tier: 'live',
    label: 'Typed NFL news, injury and role signals' },
  /*
   * The evaluation loop. Proposes and reports; cannot promote. Daily is the
   * right cadence — it is watching for drift and for candidates that start
   * clearing the bar as data accumulates, neither of which moves hourly.
   */
  nfl_model_watch: { run: refreshModelWatch, maxAgeMinutes: 24 * 60, tier: 'heavy',
    label: 'Model drift watch and candidate discovery (report only)' },
  /*
   * Distinct from nfl_model_watch above: that job re-evaluates CANDIDATES
   * against sealed audits. This job re-evaluates things ALREADY APPROVED
   * and shipped (the fantasy coordinator's weights, the anytime-TD
   * calibrator) against fresh, strictly-post-approval data, using the
   * always-valid sequential test so it can be checked again every day as
   * more data lands without inflating the false-positive rate. 'growth'
   * tier so it actually runs on the default (non-AUTO_HEAVY_SYNC) timer —
   * a decay check that only ever ran behind a flag nobody sets would be
   * exactly the "silently never runs" bug this project has already found
   * and fixed several times over.
   */
  decay_watch: { run: refreshDecayWatch, maxAgeMinutes: 24 * 60, tier: 'growth',
    label: 'Post-approval decay watch: do shipped findings still hold on fresh data? (report only)' },
  twitter_insiders: { run: refreshTwitterInsiders, maxAgeMinutes: 4 * 60, tier: 'metered',
    label: 'NFL insider tweets — typed injury/role claims (budget-capped, ~$0.003/handle)' },
  nfl_injuries: { run: refreshNflInjuries, maxAgeMinutes: 6 * 60, tier: 'live',
    label: 'Official practice reports (nflverse injuries release)' },
  nfl_transactions: { run: refreshNflTransactions, maxAgeMinutes: 30, tier: 'live',
    label: 'Transaction wire — signings, releases, IR moves (ESPN public API)' },
  nfl_rookie_public: { run: refreshNflRookiePublic, maxAgeMinutes: 7 * 24 * 60, tier: 'heavy',
    label: 'NFL draft and combine rookie evidence (nflverse, key-free)' },
  cfbd_rookie_usage: { run: refreshCfbdRookieSeason, maxAgeMinutes: 7 * 24 * 60, tier: 'heavy',
    label: "Incoming rookie class's final college season usage share + PPA (CFBD, key-gated)" },
  team_analyses: { run: refreshTeamAnalyses, maxAgeMinutes: 4 * 60, tier: 'heavy',
    label: "X's & O's writeups — self-limited to teams with news newer than their analysis" },
  nfl_coaches: { run: refreshCoaches, maxAgeMinutes: 24 * 60, tier: 'growth',
    label: 'Per-team-season head-coach history (nflverse/nfldata games.csv)' },
  ffopportunity: { run: refreshFfOpportunity, maxAgeMinutes: 3 * 24 * 60, tier: 'growth',
    label: 'ffopportunity weekly expected-fantasy-points benchmark' }
};

/** Runs one job if it is older than its threshold. `force` ignores the age. */
/** The budget a job gets before the tier abandons it. Overridable per job. */
const DEFAULT_JOB_TIMEOUT_MS = 120_000;

// Threshold for the "a job ran long" warning below. Not a timeout — jobs still
// get their full budget (DEFAULT_JOB_TIMEOUT_MS) — just a number worth seeing.
// Picked from server/index.js:143's own bound: an HTTP request queued behind a
// blocking synchronous call feels instant under ~100ms and noticeable well
// before a full second, so 750ms is "found it" territory, not noise.
const SLOW_JOB_WARN_MS = 750;

export async function runIfStale(name, { force = false } = {}) {
  const job = JOBS[name];
  if (!job) return { job: name, error: 'unknown job' };
  const age = minutesSince(name);
  if (!force && age < job.maxAgeMinutes) {
    return { job: name, skipped: true, age_minutes: Math.round(age), max_age_minutes: job.maxAgeMinutes };
  }
  const startedAt = Date.now();
  try {
    // EVERY JOB IS TIME-BOUND, AND THIS IS NOT DEFENSIVE PROGRAMMING.
    //
    // The live tier runs 26 jobs SEQUENTIALLY in one `for ... await` loop.
    // `nfl_t60_runner` — the prospective capture whose evidence cannot be
    // recreated — is 14th. Job 4 is `player_rosters`, which fetches ESPN's
    // fantasy API; undici applies no response timeout of its own, so a server
    // that accepts the socket and then stalls holds that promise forever.
    //
    // And the failure is self-perpetuating rather than transient. `record()`
    // runs only AFTER `job.run()` returns, so a hung job never records, stays
    // stale, and is re-run on the next tick — hanging again at position 4,
    // never reaching 14. `sync_log` meanwhile still shows `nfl_t60_runner: ok`
    // from its last good run, because a job that stopped being CALLED looks
    // identical to a healthy one.
    //
    // So one stalled ESPN request on a Sunday afternoon silently ends the
    // capture for the life of the process. A timeout converts that into a
    // recorded error and lets the loop reach the jobs behind it.
    const timeoutMs = job.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    let timer;
    const detail = await Promise.race([
      job.run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `job '${name}' exceeded its ${Math.round(timeoutMs / 1000)}s budget and was abandoned so the ` +
          'rest of the tier could run')), timeoutMs);
        timer.unref?.();
      })
    ]).finally(() => clearTimeout(timer));
    // A job that chose not to do its work (reserve hold, no key, no due window)
    // is not healthy; recording it as 'ok' told every freshness view that a
    // capture happened when nothing did.
    record(name, detail?.skipped === true ? 'skipped' : 'ok', detail);
    // node:sqlite's DatabaseSync is fully synchronous (server/db/index.js) — a
    // slow query inside job.run() blocks this process, not just this job, so
    // every other request queues behind it for the same span this prints.
    // Found empirically 2026-09-19 chasing a scheduler-caused freeze that a
    // fresh/small database can't reproduce (see the note above runIfStale):
    // this is the number to read off Nick's real box, not this sandbox's.
    const durationMs = Date.now() - startedAt;
    if (durationMs >= SLOW_JOB_WARN_MS) {
      console.warn(`[scheduler] '${name}' took ${(durationMs / 1000).toFixed(1)}s ` +
        '— every request was blocked for that long while it ran');
    }
    return { job: name, ran: true, detail, duration_ms: durationMs };
  } catch (e) {
    // A failed refresh must never take a page down — the stale data is still
    // servable, and the failure is recorded so it is visible rather than silent.
    //
    // The record itself is a database write, and on a 9.8 GB WAL file with a
    // live server and concurrent readers it can exceed the busy timeout. If it
    // throws here it escapes runIfStale, escapes the tier loop, and is
    // swallowed by the timer's `.catch(() => {})` — killing the remainder of
    // the pass with no output at all. The recording of a failure must not be
    // able to cause a larger one.
    try { record(name, 'error', e.message); } catch { /* the pass continues */ }
    return { job: name, ran: true, error: e.message, duration_ms: Date.now() - startedAt };
  }
}

export async function runAllStale({ force = false } = {}) {
  const out = [];
  for (const name of Object.keys(JOBS)) out.push(await runIfStale(name, { force }));
  return out;
}

/* ----------------------------------------------------------------- read-path */

let inFlight = null;

/**
 * Called on page loads that need current data.
 *
 * Deliberately fire-and-forget: the request returns immediately with whatever
 * is stored, and the refresh lands in the background for the next load. Blocking
 * a page render on a network sync would make the app feel broken every time the
 * MLB API is slow.
 *
 * Concurrent calls share one in-flight refresh so a page with four components
 * does not trigger four syncs.
 */
export function refreshInBackground(jobs = ['mlb_schedule']) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try { for (const j of jobs) await runIfStale(j); }
    finally { inFlight = null; }
  })();
  return inFlight;
}

/* ------------------------------------------------------------------- timer */

let timer = null;
let liveTimer = null;

/**
 * Starts the background timer. Runs a catch-up pass shortly after boot — an app
 * that has been closed for a week should not wait for the first interval — then
 * settles into a regular check.
 */
const jobsInTier = tier => Object.entries(JOBS).filter(([, j]) => j.tier === tier).map(([n]) => n);

/**
 * Starts the background timers.
 *
 * There are two, deliberately, because the jobs in this file have wildly
 * different costs and the previous single-timer design could not express that.
 * It ran a hardcoded list of six jobs every thirty minutes and everything else
 * only when AUTO_HEAVY_SYNC was set — which in practice meant never. The free
 * ESPN feeds were the casualties: the reference-line movement detector had run
 * three times in the life of the database despite declaring a fifteen-minute
 * cadence, and the live play-by-play poller had never run at all. A model
 * cannot react to information it is not being given.
 *
 * LIVE tier — free, keyless, fast, and the only tier where latency matters.
 * Play-by-play during a game, line movement, the transaction wire. Polled on a
 * short tick, because a fifteen-minute job on a thirty-minute timer is a
 * thirty-minute job, and a three-minute job on it is useless.
 *
 * METERED tier — costs API credits or counts against a spend cap. Runs on the
 * slow tick and each job still enforces its own budget internally.
 *
 * HEAVY tier — long compute (season simulations, retraining, LLM writeups).
 * Still gated behind AUTO_HEAVY_SYNC so a laptop is not silently pinned.
 *
 * Every tier goes through `runIfStale`, so a short tick never re-runs a job
 * before its own `maxAgeMinutes` allows it. The tick is an upper bound on
 * responsiveness, not a schedule.
 */
export function startScheduler({
  intervalMinutes = 30, liveIntervalSeconds = 90, bootDelayMs = 20000
} = {}) {
  if (timer) return { already_running: true };

  // SCHEDULER_DISABLED: a hand-operated brake, not a feature. Added 2026-09-07
  // hours before the Matta-Kodsi draft, after the betting-side live tier's
  // 90-second polling of a 6GB+ synchronous SQLite database (node:sqlite has
  // no worker thread; a slow query blocks the whole HTTP server, not just the
  // caller) was found to be the actual cause of the app going periodically
  // unresponsive for several seconds at a time. None of the fantasy pages
  // depend on live NFL/MLB odds staying fresh, so the safe move for a night
  // that has to work is to stop paying that cost rather than chase which of
  // a dozen 3-to-5-minute jobs is the one currently holding the lock. Unset
  // (or remove from .env) to resume normal syncing once nothing depends on
  // the app being maximally responsive.
  if (process.env.SCHEDULER_DISABLED === '1') {
    console.log('Scheduler disabled via SCHEDULER_DISABLED=1 — no background jobs will run.');
    return { disabled: true };
  }

  // Keep launch interactive. MLB player-log ingestion processes thousands of
  // responses and tomorrow-pick generation runs large simulations; doing either
  // on the main thread twenty seconds after boot made every API request hang.
  const bootJobs = ['rss_news', 'espn_news', 'nfl_news_signals',
    'mlb_schedule', 'mlb_probables', 'mlb_boxscores', 'nfl_lines', 'nfl_forward_settle',
    'evidence_daemon', 'espn_line_watch', 'nfl_play_by_play',
    'nfl_book_feeds_fast', 'nfl_book_feeds_slow', 'nfl_book_feeds_extra', 'nfl_prop_feeds', 'nfl_prop_clv_free',
    'polymarket_line_watch', 'beat_the_close', 'nfl_pick_watch', 'nfl_t60_runner'];
  setTimeout(() => {
    (async () => { for (const j of bootJobs) await runIfStale(j); })().catch(() => {});
  }, bootDelayMs);
  // A local app may not stay open for the first 30-minute slow tick. Give the
  // growth check its own delayed boot pass: it is cheap when no week is new and
  // waits until the UI has been interactive for a while before any ingest.
  setTimeout(() => { runIfStale('nfl_model_growth').catch(() => {}); }, Math.max(90000, bootDelayMs + 60000));
  // Worker-thread reports: start after the interactive boot work so the first
  // dashboard reads are served from the store within a few minutes of launch.
  setTimeout(() => { runIfStale('nfl_reports').catch(() => {}); }, Math.max(150000, bootDelayMs + 120000));

  const live = jobsInTier('live');
  const metered = jobsInTier('metered');
  const growth = jobsInTier('growth');
  const heavy = process.env.AUTO_HEAVY_SYNC === '1' ? jobsInTier('heavy') : [];

  // A TIER NEVER RUNS ON TOP OF ITSELF.
  //
  // `setInterval` fires on schedule whether or not the previous pass finished.
  // With 26 sequential live jobs on a 90-second timer, a pass that runs long
  // used to have a second pass start behind it, then a third, each re-entering
  // the same jobs — multiplying load precisely when something is already slow,
  // and interleaving two passes over the same `sync_log` rows.
  //
  // The guard also gives the swallowed rejection a voice. `.catch(() => {})`
  // was hiding tier-level failures completely; a pass that dies now says so
  // once, which is the difference between a job that is failing and a job that
  // has silently stopped being called.
  const tier = (label, jobs, everyMs) => {
    let inFlight = false;
    const handle = setInterval(() => {
      if (inFlight) {
        console.warn(`[scheduler] ${label} tier still running when its next pass was due — skipping this one`);
        return;
      }
      inFlight = true;
      const passStartedAt = Date.now();
      (async () => { for (const j of jobs) await runIfStale(j); })()
        .catch(e => console.error(`[scheduler] ${label} tier pass failed:`, e?.message ?? e))
        .finally(() => {
          // Total wall time for the pass, next to SLOW_JOB_WARN_MS's per-job
          // lines above — the two together say both "how long was the app
          // unresponsive this cycle" and "because of which job".
          const passMs = Date.now() - passStartedAt;
          if (passMs >= SLOW_JOB_WARN_MS) {
            console.warn(`[scheduler] ${label} tier pass took ${(passMs / 1000).toFixed(1)}s total ` +
              `(${jobs.length} jobs) — see any '[scheduler] '<job>' took ...' lines above for which one`);
          }
          inFlight = false;
        });
    }, everyMs);
    handle.unref?.();   // never hold the process open just for this
    return handle;
  };

  liveTimer = tier('live', live, liveIntervalSeconds * 1000);
  timer = tier('background', [...growth, ...metered, ...heavy], intervalMinutes * 60000);

  return { started: true, interval_minutes: intervalMinutes,
    live_interval_seconds: liveIntervalSeconds,
    live_jobs: live.length, growth_jobs: growth.length,
    metered_jobs: metered.length, heavy_jobs: heavy.length,
    heavy_enabled: process.env.AUTO_HEAVY_SYNC === '1' };
}

export function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  return { stopped: true };
}

export function schedulerStatus() {
  return {
    running: Boolean(timer),
    live_timer_running: Boolean(liveTimer),
    heavy_enabled: process.env.AUTO_HEAVY_SYNC === '1',
    today: today(),
    jobs: Object.entries(JOBS).map(([name, j]) => {
      const l = lastRun(name);
      const age = minutesSince(name);
      return {
        job: name, label: j.label, tier: j.tier ?? 'heavy',
        max_age_minutes: j.maxAgeMinutes,
        last_run_at: l?.last_run_at ?? null,
        age_minutes: Number.isFinite(age) ? Math.round(age) : null,
        stale: age >= j.maxAgeMinutes,
        last_status: l?.last_status ?? 'never run',
        last_detail: l?.last_detail ?? null,
        runs: l?.runs ?? 0
      };
    })
  };
}
