/**
 * AJ-PICK (Nick 2026-09-25): A.J. Brown (277) may be traded only for a player Nick himself picked.
 *
 * The automated "consistent Blue chip" reader failed its prereg (#483), so the route is manual:
 *   - `aj.allow { player_id }` / `aj.revoke { player_id }` (War Room requests, source 'nick' only)
 *     keep a per-league list of the players Nick would take for 277;
 *   - never-give.js#ajMayMove lets a step give 277 only when its gets hold a player on that list who
 *     is a Blue chip (83+) at serve time; every other rule is unchanged;
 *   - every card that gives 277 carries requires_nick_confirm and is never the Next move hero until
 *     Nick taps OK on that exact card (`aj.confirm { move_id }`, source 'nick' only).
 *
 * This file is the one reader of those rows (the planner via the producer, the rule gate and the
 * route all fold them here). Pure fold + one DB read; no rule lives here (never-give.js holds them).
 */

/** A.J. Brown's id (never-give.js pins it). */
export const AJ_ID = '277';
/** Request kinds only Nick may write (schema.js refuses them from Coach, confirmed or not). */
export const AJ_KINDS = Object.freeze(['aj.allow', 'aj.revoke', 'aj.confirm']);
/** How many "Needs your OK" cards a league run shows beside the deck. */
export const AJ_CARDS_MAX = 2;
/** Kill switch for one release: GRIDIRON_AJ_PICK=0 turns the manual route off (277 locked, as before). */
export const AJ_PICK_ENV = 'GRIDIRON_AJ_PICK';

export const ajPickOn = (env = process.env) => env?.[AJ_PICK_ENV] !== '0';

const S = x => String(x);
const parse = text => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } };

/**
 * Pure fold over one league's warroom_requests rows (any order).
 * -> { allow: Set<id>, confirmed: Set<move_id>, ignored: [{ id, why }] }
 * Latest allow / revoke per player wins; a retracted row does not count; a Coach row never counts
 * (the route refuses them; a row written around it is still not followed).
 */
export function foldAj(list) {
  const sorted = [...(list ?? [])].sort((a, b) => a.id - b.id);
  const ignored = [];
  const payloads = new Map();
  for (const r of sorted) {
    if (r.kind !== 'retract' && !AJ_KINDS.includes(r.kind)) continue;
    const p = parse(r.payload);
    if (!p.ok) { ignored.push({ id: r.id, why: 'payload does not parse' }); continue; }
    payloads.set(r.id, p.value);
  }
  const retracted = new Set(sorted.filter(r => r.kind === 'retract' && payloads.has(r.id))
    .map(r => Number(payloads.get(r.id)?.request_id)));
  const allow = new Set();
  const confirmed = new Set();
  for (const r of sorted) {
    if (!AJ_KINDS.includes(r.kind) || !payloads.has(r.id)) continue;
    if (retracted.has(r.id)) { ignored.push({ id: r.id, why: 'retracted' }); continue; }
    if (r.source !== 'nick') { ignored.push({ id: r.id, why: 'only Nick may pick or confirm A.J. Brown trades' }); continue; }
    const p = payloads.get(r.id);
    if (r.kind === 'aj.confirm') { if (p.move_id != null) confirmed.add(S(p.move_id)); continue; }
    if (p.player_id == null || S(p.player_id) === AJ_ID) { ignored.push({ id: r.id, why: 'no player' }); continue; }
    if (r.kind === 'aj.allow') allow.add(S(p.player_id));
    else allow.delete(S(p.player_id));
  }
  return { allow, confirmed, ignored };
}

/**
 * One league's AJ-PICK state from the DB. db: { rows } (server/db/index.js or a test double).
 * No warroom_requests table -> empty (277 stays locked). A read that throws propagates: callers
 * fail closed on it (never-give.js#ruleGate marks the gate closed).
 */
export function ajState(db, leagueId) {
  const has = db.rows(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'warroom_requests'`);
  if (!has.length) return { status: 'absent', allow: new Set(), confirmed: new Set(), ignored: [] };
  const list = db.rows(`SELECT id, kind, payload, source, confirmed FROM warroom_requests
    WHERE league_id = ? AND kind IN ('aj.allow', 'aj.revoke', 'aj.confirm', 'retract') ORDER BY id`, Number(leagueId));
  return { status: 'ok', ...foldAj(list) };
}

/** Whether a step gives A.J. Brown. */
export const givesAj = step => (step?.give ?? []).some(id => S(id) === AJ_ID);
