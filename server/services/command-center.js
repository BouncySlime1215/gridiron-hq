/**
 * SK-01 — the weekly command center: one list across every league the signed-in
 * user belongs to, sorted by deadline.
 *
 * IT COMPUTES NO NUMBER. Every figure on an item is read from an existing
 * producer, named here and on the response (`sources.<kind>.producer`):
 *
 *   dead_starter   SS-01's guard when dead-starters.js exists on this build: read
 *                  through its one consumer, lineup-brain.js#lineupCall, as
 *                  `dead_starters.items` (the same list the Start/Sit page shows),
 *                  and then lineupDiff is not called. Before SS-01:
 *                  trade-engine.js#lineupDiff `flagged_starters` (on IR, or flagged
 *                  out for the season); the bench swap is lineupDiff's own `swaps`.
 *   stream         streaming-board.js#streamingBoard (WV-01, PR #176) when that
 *                  module exists on this build; its `suggestion` only.
 *   injury_alert   waiver-wire.js#waiverBoard().injury_alerts (WV-02, PR #178)
 *                  when the field is present.
 *   no_move        league_transactions_raw (writer: the `upsert` statement in
 *                  scripts/collect-league-transactions.mjs, off-server): my team's
 *                  adds, claims and trades in the league's current scoring period.
 *
 * Absence is a state, never an empty list: a producer that is not on this build
 * reads `not_merged`, one that threw reads `error` (logged in full, a plain
 * sentence on the response), a
 * transaction store that was never collected reads `source_table_absent`, and a
 * collection older than MOVES_FRESH_MS reads `stale` — none of them becomes
 * "nothing to do".
 */
import { rows } from '../db/index.js';
import * as tradeEngine from './trade-engine.js';
import * as lineupBrain from './lineup-brain.js';
import * as waiverWire from './waiver-wire.js';
import { leagueCurrentWeek } from './league-week.js';
import { transactionsCollected } from './manager-signals.js';
import { linesFor } from './gamescript.js';
import { nflKickoffDate, zonedDateTime } from './date-util.js';
import { canonicalTeamCode } from './team-codes.js';

/**
 * Hand-set, not fitted: how old the transaction collection may be before
 * "0 moves this week" stops being a claim we can make. The collector runs by
 * hand (scripts/collect-league-transactions.mjs); a day-old read can miss a
 * claim made this morning, so past a day the nudge is withheld and the league
 * says "stale" instead.
 */
export const MOVES_FRESH_MS = 24 * 3600 * 1000;
/** Hand-set: how long one user's command center is reused before it is rebuilt. */
export const CACHE_MS = 10 * 60 * 1000;
/** What counts as a move: adds, waiver claims and trades, made or pending. Lineup sets (ROSTER) do not. */
export const MOVE_TYPES = ['FREEAGENT', 'WAIVER', 'TRADE_PROPOSAL', 'TRADE_ACCEPT'];
export const MOVE_STATUSES = ['EXECUTED', 'PENDING'];

const KIND_ORDER = { dead_starter: 0, injury_alert: 1, stream: 2, no_move: 3 };

/* ------------------------------------------------------------------ helpers */

const iso = d => (d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null);
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
const fmt = v => (Number.isFinite(Number(v)) ? String(+Number(v).toFixed(1)) : null);

/** Team -> kickoff ISO for one week, from game_lines (the pair WV-01 reads). */
export function kickoffMap(season, week) {
  const out = new Map();
  for (const g of linesFor(season, week)) {
    if (!g?.gameday) continue;
    const at = iso(nflKickoffDate(g.gameday, g.gametime || '23:59'));
    if (at) out.set(canonicalTeamCode(g.team), at);
  }
  return out;
}

function earliest(...values) {
  const known = values.filter(Boolean).map(v => [v, Date.parse(v)]).filter(([, t]) => Number.isFinite(t));
  if (!known.length) return null;
  return known.sort((a, b) => a[1] - b[1])[0][0];
}

/** A WV-02 claim_by / nextWaiverRun object -> { deadline, guess }. */
function waiverDeadline(run) {
  if (!run?.known || !run.date || !Number.isInteger(run.hour)) return { deadline: null, guess: false };
  // RL-16-2: a scheduled or observed run carries its exact instant; the settings guess is flagged.
  const at = run.at ?? iso(zonedDateTime(run.date, `${String(run.hour).padStart(2, '0')}:00`, run.zone || 'America/New_York'));
  return { deadline: at, guess: run.confirmed === false || /guess/i.test(String(run.zone_basis ?? '')) };
}

export function byDeadline(a, b) {
  const ta = a.deadline ? Date.parse(a.deadline) : Infinity;
  const tb = b.deadline ? Date.parse(b.deadline) : Infinity;
  if (ta !== tb) return ta - tb;
  return (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
}

/** SS-01 reason codes (dead-starters.js#deadReason) in words for the card's first line. */
const SS01_REASON = { ir: 'on IR', out_for_season: 'out for the season', out: 'listed Out',
  doubtful: 'listed Doubtful', bye: 'on bye', inactive: 'inactive' };

/**
 * Which dead-starter list a producer payload carries, in one shape.
 *   SS-01: lineupCall(...).dead_starters = { covered, starters_checked, items: [...] }
 *   before SS-01: lineupDiff(...).flagged_starters = [...]
 * `covered: false` (e.g. a non-ESPN league) is not a clear list: list is null and
 * `reason` says why.
 */
export function deadStarterList(diff) {
  const ss = diff?.dead_starters;
  if (ss && typeof ss === 'object' && !Array.isArray(ss)) {
    const producer = 'lineupCall.dead_starters (SS-01)';
    if (!ss.covered || !Array.isArray(ss.items)) {
      return { list: null, producer, reason: ss.reason ?? 'the dead-starter guard did not cover this league' };
    }
    return { producer, list: ss.items.map(i => ({
      id: i.player?.id, name: i.player?.name, position: i.player?.position, team_abbr: i.player?.team_abbr,
      reason: SS01_REASON[i.reason] ?? i.reason, ss01_reason: i.reason, kickoff: i.kickoff ?? null,
      replacement: i.replacement ?? null, ss01_why: i.why ?? null,
    })) };
  }
  if (Array.isArray(diff?.flagged_starters)) return { list: diff.flagged_starters, producer: 'lineupDiff.flagged_starters' };
  return { list: null, producer: null };
}

/* ------------------------------------------------------------ one league's items */

/**
 * Items for one league from producer outputs already in hand. Pure apart from
 * the kickoff read (game_lines), which a caller may pass as `kickoffs`.
 */
export function leagueItems({ league, diff, waivers, streams, moves, season, week, kickoffs = null, waiverRun = null }) {
  const items = [];
  const kick = kickoffs ?? kickoffMap(season, week);
  const base = kind => ({ league: { id: league.id, name: league.name }, kind });

  // Dead starters.
  const dead = deadStarterList(diff).list ?? [];
  const deadNames = new Set();
  for (const p of dead) {
    const name = p.name ?? p.player;
    deadNames.add(norm(name));
    const swap = (diff?.swaps ?? []).find(s => s.out && (s.out.id === p.id || norm(s.out.name) === norm(name)));
    const pts = fmt(p.week_points);
    let why = p.ss01_why ? p.ss01_why : swap?.in
      ? `Scores 0 this week; ${swap.in.name} on your bench projects ${fmt(swap.in.week_points)} pts.`
      : `Scores 0 this week${pts ? ` (projected ${pts} pts if he played)` : ''}; no bench player fits the slot.`;
    if (p.espn_disagrees) why += ` ESPN still lists him ${String(p.espn_status ?? 'active').toLowerCase()}: check before benching.`;
    items.push({
      ...base('dead_starter'),
      what: `${name} (${p.position}) is starting but ${p.reason ?? 'will not play'}`,
      why,
      action: { label: 'Fix lineup', href: '/lineup' },
      deadline: p.kickoff ?? kick.get(canonicalTeamCode(p.team_abbr ?? p.team)) ?? null,
      deadline_basis: 'kickoff', deadline_guess: false,
      tone: p.espn_disagrees || p.ss01_reason === 'doubtful' ? 'amber' : 'red',
    });
  }

  // Injury alerts (WV-02), minus anyone already listed as a dead starter.
  for (const a of Array.isArray(waivers?.injury_alerts) ? waivers.injury_alerts : []) {
    if (deadNames.has(norm(a.player))) continue;
    const same = a.replacements?.same_team?.[0] ?? null;
    const fa = a.replacements?.best_free_agent ?? null;
    const why = same
      ? `${same.player} (same team${same.on_your_roster ? ', on your roster' : ''}) projects ${fmt(same.projected_ppg)} pts this week.`
      : fa ? `Best healthy free agent at ${a.position}: ${fa.player}, ${fmt(fa.projected_ppg)} pts this week.`
        : `0 healthy same-team or free-agent replacements found at ${a.position}.`;
    const { deadline, guess } = waiverDeadline(a.claim_by);
    items.push({
      ...base('injury_alert'),
      what: `${a.player} (${a.position}) is ${String(a.status ?? a.designation ?? 'hurt').toLowerCase()}`,
      why,
      action: { label: 'Open waiver wire', href: '/lineup' },
      deadline, deadline_basis: deadline ? 'waiver run' : null, deadline_guess: guess,
      tone: 'red',
    });
  }

  // Streaming swap (WV-01): only an actionable suggestion becomes an item.
  const s = streams?.suggestion;
  if (s && (s.action === 'swap' || s.action === 'add') && s.add) {
    items.push({
      ...base('stream'),
      what: s.action === 'swap' && s.drop ? `Stream ${s.add.team} D/ST over ${s.drop.team}` : `Add ${s.add.team} D/ST`,
      why: s.why,
      action: { label: 'Open streaming board', href: '/lineup' },
      deadline: earliest(s.add.kickoff, s.drop?.kickoff), deadline_basis: 'kickoff', deadline_guess: false,
      tone: 'green',
    });
  }

  // No move yet this week: only on a fresh collection that counted zero.
  if (moves?.state === 'present' && moves.count === 0) {
    const best = (waivers?.immediate ?? [])[0] ?? null;
    const run = waiverDeadline(waiverRun ?? waivers?.waiver_run
      ?? (Array.isArray(waivers?.injury_alerts) ? waivers.injury_alerts[0]?.claim_by : null));
    items.push({
      ...base('no_move'),
      what: `No move yet in week ${week}`,
      why: `0 adds, claims or trades by you this week`
        + (best ? `; best claim on the wire: ${best.player}, +${fmt(best.upgrade)} pts this week.`
          : `; the waiver board shows 0 claims that help this week.`),
      action: { label: 'Open waiver wire', href: '/lineup' },
      deadline: run.deadline, deadline_basis: run.deadline ? 'waiver run' : null, deadline_guess: run.guess,
      tone: 'grey',
    });
  }
  return items.sort(byDeadline);
}

/* --------------------------------------------------------------- moves this week */

const tableExists = name =>
  rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).length > 0;

/** My team's moves in the league's current scoring period, with the read's state. */
export function movesThisWeek(lg, now = new Date()) {
  const week = leagueCurrentWeek(lg);
  if (!tableExists('league_transactions_raw')) {
    return { state: 'source_table_absent', count: null, week,
      message: 'your league moves have never been collected on this server' };
  }
  if (lg.my_team_id == null || lg.my_team_id === '') {
    return { state: 'no_team', count: null, week, message: 'this league does not know which team is yours' };
  }
  const collected = transactionsCollected(lg.id, lg.season);
  if (!collected.rows) return { state: 'not_collected', count: null, week, message: 'no league moves collected yet' };
  const age = now.getTime() - Date.parse(collected.as_of);
  if (!Number.isFinite(age) || age > MOVES_FRESH_MS) {
    return { state: 'stale', count: null, week, as_of: collected.as_of,
      message: 'league moves were last collected more than a day ago' };
  }
  const [r] = rows(`SELECT COUNT(*) AS n FROM league_transactions_raw
                    WHERE league_id = ? AND season = ? AND scoring_period = ? AND team_id = ?
                      AND type IN (${MOVE_TYPES.map(() => '?').join(',')})
                      AND status IN (${MOVE_STATUSES.map(() => '?').join(',')})`,
  lg.id, lg.season, week, Number(lg.my_team_id), ...MOVE_TYPES, ...MOVE_STATUSES);
  return { state: 'present', count: r?.n ?? 0, week, as_of: collected.as_of };
}

/* ------------------------------------------------------ feature-detected producers */

let streamingOverride; // undefined: detect; null: absent; function: use it (tests)
let streamingLoad = null;
async function streamingProducer() {
  if (streamingOverride !== undefined) return streamingOverride;
  streamingLoad ??= import('./streaming-board.js').then(
    m => (typeof m.streamingBoard === 'function' ? m.streamingBoard : null),
    e => {
      if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('streaming-board.js')) return null;
      throw e;
    });
  return streamingLoad;
}

// SS-01 detection: its module on this build means lineupCall carries `dead_starters`.
let deadStarterOverride; // undefined: detect; boolean: forced (tests)
let deadStarterLoad = null;
async function ss01Present() {
  if (deadStarterOverride !== undefined) return deadStarterOverride;
  deadStarterLoad ??= import('./dead-starters.js').then(
    m => typeof m.deadStarters === 'function',
    e => {
      if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('dead-starters.js')) return false;
      throw e;
    });
  return deadStarterLoad;
}

const FAILED = 'This check failed on the server this time; the failure is logged.';
let nowFn = () => new Date();
const cache = new Map();

export function __setStreamingProducer(fn) { streamingOverride = fn; }
export function __setDeadStarterGuard(on) { deadStarterOverride = on; }
export function __setNow(fn) { nowFn = fn ?? (() => new Date()); }
export function __clearCache() { cache.clear(); }

/** Run one producer; an exception becomes that source's `error` state, logged, never swallowed. */
function attempt(leagueId, kind, fn) {
  try {
    return { value: fn() };
  } catch (error) {
    // Logged in full here; the response carries a plain sentence only, so no
    // server internals (paths, table names) reach the page.
    console.error(`[command-center] ${kind} failed for league ${leagueId}:`, error);
    return { error: FAILED };
  }
}

/**
 * The checks that ran ('present') in EVERY league: the only ones the page may
 * report as a count ("0 dead starters"). A check that is not merged, switched
 * off, stale, failed or unsynced in any league is left out here and named under
 * the list instead. No leagues: nothing is clear.
 */
export const CHECKS = ['dead_starters', 'injury_alerts', 'streams', 'moves'];
export function clearChecks(leagues) {
  if (!leagues.length) return [];
  return CHECKS.filter(k => leagues.every(l => l.sources?.[k]?.state === 'present'));
}

/* ------------------------------------------------------------------- the route */

// Explicit columns: never leagues.espn_s2 or leagues.swid (they are cookies).
const LEAGUE_COLUMNS = `l.id, l.platform, l.league_id, l.season, l.name, l.my_team_id, l.team_count, l.ppr,
  l.superflex, l.roster_positions, l.payload, l.fetched_at, l.league_type, l.current_week, l.payload_season`;

export async function commandCenter(userId) {
  const now = nowFn();
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.value;

  const leagues = rows(`SELECT ${LEAGUE_COLUMNS} FROM leagues l JOIN league_memberships m ON m.league_id = l.id
                        WHERE m.user_id = ? ORDER BY l.id`, userId);
  const { season, week } = tradeEngine.tradeWeekContext();
  const stream = await streamingProducer();
  const ss01 = await ss01Present();
  const kickoffs = kickoffMap(season, week);
  const items = [];
  const out = [];

  for (const lg of leagues) {
    const league = { id: lg.id, name: lg.name };
    const sources = {};
    if (!lg.payload) {
      for (const k of ['dead_starters', 'injury_alerts', 'streams', 'moves']) sources[k] = { state: 'not_synced' };
      out.push({ ...league, week: null, sources });
      continue;
    }
    // One dead-starter producer per build: SS-01's guard (via lineupCall, the list
    // Start/Sit shows) when it exists, else lineupDiff's flagged starters.
    const diffR = attempt(lg.id, 'dead_starters', () => (ss01
      ? lineupBrain.lineupCall(lg.id, { myTeamId: lg.my_team_id })
      : tradeEngine.lineupDiff(lg, lg.my_team_id)));
    const dead = deadStarterList(diffR.value);
    sources.dead_starters = diffR.error ? { state: 'error', message: diffR.error }
      : diffR.value?.error ? { state: 'unavailable', message: diffR.value.error }
        : dead.list ? { state: 'present', producer: dead.producer, count: dead.list.length }
          : { state: 'unavailable', producer: dead.producer, message: dead.reason ?? 'the lineup check returned no starter list' };

    const wwR = attempt(lg.id, 'injury_alerts', () => waiverWire.waiverBoard(lg, { myTeamId: lg.my_team_id }));
    sources.injury_alerts = wwR.error ? { state: 'error', message: wwR.error }
      : wwR.value?.error ? { state: 'unavailable', message: wwR.value.error }
        : Array.isArray(wwR.value?.injury_alerts)
          ? { state: 'present', producer: 'waiverBoard.injury_alerts (WV-02)', count: wwR.value.injury_alerts.length }
          : { state: 'not_merged', waiting_on: 'WV-02 (PR #178)', message: 'not switched on in this version yet' };

    let streamR = { value: null };
    if (!stream) {
      sources.streams = { state: 'not_merged', waiting_on: 'WV-01 (PR #176)', message: 'not switched on in this version yet' };
    } else {
      streamR = attempt(lg.id, 'streams', () => stream(lg, { myTeamId: lg.my_team_id, season, week }));
      sources.streams = streamR.error ? { state: 'error', message: streamR.error }
        : streamR.value?.error ? { state: 'unavailable', message: streamR.value.error }
          // WV-01 ships its swap suggestion default-off until it holds on 2026
          // forward weeks; a gated suggestion is all-null. That is "switched off",
          // not "no better defense", and it is said as such.
          : streamR.value?.suggestion && streamR.value.suggestion.action == null && streamR.value.suggestion.why == null
            ? { state: 'default_off', producer: 'streamingBoard.suggestion (WV-01)',
              message: 'switched off until it is confirmed on this season\'s games' }
            : { state: 'present', producer: 'streamingBoard.suggestion (WV-01)', action: streamR.value?.suggestion?.action ?? null };
    }

    const movesR = attempt(lg.id, 'moves', () => movesThisWeek(lg, now));
    const moves = movesR.error ? { state: 'error', count: null, message: movesR.error } : movesR.value;
    sources.moves = { producer: 'league_transactions_raw', ...moves };

    const waiverRun = typeof waiverWire.nextWaiverRun === 'function'
      ? attempt(lg.id, 'waiver_run', () => waiverWire.nextWaiverRun(JSON.parse(lg.payload), now,
        typeof waiverWire.observedWaiverRuns === 'function' ? waiverWire.observedWaiverRuns(lg.id, lg.season) : [])).value ?? null
      : null;
    items.push(...leagueItems({
      league, season, week: moves.week ?? leagueCurrentWeek(lg), now, kickoffs, waiverRun,
      diff: diffR.value?.error ? null : diffR.value,
      waivers: wwR.value?.error ? null : wwR.value,
      streams: streamR.value?.error ? null : streamR.value,
      moves,
    }));
    out.push({ ...league, week: moves.week ?? null, sources });
  }

  items.sort(byDeadline);
  const value = {
    generated_at: now.toISOString(), season, nfl_week: week,
    items, leagues: out,
    clear_checks: clearChecks(out),
    empty_reason: !leagues.length ? 'no_leagues' : !items.length ? 'nothing_due' : null,
  };
  cache.set(key, { at: now.getTime(), value });
  return value;
}
