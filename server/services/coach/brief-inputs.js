/**
 * COACH-BRIEF inputs: what changed overnight, read as rows the brief can cite.
 *
 * Every reader takes its database as an argument (the app DB, or the private
 * chat DB) and returns one section:
 *   { status: 'ok', rows, as_of } | { status: 'unknown', reason, rows: [] }
 * `keys` name the raw rows an 'ok' section used; a reader skips any key in
 * `exclude` (rows an earlier brief already reported, see brief.js windowStart).
 * An absent table or DB is 'unknown' with the reason, never an empty 'ok', so
 * the brief says "not read" instead of "nothing happened". Any other SQL error
 * throws: a broken read must not pass for a quiet night.
 *
 * Privacy (PEOPLE-FLOW guardrails): the chat reader selects labels, counts and
 * timestamps only. It never selects message text, and a chat name never leaves
 * this file: rows carry the roster id ("Team 7"), nothing else.
 */

/**
 * Statement labels and how much weight each carries (PEOPLE-FLOW.md section 3).
 *   proven       follow-through measured league-wide (WANT_PLAYER: 17x base)
 *   per_manager  credible for some managers and noise for others (SHOP): it
 *                counts only when that manager's own credibility says so
 *   noise        measured, no predictive power: shown as a count, never as news
 */
export const LABEL_WEIGHT = Object.freeze({
  WANT_PLAYER: 'proven', SHOP: 'per_manager', UNTOUCHABLE: 'noise', FRUSTRATED: 'noise'
});
/** A SHOP statement counts as credible when his shop credibility is at least this. */
export const SHOP_CREDIBLE_AT = 0.5;

/**
 * The chat classifier's questions (scripts/news-line/jev_league_chat.mts) that
 * map onto a statement label. The classifier has no WANT_PLAYER question, so
 * that label arrives only from the PULSE-01 labeller when it lands.
 */
const JEV_LABELS = Object.freeze({
  open_to_trade: { label: 'SHOP', min_p: 0.5 },
  'own_roster.argmax:untouchable': { label: 'UNTOUCHABLE', min_p: 0.5 },
  'own_roster.argmax:complaining': { label: 'FRUSTRATED', min_p: 0.5 }
});

const unknown = reason => ({ status: 'unknown', reason, rows: [] });
const inWindow = col => `julianday(${col}) > julianday(?) AND julianday(${col}) <= julianday(?)`;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * Trusted roster -> chat name joins for one league, read from the app DB
 * (manager-identity.js owns the table). Returns Map(chat name -> roster id).
 */
export function trustedChatNames(db, leagueId, trusted = ['confirmed', 'exact']) {
  if (!tableExists(db, 'league_member_identity')) return new Map();
  const rows = db.prepare(`SELECT roster_id, chat_name FROM league_member_identity
    WHERE league_id = ? AND chat_name IS NOT NULL AND confidence IN (${trusted.map(() => '?').join(', ')})`)
    .all(leagueId, ...trusted);
  return new Map(rows.map(r => [r.chat_name, String(r.roster_id)]));
}

/**
 * Labelled statements in the window, one row per (team, label):
 *   { team, label, weight, n, credible, last_at }
 * `credibility` is optional: Map(team -> { shop: number }) from the counterpart
 * model. Without it a SHOP statement is reported as "not proven for him yet".
 */
export function readStatements(chat, { names, since, until, credibility = new Map(), exclude = new Set() }) {
  if (!chat) return unknown('No chat DB on this machine (GRIDIRON_CHAT_DB_PATH), so no statements were read.');
  if (!names?.size) return unknown('No confirmed chat identities for this league, so no statement can be tied to a team.');
  if (!tableExists(chat, 'jev_chat_signals') || !tableExists(chat, 'messages')) {
    return unknown('The chat DB has no labelled statements yet (jev_chat_signals is missing).');
  }
  const questions = Object.keys(JEV_LABELS);
  const raw = chat.prepare(`SELECT s.msg_id AS msg_id, s.name AS speaker, s.question AS question, s.probability AS p, m.ts_utc AS at
    FROM jev_chat_signals s JOIN messages m ON m.msg_id = s.msg_id
    WHERE s.question IN (${questions.map(() => '?').join(', ')}) AND ${inWindow('m.ts_utc')}`)
    .all(...questions, since, until);
  const byKey = new Map();
  const keys = [];
  for (const r of raw) {
    const team = names.get(r.speaker);
    const map = JEV_LABELS[r.question];
    if (!team || !map || !(Number(r.p) >= map.min_p)) continue;
    const k = `s:${r.msg_id}:${r.question}`;
    if (exclude.has(k)) continue;
    keys.push(k);
    const key = `${team}|${map.label}`;
    const cur = byKey.get(key) ?? { team, label: map.label, weight: LABEL_WEIGHT[map.label], n: 0, last_at: null };
    cur.n += 1;
    if (!cur.last_at || r.at > cur.last_at) cur.last_at = r.at;
    byKey.set(key, cur);
  }
  const rows = [...byKey.values()].map(r => {
    const shop = credibility.get(r.team)?.shop;
    const credible = r.weight === 'proven' || (r.weight === 'per_manager' && Number(shop) >= SHOP_CREDIBLE_AT);
    return { ...r, credible, shop_credibility: typeof shop === 'number' ? shop : null };
  }).sort((a, b) => Number(b.credible) - Number(a.credible) || b.n - a.n || a.team.localeCompare(b.team));
  return { status: 'ok', rows, keys, as_of: until };
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
