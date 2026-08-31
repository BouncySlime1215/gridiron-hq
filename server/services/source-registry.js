/**
 * Build Order 0.5 — one registry of every ingestion source, not three.
 *
 * Before this, staleness lived in three disconnected places: scheduler.js's
 * JOBS (8 entries, mostly MLB/betting, the only ones with an actual timer and
 * a staleness budget), dev.js's `/status` (five raw MAX(fetched_at) probes,
 * no budget, no cadence, no failure semantics), and everything else — nflverse,
 * PBP, NGS/PFR/snaps/depth/injuries, ESPN rosters/news/stats, Sleeper, FFC,
 * FantasyCalc, OverTheCap, Wikipedia's Top 100 — which had no tracking at all.
 * A resync of any of those could silently fail and nothing would know.
 *
 * This module doesn't replace scheduler.js — a scheduled job still needs a
 * timer and a maxAgeMinutes to auto-refresh on. It adds the sources that only
 * ever run on demand, and gives every source (scheduled or not) three things
 * the Build Order calls out explicitly:
 *
 *   cadence   — how often the upstream actually changes, so "stale" means
 *               something real rather than an arbitrary number
 *   cutoff    — what "as of" means for this source: same-day live, settles
 *               T+1, a point-in-time ID crosswalk with no real staleness, ...
 *   failureMode — what happens when the fetch fails: does the app keep
 *               serving the last good sync (fine), or is there no fallback
 *               (a gap opens the moment this breaks)
 *
 * All of it reads the same `sync_log` table scheduler.js already writes to —
 * recordSync() (exported from there) is what every manual sync below now
 * calls, so "was this source ever run, and did it work" is one query away
 * regardless of which route triggered it.
 */
import { lastRun, minutesSince, JOBS as SCHEDULED_JOBS } from './scheduler.js';

/**
 * Sources that only run when someone calls their /sync route — no timer, by
 * design (a full PBP re-ingest is a multi-minute, multi-season pull; nobody
 * wants that firing on a 30-minute interval). `maxAgeMinutes` here is still
 * meaningful: it is the budget confidence() uses to decide how much to trust
 * data that was never freshened, not a trigger for anything automatic.
 */
export const MANUAL_SOURCES = {
  nflverse_crosswalk: {
    label: 'nflverse player ID crosswalk (players.csv)',
    cadence: 'irregular — nflverse cuts a new release a few times a season',
    cutoff: 'point-in-time identity mapping, not a time series; a stale copy is only wrong for rookies added since the last pull',
    failureMode: 'throws; gsis_id stays unset for anyone new until the next successful run',
    maxAgeMinutes: 7 * 24 * 60
  },
  nflverse_weekly_usage: {
    label: 'nflverse weekly player usage (stats_player_week)',
    cadence: 'weekly during the season — settles a day or two after each week\'s games',
    cutoff: 'final once posted; nflverse does not revise completed weeks',
    failureMode: 'per-season failures are caught and reported inline; other seasons still sync',
    maxAgeMinutes: 3 * 24 * 60
  },
  nflverse_snap_counts: {
    label: 'nflverse snap counts',
    cadence: 'weekly during the season',
    cutoff: 'final once posted',
    failureMode: 'per-season failures are caught and reported inline; other seasons still sync',
    maxAgeMinutes: 3 * 24 * 60
  },
  nflverse_pbp: {
    label: 'nflverse play-by-play (feeds nfl_player_week_features)',
    cadence: 'weekly during the season; each pull is a full-season file',
    cutoff: 'final once posted',
    failureMode: 'throws mid-stream; that season\'s feature rows stay at whatever they were before the run',
    maxAgeMinutes: 3 * 24 * 60
  },
  nflverse_historical_lines: {
    label: 'nflverse historical game lines (games.csv)',
    cadence: 'one-time backfill plus occasional corrections',
    cutoff: 'final for completed seasons',
    failureMode: 'throws; the current-season timer job (nfl_lines) is unaffected',
    maxAgeMinutes: 30 * 24 * 60
  },
  nfl_ngs: {
    label: 'Next Gen Stats (tracking-chip data)',
    cadence: 'weekly during the season',
    cutoff: 'final once posted',
    failureMode: 'recorded independently; other advanced feeds continue and the missing NGS family abstains',
    maxAgeMinutes: 3 * 24 * 60
  },
  nfl_pfr_adv: {
    label: 'Pro-Football-Reference advanced charting',
    cadence: 'weekly during the season',
    cutoff: 'final once posted',
    failureMode: 'recorded independently; snaps, depth and injuries continue',
    maxAgeMinutes: 3 * 24 * 60
  },
  nfl_advanced_snaps: {
    label: 'nflverse snap counts (advanced feed)',
    cadence: 'weekly during the season',
    cutoff: 'final once posted',
    failureMode: 'recorded independently; other advanced feeds continue',
    maxAgeMinutes: 3 * 24 * 60
  },
  nfl_depth_charts: {
    label: 'nflverse depth charts',
    cadence: 'weekly, moves during a season as roles change',
    cutoff: 'as of the pull; a depth chart is a live opinion, not a settled fact',
    failureMode: 'recorded independently; other advanced feeds continue',
    maxAgeMinutes: 2 * 24 * 60
  },
  nfl_injuries: {
    label: 'nflverse injury reports',
    cadence: 'weekly (practice participation + game status)',
    cutoff: 'as of the pull; Friday\'s report is stale by Sunday',
    failureMode: 'recorded independently; stale injury confidence decays until the next successful pull',
    maxAgeMinutes: 24 * 60
  },
  espn_players: {
    label: 'ESPN top-800 player universe (roster + ownership)',
    cadence: 'daily-ish; the roster source of truth for offensive depth charts',
    cutoff: 'live snapshot of ESPN ownership at pull time',
    failureMode: 'throws; ambiguous name/position collisions are reported rather than silently bound',
    maxAgeMinutes: 24 * 60
  },
  espn_news_general: {
    label: 'ESPN league-wide news feed',
    cadence: 'hourly-ish — news breaks continuously in season',
    cutoff: 'live; headlines are deduped by exact match so a resync is cheap',
    failureMode: 'throws; callers that treat news as best-effort catch and continue (dev.js refresh-all does not treat this one as fatal)',
    maxAgeMinutes: 6 * 60
  },
  espn_news_team: {
    label: 'ESPN per-team news feed (32 teams)',
    cadence: 'hourly-ish',
    cutoff: 'live',
    failureMode: 'throws per team; batched with Promise.allSettled so one team\'s failure does not block the rest',
    maxAgeMinutes: 6 * 60
  },
  espn_rosters: {
    label: 'ESPN team rosters (nfldata.js)',
    cadence: 'daily-ish — cuts and signings',
    cutoff: 'live snapshot; a team wipe-and-reinsert on every sync so releases disappear correctly',
    failureMode: 'per-team fetch failures are swallowed by Promise.allSettled; status is "error" if any team came back short',
    maxAgeMinutes: 24 * 60
  },
  espn_schedules: {
    label: 'ESPN team schedules (nfldata.js)',
    cadence: 'weekly; effectively static once the season schedule is out',
    cutoff: 'as published',
    failureMode: 'per-team fetch failures are swallowed by Promise.allSettled',
    maxAgeMinutes: 7 * 24 * 60
  },
  espn_depth_chart: {
    label: 'ESPN core-API depth charts (slot-level, nfldata.js)',
    cadence: 'weekly, more often around injuries',
    cutoff: 'as of the pull',
    failureMode: 'per-team fetch failures are swallowed by Promise.allSettled',
    maxAgeMinutes: 2 * 24 * 60
  },
  overthecap_cap: {
    label: 'OverTheCap salary cap space (HTML scrape)',
    cadence: 'daily-ish; cap moves on transactions',
    cutoff: 'as of the pull',
    failureMode: 'throws outright if fewer than 30/32 teams parse — a layout change is treated as a hard failure, not silently trusted',
    maxAgeMinutes: 24 * 60
  },
  espn_season_stats: {
    label: 'ESPN season projections + prior-year actuals',
    cadence: 'projections move through the offseason; actuals are final once the season ends',
    cutoff: 'projected rows are ESPN\'s current opinion, not a completed fact',
    failureMode: 'throws',
    maxAgeMinutes: 7 * 24 * 60
  },
  nfl_top100: {
    label: 'NFL Top 100 list (Wikipedia)',
    cadence: 'revealed a few players at a time, June–September; static the rest of the year',
    cutoff: 'legitimately partial mid-summer — see the "note" field a sync returns',
    failureMode: 'throws (including on Wikipedia rate limiting)',
    maxAgeMinutes: 14 * 24 * 60
  },
  ffc_adp: {
    label: 'FantasyFootballCalculator ADP',
    cadence: 'daily during draft season',
    cutoff: 'as of the pull',
    failureMode: 'throws',
    maxAgeMinutes: 24 * 60
  },
  sleeper_players: {
    label: 'Sleeper player universe (search_rank + injury flag)',
    cadence: 'daily',
    cutoff: 'as of the pull',
    failureMode: 'throws',
    maxAgeMinutes: 24 * 60
  },
  fantasycalc_values: {
    label: 'FantasyCalc redraft trade values (global, league-agnostic)',
    cadence: 'daily; values move with real trades',
    cutoff: 'as of the pull; trend30 is a point delta, not already a percent',
    failureMode: 'throws',
    maxAgeMinutes: 24 * 60
  },
  fantasycalc_dynasty: {
    label: 'FantasyCalc dynasty values (per connected league format)',
    cadence: 'daily',
    cutoff: 'as of the pull',
    failureMode: 'per-format fetch failures are recorded inline in the result and do not stop other formats',
    maxAgeMinutes: 24 * 60
  }
};

/** One combined status record, whether the source is on a timer or on demand. */
function statusFor(name, meta, scheduled) {
  const l = lastRun(name);
  const age = minutesSince(name);
  const neverRun = !l?.last_run_at;
  const stale = neverRun || age >= meta.maxAgeMinutes;
  return {
    source: name,
    label: meta.label,
    cadence: meta.cadence,
    cutoff: meta.cutoff,
    failure_mode: meta.failureMode,
    max_age_minutes: meta.maxAgeMinutes,
    scheduled,
    last_run_at: l?.last_run_at ?? null,
    age_minutes: Number.isFinite(age) ? Math.round(age) : null,
    last_status: l?.last_status ?? 'never run',
    stale,
    confidence: confidence(name, meta)
  };
}

/**
 * A source's data must lower confidence when it's stale, not silently serve
 * old numbers as if they were current. 1.0 fresh, decaying linearly to a 0.2
 * floor at 3x its staleness budget past due, 0 if it has never run at all or
 * its last run failed outright — a floor rather than 0 because "a bit stale"
 * and "we have no idea" are different situations and a caller may still want
 * to use slightly-old data with a caveat rather than none at all.
 */
export function confidence(name, meta = MANUAL_SOURCES[name] ?? SCHEDULED_JOBS[name]) {
  if (!meta) return null;
  const l = lastRun(name);
  if (!l?.last_run_at) return 0;
  if (l.last_status === 'error') return 0.1;
  const age = minutesSince(name);
  const budget = meta.maxAgeMinutes ?? meta.max_age_minutes;
  if (age <= budget) return 1;
  const overBudgetRatio = age / budget;                 // 1 at budget, grows from there
  return +Math.max(0.2, 1 - (overBudgetRatio - 1) / 2).toFixed(2);
}

/** Every registered source, scheduled or manual, with cadence/cutoff/failure mode and live staleness. */
export function allSources() {
  const scheduled = Object.entries(SCHEDULED_JOBS).map(([name, job]) =>
    statusFor(name, { label: job.label, cadence: 'on a timer (see scheduler)', cutoff: 'as of last refresh',
      failureMode: 'recorded in sync_log; stale data keeps serving', maxAgeMinutes: job.maxAgeMinutes }, true));
  const manual = Object.entries(MANUAL_SOURCES).map(([name, meta]) => statusFor(name, meta, false));
  return [...scheduled, ...manual].sort((a, b) => a.source.localeCompare(b.source));
}
