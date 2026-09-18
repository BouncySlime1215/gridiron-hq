/**
 * How much of a trade's value is still ahead of you, and when.
 *
 * The trade objective ranked on `me.ppg_delta` — a flat weekly number with no
 * sense of WHEN those points land. So in week 10 a deal that is marginally
 * better now and worse in December outranked the reverse, which is backwards
 * for anyone who is going to make the playoffs.
 *
 * Two facts set the weighting, and neither is a taste call:
 *
 *   1. The playoff weeks are worth several times a regular-season week.
 *      Regular-season advance and finals success have different drivers, and
 *      the published exchange rate is roughly 4:1 — a change in finals win rate
 *      is worth about four times the same change in advance rate. A week 16
 *      point and a week 6 point are not the same point.
 *
 *   2. The SHARE of your remaining value that sits in the playoffs rises as the
 *      season runs down. A trade in week 3 buys twelve regular-season weeks
 *      plus three playoff weeks; the same trade in week 12 buys three and
 *      three. Nothing about the trade changed — the calendar did.
 *
 * Both fall out of one expression rather than a table of hand-set weights:
 *
 *   playoffWeight = (playoffWeeksLeft x IMPORTANCE x P(make playoffs))
 *                 / (regularWeeksLeft + playoffWeeksLeft x IMPORTANCE x P(make playoffs))
 *
 * `P(make playoffs)` is what stops this being wrong for a team that is out of
 * it. At 0.1 the playoff term nearly vanishes and the objective correctly
 * collapses back to "what helps me now" — which for a seller is the right
 * answer, because his December roster is not going to matter.
 */
import { PLAYOFF_WEEKS } from './matchups.js';

/** Published finals-to-advance exchange rate. */
export const PLAYOFF_IMPORTANCE = 4;
/** Last week of the regular season in a standard ESPN league. */
export const REGULAR_SEASON_END = 14;

/**
 * Split a trade's value between "now" and "the playoffs".
 *
 * Returns weights that sum to 1. Pass `playoffOdds` when it is known; the
 * default of 0.5 is the league-average prior for a 10-team league with four
 * playoff spots plus the uncertainty of not knowing, and it is deliberately
 * uninformative rather than optimistic.
 */
export function horizonWeights(week, { playoffOdds = 0.5, regularSeasonEnd = REGULAR_SEASON_END } = {}) {
  const w = Math.max(1, Math.min(18, Number(week) || 1));
  const regularLeft = Math.max(0, regularSeasonEnd - w + 1);
  // Once the regular season is over, every remaining point is a playoff point.
  const playoffLeft = PLAYOFF_WEEKS.filter(pw => pw >= w).length;
  if (!playoffLeft) return { now: 1, playoff: 0, regular_weeks_left: regularLeft, playoff_weeks_left: 0, playoff_odds: playoffOdds };
  const odds = Math.max(0, Math.min(1, playoffOdds));
  const playoffMass = playoffLeft * PLAYOFF_IMPORTANCE * odds;
  const total = regularLeft + playoffMass;
  if (total <= 0) return { now: 0, playoff: 1, regular_weeks_left: 0, playoff_weeks_left: playoffLeft, playoff_odds: odds };
  const playoff = playoffMass / total;
  return {
    now: +(1 - playoff).toFixed(3),
    playoff: +playoff.toFixed(3),
    regular_weeks_left: regularLeft,
    playoff_weeks_left: playoffLeft,
    playoff_odds: +odds.toFixed(3),
  };
}

/**
 * The horizon-weighted gain for one side of a deal.
 *
 * `ppgDelta` is the change in this week's best lineup; `playoffPpgDelta` is the
 * change in the lineup solved against each player's playoff-schedule-adjusted
 * rate, which `evaluate()` already computes and nothing has ever read.
 */
export function horizonGain({ ppgDelta, playoffPpgDelta, nowBaseline, playoffBaseline, weights }) {
  const now = Number(ppgDelta) || 0;
  // A deal with no playoff figure falls back to its weekly number rather than
  // being treated as worthless in December — absence of the field is not
  // evidence that the deal is bad later.
  const rawLater = Number.isFinite(playoffPpgDelta) ? playoffPpgDelta : now;

  // SCALE CORRECTION, and it is load-bearing.
  //
  // adj_ppg and playoff_ppg are not the same units. adj_ppg is
  // 0.25*currentWeekPpg + 0.75*rosPpg, and currentWeekPpg is multiplied by
  // active_probability; playoff_ppg is weeklyPpg * playoff_sos with no
  // availability term at all. Measured over 288 rostered players, the ratio
  // playoff_ppg/adj_ppg has mean 1.159 and exceeds 1.0 for every single one.
  //
  // So a raw subtraction of the two lineup deltas reads a units mismatch as a
  // schedule signal. Both are converted to a share of their OWN baseline
  // lineup first — "this deal improves my lineup by X%" — which cancels the
  // scale, and then expressed back in this-week points so the score stays in
  // familiar units.
  const nb = Number(nowBaseline) > 0 ? Number(nowBaseline) : null;
  const pb = Number(playoffBaseline) > 0 ? Number(playoffBaseline) : null;
  const later = (nb && pb) ? (rawLater / pb) * nb : rawLater;

  return {
    value: +(weights.now * now + weights.playoff * later).toFixed(3),
    now_component: +(weights.now * now).toFixed(3),
    playoff_component: +(weights.playoff * later).toFixed(3),
    playoff_delta_raw: +rawLater.toFixed(2),
    playoff_delta_scaled: +later.toFixed(2),
    scale_applied: nb && pb ? +(nb / pb).toFixed(3) : null,
    // Positive means the deal is worth MORE in the playoffs than now, on a
    // like-for-like scale — the shape a contender should be buying in November.
    playoff_tilt: +(later - now).toFixed(2),
  };
}

/** One line a human can read, explaining which horizon drove the ranking. */
export function horizonNote(weights, gain) {
  if (weights.playoff < 0.15) {
    return 'Ranked almost entirely on the remaining regular season — playoff odds are too low for December to matter.';
  }
  const pct = Math.round(weights.playoff * 100);
  if (gain.playoff_tilt > 0.4) {
    return `${pct}% of this is weighted to weeks 15-17, and the deal is worth ${gain.playoff_tilt.toFixed(1)} more per week there than it is now.`;
  }
  if (gain.playoff_tilt < -0.4) {
    return `${pct}% of this is weighted to weeks 15-17, where the deal is ${Math.abs(gain.playoff_tilt).toFixed(1)} per week WORSE than it is now — a win-now move.`;
  }
  return `${pct}% weighted to weeks 15-17; the deal is about the same in both windows.`;
}
