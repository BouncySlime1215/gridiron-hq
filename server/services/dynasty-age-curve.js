/**
 * Dynasty age-curve value decay.
 *
 * FantasyCalc's dynasty values (`dynasty_values.value`, synced by
 * `syncDynastyValues` in server/routes/aggregates.js) are pure market
 * pass-through: real trades, no age adjustment of any kind. A 34-year-old
 * running back on a hot streak and a 24-year-old on an identical streak price
 * the same if the market hasn't caught up yet — which is exactly the gap a
 * dynasty manager pays for.
 *
 * This layers a position-specific, age-indexed decay multiplier ON TOP of the
 * FantasyCalc number. It does not replace or re-derive the market value; it
 * is an additional, separately-reported adjustment (see `dynastyAgeAdjustment`
 * below), so a consumer can always see both the raw market price and the
 * age-adjusted one side by side.
 *
 * Curve anchors are taken directly from 4for4's 2025 "Production Curves"
 * study (25 years of half-PPR data, players with >=2 top-12 (RB/WR) or
 * top-6 (TE) seasons), building on prior work by Ryan Heath and Fantasy
 * Points:
 *
 *   RB   peaks age 26, holds through 28, falls off 29-31.
 *   WR   prime at 25, peak 26-28, steep decline starts 32-33.
 *   TE   peaks 26, but holds ~89% of peak production even at 34 — a much
 *        flatter decline than RB/WR.
 *
 * The study gives shape and a small number of concrete data points, not a
 * full year-by-year table, so the anchors below reproduce those stated facts
 * exactly (peak plateau, the TE's 89%-at-34 anchor) and interpolate/extrapolate
 * linearly between and beyond them for the years the study describes only in
 * words ("falls off", "steep decline"). That is stated rather than hidden:
 * anything between the literal anchors is a linear reading of the study's
 * prose, not a further-fitted number.
 *
 * No published curve was given for QB, so QB (and every other position) gets
 * multiplier 1 — decay only applies where real data supports it.
 */
import { rows } from '../db/index.js';

// age -> multiplier, peak normalized to 1.0. Sorted ascending by age.
const AGE_CURVE_ANCHORS = {
  RB: [
    [22, 1.00], [26, 1.00], [28, 1.00],  // peaks 26, holds through 28
    [29, 0.90], [30, 0.78], [31, 0.65],  // falls off 29-31
    [33, 0.50], [36, 0.32]
  ],
  WR: [
    [22, 1.00], [25, 1.00], [28, 1.00],  // prime 25, peak 26-28
    [29, 0.95], [31, 0.85],
    [32, 0.75], [33, 0.65],              // steep decline starts 32-33
    [36, 0.42]
  ],
  TE: [
    [22, 1.00], [26, 1.00],              // peaks 26
    [29, 0.965], [30, 0.95], [32, 0.92],
    [34, 0.89],                          // ~89% of peak at 34, cited exactly
    [37, 0.83]
  ]
};

export const DYNASTY_AGE_CURVE_SOURCE =
  '4for4 (2025), "Production Curves" — 25 years of half-PPR data, players with ' +
  '>=2 top-12 (RB/WR) or top-6 (TE) seasons; building on Ryan Heath / Fantasy Points.';

const FLOOR = 0.25;

/** Linear interpolation across the anchor table; flat before the first anchor, extrapolated (floored) past the last. */
export function ageDecayMultiplier(position, age) {
  const anchors = AGE_CURVE_ANCHORS[position];
  if (!anchors || age == null || !Number.isFinite(age)) return 1;
  if (age <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [a0, v0] = anchors[i - 1], [a1, v1] = anchors[i];
    if (age <= a1) return +(v0 + (v1 - v0) * (age - a0) / (a1 - a0)).toFixed(4);
  }
  // Past the last anchor: continue the final segment's slope, floored.
  const [a0, v0] = anchors[anchors.length - 2], [a1, v1] = anchors[anchors.length - 1];
  const slope = (v1 - v0) / (a1 - a0);
  return Math.max(FLOOR, +(v1 + slope * (age - a1)).toFixed(4));
}

/** Exact age in years as of `asOf` (default: now) from an ISO birth_date string. */
export function ageFromBirthDate(birthDate, asOf = new Date()) {
  if (!birthDate) return null;
  const bd = new Date(birthDate);
  if (Number.isNaN(bd.getTime())) return null;
  let age = asOf.getFullYear() - bd.getFullYear();
  const hasHadBirthdayThisYear =
    asOf.getMonth() > bd.getMonth() ||
    (asOf.getMonth() === bd.getMonth() && asOf.getDate() >= bd.getDate());
  if (!hasHadBirthdayThisYear) age--;
  return age > 15 && age < 55 ? age : null;
}

let birthDateCache = null;
/** gsis_id -> birth_date, from the nflverse sync (already joined by players.gsis_id). */
function birthDatesByGsis() {
  if (birthDateCache) return birthDateCache;
  birthDateCache = new Map(rows(`SELECT gsis_id, birth_date FROM nflverse_player_positions
                                 WHERE birth_date IS NOT NULL`).map(r => [r.gsis_id, r.birth_date]));
  return birthDateCache;
}
export function clearAgeCurveCache() { birthDateCache = null; }

/**
 * Best available age for one player: exact birth-date-derived age when the
 * nflverse sync has it (precise to the day), falling back to the ESPN roster
 * snapshot integer age (`roster_players.age`, a July-2026 snapshot) when it
 * does not. Returns { age, source } so callers can show which was used
 * instead of presenting a snapshot estimate as if it were exact.
 */
export function playerRealAge(gsisId, rosterSnapshotAge = null, { asOf = new Date() } = {}) {
  const birthDate = gsisId ? birthDatesByGsis().get(gsisId) : null;
  const exact = ageFromBirthDate(birthDate, asOf);
  if (exact != null) return { age: exact, source: 'birth_date' };
  if (Number.isFinite(rosterSnapshotAge)) return { age: rosterSnapshotAge, source: 'roster_snapshot' };
  return { age: null, source: null };
}

/**
 * The full, inspectable adjustment for one player: raw FantasyCalc value,
 * the multiplier, and the age-adjusted value — never just the final number.
 * Returns null when there is no dynasty value or no age to adjust with,
 * rather than silently defaulting to an unadjusted or zeroed value.
 */
export function dynastyAgeAdjustment({ position, rawValue, gsisId, rosterSnapshotAge = null, asOf = new Date() } = {}) {
  if (rawValue == null) return null;
  const { age, source } = playerRealAge(gsisId, rosterSnapshotAge, { asOf });
  if (age == null) {
    return { raw_value: rawValue, age: null, age_source: null, multiplier: 1, adjusted_value: rawValue,
      curve: AGE_CURVE_ANCHORS[position] ? position : null };
  }
  const multiplier = ageDecayMultiplier(position, age);
  return {
    raw_value: rawValue,
    age,
    age_source: source,
    multiplier,
    adjusted_value: +(rawValue * multiplier).toFixed(1),
    curve: AGE_CURVE_ANCHORS[position] ? position : null,
    source: DYNASTY_AGE_CURVE_SOURCE
  };
}
