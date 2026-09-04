/**
 * Honest "how much should you trust this specific number" signal for one
 * expert's contribution to one coordinated prediction, and for the
 * prediction as a whole.
 *
 * Ryan Brill (Wharton), Ron Yurko (CMU) & Abraham Wyner (Wharton):
 *   - "Exploring the Difficulty of Estimating Win Probability" (2024,
 *     arXiv:2406.16171) — play-by-play data's within-game correlation
 *     inflates effective-sample-size illusions; naive bootstrap confidence
 *     intervals over such data achieved only ~60% actual coverage against a
 *     90% nominal target.
 *   - "Analytics, Have Some Humility: A Statistical View of Fourth-Down
 *     Decision Making" (The American Statistician, 2025, arXiv:2311.03490)
 *     — only ~30% of real fourth-down decisions in their dataset warranted
 *     high confidence; the rest depended heavily on random training-data
 *     variation. Their thesis: report calibrated PER-DECISION confidence,
 *     and be honest when a decision doesn't deserve high confidence, rather
 *     than presenting every point estimate the same way.
 *
 * Both coordinators (nfl-expert-coordinator.js, fantasy-coordinator.js)
 * already compute exactly the two ingredients this thesis calls for, per
 * expert: `shrinkage[id].k` (how much walk-forward-validated signal that
 * expert's forecast actually earned — zero if it never showed a real,
 * split-half gain) and the number of INDEPENDENT weeks behind that
 * estimate (not raw game/player-row count — games within the same week
 * share correlated context, which is exactly the effective-sample-size
 * inflation the Brill/Yurko/Wyner papers warn about; both coordinators
 * already cluster-weight their ridge fit by 1/games-in-week for this same
 * reason). This module turns those two numbers into a simple, honest tier
 * rather than inventing a new uncertainty model.
 */
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const r3 = value => (value == null || !Number.isFinite(value) ? null : +value.toFixed(3));

// A season is ~18 weeks; requiring roughly a season-plus of independent,
// walk-forward-validated weekly evidence (20) to call an expert's own
// signal "fully trusted" is a deliberately conservative anchor — matching
// the papers' point that most real decisions don't clear a high bar.
const FULL_TRUST_WEEKS = 20;
const HIGH_SCORE = 0.4;
const MEDIUM_SCORE = 0.15;

/**
 * One expert's confidence tier: how much of its walk-forward shrinkage `k`
 * is backed by genuinely independent (week-level, not raw-row) evidence.
 *
 * `k === 0` (no walk-forward gain ever measured) is always 'low' — that
 * expert isn't contributing distinguishable signal regardless of sample
 * size, and a big sample cannot fix a coefficient that already shrank to
 * zero.
 */
export function expertConfidenceTier({ k, independentWeeks } = {}) {
  if (!Number.isFinite(k) || k <= 0) {
    return { tier: 'low', score: 0, independent_weeks: independentWeeks ?? 0,
      reason: 'no walk-forward gain: this expert has never earned a nonzero shrinkage weight' };
  }
  if (!Number.isFinite(independentWeeks) || independentWeeks < 1) {
    return { tier: 'low', score: 0, independent_weeks: 0,
      reason: 'no independent weeks of settled evidence behind this weight' };
  }
  const weekFactor = clamp(independentWeeks / FULL_TRUST_WEEKS, 0, 1);
  const score = clamp(k * weekFactor, 0, 1);
  const tier = score >= HIGH_SCORE ? 'high' : score >= MEDIUM_SCORE ? 'medium' : 'low';
  return { tier, score: r3(score), independent_weeks: independentWeeks, k: r3(k) };
}

/**
 * A prediction-level confidence tier: the weighted average of the ACTIVE
 * experts' own tiers (weighted by how much learned weight each one is
 * actually carrying in this specific prediction), not a flat average of
 * every registered expert regardless of whether it fired. An expert that is
 * missing this week, or that shrank to zero everywhere, does not get to
 * drag down (or prop up) a prediction it is not actually influencing.
 *
 * `contributions` is the array both coordinators already build per
 * prediction, each item carrying `raw`, `learned_weight` and a `confidence`
 * object from `expertConfidenceTier` (added by the coordinators below).
 */
export function predictionConfidence(contributions) {
  const active = (contributions ?? []).filter(c => Number.isFinite(c.raw) && c.confidence);
  const totalWeight = active.reduce((sum, c) => sum + Math.abs(c.learned_weight ?? 0), 0);
  if (!active.length || totalWeight <= 0) {
    return { tier: 'low', score: 0,
      reason: 'no active expert carries nonzero learned weight for this prediction' };
  }
  const score = active.reduce((sum, c) => sum + Math.abs(c.learned_weight ?? 0) * (c.confidence.score ?? 0), 0) / totalWeight;
  const tier = score >= HIGH_SCORE ? 'high' : score >= MEDIUM_SCORE ? 'medium' : 'low';
  return { tier, score: r3(score),
    note: 'Weighted by how much each active expert actually contributed to THIS prediction, not a ' +
      'flat average across every registered expert.' };
}

export const __test = { FULL_TRUST_WEEKS, HIGH_SCORE, MEDIUM_SCORE };
