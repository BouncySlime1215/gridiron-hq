/**
 * E-XGB phase 1: freeze ESPN's weekly projected fantasy points BEFORE kickoff.
 *
 * Why: the only way to test "can a model beat ESPN's weekly projection" honestly is
 * against ESPN numbers that provably existed before each game (M3 research note;
 * docs/tdd/EXGB-PREREG.md). ESPN re-serves a week's projection after the game, so a
 * value fetched later is not evidence of what a manager saw. Every week not captured
 * is lost for good.
 *
 * What: at each capture window (Tuesday after waivers, Saturday morning, and 2 h
 * before every kickoff instant) one kona_player_info read per scoring config - ESPN's
 * PPR defaults (`ppr`, public, no cookie) and each connected ESPN league's own
 * scoring (`league:<leagues.id>`, with that league's cookies, exactly as
 * espn-market.js reads it). Rows go into espn_weekly_projection_snapshots
 * (migration 106), append-only. A row captured at or after its player's own kickoff
 * is stored with late = 1 and is never graded (frozenEspnForGrading).
 *
 * Never logs or stores a cookie: the URL hash covers the URL and filter only.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { db, row, rows, run } from '../db/index.js';
import { BROWSER_HEADERS, PRO_TEAM } from './espn-draft.js';
import { nflKickoffDate, zonedDateTime } from './date-util.js';

const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const POSITION = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE' };
const SLOT_IDS = [0, 2, 4, 6]; // QB, RB, WR, TE
const PLAYER_LIMIT = 1500;
const FETCH_TIMEOUT_MS = 30_000;
const PRE_KICK_MS = 2 * 3600e3;
const DAY_MS = 86400e3;
export const SCORING_PPR = 'ppr';

export const leagueScoringKey = leagueRowId => `league:${leagueRowId}`;

export function buildProjectionFilter(season, week, limit = PLAYER_LIMIT) {
  return { players: {
    limit,
    filterSlotIds: { value: SLOT_IDS },
    sortPercOwned: { sortPriority: 1, sortAsc: false },
    filterStatsForTopScoringPeriodIds: { value: 2, additionalValue: [`11${season}${week}`] },
  } };
}

export function projectionUrl({ season, week, espnLeagueId = null }) {
  const scope = espnLeagueId == null ? 'leaguedefaults/3' : `leagues/${encodeURIComponent(espnLeagueId)}`;
  return `${BASE}/seasons/${season}/segments/0/${scope}?view=kona_player_info&scoringPeriodId=${week}`;
}

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
export const urlHash = (url, filter) => sha256(`${url}\n${JSON.stringify(filter)}`);

/** This week's ESPN projection (statSourceId 1) per player; actuals and other weeks are ignored. */
export function parseProjectionPayload(payload, { season, week }) {
  const out = [];
  for (const e of payload?.players ?? []) {
    const p = e?.player ?? e;
    if (p?.id == null) continue;
    const s = (p.stats ?? []).find(x => x.statSourceId === 1 && x.scoringPeriodId === week
      && x.seasonId === season && (x.statSplitTypeId ?? 1) === 1);
    if (!s || !Number.isFinite(s.appliedTotal)) continue;
    out.push({ espn_id: Number(p.id), position: POSITION[p.defaultPositionId] ?? null,
      pro_team: PRO_TEAM[p.proTeamId] ?? null, injury_status: p.injuryStatus ?? null,
      projected_pts: s.appliedTotal });
  }
  return out;
}

/** The slim payload kept (gzipped) with each capture: every field a row was parsed from. */
function slimPayload(payload, { season, week }) {
  return { players: (payload?.players ?? []).map(e => {
    const p = e?.player ?? e;
    return { id: p?.id, onTeamId: e?.onTeamId ?? null, proTeamId: p?.proTeamId, defaultPositionId: p?.defaultPositionId,
      injuryStatus: p?.injuryStatus ?? null,
      stats: (p?.stats ?? []).filter(x => x.statSourceId === 1 && x.scoringPeriodId === week && x.seasonId === season) };
  }) };
}

/** The leakage guard: 1 when captured at or after kickoff. Unknown kickoff is 0 here and ungradable later. */
export function isLate(capturedAt, kickoffAt) {
  if (!kickoffAt) return 0;
  return Date.parse(capturedAt) >= Date.parse(kickoffAt) ? 1 : 0;
}

/** team -> kickoff ISO for one week, from game_lines (Eastern wall time, like game-cutoff.js). */
export function kickoffsByTeam(season, week) {
  const out = new Map();
  for (const g of rows('SELECT team, gameday, gametime FROM game_lines WHERE season = ? AND week = ? AND gameday IS NOT NULL',
    Number(season), Number(week))) {
    const at = nflKickoffDate(g.gameday, g.gametime || '23:59');
    if (at) out.set(String(g.team).toUpperCase(), at.toISOString());
  }
  return out;
}

const etDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const etWeekday = ms => new Date(`${etDate(ms)}T12:00:00Z`).getUTCDay();
const etAt = (ms, time) => zonedDateTime(etDate(ms), time).getTime();

/**
 * The capture windows of one game week, from its kickoff instants:
 *   tue_post_waivers  Tuesday 12:00 ET before the week's first game, until Saturday's opens
 *   sat_morning       Saturday 09:00-21:00 ET
 *   pre_kick_<iso>    the 2 h before each distinct kickoff instant
 * A window never closes after the kickoff it serves, so a capture inside it is pre-kickoff.
 */
export function captureWindows(kickoffIsos) {
  const kicks = [...new Set(kickoffIsos)].map(Date.parse).filter(Number.isFinite).sort((a, b) => a - b);
  if (!kicks.length) return [];
  const first = kicks[0];
  const back = (etWeekday(first) - 2 + 7) % 7; // days back to Tuesday
  const tueNoon = etAt(first - back * DAY_MS, '12:00');
  const satOpen = etAt(tueNoon + 4 * DAY_MS, '09:00');
  const satClose = etAt(tueNoon + 4 * DAY_MS, '21:00');
  const iso = ms => new Date(ms).toISOString();
  const out = [
    { key: 'tue_post_waivers', opens_at: iso(tueNoon), closes_at: iso(Math.min(satOpen, first)) },
    { key: 'sat_morning', opens_at: iso(satOpen), closes_at: iso(satClose) },
    ...kicks.map(k => ({ key: `pre_kick_${iso(k)}`, opens_at: iso(k - PRE_KICK_MS), closes_at: iso(k) })),
  ];
  return out.filter(w => Date.parse(w.closes_at) > Date.parse(w.opens_at));
}

function capturedWindowKeys(season, week) {
  const keys = new Set();
  for (const c of rows(`SELECT window_key FROM espn_weekly_projection_captures
                        WHERE season = ? AND week = ? AND status = 'ok'`, season, week)) {
    for (const k of String(c.window_key).split('+')) keys.add(k);
  }
  return keys;
}

function leaguesToCapture(season, leagueRowIds) {
  const envIds = String(process.env.GRIDIRON_ESPN_PROJ_LEAGUES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const ids = leagueRowIds ?? (envIds.length && envIds[0] !== 'all' ? envIds.map(Number) : null);
  const all = rows(`SELECT id, league_id, espn_s2, swid FROM leagues
                    WHERE platform = 'espn' AND season = ? ORDER BY id`, season);
  return ids == null ? all : all.filter(l => ids.includes(l.id));
}

function recordCapture(c) {
  run(`INSERT INTO espn_weekly_projection_captures (capture_id, season, week, scoring_key, window_key, captured_at,
         source_url_hash, payload_sha256, payload_gz, n_players, n_rows, n_late, status, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  c.capture_id, c.season, c.week, c.scoring_key, c.window_key, c.captured_at, c.source_url_hash,
  c.payload_sha256 ?? null, c.payload_gz ?? null, c.n_players ?? 0, c.n_rows ?? 0, c.n_late ?? 0, c.status, c.error ?? null);
}

async function captureOne({ season, week, scoringKey, league, windowKey, now, fetchImpl, kickoffs, playerIds }) {
  const filter = buildProjectionFilter(season, week);
  const url = projectionUrl({ season, week, espnLeagueId: league?.league_id ?? null });
  const headers = { ...BROWSER_HEADERS, 'x-fantasy-filter': JSON.stringify(filter) };
  if (league?.espn_s2 && league?.swid) headers.Cookie = `espn_s2=${league.espn_s2}; SWID=${league.swid}`;
  const capturedAt = now.toISOString();
  const base = { capture_id: `${season}-w${week}-${scoringKey}-${windowKey}-${capturedAt}`, season, week,
    scoring_key: scoringKey, window_key: windowKey, captured_at: capturedAt, source_url_hash: urlHash(url, filter) };
  let text, payload;
  try {
    const resp = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`ESPN kona_player_info ${resp.status}`);
    text = await resp.text();
    payload = JSON.parse(text);
  } catch (e) {
    // Only our own message or the runtime's; the request headers are never part of it.
    const error = String(e?.message ?? e).replace(/espn_s2=[^;\s]*|SWID=[^;\s]*/gi, '[redacted]').slice(0, 300);
    recordCapture({ ...base, status: 'error', error });
    return { ...base, status: 'error', error, rows: 0, late: 0 };
  }
  const parsed = parseProjectionPayload(payload, { season, week });
  let late = 0;
  db.exec('BEGIN');
  try {
    for (const r of parsed) {
      const kickoffAt = r.pro_team ? kickoffs.get(r.pro_team) ?? null : null;
      const isLateRow = isLate(capturedAt, kickoffAt);
      late += isLateRow;
      run(`INSERT INTO espn_weekly_projection_snapshots (season, week, player_id, espn_id, position, pro_team,
             injury_status, projected_pts, scoring_key, captured_at, kickoff_at, late, window_key, capture_id, source_url_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      season, week, playerIds.get(r.espn_id) ?? null, r.espn_id, r.position, r.pro_team, r.injury_status,
      r.projected_pts, scoringKey, capturedAt, kickoffAt, isLateRow, windowKey, base.capture_id, base.source_url_hash);
    }
    recordCapture({ ...base, status: 'ok', payload_sha256: sha256(text),
      payload_gz: zlib.gzipSync(JSON.stringify(slimPayload(payload, { season, week }))),
      n_players: payload?.players?.length ?? 0, n_rows: parsed.length, n_late: late });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ...base, status: 'ok', rows: parsed.length, late };
}

/** One capture of one week: PPR defaults plus each selected league's own scoring. */
export async function captureWeek({ season, week, windowKey, now = new Date(), fetchImpl = globalThis.fetch,
  leagueRowIds } = {}) {
  const kickoffs = kickoffsByTeam(season, week);
  const playerIds = new Map(rows('SELECT id, espn_id FROM players WHERE espn_id IS NOT NULL')
    .map(p => [Number(p.espn_id), p.id]));
  const targets = [{ scoringKey: SCORING_PPR, league: null },
    ...leaguesToCapture(season, leagueRowIds).map(l => ({ scoringKey: leagueScoringKey(l.id), league: l }))];
  const captures = [];
  for (const t of targets) {
    captures.push(await captureOne({ season, week, windowKey, now, fetchImpl, kickoffs, playerIds, ...t }));
  }
  const failed = captures.filter(c => c.status === 'error').length;
  return { season, week, window_key: windowKey, captures: captures.map(({ capture_id, ...c }) => c),
    attempted: captures.length, failed, rows: captures.reduce((s, c) => s + c.rows, 0) };
}

/**
 * The scheduled job. Looks at the in-progress and the next game week, and captures every
 * window that is open now and has no successful capture yet (several open windows share
 * one capture, keyed 'a+b'). Outside every window it does nothing.
 */
export async function runEspnWeeklyProjectionCapture({ now = new Date(), fetchImpl = globalThis.fetch,
  leagueRowIds, season } = {}) {
  const yr = season ?? row('SELECT MAX(season) AS s FROM game_lines')?.s;
  if (!yr) return { skipped: 'no game_lines season to schedule captures from' };
  const nowIso = now.toISOString();
  const weeks = [];
  for (const w of rows('SELECT DISTINCT week FROM game_lines WHERE season = ? AND week IS NOT NULL ORDER BY week', yr)) {
    const kicks = [...kickoffsByTeam(yr, w.week).values()];
    if (kicks.some(k => k > nowIso)) weeks.push({ week: w.week, kicks });
    if (weeks.length === 2) break;
  }
  const done = [];
  let attempted = 0, failed = 0, rowsWritten = 0;
  for (const { week, kicks } of weeks) {
    const have = capturedWindowKeys(yr, week);
    const due = captureWindows(kicks).filter(w => w.opens_at <= nowIso && nowIso < w.closes_at && !have.has(w.key));
    if (!due.length) continue;
    const key = due.map(w => w.key).join('+');
    const r = await captureWeek({ season: yr, week, windowKey: key, now, fetchImpl, leagueRowIds });
    attempted += r.attempted; failed += r.failed; rowsWritten += r.rows;
    if (r.failed < r.attempted) done.push(`w${week}:${key}`);
  }
  return { season: yr, weeks: weeks.map(w => w.week), captured: done.length, windows: done,
    attempted, failed, rows: rowsWritten };
}

/**
 * The frozen ESPN number to grade against, per player: the latest capture strictly before
 * that player's own kickoff. Late rows and rows with no known kickoff never qualify.
 */
export function frozenEspnForGrading(season, week, scoringKey = SCORING_PPR) {
  return rows(`
    SELECT s.espn_id, s.player_id, s.position, s.pro_team, s.projected_pts, s.captured_at, s.kickoff_at, s.window_key
    FROM espn_weekly_projection_snapshots s
    JOIN (SELECT espn_id, MAX(captured_at) AS at FROM espn_weekly_projection_snapshots
          WHERE season = ? AND week = ? AND scoring_key = ? AND late = 0
            AND kickoff_at IS NOT NULL AND captured_at < kickoff_at
          GROUP BY espn_id) last ON last.espn_id = s.espn_id AND last.at = s.captured_at
    WHERE s.season = ? AND s.week = ? AND s.scoring_key = ?
    ORDER BY s.espn_id`, season, week, scoringKey, season, week, scoringKey);
}
