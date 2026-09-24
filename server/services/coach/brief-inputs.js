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
 * Statements and credibility are read ONLY through their producers: chat labels
 * from PULSE-01's people_pulse (#316) and per-manager follow-through from
 * CRED-01's people_credibility (#321). Neither producer is on main yet, so both
 * readers query nothing and return typed unknown with that reason. The brief
 * never opens the chat DB and keeps no labeller or credibility bar of its own
 * (one producer per number).
 */

const unknown = reason => ({ status: 'unknown', reason, rows: [] });
const inWindow = col => `julianday(${col}) > julianday(?) AND julianday(${col}) <= julianday(?)`;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export const PULSE_NOT_BUILT =
  'chat labels not built yet: their producer, PULSE-01 (people_pulse), is not on this build';
export const CRED_NOT_BUILT =
  'per-manager credibility not built yet: its producer, CRED-01 (people_credibility), is not on this build';

/**
 * Labelled statements a league-mate made in the window. The one producer is
 * PULSE-01 (people_pulse); until it is on main this reads nothing and says so,
 * so the brief says "not read" rather than "nobody said anything".
 */
export function readStatements() {
  return unknown(PULSE_NOT_BUILT);
}

/**
 * Whether a manager's statements of a kind turn into action. The one producer
 * is CRED-01 (people_credibility); until it is on main this reads nothing.
 */
export function readCredibility() {
  return unknown(CRED_NOT_BUILT);
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
    for (const r of db.prepare(`SELECT id, counterparty_team_id AS team, status, resolved_at AS at
      FROM trade_outcomes WHERE league_id = ? AND proposer_team_id = ?
        AND status IN ('accepted', 'declined', 'countered', 'expired') AND ${inWindow('resolved_at')}
      ORDER BY julianday(resolved_at), id`).all(leagueId, String(me), since, until)) {
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
