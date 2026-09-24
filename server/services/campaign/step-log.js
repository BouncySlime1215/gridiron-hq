/**
 * STEP-LOG: E5's live evidence. One `campaign_steps` row (083) per War Room
 * step Nick actually sent, with the gain the plan predicted, and the realized
 * gain once the offer settles.
 *
 * A step is logged from either of two signals, whichever comes first:
 *   - "I sent it": a non-retracted `offer.sent` request (FIX-07) whose
 *     trade_outcomes row is still marked sent. The card it stored carries the
 *     predicted gain. Written only once the 10-minute undo window has closed,
 *     so a take-back never leaves a logged step behind.
 *   - ESPN: an observed proposal from Nick's team that is exactly a War Room
 *     step in the plans file (same partner, same players each side, by ESPN
 *     id) and was proposed within OFFER_MATCH_WINDOW_HOURS of that plans file's
 *     generated_at. The trade_outcomes row gets the step's move_id.
 * Either way the identity is (league, move_id, step_index), INSERT OR IGNORE,
 * so the two signals for one offer write one row.
 *
 * SETTLING. A step settles when its trade_outcomes row leaves 'proposed'
 * (accepted / declined / countered / expired). Realized gain =
 *   p_title(first title-odds snapshot served at or after the settle time)
 *   - p_title(last snapshot served at or before the send time)
 * for Nick's team, from the `title_odds_snapshots` view (083). No snapshot yet
 * on either side -> left open, with the reason in the result. This is the
 * weekly-snapshot difference, not the paired-seed rescoring ENGINE-SPECS asks
 * for: games played between the two snapshots move it too.
 *
 * `nonExecuted` picks what a step that did not execute (declined / countered /
 * expired) realizes: 'snapshot' (default) the same snapshot difference, or
 * 'zero' (the roster did not change, so the step itself gained nothing).
 */
import { rows, row, run } from '../../db/index.js';
import { OFFER_MATCH_WINDOW_HOURS } from '../trade-outcomes.js';

const HOUR_MS = 3_600_000;
/** The "I sent it" undo window (warroom-actions/store.js RETRACT_WINDOW_MS). */
export const SENT_SETTLE_MS = 10 * 60 * 1000;
export const SETTLED = Object.freeze(['accepted', 'declined', 'countered', 'expired']);
export const NON_EXECUTED = Object.freeze(['snapshot', 'zero']);

const hasTable = name => rows(`SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`, name).length > 0;
const hasColumn = (table, col) => rows(`PRAGMA table_info(${table})`).some(c => c.name === col);
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const val = f => (f && typeof f === 'object' && 'status' in f ? (f.status === 'ok' ? f.value : undefined) : f);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Why this database cannot hold steps, or null. */
export function stepLogAbsent() {
  if (!hasTable('campaign_steps')) return 'campaign_steps does not exist here (migration 083 has not run)';
  if (!hasColumn('trade_outcomes', 'move_id')) return 'trade_outcomes.move_id does not exist here (migration 083 has not run)';
  return null;
}

/** Write one step's prediction. Returns 1 if written, 0 if that step identity already has a row. */
export function insertStep({ leagueId, moveId, stepIndex = 0, tradeOutcomeId = null, predicted, se = null, at }) {
  if (num(predicted) == null) throw new Error('step-log: predicted_title_odds_gain must be a finite number');
  return Number(run(`INSERT OR IGNORE INTO campaign_steps
    (league_id, move_id, step_index, trade_outcome_id, predicted_title_odds_gain, predicted_se, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, leagueId, String(moveId), stepIndex, tradeOutcomeId, predicted, num(se), at).changes);
}

/* ------------------------------------------------------------ "I sent it" */

/**
 * Log every settled-in "I sent it" for one league. Skips (with a reason) a
 * request whose card had no predicted gain or whose offer was not recorded.
 */
export function logSentSteps(leagueId, { now = Date.now() } = {}) {
  const out = { written: 0, skipped: [] };
  if (!hasTable('warroom_requests')) return { ...out, reason: 'warroom_requests does not exist here (migration 076 has not run)' };
  const list = rows(`SELECT id, kind, payload, created_at FROM warroom_requests
    WHERE league_id = ? AND kind IN ('offer.sent', 'retract') ORDER BY id`, leagueId);
  const retracted = new Set(list.filter(r => r.kind === 'retract').map(r => Number(parse(r.payload)?.request_id)));
  for (const r of list) {
    if (r.kind !== 'offer.sent' || retracted.has(r.id)) continue;
    if (now - Date.parse(r.created_at) < SENT_SETTLE_MS) { out.skipped.push({ request: r.id, why: 'inside the undo window' }); continue; }
    const p = parse(r.payload);
    const toId = p?.trade_outcome?.id;
    const predicted = num(p?.card?.title_odds_delta);
    if (!p?.move_id || toId == null) { out.skipped.push({ request: r.id, why: 'the offer was not recorded' }); continue; }
    if (predicted == null) { out.skipped.push({ request: r.id, why: 'the card had no predicted title-odds gain' }); continue; }
    const o = row('SELECT sent_at FROM trade_outcomes WHERE id = ?', toId);
    if (!o?.sent_at) { out.skipped.push({ request: r.id, why: 'the sent mark was taken back' }); continue; }
    out.written += insertStep({ leagueId, moveId: p.move_id, stepIndex: p.step_index ?? 0, tradeOutcomeId: toId,
      predicted, se: p.card.title_odds_delta_se, at: o.sent_at });
  }
  return out;
}

/* ------------------------------------------------------------ ESPN proposals */

/** Every step the plans entry shows: [{ move_id, step_index, partner, give, get, predicted, se }]. */
export function planSteps(entry) {
  const moves = [val(entry?.next_move), ...(val(entry?.alternatives) ?? [])].filter(m => m?.move_id);
  const out = [];
  const seen = new Set();
  for (const m of moves) {
    if (seen.has(m.move_id)) continue;
    seen.add(m.move_id);
    (m.steps ?? []).forEach((s, i) => {
      const d = s?.title_odds_delta;
      out.push({ move_id: String(m.move_id), step_index: i, partner: String(s.partner),
        give: (s.give ?? []).map(String), get: (s.get ?? []).map(String),
        predicted: num(val(d)), se: num(d?.se ?? null) });
    });
  }
  return out;
}

const key = ids => [...ids].map(String).sort().join(',');

/**
 * Match Nick's ESPN proposals in one league to the plans entry's steps and log
 * them. plans: { entries, as_of } (war-room-view.js#loadPlans). A proposal
 * already carrying a move_id, or already an "I sent it" offer's matched_tx_id,
 * is left to that path.
 */
export function logEspnSteps(leagueId, plans, { season = null } = {}) {
  const out = { matched: 0, written: 0, reason: null };
  const entry = (plans?.entries ?? []).find(e => String(e?.league) === String(leagueId));
  if (!entry) return { ...out, reason: 'no plans entry for this league' };
  const lg = row('SELECT season, my_team_id FROM leagues WHERE id = ?', leagueId);
  const me = entry.me != null ? String(entry.me) : lg?.my_team_id != null ? String(lg.my_team_id) : null;
  if (!me) return { ...out, reason: "this league does not say which team is Nick's" };
  const steps = planSteps(entry).filter(s => s.predicted != null);
  if (!steps.length) return { ...out, reason: 'the plans entry shows no step with a predicted gain' };
  const asOf = Date.parse(plans.as_of);
  if (!Number.isFinite(asOf)) return { ...out, reason: 'the plans file has no generated_at' };

  // Plans player ids -> ESPN ids.
  const ids = [...new Set(steps.flatMap(s => [...s.give, ...s.get]).map(Number).filter(Number.isInteger))];
  const espn = new Map(ids.length ? rows(`SELECT id, espn_id FROM players WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
    .filter(p => p.espn_id != null).map(p => [String(p.id), String(p.espn_id)]) : []);
  const toEspn = list => (list.every(id => espn.has(id)) ? key(list.map(id => espn.get(id))) : null);
  const byDeal = new Map();
  for (const s of steps) {
    const g = toEspn(s.give), t = toEspn(s.get);
    if (g && t) byDeal.set(`${s.partner}|${g}|${t}`, s);
  }

  const proposals = rows(`SELECT o.id, o.counterparty_team_id, o.give_json, o.get_json, o.proposed_at
    FROM trade_outcomes o
    WHERE o.league_id = ? AND o.season = COALESCE(?, o.season) AND o.source = 'observed'
      AND o.proposer_team_id = ? AND o.move_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM trade_outcomes s WHERE s.league_id = o.league_id AND s.matched_tx_id = o.espn_tx_id)`,
  leagueId, season ?? lg?.season ?? null, me);
  const espnIds = json => { const a = parse(json); return Array.isArray(a) ? key(a.map(i => i?.playerId ?? i?.espn_id).filter(x => x != null)) : null; };
  for (const p of proposals) {
    if (!(Math.abs(Date.parse(p.proposed_at) - asOf) <= OFFER_MATCH_WINDOW_HOURS * HOUR_MS)) continue;
    const s = byDeal.get(`${p.counterparty_team_id}|${espnIds(p.give_json)}|${espnIds(p.get_json)}`);
    if (!s) continue;
    out.matched++;
    run('UPDATE trade_outcomes SET move_id = ? WHERE id = ? AND move_id IS NULL', s.move_id, p.id);
    out.written += insertStep({ leagueId, moveId: s.move_id, stepIndex: s.step_index, tradeOutcomeId: p.id,
      predicted: s.predicted, se: s.se, at: p.proposed_at });
  }
  return out;
}

/* ------------------------------------------------------------ settling */

/** Nick's team p_title from the snapshot view: the last at/before `at`, or the first at/after. */
function snapshot(leagueId, team, at, side) {
  return side === 'before'
    ? row(`SELECT p_title, served_at FROM title_odds_snapshots WHERE league_id = ? AND team_id = ? AND served_at <= ?
           AND p_title IS NOT NULL ORDER BY served_at DESC LIMIT 1`, leagueId, team, at)
    : row(`SELECT p_title, served_at FROM title_odds_snapshots WHERE league_id = ? AND team_id = ? AND served_at >= ?
           AND p_title IS NOT NULL ORDER BY served_at ASC LIMIT 1`, leagueId, team, at);
}

/**
 * Fill realized gain on every open step of one league whose offer has settled
 * and has a snapshot on both sides. Idempotent: a realized step is never
 * touched again. Returns { settled, open: [{ id, why }] }.
 */
export function settleSteps(leagueId, { nonExecuted = 'snapshot' } = {}) {
  if (!NON_EXECUTED.includes(nonExecuted)) throw new Error(`step-log: nonExecuted must be one of ${NON_EXECUTED.join(', ')}`);
  const out = { settled: 0, open: [] };
  const lg = row('SELECT my_team_id FROM leagues WHERE id = ?', leagueId);
  const open = rows(`SELECT s.id, s.trade_outcome_id, s.created_at, o.status, o.resolved_at, o.sent_at, o.proposed_at,
      o.proposer_team_id
    FROM campaign_steps s LEFT JOIN trade_outcomes o ON o.id = s.trade_outcome_id
    WHERE s.league_id = ? AND s.realized_title_odds_gain IS NULL ORDER BY s.id`, leagueId);
  for (const s of open) {
    const why = w => out.open.push({ id: s.id, why: w });
    if (s.trade_outcome_id == null || s.status == null) { why('no trade_outcomes row to settle from'); continue; }
    if (!SETTLED.includes(s.status)) { why(`offer still ${s.status}`); continue; }
    if (!s.resolved_at) { why(`offer ${s.status} with no settle time`); continue; }
    const team = s.proposer_team_id ?? (lg?.my_team_id != null ? String(lg.my_team_id) : null);
    if (!team) { why("no team to read title odds for"); continue; }
    const sentAt = s.sent_at ?? s.proposed_at ?? s.created_at;
    let realized;
    if (s.status !== 'accepted' && nonExecuted === 'zero') realized = 0;
    else {
      const before = snapshot(leagueId, String(team), sentAt, 'before');
      if (!before) { why('no title-odds snapshot at or before the send'); continue; }
      const after = snapshot(leagueId, String(team), s.resolved_at > before.served_at ? s.resolved_at : before.served_at, 'after');
      if (!after || after.served_at === before.served_at) { why('no title-odds snapshot after the offer settled yet'); continue; }
      realized = after.p_title - before.p_title;
    }
    out.settled += Number(run(`UPDATE campaign_steps SET realized_title_odds_gain = ?, realized_at = ?
      WHERE id = ? AND realized_title_odds_gain IS NULL`, realized, s.resolved_at, s.id).changes);
  }
  return out;
}

/** One league, every signal, then settle. */
export function stepLogLeague(leagueId, plans, opts = {}) {
  const absent = stepLogAbsent();
  if (absent) return { league: leagueId, state: 'absent', reason: absent };
  return { league: leagueId, state: 'ok', sent: logSentSteps(leagueId, opts), espn: logEspnSteps(leagueId, plans, opts),
    settle: settleSteps(leagueId, opts) };
}
