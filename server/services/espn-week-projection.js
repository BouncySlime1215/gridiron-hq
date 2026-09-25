/**
 * PROJ-ESPN: the SOURCE of the served weekly projection, frozen pre-kickoff ESPN.
 *
 * Why (ML testbench #446, frozen week 2026-W2): our own served weekly projection had the
 * highest error at every position, 0.7-1.8 pts per player worse than ESPN's projection
 * frozen before kickoff. So the one weekly producer (trade-engine.js#buildAssetUniverse,
 * `current_week_ppg`) now reads ESPN's number from espn_weekly_projection_snapshots
 * (#431, append-only) and our own number is kept as a SHADOW (weekly_projection_shadow).
 * Lineups, Start/Sit, the weekly range and the trade finder all read current_week_ppg, so
 * they inherit it. Rest-of-season and title odds (season sim, BASIS-02) are unchanged.
 *
 * Selection, per player: the latest capture strictly before his own kickoff (a row stored
 * `late = 1` never qualifies); before kickoff that is simply the latest capture. Scoring:
 * the league's own capture (`league:<leagues.id>`) when that week has one, else ESPN's PPR
 * defaults (`ppr`).
 *
 * Hard fail, never a silent fallback: if the newest capture for the week is more than
 * STALE_DAYS old (or there is none), the week's status is 'unknown' with a reason, every
 * skill player's served week number is null (not ours), and number_health carries a
 * broken `espn_projection_stale` row (number-audit.js).
 *
 * GRIDIRON_PROJ_ESPN: default ON ('1' or unset); '0' reverts to our own projection.
 * Deliberately not tied to preview mode: this is a served-number change justified by #446.
 */
import { db } from '../db/index.js';
import { SCORING_PPR, leagueScoringKey } from './espn-weekly-projection-capture.js';

export const PROJ_ESPN_ENV = 'GRIDIRON_PROJ_ESPN';
export const STALE_DAYS = 7;
const DAY_MS = 86400e3;
/** Positions the capture covers (espn-weekly-projection-capture.js SLOT_IDS). */
export const ESPN_CAPTURED_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

/** { on }: read per call so a test or a run can flip it. Default on; only '0' turns it off. */
export function projEspnFlag() {
  return { on: process.env[PROJ_ESPN_ENV] !== '0' };
}

/** The scoring key for a league: its own capture when that week has one, else PPR. */
export function scoringKeyFor(leagueRowId, season, week, database = db) {
  if (leagueRowId != null) {
    const key = leagueScoringKey(leagueRowId);
    const has = database.prepare(`SELECT 1 FROM espn_weekly_projection_captures
      WHERE season = ? AND week = ? AND scoring_key = ? AND status = 'ok' LIMIT 1`).get(season, week, key);
    if (has) return key;
  }
  return SCORING_PPR;
}

const tableExists = (database, name) => Boolean(database.prepare(
  `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));

/**
 * The served ESPN week for one (season, week, league), as of `now`.
 * -> { status: 'ok' | 'unknown', reason?, scoring_key, newest_capture_at, age_days,
 *      byEspnId: Map<espn_id, { pts, captured_at, kickoff_at, player_id, position }> }
 * With status 'unknown' byEspnId is empty: nothing stale is ever served. `replay` (the coverage
 * replay of a finished week) skips the staleness rule only; `statusOnly` skips the per-player read.
 */
export function espnWeekProjections({ season, week, leagueRowId = null, now = Date.now(), database = db, replay = false,
  statusOnly = false } = {}) {
  const base = { season: Number(season), week: Number(week), scoring_key: SCORING_PPR,
    newest_capture_at: null, age_days: null, byEspnId: new Map() };
  if (!tableExists(database, 'espn_weekly_projection_snapshots')) {
    return { ...base, status: 'unknown', reason: 'The frozen ESPN projection tables do not exist (migration 106 not applied).' };
  }
  const nowIso = new Date(now).toISOString();
  const key = scoringKeyFor(leagueRowId, season, week, database);
  const newest = database.prepare(`SELECT MAX(captured_at) AS at FROM espn_weekly_projection_captures
    WHERE season = ? AND week = ? AND scoring_key = ? AND status = 'ok' AND captured_at <= ?`)
    .get(season, week, key, nowIso)?.at ?? null;
  const out = { ...base, scoring_key: key, newest_capture_at: newest };
  if (!newest) {
    return { ...out, status: 'unknown',
      reason: `No frozen ESPN projection has been captured for ${season} week ${week}; the weekly projection is not served.` };
  }
  const ageDays = (now - Date.parse(newest)) / DAY_MS;
  out.age_days = +ageDays.toFixed(2);
  // A replay (range-calibration.js) reads every past week's pre-kickoff rows; staleness is a serving rule.
  if (!replay && ageDays > STALE_DAYS) {
    return { ...out, status: 'unknown',
      reason: `The newest frozen ESPN projection for week ${week} is ${ageDays.toFixed(1)} days old (limit ${STALE_DAYS}); the weekly projection is not served.` };
  }
  // A cache key needs the status only (espnSnapshotStamp, trade-engine.js#assetInputsKey).
  if (statusOnly) return { ...out, status: 'ok' };
  // Latest pre-kickoff row per player, as of now.
  const picked = database.prepare(`
    SELECT s.espn_id, s.player_id, s.position, s.projected_pts, s.captured_at, s.kickoff_at
    FROM espn_weekly_projection_snapshots s
    JOIN (SELECT espn_id, MAX(captured_at) AS at FROM espn_weekly_projection_snapshots
          WHERE season = ? AND week = ? AND scoring_key = ? AND late = 0 AND captured_at <= ?
            AND (kickoff_at IS NULL OR captured_at < kickoff_at)
          GROUP BY espn_id) last ON last.espn_id = s.espn_id AND last.at = s.captured_at
    WHERE s.season = ? AND s.week = ? AND s.scoring_key = ?`)
    .all(season, week, key, nowIso, season, week, key);
  for (const r of picked) {
    out.byEspnId.set(Number(r.espn_id), { pts: Number(r.projected_pts), captured_at: r.captured_at,
      kickoff_at: r.kickoff_at ?? null, player_id: r.player_id ?? null, position: r.position ?? null });
  }
  // Players whose kickoff has passed with no pre-kickoff capture: named, so the page can say why.
  out.late_only = database.prepare(`SELECT COUNT(DISTINCT espn_id) AS n FROM espn_weekly_projection_snapshots
      WHERE season = ? AND week = ? AND scoring_key = ? AND captured_at <= ?
        AND espn_id NOT IN (SELECT espn_id FROM espn_weekly_projection_snapshots
          WHERE season = ? AND week = ? AND scoring_key = ? AND late = 0 AND captured_at <= ?
            AND (kickoff_at IS NULL OR captured_at < kickoff_at))`)
    .get(season, week, key, nowIso, season, week, key, nowIso)?.n ?? 0;
  return { ...out, status: 'ok' };
}

/**
 * One player's served week number under PROJ-ESPN.
 * -> { value: number|null, source, status: 'ok'|'unknown', reason?, captured_at? }
 *   skill player with a row      ESPN's number
 *   skill player without one     null + 'unknown' (ESPN published none before his kickoff)
 *   K / D/ST                     ESPN's number from the synced league payload (`kdst`), the
 *                                same source the season sim scores them on; else ours, labelled
 *   week 'unknown' (stale)       null + the week's reason, for every skill player
 * `onBye` is a known 0 whatever the source.
 */
export function servedWeekFor(p, week, { onBye = false, ours = null, kdst = null } = {}) {
  if (onBye) return { value: 0, source: 'bye', status: 'ok' };
  if (!ESPN_CAPTURED_POSITIONS.has(p.position)) {
    if (Number.isFinite(kdst)) return { value: kdst, source: 'espn_league_payload', status: 'ok' };
    return { value: ours, source: 'ours', status: 'ok',
      reason: 'ESPN\'s frozen capture covers QB/RB/WR/TE only and the league payload has no projection for him.' };
  }
  if (week.status !== 'ok') return { value: null, source: 'espn_frozen', status: 'unknown', reason: week.reason };
  const hit = p.espn_id != null ? week.byEspnId.get(Number(p.espn_id)) : undefined;
  if (!hit) {
    return { value: null, source: 'espn_frozen', status: 'unknown',
      reason: 'ESPN published no projection for him before his kickoff this week.' };
  }
  return { value: +hit.pts.toFixed(2), source: 'espn_frozen', status: 'ok', captured_at: hit.captured_at,
    kickoff_at: hit.kickoff_at };
}

/**
 * The SHADOW log: our own weekly number beside the served one, per player-week. A row keeps
 * updating until its kickoff, then freezes (the pre-kickoff pair is what gets graded).
 * `entries`: [{ player_id, ours, espn, captured_at, kickoff_at, served }].
 * Returns the number of rows written; a failure throws (the caller logs it by name).
 */
export function logWeeklyShadow({ season, week, scoringKey, entries, now = Date.now(), database = db }) {
  if (!entries?.length) return 0;
  const at = new Date(now).toISOString();
  const stmt = database.prepare(`INSERT INTO weekly_projection_shadow
      (season, week, player_id, scoring_key, ours, espn, captured_at, kickoff_at, served, first_logged_at, logged_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (season, week, player_id, scoring_key) DO UPDATE SET
      ours = excluded.ours, espn = excluded.espn, captured_at = excluded.captured_at,
      kickoff_at = excluded.kickoff_at, served = excluded.served, logged_at = excluded.logged_at
    WHERE weekly_projection_shadow.kickoff_at IS NULL OR excluded.logged_at < weekly_projection_shadow.kickoff_at`);
  let n = 0;
  database.exec('BEGIN');
  try {
    for (const e of entries) {
      const r = stmt.run(season, week, e.player_id, scoringKey, e.ours ?? null, e.espn ?? null,
        e.captured_at ?? null, e.kickoff_at ?? null, e.served, at, at);
      n += Number(r.changes ?? 0);
    }
    database.exec('COMMIT');
  } catch (err) { database.exec('ROLLBACK'); throw err; }
  return n;
}

/**
 * What a cached consumer of the served week must key on (league-world.js): the week's status
 * and newest capture, and the width k in force. Cheap: two indexed reads.
 */
export function espnSnapshotStamp({ season, week, leagueRowId = null, now = Date.now(), database = db } = {}) {
  const w = espnWeekProjections({ season, week, leagueRowId, now, database, statusOnly: true });
  const kId = tableExists(database, 'range_calibration')
    ? database.prepare('SELECT MAX(id) AS id FROM range_calibration').get()?.id ?? 0 : 'none';
  return `${w.status}:${w.scoring_key}:${w.newest_capture_at ?? ''}:k${kId}`;
}

/** Health of the served ESPN week for number_health (number-audit.js `espn_projection_stale`). */
export function espnProjectionHealth({ season, week, leagueRowId = null, now = Date.now(), database = db } = {}) {
  const flag = projEspnFlag();
  if (!flag.on) return { flag: 'off', status: 'off' };
  const w = espnWeekProjections({ season, week, leagueRowId, now, database });
  return { flag: 'on', status: w.status, reason: w.reason ?? null, scoring_key: w.scoring_key,
    newest_capture_at: w.newest_capture_at, age_days: w.age_days, players: w.byEspnId.size,
    late_only: w.late_only ?? 0, season: Number(season), week: Number(week) };
}

