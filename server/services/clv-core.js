/**
 * The one CLV convention, shared — and, as of the stage-2 engine unification,
 * the one CLV ledger for manually- and auto-tracked straight bets too.
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
 * error) previously lived only in nfl-clv.js. It moved here unchanged in
 * stage 3, with nfl-clv.js re-exporting it so every caller kept working.
 *
 * Stage 2 of the later engine-unification pass went one step further:
 * nfl-clv.js was still scheduled AND still routed to directly (scheduler.js's
 * line-snapshot job, and nfl-betting.js's bet-log endpoints) for functions
 * this module's math never absorbed — `recordBet`, `closingConsensus`,
 * `gradeClosingLineValue`, `clvReport`, `listBets` and `clvBySource`, the
 * whole `nfl_bet_log` ledger. Keeping that file alive as a thin wrapper
 * around math that already lived here served no purpose, so those functions
 * move here too and nfl-clv.js is deleted outright — every former importer
 * (nfl-betting.js, scheduler.js, nfl-sharp.js) now points at this module
 * directly instead.
 *
 * What this module deliberately does NOT unify: nfl-prop-clv.js's CLV is a
 * probability DELTA (closing implied prob minus quoted implied prob) against
 * player-prop lines that settle on a stat, not a game margin — a genuinely
 * different measurement, not a duplicate of this one. It is left alone.
 */
import { rows, run } from '../db/index.js';
import { shinNoVig, proportionalNoVig } from './nfl-devig.js';
import './line-shopping.js';   // owns nfl_line_snapshots, read by closingConsensus below
import { isFreshQuote } from './book-feeds.js';

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

/* =========================================================================
 * The `nfl_bet_log` ledger — merged in from nfl-clv.js (see module header).
 *
 * Win rate cannot tell you much in a season. At a true 54% edge, 270 bets
 * still produce a losing record about one time in five, and a 50% coin flip
 * produces a winning one just as often. Waiting for the record to settle
 * means waiting several seasons to learn something you could have known in a
 * month. CLV is the shortcut: if a strategy consistently takes a number
 * better than where the market closes, it is extracting value from a market
 * that is more accurate than any model here (see docs/NFL_MODEL_STATUS.md),
 * and profit follows even when the short-run record looks bad.
 *
 * The measurement only works per *bet*. "The line moved toward us" is not
 * CLV unless it is attached to a number someone actually took, at a price, at
 * a time — which is why this keeps a ledger rather than scoring games.
 * ========================================================================= */

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Most frequent value, ties broken toward the median — the consensus number. */
const modal = a => {
  if (!a.length) return null;
  const counts = new Map();
  for (const v of a) counts.set(v, (counts.get(v) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return median([...counts].filter(([, c]) => c === top).map(([v]) => v));
};

/** The other side of a two-way market, so the pair can be de-vigged. */
function opposingSide(market, side, home, away) {
  if (market === 'totals') return side === 'Over' ? 'Under' : 'Over';
  return side === home ? away : home;
}

/**
 * Records a bet exactly as taken.
 *
 * Everything needed to grade CLV later has to be captured now: which number,
 * which price, which book, and when. Reconstructing it afterwards from "we
 * liked that game" is how CLV analysis quietly becomes fiction.
 */
export function recordBet({
  event_id, commence_time, home_team, away_team,
  market, side, line = null, price, book = null,
  stake_units = 1, source = 'model', model_edge = null, placed_at = null
}) {
  if (!event_id || !market || !side) return { error: 'event_id, market and side are required' };
  // Number(null) is 0, which is finite — so a missing price must be rejected
  // explicitly or it would be logged as even money and quietly corrupt the CLV.
  if (price == null || price === '' || !Number.isFinite(Number(price))) {
    return { error: 'a real American price is required — CLV without a price is meaningless' };
  }
  run(`INSERT INTO nfl_bet_log
      (placed_at, event_id, commence_time, home_team, away_team, market, side, line, price, book,
       stake_units, source, model_edge)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    placed_at ?? new Date().toISOString(), event_id, commence_time ?? null,
    home_team ?? null, away_team ?? null, market, side,
    line == null ? null : Number(line), Number(price), book,
    Number(stake_units) || 1, source, model_edge == null ? null : Number(model_edge));
  return rows('SELECT * FROM nfl_bet_log WHERE bet_id = last_insert_rowid()')[0];
}

/**
 * The market's consensus close for one side of one game.
 *
 * "Closing" is the last snapshot captured strictly before kickoff. Consensus is
 * the modal number across books and the median price at that number, rather
 * than the best available: CLV asks whether the bet beat where the *market*
 * settled, and the single most generous book is not the market. Using the best
 * price here would flatter every result.
 */
export function closingConsensus(eventId, market, side, commenceTime) {
  const cutoff = commenceTime ?? rows(
    'SELECT commence_time FROM nfl_line_snapshots WHERE event_id=? LIMIT 1', eventId)[0]?.commence_time;
  const at = rows(`SELECT MAX(captured_at) AS at FROM nfl_line_snapshots
                   WHERE event_id=? AND market=? ${cutoff ? 'AND captured_at < ?' : ''}`,
  ...(cutoff ? [eventId, market, cutoff] : [eventId, market]))[0]?.at;
  if (!at) return null;

  const quotes = rows(`SELECT side, line, price, book_updated_at FROM nfl_line_snapshots
                       WHERE event_id=? AND market=? AND captured_at=?`, eventId, market, at)
    .filter(q => isFreshQuote(at, q.book_updated_at));
  const ours = quotes.filter(q => q.side === side);
  if (!ours.length) return null;

  const line = modal(ours.map(q => q.line).filter(v => v != null));
  const atLine = line == null ? ours : ours.filter(q => q.line === line);
  const price = median(atLine.map(q => q.price).filter(v => v != null));

  return { captured_at: at, line, price, books: atLine.length, quotes };
}

/*
 * Turning line value into money.
 *
 * A spread bet taken at +3 that closes at +1.5 is not the same bet as the one
 * the market closed on, so comparing our price to the closing price scores it
 * as a loss of value when it was plainly a gain. The points have to be priced.
 *
 * `fairProbabilityOfOurBet` does that pricing: the market's close defines a
 * distribution for the game's margin, via a sigma taken from the market's own
 * historical error (measured over 2021-25 in docs/NFL_MODEL_STATUS.md — 12.66
 * points on margins, 13.08 on totals, not a figure picked to make the output
 * look good), and our number is evaluated against that distribution.
 */

/**
 * Grades every ungraded bet whose game has started.
 *
 * clv_pct is the expected return of the bet *assuming the closing line is the
 * truth*: fair closing probability times the decimal odds taken, minus one. A
 * positive number means the bet was priced better than the market's final
 * word — which is the definition of having beaten the close.
 */
export function gradeClosingLineValue({ now = new Date().toISOString() } = {}) {
  const pending = rows(`SELECT * FROM nfl_bet_log
                        WHERE graded_at IS NULL AND (commence_time IS NULL OR commence_time <= ?)`, now);
  let graded = 0, skipped = 0;
  for (const b of pending) {
    const close = closingConsensus(b.event_id, b.market, b.side, b.commence_time);
    if (!close || close.price == null) { skipped++; continue; }

    const other = opposingSide(b.market, b.side, b.home_team, b.away_team);
    const theirs = close.quotes.filter(q => q.side === other && (close.line == null || Math.abs(q.line ?? 0) === Math.abs(close.line)));
    const theirPrice = median(theirs.map(q => q.price).filter(v => v != null));
    const closeFair = noVigProbability(close.price, theirPrice);
    // Score the number we actually took, not the one the market closed on.
    const fair = fairProbabilityOfOurBet({
      market: b.market, ourLine: b.line, closeLine: close.line,
      closeFairProb: closeFair, side: b.side
    });

    const dec = americanToDecimal(b.price);
    const clvPct = fair == null || dec == null ? null : fair * dec - 1;

    // Points of line value, signed so positive is always better for the
    // bettor — the shared convention above: totals invert by side, an Under
    // wants the higher number, an Over the lower.
    const clvPoints = signedClvPoints({
      market: b.market, ourLine: b.line, closeLine: close.line, isUnder: b.side === 'Under'
    });

    run(`UPDATE nfl_bet_log SET closing_line=?, closing_price=?, closing_fair_prob=?,
           clv_points=?, clv_pct=?, graded_at=? WHERE bet_id=?`,
      close.line, close.price, r4(fair), r3(clvPoints), r4(clvPct), now, b.bet_id);
    graded++;
  }
  return { graded, skipped, pending: pending.length };
}

/**
 * The weekly verdict.
 *
 * Read `mean_clv_pct` first. Sustained positive CLV is evidence of edge even
 * with a losing record; sustained negative CLV means the strategy is paying the
 * market for the privilege, and no win streak redeems it.
 */
export function clvReport({ source = null, since = null } = {}) {
  const where = ['graded_at IS NOT NULL'];
  const params = [];
  if (source) { where.push('source = ?'); params.push(source); }
  if (since) { where.push('placed_at >= ?'); params.push(since); }
  const bets = rows(`SELECT * FROM nfl_bet_log WHERE ${where.join(' AND ')}`, ...params);

  const snaps = rows(`SELECT COUNT(DISTINCT captured_at) AS captures FROM nfl_line_snapshots`)[0];
  if (!bets.length) {
    return {
      available: false, bets: 0, captures: snaps?.captures ?? 0,
      note: (snaps?.captures ?? 0) < 2
        ? 'No CLV yet: fewer than two line captures exist, so there is no close to compare against. Schedule the nfl_line_snapshots job and CLV becomes measurable within a week of games.'
        : 'No graded bets yet. Record bets with recordBet() as they are placed; CLV grades automatically once each game kicks off.'
    };
  }

  const pcts = bets.map(b => b.clv_pct).filter(v => v != null);
  const pts = bets.map(b => b.clv_points).filter(v => v != null);
  const beat = pcts.filter(v => v > 0).length;
  const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const sd = a => (a.length > 1
    ? Math.sqrt(a.reduce((s, v) => s + (v - mean(a)) ** 2, 0) / (a.length - 1)) : null);

  // Is the average CLV distinguishable from zero, or is it just a small sample?
  const s = sd(pcts);
  const t = s && pcts.length ? mean(pcts) / (s / Math.sqrt(pcts.length)) : null;

  return {
    available: true,
    bets: bets.length,
    graded_with_clv: pcts.length,
    mean_clv_pct: r4(mean(pcts)),
    median_clv_pct: r4(median(pcts)),
    mean_clv_points: r3(mean(pts)),
    beat_close_rate: pcts.length ? r3(beat / pcts.length) : null,
    t_stat: r3(t),
    significant: t != null && Math.abs(t) >= 2,
    verdict: t == null || pcts.length < 25
      ? `Too few graded bets (${pcts.length}) to read yet — CLV usually becomes legible around 50.`
      : mean(pcts) > 0 && Math.abs(t) >= 2
        ? 'Positive and statistically distinguishable from zero. This is real evidence of edge, and it is worth more than the win/loss record over the same period.'
        : mean(pcts) > 0
          ? 'Positive but not yet distinguishable from zero. Encouraging, not proven — keep recording.'
          : 'Negative. The bets are consistently worse than where the market closes, which means this strategy is losing value on every wager regardless of results.'
  };
}

/** The ledger itself, newest first — ungraded bets included and visibly so. */
export function listBets({ limit = 200 } = {}) {
  return rows(`SELECT * FROM nfl_bet_log ORDER BY placed_at DESC, bet_id DESC LIMIT ?`, limit);
}

/** Per-source comparison, so a model can be judged against manual picks. */
export function clvBySource() {
  const srcs = rows('SELECT DISTINCT source FROM nfl_bet_log WHERE graded_at IS NOT NULL')
    .map(r => r.source);
  return srcs.map(s => ({ source: s, ...clvReport({ source: s }) }));
}
