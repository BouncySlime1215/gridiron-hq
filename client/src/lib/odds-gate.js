/**
 * THE ODDS GATE'S DECISIONS, as plain JavaScript so they can actually be tested.
 *
 * Everything else in this vocabulary is checked by reading source text, because
 * this repository's test suite is `node:test` with no build step and cannot
 * import a `.tsx` module. That limit is acceptable for a component's markup and
 * unacceptable here: which of three states the gate is in, and what layer 4
 * says the grading found, are decisions, not rendering. A source-text test
 * cannot tell whether two states have quietly collapsed into one.
 *
 * So the decisions live here, in a file node can import and call, and
 * `components/ui/OddsGate.tsx` renders what they return. Nothing in this file
 * touches the DOM or React.
 *
 * WHY THERE IS A GATE AT ALL: the playoff-odds simulation was graded on 184,959
 * real team-weeks across 2,500 Sleeper leagues, 2021-2025. Before week 4 it
 * scores WORSE than telling every team its league's base rate, and at every
 * week it is overconfident at both ends — teams given no chance qualify about
 * 12% of the time, teams called certain miss about 10%. A number that loses to
 * the base rate is worse than no number, because a manager acts on it.
 */

/**
 * @typedef {{ brier?: number, base_rate?: number }} WeekGrade
 * @typedef {{ graded_team_weeks?: number, corpus?: string, source?: string,
 *   by_week?: Record<string, WeekGrade>, measured_on?: string,
 *   extremes?: { no_chance_qualify_rate?: number, certain_miss_rate?: number },
 *   not_graded?: string }} Calibration
 * @typedef {{ published: boolean, min_week: number, weeks_played: number,
 *   reason: string|null, calibration?: Calibration|null }} OddsGate
 */

/** One plain sentence for what a Brier score is. Said wherever one is shown. */
export const BRIER_IN_WORDS =
  'a score for how close the percentages came to what actually happened, where '
  + 'lower is better and 0.25 is what you get by saying 50% to everything';

/**
 * Which of the three states a gate is in.
 *
 * `weeks_played === 0` is checked FIRST and on its own. A gate that only asked
 * `published` would fold "no games at all" into "not enough games" and lose the
 * distinction that matters most to someone two weeks into a season: the odds
 * standing on zero results are a preseason projection that has not been told
 * anything about the football he has been watching. That is also what League
 * Hub sends today — `MyTeam.tsx` requests the simulation with no `from_week`.
 *
 * Zero results beats `published: true` if a payload ever says both. A gate
 * contradicting itself should resolve to the reading that shows less.
 *
 * No gate served at all means nothing is being withheld, so an older server
 * cannot blank the page.
 *
 * @param {OddsGate|null|undefined} gate
 * @returns {'no_results'|'too_early'|'published'}
 */
export function gateState(gate) {
  if (!gate) return 'published';
  if ((gate.weeks_played ?? 0) === 0) return 'no_results';
  return gate.published ? 'published' : 'too_early';
}

/**
 * LAYER 4 OF THE DEEP DIVE: what graded this number, and what the grading said.
 *
 * This sentence used to read "this championship number has never been scored
 * against real finished seasons". That was true when it was written and is no
 * longer. The replacement is narrower and more useful, and it has four parts;
 * dropping any one turns it into a different claim:
 *
 *   1. the inputs were graded walk-forward, week by week — real work, and a
 *      layer 4 that only ever says "untested" stops being read;
 *   2. the playoff odds themselves were graded, on a stated corpus and a
 *      stated number of team-weeks;
 *   3. what that grading FOUND — worse than a base rate before the threshold,
 *      and overconfident at both ends at every week;
 *   4. that this app's own configuration was not among what was graded.
 *
 * Part 4 is the one most likely to be cut for length, and it is the difference
 * between "this number is graded" and "a number like this one is graded".
 *
 * With no calibration in the payload it understates rather than inventing.
 *
 * @param {OddsGate|null|undefined} gate
 * @returns {string}
 */
export function gradedSentence(gate) {
  const base = 'The weekly player projections underneath this were checked by replaying past '
    + 'seasons week by week and grading each prediction on the week it was for.';
  const c = gate?.calibration;
  if (!c?.graded_team_weeks) {
    return `${base} This championship number itself has not been scored against real finished `
      + 'seasons here. Read it as a considered estimate, not as a measured frequency.';
  }
  const weeks = c.graded_team_weeks.toLocaleString('en-US');
  const w = gate?.min_week ?? 4;
  const early = c.by_week?.[String(Math.max(2, w - 2))];
  const score = early?.brier != null && early?.base_rate != null
    ? ` Early in a season it scored ${early.brier.toFixed(4)} against ${early.base_rate.toFixed(4)} `
      + `for that simpler answer — ${BRIER_IN_WORDS}.`
    : '';
  const e = c.extremes;
  const ends = e?.no_chance_qualify_rate != null && e?.certain_miss_rate != null
    ? ' At every week it is too sure of itself at the two ends: teams given no chance got there '
      + `${Math.round(e.no_chance_qualify_rate * 100)}% of the time, and teams called certain missed `
      + `${Math.round(e.certain_miss_rate * 100)}% of the time.`
    : '';
  const notGraded = c.not_graded ? ` One thing that grading did not cover: ${c.not_graded}` : '';
  // `measured_on` is the as-of of the GRADE, not of the data underneath, and it
  // belongs beside the grade rather than in the headline. A grading is a
  // measurement like any other in this app: it was taken on a day, and it can
  // go stale without anything on screen changing.
  const measured = c.measured_on ? `, measured ${c.measured_on}` : '';
  return `${base} The playoff side of this simulation has also been graded directly, on ${weeks} `
    + `real team-weeks${c.corpus ? ` from ${c.corpus}` : ''}${measured}. Before week ${w} it did worse than `
    + `simply telling every team the same number.${score}${ends}${notGraded}`;
}

/**
 * The sentence shown in place of a percentage, when the payload carries no
 * reason of its own. The server's own `reason` always wins — a page that
 * paraphrases what it was told is a second place for the claim to drift.
 *
 * @param {'no_results'|'too_early'|'published'} state
 * @param {number} minWeek
 */
export function withheldReason(state, minWeek) {
  if (state === 'no_results') {
    return 'These odds were worked out before the season started and have not been told anything '
      + 'about the games played since, so they are not about the team you have been watching.';
  }
  return `We checked how well these odds have done in the past, and before week ${minWeek} they do `
    + 'worse than simply telling every team the same number. So we are not showing one yet.';
}
