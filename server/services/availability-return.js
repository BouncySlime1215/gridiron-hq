/**
 * AVAIL-HORIZON: chance to play MORE than one week ahead (return to play).
 *
 * contingency.js#weeklyAvailability prices a player from his role state: snap-share tier
 * and how many of his team's games he has missed since he last appeared (gap). That fit
 * (scripts/fit-availability.mjs) is a ONE-week-ahead model: state from games before week
 * t, outcome in week t. The season sim asks it for every remaining week, and for a future
 * week roleStates(season, week) still only sees the games already played, so the gap is
 * frozen at today's value: a starter who missed last week's game is priced "probably
 * still out" (0.40) for weeks 4-17 alike (TITLE-ZERO, BROKEN-NUMBERS row S).
 *
 * The fix studied here is a return-to-play curve, P(active in week t+h | tier, gap bucket
 * at t), fitted on history by scripts/fit-availability-return.mjs, for h >= 1 where h is
 * the number of NFL weeks between the target week and the first week with no games on
 * file (the live anchor). A replay of a past week has h = 0 and would be unchanged.
 *
 * STUDY ONLY (AVAIL-HORIZON declined, 2026-09-24): the curve beat the frozen gap on 2024
 * (pre-registered), but wired alone into weeklyAvailability it moved Nick's league-4 odds
 * to 11.3% / 0.50%, just under the ESPN-baseline range the unit had to reach, and the
 * other half of the fix (team-mean uncertainty) lives in season-sim.js. Nothing imports
 * this module yet. The flag below is the one a wiring would read:
 * GRIDIRON_AVAIL_HORIZON '1' on, '0' off, unset = off unless preview mode
 * (preview-mode.js#previewUnconfirmed).
 */
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const AVAIL_HORIZON_ENV = 'GRIDIRON_AVAIL_HORIZON';
export const AVAIL_HORIZON_PREVIEW_REASON =
  'Chance to play beyond next week from a fitted return-to-play curve (AVAIL-HORIZON); default off ' +
  'until confirmed on 2026 weeks';

/** { on, preview }: read per call, so a test or a run can flip it. */
export function availHorizonFlag() {
  const v = process.env[AVAIL_HORIZON_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

/** The label a response carries when the curve is on only because of preview mode. */
export const availHorizonPreviewFields = flag => (flag.preview ? previewFields(AVAIL_HORIZON_PREVIEW_REASON) : {});

/** Horizon buckets: the curve is flat enough past a month that weeks are pooled. */
export function horizonBucket(h) {
  if (!Number.isInteger(h) || h < 1) return null;
  if (h <= 4) return `h${h}`;
  if (h <= 6) return 'h5-6';
  if (h <= 9) return 'h7-9';
  return 'h10+';
}

/**
 * Hierarchical beta-binomial shrinkage, parent -> child: h -> h|gap -> h|gap|tier.
 * p_child = (hits + k * p_parent) / (n + k); the root is its raw rate.
 *
 * @param observations [{ h (weeks ahead, >= 1), gap ('g0'|'g1'|'g2'), tier, active (0|1) }]
 * @returns [{ h, gap, tier, p_active, n, raw_rate }] with '*' for a pooled level
 */
export function fitReturnCurve(observations, { k = 20 } = {}) {
  const nodes = new Map();
  for (const o of observations) {
    const hb = horizonBucket(o.h);
    if (!hb || !o.gap) continue;
    let parent = null;
    for (const parts of [[hb, '*', '*'], [hb, o.gap, '*'], [hb, o.gap, o.tier ?? 'unknown']]) {
      const key = parts.join('|');
      const node = nodes.get(key) ?? nodes.set(key, { parts, n: 0, hits: 0, parent }).get(key);
      node.n++; node.hits += o.active ? 1 : 0;
      parent = key;
    }
  }
  // A parent is always inserted before its first child, so insertion order is top-down.
  const p = new Map();
  for (const [key, node] of nodes) {
    p.set(key, node.parent == null ? node.hits / node.n : (node.hits + k * p.get(node.parent)) / (node.n + k));
  }
  return [...nodes].map(([key, node]) => ({
    h: node.parts[0], gap: node.parts[1], tier: node.parts[2],
    p_active: +p.get(key).toFixed(4), n: node.n, raw_rate: +(node.hits / node.n).toFixed(4)
  }));
}

/** Lookup over fitted rows: deepest fitted cell of (h, gap, tier), or null. Pure. */
export function buildReturnLookup(rows = []) {
  const cells = new Map(rows.map(r => [`${r.h}|${r.gap}|${r.tier}`, r]));
  return {
    size: cells.size,
    lookup({ h, gap, tier }) {
      const hb = horizonBucket(h);
      if (!hb || !gap) return null;
      for (const key of [`${hb}|${gap}|${tier ?? 'unknown'}`, `${hb}|${gap}|*`, `${hb}|*|*`]) {
        const r = cells.get(key);
        if (r) return { p: r.p_active, n: r.n, basis: key.split('|').filter(x => x !== '*').join('/') };
      }
      return null;
    }
  };
}

/**
 * The fitted curve, as printed by scripts/fit-availability-return.mjs --emit: fit
 * seasons 2021-2024, emitted after the pre-registered 2024 grade passed; 2025 is never
 * read.
 */
export const RETURN_CURVE_FIT = Object.freeze({
  fitSeasons: [2021, 2022, 2023, 2024], k: 20,
  // Graded before emission (pre-registered; fit 2021-2023, graded 2024, 72,882 rows, 679 players):
  // log loss 0.6616 (frozen gap) -> 0.5925, player-clustered 90% CI of the change
  // [-0.0847, -0.0538]; ECE 0.121 -> 0.010.
  rows: Object.freeze([
    { h: 'h1', gap: '*', tier: '*', p_active: 0.6461, n: 31198 },
    { h: 'h1', gap: 'g0', tier: '*', p_active: 0.7475, n: 24388 },
    { h: 'h1', gap: 'g0', tier: 'starter', p_active: 0.8768, n: 9107 },
    { h: 'h2', gap: '*', tier: '*', p_active: 0.6375, n: 29207 },
    { h: 'h2', gap: 'g0', tier: '*', p_active: 0.7269, n: 22816 },
    { h: 'h2', gap: 'g0', tier: 'starter', p_active: 0.8513, n: 8530 },
    { h: 'h3', gap: '*', tier: '*', p_active: 0.629, n: 27220 },
    { h: 'h3', gap: 'g0', tier: '*', p_active: 0.7112, n: 21262 },
    { h: 'h3', gap: 'g0', tier: 'starter', p_active: 0.8325, n: 7938 },
    { h: 'h4', gap: '*', tier: '*', p_active: 0.6213, n: 25279 },
    { h: 'h4', gap: 'g0', tier: '*', p_active: 0.6999, n: 19684 },
    { h: 'h4', gap: 'g0', tier: 'starter', p_active: 0.8161, n: 7366 },
    { h: 'h5-6', gap: '*', tier: '*', p_active: 0.6125, n: 45239 },
    { h: 'h5-6', gap: 'g0', tier: '*', p_active: 0.6872, n: 35173 },
    { h: 'h5-6', gap: 'g0', tier: 'starter', p_active: 0.8028, n: 13123 },
    { h: 'h7-9', gap: '*', tier: '*', p_active: 0.5995, n: 54351 },
    { h: 'h7-9', gap: 'g0', tier: '*', p_active: 0.6718, n: 42198 },
    { h: 'h7-9', gap: 'g0', tier: 'starter', p_active: 0.7869, n: 15797 },
    { h: 'h10+', gap: '*', tier: '*', p_active: 0.5609, n: 66276 },
    { h: 'h10+', gap: 'g0', tier: '*', p_active: 0.6387, n: 50282 },
    { h: 'h10+', gap: 'g0', tier: 'starter', p_active: 0.7407, n: 18962 },
    { h: 'h1', gap: 'g0', tier: 'depth', p_active: 0.6446, n: 5039 },
    { h: 'h2', gap: 'g0', tier: 'depth', p_active: 0.6207, n: 4700 },
    { h: 'h3', gap: 'g0', tier: 'depth', p_active: 0.6036, n: 4372 },
    { h: 'h4', gap: 'g0', tier: 'depth', p_active: 0.5952, n: 4076 },
    { h: 'h5-6', gap: 'g0', tier: 'depth', p_active: 0.5855, n: 7288 },
    { h: 'h7-9', gap: 'g0', tier: 'depth', p_active: 0.5766, n: 8651 },
    { h: 'h10+', gap: 'g0', tier: 'depth', p_active: 0.549, n: 10303 },
    { h: 'h1', gap: 'g0', tier: 'rotation', p_active: 0.768, n: 5528 },
    { h: 'h2', gap: 'g0', tier: 'rotation', p_active: 0.7506, n: 5187 },
    { h: 'h3', gap: 'g0', tier: 'rotation', p_active: 0.7364, n: 4862 },
    { h: 'h4', gap: 'g0', tier: 'rotation', p_active: 0.7258, n: 4521 },
    { h: 'h5-6', gap: 'g0', tier: 'rotation', p_active: 0.7124, n: 8141 },
    { h: 'h7-9', gap: 'g0', tier: 'rotation', p_active: 0.6856, n: 9776 },
    { h: 'h10+', gap: 'g0', tier: 'rotation', p_active: 0.642, n: 11837 },
    { h: 'h1', gap: 'g0', tier: 'unknown', p_active: 0.6806, n: 1317 },
    { h: 'h2', gap: 'g0', tier: 'unknown', p_active: 0.6569, n: 1223 },
    { h: 'h3', gap: 'g0', tier: 'unknown', p_active: 0.6442, n: 1143 },
    { h: 'h4', gap: 'g0', tier: 'unknown', p_active: 0.6421, n: 1039 },
    { h: 'h5-6', gap: 'g0', tier: 'unknown', p_active: 0.6095, n: 1855 },
    { h: 'h7-9', gap: 'g0', tier: 'unknown', p_active: 0.597, n: 2334 },
    { h: 'h10+', gap: 'g0', tier: 'unknown', p_active: 0.6157, n: 2877 },
    { h: 'h1', gap: 'g0', tier: 'fringe', p_active: 0.5478, n: 3397 },
    { h: 'h2', gap: 'g0', tier: 'fringe', p_active: 0.5399, n: 3176 },
    { h: 'h3', gap: 'g0', tier: 'fringe', p_active: 0.5306, n: 2947 },
    { h: 'h4', gap: 'g0', tier: 'fringe', p_active: 0.5207, n: 2682 },
    { h: 'h5-6', gap: 'g0', tier: 'fringe', p_active: 0.5127, n: 4766 },
    { h: 'h7-9', gap: 'g0', tier: 'fringe', p_active: 0.5033, n: 5640 },
    { h: 'h10+', gap: 'g0', tier: 'fringe', p_active: 0.4836, n: 6303 },
    { h: 'h1', gap: 'g1', tier: '*', p_active: 0.3475, n: 3174 },
    { h: 'h1', gap: 'g1', tier: 'depth', p_active: 0.2572, n: 769 },
    { h: 'h2', gap: 'g1', tier: '*', p_active: 0.3739, n: 2959 },
    { h: 'h2', gap: 'g1', tier: 'depth', p_active: 0.286, n: 716 },
    { h: 'h3', gap: 'g1', tier: '*', p_active: 0.3919, n: 2722 },
    { h: 'h3', gap: 'g1', tier: 'depth', p_active: 0.3195, n: 665 },
    { h: 'h4', gap: 'g1', tier: '*', p_active: 0.406, n: 2565 },
    { h: 'h4', gap: 'g1', tier: 'depth', p_active: 0.3237, n: 626 },
    { h: 'h5-6', gap: 'g1', tier: '*', p_active: 0.4108, n: 4603 },
    { h: 'h5-6', gap: 'g1', tier: 'depth', p_active: 0.3431, n: 1123 },
    { h: 'h7-9', gap: 'g1', tier: '*', p_active: 0.4037, n: 5553 },
    { h: 'h7-9', gap: 'g1', tier: 'depth', p_active: 0.3117, n: 1347 },
    { h: 'h10+', gap: 'g1', tier: '*', p_active: 0.378, n: 7420 },
    { h: 'h10+', gap: 'g1', tier: 'depth', p_active: 0.2954, n: 1874 },
    { h: 'h1', gap: 'g1', tier: 'fringe', p_active: 0.2753, n: 859 },
    { h: 'h2', gap: 'g1', tier: 'fringe', p_active: 0.2832, n: 801 },
    { h: 'h3', gap: 'g1', tier: 'fringe', p_active: 0.2838, n: 723 },
    { h: 'h4', gap: 'g1', tier: 'fringe', p_active: 0.3293, n: 691 },
    { h: 'h5-6', gap: 'g1', tier: 'fringe', p_active: 0.3075, n: 1210 },
    { h: 'h7-9', gap: 'g1', tier: 'fringe', p_active: 0.3026, n: 1398 },
    { h: 'h10+', gap: 'g1', tier: 'fringe', p_active: 0.2847, n: 1819 },
    { h: 'h1', gap: 'g1', tier: 'rotation', p_active: 0.3782, n: 588 },
    { h: 'h2', gap: 'g1', tier: 'rotation', p_active: 0.4205, n: 559 },
    { h: 'h3', gap: 'g1', tier: 'rotation', p_active: 0.4373, n: 517 },
    { h: 'h4', gap: 'g1', tier: 'rotation', p_active: 0.4647, n: 486 },
    { h: 'h5-6', gap: 'g1', tier: 'rotation', p_active: 0.4638, n: 871 },
    { h: 'h7-9', gap: 'g1', tier: 'rotation', p_active: 0.4379, n: 1074 },
    { h: 'h10+', gap: 'g1', tier: 'rotation', p_active: 0.3654, n: 1402 },
    { h: 'h1', gap: 'g1', tier: 'unknown', p_active: 0.4554, n: 362 },
    { h: 'h2', gap: 'g1', tier: 'unknown', p_active: 0.4904, n: 348 },
    { h: 'h3', gap: 'g1', tier: 'unknown', p_active: 0.4784, n: 312 },
    { h: 'h5-6', gap: 'g1', tier: 'unknown', p_active: 0.4667, n: 559 },
    { h: 'h7-9', gap: 'g1', tier: 'unknown', p_active: 0.4751, n: 679 },
    { h: 'h10+', gap: 'g1', tier: 'unknown', p_active: 0.4779, n: 814 },
    { h: 'h4', gap: 'g1', tier: 'unknown', p_active: 0.4504, n: 300 },
    { h: 'h1', gap: 'g1', tier: 'starter', p_active: 0.4593, n: 596 },
    { h: 'h2', gap: 'g1', tier: 'starter', p_active: 0.4891, n: 535 },
    { h: 'h3', gap: 'g1', tier: 'starter', p_active: 0.5292, n: 505 },
    { h: 'h5-6', gap: 'g1', tier: 'starter', p_active: 0.5514, n: 840 },
    { h: 'h7-9', gap: 'g1', tier: 'starter', p_active: 0.5694, n: 1055 },
    { h: 'h10+', gap: 'g1', tier: 'starter', p_active: 0.5471, n: 1511 },
    { h: 'h4', gap: 'g1', tier: 'starter', p_active: 0.5293, n: 462 },
    { h: 'h1', gap: 'g2', tier: '*', p_active: 0.2303, n: 3636 },
    { h: 'h1', gap: 'g2', tier: 'depth', p_active: 0.1722, n: 971 },
    { h: 'h2', gap: 'g2', tier: '*', p_active: 0.274, n: 3432 },
    { h: 'h2', gap: 'g2', tier: 'depth', p_active: 0.2118, n: 922 },
    { h: 'h3', gap: 'g2', tier: '*', p_active: 0.291, n: 3236 },
    { h: 'h3', gap: 'g2', tier: 'depth', p_active: 0.2442, n: 880 },
    { h: 'h4', gap: 'g2', tier: '*', p_active: 0.2962, n: 3030 },
    { h: 'h4', gap: 'g2', tier: 'depth', p_active: 0.2493, n: 822 },
    { h: 'h5-6', gap: 'g2', tier: '*', p_active: 0.303, n: 5463 },
    { h: 'h5-6', gap: 'g2', tier: 'depth', p_active: 0.2287, n: 1458 },
    { h: 'h7-9', gap: 'g2', tier: '*', p_active: 0.3032, n: 6600 },
    { h: 'h7-9', gap: 'g2', tier: 'depth', p_active: 0.2401, n: 1800 },
    { h: 'h10+', gap: 'g2', tier: '*', p_active: 0.264, n: 8574 },
    { h: 'h10+', gap: 'g2', tier: 'depth', p_active: 0.2095, n: 2430 },
    { h: 'h1', gap: 'g2', tier: 'fringe', p_active: 0.1652, n: 1019 },
    { h: 'h3', gap: 'g2', tier: 'fringe', p_active: 0.2099, n: 894 },
    { h: 'h4', gap: 'g2', tier: 'fringe', p_active: 0.1985, n: 826 },
    { h: 'h5-6', gap: 'g2', tier: 'fringe', p_active: 0.2086, n: 1471 },
    { h: 'h7-9', gap: 'g2', tier: 'fringe', p_active: 0.2035, n: 1774 },
    { h: 'h10+', gap: 'g2', tier: 'fringe', p_active: 0.1793, n: 2302 },
    { h: 'h2', gap: 'g2', tier: 'fringe', p_active: 0.2025, n: 955 },
    { h: 'h1', gap: 'g2', tier: 'rotation', p_active: 0.2756, n: 697 },
    { h: 'h2', gap: 'g2', tier: 'rotation', p_active: 0.3335, n: 659 },
    { h: 'h3', gap: 'g2', tier: 'rotation', p_active: 0.3315, n: 619 },
    { h: 'h4', gap: 'g2', tier: 'rotation', p_active: 0.3539, n: 593 },
    { h: 'h5-6', gap: 'g2', tier: 'rotation', p_active: 0.3603, n: 1096 },
    { h: 'h7-9', gap: 'g2', tier: 'rotation', p_active: 0.3565, n: 1352 },
    { h: 'h10+', gap: 'g2', tier: 'rotation', p_active: 0.2968, n: 1726 },
    { h: 'h1', gap: 'g2', tier: 'starter', p_active: 0.3147, n: 627 },
    { h: 'h2', gap: 'g2', tier: 'starter', p_active: 0.3748, n: 595 },
    { h: 'h4', gap: 'g2', tier: 'starter', p_active: 0.4287, n: 514 },
    { h: 'h5-6', gap: 'g2', tier: 'starter', p_active: 0.445, n: 942 },
    { h: 'h7-9', gap: 'g2', tier: 'starter', p_active: 0.4721, n: 1105 },
    { h: 'h10+', gap: 'g2', tier: 'starter', p_active: 0.4199, n: 1512 },
    { h: 'h1', gap: 'g2', tier: 'unknown', p_active: 0.3176, n: 322 },
    { h: 'h2', gap: 'g2', tier: 'unknown', p_active: 0.3317, n: 301 },
    { h: 'h3', gap: 'g2', tier: 'unknown', p_active: 0.3306, n: 291 },
    { h: 'h4', gap: 'g2', tier: 'unknown', p_active: 0.3286, n: 275 },
    { h: 'h5-6', gap: 'g2', tier: 'unknown', p_active: 0.3877, n: 496 },
    { h: 'h7-9', gap: 'g2', tier: 'unknown', p_active: 0.3448, n: 569 },
    { h: 'h10+', gap: 'g2', tier: 'unknown', p_active: 0.3097, n: 604 },
    { h: 'h3', gap: 'g2', tier: 'starter', p_active: 0.4158, n: 552 }
  ])
});

let _served = null;
/** The lookup over RETURN_CURVE_FIT, built once. */
export function servedReturnCurve() {
  _served ??= buildReturnLookup(RETURN_CURVE_FIT.rows);
  return _served;
}
