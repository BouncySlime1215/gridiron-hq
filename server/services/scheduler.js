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

/** NFL lines for the current season, including scores as games go final. */
async function refreshNflLines() {
  const { syncCurrentLines, clearGameScriptCache } = await import('./gamescript.js');
  const season = Number(process.env.NFL_SEASON) || new Date().getFullYear();
  const out = await syncCurrentLines(season, 18);
  clearGameScriptCache();
  return out;
}

/**
 * Each job carries how stale it is allowed to get. These are tuned to how fast
 * the underlying data actually changes — a schedule shifts hourly during a
 * slate, box scores only settle after games end, and NFL lines move all week.
 */
export const JOBS = {
  mlb_schedule: { run: refreshMlbSchedule, maxAgeMinutes: 60, label: 'MLB schedule and results' },
  mlb_logs: { run: refreshMlbLogs, maxAgeMinutes: 6 * 60, label: 'MLB player game logs' },
  nfl_lines: { run: refreshNflLines, maxAgeMinutes: 3 * 60, label: 'NFL betting lines' }
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
  setTimeout(() => { runAllStale().catch(() => {}); }, bootDelayMs);
  timer = setInterval(() => { runAllStale().catch(() => {}); }, intervalMinutes * 60000);
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
