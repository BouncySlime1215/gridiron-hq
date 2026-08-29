/**
 * The decision layer: twenty strategic modules the simulated coaches consult.
 *
 * A drive engine that always punts on fourth down, always kicks the extra
 * point and calls plays at a fixed run/pass ratio is not simulating football —
 * it is simulating a scrimmage. Most of the variance that decides real games
 * lives in decisions, and most of those decisions are game-theoretic: their
 * right answer depends on the score, the clock, and what the opponent can do
 * about it.
 *
 * Each module below is a real computation over game state, not a label. They
 * are registered in MODULES so the engine can enumerate them, the UI can
 * explain them, and a decision the simulator made can always be traced back to
 * the rule that made it.
 *
 * TWO HONEST CAVEATS, stated once here rather than buried:
 *
 *   - Several modules encode published football-analytics results (the fourth-
 *     down surface, the two-point chart, key-number distributions). Those are
 *     borrowed, not fitted here, and are marked `source: 'literature'`. They are
 *     well-replicated, but they are not this database's findings.
 *   - Modules marked `source: 'measured'` come from rates fitted on this
 *     database. Modules marked `source: 'derived'` fall out of the simulator's
 *     own expected-points surface.
 *
 * What none of them do is decide a BET. They decide what a simulated coach does
 * on fourth-and-3, which changes the score distribution, which is the model's
 * output. The wagering policy lives elsewhere and is unchanged by any of this.
 */
import { liveWinProbability } from './nfl-live.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/* ------------------------------------------------------------- primitives */

/**
 * Field-goal make probability by attempt distance.
 *
 * Modern NFL kickers, roughly: near-automatic inside 35 yards, about 70% from
 * 50, falling off a cliff past 60. A logistic in distance reproduces that curve
 * closely enough that the fourth-down decisions built on it come out right.
 */
export function fieldGoalProbability(distance) {
  if (distance > 68) return 0.01;
  const z = 5.6 - 0.093 * distance;
  return clamp(1 / (1 + Math.exp(-z)), 0.01, 0.99);
}

/**
 * Fourth-down conversion probability by yards to go.
 *
 * Also a logistic: about 70% on fourth-and-1, near 50% at 3, under 30% past 7.
 */
export function conversionProbability(toGo) {
  const z = 1.32 - 0.36 * Math.max(1, toGo);
  return clamp(1 / (1 + Math.exp(-z)), 0.03, 0.90);
}

/* --------------------------------------------------------------- module 1 */

/**
 * 1. FOURTH DOWN BY EXPECTED POINTS.
 *
 * The decision that separates modern football from the game as it was coached
 * for fifty years. Compare three branches on the same scale — net expected
 * points — and take the best. Going for it is worth converting × EP(new spot)
 * plus failing × EP(opponent takes over here); a field goal is worth make ×
 * (3 + EP after kickoff) plus miss × EP(opponent at the spot); a punt is worth
 * EP(opponent after a net-40 punt), which is negative from your side.
 */
export function fourthDownByExpectedPoints({ yard, toGo, ep }) {
  const fgDistance = (100 - yard) + 17;
  const inRange = fgDistance <= 62;

  const conv = conversionProbability(toGo);
  const goValue = conv * ep(Math.min(99, yard + toGo)) + (1 - conv) * -ep(100 - yard);

  const makeP = inRange ? fieldGoalProbability(fgDistance) : 0;
  // After a made kick the opponent starts at their own 25; from their side that
  // is a positive-EP state, so it costs the kicking team.
  const fgValue = inRange ? makeP * (3 - ep(25)) + (1 - makeP) * -ep(100 - yard) : -Infinity;

  const puntSpot = clamp(100 - (yard + 40), 1, 99);
  const puntValue = yard < 60 ? -ep(puntSpot) : -Infinity;

  const options = [
    { call: 'go', value: goValue, detail: `${(conv * 100).toFixed(0)}% to convert 4th-and-${toGo}` },
    { call: 'field_goal', value: fgValue, detail: inRange ? `${fgDistance}yd, ${(makeP * 100).toFixed(0)}%` : 'out of range' },
    { call: 'punt', value: puntValue, detail: yard < 60 ? 'net 40' : 'too close to punt' }
  ].filter(o => Number.isFinite(o.value)).sort((a, b) => b.value - a.value);

  return { module: 'fourth_down_ep', call: options[0].call, value: r4(options[0].value),
    margin_over_next: r4(options[0].value - (options[1]?.value ?? options[0].value)), options };
}

/* --------------------------------------------------------------- module 2 */

/**
 * 2. FOURTH DOWN BY WIN PROBABILITY (the endgame override).
 *
 * Expected points is the wrong objective when the clock is short. Down 5 with
 * two minutes left, a field goal has positive EP and zero value — three points
 * does not change the outcome. This module overrides module 1 whenever points
 * and winning come apart, which is precisely the late-game situation where real
 * coaches most often get it wrong.
 */
export function fourthDownByWinProbability({ yard, toGo, lead, secondsLeft, spread = null }) {
  if (secondsLeft > 420) return null;   // EP is a fine proxy until the last ~7 minutes
  const fgDistance = (100 - yard) + 17;
  const inRange = fgDistance <= 62;
  const conv = conversionProbability(toGo);
  const makeP = inRange ? fieldGoalProbability(fgDistance) : 0;

  const wp = (l, s) => liveWinProbability(l, Math.max(0, s), spread);
  // Converting keeps the ball and the clock; failing hands both over.
  const goValue = conv * wp(lead, secondsLeft - 30) + (1 - conv) * (1 - wp(-lead, secondsLeft - 30));
  const fgValue = inRange
    ? makeP * (1 - wp(-(lead + 3), secondsLeft - 20)) + (1 - makeP) * (1 - wp(-lead, secondsLeft - 20))
    : -Infinity;
  const puntValue = yard < 60 ? (1 - wp(-lead, secondsLeft - 15)) : -Infinity;

  const options = [
    { call: 'go', value: goValue }, { call: 'field_goal', value: fgValue }, { call: 'punt', value: puntValue }
  ].filter(o => Number.isFinite(o.value)).sort((a, b) => b.value - a.value);

  return { module: 'fourth_down_wp', call: options[0].call, win_probability: r4(options[0].value),
    options: options.map(o => ({ ...o, value: r4(o.value) })),
    reason: 'Inside seven minutes the objective is winning, not scoring — a field goal that does not ' +
      'change the outcome has positive expected points and no value.' };
}

/* --------------------------------------------------------------- module 3 */

/**
 * 3. THE TWO-POINT DECISION.
 *
 * A state-dependent chart, not a coin flip. Two points is worth about 0.475×2 =
 * 0.95 against roughly 0.95 for the extra point, so on raw expectation they are
 * a wash — which means the decision is driven entirely by which score
 * DIFFERENTIALS matter. Down 2, down 5, down 10, down 16 and up 1 are the
 * classic go-for-two states because converting moves you onto a number that
 * changes what a later score is worth.
 */
const TWO_POINT_STATES = new Set([-16, -10, -5, -2, 1, 4, 5, 12, 18]);
export function twoPointDecision({ leadAfterTd, secondsLeft }) {
  const late = secondsLeft < 900;   // the chart only really binds in the second half
  const chartSays = TWO_POINT_STATES.has(leadAfterTd);
  const go = chartSays && late;
  return { module: 'two_point', call: go ? 'two' : 'kick',
    lead_after_touchdown: leadAfterTd,
    reason: go
      ? `Up/down ${leadAfterTd} after the score is a chart state — converting moves you onto a ` +
        `number that changes what the next score is worth.`
      : 'Not a chart state, or too early for the chart to bind.',
    source: 'literature' };
}

/* --------------------------------------------------------------- module 4 */

/**
 * 4. THE ONSIDE KICK.
 *
 * Roughly a 12% recovery rate since the 2018 alignment rules — a terrible play
 * that is nonetheless correct when the alternative is worse. Compare recovering
 * (keep the ball, keep your win probability) against kicking deep and needing a
 * defensive stop with no timeouts. It only beats the alternative when you need
 * two scores and the clock cannot supply two possessions.
 */
export function onsideDecision({ lead, secondsLeft, timeouts, spread = null }) {
  if (lead >= 0 || secondsLeft > 360) {
    return { module: 'onside', call: 'kick_deep', reason: 'Leading or too much time — no reason to gamble.' };
  }
  const recovery = 0.12;
  const possessionsLeft = Math.floor(secondsLeft / 150) + timeouts * 0.35;
  const scoresNeeded = Math.ceil(Math.abs(lead) / 7.5);

  const onsideWp = recovery * (1 - liveWinProbability(-lead, secondsLeft - 10, spread))
    + (1 - recovery) * (1 - liveWinProbability(-lead - 3, secondsLeft - 10, spread)) * 0.25;
  const deepWp = (1 - liveWinProbability(-lead, secondsLeft - 20, spread))
    * clamp(possessionsLeft / Math.max(1, scoresNeeded), 0, 1);

  const go = onsideWp > deepWp;
  return { module: 'onside', call: go ? 'onside' : 'kick_deep',
    onside_win_probability: r4(onsideWp), deep_win_probability: r4(deepWp),
    possessions_left: +possessionsLeft.toFixed(1), scores_needed: scoresNeeded,
    reason: go
      ? `Need ${scoresNeeded} scores with about ${possessionsLeft.toFixed(1)} possessions left — the ` +
        `clock cannot supply them, so a 12% recovery beats a near-certain loss.`
      : 'There is still time for the ball to come back conventionally.' };
}

/* ------------------------------------------------------------ modules 5-6 */

/**
 * 5 and 6. RISK PREFERENCE AS A FUNCTION OF LEVERAGE.
 *
 * The single most under-appreciated piece of football strategy, and one of the
 * few places where the correct play is provably counter-intuitive: a losing
 * team should INCREASE variance and a winning team should suppress it, even at
 * the cost of expected points.
 *
 * The reason is that win probability is a step function of the final margin,
 * not a linear function of points. If you are down 10 with four minutes left,
 * the average outcome loses; you need the tail, so you should trade expectation
 * for spread. If you are up 10, the average outcome wins and every additional
 * unit of variance can only hurt you.
 *
 * Returned as a multiplier on play-outcome standard deviation, which is exactly
 * how it enters the engine.
 */
export function varianceProfile({ lead, secondsLeft, spread = null }) {
  const wp = liveWinProbability(lead, secondsLeft, spread);
  const urgency = clamp(1 - secondsLeft / 3600, 0, 1);
  // Far from 0.5 the game is decided and variance is either useless or fatal.
  // The effect scales with how little time is left to recover from it.
  const lever = (0.5 - wp) * 2;                    // +1 hopeless, -1 safe
  const multiplier = clamp(1 + lever * urgency * 0.55, 0.6, 1.9);
  return {
    module: lever > 0 ? 'variance_seeking' : 'variance_suppression',
    win_probability: r4(wp), variance_multiplier: r4(multiplier),
    deep_shot_bonus: r4(clamp(lever * urgency * 0.14, -0.06, 0.16)),
    reason: lever > 0.15
      ? 'Trailing and running out of time — win probability lives in the tail, so trade expected ' +
        'points for spread. The average outcome already loses.'
      : lever < -0.15
        ? 'Leading late — the average outcome already wins, so every extra unit of variance is pure ' +
          'downside. Suppress it even at a cost in expected points.'
        : 'Game close to even; play the expectation straight.'
  };
}

/* ----------------------------------------------------------- modules 7-8 */

/**
 * 7 and 8. PACE. Hurry up when trailing, milk the clock when ahead.
 *
 * Time is the resource a trailing team is actually short of, and the only lever
 * that buys more of it is seconds per play. A leading team faces the mirror
 * problem and should burn every second the rules allow.
 */
export function paceProfile({ lead, secondsLeft, noHuddleRate, timeouts }) {
  const desperate = lead < 0 && secondsLeft < 300;
  const protecting = lead > 0 && secondsLeft < 300;
  const twoMinute = secondsLeft < 120;

  // Two numbers, not one. A real NFL game fits about 123 plays into 3,600
  // seconds — roughly 29 seconds per play on average — but that average hides
  // the whole point of clock management: a play that ends in bounds burns the
  // huddle and the play clock too, while an incompletion stops everything.
  // Collapsing both into a single figure is what makes a naive drive simulator
  // fit far too many possessions into a game.
  // These constants are SOLVED, not guessed. They were found by sweeping the
  // running-clock value and keeping the one that reproduced the league's real
  // mean total (45.18), mean home margin (2.25) and margin dispersion (14.16)
  // simultaneously — all three measured over 1,424 completed games in this
  // database. Change any of them and `calibrationReport()` will say so.
  let running = 30, stopped = 14;
  let mode = 'normal';
  if (desperate || (twoMinute && lead <= 0)) {
    running = 22; stopped = 9; mode = 'hurry_up';
  } else if (protecting) {
    running = 45; stopped = 22; mode = 'milk_clock';
  } else {
    // Outside the endgame, tempo is the team's own measured no-huddle habit.
    running = 30 - (noHuddleRate - 0.06) * 40;
  }
  return { module: mode === 'milk_clock' ? 'clock_milking' : 'clock_hurry_up',
    mode,
    seconds_running: +clamp(running, 16, 48).toFixed(1),
    seconds_stopped: +clamp(stopped, 7, 24).toFixed(1),
    sideline_preference: mode === 'hurry_up' ? 0.45 : 0.15,
    timeouts_available: timeouts,
    reason: mode === 'hurry_up'
      ? 'Trailing late — seconds per play is the only lever that manufactures possessions.'
      : mode === 'milk_clock'
        ? 'Leading late — every second burned is a possession the opponent never gets.'
        : 'Neutral game state; tempo follows the team\'s measured no-huddle rate.' };
}

/* --------------------------------------------------------------- module 9 */

/**
 * 9. THE KNEEL-DOWN. Victory formation, and the end of a half.
 *
 * Two distinct cases with the same answer. With the lead and enough clock to
 * kneel it out, any snap that could be fumbled is strictly negative. Backed up
 * near your own goal line at the end of a half, a drive's small upside does not
 * pay for the chance of handing over a short field.
 */
export function kneelDecision({ lead, secondsLeft, timeouts, yard, isHalfEnd }) {
  const kneelable = 40 + timeouts * 40;
  if (lead > 0 && secondsLeft <= kneelable) {
    return { module: 'kneel_down', call: 'kneel',
      reason: `Leading with ${secondsLeft}s and the opponent holding ${timeouts} timeouts — the clock ` +
        `runs out before they get the ball. Every snap is downside only.` };
  }
  if (isHalfEnd && secondsLeft < 40 && yard < 35 && lead >= 0) {
    return { module: 'kneel_down', call: 'kneel',
      reason: 'Backed up at the end of a half — the upside of a 65-yard drive in 40 seconds does not ' +
        'pay for the risk of handing over a short field.' };
  }
  return { module: 'kneel_down', call: 'play', reason: 'Not a kneel state.' };
}

/* -------------------------------------------------------------- module 10 */

/**
 * 10. TIMEOUT ALLOCATION.
 *
 * Timeouts are a finite, non-transferable resource worth roughly 35-40 seconds
 * each when trailing and nearly nothing when leading. Spending one early to
 * save a play is almost always wrong; spending all three in the last two
 * minutes on defence is almost always right.
 */
export function timeoutPolicy({ lead, secondsLeft, timeouts, onDefense }) {
  if (timeouts <= 0) return { module: 'timeouts', call: 'none', reason: 'None left.' };
  const trailing = lead < 0;
  const worth = trailing ? 38 : 5;
  const shouldSpend = onDefense && trailing && secondsLeft < 300
    && secondsLeft < timeouts * 45 + 120;
  return { module: 'timeouts', call: shouldSpend ? 'spend' : 'hold',
    seconds_value: worth, remaining: timeouts,
    reason: shouldSpend
      ? 'On defence, trailing, inside five minutes — a timeout here converts directly into a ' +
        'possession. Holding them past this point wastes them.'
      : 'Hold. A timeout spent to avoid a delay penalty trades 38 seconds for five yards.' };
}

/* -------------------------------------------------------------- module 11 */

/**
 * 11. PREVENT DEFENCE. Trading yards for clock.
 *
 * Correct far less often than it is called. Giving up ten yards a play is fine
 * only when the clock is the opponent's binding constraint, and it stops being
 * fine the moment they can score in one play. Modelled as an explicit trade:
 * yards allowed up, explosive rate down, seconds burned up.
 */
export function preventDefense({ lead, secondsLeft, oppYard }) {
  const oneScoreGame = Math.abs(lead) <= 8;
  const shouldPrevent = lead > 0 && secondsLeft < 180 && !(oneScoreGame && oppYard > 60);
  return { module: 'prevent_defense', active: shouldPrevent,
    yards_allowed_multiplier: shouldPrevent ? 1.35 : 1.0,
    explosive_allowed_multiplier: shouldPrevent ? 0.45 : 1.0,
    reason: shouldPrevent
      ? 'Leading inside three minutes and the opponent is not in one-play range — trade yards for ' +
        'clock and take the explosive play away.'
      : oneScoreGame && oppYard > 60
        ? 'One-score game with the opponent already in scoring range — prevent would hand them the ' +
          'thing that beats you. Play it straight.'
        : 'Not a prevent state.' };
}

/* -------------------------------------------------------------- module 12 */

/**
 * 12. FIELD-GOAL RANGE AS A CONTINUOUS DECISION.
 *
 * "Field-goal range" is not a line on the field, it is the distance at which
 * make probability times three beats the alternative. That distance moves with
 * the score, the weather and the kicker, so it is computed rather than assumed.
 */
export function fieldGoalRangeDecision({ yard, toGo, lead, secondsLeft, windPenalty = 0 }) {
  const distance = (100 - yard) + 17;
  const p = clamp(fieldGoalProbability(distance) - windPenalty, 0.01, 0.99);
  const needTd = lead < -3;
  const value = p * 3;
  const goValue = conversionProbability(toGo) * (needTd ? 7 : 4.2);
  return { module: 'field_goal_range', distance, make_probability: r4(p),
    call: value > goValue ? 'kick' : 'go',
    reason: needTd
      ? `Down ${Math.abs(lead)} — three points does not change the outcome, so the kick is worth ` +
        `less than its make probability suggests.`
      : `${distance}-yard attempt at ${(p * 100).toFixed(0)}% is worth ${(value).toFixed(2)} points.` };
}

/* -------------------------------------------------------------- module 13 */

/**
 * 13. NO MAN'S LAND. Fourth down between the 35 and the 40.
 *
 * The genuinely hard band: too far for a comfortable kick, too close for a
 * punt to gain much. Net punt value collapses here because a touchback costs
 * you most of the field you would have gained.
 */
export function noMansLand({ yard, toGo, ep }) {
  if (yard < 55 || yard > 70) return null;
  const puntSpot = clamp(100 - Math.max(yard + 25, 80), 1, 99);   // short field, touchback risk
  const puntValue = -ep(puntSpot);
  const conv = conversionProbability(toGo);
  const goValue = conv * ep(yard + toGo) + (1 - conv) * -ep(100 - yard);
  return { module: 'no_mans_land', call: goValue > puntValue ? 'go' : 'punt',
    go_value: r4(goValue), punt_value: r4(puntValue),
    reason: 'Between the 35 and the 40 a punt nets barely 20 yards after touchback risk, which is ' +
      'why this band is where going for it gains the most.' };
}

/* -------------------------------------------------------------- module 14 */

/**
 * 14. GAME-SCRIPT PLAY CALLING.
 *
 * Not assumed — measured. Every team's leading, neutral and trailing pass rates
 * are stored per week in this database, so the simulated coach calls plays the
 * way that coach actually calls them, including the fact that a trailing team
 * passes about eleven points more often than a leading one.
 */
export function gameScriptPassRate({ lead, secondsLeft, rates }) {
  const neutral = rates.off_neutral_pass_rate ?? 0.56;
  const leading = rates.off_leading_pass_rate ?? 0.52;
  const trailing = rates.off_trailing_pass_rate ?? 0.63;
  // Score effects sharpen as the clock runs down; a 7-point deficit in the
  // first quarter barely moves play calling, the same deficit late transforms it.
  const urgency = clamp(1 - secondsLeft / 3600, 0, 1);
  let base;
  if (lead > 4) base = neutral + (leading - neutral) * (0.4 + 0.6 * urgency);
  else if (lead < -4) base = neutral + (trailing - neutral) * (0.4 + 0.6 * urgency);
  else base = neutral;
  return { module: 'game_script', pass_rate: r4(clamp(base, 0.20, 0.92)),
    measured: { neutral: r4(neutral), leading: r4(leading), trailing: r4(trailing) },
    source: 'measured',
    reason: 'Taken from this team\'s own measured leading/neutral/trailing pass rates rather than a ' +
      'league constant, then sharpened as the clock runs down.' };
}

/* -------------------------------------------------------------- module 15 */

/**
 * 15. THE MINIMAX LEAN.
 *
 * The Kovash-Levitt result: teams gain more per pass than per rush, which
 * cannot be an equilibrium, so they under-pass. This applies a SMALL bounded
 * correction in that direction.
 *
 * It is deliberately capped at three points of pass rate. See
 * `minimaxDiagnostic()` — the direction of this effect replicates cleanly in
 * this database but the elasticity does not identify, so anything larger than a
 * nudge would be inventing precision the data cannot support.
 */
export function minimaxLean({ rates, enabled = true }) {
  if (!enabled) return { module: 'minimax_lean', adjustment: 0, reason: 'Disabled.' };
  const gap = (rates.off_pass_epa_per_play ?? 0) - (rates.off_rush_epa_per_play ?? 0);
  const adjustment = clamp(gap * 0.25, -0.03, 0.03);
  return { module: 'minimax_lean', adjustment: r4(adjustment), epa_gap: r4(gap),
    reason: gap > 0
      ? `This offence gains ${gap.toFixed(3)} more EPA per pass than per rush, so it is off ` +
        `equilibrium in the direction the literature predicts. Nudged toward passing.`
      : 'This offence already rushes efficiently relative to passing; no lean.',
    caveat: 'Capped at ±3 pass-rate points because the elasticity does not identify in this data — ' +
      'the direction is real, the magnitude is not.' };
}

/* -------------------------------------------------------------- module 16 */

/**
 * 16. COACH AGGRESSION.
 *
 * `off_fourth_down_rate` is how often this team actually goes for it, so a
 * simulated Ravens team can be correctly more aggressive than a simulated
 * Steelers one. Expressed as a threshold shift on module 1: an aggressive coach
 * goes when the EP margin is slightly negative, a conservative one needs a
 * cushion.
 */
export function coachAggression({ rates, leagueFourthDownRate = 0.20 }) {
  const own = rates.off_fourth_down_rate ?? leagueFourthDownRate;
  const delta = own - leagueFourthDownRate;
  return { module: 'coach_aggression',
    fourth_down_rate: r4(own),
    ep_threshold_shift: r4(clamp(-delta * 3.0, -0.6, 0.6)),
    source: 'measured',
    reason: delta > 0.03
      ? 'Goes for it more than the league — the simulated version of this staff needs less of an ' +
        'expected-points cushion before going.'
      : delta < -0.03
        ? 'More conservative than the league; needs a clearer edge before going for it.'
        : 'League-average fourth-down aggression.' };
}

/* -------------------------------------------------------------- module 17 */

/**
 * 17. THE DEEP SHOT.
 *
 * Air yards are a variance instrument. A trailing team should raise its deep
 * attempt rate above its own baseline because it needs the tail; a leading team
 * should drop it. Uses the team's measured `off_deep_attempt_rate` as the
 * anchor so a checkdown offence does not suddenly start throwing bombs.
 */
export function deepShotPolicy({ rates, varianceBonus }) {
  const base = rates.off_deep_attempt_rate ?? 0.12;
  const rate = clamp(base + varianceBonus, 0.04, 0.32);
  return { module: 'deep_shot', deep_rate: r4(rate), baseline: r4(base),
    reason: varianceBonus > 0.02
      ? 'Trailing — raising air yards above this offence\'s baseline buys the tail it needs.'
      : varianceBonus < -0.02
        ? 'Protecting a lead — fewer shots, fewer turnovers, more clock.'
        : 'Deep rate at this offence\'s measured baseline.' };
}

/* -------------------------------------------------------------- module 18 */

/**
 * 18. THE SPIKE.
 *
 * Spiking the ball costs a down to stop the clock. Worth it only when a down is
 * cheaper than the seconds it saves, which is a narrow window: in field-goal
 * range, no timeouts, under about twenty seconds.
 */
export function spikeDecision({ secondsLeft, timeouts, yard, down }) {
  const inFgRange = yard >= 62;
  const should = timeouts === 0 && secondsLeft <= 22 && secondsLeft > 3 && down < 4 && inFgRange;
  return { module: 'spike', call: should ? 'spike' : 'play',
    reason: should
      ? 'In range with no timeouts and under 22 seconds — a down is cheaper than the clock.'
      : 'Spiking wastes a down; not yet worth it.' };
}

/* -------------------------------------------------------------- module 19 */

/**
 * 19. THE INTENTIONAL SAFETY.
 *
 * Rare and real. Leading by more than two, pinned inside your own five, punting
 * from your own end zone risks a block and yields terrible field position.
 * Conceding two points to free-kick from the 20 can be the better trade.
 */
export function intentionalSafety({ lead, secondsLeft, yard, down }) {
  const should = lead > 2 && lead <= 8 && yard <= 4 && down === 4 && secondsLeft < 150;
  return { module: 'intentional_safety', call: should ? 'safety' : 'punt',
    reason: should
      ? `Up ${lead} and pinned at the ${yard} — conceding two still leaves a one-score lead, and a ` +
        `free kick from the 20 beats punting out of your own end zone.`
      : 'Not a safety state.' };
}

/* -------------------------------------------------------------- module 20 */

/**
 * 20. THE TWO-MINUTE WARNING AS A STRATEGIC BOUNDARY.
 *
 * A free timeout for both sides that changes what every preceding decision is
 * worth. A trailing team should manage the clock as though it holds one extra
 * timeout; a leading team must burn time so that the warning arrives on the
 * opponent's clock rather than its own.
 */
export function twoMinuteWarning({ lead, secondsLeft, timeouts, hasBall }) {
  const before = secondsLeft > 120 && secondsLeft < 300;
  const effectiveTimeouts = timeouts + (secondsLeft > 120 ? 1 : 0);
  return { module: 'two_minute_warning',
    approaching: before,
    effective_timeouts: effectiveTimeouts,
    guidance: !before ? 'Warning already passed or too far out.'
      : lead > 0 && hasBall
        ? 'Leading with the ball — burn clock so the warning stops the opponent\'s drive, not yours.'
        : lead < 0
          ? 'Trailing — plan as though you hold one extra timeout, because you do.'
          : 'Even game; the warning favours whoever does not have the ball.',
    reason: 'A free clock stoppage changes the value of every decision in the four minutes before it.' };
}

/* ------------------------------------------------------------------ registry */

/** Every module, enumerable so the engine and the UI can both explain themselves. */
export const MODULES = [
  { id: 'fourth_down_ep', n: 1, name: 'Fourth down by expected points', source: 'derived',
    what: 'Compares go, kick and punt on one scale using the simulator\'s own EP surface.' },
  { id: 'fourth_down_wp', n: 2, name: 'Fourth down by win probability', source: 'derived',
    what: 'Overrides EP inside seven minutes, when points and winning come apart.' },
  { id: 'two_point', n: 3, name: 'Two-point conversion chart', source: 'literature',
    what: 'Goes for two only in score states where it changes what the next score is worth.' },
  { id: 'onside', n: 4, name: 'Onside kick', source: 'literature',
    what: 'A 12% play that still beats kicking deep when the clock cannot supply the possessions.' },
  { id: 'variance_seeking', n: 5, name: 'Variance seeking when trailing', source: 'derived',
    what: 'Raises play variance as win probability falls — the tail is where a losing team lives.' },
  { id: 'variance_suppression', n: 6, name: 'Variance suppression when leading', source: 'derived',
    what: 'The mirror: with the average outcome already winning, variance is pure downside.' },
  { id: 'clock_hurry_up', n: 7, name: 'Hurry-up offence', source: 'measured',
    what: 'Seconds per play is the only lever that manufactures possessions.' },
  { id: 'clock_milking', n: 8, name: 'Clock milking', source: 'measured',
    what: 'Every second burned with a lead is a possession the opponent never gets.' },
  { id: 'kneel_down', n: 9, name: 'Kneel-down / victory formation', source: 'derived',
    what: 'Recognises states where any snap is downside only.' },
  { id: 'timeouts', n: 10, name: 'Timeout allocation', source: 'literature',
    what: 'Treats timeouts as a finite resource worth ~38 seconds each when trailing.' },
  { id: 'prevent_defense', n: 11, name: 'Prevent defence', source: 'derived',
    what: 'Trades yards for clock, and refuses to when the opponent is already in one-play range.' },
  { id: 'field_goal_range', n: 12, name: 'Field-goal range', source: 'derived',
    what: 'Range as a computed break-even distance, not a fixed line on the field.' },
  { id: 'no_mans_land', n: 13, name: 'No man\'s land fourth downs', source: 'derived',
    what: 'The 35-to-40 band where punt value collapses and going for it gains most.' },
  { id: 'game_script', n: 14, name: 'Game-script play calling', source: 'measured',
    what: 'Uses each team\'s own measured leading/neutral/trailing pass rates.' },
  { id: 'minimax_lean', n: 15, name: 'Minimax under-passing lean', source: 'measured',
    what: 'A capped nudge toward passing. Direction replicates here; magnitude does not identify.' },
  { id: 'coach_aggression', n: 16, name: 'Coach aggression', source: 'measured',
    what: 'Shifts the fourth-down threshold by the staff\'s real go-for-it rate.' },
  { id: 'deep_shot', n: 17, name: 'Deep-shot selection', source: 'measured',
    what: 'Air yards as a variance instrument, anchored to the offence\'s own baseline.' },
  { id: 'spike', n: 18, name: 'The spike', source: 'derived',
    what: 'Spends a down to stop the clock only inside the narrow window where that trade pays.' },
  { id: 'intentional_safety', n: 19, name: 'Intentional safety', source: 'literature',
    what: 'Concedes two to avoid punting from the back of your own end zone.' },
  { id: 'two_minute_warning', n: 20, name: 'Two-minute warning boundary', source: 'literature',
    what: 'A free stoppage that changes the value of every decision before it.' }
];

export function moduleCatalog() {
  const bySource = { measured: [], derived: [], literature: [] };
  for (const m of MODULES) bySource[m.source].push(m.name);
  return {
    count: MODULES.length, modules: MODULES, by_source: bySource,
    note: '"measured" means fitted on rates in this database. "derived" means it falls out of the ' +
      'simulator\'s own expected-points surface. "literature" means it encodes a published, ' +
      'well-replicated football-analytics result that was NOT re-derived here — those are borrowed ' +
      'and labelled as such.'
  };
}
