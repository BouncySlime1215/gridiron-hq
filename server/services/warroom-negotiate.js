/**
 * NEGOTIATE-UI: negotiation mode (WAR-ROOM-UI.md v3, new mode 1).
 *
 * After "I sent it" the War Room card becomes a live thread:
 *   - branches for his reply: the step's own `reply_table` as the plans file served
 *     it when Nick sent the offer (stored with the thread, so a replan does not
 *     rewrite what he sent against); logging a reply marks its branch;
 *   - a countdown to "follow up" and then "move on", read off HIS reply-time
 *     distribution (replyTimes below), with the source and sample size shown;
 *   - the counter builder (campaign/negotiate-engine.js) and the walk-away line.
 *
 * Nothing here sends an offer or changes a plan. Threads live in the two tables of
 * migration 102; the sent time is trade_outcomes.sent_at (the one "I sent it" store),
 * never a copy. Every query is parameterised.
 */
import { row, rows, run } from '../db/index.js';
import { NUDGE_HOURS, SWITCH_HOURS } from './campaign/playbook.js';
import { offerState } from './campaign/negotiator-safety.js';

export const REPLY_KINDS = Object.freeze(['accept', 'decline', 'counter', 'silence']);
export const CLOSE_REASONS = Object.freeze(['accepted', 'declined', 'walked_away', 'undone']);
/** "I sent it" can be undone for this long (WAR-ROOM-UI.md section 5, step 3). */
export const UNDO_MINUTES = 10;
/** A reply-time quantile needs this many observations (variables.js MIN_N). */
export const MIN_REPLIES = 5;
/** Hand-set floors on the countdown, so a fast texter is not chased within minutes. */
export const FOLLOW_UP_FLOOR_MIN = 60;
export const MOVE_ON_FLOOR_MIN = 240;
const MIN = 60_000;

/* ------------------------------------------------------ reply-time data */

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/**
 * How long HE takes to answer an offer, in minutes, from ESPN's own log. ESPN writes
 * Nick's offer as TRADE_PROPOSAL/EXECUTE under Nick's team and his answer as its own
 * TRADE_ACCEPT or TRADE_DECLINE/EXECUTE row under HIS team, tied back by related_tx_id
 * (the same reading as counterparty-pricing.js#selfRead and manager-signals.js). The
 * gap is answer.proposed_at - offer.proposed_at. PROCESS and CANCEL rows are the league
 * processing or vetoing, not him answering. Offers that expire unanswered leave no
 * row, so this is his time when he does answer.
 */
export function espnReplyMinutes(leagueId, me, partner) {
  let list;
  try {
    list = rows(`SELECT o.tx_id, o.proposed_at AS asked, a.proposed_at AS answered
                 FROM league_transactions_raw o
                 JOIN league_transactions_raw a
                   ON a.league_id = o.league_id AND a.season = o.season AND a.related_tx_id = o.tx_id
                  AND a.type IN ('TRADE_ACCEPT', 'TRADE_DECLINE') AND a.execution_type = 'EXECUTE'
                  AND a.team_id = ?
                 WHERE o.league_id = ? AND o.type = 'TRADE_PROPOSAL' AND o.execution_type = 'EXECUTE'
                   AND o.team_id = ?`, Number(partner), leagueId, Number(me));
  } catch (e) {
    // The table is created by scripts/collect-league-transactions.mjs, not a migration.
    if (/no such table/.test(e.message)) return { minutes: [], missing: 'the ESPN transaction log has not been collected on this machine' };
    throw e;
  }
  const seen = new Set(), minutes = [];
  for (const r of list) {
    if (seen.has(r.tx_id)) continue;
    seen.add(r.tx_id);
    const gap = (Date.parse(r.answered) - Date.parse(r.asked)) / MIN;
    if (Number.isFinite(gap) && gap >= 0) minutes.push(gap);
  }
  return { minutes };
}

/** A chat read walks his whole message history, so each is kept this long. */
const CHAT_MEMO_MS = 10 * 60_000;
const chatMemo = new Map();

/** His chat reply latency (coach/people/variables.js), when the chat corpus and a trusted identity exist. */
async function chatReplyQuantiles(leagueId, partner) {
  const key = `${leagueId}:${partner}`;
  const hit = chatMemo.get(key);
  if (hit && Date.now() - hit.at < CHAT_MEMO_MS) return hit.value;
  const { identityMap } = await import('./manager-identity.js');
  const ids = identityMap(leagueId);
  const who = ids.get(String(partner)) ?? ids.get(Number(partner));
  let value;
  if (!who?.chat_name) value = { missing: 'no trusted match between this team and a chat name' };
  else {
    const { personVariables } = await import('./coach/people/variables.js');
    const vars = personVariables(who.chat_name);
    const p50 = vars.find(v => v.id === 'reply_latency_p50'), p90 = vars.find(v => v.id === 'reply_latency_p90');
    value = Number.isFinite(p50?.value) && Number.isFinite(p90?.value)
      ? { p50: p50.value, p90: p90.value, n: p90.n }
      : { missing: p90?.withheld ?? p50?.withheld ?? 'no reply latency measured for him' };
  }
  chatMemo.set(key, { at: Date.now(), value });
  return value;
}

/**
 * His reply-time distribution: { status, p50_min, p90_min, n, source, basis, reason? }.
 * ESPN offer answers first (the thing being timed is an offer), then his chat reply
 * latency, else the playbook's hand-set 24 h / 48 h with the reason there is no data.
 * `chat` replaces the chat read (tests; the corpus lives on one machine).
 */
export async function replyTimes(leagueId, me, partner, { chat = chatReplyQuantiles } = {}) {
  const espn = espnReplyMinutes(leagueId, me, partner);
  if (espn.minutes.length >= MIN_REPLIES) {
    const s = espn.minutes.slice().sort((a, b) => a - b);
    return { status: 'ok', p50_min: quantile(s, 0.5), p90_min: quantile(s, 0.9), n: s.length, source: 'espn.offers',
      basis: `his answers to ${s.length} of your ESPN offers, offer to answer` };
  }
  const why = [espn.missing ?? `${espn.minutes.length} answered ESPN offer${espn.minutes.length === 1 ? '' : 's'} to him (needs ${MIN_REPLIES})`];
  let c;
  try { c = await chat(leagueId, partner); } catch (e) { c = { missing: `the chat read failed (${e.message ?? e})` }; }
  if (Number.isFinite(c?.p90) && Number.isFinite(c?.p50)) {
    return { status: 'ok', p50_min: c.p50, p90_min: c.p90, n: c.n ?? null, source: 'chat.labels',
      basis: `his reply time in the league chat${c.n ? `, ${c.n} replies` : ''}` };
  }
  why.push(c?.missing ?? 'no chat reply time');
  return { status: 'unknown', p50_min: null, p90_min: null, n: 0, source: 'plan.template',
    basis: `hand-set: follow up at ${NUDGE_HOURS} h, move on at ${SWITCH_HOURS} h`,
    reason: `No reply-time data for him: ${why.join('; ')}.` };
}

/**
 * The countdown for a thread sent at `sentAt` (ISO), at `now` (ms).
 * Follow up once he is past his slow reply time (p90); move on at twice it.
 * Returns { phase, follow_up_at, move_on_at, basis, source, n, guess, reason? }.
 */
export function countdown(dist, sentAt, now, { answeredAt = null } = {}) {
  const sent = Date.parse(sentAt);
  const measured = dist?.status === 'ok' && Number.isFinite(dist.p90_min);
  const followMin = measured ? Math.max(FOLLOW_UP_FLOOR_MIN, dist.p90_min) : NUDGE_HOURS * 60;
  const moveMin = measured ? Math.max(MOVE_ON_FLOOR_MIN, 2 * dist.p90_min) : SWITCH_HOURS * 60;
  const follow_up_at = new Date(sent + followMin * MIN).toISOString();
  const move_on_at = new Date(sent + moveMin * MIN).toISOString();
  const phase = answeredAt ? 'answered'
    : now >= sent + moveMin * MIN ? 'move_on'
      : now >= sent + followMin * MIN ? 'follow_up' : 'waiting';
  return {
    phase, follow_up_at, move_on_at,
    typical_min: measured ? dist.p50_min : null, slow_min: measured ? dist.p90_min : null,
    source: dist?.source ?? 'plan.template', n: dist?.n ?? 0, guess: true,
    basis: measured
      ? `${dist.basis}; follow up past his slow reply time (90th percentile), move on at twice it (hand-set rule, floors ${FOLLOW_UP_FLOOR_MIN} min / ${MOVE_ON_FLOOR_MIN / 60} h)`
      : dist?.basis ?? `hand-set: follow up at ${NUDGE_HOURS} h, move on at ${SWITCH_HOURS} h`,
    ...(measured ? {} : { reason: dist?.reason ?? 'No reply-time data for him.' })
  };
}

/* ------------------------------------------------------------ the step */

/** The move and step on the served view, or null. The deck is alternatives.value (FIX-04). */
export function findStep(view, moveId, stepIndex = 0) {
  const moves = [];
  if (view?.alternatives?.status === 'ok') moves.push(...view.alternatives.value);
  if (view?.next_move?.status === 'ok') moves.push(view.next_move.value);
  const move = moves.find(m => m?.move_id === moveId);
  const step = move?.steps?.[stepIndex];
  return step ? { move, step } : null;
}

const STEP_KEYS = ['partner', 'give', 'get', 'p_yes', 'p_yes_band', 'title_odds_delta', 'title_after',
  'message', 'walk_away', 'reply_table'];

/* ------------------------------------------------------------ the store */

const parse = s => (s == null ? null : JSON.parse(s));

/**
 * A thread with its sent time. "I sent it" has ONE store, trade_outcomes.sent_at
 * (migration 080, warroom-actions/store.js#recordRequest); the thread reads it
 * through trade_outcome_id and never keeps a copy. NULL once that mark is taken back.
 */
const THREAD_SQL = `SELECT n.*, o.sent_at AS sent_at FROM negotiation_threads n
                    LEFT JOIN trade_outcomes o ON o.id = n.trade_outcome_id`;

function threadRow(id) {
  return row(`${THREAD_SQL} WHERE n.id = ?`, id);
}

/**
 * Open (or return the already-open) thread for one step Nick marked sent.
 * `tradeOutcomeId` is the trade_outcomes row "I sent it" wrote or found. An open
 * thread whose sent mark was taken back elsewhere (the deck's own retract) is closed
 * as undone first, so it never blocks a fresh send.
 */
export function openThread({ leagueId, userId = null, tradeOutcomeId, moveId, stepIndex = 0, step, names, snapshotId = null, at }) {
  closeIfUnsent(leagueId, moveId, stepIndex, at);
  const open = row(`${THREAD_SQL} WHERE n.league_id = ? AND n.move_id = ? AND n.step_index = ? AND n.status = 'open'`,
    leagueId, moveId, stepIndex);
  if (open) return open.id;
  const kept = Object.fromEntries(STEP_KEYS.filter(k => k in step).map(k => [k, step[k]]));
  const ids = new Set([...step.give, ...step.get, ...(step.walk_away?.value?.max_give ?? [])].map(String));
  const labels = Object.fromEntries([...ids].map(id => [id, names?.[id] ?? `Player ${id}`]));
  run(`INSERT INTO negotiation_threads
         (league_id, user_id, trade_outcome_id, move_id, step_index, partner, give_json, get_json, step_json, names_json, snapshot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  leagueId, userId, tradeOutcomeId, moveId, stepIndex, String(step.partner), JSON.stringify(step.give.map(String)),
  JSON.stringify(step.get.map(String)), JSON.stringify(kept), JSON.stringify(labels), snapshotId);
  return row('SELECT last_insert_rowid() AS id').id;
}

/**
 * Close, as undone, the open thread for this step whose sent mark was taken back.
 * Call it BEFORE recording a fresh "I sent it", which re-marks the same row.
 */
export function closeIfUnsent(leagueId, moveId, stepIndex, at) {
  const open = row(`${THREAD_SQL} WHERE n.league_id = ? AND n.move_id = ? AND n.step_index = ? AND n.status = 'open'`,
    leagueId, moveId, stepIndex);
  if (open && open.sent_at == null) closeThread(open.id, 'undone', at);
}

export function getThread(leagueId, id) {
  const t = threadRow(id);
  return t && Number(t.league_id) === Number(leagueId) ? t : null;
}

export function threadsFor(leagueId, { includeClosedHours = 24, now = Date.now() } = {}) {
  const since = new Date(now - includeClosedHours * 3600_000).toISOString();
  return rows(`${THREAD_SQL} WHERE n.league_id = ? AND (n.status = 'open' OR n.closed_at >= ?)
               ORDER BY n.id DESC`, leagueId, since);
}

export function eventsOf(id) {
  return rows('SELECT * FROM negotiation_events WHERE thread_id = ? ORDER BY id', id);
}

export function addEvent(id, { kind, reply = null, give = null, get = null, note = null, at }) {
  run(`INSERT INTO negotiation_events (thread_id, kind, reply, give_json, get_json, note, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  id, kind, reply, give ? JSON.stringify(give.map(String)) : null, get ? JSON.stringify(get.map(String)) : null, note, at);
}

export function closeThread(id, reason, at) {
  run(`UPDATE negotiation_threads SET status = 'closed', closed_reason = ?, closed_at = ?
       WHERE id = ? AND status = 'open'`, reason, at, id);
}

/** Adds labels for players first named in a counter, so the thread can print them. */
export function addNames(id, labels) {
  const t = threadRow(id);
  const names = { ...parse(t.names_json), ...labels };
  run('UPDATE negotiation_threads SET names_json = ? WHERE id = ?', JSON.stringify(names), id);
}

/* ------------------------------------------------------------- the view */

const BRANCH_LABELS = { accept: 'He accepts', decline: 'He declines', counter: 'He counters', silence: 'No reply' };
/** A logged reply closes the thread for these; a counter or silence keeps it open. */
const CLOSES = { accept: 'accepted', decline: 'declined' };
export const closesOn = kind => CLOSES[kind] ?? null;

/** The latest send on a thread: "I sent it" (null once taken back), or Nick's latest counter. */
export function lastSendOf(t, events) {
  const unsent = t.sent_at == null;
  return [...(unsent ? [] : [t.sent_at]), ...events.filter(e => e.kind === 'counter_sent').map(e => e.at)].sort().pop() ?? null;
}

/** Every player a thread's deal names: the step, Nick's counters and his logged asks. */
export function dealIdsOf(t, events) {
  const out = new Set([...parse(t.give_json), ...parse(t.get_json)].map(String));
  for (const e of events) for (const x of [...(parse(e.give_json) ?? []), ...(parse(e.get_json) ?? [])]) out.add(String(x));
  return [...out];
}

/**
 * The thread as the client draws it. `dist` is replyTimes()'s result for the partner.
 * The latest logged reply picks the live branch; before any reply the countdown runs.
 * NEGOTIATOR-SAFETY: with `news` (campaign/deal-news.js#dealNews since the last send) an open thread also
 * carries `offer`: when it expires and whether news on a player in the deal says to withdraw it now.
 */
export function threadView(t, events, dist, now, { news = null } = {}) {
  const step = parse(t.step_json);
  const replies = events.filter(e => e.kind === 'reply');
  const last = replies[replies.length - 1] ?? null;
  const table = step.reply_table;
  const branches = REPLY_KINDS.map(kind => ({
    kind, label: BRANCH_LABELS[kind],
    plan: table?.status === 'ok' ? (table.value?.[kind] ?? { status: 'unknown', source: 'plan.path', reason: 'Not planned yet.' })
      : { status: table?.status === 'failed' ? 'failed' : 'unknown', source: 'plan.path', reason: table?.reason ?? 'Not planned yet.' },
    live: last?.reply === kind
  }));
  // "I sent it" taken back in the one sent store (trade_outcomes.sent_at is NULL):
  // the thread reads as undone, whatever its own row says.
  const unsent = t.sent_at == null;
  const status = unsent ? 'closed' : t.status;
  const closedReason = unsent && t.status === 'open' ? 'undone' : t.closed_reason;
  // The clock restarts when Nick sends a counter; an answer after the latest send stops it.
  const lastSend = lastSendOf(t, events);
  const answered = replies.find(e => e.reply !== 'silence' && e.at >= lastSend) ?? null;
  const sentMs = unsent ? NaN : Date.parse(t.sent_at);
  return {
    id: t.id, league_id: t.league_id, move_id: t.move_id, step_index: t.step_index,
    partner: t.partner, give: parse(t.give_json), get: parse(t.get_json),
    names: parse(t.names_json),
    sent_at: t.sent_at, snapshot_id: t.snapshot_id,
    status, closed_reason: closedReason, closed_at: t.closed_at,
    undo_until: unsent ? null : new Date(sentMs + UNDO_MINUTES * MIN).toISOString(),
    can_undo: status === 'open' && now < sentMs + UNDO_MINUTES * MIN,
    step: { p_yes: step.p_yes, p_yes_band: step.p_yes_band ?? null, title_odds_delta: step.title_odds_delta,
      title_after: step.title_after, message: step.message, walk_away: step.walk_away },
    branches,
    events: events.map(e => ({ kind: e.kind, reply: e.reply, give: parse(e.give_json), get: parse(e.get_json), note: e.note, at: e.at })),
    countdown: status === 'open' ? { ...countdown(dist, lastSend, now, { answeredAt: answered?.at ?? null }), from: lastSend } : null,
    ...(news && status === 'open' && lastSend ? { offer: offerState({ lastSend, now, ids: dealIdsOf(t, events), news }) } : {})
  };
}
