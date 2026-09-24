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
 *   1. A playoff week is worth more than a regular-season week, and by how much
 *      is PLAYOFF_IMPORTANCE. The shipped 4 is NOT a measured value. It was lifted
 *      from a best-ball tournament figure (ETR's 4:1 finals-to-advance rate,
 *      docs/WHAT-WINS-STUDY.md:26), which prices a change in a best-ball team's
 *      finals WIN RATE against its advance rate. It says nothing about how many
 *      regular-season points a managed H2H playoff week is worth, and this comment
 *      used to present it as that league's published exchange rate. RL-16-1
 *      measured the real one (see playoffImportance below); it is on only behind
 *      GRIDIRON_RL16_1_ENABLED or preview mode, and only for the league shape it
 *      was measured on.
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
import { leagueRules } from './league-rules.js';
import { previewUnconfirmed, previewFields } from './preview-mode.js';

/**
 * The served playoff-week weight, and still the value for every league shape
 * RL-16-1 did not measure. Unmeasured: borrowed from a best-ball win-rate
 * exchange rate (see the header), not fitted on any H2H league.
 */
export const PLAYOFF_IMPORTANCE = 4;

/**
 * RL-16-1: default-off switch for the measured weight. Read per call (like
 * RL-19-1's) so a test can flip it without a restart. Off: the served weight is
 * 4 for every league and horizonWeights() output is byte-identical to before.
 */
const RL16_1_ENV = 'GRIDIRON_RL16_1_ENABLED';
const rl16On = () => process.env[RL16_1_ENV] === '1';
/**
 * RL-16-1 (validator r16): 579 Sleeper leagues, playoff-week weight measured per
 * team by standing. Rank 4-6 in 10-team / 6-playoff leagues, the bubble group
 * whose trades the weight actually moves: 5.13 [4.28, 6.34]; rank 1-3: 5.67.
 * The pooled 6.70 is pulled up by non-contenders and is NOT used, nor is the
 * pre-registered 3.82. Interim until CE-09 per-team title odds replace this proxy.
 */
const RL16_1_CONTENDER_IMPORTANCE = 5.13;
const RL16_1_SHAPE = { teams: 10, playoffTeams: 6 };
const RL16_1_REASON = 'RL-16-1 measured playoff-week weight (10-team/6-playoff contenders, 5.13 [4.28, 6.34]) is default-off';

/**
 * The playoff-week weight for a league of this shape: { value, measured, source },
 * plus preview fields when it is on only because of preview mode. 12/6, 8/4 and
 * any shape the platform did not report stay on 4, labelled unmeasured.
 */
export function playoffImportance({ teams = null, playoffTeams = null } = {}) {
  const unmeasured = { value: PLAYOFF_IMPORTANCE, measured: false,
    source: `unmeasured: borrowed best-ball rate, no RL-16-1 measurement for ${teams ?? '?'}-team/${playoffTeams ?? '?'}-playoff leagues` };
  const byFlag = rl16On();
  const byPreview = !byFlag && previewUnconfirmed();
  if (!byFlag && !byPreview) return unmeasured;
  if (teams !== RL16_1_SHAPE.teams || playoffTeams !== RL16_1_SHAPE.playoffTeams) return unmeasured;
  return {
    value: RL16_1_CONTENDER_IMPORTANCE, measured: true,
    source: 'RL-16-1: 579 Sleeper leagues, 10-team/6-playoff, rank 4-6 contenders, 5.13 [4.28, 6.34]',
    ...(byPreview ? previewFields(RL16_1_REASON) : {}),
  };
}

/**
 * Team count and playoff-team count from the synced settings, for playoffImportance.
 * Nulls when the platform does not say (non-ESPN, unparseable, missing fields).
 */
export function leagueShape(lg) {
  const none = { teams: null, playoffTeams: null };
  if (!lg?.payload) return none;
  let payload;
  try {
    payload = typeof lg.payload === 'string' ? JSON.parse(lg.payload) : lg.payload;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return none;
  }
  const teams = Array.isArray(payload?.teams) && payload.teams.length ? payload.teams.length : null;
  return { teams, playoffTeams: leagueRules(lg).schedule.playoff_teams ?? null };
}
/** Last week of the regular season in a standard ESPN league. */
export const REGULAR_SEASON_END = 14;

/**
 * This league's own calendar, from the settings the platform synced.
 *
 * horizonWeights() used to take a week number and no league, so REGULAR_SEASON_END
 * = 14 and PLAYOFF_WEEKS = [15, 16, 17] applied to every league. Two of the five
 * synced leagues are not shaped like that: league 3 has a 13-week regular season,
 * so its week 14 is already a playoff week and was being counted as regular season;
 * leagues 1 and 3 play two-week playoff matchups, so their playoffs span four NFL
 * weeks, not three (league_week_scores shows the doubled totals). Derived here as
 * matchupPeriodCount regular weeks, then ceil(log2(playoffTeamCount)) rounds of
 * playoffMatchupPeriodLength weeks each. For the three 6-team-bracket leagues
 * that is exactly the old default. Falls back to the defaults when the platform
 * does not say, or uses multi-week REGULAR-season matchups (where period count is
 * not a week count).
 */
export function leagueSchedule(lg) {
  // One producer: league-rules.js reads the same four fields with the same
  // derivation. This keeps its labelled default for its callers (the trade
  // horizon needs some calendar); the simulator refuses instead.
  const sch = lg?.payload ? leagueRules(lg).schedule : null;
  if (!sch?.playoff_weeks) {
    return { regularSeasonEnd: REGULAR_SEASON_END, playoffWeeks: [...PLAYOFF_WEEKS], source: 'default' };
  }
  return {
    regularSeasonEnd: sch.regular_season_weeks,
    playoffWeeks: sch.playoff_weeks.flat(),
    source: 'league_settings',
  };
}

/**
 * Split a trade's value between "now" and "the playoffs".
 *
 * Returns weights that sum to 1. Pass `playoffOdds` when it is known; the
 * default of 0.5 is the league-average prior for a 10-team league with four
 * playoff spots plus the uncertainty of not knowing, and it is deliberately
 * uninformative rather than optimistic.
 */
export function horizonWeights(week, {
  playoffOdds = 0.5, regularSeasonEnd = REGULAR_SEASON_END, playoffWeeks = PLAYOFF_WEEKS,
  teams = null, playoffTeams = null,
} = {}) {
  const w = Math.max(1, Math.min(18, Number(week) || 1));
  const regularLeft = Math.max(0, regularSeasonEnd - w + 1);
  // Once the regular season is over, every remaining point is a playoff point.
  const playoffLeft = playoffWeeks.filter(pw => pw >= w).length;
  const weeksLabel = playoffWeeks.length ? `${playoffWeeks[0]}-${playoffWeeks.at(-1)}` : null;
  if (!playoffLeft) return { now: 1, playoff: 0, regular_weeks_left: regularLeft, playoff_weeks_left: 0, playoff_odds: playoffOdds, playoff_weeks_label: weeksLabel };
  const odds = Math.max(0, Math.min(1, playoffOdds));
  const imp = playoffImportance({ teams, playoffTeams });
  // Flag off: no new fields, so the served horizon is exactly what it was.
  const impFields = rl16On() || previewUnconfirmed() ? {
    playoff_importance: imp.value,
    playoff_importance_measured: imp.measured,
    playoff_importance_source: imp.source,
    ...(imp.preview ? previewFields(imp.preview_reason) : {}),
  } : {};
  const playoffMass = playoffLeft * imp.value * odds;
  const total = regularLeft + playoffMass;
  if (total <= 0) return { now: 0, playoff: 1, regular_weeks_left: 0, playoff_weeks_left: playoffLeft, playoff_odds: odds, playoff_weeks_label: weeksLabel, ...impFields };
  const playoff = playoffMass / total;
  return {
    now: +(1 - playoff).toFixed(3),
    playoff: +playoff.toFixed(3),
    regular_weeks_left: regularLeft,
    playoff_weeks_left: playoffLeft,
    playoff_odds: +odds.toFixed(3),
    playoff_weeks_label: weeksLabel,
    ...impFields,
  };
}

/**
 * The horizon-weighted gain for one side of a deal.
 *
 * `ppgDelta` is the change in the best lineup solved on adj_ppg — NOT this week's
 * lineup, whatever the name "now" suggests. evaluate() calls bestLineup() with its
 * default key, and adj_ppg is 0.25 * current_week_ppg + 0.75 * ros_ppg, so 75% of
 * the "now" leg is already rest-of-season value. At week 2 the effective weight on
 * the actual current week is weights.now * 0.25, not weights.now. This comment used
 * to call it "the change in this week's best lineup"; the number has not been
 * changed here because re-keying it moves every trade ranking and needs grading
 * first.
 *
 * `playoffPpgDelta` is the change in the playoff-weeks lineup: evaluate() solves
 * the best lineup on the weekly rate (ros_ppg) for each of this league's remaining
 * playoff weeks, with anyone on bye that week out of it, and averages them. It
 * carries NO schedule strength. The playoff multiplier it used to carry
 * (playoff_sos, via playoff_ppg) failed the weekly walk-forward test —
 * home field and DvP were no better than nothing on 2025 (matchups.js,
 * 2026-09-17) — and is 1 while that stays true. So the two legs differ only by
 * WHEN points land: the "now" leg carries this week (its injuries, its byes, its
 * betting-line correction) and the playoff leg carries playoff-week byes. The
 * importance weighting is not applied here: it lives in horizonWeights() (a playoff
 * week worth playoffImportance() regular weeks, times P(make playoffs)) and reaches
 * this function only through `weights`. That weight is the unmeasured best-ball 4
 * unless RL-16-1 is on for a 10/6 league (5.13, measured; see the file header). When this week's projection equals the
 * weekly rate for everyone involved (no bye, no injury, no this-week correction)
 * and nobody is on bye in the playoff weeks, the two legs are equal and `value`
 * is ppgDelta.
 */
export function horizonGain({ ppgDelta, playoffPpgDelta, nowBaseline, playoffBaseline, weights }) {
  const now = Number(ppgDelta) || 0;
  // A deal with no playoff figure falls back to its weekly number rather than
  // being treated as worthless in December — absence of the field is not
  // evidence that the deal is bad later.
  const rawLater = Number.isFinite(playoffPpgDelta) ? playoffPpgDelta : now;

  // SCALE CORRECTION, and it is load-bearing.
  //
  // adj_ppg and the playoff leg are not the same units. adj_ppg is
  // 0.25*currentWeekPpg + 0.75*rosPpg, and currentWeekPpg is multiplied by
  // active_probability (about 0.8 for a healthy starter — a known under-estimate,
  // contingency.js) and is 0 on a bye; the playoff leg is on the weekly rate, with
  // no availability term. Measured 2026 W2 over 742 rostered players in the five
  // synced leagues (after the schedule tilt was removed): rate/adj_ppg has mean
  // 1.111 and exceeds 1.0 for 734; whole lineups run 1.03-1.10 (mean 1.064).
  //
  // So a raw subtraction of the two lineup deltas would read that level gap as a
  // "worth more in December" signal. Both are converted to a share of their OWN baseline
  // lineup first — "this deal improves my lineup by X%" — which cancels the
  // scale, and then expressed back in this-week points so the score stays in
  // familiar units.
  const nb = Number(nowBaseline) > 0 ? Number(nowBaseline) : null;
  const pb = Number(playoffBaseline) > 0 ? Number(playoffBaseline) : null;
  // Only a genuine playoff figure is on the playoff scale. When the fallback above
  // ran, rawLater IS `now`, already in adj_ppg units, and rescaling it by nb/pb
  // (~0.90 on measured data) would quietly make the deal ~10% worse in December —
  // the opposite of what the fallback's own comment promises.
  const hasPlayoff = Number.isFinite(playoffPpgDelta);
  const scaled = hasPlayoff && nb && pb;
  const later = scaled ? (rawLater / pb) * nb : rawLater;

  return {
    value: +(weights.now * now + weights.playoff * later).toFixed(3),
    now_component: +(weights.now * now).toFixed(3),
    playoff_component: +(weights.playoff * later).toFixed(3),
    playoff_delta_raw: +rawLater.toFixed(2),
    playoff_delta_scaled: +later.toFixed(2),
    scale_applied: scaled ? +(nb / pb).toFixed(3) : null,
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
  const weeks = weights.playoff_weeks_label ?? '15-17';
  // The tilt is timing only: this week's number (each player's modelled chance to
  // play, this week's bye, the game-line correction) against playoff-week byes. No
  // matchup read is behind it (see horizonGain), so the note never implies one. Nor
  // does it say "injury": measured 2026 W2, 32 of 33 deals with |tilt| > 0.4 had no
  // injury report or bye on any player involved; 27 of them went to ~0 when this
  // week's number was set to the weekly rate, i.e. the chance-to-play prior
  // (contingency.js, ~0.57-0.86 for healthy starters) is what moves them.
  if (gain.playoff_tilt > 0.4) {
    return `${pct}% of this is weighted to weeks ${weeks}, and the deal is worth ${gain.playoff_tilt.toFixed(1)} more per week there than it is now — this week's number is cut by each player's modelled chance to play (and any bye or betting-line adjustment); the playoff weeks only lose byes.`;
  }
  if (gain.playoff_tilt < -0.4) {
    return `${pct}% of this is weighted to weeks ${weeks}, where the deal is ${Math.abs(gain.playoff_tilt).toFixed(1)} per week WORSE than it is now — more of its value sits in this week's number (who is likelier to play, the betting-line adjustment), or playoff-week byes on the rosters change who is needed then — a win-now move.`;
  }
  return `${pct}% weighted to weeks ${weeks}; the deal is about the same in both windows.`;
}
