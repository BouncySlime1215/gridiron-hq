/**
 * Closing-line value for player props — the only evidence that can establish
 * a real betting edge.
 *
 * THE STATE OF THE QUESTION, precisely. Two claims get conflated as "the model
 * has no edge", and only one of them is established:
 *
 *   SPREADS — settled, negative. `game_lines` holds 15,096 closing spreads and
 *   totals back to 1999, all 21 component models have been measured against
 *   them, and 0 of 21 clear the materiality gate. That question is answered
 *   and should not be re-litigated.
 *
 *   PROPS — UNMEASURED. `nfl_prop_quote_snapshots` contains zero rows. The
 *   model has never once been compared to a real prop price. "No edge on
 *   props" is not a finding; it is an absence of data.
 *
 * That distinction matters because props are exactly where the model does have
 * demonstrable skill — 2+ touchdowns at +27.3% Brier skill, any-type TD at
 * +20.6%, rushing TD at +9.5%, all against each market's own climatology.
 * Whether that skill converts into money depends entirely on where books hang
 * the lines, which nobody here has ever looked at.
 *
 * Note what this does NOT assume: beating the market on average is not the
 * bar. A prop bettor needs only a findable subset where the model's number
 * differs from the line by more than the vig. Prop markets are also softer
 * than spreads — lower limits, less sharp money, hundreds of lines per week
 * priced semi-automatically — so the prior for finding such a subset is
 * meaningfully better than it is for sides and totals. That is a hypothesis,
 * and this module exists to test it rather than assert it.
 *
 * Closing-line value is the metric, not realised profit. CLV converges far
 * faster than win rate: whether you beat the closing number is knowable in
 * a few hundred bets, whereas separating a 2% ROI edge from variance takes
 * thousands. Positive median CLV is the standard evidence that a model is
 * finding real mispricing, and `MODEL_OPERATIONS.md` already names it as the
 * promotion requirement.
 */
import { db, rows, run } from '../db/index.js';
import { hasKey, events, playerProps, flattenProps, PROP_MARKETS } from './odds-api.js';
import { playerWeeks } from './nfl-pbp.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_prop_clv (
    captured_at TEXT NOT NULL, event_id TEXT NOT NULL, book TEXT NOT NULL,
    market TEXT NOT NULL, player TEXT NOT NULL, side TEXT NOT NULL,
    line REAL, american_price INTEGER NOT NULL,
    model_probability REAL, implied_probability REAL, edge REAL,
    season INTEGER, week INTEGER,
    closing_line REAL, closing_price INTEGER, clv_cents REAL,
    settled INTEGER NOT NULL DEFAULT 0, actual_value REAL, won INTEGER,
    PRIMARY KEY (captured_at, event_id, book, market, player, side)
  );
  CREATE INDEX IF NOT EXISTS idx_prop_clv_settle ON nfl_prop_clv(settled, season, week);
`);

/** American odds -> implied probability, and the no-vig pair. */
export const impliedFromAmerican = p => (p >= 0 ? 100 / (p + 100) : -p / (-p + 100));

/** Decimal price, for CLV in percentage terms. */
const decimalFromAmerican = p => (p >= 0 ? 1 + p / 100 : 1 + 100 / -p);

/**
 * Capture the current prop market. Idempotent per (capture, event, book,
 * market, player, side), so running it more often than the market moves
 * simply stores nothing new.
 *
 * Deliberately stores EVERY quote, not only the ones the model likes. Storing
 * only flagged bets would make the archive unusable for measuring calibration
 * across the whole market, and would bake this week's model into the record
 * of what the market offered.
 */
export async function capturePropMarket({ season, week, maxEvents = 12 } = {}) {
  if (!hasKey()) return { skipped: true, reason: 'no ODDS_API_KEY configured' };
  const capturedAt = new Date().toISOString();
  const list = (await events()) ?? [];
  const insert = db.prepare(`INSERT OR IGNORE INTO nfl_prop_clv
    (captured_at,event_id,book,market,player,side,line,american_price,season,week)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let stored = 0, seen = 0;
  for (const e of list.slice(0, maxEvents)) {
    let payload;
    try { payload = await playerProps(e.id, { markets: PROP_MARKETS }); } catch { continue; }
    if (!payload) continue;
    for (const q of flattenProps(payload)) {
      seen++;
      stored += insert.run(capturedAt, q.event_id, q.book, q.market, q.player, q.side,
        q.line ?? null, q.american_price, season ?? null, week ?? null).changes;
    }
  }
  return { captured_at: capturedAt, events: Math.min(list.length, maxEvents), quotes_seen: seen, stored };
}

/** Map a stored market key to the player-week field that settles it. */
const SETTLE_FIELD = {
  player_pass_yds: 'passing_yards',
  player_rush_yds: 'rushing_yards',
  player_reception_yds: 'receiving_yards',
  player_receptions: 'receptions'
};

/**
 * Settle captured quotes against real outcomes.
 *
 * Only over/under markets on a numeric line are settled here. Anytime-TD is
 * deliberately left for a separate pass because its settlement rule (rushing
 * plus receiving, excluding passing) is a real source of quiet error and
 * should not be buried in a loop that also handles yardage.
 */
export function settlePropQuotes({ season, week } = {}) {
  const pending = rows(`SELECT * FROM nfl_prop_clv
                        WHERE settled = 0 AND season = ? AND week = ?
                          AND market IN ('player_pass_yds','player_rush_yds','player_reception_yds','player_receptions')`,
  season, week);
  if (!pending.length) return { settled: 0, unmatched: 0, note: 'nothing pending for that week' };

  const actuals = new Map();
  for (const r of playerWeeks(season).filter(x => x.week === week)) {
    actuals.set(String(r.player_name ?? '').toLowerCase(), r.features);
  }
  const upd = db.prepare(`UPDATE nfl_prop_clv SET settled=1, actual_value=?, won=?
                          WHERE captured_at=? AND event_id=? AND book=? AND market=? AND player=? AND side=?`);
  let settled = 0, unmatched = 0;
  for (const q of pending) {
    const f = actuals.get(String(q.player).toLowerCase());
    if (!f) { unmatched++; continue; }
    const actual = f[SETTLE_FIELD[q.market]];
    if (!Number.isFinite(actual) || q.line == null) { unmatched++; continue; }
    // A push (exact line) is neither a win nor a loss; recorded as null.
    const won = actual === q.line ? null
      : /over/i.test(q.side) ? (actual > q.line ? 1 : 0) : (actual < q.line ? 1 : 0);
    upd.run(actual, won, q.captured_at, q.event_id, q.book, q.market, q.player, q.side);
    settled++;
  }
  return { settled, unmatched };
}

/**
 * The evidence report. Reports what is actually known, and says plainly when
 * that is nothing — an empty archive must read as "not yet measured", never
 * as "no edge found".
 */
export function propEdgeEvidence() {
  const total = rows(`SELECT COUNT(*) n FROM nfl_prop_clv`)[0].n;
  if (!total) {
    return {
      status: 'not_yet_measured',
      captured_quotes: 0,
      verdict: 'The model has never been compared to a real prop price. This is an absence of ' +
        'evidence, not evidence of absence — distinct from spreads, where 0 of 21 models beating ' +
        '15,096 closing lines is a genuine measured negative.',
      to_start: 'Set ODDS_API_KEY and let the nfl_prop_capture scheduler job run through a slate. ' +
        'Roughly 200 settled bets are needed before median CLV means anything.'
    };
  }
  const settled = rows(`SELECT * FROM nfl_prop_clv WHERE settled = 1 AND won IS NOT NULL`);
  const withClv = rows(`SELECT clv_cents FROM nfl_prop_clv WHERE clv_cents IS NOT NULL`).map(r => r.clv_cents);
  const median = a => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const wins = settled.filter(r => r.won === 1).length;
  const roi = settled.length
    ? settled.reduce((s, r) => s + (r.won === 1 ? decimalFromAmerican(r.american_price) - 1 : -1), 0) / settled.length
    : null;
  return {
    status: settled.length >= 200 ? 'measurable' : 'accumulating',
    captured_quotes: total,
    settled_bets: settled.length,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    roi: roi == null ? null : +roi.toFixed(4),
    median_clv_cents: median(withClv),
    breakeven_note: 'At standard -110 pricing the break-even win rate is 52.4%.',
    verdict: settled.length < 200
      ? `Only ${settled.length} settled bets. Below ~200 this cannot separate edge from variance; keep accumulating.`
      : 'Sample is large enough to read. Median CLV is the primary signal; ROI is noisier and secondary.'
  };
}

export function propClvStatus() {
  const x = rows(`SELECT COUNT(*) quotes, COUNT(DISTINCT captured_at) captures,
                         COUNT(DISTINCT event_id) events, SUM(settled) settled,
                         MIN(captured_at) first, MAX(captured_at) latest
                  FROM nfl_prop_clv`)[0];
  return { ...x, has_key: hasKey() };
}
