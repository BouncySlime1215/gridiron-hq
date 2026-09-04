/**
 * Closing line value — the only fast, honest read on whether a strategy works.
 *
 * Win rate cannot tell you much in a season. At a true 54% edge, 270 bets still
 * produce a losing record about one time in five, and a 50% coin flip produces a
 * winning one just as often. Waiting for the record to settle means waiting
 * several seasons to learn something you could have known in a month.
 *
 * CLV is the shortcut. If you consistently take a number better than where the
 * market closes, you are extracting value from a market that is more accurate
 * than any model here (see docs/NFL_MODEL_STATUS.md) — and profit follows even
 * when the short-run record looks bad. If you do not, a hot streak proves
 * nothing. So CLV, not units, is what should be judged weekly.
 *
 * The measurement only works per *bet*. "The line moved toward us" is not CLV
 * unless it is attached to a number someone actually took, at a price, at a
 * time. That is why this keeps a ledger rather than scoring games.
 */
import { db, rows, run } from '../db/index.js';
import './line-shopping.js';   // owns nfl_line_snapshots, read below
import { isFreshQuote } from './book-feeds.js';
import { shinNoVig, proportionalNoVig } from './nfl-devig.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_bet_log (
    bet_id INTEGER PRIMARY KEY AUTOINCREMENT,
    placed_at TEXT NOT NULL,
    event_id TEXT NOT NULL, commence_time TEXT,
    home_team TEXT, away_team TEXT,
    market TEXT NOT NULL, side TEXT NOT NULL,
    line REAL, price INTEGER NOT NULL, book TEXT,
    stake_units REAL DEFAULT 1,
    source TEXT, model_edge REAL,
    closing_line REAL, closing_price INTEGER, closing_fair_prob REAL,
    clv_points REAL, clv_pct REAL, graded_at TEXT,
    result TEXT, units_won REAL
  );
  CREATE INDEX IF NOT EXISTS idx_betlog_event ON nfl_bet_log(event_id, market, side);
`);

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

export const americanToProb = o =>
  o == null || !Number.isFinite(o) ? null : (o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100));
export const americanToDecimal = o =>
  o == null || !Number.isFinite(o) ? null : (o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));

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
 * The market's close defines a distribution for the game's margin; our number
 * is then evaluated against that distribution. Sigma is the market's own
 * historical error, measured over 2021-25 in docs/NFL_MODEL_STATUS.md — 12.66
 * points on margins, 13.08 on totals — rather than a figure picked to make the
 * output look good.
 */
const SIGMA = { spreads: 12.66, totals: 13.08 };

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
 * Probability our exact bet wins, judged by where the market closed.
 *
 * For a moneyline there is no number to compare, so the de-vigged closing price
 * is the answer directly. For spreads and totals the closing line and price
 * together imply a distribution, and our number is scored against it — which is
 * what makes a better number show up as positive value.
 */
export function fairProbabilityOfOurBet({ market, ourLine, closeLine, closeFairProb, side }) {
  if (closeFairProb == null) return null;
  if (market === 'h2h' || ourLine == null || closeLine == null) return closeFairProb;
  const sigma = SIGMA[market];
  if (!sigma) return closeFairProb;

  // Recover the mean the closing number implies, allowing for a price that is
  // not exactly even money at that number.
  const z = normalInv(1 - closeFairProb);
  if (z == null) return closeFairProb;

  if (market === 'totals') {
    // Over wins above the number, Under below it.
    const mu = side === 'Under' ? closeLine + sigma * z : closeLine - sigma * z;
    return side === 'Under'
      ? normalCdf((ourLine - mu) / sigma)
      : 1 - normalCdf((ourLine - mu) / sigma);
  }
  // Spreads: `line` is quoted from the bettor's side, so the bet wins when
  // margin > -line. Positive (ourLine - closeLine) is always extra cushion.
  const mu = -closeLine - sigma * z;
  return 1 - normalCdf((-ourLine - mu) / sigma);
}

/**
 * Removes the bookmaker's margin from a two-sided market.
 *
 * Raw implied probabilities sum to more than 1 — that excess is the vig, and
 * comparing a bet price against a vigged probability would score every bet as
 * losing value. Shin's method (see nfl-devig.js) is the default here — it
 * corrects for the favorite-longshot bias a naive proportional split misses
 * on a skewed line. `proportionalNoVigProbability` below is kept, unused by
 * this module, for anything that wants to compare the two methods directly.
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

    // Points of line value, signed so positive is always better for the bettor.
    // Totals invert: an Under wants the higher number, an Over the lower.
    let clvPoints = null;
    if (b.line != null && close.line != null) {
      clvPoints = b.market === 'totals' && b.side === 'Under'
        ? b.line - close.line
        : b.market === 'totals'
          ? close.line - b.line
          : b.line - close.line;
    }

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
