/**
 * Phase 1 of the 2026-09-09 learning-pipeline plan: closes a confirmed, real
 * ~6-month blackout that recurred at every single season boundary this
 * project has data for (verified directly against the database, not
 * theorized). Root cause: `nfl-model-growth.js`'s whole ingestion cycle
 * (including depth charts and injury reports) only runs when `game_lines`
 * has a newly finalized week — and no games finalize between the Super Bowl
 * and next September, so it silently never ran in that window, every year.
 *
 * Two independent things live here:
 *
 *   1. `refreshNflOffseasonCycle(season)` — a ONE-TIME action fired from
 *      `nfl-model-growth.js`'s season-end branch, the moment a season (regular
 *      season + playoffs) is fully complete. Pulls the richer offseason
 *      dataset (draft picks, contracts, depth resets — `offseason-data.js`)
 *      for the upcoming season, gated on a sync_log marker so it only
 *      actually runs once per boundary even though the growth cycle itself
 *      re-checks every few hours.
 *
 *   2. `refreshNflOffseasonDepthAndInjuries()` — a genuinely independent,
 *      ongoing refresh that does NOT wait for "a game just finalized" (the
 *      actual root cause), on a cadence that ramps with the calendar instead
 *      of a flat weekly check: sparse in the dead of the offseason, denser
 *      around the draft and minicamps, DAILY through the confirmed
 *      highest-churn window (final roster cutdowns / waivers in late August).
 *      Registered in `scheduler.js` with a short flat `maxAgeMinutes` so the
 *      scheduler checks in on it often; the function itself decides whether
 *      real work is actually due under the variable cadence, so "how often
 *      the scheduler looks" and "how often real work happens" stay separate.
 */
import { rows, row } from '../db/index.js';
import { recordSync, lastRun } from './scheduler.js';
import { syncDepthCharts, syncInjuries } from './nfl-advanced.js';
import { syncOffseasonData } from './offseason-data.js';
import { syncPublicRookieEvidence } from './nfl-rookie-ingest.js';

export const OFFSEASON_CYCLE_SOURCE = 'nfl_offseason_cycle';
export const OFFSEASON_DEPTH_INJURY_SOURCE = 'nfl_offseason_depth_injury';

/**
 * One-time upcoming-season data pull, fired once a season is fully over.
 * Idempotent: `syncOffseasonData` itself is safe to rerun (INSERT OR REPLACE,
 * transactional, per its own header) but this still checks a marker first so
 * a normal 6-hourly growth-cycle re-check after the season ends doesn't
 * re-fetch external sources for no reason every single cycle.
 */
export async function refreshNflOffseasonCycle(justCompletedSeason) {
  const upcomingSeason = justCompletedSeason + 1;
  const marker = `${OFFSEASON_CYCLE_SOURCE}_${upcomingSeason}`;
  const already = lastRun(marker);
  if (already?.last_status === 'ok') {
    return { skipped: true, reason: `already synced for ${upcomingSeason}`, last_run_at: already.last_run_at };
  }
  const sync = await syncOffseasonData({ seasons: [upcomingSeason] });
  const rookieCoverage = await reconcileRookieEvidenceCoverage(upcomingSeason);
  const result = { upcoming_season: upcomingSeason, offseason_data: sync, rookie_coverage: rookieCoverage };
  recordSync(marker, sync.failures?.length ? 'error' : 'ok', result);
  return result;
}

/**
 * Real churn does not happen at a flat weekly rate across the offseason —
 * it clusters around the draft (late April), minicamps (May-June), and above
 * all final roster cutdowns / waiver claims in late August (the exact ~36-day
 * gap confirmed empty even in the one offseason this app has live data for).
 * Returns how many hours must pass before the next refresh is "due" for the
 * given date, so the same job function can be checked often by the scheduler
 * while only doing real work on this calendar-aware cadence.
 */
export function offseasonRefreshIntervalHours(date = new Date()) {
  const month = date.getUTCMonth(); // 0=Jan
  const day = date.getUTCDate();
  const isCutdownWindow = (month === 7 && day >= 20) || (month === 8 && day <= 10); // ~Aug 20 - Sep 10
  const isDraftOrMinicamp = (month === 3 && day >= 15) || month === 4 || month === 5; // mid-Apr through Jun
  // Checked AFTER the cutdown window on purpose: early September belongs to
  // the cutdown/waiver rule above even though it is technically week 1 of
  // the regular season, because roster churn that week dwarfs a normal
  // in-season week and the normal model-growth cycle isn't ingesting depth
  // charts for it yet either.
  const isRegularSeason = (month >= 8 && month <= 11) || month === 0; // Sep-Dec, Jan (playoffs run into Feb)
  if (isCutdownWindow) return 24; // daily through the highest-churn week of the year
  if (isRegularSeason) return 24 * 30; // handled by the normal in-season cycle anyway; this job is a backstop
  if (isDraftOrMinicamp) return 24 * 3; // every ~3 days
  return 24 * 14; // dead period (Feb-mid Apr, Jul): every 2 weeks is plenty
}

/**
 * The actual independent refresh — genuinely decoupled from "a game just
 * finalized," which is the root cause this whole module exists to fix.
 * Determines its own due-ness from `offseasonRefreshIntervalHours` rather
 * than a single fixed `maxAgeMinutes`, so the scheduler can check in
 * frequently without that meaning frequent real work.
 */
export async function refreshNflOffseasonDepthAndInjuries({ season = Number(process.env.NFL_SEASON) || new Date().getFullYear(), force = false } = {}) {
  const last = lastRun(OFFSEASON_DEPTH_INJURY_SOURCE);
  const dueInHours = offseasonRefreshIntervalHours(new Date());
  if (!force && last?.last_run_at) {
    const hoursSince = (Date.now() - new Date(last.last_run_at).getTime()) / 36e5;
    if (hoursSince < dueInHours) {
      return { skipped: true, reason: 'not due yet under the variable offseason cadence',
        hours_since_last: +hoursSince.toFixed(1), due_every_hours: dueInHours };
    }
  }
  const depth = await syncDepthCharts([season, season + 1]);
  const injuries = await syncInjuries([season, season + 1]);
  const result = { depth, injuries, cadence_hours: dueInHours, refreshed_at: new Date().toISOString() };
  recordSync(OFFSEASON_DEPTH_INJURY_SOURCE, 'ok', result);
  return result;
}

/**
 * Confirms every real draft pick for a season actually has evidence, rather
 * than trusting the original historical backfill was exhaustive — it wasn't
 * (verified: a recent #1 overall pick had zero rows). Compares seasons'
 * rookie counts against each other rather than against an external source,
 * since a season with dramatically fewer evidence rows than its neighbors,
 * for the same evidence_type, is the observable signature of a gap.
 */
export function rookieEvidenceCoverage() {
  return rows(`
    SELECT season, COUNT(DISTINCT player_id) players, COUNT(*) rows
    FROM nfl_rookie_evidence
    GROUP BY season ORDER BY season`);
}

async function reconcileRookieEvidenceCoverage(season) {
  const coverage = rookieEvidenceCoverage();
  const recent = coverage.filter(c => c.season >= season - 3 && c.season < season);
  const median = recent.length
    ? recent.map(c => c.players).sort((a, b) => a - b)[Math.floor(recent.length / 2)] : null;
  const thisSeason = coverage.find(c => c.season === season);
  const looksIncomplete = median != null && (!thisSeason || thisSeason.players < median * 0.5);
  if (!looksIncomplete) return { season, checked: true, resynced: false, players: thisSeason?.players ?? 0, median_of_recent_seasons: median };
  const resync = await syncPublicRookieEvidence({ fromSeason: season, throughSeason: season });
  return { season, checked: true, resynced: true, reason: `only ${thisSeason?.players ?? 0} players vs a ${median}-player median over the prior 3 seasons`, resync };
}

/**
 * Makes a future silent blackout impossible to miss — the exact class of gap
 * this module exists to fix was only found tonight by accident, checking the
 * database by hand. Flags any calendar month during the season (Sep-Feb,
 * when depth/injury data should never go quiet) with zero new rows.
 */
const COVERAGE_TABLES = { nfl_depth: 'captured', nfl_injuries: 'modified_at' };

export function offseasonCoverageHealth() {
  const nowYm = new Date().toISOString().slice(0, 7);
  const gaps = {};
  for (const [table, column] of Object.entries(COVERAGE_TABLES)) {
    let present;
    try { present = rows(`SELECT DISTINCT strftime('%Y-%m', ${column}) ym FROM ${table} ORDER BY ym`).map(r => r.ym); }
    catch { present = []; }
    if (!present.length) { gaps[table] = []; continue; }
    // Only check the era this table has ANY data for — this is a forward-
    // looking monitor for a future silent blackout, not an audit of decades
    // this project never tracked weekly depth charts for at all.
    const trackedFrom = present[0];
    const seasonMonths = new Set();
    for (const r of rows(`SELECT DISTINCT season FROM game_lines`)) {
      const s = r.season;
      for (const m of [9, 10, 11, 12]) seasonMonths.add(`${s}-${String(m).padStart(2, '0')}`);
      for (const m of [1, 2]) seasonMonths.add(`${s + 1}-${String(m).padStart(2, '0')}`);
    }
    const presentSet = new Set(present);
    gaps[table] = [...seasonMonths].filter(ym => ym >= trackedFrom && ym <= nowYm && !presentSet.has(ym)).sort();
  }
  return { healthy: Object.values(gaps).every(g => g.length === 0), gaps,
    note: 'Any month listed here is a real, in-season blackout within the era this table has ever tracked data for — depth/injury data should never go quiet Sep-Feb once tracking has started.' };
}
