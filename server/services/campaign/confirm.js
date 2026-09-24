/**
 * North-star row 17: confirm the chosen plan on fresh dice (pure).
 *
 * The plan is CHOSEN on one seed and its numbers are the best of many noisy
 * estimates, so they are biased upward (the winner's curse, IDEA-002). The
 * producer re-prices the chosen plan and the deck on an independent seed and
 * shows THOSE numbers. The confirm seed is derived from the planning seed and
 * is never equal to it.
 */
import { pathExpectation } from './paths.js';

/** FNV-1a over the parts; the same shape as stats-util.js#keyedSeed (kept local: pure module). */
export function hash(...parts) {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= 0x1f; h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}

/** An independent seed for the confirm pass; guaranteed different from `planSeed`. */
export function confirmSeed(planSeed, leagueId, fetchedAt = '') {
  const s = hash('campaign-confirm', leagueId, fetchedAt, planSeed);
  return s === (Number(planSeed) >>> 0) ? ((s + 1) >>> 0) || 1 : s;
}

/**
 * Verdict on the re-priced plan. original / confirmed: pathExpectation results (confirmed built
 * from the fresh-dice deltas with the same P(accept)s).
 *   holds   confirmed expected > 0 and within 2 SE of the original
 *   shrank  still > 0 but more than 2 SE below the original (the curse, measured)
 *   failed  <= 0 on fresh dice: the plan is not shown as the next move
 */
export function confirmVerdict(original, confirmed) {
  const se = Math.hypot(original.expected_se ?? 0, confirmed.expected_se ?? 0);
  const drop = original.expected - confirmed.expected;
  const verdict = confirmed.expected <= 0 ? 'failed' : drop > 2 * se ? 'shrank' : 'holds';
  return { verdict, original_expected: original.expected, confirmed_expected: confirmed.expected,
    shrink: drop, se };
}

/** Re-price a plan's steps with fresh-dice deltas: freshSteps[i] = { delta, se, clears }. */
export function repricePlan(plan, freshSteps) {
  const steps = plan.steps.map((s, i) => ({ ...s, delta: freshSteps[i].delta, se: freshSteps[i].se, clears: freshSteps[i].clears }));
  return { ...plan, steps, ...pathExpectation(steps) };
}
