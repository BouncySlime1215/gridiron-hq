/**
 * The free movement detector.
 *
 * The Odds API is the only source here with multi-book depth, and it is metered
 * — the free tier is a few hundred credits a month and blind hourly polling
 * exhausts it in days (which is exactly what happened: multi-book capture went
 * from 8 books across 272 events on Aug 5 to 1 book on 1 event by Aug 27).
 *
 * ESPN's public scoreboard publishes a live DraftKings spread and total for
 * every game with no API key and no quota. That is one book, so it can never
 * price a shopping edge — but it is a perfectly good *reference line*, and a
 * reference line is all you need to answer "did anything move?".
 *
 *     ESPN scoreboard  →  free, unlimited      →  detect that the market moved
 *     The Odds API     →  paid, scarce         →  spend only once it has
 *
 * So this module polls ESPN as often as we like and records the movement log.
 * `capturesWorthSpending()` then names the events where a paid multi-book
 * snapshot would actually buy new information, which turns a small credit
 * budget from blind polling into a targeted instrument.
 */
import { db, rows, run } from '../db/index.js';
import { lineMoveValue } from './nfl-execution-edge.js';
import { recordSync } from './scheduler.js';

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SEASON = Number(process.env.NFL_SEASON) || 2026;

db.exec(`
  CREATE TABLE IF NOT EXISTS espn_line_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at TEXT NOT NULL,
    season INTEGER NOT NULL, week INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    home_team TEXT, away_team TEXT, commence_time TEXT,
    home_spread REAL, total REAL,
    prev_home_spread REAL, prev_total REAL,
    spread_delta REAL, total_delta REAL,
    -- What the spread move is worth in win probability, priced against the real
    -- NFL margin distribution. A half point across 3 is not a half point across 5.
    spread_move_value REAL,
    first_sighting INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_espn_moves_event ON espn_line_moves(event_id, observed_at);
  CREATE INDEX IF NOT EXISTS idx_espn_moves_time ON espn_line_moves(observed_at);
`);

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/** The most recent recorded state per event, which is what a new poll is diffed against. */
function latestByEvent(season, week) {
  const list = rows(
    `SELECT event_id, home_spread, total FROM espn_line_moves
     WHERE season = ? AND week = ?
       AND id IN (SELECT MAX(id) FROM espn_line_moves WHERE season = ? AND week = ? GROUP BY event_id)`,
    season, week, season, week);
  return new Map(list.map(x => [x.event_id, x]));
}

/**
 * Poll ESPN and append to the movement log.
 *
 * Deliberately writes a row ONLY when a number actually changed (or on first
 * sighting). Logging every poll would bury a handful of real moves under
 * thousands of identical rows and make "when did this move, and by how much" an
 * expensive diff instead of a trivial select. The table is a movement log, not
 * a poll log.
 */
export async function pollEspnLines({ season = SEASON, week = 1 } = {}) {
  let data;
  try {
    const res = await fetch(`${ESPN_SCOREBOARD}?seasontype=2&week=${week}&dates=${season}`,
      { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
    data = await res.json();
  } catch (e) {
    recordSync('espn_line_watch', 'error', e.message);
    return { error: e.message };
  }

  const previous = latestByEvent(season, week);
  const now = new Date().toISOString();
  let moves = 0, firstSeen = 0, unchanged = 0;
  const detected = [];

  for (const ev of data.events ?? []) {
    const c = ev.competitions?.[0];
    const odds = c?.odds?.[0];
    if (!odds) continue;
    const home = c.competitors?.find(x => x.homeAway === 'home');
    const away = c.competitors?.find(x => x.homeAway === 'away');
    if (!home || !away) continue;

    // ESPN quotes `spread` from the home side, negative = home favoured.
    const homeSpread = odds.spread == null ? null : Number(odds.spread);
    const total = odds.overUnder == null ? null : Number(odds.overUnder);
    if (homeSpread == null && total == null) continue;

    const prev = previous.get(ev.id);
    const spreadDelta = prev && prev.home_spread != null && homeSpread != null
      ? +(homeSpread - prev.home_spread).toFixed(2) : null;
    const totalDelta = prev && prev.total != null && total != null
      ? +(total - prev.total).toFixed(2) : null;

    if (prev && !spreadDelta && !totalDelta) { unchanged++; continue; }

    // A move's worth depends entirely on which numbers it crossed. Priced from
    // the home side, which is the side ESPN's spread is quoted on.
    const moveValue = prev && spreadDelta
      ? lineMoveValue(prev.home_spread, homeSpread) : null;

    run(`INSERT INTO espn_line_moves
      (observed_at, season, week, event_id, home_team, away_team, commence_time,
       home_spread, total, prev_home_spread, prev_total, spread_delta, total_delta,
       spread_move_value, first_sighting)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      now, season, week, ev.id,
      home.team?.abbreviation ?? null, away.team?.abbreviation ?? null, ev.date ?? null,
      homeSpread, total, prev?.home_spread ?? null, prev?.total ?? null,
      spreadDelta, totalDelta, r3(moveValue), prev ? 0 : 1);

    if (prev) {
      moves++;
      detected.push({ event_id: ev.id, matchup: `${away.team?.abbreviation} at ${home.team?.abbreviation}`,
        spread_delta: spreadDelta, total_delta: totalDelta, move_value: r3(moveValue) });
    } else firstSeen++;
  }

  const out = { season, week, moves, first_seen: firstSeen, unchanged, detected, polled_at: now, cost: 'free' };
  recordSync('espn_line_watch', 'ok', out);
  return out;
}

/** Scheduler entry point — polls whichever week is live. */
export async function refreshEspnLineWatch() {
  const week = Number(process.env.NFL_WEEK) || currentWeek();
  const result = await pollEspnLines({ season: SEASON, week });
  if (result.error) return result;
  const dispatch = await import('./nfl-capture-dispatch.js');
  result.triggers = dispatch.enqueueEspnMoveTriggers(result.detected, result.polled_at);
  // This is the only paid step, guarded inside the dispatcher by the configured
  // key, a 50-credit reserve and a cooldown that collapses simultaneous moves.
  result.capture = await dispatch.dispatchTriggeredCapture();
  return result;
}

/**
 * Best guess at the live week from the schedule we already store, so the poller
 * does not need a hand-set env var to follow the season.
 */
function currentWeek() {
  const r = rows(`SELECT week FROM game_lines WHERE season = ? AND team_score IS NULL
                  ORDER BY week LIMIT 1`, SEASON)[0];
  return r?.week ?? 1;
}

/* ------------------------------------------------------------- reading it */

export function recentMoves({ hours = 72, limit = 50 } = {}) {
  return rows(
    `SELECT observed_at, season, week, event_id, home_team, away_team, commence_time,
            prev_home_spread, home_spread, spread_delta, prev_total, total, total_delta,
            spread_move_value
     FROM espn_line_moves
     WHERE first_sighting = 0 AND observed_at >= datetime('now', ?)
     ORDER BY observed_at DESC LIMIT ?`,
    `-${hours} hours`, limit);
}

/**
 * Events where a paid multi-book snapshot would actually buy something.
 *
 * The reference line moving is the signal that books are re-pricing and are
 * therefore most likely to disagree with each other — which is precisely when a
 * multi-book capture is worth a credit, and precisely what blind hourly polling
 * cannot distinguish from a quiet market.
 */
export function capturesWorthSpending({ hours = 24, minMoveValue = 0.01 } = {}) {
  const moves = rows(
    `SELECT event_id, home_team, away_team, commence_time,
            MAX(ABS(spread_delta)) AS max_spread_delta,
            MAX(spread_move_value)  AS max_move_value,
            COUNT(*)                AS move_count,
            MAX(observed_at)        AS last_move_at
     FROM espn_line_moves
     WHERE first_sighting = 0 AND observed_at >= datetime('now', ?)
     GROUP BY event_id`, `-${hours} hours`);

  return moves
    .filter(m => (m.max_move_value ?? 0) >= minMoveValue || (m.max_spread_delta ?? 0) >= 1)
    .map(m => ({ ...m, matchup: `${m.away_team} at ${m.home_team}` }))
    .sort((a, b) => (b.max_move_value ?? 0) - (a.max_move_value ?? 0));
}

/**
 * The current slate as one row per SIDE, which is the shape a teaser leg check
 * needs — a Wong leg is defined from the bettor's own side (favourite −7.5 to
 * −8.5, or underdog +1.5 to +2.5), so a game has to be split in two before it
 * can be tested. Free: this reads the movement log, not the paid API.
 */
export function currentSlate({ season = SEASON, week = null } = {}) {
  const wk = week ?? currentWeek();
  const latest = rows(
    `SELECT event_id, home_team, away_team, commence_time, home_spread, total
     FROM espn_line_moves
     WHERE season = ? AND week = ?
       AND id IN (SELECT MAX(id) FROM espn_line_moves WHERE season = ? AND week = ? GROUP BY event_id)`,
    season, wk, season, wk);

  const sides = [];
  for (const g of latest) {
    if (g.home_spread == null) continue;
    const base = { event_id: g.event_id, matchup: `${g.away_team} at ${g.home_team}`,
      commence_time: g.commence_time, total: g.total };
    sides.push({ ...base, team: g.home_team, opponent: g.away_team, home: true, spread: g.home_spread });
    sides.push({ ...base, team: g.away_team, opponent: g.home_team, home: false, spread: -g.home_spread });
  }
  return { season, week: wk, games: latest.length, sides };
}

export function espnWatchStatus() {
  const total = rows('SELECT COUNT(*) AS n FROM espn_line_moves')[0]?.n ?? 0;
  const moves = rows('SELECT COUNT(*) AS n FROM espn_line_moves WHERE first_sighting = 0')[0]?.n ?? 0;
  const last = rows('SELECT MAX(observed_at) AS t FROM espn_line_moves')[0]?.t ?? null;
  const tracked = rows('SELECT COUNT(DISTINCT event_id) AS n FROM espn_line_moves')[0]?.n ?? 0;
  return {
    rows_logged: total, moves_detected: moves, events_tracked: tracked,
    last_poll: last, worth_capturing: capturesWorthSpending().length,
    cost: 'free — ESPN public scoreboard, no API key and no quota',
    note: 'One book, so this can never price a shopping edge. It exists to say WHEN a paid ' +
      'multi-book capture is worth spending a credit on.'
  };
}
