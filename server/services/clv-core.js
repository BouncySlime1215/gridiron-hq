/**
 * The one CLV convention, shared.
 *
 * Giant Plan 8.1 (audit-consolidation stage 3): four modules had each grown
 * their own closing-line-value math —
 *
 *   nfl-clv.js            de-vigs with Shin, prices the exact line via a
 *                          sigma-adjusted normal model, grades `nfl_bet_log`.
 *   nfl-execution-clv.js   reads the immutable quote tape for one exact
 *                          contract, grades accepted positions.
 *   forward-ledger.js      grades pre-registered picks against `game_lines`'
 *                          single closing number.
 *   shadow-ledger.js       grades paper-traded decisions the same way.
 *
 * All four already agreed, independently, on the POINTS sign convention
 * (verified by reading every one of them for this consolidation): a spread's
 * `line` is always expressed from the backed side's own perspective, so
 * `ourLine - closeLine` is positive exactly when the bettor got the better
 * number; a total inverts by side, because a higher number helps Under and
 * hurts Over. That convention is `signedClvPoints` below — one function
 * instead of four copies of the same three-way ternary.
 *
 * The FAIR-PROBABILITY math (de-vig a two-sided close, then price an exact
 * line that differs from the close through the market's own historical
 * error) previously lived only in nfl-clv.js, and nfl-sharp.js already
 * imported it from there. It moves here unchanged; nfl-clv.js now re-exports
 * it so every existing caller keeps working.
 *
 * What this module deliberately does NOT unify: nfl-prop-clv.js's CLV is a
 * probability DELTA (closing implied prob minus quoted implied prob) against
 * player-prop lines that settle on a stat, not a game margin — a genuinely
 * different measurement, not a duplicate of this one. It is left alone.
 */
import { rows, run } from '../db/index.js';
import { shinNoVig, proportionalNoVig } from './nfl-devig.js';

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

export const americanToProb = o =>
  o == null || !Number.isFinite(o) ? null : (o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100));
export const americanToDecimal = o =>
  o == null || !Number.isFinite(o) ? null : (o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));

/**
 * Points of closing line value, signed so positive is always better for the
 * bettor — the one convention nfl-clv.js, nfl-execution-clv.js,
 * forward-ledger.js and shadow-ledger.js each computed on their own.
 *
 * `market` may be spelled 'spread'/'spreads' or 'total'/'totals' (every
 * caller uses one or the other); only the 'total'/'totals' prefix matters,
 * matched case-insensitively so any caller's spelling works. `isUnder` marks
 * a totals bet on the Under side — callers pass whatever boolean test their
 * own `side` field needs (`side === 'Under'`, `/under/i.test(side)`, etc.),
 * since the side is spelled differently in every ledger.
 */
export function signedClvPoints({ market, ourLine, closeLine, isUnder = false }) {
  if (!Number.isFinite(ourLine) || !Number.isFinite(closeLine)) return null;
  if (/^total/i.test(String(market ?? ''))) {
    // Under wants the higher number (more room to stay under); Over wants
    // the lower one.
    return isUnder ? ourLine - closeLine : closeLine - ourLine;
  }
  // Spread (and moneyline handicaps, if ever priced with a line): both lines
  // are already expressed from the backed side's own perspective, so a
  // larger number is unambiguously better with no side-based inversion.
  return ourLine - closeLine;
}

/**
 * The market's historical error on its own close, in points — measured over
 * 2021-25 in docs/NFL_MODEL_STATUS.md, not a figure picked to flatter a
 * result. Ported unchanged from nfl-clv.js.
 */
const SIGMA = { spreads: 12.66, totals: 13.08, spread: 12.66, total: 13.08 };

/** Abramowitz-Stegun normal CDF; accurate to ~7 decimal places, no dependency. */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
    t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
/** Inverse normal CDF (Acklam), for recovering the mean the close implies. */
function normalInv(p) {
  if (p <= 0 || p >= 1) return null;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

/**
 * Removes the bookmaker's margin from a two-sided market. Shin's method is
 * the default — it corrects for the favorite-longshot bias a naive
 * proportional split misses on a skewed line — `proportionalNoVigProbability`
 * is kept for anything that wants to compare the two methods directly.
 * Ported unchanged from nfl-clv.js; nfl-sharp.js already depends on this.
 */
export function noVigProbability(ourPrice, theirPrice) {
  if (theirPrice == null) return americanToProb(ourPrice); // one-sided quote: best available is the raw implied
  return shinNoVig(ourPrice, theirPrice);
}

/** The legacy proportional-split method, kept only for side-by-side comparison. */
export function proportionalNoVigProbability(ourPrice, theirPrice) {
  if (theirPrice == null) return americanToProb(ourPrice);
  return proportionalNoVig(ourPrice, theirPrice);
}

/**
 * Probability our exact bet wins, judged by where the market closed. For a
 * moneyline there is no number to compare, so the de-vigged closing price is
 * the answer directly. For spreads and totals the closing line and price
 * together imply a distribution, and our number is scored against it — which
 * is what makes a better number show up as positive value. Ported unchanged
 * from nfl-clv.js; nfl-sharp.js already depends on this.
 */
export function fairProbabilityOfOurBet({ market, ourLine, closeLine, closeFairProb, side }) {
  if (closeFairProb == null) return null;
  if (market === 'h2h' || ourLine == null || closeLine == null) return closeFairProb;
  const sigma = SIGMA[market];
  if (!sigma) return closeFairProb;

  const z = normalInv(1 - closeFairProb);
  if (z == null) return closeFairProb;

  if (/^total/i.test(market)) {
    const mu = side === 'Under' ? closeLine + sigma * z : closeLine - sigma * z;
    return side === 'Under'
      ? normalCdf((ourLine - mu) / sigma)
      : 1 - normalCdf((ourLine - mu) / sigma);
  }
  const mu = -closeLine - sigma * z;
  return 1 - normalCdf((-ourLine - mu) / sigma);
}

/**
 * The reference-book policy for a NEW consumer of this module: when a close
 * is built as a consensus across books, the book the position was actually
 * accepted/executed at is excluded by default. Including it lets a position
 * partly close against its own quote, which biases the measured CLV toward
 * zero. Existing callers with their own already-declared, already-tested
 * book policy (nfl-execution-clv.js's `DEFAULT_CLOSING_BOOKS = null`, kept
 * deliberately as "every book present in the tape" — see that file) are
 * unaffected; this is the default for anything reaching for one for the
 * first time, and is available to existing callers as an opt-in.
 */
export function referenceBookQuotes(quotes, { executionBook = null, bookKey = 'bookmaker_key' } = {}) {
  if (!executionBook) return quotes;
  return quotes.filter(q => q[bookKey] !== executionBook);
}

/**
 * Records one CLV grade into the append-only `nfl_clv_grades` ledger
 * (migration 037). Deliberately a separate, explicit call rather than a side
 * effect of computing a report — a report stays safe to call as often as
 * reading anything else, and a grade is written only when something asks
 * for one to be recorded. Idempotent per (subject, grading_version): calling
 * this again for the same graded thing under the same grading_version is a
 * no-op (INSERT OR IGNORE on a deterministic id); a genuinely new
 * `grading_version` records a new row rather than overwriting the old one,
 * exactly as migration 037 requires.
 */
export function recordClvGrade({
  decisionEventId = null, opportunityId = null, gradingVersion, bookSet,
  quoteIds = [], pointClv = null, priceClvProbability = null, closeSource, note = null
} = {}) {
  if (!gradingVersion) throw new Error('recordClvGrade requires gradingVersion');
  if (!closeSource) throw new Error('recordClvGrade requires closeSource');
  if (decisionEventId == null && opportunityId == null) {
    throw new Error('recordClvGrade requires decisionEventId or opportunityId');
  }
  const id = `${opportunityId ?? `decision:${decisionEventId}`}:${gradingVersion}`;
  const result = run(`INSERT OR IGNORE INTO nfl_clv_grades
      (id, decision_event_id, opportunity_id, grading_version, book_set, quote_ids,
       point_clv, price_clv_probability, close_source, note)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
  id, decisionEventId, opportunityId, gradingVersion,
  JSON.stringify(bookSet ?? null), JSON.stringify(quoteIds ?? []),
  r3(pointClv), r4(priceClvProbability), closeSource, note);
  return { id, inserted: !!result.changes };
}

/** The grades recorded so far for one opportunity, newest grading_version last. */
export function clvGradesForOpportunity(opportunityId) {
  return rows(`SELECT * FROM nfl_clv_grades WHERE opportunity_id = ? ORDER BY created_at`, opportunityId);
}
