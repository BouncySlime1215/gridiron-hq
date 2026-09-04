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
import { db, rows, run } from '../db/index.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS sync_log (
    job TEXT PRIMARY KEY,
    last_run_at TEXT,
    last_status TEXT,
    last_detail TEXT,
    runs INTEGER DEFAULT 0
  );
`);

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
  const { syncPlayersFromESPN } = await import('../routes/espn.js');
  return syncPlayersFromESPN();
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
  const { gradeClosingLineValue } = await import('./nfl-clv.js');
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

/** Free multi-book feeds (Pinnacle guest, OddsTrader aggregator, Kambi, Bovada). No credits, no key. */
async function refreshBookFeeds() {
  const { captureBookFeeds } = await import('./book-feeds.js');
  return captureBookFeeds();
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
  return { captured, settlement, reconciliation: reconcilePropQuoteMatches(), archive: propClvStatus() };
}

/** Turn fresh reporting into typed, cutoff-safe context shared by fantasy and betting. */
async function refreshNflNewsSignals() {
  const { syncStructuredNewsSignals, syncAiNewsSignals, newsSignalCoverage } = await import('./nfl-news-signal.js');
  const rules = syncStructuredNewsSignals({ sinceDays: 14 });
  const ai = await syncAiNewsSignals({ sinceDays: 7, limit: 20 });
  return { rules, ai, coverage: newsSignalCoverage() };
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
 * The forward decision ledger for the CURRENT week, unattended.
 *
 * Until now the only writer of `nfl_pick_decisions`, the pregame snapshots and
 * the expert council's forward rows was a human clicking a button. A frozen
 * forward ledger that depends on someone remembering to click is not frozen.
 * This job derives the live week from the schedule, records every decision
 * (including every abstention) under the production policy, freezes pregame
 * context, and captures the council. It stakes nothing and locks no picks.
 */
async function refreshNflDecisionLedger() {
  const { currentNflWeek } = await import('./weekly-learning.js');
  const { autoPickDecisionBoard, persistPickDecisions } = await import('./nfl-auto-picks.js');
  const { capturePregameSnapshots } = await import('./nfl-pregame.js');
  const { captureForwardExpertWeek } = await import('./nfl-expert-council.js');
  const { season, week } = currentNflWeek();
  if (!Number.isInteger(week) || week < 1 || week > 18) return { skipped: true, reason: 'no regular-season week is upcoming' };
  const board = autoPickDecisionBoard(season, week);
  const decisions = persistPickDecisions(season, week, board);
  let pregame = null, council = null;
  try { pregame = capturePregameSnapshots(season, week); } catch (e) { pregame = { error: e.message }; }
  try { council = captureForwardExpertWeek(season, week, { horizon: 'scheduled' }); } catch (e) { council = { error: e.message }; }
  return { season, week, decisions: board.decisions?.length ?? null, selected: board.selected?.length ?? 0,
    abstention_reasons: board.abstention_reasons ?? null, persisted: decisions, pregame, expert_council: council,
    staking: 'zero units; this ledger records decisions, it does not place or size bets' };
}

/**
 * Each job carries how stale it is allowed to get. These are tuned to how fast
 * the underlying data actually changes — a schedule shifts hourly during a
 * slate, box scores only settle after games end, and NFL lines move all week.
 */
export const JOBS = {
  mlb_schedule: { run: refreshMlbSchedule, maxAgeMinutes: 60, tier: 'live', label: 'MLB schedule and results' },
  mlb_logs: { run: refreshMlbLogs, maxAgeMinutes: 6 * 60, tier: 'heavy', label: 'MLB player game logs' },
  mlb_boxscores: { run: refreshMlbBoxscores, maxAgeMinutes: 30, tier: 'live', label: 'MLB final boxscore settlement' },
  mlb_probables: { run: refreshMlbProbables, maxAgeMinutes: 90, tier: 'live', label: 'MLB probable starters' },
  mlb_tomorrow_picks: { run: prepareTomorrowPicks, maxAgeMinutes: 90, tier: 'heavy', label: "Tomorrow's MLB picks" },
  player_rosters: { run: refreshPlayerRosters, maxAgeMinutes: 3 * 60, tier: 'live',
    label: 'Player team assignments — the actual fix for stale roster spots' },
  // Free (ESPN scoreboard). Hourly, so the last stored line before kickoff is a
  // usable closing reference for settlement and so finals land within the hour.
  nfl_lines: { run: refreshNflLines, maxAgeMinutes: 60, tier: 'live', label: 'NFL betting lines and finals (ESPN, free)' },
  nfl_line_snapshots: { run: refreshNflLineSnapshots, maxAgeMinutes: 12 * 60, tier: 'metered', label: 'Multi-book line snapshots (CLV)' },
  nfl_sgo_snapshot: { run: refreshSportsGameOdds, maxAgeMinutes: 30, tier: 'metered',
    label: 'SportsGameOdds multi-book snapshot (free, opt-in, own budget)' },
  nfl_prop_feeds: { run: refreshPropFeeds, maxAgeMinutes: 60, tier: 'live',
    label: 'Free player-prop quotes: Action Network, Underdog' },
  nfl_book_feeds_extra: { run: refreshExtraBookFeeds, maxAgeMinutes: 60, tier: 'live',
    label: 'Free game lines: Rotowire (Circa, DK, FD, MGM, Caesars, BetRivers, Fanatics, theScore, Betr) and SBR (bet365, Hard Rock)' },
  nfelo_sync: { run: refreshNfelo, maxAgeMinutes: 6 * 60, tier: 'growth',
    label: 'nfelo: QB-adjusted Elo, per-game HFA, pre-regression line, public splits' },
  nfl_external_ratings: { run: refreshExternalRatings, maxAgeMinutes: 24 * 60, tier: 'growth',
    label: 'ESPN FPI weekly snapshot and TeamRankings predictive (Wednesday)' },
  nfl_forecast_history: { run: refreshForecastHistory, maxAgeMinutes: 24 * 60, tier: 'heavy',
    label: 'Open-Meteo previous-runs: what the wind forecast said before each played kickoff' },
  nfl_book_feeds: { run: refreshBookFeeds, maxAgeMinutes: 60, tier: 'live',
    label: 'Free multi-book quotes: Pinnacle, OddsTrader (11 books), BetRivers, Bovada' },
  nfl_qbr_weather: { run: refreshQbrAndWeather, maxAgeMinutes: 24 * 60, tier: 'growth',
    label: 'Weekly ESPN QBR and kickoff-hour weather for the current and prior season' },
  beat_the_close: { run: refreshBeatTheClose, maxAgeMinutes: 60, tier: 'live',
    label: 'Beat the close: signal snapshots, zero-unit shadow decisions, CLV settlement' },
  polymarket_line_watch: { run: refreshPolymarketLineWatch, maxAgeMinutes: 15, tier: 'live',
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
  prediction_markets: { run: () => import('./prediction-markets.js').then(async m => ({
    quotes: await m.captureKalshi({}), flow: await m.captureKalshiFlow({}) })),
  maxAgeMinutes: 20, tier: 'live', label: 'Prediction market quotes and trade tape (free)' },
  // Free, no key. Polymarket is the only venue measured cheaper than Kalshi,
  // and its hourly price history is the only source here that can show how a
  // price moved around a news event after the fact.
  polymarket: { run: () => import('./polymarket.js').then(async m => ({
    markets: await m.ingestPolymarketNfl({ maxPages: 4 }),
    books: await m.captureOrderBooks({ minVolume: 1000, limit: 40 }) })),
  maxAgeMinutes: 30, tier: 'live', label: 'Polymarket NFL markets and order books (free)' },
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
  nfl_decision_ledger: { run: refreshNflDecisionLedger, maxAgeMinutes: 3 * 60, tier: 'growth',
    label: 'NFL current-week decision ledger, pregame snapshots, and expert council freeze (zero units)' },
  nfl_reports: { run: refreshReports, maxAgeMinutes: 3 * 60, tier: 'growth',
    label: 'Heavy dashboard reports computed off-thread (worker) and served from SQLite' },
  nfl_prop_calibration: { run: refreshNflPropCalibration, maxAgeMinutes: 24 * 60, tier: 'heavy',
    label: 'NFL chronological prop calibration registry' },
  fantasy_coordinator_refit: { run: refreshFantasyCoordinator, maxAgeMinutes: 24 * 60, tier: 'heavy',
    label: 'Fantasy coordinator refit (ensemble/game-script blend, walk-forward validated)' },
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
  twitter_insiders: { run: refreshTwitterInsiders, maxAgeMinutes: 4 * 60, tier: 'metered',
    label: 'NFL insider tweets — typed injury/role claims (budget-capped, ~$0.003/handle)' },
  nfl_injuries: { run: refreshNflInjuries, maxAgeMinutes: 6 * 60, tier: 'live',
    label: 'Official practice reports (nflverse injuries release)' },
  nfl_transactions: { run: refreshNflTransactions, maxAgeMinutes: 30, tier: 'live',
    label: 'Transaction wire — signings, releases, IR moves (ESPN public API)' },
  nfl_rookie_public: { run: refreshNflRookiePublic, maxAgeMinutes: 7 * 24 * 60, tier: 'heavy',
    label: 'NFL draft and combine rookie evidence (nflverse, key-free)' },
  team_analyses: { run: refreshTeamAnalyses, maxAgeMinutes: 4 * 60, tier: 'heavy',
    label: "X's & O's writeups — self-limited to teams with news newer than their analysis" }
};

/** Runs one job if it is older than its threshold. `force` ignores the age. */
export async function runIfStale(name, { force = false } = {}) {
  const job = JOBS[name];
  if (!job) return { job: name, error: 'unknown job' };
  const age = minutesSince(name);
  if (!force && age < job.maxAgeMinutes) {
    return { job: name, skipped: true, age_minutes: Math.round(age), max_age_minutes: job.maxAgeMinutes };
  }
  try {
    const detail = await job.run();
    // A job that chose not to do its work (reserve hold, no key, no due window)
    // is not healthy; recording it as 'ok' told every freshness view that a
    // capture happened when nothing did.
    record(name, detail?.skipped === true ? 'skipped' : 'ok', detail);
    return { job: name, ran: true, detail };
  } catch (e) {
    // A failed refresh must never take a page down — the stale data is still
    // servable, and the failure is recorded so it is visible rather than silent.
    record(name, 'error', e.message);
    return { job: name, ran: true, error: e.message };
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

  // Keep launch interactive. MLB player-log ingestion processes thousands of
  // responses and tomorrow-pick generation runs large simulations; doing either
  // on the main thread twenty seconds after boot made every API request hang.
  const bootJobs = ['rss_news', 'espn_news', 'nfl_news_signals',
    'mlb_schedule', 'mlb_probables', 'mlb_boxscores', 'nfl_lines',
    'evidence_daemon', 'espn_line_watch', 'nfl_play_by_play',
    'nfl_book_feeds', 'nfl_book_feeds_extra', 'nfl_prop_feeds', 'nfl_prop_clv_free', 'polymarket_line_watch', 'beat_the_close'];
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

  liveTimer = setInterval(() => {
    (async () => { for (const j of live) await runIfStale(j); })().catch(() => {});
  }, liveIntervalSeconds * 1000);
  liveTimer.unref?.();

  timer = setInterval(() => {
    (async () => { for (const j of [...growth, ...metered, ...heavy]) await runIfStale(j); })().catch(() => {});
  }, intervalMinutes * 60000);
  timer.unref?.();  // never hold the process open just for this

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
