/**
 * A PERCENTAGE THAT MAY NEVER READ AS CERTAIN.
 *
 * Some quantities in this app are guaranteed by their producer to be neither 0
 * nor 1, and the guarantee is not enough on its own. At one decimal place
 * 0.9999 renders "100.0%" and 0.00004 renders "0.0%": the value obeys the
 * promise and the screen still tells a manager his season is decided in week 3.
 *
 * So the clamp is on the RENDERED STRING, and it lives here rather than in the
 * two places that need it. `formatValue` applies it for any glossary entry
 * marked `neverCertain`, and the league-outlook panel applies it to the
 * probability the outlook route sends. One implementation, because two would
 * drift and only one of them would be the one on screen.
 *
 * Decided by rounding first and then asking whether the result is one of the
 * two claims that may not be made. A hand-chosen epsilon instead would clamp a
 * number that renders fine and miss one that does not.
 *
 * Returns null for anything that is not a finite number, so the caller renders
 * its own missing state rather than a zero — a missing number and a zero are
 * different facts and this project has shipped the bug where they looked the
 * same.
 */
export function percentText(value, precision = 1, { neverCertain = false } = {}) {
  if (value == null || !Number.isFinite(value)) return null;
  const shown = (value * 100).toFixed(precision);
  if (!neverCertain) return `${shown}%`;
  const step = Math.pow(10, -precision);
  if (Number(shown) >= 100) return `above ${(100 - step).toFixed(precision)}%`;
  if (Number(shown) <= 0) return `below ${step.toFixed(precision)}%`;
  return `${shown}%`;
}
