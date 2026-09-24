/**
 * REACH-01: which targets Nick can reach at all, and why every scored path died (pure).
 *
 * Reach. A step reads fair on his screen only when Nick's side sums into the target's fairBand
 * (paths.js), and it never overpays past the cap (search.js). So a target is out of reach when
 * even the most valuable package the search could hand over sits under fairBand(value).lo. That
 * package is bounded over every shape the search builds (search.js#searchTarget):
 *   direct   up to maxGiveDirect of Nick's pieces (the direct finish allows 3);
 *   chain    a chip step (1 or 2 of Nick's for one real outside piece, fair and in cap), then an
 *            optional second chip (1 for 1), then a finish of up to maxGiveChain.
 * The chip piece is the most valuable real outside player that chip could read fair for, which
 * only overstates what a chain can reach: the bound can keep a hopeless target, never skip a
 * findable one.
 *
 * dropped_by_reason. Per risk mode, the paths each gate removed (modes.js codes), the all-in
 * p_complete floor, and for the objective mode the deck cards the fresh-dice confirm dropped;
 * plus the search-level counts (steps the no-overpay cap turned away, targets skipped as out of
 * reach). Counts of numbers the planner already computes; nothing is priced here.
 *
 * Flag GRIDIRON_REACH: '1' on; anything else (unset included) off. The preview switch does NOT turn
 * it on: it stays off until the league-4 measurement passes (the project's "nothing unproven moves a
 * number Nick sees"). On, the planner filters targets on reach, the chained finish and flipReach
 * package up to the mode's max give, and the loop searches REACH_TARGETS targets.
 */
import { fairBand, SCREEN_WINDOW } from './paths.js';
import { TOLERANCE_CODES, MODES } from './modes.js';

export const REACH_ENV = 'GRIDIRON_REACH';
/** Targets the loop searches with the flag on (ONE-PLAN night 1: 8, up from 3). */
export const REACH_TARGETS = 8;
const EPS = 1e-9;

/** 'on' only when GRIDIRON_REACH=1; unset, 0 or anything else is 'off' (preview does not turn it on). */
export function reachFlag(env = process.env) {
  return env?.[REACH_ENV] === '1' ? 'on' : 'off';
}

const topSum = (vals, k) => [...vals].sort((a, b) => b - a).slice(0, k).reduce((s, v) => s + v, 0);

/** The most valuable value in the ascending list `sorted` inside [lo, hi], or null. */
function maxIn(sorted, lo, hi) {
  let a = 0, b = sorted.length;
  while (a < b) { const m = (a + b) >> 1; if (sorted[m] <= hi + EPS) a = m + 1; else b = m; }
  const v = a > 0 ? sorted[a - 1] : null;
  return v != null && v >= lo - EPS ? v : null;
}

/**
 * The best package value Nick could hand over, by shape.
 * mine: Nick's tradable values; outside: every tradable value on the other (non-excluded) rosters.
 * Returns { direct: { 1: v, 2: v, ... }, chain: v | null, best }.
 */
export function reachBound({ mine, outside, maxGiveDirect = 3, maxGiveChain = 2, maxOverpay = 0, window = SCREEN_WINDOW }) {
  const own = mine.filter(v => v > 0);
  const out = outside.filter(v => v > 0).sort((a, b) => a - b);
  const direct = {};
  for (let k = 1; k <= maxGiveDirect; k++) direct[k] = topSum(own, k);
  // A chip for give sum s gets x with s inside fairBand(x) and s <= x (1 + cap).
  const chipGet = s => {
    const floor = Number.isFinite(maxOverpay) ? s / (1 + maxOverpay) : 0;
    return maxIn(out, Math.max(s / (1 + window.high / 100), floor), s / (1 + window.low / 100));
  };
  const gives = [];
  for (let i = 0; i < own.length; i++) {
    gives.push([i]);
    for (let j = i + 1; j < own.length; j++) gives.push([i, j]);
  }
  let chain = null;
  for (const g of gives) {
    const x = chipGet(g.reduce((s, i) => s + own[i], 0));
    if (x == null) continue;
    const r1 = [...own.filter((_, i) => !g.includes(i)), x];
    chain = Math.max(chain ?? 0, topSum(r1, maxGiveChain));
    for (let y = 0; y < r1.length; y++) {
      const z = chipGet(r1[y]);
      if (z == null || z <= r1[y]) continue;
      chain = Math.max(chain, topSum([...r1.slice(0, y), ...r1.slice(y + 1), z], maxGiveChain));
    }
  }
  const best = Math.max(...Object.values(direct), chain ?? 0);
  return { direct, chain, best };
}

/** One target against the bound: what it needs on his screen, the smallest direct give that gets there. */
export function targetReach(value, bound) {
  const band = fairBand(value);
  if (!band) return { need: null, reach: bound.best, in_reach: false, min_gives: null };
  const need = band.lo;
  const k = Object.keys(bound.direct).map(Number).sort((a, b) => a - b).find(n => bound.direct[n] + EPS >= need) ?? null;
  const viaChain = bound.chain != null && bound.chain + EPS >= need;
  return { need, reach: bound.best, in_reach: k != null || viaChain, min_gives: k ?? (viaChain ? 'chain' : null) };
}

/**
 * dropped_by_reason. byMode: { mode: rankPlans result } over the same candidates; confirm:
 * { checked, failed } for the objective mode (null when the confirm world failed).
 */
export function droppedByReason({ candidates, byMode, objectiveMode, confirm = null, noOverpay = 0, outOfReach = 0 }) {
  const modes = {};
  for (const m of MODES) {
    const r = byMode[m];
    const tolerance = Object.fromEntries(TOLERANCE_CODES.map(c => [c, 0]));
    let floor = 0;
    for (const d of r?.dropped ?? []) {
      if (d.code === 'p_complete_floor') floor++;
      else tolerance[d.code] = (tolerance[d.code] ?? 0) + 1;
    }
    modes[m] = { kept: r?.ranked.length ?? 0, tolerance, p_complete_floor: floor, confirm: m === objectiveMode ? confirm : null };
  }
  return { candidates, search: { no_overpay: noOverpay, out_of_reach: outOfReach }, modes };
}

/** One line for the producer's log: kept / dropped per mode, by the biggest gates. */
export function droppedLine(d) {
  if (!d) return 'dropped_by_reason none';
  const mode = m => {
    const r = d.modes[m];
    const gates = Object.entries({ ...r.tolerance, p_complete_floor: r.p_complete_floor }).filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
    return `${m} kept ${r.kept}${gates ? ` (dropped: ${gates})` : ''}${r.confirm ? `, confirm failed ${r.confirm.failed}/${r.confirm.checked}` : ''}`;
  };
  return `dropped_by_reason: ${d.candidates} paths; overpay-capped steps ${d.search.no_overpay}; out-of-reach targets ${d.search.out_of_reach}; ${MODES.map(mode).join('; ')}`;
}
