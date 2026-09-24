/**
 * FIX-07 (c): what the War Room shows is measured like every other surface.
 *
 * On each GET /api/trades/:id/war-room this:
 *   - logs the shown next move to `follow_ledger` (kind 'next_move', through
 *     engine/follow-ledger.js#logNextMove: INSERT OR IGNORE, so a re-render
 *     inserts nothing) so SELF-01 can later see whether Nick followed it;
 *   - queues a `war_room` surface in serve-log.js (p_yes, title_odds_delta,
 *     title_after per shown move, and my title_now) for grading later.
 *
 * Both read the league's entry in the plans file as the producer wrote it
 * (contract warroom-plans/1). Neither throws into the route: the view is the
 * product, the logs the measurement. Each says what it did, and when it did
 * nothing, why (`reason`), so an inert log is visible in the response.
 */
import { logNextMove } from './engine/follow-ledger.js';
import { recordServed } from './serve-log.js';
import { leagueEntry } from './warroom-actions/cards.js';

const val = f => (f?.status === 'ok' ? f.value : null);
const num = f => { const v = val(f); return typeof v === 'number' && Number.isFinite(v) ? v : null; };

/** The follow-ledger move for a plans entry, or { reason } when there is none to log. */
export function nextMoveOf(entry, lg) {
  const next = val(entry?.next_move);
  const st = next?.steps?.[0];
  if (!next?.move_id || !st) return { reason: 'no next move in the plans file for this league' };
  const week = Number(lg?.current_week);
  if (!(week >= 1) || !Number.isInteger(Number(lg?.season))) return { reason: 'league has no current week or season on file' };
  const runnerUp = (val(entry.alternatives) ?? []).find(m => m?.move_id && m.move_id !== next.move_id) ?? null;
  const rs = runnerUp?.steps?.[0] ?? null;
  const head = num(next.expected), alt = num(runnerUp?.expected);
  return {
    move: {
      season: Number(lg.season), week, action: 'trade',
      pick: { partner_id: String(st.partner), give: st.give, get: st.get, move_id: next.move_id },
      alternative: rs ? { partner_id: String(rs.partner), give: rs.give, get: rs.get, move_id: runnerUp.move_id } : null,
      // The margin the call was made on: its expected gain over the runner-up's (objective units).
      margin: head != null && alt != null ? head - alt : null,
      inputs: { move_id: next.move_id, p_yes: num(st.p_yes), title_odds_delta: num(st.title_odds_delta),
        title_after: num(st.title_after) },
    },
  };
}

/**
 * plans: war-room-view.js#loadPlans's result. Returns
 * { follow_ledger: { state, reason? }, serve_log: { request_id | null, reason? } }.
 */
export function logWarRoomShown(res, lg, plans) {
  if (plans?.status !== 'ok') {
    const reason = plans?.reason ?? 'no plans file';
    return { follow_ledger: { state: 'not_logged', reason }, serve_log: { request_id: null, reason } };
  }
  const entry = leagueEntry(plans.entries, lg.id);
  if (!entry) {
    const reason = 'this league has no entry in the plans file';
    return { follow_ledger: { state: 'not_logged', reason }, serve_log: { request_id: null, reason } };
  }
  const nm = nextMoveOf(entry, lg);
  const follow = nm.move ? logNextMove(lg, nm.move) : { state: 'not_logged', reason: nm.reason };
  const requestId = entry.error ? null
    : recordServed(res, 'war_room', lg, { ...entry, plans_version: plans.id });
  return {
    follow_ledger: { state: follow.state, ...(follow.reason ? { reason: follow.reason } : {}) },
    serve_log: requestId ? { request_id: requestId } : { request_id: null, reason: entry.error ? 'the planner failed for this league' : 'nothing servable' },
  };
}
