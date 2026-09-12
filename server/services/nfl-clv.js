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
import { rows, run } from '../db/index.js';
import './line-shopping.js';   // owns nfl_line_snapshots, read below
import { isFreshQuote } from './book-feeds.js';
import {
  americanToProb, americanToDecimal, noVigProbability, proportionalNoVigProbability,
  fairProbabilityOfOurBet, signedClvPoints
} from './clv-core.js';

// nfl_bet_log and idx_betlog_event come from
// server/migrations/000_legacy_schema.js.

// Audit-consolidation stage 3 (Giant Plan 8.1): the de-vig, sigma-adjusted
// fair-probability math below used to be defined here and nfl-sharp.js
// imported it from this file. It now lives in clv-core.js as the one shared
// implementation; these are re-exports so every existing caller (this
// file's own gradeClosingLineValue below, nfl-sharp.js, and anything else
// that imports them from 'nfl-clv.js') keeps working unchanged.
export { americanToProb, americanToDecimal, noVigProbability, proportionalNoVigProbability, fairProbabilityOfOurBet };

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

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
 * `fairProbabilityOfOurBet` (re-exported above from clv-core.js) does that
 * pricing: the market's close defines a distribution for the game's margin,
 * via a sigma taken from the market's own historical error (measured over
 * 2021-25 in docs/NFL_MODEL_STATUS.md — 12.66 points on margins, 13.08 on
 * totals, not a figure picked to make the output look good), and our number
 * is evaluated against that distribution.
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
    // bettor. The shared clv-core.js convention: totals invert by side, an
    // Under wants the higher number, an Over the lower.
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
