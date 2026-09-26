/**
 * COACH-CHAT: Coach conversations (migration 114).
 *
 * One active thread per (user, league); "New conversation" archives it and
 * opens another. A thread keeps its last N turns (a turn is Nick's question and
 * Coach's reply; N from GRIDIRON_COACH_THREAD_TURNS, default 12) and folds the
 * turns that fall out of that window into a rolling structured summary: how
 * many turns, which intents, which moves, partners and players were discussed.
 * The summary holds ids and counts, never the text.
 *
 * The thread also carries the FOCUS: what "him", "that trade" and "the other
 * one" refer to (focus.js resolves it; this file only stores it).
 *
 * Local-only data in the gitignored database.
 */
import { db, rows, row, run } from '../../db/index.js';

export const THREAD_TURNS_ENV = 'GRIDIRON_COACH_THREAD_TURNS';
export const DEFAULT_THREAD_TURNS = 12;
const MIN_TURNS = 2;
const MAX_TURNS = 50;
/** The summary keeps at most this many ids per list, newest last. */
const SUMMARY_IDS = 12;

/** Turns a thread retains, from the env (a bad value is refused loudly, not guessed around). */
export function threadTurnLimit(env = process.env) {
  const raw = env[THREAD_TURNS_ENV];
  if (raw == null || raw === '') return DEFAULT_THREAD_TURNS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_TURNS || n > MAX_TURNS) {
    throw new Error(`${THREAD_TURNS_ENV} must be a whole number from ${MIN_TURNS} to ${MAX_TURNS}, not ${JSON.stringify(raw)}`);
  }
  return n;
}

const parse = (text, what) => {
  try { return JSON.parse(text ?? '{}'); } catch (e) {
    throw new Error(`coach thread ${what} is not valid JSON: ${e.message}`);
  }
};

function shape(r) {
  if (!r) return null;
  return { id: r.id, league_id: r.league_id, status: r.status, focus: parse(r.focus_json, 'focus'),
    summary: parse(r.summary_json, 'summary'), created_at: r.created_at, updated_at: r.updated_at };
}

const assertIds = (userId, leagueId) => {
  if (!Number.isInteger(userId) || userId < 1) throw new Error('a coach thread needs a user id');
  if (!Number.isInteger(leagueId) || leagueId < 1) throw new Error('a coach thread needs a league id');
};

/** The user's active thread in this league; created when `create` and none exists. */
export function activeThread(userId, leagueId, { create = true } = {}) {
  assertIds(userId, leagueId);
  const found = row(`SELECT * FROM coach_threads WHERE user_id = ? AND league_id = ? AND status = 'active'`, userId, leagueId);
  if (found || !create) return shape(found);
  run(`INSERT OR IGNORE INTO coach_threads (user_id, league_id) VALUES (?, ?)`, userId, leagueId);
  return shape(row(`SELECT * FROM coach_threads WHERE user_id = ? AND league_id = ? AND status = 'active'`, userId, leagueId));
}

/** "New conversation": the active thread is archived (kept, not shown) and a fresh one opens. */
export function newThread(userId, leagueId) {
  assertIds(userId, leagueId);
  db.exec('BEGIN');
  try {
    run(`UPDATE coach_threads SET status = 'archived', updated_at = datetime('now')
         WHERE user_id = ? AND league_id = ? AND status = 'active'`, userId, leagueId);
    run(`INSERT INTO coach_threads (user_id, league_id) VALUES (?, ?)`, userId, leagueId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return activeThread(userId, leagueId, { create: false });
}

/** The retained messages of a thread, oldest first. */
export function threadMessages(threadId) {
  return rows(`SELECT id, role, text, intent, payload_json, created_at FROM coach_messages WHERE thread_id = ? ORDER BY id`, threadId)
    .map(r => ({ id: r.id, role: r.role, text: r.text, intent: r.intent, payload: parse(r.payload_json, 'message payload'), created_at: r.created_at }));
}

const pushIds = (list, ids) => {
  const out = [...(list ?? [])];
  for (const id of ids) {
    if (id == null || id === '') continue;
    const s = String(id);
    const at = out.indexOf(s);
    if (at >= 0) out.splice(at, 1);
    out.push(s);
  }
  return out.slice(-SUMMARY_IDS);
};

/**
 * Fold turns into the rolling summary (pure). A turn is { question, intent,
 * focus, at }; only its intent, ids and time are kept.
 */
export function foldSummary(summary = {}, turns = []) {
  const s = { turns_folded: 0, intents: {}, moves: [], partners: [], players: [], first_at: null, last_at: null, ...summary };
  s.intents = { ...s.intents };
  for (const t of turns) {
    s.turns_folded += 1;
    const intent = t.intent ?? 'free_text';
    s.intents[intent] = (s.intents[intent] ?? 0) + 1;
    const f = t.focus ?? {};
    s.moves = pushIds(s.moves, [f.move_id]);
    s.partners = pushIds(s.partners, [f.partner]);
    s.players = pushIds(s.players, f.players ?? []);
    s.first_at = s.first_at ?? t.at ?? null;
    s.last_at = t.at ?? s.last_at;
  }
  return s;
}

/** The summary in one line of words, for the model path's context (ids only, no text). */
export function summaryText(summary) {
  if (!summary?.turns_folded) return '';
  const intents = Object.entries(summary.intents ?? {}).map(([k, n]) => `${k.replace(/_/g, ' ')} x${n}`).join(', ');
  const bits = [`${summary.turns_folded} earlier turn${summary.turns_folded === 1 ? '' : 's'} (${intents})`];
  if (summary.moves?.length) bits.push(`moves discussed: ${summary.moves.join(', ')}`);
  if (summary.partners?.length) bits.push(`partners discussed: team ${summary.partners.join(', team ')}`);
  if (summary.players?.length) bits.push(`players discussed: ${summary.players.join(', ')}`);
  return bits.join('; ');
}

/**
 * Record one turn: Nick's question, Coach's reply payload, and the focus after
 * it. Then retention: turns past the limit fold into the summary and are
 * deleted. Returns { folded } (how many turns were folded this time).
 */
export function appendTurn(threadId, { question, intent = null, reply, focus = {} }, { limit = threadTurnLimit() } = {}) {
  if (!Number.isInteger(threadId)) throw new Error('appendTurn needs a thread id');
  const text = String(question ?? '').trim();
  if (!text) throw new Error('appendTurn needs the question');
  const replyText = String(reply?.text ?? '').trim() || '(no text)';
  db.exec('BEGIN');
  try {
    run(`INSERT INTO coach_messages (thread_id, role, text, intent, payload_json) VALUES (?, 'nick', ?, ?, '{}')`, threadId, text, intent);
    run(`INSERT INTO coach_messages (thread_id, role, text, intent, payload_json) VALUES (?, 'coach', ?, ?, ?)`,
      threadId, replyText, intent, JSON.stringify({ ...(reply ?? {}), focus }));
    run(`UPDATE coach_threads SET focus_json = ?, updated_at = datetime('now') WHERE id = ?`, JSON.stringify(focus ?? {}), threadId);
    const folded = enforceRetention(threadId, limit);
    db.exec('COMMIT');
    return { folded };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Fold and delete the turns beyond `limit` (oldest first). Runs inside appendTurn's transaction. */
function enforceRetention(threadId, limit) {
  const msgs = rows(`SELECT id, role, intent, payload_json, created_at FROM coach_messages WHERE thread_id = ? ORDER BY id`, threadId);
  const starts = msgs.map((m, i) => (m.role === 'nick' ? i : -1)).filter(i => i >= 0);
  const extra = starts.length - limit;
  if (extra <= 0) return 0;
  const cut = starts[extra];
  const old = msgs.slice(0, cut);
  const turns = [];
  for (const m of old) {
    if (m.role === 'nick') turns.push({ intent: m.intent, focus: {}, at: m.created_at });
    else if (turns.length) turns[turns.length - 1].focus = parse(m.payload_json, 'message payload').focus ?? {};
  }
  const t = row('SELECT summary_json FROM coach_threads WHERE id = ?', threadId);
  const summary = foldSummary(parse(t?.summary_json, 'summary'), turns);
  run('UPDATE coach_threads SET summary_json = ? WHERE id = ?', JSON.stringify(summary), threadId);
  run('DELETE FROM coach_messages WHERE thread_id = ? AND id < ?', threadId, msgs[cut].id);
  return turns.length;
}

/** The recent turns as { role, text } for the model path's context. */
export function recentTurns(threadId, turns = threadTurnLimit()) {
  const msgs = threadMessages(threadId);
  return msgs.slice(-turns * 2).map(m => ({ role: m.role, text: m.text }));
}
