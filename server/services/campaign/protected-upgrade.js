/**
 * PROTECTED-UPGRADE (Nick 2026-09-26, a hard-rule change he approved): Nico Collins (160) and Chase
 * Brown (80) are no longer untouchable outright. Each protected player has a per-league setting:
 *   'locked'           never given (the rule before this unit, exactly);
 *   'blue_chips_only'  given ONLY in a step that is a true tier up (the new default for 160 and 80).
 *
 * The setting is Nick's own tap, stored like AJ-PICK's picks: a War Room request `protect.mode
 * { player_id, mode }` (source 'nick' only; schema.js refuses it from Coach). Latest row per player
 * wins; a retracted row does not count. No row -> PROTECTED_DEFAULTS. A.J. Brown (277) keeps his own
 * AJ-PICK route (aj-pick.js) and is not settable here.
 *
 * THE RULE lives in never-give.js (the one rules module): a protected player in 'blue_chips_only' may
 * be given in a step only when
 *   (a) that step's gets hold a Blue chip (83+) whose Blue chip score AND FantasyCalc value are both
 *       HIGHER than the protected player's (tierUpGets below);
 *   (b) every other rule holds: 0 overpay per step at today's prices (a protected star is never depth,
 *       so the +12% depth-only 2-for-1 exception cannot apply), STEP-REGRET, the 83+ floor on every get
 *       and stepping stone, no buy-backs, never 290;
 *   (c) that step raises both Nick's playoff odds and his lineup points (upgradeRises below);
 * and every card that uses one is a "Needs your OK" card (AJ-PICK's pattern: never the next move until
 * Nick OKs that exact card with `aj.confirm`).
 *
 * This file holds the setting's reader and the two pure predicates; no rule decision lives here.
 */

/** The players this setting governs and their default mode (generic: add an id here to make it settable). */
export const PROTECTED_DEFAULTS = Object.freeze({ 160: 'blue_chips_only', 80: 'blue_chips_only' });
export const PROTECTED_IDS = Object.freeze(Object.keys(PROTECTED_DEFAULTS));
export const PROTECT_MODES = Object.freeze(['locked', 'blue_chips_only']);
/** The request kind Nick's setting is stored as (warroom_requests, source 'nick' only). */
export const PROTECT_KIND = 'protect.mode';
/** Kill switch for one release: GRIDIRON_PROTECTED_UPGRADE=0 locks every protected player (the old rule). */
export const PROTECTED_UPGRADE_ENV = 'GRIDIRON_PROTECTED_UPGRADE';
export const protectedUpgradeOn = (env = process.env) => env?.[PROTECTED_UPGRADE_ENV] !== '0';
/** The Blue chip score a tier-up get must reach (never-give.js / search.js BLUE_CHIP_SCORE; kept here to avoid an import cycle). */
export const TIER_UP_FLOOR = 83;
/** Nick's words for the modes (Settings and the card label). */
export const MODE_LABEL = Object.freeze({ locked: 'Locked', blue_chips_only: 'Blue chips only' });

const S = x => String(x);
const parse = text => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } };

/**
 * Pure fold over one league's warroom_requests rows (any order).
 * -> { modes: Map<id, mode> (every protected id, defaults filled), set: Set<id> (ids Nick set), ignored }
 */
export function foldProtect(list) {
  const sorted = [...(list ?? [])].sort((a, b) => a.id - b.id);
  const ignored = [];
  const payloads = new Map();
  for (const r of sorted) {
    if (r.kind !== 'retract' && r.kind !== PROTECT_KIND) continue;
    const p = parse(r.payload);
    if (!p.ok) { ignored.push({ id: r.id, why: 'payload does not parse' }); continue; }
    payloads.set(r.id, p.value);
  }
  const retracted = new Set(sorted.filter(r => r.kind === 'retract' && payloads.has(r.id)).map(r => Number(payloads.get(r.id)?.request_id)));
  const modes = new Map(PROTECTED_IDS.map(id => [id, PROTECTED_DEFAULTS[id]]));
  const set = new Set();
  for (const r of sorted) {
    if (r.kind !== PROTECT_KIND || !payloads.has(r.id)) continue;
    if (retracted.has(r.id)) { ignored.push({ id: r.id, why: 'retracted' }); continue; }
    if (r.source !== 'nick') { ignored.push({ id: r.id, why: 'only Nick may change a protected player' }); continue; }
    const p = payloads.get(r.id);
    const id = S(p.player_id);
    if (!PROTECTED_IDS.includes(id) || !PROTECT_MODES.includes(p.mode)) { ignored.push({ id: r.id, why: 'not a protected player or mode' }); continue; }
    modes.set(id, p.mode);
    set.add(id);
  }
  return { modes, set, ignored };
}

/**
 * One league's setting from the DB. db: { rows }. Kill switch or no warroom_requests table -> the
 * defaults (kill switch: every player locked). A read that throws propagates: callers fail closed.
 * -> { status, modes: Map<id, mode>, upgrade: Set<id> (ids in 'blue_chips_only'), set: Set<id> }
 */
export function protectState(db, leagueId, { env = process.env } = {}) {
  if (!protectedUpgradeOn(env)) {
    const modes = new Map(PROTECTED_IDS.map(id => [id, 'locked']));
    return { status: 'off', modes, upgrade: new Set(), set: new Set(), ignored: [] };
  }
  const has = db.rows(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'warroom_requests'`);
  const f = has.length
    ? foldProtect(db.rows(`SELECT id, kind, payload, source FROM warroom_requests
      WHERE league_id = ? AND kind IN (?, 'retract') ORDER BY id`, Number(leagueId), PROTECT_KIND))
    : foldProtect([]);
  return { status: has.length ? 'ok' : 'absent', modes: f.modes, set: f.set, ignored: f.ignored,
    upgrade: new Set([...f.modes].filter(([, m]) => m === 'blue_chips_only').map(([id]) => id)) };
}

/**
 * (a) The gets that make giving `id` a true tier up: a Blue chip (TIER_UP_FLOOR+) whose score AND
 * FantasyCalc value are both strictly higher than the protected player's. Any unread number -> none
 * (fail closed). scoreOf(id) -> number|null; fcOf(id) -> number|null.
 */
export function tierUpGets(id, gets, { scoreOf, fcOf, floor = TIER_UP_FLOOR }) {
  const ps = scoreOf(id), pv = fcOf(id);
  if (!Number.isFinite(ps) || !Number.isFinite(pv)) return [];
  return (gets ?? []).map(S).filter(g => {
    const s = scoreOf(g), v = fcOf(g);
    return Number.isFinite(s) && Number.isFinite(v) && s >= Math.max(floor, TIER_UP_FLOOR) && s > ps && v > pv;
  });
}

/**
 * (c) Whether a step raises both Nick's playoff odds and his lineup points: me / prev are the rescore's
 * `me` block after this step and after the step before (null for the first), as search.js#premiumHolds.
 */
export function upgradeRises(me, prev) {
  const pts = Number(me?.points_delta) - (prev ? Number(prev.points_delta) : 0);
  const po = Number(me?.playoff_delta) - (prev ? Number(prev.playoff_delta) : 0);
  if (!Number.isFinite(pts) || !Number.isFinite(po)) return { ok: false, why: 'unread' };
  if (!(pts > 0)) return { ok: false, why: 'lineup_points', points_delta: pts, playoff_delta: po };
  if (!(po > 0)) return { ok: false, why: 'playoff_odds', points_delta: pts, playoff_delta: po };
  return { ok: true, points_delta: pts, playoff_delta: po };
}

/** A served step's confirmed rise (step.protected_upgrade.confirmed, planner.js), or null. */
export function stepRises(step) {
  const pu = step?.protected_upgrade;
  // Served shape (view.js): a field { status: 'ok', value: { confirmed_lineup_points_delta, confirmed_playoff_odds_delta } }.
  if (pu?.status === 'ok' && pu.value && typeof pu.value === 'object') {
    const v = pu.value;
    return v.confirmed_lineup_points_delta != null && v.confirmed_playoff_odds_delta != null
      ? { points_delta: v.confirmed_lineup_points_delta, playoff_delta: v.confirmed_playoff_odds_delta } : null;
  }
  // Planner shape (planner.js): { confirmed: { points_delta, playoff_delta } } (null until the fresh dice agree).
  const c = pu?.confirmed;
  return c && typeof c === 'object' ? { points_delta: c.points_delta, playoff_delta: c.playoff_delta } : null;
}

/** The protected ids a step gives. */
export const protectedGiven = (step, ids = PROTECTED_IDS) => (step?.give ?? []).map(S).filter(id => ids.includes(id));
