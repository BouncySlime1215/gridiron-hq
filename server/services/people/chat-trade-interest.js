/**
 * CHAT-TRADE-INTEREST (SCREENSHOT-OFFERS follow-up): wants / would-give signals from a league-mate's
 * own trade screenshots (a finalize/draft screen he is composing, or an analyzer comparison he built).
 * One writer and one reader over `chat_trade_interest` (migration 109). Ids only.
 *
 * WHAT IT IS NOT. A draft is not an offer (the offer ledger requires ESPN's trace of it) and a
 * what-if is not a price. This is a shadow signal for the people model: the his-side lens logs it
 * per target; nothing served reads it and nothing is weighted on it until it is measured.
 */
import { row, run } from '../../db/index.js';

export const INTEREST_KINDS = Object.freeze(['finalize', 'hypothetical']);

const tableReady = () => !!row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'chat_trade_interest'`);
const ids = xs => [...new Set((xs ?? []).map(Number).filter(Number.isInteger))];

/**
 * o: { league_id, season, roster_id, wants_ids, would_give_ids, kind, seen_at, confidence, source_key }.
 * -> { state: 'recorded' | 'already_recorded' | 'refused' | 'table_absent', id?, reason? }
 */
export function recordChatTradeInterest(o) {
  if (!tableReady()) return { state: 'table_absent', reason: 'chat_trade_interest does not exist here — migration 109 has not run' };
  for (const f of ['league_id', 'season', 'roster_id', 'kind', 'seen_at', 'confidence', 'source_key']) {
    if (o?.[f] == null) return { state: 'refused', reason: `${f} is required` };
  }
  if (!INTEREST_KINDS.includes(o.kind)) return { state: 'refused', reason: `kind must be one of ${INTEREST_KINDS.join(', ')}` };
  const wants = ids(o.wants_ids);
  const give = ids(o.would_give_ids);
  if (!wants.length && !give.length) return { state: 'refused', reason: 'no player on either side' };
  const have = row('SELECT id FROM chat_trade_interest WHERE source_key = ?', String(o.source_key));
  if (have) return { state: 'already_recorded', id: have.id };
  const info = run(`INSERT INTO chat_trade_interest (league_id, season, roster_id, wants_ids, would_give_ids, kind, seen_at,
      confidence, source_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  o.league_id, o.season, o.roster_id, JSON.stringify(wants), JSON.stringify(give), o.kind, o.seen_at,
  Math.max(0, Math.min(1, Number(o.confidence))), String(o.source_key), new Date().toISOString());
  return { state: 'recorded', id: Number(info.lastInsertRowid) };
}

/**
 * One league-season's rows, newest first, with each player's ESPN id beside his players.id so a caller
 * can map to its own id space. -> { status: 'ok', rows } | { status: 'absent', reason }
 */
export function readChatTradeInterest(database, leagueId, season) {
  const q = (sql, ...a) => (database?.rows ? database.rows(sql, ...a) : database.prepare(sql).all(...a));
  const has = q(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'chat_trade_interest'`).length;
  if (!has) return { status: 'absent', reason: 'chat_trade_interest does not exist here — migration 109 has not run' };
  const out = q(`SELECT roster_id, wants_ids, would_give_ids, kind, seen_at, confidence FROM chat_trade_interest
                 WHERE league_id = ? AND season = ? ORDER BY seen_at DESC, id DESC`, leagueId, season);
  const all = new Set(out.flatMap(r => [...JSON.parse(r.wants_ids), ...JSON.parse(r.would_give_ids)]));
  const espn = new Map();
  if (all.size) {
    for (const p of q(`SELECT id, espn_id FROM players WHERE id IN (${[...all].map(() => '?').join(',')})`, ...all)) espn.set(p.id, p.espn_id);
  }
  const side = j => JSON.parse(j).map(id => ({ player_id: id, espn_id: espn.get(id) ?? null }));
  return { status: 'ok', rows: out.map(r => ({ roster_id: r.roster_id, kind: r.kind, seen_at: r.seen_at, confidence: r.confidence,
    wants: side(r.wants_ids), would_give: side(r.would_give_ids) })) };
}

