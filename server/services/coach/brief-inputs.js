/**
 * COACH-BRIEF inputs: what changed overnight, read as rows the brief can cite.
 *
 * Every reader that reads takes the app DB as an argument and returns one section:
 *   { status: 'ok', rows, as_of } | { status: 'unknown', reason, rows: [] }
 * `keys` name the raw rows an 'ok' section used; a reader skips any key in
 * `exclude` (rows an earlier brief already reported, see brief.js windowStart).
 * An absent table or DB is 'unknown' with the reason, never an empty 'ok', so
 * the brief says "not read" instead of "nothing happened". Any other SQL error
 * throws: a broken read must not pass for a quiet night.
 *
 * Statements and credibility are read ONLY through their producers' own
 * readers: chat labels from PULSE-01's people_pulse (#316) via
 * people/pulse.js#recentPulse, and per-manager follow-through from CRED-01's
 * people_credibility (#321) via people/credibility.js#readCredibility. Each is
 * typed unknown only when its producer has no row for the league and window
 * (table absent, never run, or not run since the window opened). The brief
 * never opens the chat DB and keeps no labeller or credibility bar of its own:
 * "credible" is PULSE-01's CREDIBLE_LIFT, the weight is CRED-01's (one producer
 * per number).
 */
import { createRequire } from 'node:module';
import { readCredibility as credibilityRun, METHOD_VERSION } from '../people/credibility.js';

const require = createRequire(import.meta.url);
let pulseModule = null;
/**
 * PULSE-01's module, loaded on the first read. A static import would open the
 * app DB (pulse.js imports db/index.js), and the brief must open nothing while
 * its flag is off (scripts/coach/morning-brief.mjs checks the flag after
 * importing brief.js). Same module instance as any static import of it.
 */
function pulse() {
  return (pulseModule ??= require('../people/pulse.js'));
}

const unknown = reason => ({ status: 'unknown', reason, rows: [] });
const inWindow = col => `julianday(${col}) > julianday(?) AND julianday(${col}) <= julianday(?)`;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export const PULSE_NOT_BUILT =
  'no people_pulse table on this database: PULSE-01 (migration 098) has not been applied here';
export const CRED_NOT_BUILT =
  'no people_credibility table on this database: CRED-01 (migration 099) has not been applied here';
/** How many statements a morning read takes from the producer, newest first. */
export const MAX_STATEMENTS = 200;
/** The follow-through window the brief reports, the one PULSE-01 weighs statements by. */
export const CRED_WINDOW_DAYS = 7;

/**
 * Labelled statements league-mates made in the window, from PULSE-01's reader.
 * Rows: { id, roster_id, type, phrase, credible, weight, as_of, ago } (labels and
 * a ticker phrase, never chat text or a manager name). Typed unknown when the
 * table is absent, the pulse never ran for this league, or its last run is not
 * after the window opened (a pulse that has not looked is not a quiet night).
 */
export function readStatements(db, { leagueId, since, until, exclude = new Set() } = {}) {
  if (!db || !tableExists(db, 'people_pulse') || !tableExists(db, 'people_pulse_runs')) return unknown(PULSE_NOT_BUILT);
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  const hours = Math.max(0, (untilMs - sinceMs) / 3600e3);
  const r = pulse().recentPulse(leagueId, { database: db, now: new Date(untilMs), hours, limit: MAX_STATEMENTS });
  if (r.status !== 'ok') return unknown(PULSE_NOT_BUILT);
  if (!r.last_run) return unknown(`PULSE-01 has not run for league ${leagueId}: no people_pulse run is recorded`);
  if (!(Date.parse(r.last_run.ran_at) > sinceMs)) {
    return unknown(`PULSE-01 has not run since this window opened: its last run was ${r.last_run.ran_at}`);
  }
  const rows = r.items
    .filter(it => Date.parse(it.as_of) > sinceMs && !exclude.has(`p:${it.id}`))
    .map(it => ({ id: it.id, roster_id: Number(it.roster_id), type: it.type, phrase: it.phrase, credible: it.credible,
      weight: it.weight ?? null, as_of: it.as_of, ago: it.ago }));
  return { status: 'ok', rows, keys: rows.map(x => `p:${x.id}`), as_of: until, last_run: r.last_run.ran_at,
    credible_lift: pulse().CREDIBLE_LIFT };
}

/**
 * Who is credible: CRED-01's newest run at or before `until`, its per-manager
 * rows for the CRED_WINDOW_DAYS window whose weight clears PULSE-01's
 * CREDIBLE_LIFT, strongest first. Rows: { roster_id, stmt_type, outcome,
 * window_days, weight, n_statements, status }. Typed unknown when the table is
 * absent or the producer has no run for this league by then.
 */
export function readCredibility(db, { leagueId, until } = {}) {
  if (!db || !tableExists(db, 'people_credibility')) return unknown(CRED_NOT_BUILT);
  const run = credibilityRun(db, leagueId, { asOf: until ?? null });
  if (!run) return unknown(`CRED-01 has no ${METHOD_VERSION} run for league ${leagueId} at or before this brief`);
  const bar = pulse().CREDIBLE_LIFT;
  const rows = [];
  for (const [roster, types] of Object.entries(run.rosters)) {
    for (const [type, windows] of Object.entries(types)) {
      const x = windows[CRED_WINDOW_DAYS];
      if (!x || x.weight == null || !(x.weight >= bar) || !['proven', 'manager_split'].includes(x.status)) continue;
      rows.push({ roster_id: Number(roster), stmt_type: type, outcome: x.outcome, window_days: x.window_days,
        weight: x.weight, n_statements: x.n_statements, status: x.status });
    }
  }
  rows.sort((a, b) => b.weight - a.weight || a.roster_id - b.roster_id || a.stmt_type.localeCompare(b.stmt_type));
  return { status: 'ok', rows, as_of: run.as_of, credible_lift: bar, window_days: CRED_WINDOW_DAYS };
}

const OUTCOME_REPLY = { accepted: 'accept', declined: 'decline', countered: 'counter', expired: 'silence' };

/**
 * Replies to Nick's offers in the window, from two writers:
 *   trade_outcomes   an offer he proposed that resolved (067)
 *   warroom_requests an 'offer.reply' he logged in the War Room (076), minus retracted ones
 * Rows: { team, reply, decline_reason, at, via }. A logged reply whose move is
 * no longer on the plan has team null; one that repeats a resolved outcome
 * (same team, same reply) is dropped so a reply is counted once.
 */
export function readReplies(db, { leagueId, me, since, until, partnerOf = () => null, exclude = new Set() }) {
  const rows = [];
  const keys = [];
  const read = [];
  if (tableExists(db, 'trade_outcomes')) {
    read.push('trade_outcomes');
    // An offer Nick sent from the app has two rows once both settle: the app row (matched_tx_id
    // = the ESPN proposal) and the collector's observed copy (espn_tx_id = the same proposal).
    // Count the reply once: skip the observed copy (#409 review finding 3). 'withdrawn' (his
    // own take-back) is not in the list: it is not a reply.
    const hasMatched = db.prepare(`SELECT name FROM pragma_table_info('trade_outcomes')`).all().some(c => c.name === 'matched_tx_id');
    const notAppCopy = hasMatched
      ? `AND NOT (source = 'observed' AND espn_tx_id IN (SELECT matched_tx_id FROM trade_outcomes
           WHERE league_id = ? AND season = o.season AND matched_tx_id IS NOT NULL))`
      : '';
    for (const r of db.prepare(`SELECT id, counterparty_team_id AS team, status, resolved_at AS at
      FROM trade_outcomes o WHERE league_id = ? AND proposer_team_id = ?
        AND status IN ('accepted', 'declined', 'countered', 'expired') AND ${inWindow('resolved_at')}
        ${notAppCopy}
      ORDER BY julianday(resolved_at), id`).all(leagueId, String(me), since, until, ...(hasMatched ? [leagueId] : []))) {
      if (exclude.has(`o:${r.id}`)) continue;
      keys.push(`o:${r.id}`);
      rows.push({ team: r.team == null ? null : String(r.team), reply: OUTCOME_REPLY[r.status], decline_reason: null, at: r.at, via: 'trade_outcomes' });
    }
  }
  if (tableExists(db, 'warroom_requests')) {
    read.push('warroom_requests');
    const retracted = new Set(db.prepare(`SELECT payload FROM warroom_requests WHERE league_id = ? AND kind = 'retract'`)
      .all(leagueId).map(r => JSON.parse(r.payload).request_id));
    for (const r of db.prepare(`SELECT id, payload, created_at AS at FROM warroom_requests
      WHERE league_id = ? AND kind = 'offer.reply' AND ${inWindow('created_at')} ORDER BY id`).all(leagueId, since, until)) {
      if (retracted.has(r.id) || exclude.has(`w:${r.id}`)) continue;
      const p = JSON.parse(r.payload);
      const team = partnerOf(p.move_id);
      // A logged reply repeats a resolved outcome when the team matches, or when the
      // move has left the plan (team unknown) and an outcome with the same reply exists.
      if (rows.some(x => x.via === 'trade_outcomes' && x.reply === p.reply && (!team || x.team === team))) continue;
      keys.push(`w:${r.id}`);
      rows.push({ team, reply: p.reply, decline_reason: p.decline_reason ?? null, at: r.at, via: 'warroom_requests' });
    }
  }
  if (!read.length) return unknown('Neither trade_outcomes nor warroom_requests exists in this DB, so replies were not read.');
  return { status: 'ok', rows, keys, as_of: until };
}

const HEALTHY = ['ACTIVE', 'NORMAL', ''];

/**
 * Injury designations that changed in the window on the latest ESPN roster
 * snapshot (058), for players on Nick's team or in `watch` (the next move's
 * players). Rows: { player_id, name, status, mine, at }.
 * `changed_at` moves when any column of the row changes, so a row here means
 * "listed with this status, row updated overnight", not "newly injured".
 */
export function readInjuries(db, { leagueId, me, since, until, watch = [], exclude = new Set() }) {
  if (!tableExists(db, 'league_roster_snapshots')) {
    return unknown('No ESPN roster snapshots in this DB (league_roster_snapshots), so injuries were not read.');
  }
  const latest = db.prepare(`SELECT season, MAX(scoring_period_id) AS period FROM league_roster_snapshots
    WHERE league_id = ? AND season = (SELECT MAX(season) FROM league_roster_snapshots WHERE league_id = ?)`)
    .get(leagueId, leagueId);
  if (latest?.period == null) return unknown('No ESPN roster snapshot for this league yet.');
  const watched = new Set(watch.map(String));
  const rows = db.prepare(`SELECT player_id, player_name AS name, team_id, injury_status AS status, changed_at AS at
    FROM league_roster_snapshots
    WHERE league_id = ? AND season = ? AND scoring_period_id = ? AND on_roster = 1
      AND injury_status IS NOT NULL AND ${inWindow('changed_at')}
    ORDER BY player_name`).all(leagueId, latest.season, latest.period, since, until)
    .filter(r => !HEALTHY.includes(String(r.status).toUpperCase()))
    .map(r => ({ player_id: r.player_id == null ? null : String(r.player_id), name: r.name, status: r.status,
      mine: String(r.team_id) === String(me), at: r.at }))
    .filter(r => r.mine || (r.player_id && watched.has(r.player_id)))
    .map(r => ({ ...r, key: `i:${r.player_id ?? r.name}:${r.status}:${r.at}` }))
    .filter(r => !exclude.has(r.key));
  return { status: 'ok', rows: rows.map(({ key, ...r }) => r), keys: rows.map(r => r.key), as_of: until, period: latest.period };
}
