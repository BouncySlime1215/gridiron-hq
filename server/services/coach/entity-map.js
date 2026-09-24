/**
 * COACH-LINK (1): one map of who and what is the same thing across every source
 * Coach reads for a league — ESPN, Sleeper, the league chat, the news, the
 * trade_outcomes ledger and screenshot trades — with a confidence on each link.
 *
 * Two kinds of entity.
 *
 *   player:<internal id>   a players row. ESPN, Sleeper and GSIS ids join through
 *                          player-ids.js, the one bridge (never a raw id join).
 *   team:<roster id>       one fantasy team in this league, and the person who
 *                          runs it: ESPN team + member, chat speaker, Sleeper user.
 *
 * Every link says HOW it was made and how far to trust it. The labels are the
 * ones league_member_identity already uses, plus one:
 *
 *   confirmed   Nick said so (identity table)
 *   exact       a shared id: ESPN id on the roster, players.sleeper_id, a roster
 *               id written by the same league's ESPN sync
 *   likely      surname + first-name prefix (identity table)
 *   uncertain   surname prefix only, or one person's name matched across two
 *               platforms
 *   name        a player name that normalises to exactly one players row
 *
 * `trusted` is confirmed or exact, the same line manager-identity.js draws
 * (TRUSTED_CONFIDENCE). Anything below it is shown with its label, never used
 * to attribute a chat speaker's words to a roster.
 *
 * PRIVATE THINGS STAY OUT. A chat handle is a phone number or an email address,
 * so a chat link carries `source_id: null` and says the handle exists. Person
 * names are used to resolve a query and never returned: a team is labelled by
 * its ESPN team name, a person by roster id.
 *
 * TYPED ABSENCE. Each source reports { status, reason } in `sources`: a chat DB
 * that is not on this machine, a table this build does not have (screenshot
 * trades are SHOT-01's), a league that has not synced. Absent is never zero.
 */
import { db, rows } from '../../db/index.js';
import { previewUnconfirmed } from '../preview-mode.js';
import { openChatDb } from '../manager-signals.js';
import { identityRows, TRUSTED_CONFIDENCE } from '../manager-identity.js';
import { resolvePlayerId, normalise } from '../player-ids.js';

export const LINK_ENV = 'GRIDIRON_COACH_LINK';

/** On with its own flag or preview mode; its own flag set to '0' vetoes preview. */
export function linkOn() {
  const own = process.env[LINK_ENV];
  if (own === '1') return true;
  if (own === '0') return false;
  return previewUnconfirmed();
}

/** Strongest first. A link below TRUSTED is shown, never used to attribute. */
export const CONFIDENCE = Object.freeze(['confirmed', 'exact', 'likely', 'uncertain', 'name']);
export const TRUSTED = TRUSTED_CONFIDENCE;
const isTrusted = c => TRUSTED.includes(c);

export function tableIn(database, name) {
  return !!database?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
export const columnsOf = (database, table) =>
  database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map(c => c.name);

const personNorm = s => String(s ?? '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

function parseJson(text, what) {
  if (text == null || text === '') return null;
  try { return JSON.parse(text); } catch (e) {
    throw new Error(`${what} is not valid JSON (${e.message})`);
  }
}

/** The ids a trade side lists, whatever shape the writer used (ESPN items, bare ids, {id}). */
export function sideIds(list) {
  if (!Array.isArray(list)) return [];
  return list.map(item => (item && typeof item === 'object'
    ? (item.playerId ?? item.player_id ?? item.id ?? null) : item))
    .filter(v => v != null && v !== '').map(String);
}

/**
 * The players row behind an id on a trade (ESPN items, the app's proposals, a
 * screenshot): a GSIS-shaped id as GSIS, anything else as ESPN first, since
 * that is what an ESPN league writes, and only then unhinted. Unhinted first
 * would read a small ESPN id as some other player's internal id.
 */
export function tradePlayer(id) {
  if (id == null || id === '') return null;
  const s = String(id);
  if (/^\d{2}-\d{7}$/.test(s)) return resolvePlayerId(s, 'gsis');
  return resolvePlayerId(s, 'espn') ?? resolvePlayerId(s);
}

/* ---------------------------------------------------------------- builder */

function newBook() {
  const byKey = new Map();
  const entity = (key, kind, label) => {
    if (!byKey.has(key)) byKey.set(key, { key, kind, label, links: [], resolve: new Set() });
    const e = byKey.get(key);
    if (!e.label && label) e.label = label;
    return e;
  };
  /** One link per (source, id_space, source_id); the stronger confidence wins, counts add. */
  const link = (e, l) => {
    const same = e.links.find(x => x.source === l.source && x.id_space === l.id_space && x.source_id === l.source_id);
    const full = { n: 1, ...l, trusted: isTrusted(l.confidence) };
    if (!same) { e.links.push(full); return; }
    same.n += full.n;
    if (CONFIDENCE.indexOf(full.confidence) < CONFIDENCE.indexOf(same.confidence)) {
      Object.assign(same, { confidence: full.confidence, method: full.method, trusted: full.trusted });
    }
  };
  /** How many players rows share each normalised name; > 1 is why a name resolves to nothing. */
  let counts = null;
  const nameCounts = () => {
    if (counts) return counts;
    counts = new Map();
    for (const r of rows('SELECT name FROM players')) {
      const n = normalise(r.name);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return counts;
  };
  return { byKey, entity, link, nameCounts };
}

/** A players row as an entity, with its id-bridge links. */
function playerEntity(book, p) {
  const e = book.entity(`player:${p.id}`, 'player', p.name);
  e.player_id = p.id;
  e.resolve.add(normalise(p.name));
  book.link(e, { source: 'players', id_space: 'internal', source_id: String(p.id), confidence: 'exact', method: 'players row' });
  if (p.espn_id != null) book.link(e, { source: 'espn', id_space: 'espn_player', source_id: String(p.espn_id), confidence: 'exact', method: 'players.espn_id' });
  if (p.sleeper_id != null) book.link(e, { source: 'sleeper', id_space: 'sleeper_player', source_id: String(p.sleeper_id), confidence: 'exact', method: 'players.sleeper_id' });
  if (p.gsis_id) book.link(e, { source: 'nflverse', id_space: 'gsis', source_id: String(p.gsis_id), confidence: 'exact', method: 'players.gsis_id' });
  return e;
}

/**
 * Resolve one player reference to an entity. `kind` is the id space when known.
 * Returns { entity, confidence } or { entity: null, why: 'ambiguous'|'unresolved' }.
 */
function playerRef(book, value, { kind = null, name = null } = {}) {
  if (value != null && value !== '') {
    const p = resolvePlayerId(value, kind);
    if (p) return { entity: playerEntity(book, p), confidence: 'exact', method: `${kind ?? 'id'} via player-ids.js` };
  }
  if (name) {
    const p = resolvePlayerId(name, 'name');
    if (p) return { entity: playerEntity(book, p), confidence: 'name', method: 'name normalises to one players row' };
    return { entity: null, why: (book.nameCounts().get(normalise(name)) ?? 0) > 1 ? 'ambiguous' : 'unresolved' };
  }
  return { entity: null, why: 'unresolved' };
}


const source = (status, extra = {}) => ({ status, ...extra });

/* ---------------------------------------------------------------- sources */

function espnSource(book, league, payload) {
  const teams = payload?.teams ?? [];
  const members = new Map((payload?.members ?? []).map(m => [m.id, m]));
  let players = 0;
  let unresolved = 0;
  for (const t of teams) {
    const rosterId = String(t.id);
    const e = book.entity(`team:${rosterId}`, 'team', t.name ?? null);
    e.roster_id = rosterId;
    if (t.name) e.resolve.add(personNorm(t.name));
    book.link(e, { source: 'espn', id_space: 'espn_team', source_id: rosterId, confidence: 'exact', method: 'league sync payload' });
    const owner = (t.owners ?? [])[0];
    if (owner) {
      book.link(e, { source: 'espn', id_space: 'espn_member', source_id: String(owner), confidence: 'exact', method: 'teams[].owners[0]' });
      const m = members.get(owner);
      const full = personNorm(`${m?.firstName ?? ''} ${m?.lastName ?? ''}`);
      if (full) e.resolve.add(full);
    }
    for (const entry of t.roster?.entries ?? []) {
      const espnId = entry.playerId ?? entry.playerPoolEntry?.player?.id ?? null;
      const name = entry.playerPoolEntry?.player?.fullName ?? null;
      const ref = playerRef(book, espnId, { kind: 'espn', name });
      players += 1;
      if (!ref.entity) { unresolved += 1; continue; }
      ref.entity.roster_id = rosterId;
      book.link(ref.entity, { source: 'espn', id_space: 'espn_roster', source_id: rosterId,
        confidence: ref.confidence, method: ref.confidence === 'exact' ? 'ESPN id on this league roster' : 'roster name, no id bridge' });
    }
  }
  if (!teams.length) return source('unknown', { reason: `league ${league.id} has no teams in its synced payload` });
  return source('ok', { n: teams.length, players_n: players, unresolved_n: unresolved });
}

function identitySource(book, leagueId) {
  const ident = identityRows(leagueId);
  if (!ident.length) return { status: source('unknown', { reason: 'no league_member_identity rows: the identity match has not run' }), byChatName: new Map() };
  const byChatName = new Map();
  let linked = 0;
  for (const r of ident) {
    const e = book.entity(`team:${r.roster_id}`, 'team', r.team_name ?? null);
    e.roster_id = String(r.roster_id);
    if (r.espn_name) e.resolve.add(personNorm(r.espn_name));
    if (!r.chat_name || !CONFIDENCE.includes(r.confidence)) continue;
    e.resolve.add(personNorm(r.chat_name));
    book.link(e, { source: 'chat', id_space: 'chat_speaker', source_id: null, confidence: r.confidence,
      method: `league_member_identity: ${r.match_method ?? 'unknown method'}` });
    byChatName.set(r.chat_name, { roster_id: String(r.roster_id), confidence: r.confidence, trusted: isTrusted(r.confidence) });
    linked += 1;
  }
  return { status: source('ok', { n: ident.length, linked_n: linked }), byChatName };
}

function chatSource(book, byChatName) {
  const chat = openChatDb();
  if (!chat) return source('unknown', { reason: 'no league chat DB on this machine (GRIDIRON_CHAT_DB_PATH)' });
  try {
    let handles = 0;
    if (tableIn(chat, 'participants')) {
      for (const p of chat.prepare('SELECT name FROM participants WHERE name IS NOT NULL').all()) {
        const who = byChatName.get(p.name);
        if (!who) continue;
        const e = book.byKey.get(`team:${who.roster_id}`);
        book.link(e, { source: 'chat', id_space: 'chat_handle', source_id: null, confidence: who.confidence,
          method: 'participants.name = the identity row\'s chat name (handle withheld)' });
        handles += 1;
      }
    }
    if (!tableIn(chat, 'jev_chat_signals')) {
      return source('ok', { handles_n: handles, labelled_n: 0, reason: 'no jev_chat_signals table: no labelled player mentions' });
    }
    const cols = columnsOf(chat, 'jev_chat_signals');
    const idCol = cols.includes('mentioned_player_id') ? 'mentioned_player_id' : null;
    const found = chat.prepare(`SELECT mentioned_player AS name, ${idCol ?? 'NULL'} AS pid, COUNT(*) AS n
                                FROM jev_chat_signals WHERE mentioned_player IS NOT NULL AND mentioned_player <> ''
                                GROUP BY mentioned_player, pid`).all();
    let labelled = 0; let unresolved = 0; let ambiguous = 0;
    for (const f of found) {
      const ref = playerRef(book, f.pid, { name: f.name });
      if (!ref.entity) { if (ref.why === 'ambiguous') ambiguous += f.n; else unresolved += f.n; continue; }
      labelled += f.n;
      book.link(ref.entity, { source: 'chat', id_space: 'chat_label', source_id: null, n: f.n, confidence: ref.confidence,
        method: ref.confidence === 'exact' ? 'labelled player id' : 'labelled player name' });
    }
    return source('ok', { handles_n: handles, labelled_n: labelled, unresolved_n: unresolved, ambiguous_n: ambiguous });
  } finally { chat.close(); }
}

function sleeperSource(book, league) {
  const others = rows(`SELECT id, payload FROM leagues WHERE platform = 'sleeper' AND payload IS NOT NULL AND id <> ?`, league.id);
  if (!others.length) return source('unknown', { reason: 'no synced Sleeper league on this build to link managers across' });
  const teams = [...book.byKey.values()].filter(e => e.kind === 'team');
  let linked = 0;
  for (const lg of others) {
    const payload = parseJson(lg.payload, `leagues.payload for Sleeper league ${lg.id}`);
    for (const u of payload?.users ?? []) {
      const names = [u.display_name, u.metadata?.team_name].map(personNorm).filter(Boolean);
      const hits = teams.filter(t => names.some(n => t.resolve.has(n)));
      if (hits.length !== 1) continue;
      book.link(hits[0], { source: 'sleeper', id_space: 'sleeper_user', source_id: String(u.user_id),
        confidence: 'uncertain', method: `one name matched in Sleeper league ${lg.id} (names only, no shared id)` });
      linked += 1;
    }
  }
  return source('ok', { leagues_n: others.length, linked_n: linked });
}

function newsSource(book) {
  if (!tableIn(db, 'nfl_news_events')) return source('unknown', { reason: 'no nfl_news_events table on this build' });
  const players = [...book.byKey.values()].filter(e => e.kind === 'player' && e.player_id != null);
  if (!players.length) return source('ok', { linked_n: 0 });
  const byPid = new Map(players.map(e => [e.player_id, e]));
  const found = rows(`SELECT player_id, player_name, COUNT(*) AS n FROM nfl_news_events
                      WHERE player_id IS NOT NULL OR player_name IS NOT NULL GROUP BY player_id, player_name`);
  let linked = 0;
  for (const f of found) {
    const byId = f.player_id != null ? resolvePlayerId(f.player_id) : null;
    const p = byId ?? (f.player_name ? resolvePlayerId(f.player_name, 'name') : null);
    const e = p ? byPid.get(p.id) : null;
    if (!e) continue;
    book.link(e, { source: 'news', id_space: 'nfl_news_events', source_id: null, n: f.n,
      confidence: byId ? 'exact' : 'name', method: byId ? 'news player_id via player-ids.js' : 'news player_name' });
    linked += f.n;
  }
  return source('ok', { linked_n: linked });
}

function tradeSource(book, leagueId) {
  if (!tableIn(db, 'trade_outcomes')) return source('unknown', { reason: 'no trade_outcomes table on this build' });
  const found = rows(`SELECT id, proposer_team_id, counterparty_team_id, give_json, get_json FROM trade_outcomes
                      WHERE league_id = ?`, leagueId);
  let unresolved = 0;
  for (const t of found) {
    for (const rosterId of [t.proposer_team_id, t.counterparty_team_id]) {
      if (rosterId == null) continue;
      const e = book.byKey.get(`team:${rosterId}`) ?? book.entity(`team:${rosterId}`, 'team', null);
      e.roster_id = String(rosterId);
      book.link(e, { source: 'trade_outcomes', id_space: 'team_id', source_id: String(rosterId), confidence: 'exact', method: 'roster id in this league\'s ledger' });
    }
    for (const id of [...sideIds(parseJson(t.give_json, `trade_outcomes ${t.id} give_json`)),
      ...sideIds(parseJson(t.get_json, `trade_outcomes ${t.id} get_json`))]) {
      const p = tradePlayer(id);
      if (!p) { unresolved += 1; continue; }
      book.link(playerEntity(book, p), { source: 'trade_outcomes', id_space: 'trade_player', source_id: null, confidence: 'exact', method: 'player id in give/get' });
    }
  }
  return source('ok', { n: found.length, unresolved_n: unresolved });
}

/** The columns screenshot trades may carry. SHOT-01 (migration 085) owns the table; this reads what is there. */
export const SHOT_TEAM_COLS = ['partner_roster_id', 'counterparty_team_id', 'roster_id', 'team_id'];
export const SHOT_SIDE_COLS = ['give_json', 'get_json'];

function screenshotSource(book, leagueId) {
  if (!tableIn(db, 'screenshot_proposals')) {
    return source('unknown', { reason: 'no screenshot_proposals table on this build (SHOT-01, migration 085, is local)' });
  }
  const cols = columnsOf(db, 'screenshot_proposals');
  const teamCol = SHOT_TEAM_COLS.find(c => cols.includes(c));
  const sides = SHOT_SIDE_COLS.filter(c => cols.includes(c));
  const where = cols.includes('league_id') ? 'WHERE league_id = ?' : '';
  const found = db.prepare(`SELECT ${[teamCol, ...sides].filter(Boolean).join(', ') || '1 AS one'}
                            FROM screenshot_proposals ${where}`).all(...(where ? [leagueId] : []));
  let unresolved = 0;
  for (const s of found) {
    if (teamCol && s[teamCol] != null) {
      const e = book.byKey.get(`team:${s[teamCol]}`);
      if (e) book.link(e, { source: 'screenshot', id_space: 'screenshot_team', source_id: String(s[teamCol]), confidence: 'exact', method: `screenshot_proposals.${teamCol}` });
    }
    for (const c of sides) {
      for (const item of parseJson(s[c], `screenshot_proposals.${c}`) ?? []) {
        const id = typeof item === 'object' ? (item?.player_id ?? item?.playerId ?? item?.id ?? null) : item;
        const name = typeof item === 'object' ? (item?.name ?? item?.player ?? null) : (typeof item === 'string' && !/^\d+$/.test(item) ? item : null);
        const byId = tradePlayer(id);
        const ref = byId ? { entity: playerEntity(book, byId), confidence: 'exact' } : playerRef(book, null, { name });
        if (!ref.entity) { unresolved += 1; continue; }
        book.link(ref.entity, { source: 'screenshot', id_space: 'screenshot_player', source_id: null, confidence: ref.confidence,
          method: ref.confidence === 'exact' ? 'player id read off the screenshot' : 'player name read off the screenshot' });
      }
    }
  }
  return source('ok', { n: found.length, team_column: teamCol ?? null, unresolved_n: unresolved });
}

/* ---------------------------------------------------------------- public */

/**
 * Build the map for one league. Deterministic: same rows in, same map out.
 * @returns {{status:'ok'|'unknown', reason?, league_id, entities: object[], sources: object,
 *   byChatName: Map<string,{roster_id, confidence, trusted}>}}
 */
export function buildEntityMap(leagueId) {
  const league = rows('SELECT id, platform, payload FROM leagues WHERE id = ?', leagueId)[0];
  if (!league) return { status: 'unknown', reason: `no league ${leagueId}`, league_id: leagueId, entities: [], sources: {}, byChatName: new Map() };
  const book = newBook();
  const payload = parseJson(league.payload, `leagues.payload for league ${leagueId}`);
  const sources = {};
  sources.espn = league.platform === 'espn' && payload
    ? espnSource(book, league, payload)
    : source('unknown', { reason: payload ? `league ${leagueId} is ${league.platform}, not ESPN` : `league ${leagueId} has not synced` });
  const ident = identitySource(book, leagueId);
  sources.identity = ident.status;
  sources.chat = chatSource(book, ident.byChatName);
  sources.sleeper = sleeperSource(book, league);
  sources.trade_outcomes = tradeSource(book, leagueId);
  sources.screenshots = screenshotSource(book, leagueId);
  sources.news = newsSource(book);
  const entities = [...book.byKey.values()].sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
  return { status: 'ok', league_id: leagueId, entities, sources, byChatName: ident.byChatName };
}

/** "K. Bell" -> k + bell, matched against a full name's first initial and last word. */
function initialMatch(query, label) {
  const m = /^([A-Za-z])\.\s*(.+)$/.exec(String(query).trim());
  if (!m || !label) return false;
  const words = String(label).trim().split(/\s+/);
  return words[0]?.[0]?.toLowerCase() === m[1].toLowerCase()
    && normalise(words.slice(1).join(' ')) === normalise(m[2].replace(/\s*\([^)]*\)\s*$/, ''));
}

/**
 * Find one entity for a query: `team:7`, `player:123`, a roster id, any player
 * id, a player's name (full or "K. Bell"), a team name, or a person's name.
 * @returns {{status:'ok', entity} | {status:'unknown', reason, candidates_n}}
 */
export function resolveEntity(map, query) {
  const q = String(query ?? '').trim();
  if (!q) return { status: 'unknown', reason: 'no entity given', candidates_n: 0 };
  const byKey = new Map(map.entities.map(e => [e.key, e]));
  if (byKey.has(q)) return { status: 'ok', entity: byKey.get(q) };
  const teams = map.entities.filter(e => e.kind === 'team');
  if (/^\d{1,3}$/.test(q) && byKey.has(`team:${q}`)) return { status: 'ok', entity: byKey.get(`team:${q}`) };

  const pnorm = personNorm(q);
  const teamHits = teams.filter(t => t.resolve.has(pnorm));
  if (teamHits.length === 1) return { status: 'ok', entity: teamHits[0] };

  const players = map.entities.filter(e => e.kind === 'player');
  const n = normalise(q);
  const playerHits = players.filter(e => e.resolve.has(n) || initialMatch(q, e.label));
  if (playerHits.length === 1) return { status: 'ok', entity: playerHits[0] };
  if (playerHits.length + teamHits.length > 1) {
    return { status: 'unknown', reason: `"${q}" matches ${playerHits.length + teamHits.length} entities; name one by key`, candidates_n: playerHits.length + teamHits.length };
  }
  // A player outside this league's sources: the id bridge still knows him.
  const p = /^player:(\d+)$/.test(q) ? resolvePlayerId(q.slice(7), 'internal') : resolvePlayerId(q);
  if (p) {
    const book = newBook();
    return { status: 'ok', entity: playerEntity(book, p) };
  }
  return { status: 'unknown', reason: `nothing in league ${map.league_id}'s sources is "${q}"`, candidates_n: 0 };
}
