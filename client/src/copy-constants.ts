/**
 * Copy shared across the app.
 *
 * `NOT_PROVEN_MESSAGE` used to live in the betting pages, which were removed
 * with the rest of the betting UI (the models behind them are untouched and
 * still run). The page-explain assistant is mounted app-wide and still needs
 * it, so it lives here rather than in a deleted folder.
 */
export const NOT_PROVEN_MESSAGE =
  "This model hasn't beaten the real betting lines yet, so no real money is at risk — everything below is practice, tracked so we'll know the moment that changes.";

const ROUND_WORDS: Record<number, string> = { 2: 'two', 3: 'three' };

/**
 * The playoff weeks the season sim actually played, from its `playoff_weeks`
 * field (league-rules.js, one array of NFL weeks per round). Null when the
 * field is absent, so a page never falls back to a guessed "weeks 15–17".
 */
export function playoffWeeksText(weeks: number[][] | null | undefined): string | null {
  if (!Array.isArray(weeks) || !weeks.length || !weeks.every(r => Array.isArray(r) && r.length)) return null;
  const flat = weeks.flat();
  const span = `NFL weeks ${Math.min(...flat)}–${Math.max(...flat)}`;
  const len = weeks[0].length;
  if (len === 1) return span;
  return `${span}, ${ROUND_WORDS[len] ?? len} weeks per round`;
}
