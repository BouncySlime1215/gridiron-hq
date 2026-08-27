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
  return { ...snap, clv: gradeClosingLineValue() };
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
 * Each job carries how stale it is allowed to get. These are tuned to how fast
 * the underlying data actually changes — a schedule shifts hourly during a
 * slate, box scores only settle after games end, and NFL lines move all week.
 */
export const JOBS = {
  mlb_schedule: { run: refreshMlbSchedule, maxAgeMinutes: 60, label: 'MLB schedule and results' },
  mlb_logs: { run: refreshMlbLogs, maxAgeMinutes: 6 * 60, label: 'MLB player game logs' },
  mlb_boxscores: { run: refreshMlbBoxscores, maxAgeMinutes: 30, label: 'MLB final boxscore settlement' },
  mlb_probables: { run: refreshMlbProbables, maxAgeMinutes: 90, label: 'MLB probable starters' },
  mlb_tomorrow_picks: { run: prepareTomorrowPicks, maxAgeMinutes: 90, label: "Tomorrow's MLB picks" },
  nfl_lines: { run: refreshNflLines, maxAgeMinutes: 3 * 60, label: 'NFL betting lines' },
  nfl_line_snapshots: { run: refreshNflLineSnapshots, maxAgeMinutes: 12 * 60, label: 'Multi-book line snapshots (CLV)' },
  evidence_daemon: { run: runEvidenceDaemon, maxAgeMinutes: 5, label: 'Forward evidence capture windows' },
  nfl_weekly_learning: { run: refreshWeeklyLearning, maxAgeMinutes: 6 * 60,
    label: 'NFL weekly snapshot, settlement, and challenger retraining' },
  nfl_prop_calibration: { run: refreshNflPropCalibration, maxAgeMinutes: 24 * 60,
    label: 'NFL chronological prop calibration registry' },
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
  nfl_prop_capture: { run: refreshPropCapture, maxAgeMinutes: 60,
    label: 'NFL prop market capture (CLV evidence)' },
  nfl_news_signals: { run: refreshNflNewsSignals, maxAgeMinutes: 60,
    label: 'Typed NFL news, injury and role signals' },
  /*
   * The evaluation loop. Proposes and reports; cannot promote. Daily is the
   * right cadence — it is watching for drift and for candidates that start
   * clearing the bar as data accumulates, neither of which moves hourly.
   */
  nfl_model_watch: { run: refreshModelWatch, maxAgeMinutes: 24 * 60,
    label: 'Model drift watch and candidate discovery (report only)' }
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
    record(name, 'ok', detail);
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

/**
 * Starts the background timer. Runs a catch-up pass shortly after boot — an app
 * that has been closed for a week should not wait for the first interval — then
 * settles into a regular check.
 */
export function startScheduler({ intervalMinutes = 30, bootDelayMs = 20000 } = {}) {
  if (timer) return { already_running: true };
  // Keep launch interactive. MLB player-log ingestion can process thousands of
  // responses and tomorrow-pick generation runs large simulations; doing either
  // on the main thread twenty seconds after boot made every API request hang.
  // The boot pass is restricted to light network jobs. Heavy jobs still run on
  // the interval and through explicit refresh controls.
  const bootJobs = ['mlb_schedule', 'mlb_probables', 'mlb_boxscores', 'nfl_lines', 'evidence_daemon', 'nfl_weekly_learning'];
  setTimeout(() => {
    (async () => { for (const j of bootJobs) await runIfStale(j); })().catch(() => {});
  }, bootDelayMs);
  const scheduledJobs = process.env.AUTO_HEAVY_SYNC === '1' ? Object.keys(JOBS) : bootJobs;
  timer = setInterval(() => {
    (async () => { for (const j of scheduledJobs) await runIfStale(j); })().catch(() => {});
  }, intervalMinutes * 60000);
  timer.unref?.();  // never hold the process open just for this
  return { started: true, interval_minutes: intervalMinutes };
}

export function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
  return { stopped: true };
}

export function schedulerStatus() {
  return {
    running: Boolean(timer),
    today: today(),
    jobs: Object.entries(JOBS).map(([name, j]) => {
      const l = lastRun(name);
      const age = minutesSince(name);
      return {
        job: name, label: j.label,
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
