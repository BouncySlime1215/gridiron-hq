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
 * The fix here is a return-to-play curve, P(active in week t+h | tier, gap bucket at t),
 * fitted on history by scripts/fit-availability-return.mjs, used for h >= 1 where h is
 * the number of NFL weeks between the target week and the first week with no games on
 * file (the live anchor). A replay of a past week has h = 0 and is unchanged.
 *
 * Flag: GRIDIRON_AVAIL_HORIZON '1' on, '0' off, unset = off unless preview mode
 * (preview-mode.js#previewUnconfirmed). Off, weeklyAvailability is byte-for-byte what it
 * was.
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
 * The fitted curve the app serves. Written by scripts/fit-availability-return.mjs
 * (--emit), fit seasons 2021-2024 after the pre-registered 2024 grade passed; 2025 is
 * never read. Empty = the curve is not fitted, and weeklyAvailability keeps the frozen
 * one-week rate even with the flag on.
 */
export const RETURN_CURVE_FIT = Object.freeze({ fitSeasons: [], k: 20, rows: [] });

let _served = null;
/** The lookup over RETURN_CURVE_FIT, built once. */
export function servedReturnCurve() {
  _served ??= buildReturnLookup(RETURN_CURVE_FIT.rows);
  return _served;
}
