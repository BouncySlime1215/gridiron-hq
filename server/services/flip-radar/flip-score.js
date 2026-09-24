/**
 * FLIP-01: the pure arithmetic of the flip radar. No DB, no sim.
 *
 * Ported from the ACQ-FLIP prototype (scripts/study/acq-flip-proto.mjs, PR #227,
 * NORTH-STAR-RND C3/C4), which ran it on the real leagues. What is new here is
 * the ranking the spec asks for (ENGINE-SPECS.md FLIP-01: spread x P(A accepts)
 * x P(B accepts) x days before the deadline) and the deadline reader; the
 * prototype sorted by spread alone.
 */

/** The trade finder's fairness window on the counterparty's side, in percent. */
export const SCREEN_WINDOW = Object.freeze({ low: -12, high: 18 });
/** A title-odds number is real only past this many standard errors (season-sim.js). */
export const NOISE_K = 2;
const DAY_MS = 86_400_000;

/**
 * How a deal reads on the counterparty's own market screen: what he gets minus
 * what he gives, as a percent of what he gives (FantasyCalc values).
 */
export function screenPct(theyGetValue, theyGiveValue) {
  if (!(theyGiveValue > 0)) return null;
  return ((theyGetValue - theyGiveValue) / theyGiveValue) * 100;
}

/** Whether a deal looks fair on his screen: inside the finder's window. */
export function screenFair(theyGetValue, theyGiveValue, window = SCREEN_WINDOW) {
  const pct = screenPct(theyGetValue, theyGiveValue);
  return pct != null && pct >= window.low && pct <= window.high;
}

/**
 * A flip spread: p moved from A to B changes B's title odds by dB and A's by
 * dA. The spread is dB + dA (what p is worth to B beyond what he is worth to
 * A). SE combines both paired SEs as if independent; A and B cannot both win
 * one run, so their errors are not positively correlated and this does not
 * understate it.
 */
export function flipSpread(dB, seB, dA, seA, k = NOISE_K) {
  const spread = dB + dA;
  const se = Math.sqrt((seB ?? 0) ** 2 + (seA ?? 0) ** 2);
  return { spread, se, clears: se > 0 && spread > k * se };
}

/**
 * Two legs through Nick: leg 1 (buy from A) accepted with p1 leaves him at d1,
 * both legs with p1*p2 leave him at d2. A declined second leg strands the
 * first, so the honest expectation counts that state.
 */
export function twoLegExpectation(p1, d1, p2, d2) {
  const pBoth = p1 * p2;
  return { p_both: pBoth, expected: p1 * (1 - p2) * d1 + pBoth * d2 };
}

/**
 * Whole days from `now` to the league's trade deadline, or null when the
 * league payload does not carry one. ESPN stores it as epoch ms at
 * settings.tradeSettings.deadlineDate. A passed deadline is 0.
 */
export function daysToDeadline(payload, now = Date.now()) {
  let p = payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (e) {
      if (e instanceof SyntaxError) return null;
      throw e;
    }
  }
  const ms = Number(p?.settings?.tradeSettings?.deadlineDate);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(0, Math.floor((ms - now) / DAY_MS));
}

/**
 * The spec's rank: spread x P(A accepts) x P(B accepts) x days left. With no
 * known deadline the days factor is 1 (the order then falls back to the
 * spread-and-odds product, and the section says so); a passed deadline ranks 0.
 */
export function rankScore({ spread, p1, p2, days }) {
  if (!(spread > 0) || !Number.isFinite(p1) || !Number.isFinite(p2)) return 0;
  const d = days == null ? 1 : days;
  return spread * p1 * p2 * d;
}
