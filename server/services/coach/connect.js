/**
 * COACH-LINK (2): the `connect` tool. One entity — a player or a team in the
 * league — and everything every source says about it, on one timeline, as of a
 * moment.
 *
 *   news          nfl_news_events (claim type, certainty, verification state)
 *                 and nfl_news_signals (signal type, status)
 *   chat          labelled chat signals (jev_chat_signals) about the player, or
 *                 by the team's speaker; the label only, never the message
 *   pulse         pulse_statements (PULSE-01), when the table exists
 *   trades        trade_outcomes: who offered what, and what came of it
 *   screenshots   screenshot_proposals (SHOT-01), when the table exists
 *
 * LABELS ONLY. No column that holds words someone wrote is selected: not the
 * message text, not claim_text, not evidence_span, not a quote. A chat event
 * says "this speaker's message was labelled X on this day" and nothing else.
 *
 * AS-OF. Every event carries its time, and anything after `as_of` is left out
 * and counted (`events_after_as_of_n`), so "what did we know on Tuesday" is
 * answered with what was known on Tuesday. An event with no time is left out
 * too and counted as `undated_n`; a timeline that cannot place a row must not
 * guess where it goes.
 *
 * ATTRIBUTION. A chat event is attributed to a roster only through a trusted
 * link (confirmed or exact). Below that, the event is kept with `roster_id`
 * null and its link's confidence, so a `likely` match can never put one
 * manager's words in another's mouth.
 */
import { db, rows } from '../../db/index.js';
import { openChatDb } from '../manager-signals.js';
import { resolvePlayerId, normalise } from '../player-ids.js';
import { buildEntityMap, resolveEntity, tableIn, columnsOf, sideIds, tradePlayer, SHOT_TEAM_COLS, SHOT_SIDE_COLS } from './entity-map.js';

/** Bad arguments. tools.js turns this into a CoachToolError the model sees. */
export class LinkToolInputError extends Error {
  constructor(message) { super(message); this.name = 'LinkToolInputError'; }
}

/** Newest events kept per call; ask.js cuts a result at 20,000 characters. */
export const MAX_EVENTS = 60;
/** A chat label counts when the classifier put it at or above this. */
const LABEL_P = 0.5;

export function leagueArg(input) {
  const n = Number(input?.league_id);
  if (!Number.isInteger(n) || n < 1) throw new LinkToolInputError(`league_id must be a whole number, got ${JSON.stringify(input?.league_id)}.`);
  return n;
}

/** SQLite's "YYYY-MM-DD HH:MM:SS" is UTC; Date.parse would read it as local time. */
export function toMs(at) {
  if (at == null || at === '') return null;
  const s = String(at);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isFinite(ms) ? ms : null;
}

export function asOfArg(input) {
  if (input?.as_of == null || input.as_of === '') return Date.now();
  const ms = toMs(input.as_of);
  if (ms == null) throw new LinkToolInputError(`as_of must be a date or ISO time, got ${JSON.stringify(input.as_of)}.`);
  return ms;
}

const iso = ms => new Date(ms).toISOString();
const unknownRow = (reason, extra = {}) => [{ status: 'unknown', reason, ...extra }];
const parse = text => {
  if (text == null || text === '') return null;
  try { return JSON.parse(text); } catch (e) { throw new Error(`a stored JSON column is not valid JSON (${e.message})`); }
};
const placeholders = list => list.map(() => '?').join(', ');

/* ---------------------------------------------------------------- player events */

/** Every id and the name this player goes by, for matching rows in each source. */
function playerKeys(entity) {
  const ids = new Set(entity.links.filter(l => l.source_id != null && ['internal', 'espn_player', 'sleeper_player', 'gsis'].includes(l.id_space))
    .map(l => String(l.source_id)));
  return { ids: [...ids], name: entity.label, pid: entity.player_id };
}

const isPlayer = (pid, value, name) => {
  const p = (value != null ? resolvePlayerId(value) : null) ?? (name ? resolvePlayerId(name, 'name') : null);
  if (!p || p.id !== pid) return null;
  return value != null && resolvePlayerId(value) ? 'exact' : 'name';
};

function newsForPlayer(keys) {
  const out = [];
  if (tableIn(db, 'nfl_news_events')) {
    const found = rows(`SELECT first_seen_time AS at, claim_type, certainty_label, novelty_label, verification_state,
                               source_name, player_id, player_name
                        FROM nfl_news_events WHERE player_id IN (${placeholders(keys.ids)}) OR player_name = ?`,
    ...keys.ids, keys.name ?? '');
    for (const r of found) {
      const conf = isPlayer(keys.pid, r.player_id, r.player_name);
      if (!conf) continue;
      out.push({ at: r.at, source: 'news', kind: r.claim_type, label: [r.certainty_label, r.novelty_label].filter(Boolean).join(' ') || null,
        status: r.verification_state, from: r.source_name ?? null, link_confidence: conf });
    }
  }
  if (tableIn(db, 'nfl_news_signals')) {
    const found = rows(`SELECT published_at AS at, signal_type, status, verification_state, source, player_id, player_name
                        FROM nfl_news_signals WHERE player_id IN (${placeholders(keys.ids)}) OR player_name = ?`,
    ...keys.ids, keys.name ?? '');
    for (const r of found) {
      const conf = isPlayer(keys.pid, r.player_id, r.player_name);
      if (!conf) continue;
      out.push({ at: r.at, source: 'news_signal', kind: r.signal_type, label: r.status ?? null,
        status: r.verification_state, from: r.source ?? null, link_confidence: conf });
    }
  }
  return out;
}

/** Chat label rows, time from the message, the message itself never read. */
function chatLabels(chat, where, params) {
  const hasMessages = tableIn(chat, 'messages');
  const cols = columnsOf(chat, 'jev_chat_signals');
  const idCol = cols.includes('mentioned_player_id') ? 's.mentioned_player_id' : 'NULL';
  return chat.prepare(`SELECT ${hasMessages ? 'COALESCE(m.ts_utc, s.evaluated_at)' : 's.evaluated_at'} AS at,
                              s.name AS speaker, s.question, s.mentioned_player, ${idCol} AS mentioned_player_id
                       FROM jev_chat_signals s ${hasMessages ? 'LEFT JOIN messages m ON m.msg_id = s.msg_id' : ''}
                       WHERE s.probability >= ? AND ${where}`).all(LABEL_P, ...params);
}

function chatForPlayer(keys, byChatName) {
  const chat = openChatDb();
  if (!chat) return { events: [], unknown: 'chat' };
  try {
    if (!tableIn(chat, 'jev_chat_signals')) return { events: [], unknown: 'chat' };
    const names = chat.prepare(`SELECT DISTINCT mentioned_player AS n FROM jev_chat_signals WHERE mentioned_player IS NOT NULL`)
      .all().map(r => r.n).filter(n => isPlayer(keys.pid, null, n));
    if (!names.length) return { events: [] };
    const events = chatLabels(chat, `s.mentioned_player IN (${placeholders(names)})`, names).map(r => {
      const who = byChatName.get(r.speaker);
      return { at: r.at, source: 'chat', kind: 'chat_label', label: r.question,
        roster_id: who?.trusted ? who.roster_id : null,
        speaker_link: who ? who.confidence : 'unlinked',
        link_confidence: isPlayer(keys.pid, r.mentioned_player_id, r.mentioned_player) ?? 'name' };
    });
    return { events };
  } finally { chat.close(); }
}

function pulseRows(where, params) {
  if (!tableIn(db, 'pulse_statements')) return { events: [], unknown: 'pulse' };
  const cols = columnsOf(db, 'pulse_statements');
  const stamp = ['at', 'created_at'].find(c => cols.includes(c));
  const keep = ['roster_id', 'player', 'player_id', 'label', 'kind', 'credible'].filter(c => cols.includes(c));
  const w = where(cols);
  if (!stamp || !w) return { events: [], unknown: 'pulse' };
  const found = db.prepare(`SELECT ${stamp} AS at, ${keep.join(', ')} FROM pulse_statements WHERE ${w.sql}`).all(...w.params);
  return { events: found.filter(w.keep ?? (() => true)).map(r => ({ at: r.at, source: 'pulse', kind: r.kind ?? 'statement', label: r.label ?? null,
    status: r.credible == null ? null : (r.credible ? 'credible' : 'not credible'), roster_id: r.roster_id ?? null,
    link_confidence: w.confidence(r) })) };
}

function tradeEvents(leagueId, match) {
  if (!tableIn(db, 'trade_outcomes')) return { events: [], unknown: 'trade_outcomes' };
  const out = [];
  for (const t of rows(`SELECT id, source, status, proposer_team_id, counterparty_team_id, give_json, get_json,
                               proposed_at, resolved_at FROM trade_outcomes WHERE league_id = ?`, leagueId)) {
    const side = match(t);
    if (!side) continue;
    const base = { source: 'trade_outcomes', label: `${t.source}${side === true ? '' : `, ${side}`}`,
      roster_id: t.proposer_team_id ?? null, partner_roster_id: t.counterparty_team_id ?? null, trade_id: t.id, link_confidence: 'exact' };
    out.push({ ...base, at: t.proposed_at, kind: 'trade_proposed', status: 'proposed' });
    if (t.resolved_at && t.status !== 'proposed') out.push({ ...base, at: t.resolved_at, kind: 'trade_resolved', status: t.status });
  }
  return { events: out };
}

function screenshotEvents(leagueId, match) {
  if (!tableIn(db, 'screenshot_proposals')) return { events: [], unknown: 'screenshots' };
  const cols = columnsOf(db, 'screenshot_proposals');
  const stamp = ['captured_at', 'proposed_at', 'created_at', 'at'].find(c => cols.includes(c));
  const teamCol = SHOT_TEAM_COLS.find(c => cols.includes(c)) ?? null;
  const sides = SHOT_SIDE_COLS.filter(c => cols.includes(c));
  const keep = [stamp, teamCol, ...sides, cols.includes('status') ? 'status' : null].filter(Boolean);
  if (!stamp) return { events: [], unknown: 'screenshots' };
  const where = cols.includes('league_id') ? 'WHERE league_id = ?' : '';
  const found = db.prepare(`SELECT ${keep.join(', ')} FROM screenshot_proposals ${where}`).all(...(where ? [leagueId] : []));
  const out = [];
  for (const s of found) {
    const side = match(s, teamCol, sides);
    if (!side) continue;
    out.push({ at: s[stamp], source: 'screenshot', kind: 'screenshot_trade', label: side === true ? null : side,
      status: s.status ?? null, roster_id: teamCol ? (s[teamCol] ?? null) : null, link_confidence: 'exact' });
  }
  return { events: out };
}

function playerEvents(leagueId, entity, map) {
  const keys = playerKeys(entity);
  const isHim = id => tradePlayer(id)?.id === keys.pid;
  const inSide = json => sideIds(parse(json)).some(isHim);
  const pulseHit = r => r.player_id != null && resolvePlayerId(r.player_id)?.id === keys.pid;
  const parts = [
    { events: newsForPlayer(keys) },
    chatForPlayer(keys, map.byChatName),
    pulseRows(cols => {
      const conds = []; const params = [];
      if (cols.includes('player_id') && keys.ids.length) { conds.push(`player_id IN (${placeholders(keys.ids)})`); params.push(...keys.ids); }
      if (cols.includes('player')) { conds.push('player IS NOT NULL'); }
      if (!conds.length) return null;
      const league = cols.includes('league_id') ? ' AND league_id = ?' : '';
      return { sql: `(${conds.join(' OR ')})${league}`, params: [...params, ...(league ? [leagueId] : [])],
        keep: r => pulseHit(r) || isPlayer(keys.pid, null, r.player),
        confidence: r => (pulseHit(r) ? 'exact' : 'name') };
    }),
    tradeEvents(leagueId, t => (inSide(t.give_json) ? 'player on the give side' : inSide(t.get_json) ? 'player on the get side' : null)),
    screenshotEvents(leagueId, (s, _teamCol, sides) => {
      for (const c of sides) {
        for (const item of parse(s[c]) ?? []) {
          const id = typeof item === 'object' ? (item?.player_id ?? item?.playerId ?? item?.id) : item;
          const name = typeof item === 'object' ? (item?.name ?? item?.player) : null;
          if (isHim(id) || (name && isPlayer(keys.pid, null, name))) {
            return `player on the ${c.replace('_json', '')} side`;
          }
        }
      }
      return null;
    })
  ];
  return parts;
}

/* ---------------------------------------------------------------- team events */

function teamEvents(leagueId, entity, map) {
  const rosterId = entity.roster_id;
  const speakers = [...map.byChatName.entries()].filter(([, w]) => w.roster_id === rosterId);
  const chatPart = (() => {
    const chat = openChatDb();
    if (!chat) return { events: [], unknown: 'chat' };
    try {
      if (!tableIn(chat, 'jev_chat_signals')) return { events: [], unknown: 'chat' };
      const trusted = speakers.filter(([, w]) => w.trusted).map(([name]) => name);
      if (!trusted.length) {
        return { events: [], note: speakers.length ? `chat speaker link is ${speakers[0][1].confidence}, below trusted: not attributed` : 'no chat speaker linked' };
      }
      return { events: chatLabels(chat, `s.name IN (${placeholders(trusted)})`, trusted).map(r => ({
        at: r.at, source: 'chat', kind: 'chat_label', label: r.question, roster_id: rosterId,
        player_name: r.mentioned_player ? (resolvePlayerId(r.mentioned_player_id ?? r.mentioned_player, r.mentioned_player_id ? null : 'name')?.name ?? null) : null,
        link_confidence: map.byChatName.get(r.speaker)?.confidence ?? null })) };
    } finally { chat.close(); }
  })();
  return [
    chatPart,
    pulseRows(cols => (cols.includes('roster_id') ? {
      sql: `roster_id = ?${cols.includes('league_id') ? ' AND league_id = ?' : ''}`,
      params: [rosterId, ...(cols.includes('league_id') ? [leagueId] : [])], confidence: () => 'exact' } : null)),
    tradeEvents(leagueId, t => (String(t.proposer_team_id) === rosterId ? 'this team proposed'
      : String(t.counterparty_team_id) === rosterId ? 'this team received' : null)),
    screenshotEvents(leagueId, (s, teamCol) => (teamCol && String(s[teamCol]) === rosterId ? true : null))
  ];
}

/* ---------------------------------------------------------------- the tool */

/** Flatten an event to citable scalar columns, fixed order. */
const EVENT_COLS = ['at', 'source', 'kind', 'label', 'status', 'from', 'roster_id', 'partner_roster_id', 'trade_id',
  'player_name', 'speaker_link', 'link_confidence'];

/**
 * connect: one entity's cross-source timeline as of a moment.
 * @returns {object[]} [entity row, ...link rows, ...event rows oldest first] or one typed unknown row.
 */
export function connect(input) {
  const leagueId = leagueArg(input);
  const asOf = asOfArg(input);
  const query = String(input?.entity ?? '').trim();
  if (!query) throw new LinkToolInputError('entity is required: a player name or id, a roster id, a team name, or a key like team:7.');
  const map = buildEntityMap(leagueId);
  if (map.status !== 'ok') return unknownRow(map.reason, { league_id: leagueId });
  const found = resolveEntity(map, query);
  if (found.status !== 'ok') return unknownRow(found.reason, { league_id: leagueId, candidates_n: found.candidates_n });
  const { entity } = found;

  const parts = entity.kind === 'player' ? playerEvents(leagueId, entity, map) : teamEvents(leagueId, entity, map);
  const all = parts.flatMap(p => p.events);
  const unknownSources = [...new Set(parts.map(p => p.unknown).filter(Boolean))];
  const notes = parts.map(p => p.note).filter(Boolean);
  const dated = all.map(e => ({ ...e, ms: toMs(e.at) }));
  const undated = dated.filter(e => e.ms == null).length;
  const known = dated.filter(e => e.ms != null && e.ms <= asOf).sort((a, b) => a.ms - b.ms || a.source.localeCompare(b.source));
  const after = dated.filter(e => e.ms != null && e.ms > asOf).length;
  const shown = known.slice(-MAX_EVENTS);

  const head = {
    row_kind: 'entity', status: 'ok', league_id: leagueId, as_of: iso(asOf), entity_key: entity.key, entity_kind: entity.kind,
    ...(entity.kind === 'player' ? { player_name: entity.label ?? null } : { team_name: entity.label ?? null }),
    roster_id: entity.roster_id ?? null, links_n: entity.links.length, trusted_links_n: entity.links.filter(l => l.trusted).length,
    events_n: known.length, events_shown_n: shown.length, events_after_as_of_n: after, undated_n: undated,
    sources_unknown: unknownSources.join(', ') || null, note: notes.join('; ') || null
  };
  const links = entity.links.map(l => ({ row_kind: 'link', source: l.source, id_space: l.id_space, source_id: l.source_id,
    confidence: l.confidence, trusted: l.trusted, method: l.method, n: l.n }));
  const events = shown.map(e => ({ row_kind: 'event', ...Object.fromEntries(EVENT_COLS.map(c => [c, e[c] ?? null])) }));
  return [head, ...links, ...events];
}

export const CONNECT_TOOL = Object.freeze({
  name: 'connect', kind: 'service', source: 'server/services/coach/connect.js#connect',
  tables: ['nfl_news_events', 'nfl_news_signals', 'trade_outcomes', 'league_member_identity', 'pulse_statements', 'screenshot_proposals'],
  description: 'Everything every source says about one player or one team in the league, on one timeline, as of a moment: ' +
    'news claims and signals, labelled chat mentions, pulse statements, trade offers and their outcomes, screenshot trades. ' +
    'Row 0 is the entity (entity_key, player_name or team_name, counts, which sources are unknown). Then one link row per ' +
    'id this entity has in each source, with its confidence (confirmed, exact, likely, uncertain, name) and trusted. Then ' +
    'events oldest first. Labels only: no message or article text. A chat event is tied to a roster only through a trusted ' +
    'link. events_after_as_of_n says how much happened after as_of and was left out.',
  input_schema: { type: 'object', required: ['league_id', 'entity'], properties: {
    league_id: { type: 'integer', description: "the user's league id" },
    entity: { type: 'string', description: 'a player name ("K. Bell" works) or id, a roster id, a team name, or a key: player:123, team:7' },
    as_of: { type: 'string', description: 'ISO date or time; omit for now' } } },
  run(input) { return { value: connect(input), tables: this.tables }; }
});
