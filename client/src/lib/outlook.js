/**
 * THE LEAGUE OUTLOOK PANEL'S DECISIONS, as plain JavaScript so they are tested
 * by being called rather than by reading source text.
 *
 * `GET /api/leagues/:id/outlook` answers in one of two shapes. Not ready is
 * `{ ready: false, reason }` where the reason is a finished sentence to print
 * as it arrives. Ready carries a fitted model's read on every team, and three
 * of its rules are the sort that look like formatting and are not:
 *
 *   - a probability is never 0 and never 1, and must never RENDER as 0% or
 *     100% either;
 *   - the verdict `act` is never served and must never be synthesised here;
 *   - the decomposition's three parts are shown in the server's stated order.
 *
 * Nothing in this file touches the DOM or React.
 */
import { percentText } from './percent.js';

/** The verdicts the server can send. `act` is deliberately not among them. */
const VERDICTS = {
  fine: { label: 'Fine', plain: 'Nothing here needs your attention this week.' },
  watch: { label: 'Watch', plain: 'Worth keeping an eye on. Not a reason to do anything yet.' },
  act_candidate: {
    label: 'Worth a look',
    plain: 'This is where a move would matter most. Whether one is actually available is a different question, and this panel does not answer it.'
  }
};

/**
 * WHY THERE IS NO "ACT".
 *
 * The obvious next step from `act_candidate` is a panel that says "act", and it
 * is wrong. Act means a specific move exists that raises these odds, and only a
 * caller holding the trade engine's best move can know that. A panel that
 * upgraded the label on its own would be telling a manager to do something
 * without having found anything for him to do.
 */
export function verdictOf(verdict) {
  return VERDICTS[verdict] ?? null;
}

/**
 * A probability as text, clamped at the ENDS OF THE STRING rather than the
 * value.
 *
 * The payload guarantees the number is never exactly 0 or 1, and that is not
 * enough: at one decimal place 0.9999 rounds to "100.0%" and 0.00004 rounds to
 * "0.0%". The guarantee would survive and the screen would still say a season
 * is decided in week 3. So the rendered string is clamped, and it says which
 * side it is on rather than pretending to a precision it does not have.
 *
 * Returns null for a value that is not a number, so a caller renders its own
 * missing state instead of a zero.
 */
export function probabilityText(p, precision = 1) {
  return percentText(p, precision, { neverCertain: true });
}

/**
 * The decomposition's parts, in the order the server stated.
 *
 * `order` exists because the three parts are not equally important in every
 * league and the server knows which dominates. Rendering them in a fixed order
 * would quietly put the biggest one last in half the leagues.
 *
 * `real` is a REMAINDER — what is left after luck and noise are taken out — not
 * a separately measured quantity, and `real_is` carries the server's sentence
 * saying so. A panel that showed the three as equals would be claiming a
 * measurement that was never made.
 *
 * `no_results_yet` is the same model with the result features neutral. It is
 * NOT a preseason forecast, and calling it one on screen would be inventing a
 * comparison the server did not run.
 */
const PART_LABELS = {
  luck: 'Luck',
  noise: 'Not yet separable',
  real: 'The team itself'
};

export function decompositionParts(d) {
  if (!d) return [];
  const order = Array.isArray(d.order) && d.order.length ? d.order : ['real', 'luck', 'noise'];
  return order
    .filter(key => key in PART_LABELS)
    .map(key => ({
      key,
      label: PART_LABELS[key],
      value: Number.isFinite(d[key]) ? d[key] : null,
      // Only `real` carries a caveat, and only because the server sent one.
      note: key === 'real' ? (d.real_is ?? null) : null
    }));
}

/**
 * Whether the panel may show the decomposition at all.
 *
 * With no weeks played the three parts are a split of nothing. The server can
 * still send them; showing them would be a chart of zero.
 */
export function showsDecomposition(outlook) {
  return (outlook?.weeks_played ?? 0) > 0 && !!outlook?.teams?.some(t => t.decomposition);
}
