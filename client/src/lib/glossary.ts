/**
 * ONE RECORD PER QUANTITY. Every label the app prints reads from here.
 *
 * The reason is a live defect, not a style preference. `floor` currently means
 * the 10th percentile of a single week in the trade engine and the 20th
 * percentile of a season on the career line, and both appear on one screen under
 * one word. A manager reading "floor 8.1" and "floor 11.4" has no way to know
 * those are different questions. A label written inline in a component is how
 * that happened, so a label written inline in a component is a bug.
 *
 * Each entry carries five things, and the last three are the ones that usually
 * go missing:
 *
 *   name       what a manager reads
 *   plain      one sentence, no statistics vocabulary (see BANNED below)
 *   raw        the server field or column this actually is, so the deep dive can
 *              show it as a footnote and an engineer can grep it
 *   unit       so a percentage never renders next to a points-per-game number
 *              with the same styling
 *   precision  decimal places. Fixed per quantity, because "8.1" and "8.13" on
 *              the same page read as two different measurements.
 *
 * WHAT THIS FILE IS NOT: it is not a place to state what a number means to your
 * team. "Good" and "bad" belong to the page. This file says what was measured.
 */

/**
 * Words that are never allowed in a `plain` sentence.
 *
 * Nick's rule, verbatim: explanations that "make sense to someone who never
 * deals with stats. Detailed but not like wtf." These are the words that read as
 * rigour to the person who wrote them and as noise to everyone else. The test
 * enforces this list, which is the only reason it stays true.
 */
export const BANNED_WORDS = [
  'percentile', 'distribution', 'prior', 'shrinkage', 'calibrated', 'variance',
  'posterior', 'quantile', 'stochastic', 'heteroskedastic', 'regression'
] as const;

/**
 * `percent` means the SERVER SENDS A FRACTION. Every percentage in this app
 * arrives 0-1 (`p_active`, `title_odds`, `title_delta`) and `formatValue`
 * multiplies. A server field that ever arrives already in percent must not be
 * given this unit, or it renders a hundred times too large — which is the kind
 * of error that looks like a model bug for a week.
 */
export type Unit = 'points' | 'points_per_game' | 'percent' | 'count' | 'rank' | 'weeks' | 'none';

export interface Term {
  /** What a manager reads. Sentence case, never a column name. */
  name: string;
  /** One sentence, plain words, no word from BANNED_WORDS. */
  plain: string;
  /** The server field this is. Shown only at the bottom of a deep dive. */
  raw: string;
  unit: Unit;
  /** Decimal places when this renders as a number. */
  precision: number;
  /**
   * This quantity may never render as 0% or 100%, whatever it rounds to.
   *
   * Its producer guarantees the value is neither, and that guarantee does not
   * survive rounding: at one decimal 0.9999 renders "100.0%". A screen saying
   * a season is decided in week 3 is a stronger claim than any model here
   * makes. Set on the entry rather than applied at a call site, so every
   * surface showing the quantity gets it.
   */
  neverCertain?: boolean;
}

/**
 * The terms, keyed by a stable id that components import by name.
 *
 * Keys are the id, NOT the raw column, precisely because two ids can share a raw
 * column shape and one raw name can mean two things — which is the `floor`
 * collision this file exists to end. Both floors are here, separately, under
 * names that say which is which.
 */
export const GLOSSARY = {
  projected_points: {
    name: 'Projected points',
    plain: 'What we expect this player to score this week, as a typical week rather than a best or worst case.',
    raw: 'projection.mean',
    unit: 'points', precision: 1
  },
  week_floor: {
    name: 'Quiet week',
    plain: 'A week that goes badly for this player but not catastrophically — about one week in ten looks like this or worse.',
    raw: 'projection.p10',
    unit: 'points', precision: 1
  },
  week_ceiling: {
    name: 'Big week',
    plain: 'A week that goes well for this player — about one week in ten looks like this or better.',
    raw: 'projection.p90',
    unit: 'points', precision: 1
  },
  season_floor: {
    name: 'Quiet season',
    plain: 'How the rest of the season looks if this player disappoints — about one season in five ends up here or lower.',
    raw: 'career.p20',
    unit: 'points_per_game', precision: 1
  },
  chance_to_play: {
    name: 'Chance to play',
    plain: 'How likely this player is to be active on Sunday, from the injury report and how often he has played before.',
    raw: 'availability.p_active',
    unit: 'percent', precision: 0
  },
  title_odds: {
    name: 'Title chance',
    plain: 'How often your team wins the championship when we play the rest of the season out thousands of times.',
    raw: 'sim.title_odds',
    unit: 'percent', precision: 1
  },
  playoff_odds: {
    name: 'Playoff chance',
    plain: 'How often your team makes the playoffs when we play the rest of the season out thousands of times.',
    raw: 'sim.playoff_odds',
    unit: 'percent', precision: 1
  },
  /**
   * NOT the same number as `playoff_odds`, and separate for exactly the reason
   * this file exists. That one plays the rest of the season out thousands of
   * times. This one is a model fitted on finished seasons reading the season so
   * far. Two methods, two answers, and putting them under one name is the
   * `floor` collision again.
   */
  outlook_probability: {
    name: 'Chance to qualify',
    plain: 'How often teams in this position have gone on to make the playoffs, from finished seasons we can check.',
    raw: 'outlook.probability',
    unit: 'percent', precision: 1, neverCertain: true
  },
  title_delta: {
    name: 'Change in title chance',
    plain: 'How much this move moves your championship number, with the same simulated seasons run before and after so the difference is the move and not luck.',
    raw: 'trade_impact.title_delta',
    unit: 'percent', precision: 1
  },
  expected_wins: {
    name: 'Expected wins',
    plain: 'How many games your team wins in a typical run of the rest of the season.',
    raw: 'sim.expected_wins',
    unit: 'count', precision: 1
  },
  start_score: {
    name: 'Start score',
    plain: 'How strongly we want this player in your lineup this week, after his chance to play is taken into account.',
    raw: 'lineup.score',
    unit: 'points', precision: 1
  },
  accept_chance: {
    name: 'Chance they say yes',
    plain: 'How likely this manager is to accept this offer, from what you have told us about how they trade and any offers they have actually answered.',
    raw: 'counterparty.accept',
    unit: 'percent', precision: 0
  },
  shotgun_rate: {
    name: 'Shotgun rate',
    plain: 'How often this offence lines the quarterback up several yards behind the ball, out of the plays the source tagged.',
    raw: 'nfl_play_by_play.shotgun',
    unit: 'percent', precision: 0
  },
  no_huddle_rate: {
    name: 'No-huddle rate',
    plain: 'How often this offence snaps the ball without stopping to huddle first.',
    raw: 'nfl_play_by_play.no_huddle',
    unit: 'percent', precision: 0
  },
  deep_rate: {
    name: 'Deep throw rate',
    plain: 'How often this offence throws the ball far down the field rather than short.',
    raw: "nfl_play_by_play.pass_depth = 'deep'",
    unit: 'percent', precision: 0
  },
  points_allowed_to_position: {
    name: 'Given up to this position',
    plain: 'What this defence has actually given up to players at this position so far. It is what happened, not what we expect next.',
    raw: 'matchups.dvp.ppg_allowed',
    unit: 'points_per_game', precision: 1
  }
} as const satisfies Record<string, Term>;

export type TermId = keyof typeof GLOSSARY;

/** The record for an id. Throws on an unknown id rather than rendering the id. */
export function term(id: TermId): Term {
  const t = GLOSSARY[id];
  if (!t) throw new Error(`no glossary entry for "${id}" — add one rather than writing the label inline`);
  return t;
}

import { percentText } from './percent.js';

const SUFFIX: Record<Unit, string> = {
  points: '', points_per_game: '/g', percent: '%', count: '', rank: '', weeks: ' wk', none: ''
};

/**
 * A number formatted the way its quantity is always formatted.
 *
 * `null` renders as an em dash, never as 0 or as an empty cell. A missing number
 * and a zero are different facts and this project has shipped the bug where they
 * looked the same.
 */
export function formatValue(
  id: TermId,
  value: number | null | undefined,
  { signed = false }: { signed?: boolean } = {}
): string {
  const t = term(id);
  if (value == null || !Number.isFinite(value)) return '—';
  // A quantity that may never read as certain is clamped on the rendered
  // string, in one place, so every surface showing it gets the same answer.
  if (t.neverCertain && t.unit === 'percent') {
    return percentText(value, t.precision, { neverCertain: true }) ?? '—';
  }
  const scaled = t.unit === 'percent' ? value * 100 : value;
  const sign = signed && scaled > 0 ? '+' : '';
  return sign + scaled.toFixed(t.precision) + SUFFIX[t.unit];
}
