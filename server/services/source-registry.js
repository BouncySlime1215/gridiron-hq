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
// MOVED TO scheduler.js's JOBS on 2026-09-19, and deleted from here because
// allSources() concatenates both lists with no dedup (a source left in both
// places is listed twice, with two different cadences):
//
//   nflverse_crosswalk, nflverse_weekly_usage, nflverse_snap_counts,
//   espn_depth_chart, espn_season_stats, sleeper_players
//
// Every one of them is a core fantasy feed, and every one of them had never
// run on the deployed app. "No timer, by design" below is a defensible rule
// for a multi-season play-by-play backfill; it was never defensible for the
// player ID crosswalk, and the result was a players table of 448 seed rows
// with no external ids and empty usage, snap and projection tables. Depth
// charts moved to ESPN's per-team feed rather than nflverse's, whose 2026
// file was measured at 51 MB in week 2 and grows weekly — see
// refreshEspnDepthChart in scheduler.js.
export const MANUAL_SOURCES = {
  nfl_rookie_college: {
    label: 'SportsDataverse play-level college production and opponent strength',
    cadence: 'annual backfill after the college season',
    cutoff: 'January 20 following the completed college season; never reads NFL outcomes',
    failureMode: 'per-run failure is recorded; draft/combine prior remains available and college fields stay missing',
    maxAgeMinutes: 30 * 24 * 60
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
  // nfl_injuries moved to scheduler.js's JOBS (a real, healthy, live-tier job
  // on a 6h cadence — see refreshNflInjuries there). This entry existed here
  // as a conflicting "weekly" duplicate of the same underlying data, and
  // allSources() concatenates both lists without dedup, so it listed the
  // same source twice with contradictory cadence/label. Same class of fix as
  // the espn_rosters removal above.
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
  // espn_rosters moved to scheduler.js's JOBS (it now runs on a real timer —
  // see that file's refreshEspnRosters for why: this entry existed here as
  // "on demand" documentation, but nothing ever actually called it on demand
  // either, and a roster synced once on install just sat there for weeks).
  // allSources() would otherwise list it twice.
  espn_schedules: {
    label: 'ESPN team schedules (nfldata.js)',
    cadence: 'weekly; effectively static once the season schedule is out',
    cutoff: 'as published',
    failureMode: 'per-team fetch failures are swallowed by Promise.allSettled',
    maxAgeMinutes: 7 * 24 * 60
  },

  overthecap_cap: {
    label: 'OverTheCap salary cap space (HTML scrape)',
    cadence: 'daily-ish; cap moves on transactions',
    cutoff: 'as of the pull',
    failureMode: 'throws outright if fewer than 30/32 teams parse — a layout change is treated as a hard failure, not silently trusted',
    maxAgeMinutes: 24 * 60
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
  },
  historical_adp: {
    label: 'DynastyProcess historical preseason consensus rank (fantasy boom/bust prior)',
    cadence: 'one-time backfill; each season is a frozen preseason snapshot, never revised',
    cutoff: 'the last scrape before that season\'s Week 1 kickoff',
    failureMode: 'throws; the boom/bust classifier has zero training examples for the affected seasons and shrinks to zero rather than guessing',
    maxAgeMinutes: 90 * 24 * 60
  },
  nfl_prospective_collection: {
    label: 'NFL prospective collection: multi-book quote tape + bounded typed-news extraction (Phase 3)',
    cadence: 'manual only, by design — no timer; costs real Odds API quota and Anthropic spend per run',
    cutoff: 'as of the moment the button was last pressed; stops entirely when the app is closed',
    failureMode: 'each half (quote capture, news extraction) fails independently and is recorded separately; no automatic retry, so a failure is never silently re-charged',
    maxAgeMinutes: 6 * 60
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
  const freshness = age <= budget ? 1 : Math.max(0.2, 1 - (age / budget - 1) / 2);
  if (l.last_status === 'partial') {
    // Some-but-not-all of a per-team batch failed (see nfldata.js's syncRosters).
    // That's a genuinely different situation from a total failure and shouldn't
    // get shoved to the same 0.1 floor: scale by how much of the batch actually
    // landed, so 31/32 teams still reads as trustworthy and 16/32 reads as
    // meaningfully degraded. Falls back to a neutral midpoint if a caller logged
    // 'partial' without the team-count detail this scaling needs.
    let detail;
    try { detail = JSON.parse(l.last_detail); } catch { detail = null; }
    const attempted = detail?.teamsAttempted;
    const failedCount = detail?.failedTeams?.length;
    const successFraction = (attempted > 0 && failedCount != null)
      ? Math.max(0, (attempted - failedCount) / attempted)
      : 0.5;
    return +Math.max(0.1, freshness * successFraction).toFixed(2);
  }
  return +freshness.toFixed(2);
}

/** Every registered source, scheduled or manual, with cadence/cutoff/failure mode and live staleness. */
export function allSources() {
  const scheduled = Object.entries(SCHEDULED_JOBS).map(([name, job]) =>
    statusFor(name, { label: job.label, cadence: 'on a timer (see scheduler)', cutoff: 'as of last refresh',
      failureMode: 'recorded in sync_log; stale data keeps serving', maxAgeMinutes: job.maxAgeMinutes }, true));
  const manual = Object.entries(MANUAL_SOURCES).map(([name, meta]) => statusFor(name, meta, false));
  return [...scheduled, ...manual].sort((a, b) => a.source.localeCompare(b.source));
}

/* -------------------------------------------------- what the app serves now */

/**
 * One entry per table the app SERVES, with a rule that answers "is this
 * current?" in SQL rather than in prose.
 *
 * WHY THIS IS NOT A LIST OF TIMESTAMPS. The obvious registry keys off an
 * `updated_at` column: when did we last write this. That is the wrong question
 * and it is the exact shape of the bug this registry exists to kill. A sync
 * that ran, succeeded and wrote nothing leaves a fresh timestamp on an empty
 * table, and the banner says healthy while the page serves nothing. This
 * project has shipped that failure more than once.
 *
 * So the primary mechanism here is COVERAGE: does the table actually hold rows
 * for the season and week the app is currently serving. A timestamp says when
 * we last tried. Coverage says whether the data is there. Only the second one
 * is what a user sees.
 *
 * That choice is also forced by the schema, which is worth knowing before
 * anyone proposes simplifying it: of the tables below, `player_week_usage`,
 * `schedule_games`, `nfl_injuries`, `nfl_depth`, `nfl_player_week_features`
 * and `league_roster_snapshots` have **no timestamp column at all**. A
 * timestamp-based registry could not describe them even if it wanted to, and
 * they are the tables the fantasy surfaces lean on hardest.
 *
 * CONTRACT, so the consumer can be written against it without reading this
 * file:
 *
 *   table       string  the SQLite table name
 *   season_col  string|null  its season column, null if it has none
 *   week_col    string|null  its week column, null if it is season-grained
 *   updated_col string|null  a write timestamp IF one exists. Usually null.
 *                            Never the basis of the verdict; useful only for
 *                            "we last tried at ..." next to the real answer.
 *   current_rule.text  one plain sentence, written for someone who does not
 *                      deal with stats, saying what current means here
 *   current_rule.sql   a query returning exactly one row, one column, 1 when
 *                      the table is current and 0 when it is not
 *   current_rule.params  the bind order for that SQL, e.g. ['season','week'].
 *                      Positional `?` rather than named, so the consumer does
 *                      not have to care which named-parameter dialect
 *                      node:sqlite accepts. db/index.js `row` is variadic, so
 *                      the call site spreads: row(sql, ...params.map(pick)).
 *                      Passing the array unspread throws "Unknown named
 *                      parameter '0'" -- found by the test, not in the banner.
 *   grain       'week' | 'season' | 'static'  how often it should move
 *
 * The season and week to bind come from `NFL_SEASON` and `currentNflWeek`
 * (weekly-learning.js) — the same pair the rest of the app serves from, so the
 * banner cannot disagree with the page beside it.
 *
 * DELIBERATELY NOT EXHAUSTIVE, and it says so rather than implying coverage it
 * does not have. 100 tables in this schema carry a season or week column; most
 * are internal (audit ledgers, replay caches, backfill checkpoints) and a
 * banner listing them would be noise a user has to learn to ignore. These are
 * the tables read on the served fantasy read path, taken from the query counts
 * in server/routes/. Betting-side tables are out of scope by Nick's ruling and
 * are not listed. Adding an entry is the mechanism for widening it.
 */
export function servedTables() {
  return [
    {
      table: 'player_week_usage',
      season_col: 'season', week_col: 'week', updated_col: null, grain: 'week',
      current_rule: {
        text: 'Weekly usage is current when it holds rows for this season up to '
          + 'the week being served. This is the table the whole fantasy model '
          + 'reads, so if it stops at an earlier week every projection quietly '
          + 'falls back to older form.',
        sql: 'SELECT CASE WHEN MAX(week) >= ? THEN 1 ELSE 0 END AS current '
          + 'FROM player_week_usage WHERE season = ?',
        params: ['week', 'season'],
      },
    },
    {
      table: 'nfl_player_week_features',
      season_col: 'season', week_col: 'week', updated_col: null, grain: 'week',
      current_rule: {
        text: 'The per-week feature rows the model scores from are current when '
          + 'they reach the week being served.',
        sql: 'SELECT CASE WHEN MAX(week) >= ? THEN 1 ELSE 0 END AS current '
          + 'FROM nfl_player_week_features WHERE season = ?',
        params: ['week', 'season'],
      },
    },
    {
      table: 'schedule_games',
      season_col: 'season', week_col: 'week', updated_col: null, grain: 'season',
      current_rule: {
        text: 'The schedule is current when this season\'s games are loaded at '
          + 'all. It is published once and rarely changes, so an empty season '
          + 'here means the season was never ingested rather than that it went '
          + 'stale.',
        sql: 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS current '
          + 'FROM schedule_games WHERE season = ?',
        params: ['season'],
      },
    },
    {
      table: 'nfl_injuries',
      season_col: 'season', week_col: 'week', updated_col: null, grain: 'week',
      current_rule: {
        text: 'Injury rows are current when they exist for the week being '
          + 'served. Last week\'s injuries are worse than none, because they '
          + 'read as a clean bill of health for someone who is out.',
        sql: 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS current '
          + 'FROM nfl_injuries WHERE season = ? AND week = ?',
        params: ['season', 'week'],
      },
    },
    {
      table: 'nfl_depth',
      season_col: 'season', week_col: 'week', updated_col: null, grain: 'week',
      current_rule: {
        text: 'Depth charts are current when they exist for the week being '
          + 'served. A depth chart is a live opinion, not a settled fact, so an '
          + 'old one is a wrong one.',
        sql: 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS current '
          + 'FROM nfl_depth WHERE season = ? AND week = ?',
        params: ['season', 'week'],
      },
    },
    {
      table: 'player_season_stats',
      season_col: 'season', week_col: null, updated_col: 'fetched_at', grain: 'season',
      current_rule: {
        text: 'Season totals are current when this season has rows. The '
          + 'fetched_at column says when we last pulled them, which is worth '
          + 'showing beside the answer but is not the answer.',
        sql: 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS current '
          + 'FROM player_season_stats WHERE season = ?',
        params: ['season'],
      },
    },
    {
      table: 'roster_players',
      season_col: null, week_col: null, updated_col: 'fetched_at', grain: 'week',
      current_rule: {
        text: 'League rosters are current when every connected league was '
          + 'refreshed within the last day. This is the one table where a '
          + 'timestamp is the right test, because a roster has no season or '
          + 'week of its own — it is simply whatever it was when we last looked.',
        sql: 'SELECT CASE WHEN MIN(fetched_at) >= datetime(\'now\', \'-1 day\') '
          + 'THEN 1 ELSE 0 END AS current FROM roster_players',
        params: [],
      },
    },
    {
      table: 'league_roster_snapshots',
      season_col: 'season', week_col: null, updated_col: null, grain: 'week',
      current_rule: {
        text: 'Roster history is current when this season has at least one '
          + 'snapshot. It is an append-only record, so the question is whether '
          + 'we started collecting this season, not whether it moved today.',
        sql: 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS current '
          + 'FROM league_roster_snapshots WHERE season = ?',
        params: ['season'],
      },
    },
    {
      table: 'news_items',
      season_col: null, week_col: null, updated_col: 'created_at', grain: 'week',
      current_rule: {
        text: 'News is current when something arrived in the last two days. '
          + 'A quiet stretch in the offseason is normal; two days of silence '
          + 'during a season means the feed stopped rather than that nothing '
          + 'happened.',
        sql: 'SELECT CASE WHEN MAX(created_at) >= datetime(\'now\', \'-2 days\') '
          + 'THEN 1 ELSE 0 END AS current FROM news_items',
        params: [],
      },
    },
    {
      table: 'players',
      season_col: null, week_col: null, updated_col: null, grain: 'static',
      current_rule: {
        text: 'The player universe is current when it is populated at all. It '
          + 'is the join target for nearly every other table, so empty here '
          + 'means the whole app is empty, not that one feed is late.',
        sql: 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS current FROM players',
        params: [],
      },
    },
  ];
}
