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
import { hasKey, events, playerProps, flattenAllProps, PROP_MARKETS, usage } from './odds-api.js';
import { playerWeeks } from './nfl-pbp.js';
import { projectWeek } from './nfl-props.js';

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

const quoteCols = new Set(db.prepare('PRAGMA table_info(nfl_prop_clv)').all().map(c => c.name));
for (const [column, type] of [
  ['commence_time', 'TEXT'], ['home_team', 'TEXT'], ['away_team', 'TEXT'],
  ['closing_fair_probability', 'REAL'], ['clv_probability', 'REAL']
]) {
  if (!quoteCols.has(column)) db.exec(`ALTER TABLE nfl_prop_clv ADD COLUMN ${column} ${type}`);
}

/** American odds -> implied probability, and the no-vig pair. */
export const impliedFromAmerican = p => (p >= 0 ? 100 / (p + 100) : -p / (-p + 100));

/** Decimal price, for CLV in percentage terms. */
const decimalFromAmerican = p => (p >= 0 ? 1 + p / 100 : 1 + 100 / -p);
const HOUR = 3600e3;
export const PROP_CAPTURE_HORIZONS_HOURS = Object.freeze([24, 1]);
const PROP_CREDIT_RESERVE = 50;

const normalizeName = value => String(value ?? '').toLowerCase()
  .replace(/[^a-z ]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
  .replace(/\s+/g, ' ').trim();

const MARKET_STAT = {
  player_pass_yds: 'pass_yds', player_rush_yds: 'rush_yds',
  player_reception_yds: 'rec_yds', player_receptions: 'receptions',
  player_anytime_td: 'any_td'
};

export function noVigPropProbability(ownPrice, oppositePrice) {
  const own = impliedFromAmerican(ownPrice);
  if (!Number.isFinite(oppositePrice)) return own;
  const opposite = impliedFromAmerican(oppositePrice);
  return own + opposite > 0 ? own / (own + opposite) : null;
}

function attachFairProbabilities(quotes) {
  const index = new Map(quotes.map(q => [[q.event_id, q.book, q.market,
    normalizeName(q.player), q.line ?? '', String(q.side).toLowerCase()].join('|'), q]));
  return quotes.map(q => {
    const side = String(q.side).toLowerCase();
    const oppositeSide = side === 'over' ? 'under' : side === 'under' ? 'over' : null;
    const opposite = oppositeSide ? index.get([q.event_id, q.book, q.market,
      normalizeName(q.player), q.line ?? '', oppositeSide].join('|')) : null;
    return { ...q, implied_probability: noVigPropProbability(q.american_price, opposite?.american_price) };
  });
}

function weekForEvent(event, season, fallbackWeek) {
  const home = rows('SELECT abbr FROM nfl_teams WHERE name=?', event.home_team)[0]?.abbr;
  const away = rows('SELECT abbr FROM nfl_teams WHERE name=?', event.away_team)[0]?.abbr;
  if (!home || !away) return fallbackWeek ?? null;
  const candidates = rows(`SELECT week,gameday FROM game_lines
                            WHERE season=? AND home=1 AND team=? AND opponent=?`, season, home, away);
  if (!candidates.length) return fallbackWeek ?? null;
  const kickoff = new Date(event.commence_time).getTime();
  candidates.sort((a, b) => Math.abs(new Date(`${a.gameday}T17:00:00Z`).getTime() - kickoff)
    - Math.abs(new Date(`${b.gameday}T17:00:00Z`).getTime() - kickoff));
  return candidates[0].week;
}

function probabilityForQuote(quote, projections) {
  const projection = projections.get(normalizeName(quote.player));
  if (!projection) return null;
  if (quote.market === 'player_anytime_td') return projection.projection.any_td_prob;
  const stat = MARKET_STAT[quote.market];
  const samples = projection._sims?.[stat];
  if (!samples?.length || !Number.isFinite(quote.line)) return null;
  const over = samples.filter(value => value > quote.line).length / samples.length;
  return /^under$/i.test(quote.side) ? 1 - over : over;
}

/** Return the closest still-missing capture horizon that is currently due. */
export function duePropCaptureHorizon(commenceTime, priorCaptures = [],
  now = new Date().toISOString(), horizons = PROP_CAPTURE_HORIZONS_HOURS) {
  const kickoff = new Date(commenceTime).getTime(), at = new Date(now).getTime();
  if (!Number.isFinite(kickoff) || !Number.isFinite(at) || at >= kickoff) return null;
  const due = horizons.filter(hours => {
    if (kickoff - at > hours * HOUR) return false;
    const opens = kickoff - hours * HOUR;
    return !priorCaptures.some(capture => {
      const t = new Date(capture).getTime();
      return t >= opens && t < kickoff;
    });
  });
  return due.length ? Math.min(...due) : null;
}

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
export async function capturePropMarket({ season, week, maxEvents = 12, scheduled = false } = {}) {
  if (!hasKey()) return { skipped: true, reason: 'no ODDS_API_KEY configured' };
  const capturedAt = new Date().toISOString();
  const list = (await events()) ?? [];
  let selected = list;
  if (scheduled) {
    selected = list.filter(event => {
      const prior = rows('SELECT DISTINCT captured_at FROM nfl_prop_clv WHERE event_id=?', event.id)
        .map(row => row.captured_at);
      return duePropCaptureHorizon(event.commence_time, prior, capturedAt) != null;
    });
    if (!selected.length) {
      const next = list.map(event => ({ event: event.id, commence_time: event.commence_time,
        hours_until: (new Date(event.commence_time).getTime() - Date.now()) / HOUR }))
        .filter(x => x.hours_until > 0).sort((a, b) => a.hours_until - b.hours_until)[0] ?? null;
      return { skipped: true, reason: 'no T-24h or T-1h prop capture window is due', next_event: next };
    }
  }
  const budget = usage();
  const affordable = Number.isFinite(budget.requests_remaining)
    ? Math.max(0, Math.floor((budget.requests_remaining - PROP_CREDIT_RESERVE) / PROP_MARKETS.length))
    : maxEvents;
  const eventLimit = Math.min(maxEvents, affordable);
  if (eventLimit < 1) return { skipped: true,
    reason: `credit reserve protected (${budget.requests_remaining ?? 'unknown'} remaining; ${PROP_CREDIT_RESERVE} reserved)`,
    usage: budget };
  selected = selected.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time)).slice(0, eventLimit);
  const insert = db.prepare(`INSERT OR IGNORE INTO nfl_prop_clv
    (captured_at,event_id,book,market,player,side,line,american_price,
     model_probability,implied_probability,edge,season,week,commence_time,home_team,away_team)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const projectionsByWeek = new Map();
  let stored = 0, seen = 0;
  for (const e of selected) {
    let payload;
    try { payload = await playerProps(e.id, { markets: PROP_MARKETS }); } catch { continue; }
    if (!payload) continue;
    const eventWeek = weekForEvent(e, season, week);
    if (!projectionsByWeek.has(eventWeek)) {
      const projections = Number.isInteger(eventWeek) ? projectWeek(season, eventWeek) : [];
      projectionsByWeek.set(eventWeek, new Map(projections.map(p => [normalizeName(p.name), p])));
    }
    const projectionIndex = projectionsByWeek.get(eventWeek);
    for (const q of attachFairProbabilities(flattenAllProps(payload))) {
      seen++;
      if (q.commence_time && new Date(q.commence_time).getTime() <= new Date(capturedAt).getTime()) continue;
      const modelProbability = probabilityForQuote(q, projectionIndex);
      const edge = Number.isFinite(modelProbability) && Number.isFinite(q.implied_probability)
        ? modelProbability - q.implied_probability : null;
      const offeredLine = q.line ?? (q.market === 'player_anytime_td' ? 0.5 : null);
      stored += insert.run(capturedAt, q.event_id, q.book, q.market, q.player, q.side,
        offeredLine, q.american_price, modelProbability, q.implied_probability, edge,
        season ?? null, eventWeek ?? null, q.commence_time ?? e.commence_time ?? null,
        q.home_team ?? e.home_team ?? null, q.away_team ?? e.away_team ?? null).changes;
    }
  }
  const closing = finalizeClosingSnapshots();
  return { captured_at: capturedAt, events: selected.length, quotes_seen: seen,
    modeled: rows('SELECT COUNT(*) n FROM nfl_prop_clv WHERE captured_at=? AND model_probability IS NOT NULL', capturedAt)[0]?.n ?? 0,
    stored, closing, usage: usage(), schedule: scheduled ? { horizons_hours: PROP_CAPTURE_HORIZONS_HOURS,
      credit_reserve: PROP_CREDIT_RESERVE } : null };
}

/** Freeze the last book-specific quote before kickoff as the close. */
export function finalizeClosingSnapshots(now = new Date().toISOString()) {
  const pending = rows(`SELECT * FROM nfl_prop_clv
                        WHERE commence_time IS NOT NULL AND commence_time <= ?
                          AND captured_at < commence_time
                          AND closing_price IS NULL`, now);
  const update = db.prepare(`UPDATE nfl_prop_clv
    SET closing_line=?,closing_price=?,closing_fair_probability=?,clv_probability=?,clv_cents=?
    WHERE captured_at=? AND event_id=? AND book=? AND market=? AND player=? AND side=?`);
  let finalized = 0, unmatched = 0;
  for (const quote of pending) {
    const close = rows(`SELECT line,american_price,implied_probability FROM nfl_prop_clv
                        WHERE event_id=? AND book=? AND market=? AND player=? AND side=?
                          AND captured_at < ?
                        ORDER BY captured_at DESC LIMIT 1`, quote.event_id, quote.book,
    quote.market, quote.player, quote.side, quote.commence_time)[0];
    if (!close) { unmatched++; continue; }
    const clv = Number.isFinite(close.implied_probability) && Number.isFinite(quote.implied_probability)
      ? close.implied_probability - quote.implied_probability : null;
    update.run(close.line, close.american_price, close.implied_probability, clv,
      clv == null ? null : clv * 100, quote.captured_at, quote.event_id, quote.book,
      quote.market, quote.player, quote.side);
    finalized++;
  }
  return { finalized, unmatched };
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
                          AND market IN ('player_pass_yds','player_rush_yds','player_reception_yds','player_receptions','player_anytime_td')`,
  season, week);
  if (!pending.length) return { settled: 0, unmatched: 0, note: 'nothing pending for that week' };

  const actuals = new Map();
  for (const r of playerWeeks(season).filter(x => x.week === week)) {
    actuals.set(normalizeName(r.player_name), r.features);
  }
  const upd = db.prepare(`UPDATE nfl_prop_clv SET settled=1, actual_value=?, won=?
                          WHERE captured_at=? AND event_id=? AND book=? AND market=? AND player=? AND side=?`);
  let settled = 0, unmatched = 0;
  for (const q of pending) {
    const f = actuals.get(normalizeName(q.player));
    if (!f) { unmatched++; continue; }
    const actual = q.market === 'player_anytime_td'
      ? ((f.rushing_tds ?? 0) + (f.receiving_tds ?? 0)) : f[SETTLE_FIELD[q.market]];
    if (!Number.isFinite(actual) || q.line == null) { unmatched++; continue; }
    // A push (exact line) is neither a win nor a loss; recorded as null.
    const won = actual === q.line ? null
      : /^(over|yes)$/i.test(q.side) ? (actual > q.line ? 1 : 0) : (actual < q.line ? 1 : 0);
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
  /*
   * Quotes are not bets. Counting every book, both sides and every hourly
   * snapshot would turn one Josh Allen market into dozens of fake samples.
   * The shadow policy is deterministic: for each event/player/market, freeze
   * the earliest captured board and retain its single largest positive
   * model-vs-no-vig divergence. Later captures exist only to establish CLV.
   */
  const modeled = rows(`SELECT * FROM nfl_prop_clv
                        WHERE model_probability IS NOT NULL
                          AND implied_probability IS NOT NULL
                          AND captured_at < commence_time
                        ORDER BY captured_at,event_id,market,player,edge DESC`);
  const decisions = new Map();
  for (const quote of modeled) {
    const key = `${quote.event_id}|${quote.market}|${normalizeName(quote.player)}`;
    const current = decisions.get(key);
    if (!current || quote.captured_at < current.captured_at
      || (quote.captured_at === current.captured_at && quote.edge > current.edge)) {
      decisions.set(key, quote);
    }
  }
  const shadow = [...decisions.values()].filter(quote => quote.edge > 0);
  const settled = shadow.filter(quote => quote.settled === 1 && quote.won != null);
  const withClv = shadow.map(quote => quote.clv_probability).filter(Number.isFinite);
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
    modeled_quotes: modeled.length,
    shadow_decisions: shadow.length,
    settled_bets: settled.length,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    roi: roi == null ? null : +roi.toFixed(4),
    median_clv_probability: median(withClv),
    breakeven_note: 'Prices are real and no-vigged per book. One immutable shadow decision per event/player/market; hourly quotes and both sides are never counted as independent bets.',
    verdict: settled.length < 200
      ? `Only ${settled.length} settled bets. Below ~200 this cannot separate edge from variance; keep accumulating.`
      : 'Sample is large enough to read. Median CLV is the primary signal; ROI is noisier and secondary.'
  };
}

export function propClvStatus() {
  const x = rows(`SELECT COUNT(*) quotes, COUNT(DISTINCT captured_at) captures,
                         COUNT(DISTINCT event_id) events, SUM(settled) settled,
                         SUM(model_probability IS NOT NULL) modeled,
                         SUM(closing_price IS NOT NULL) closed,
                         MIN(captured_at) first, MAX(captured_at) latest
                  FROM nfl_prop_clv`)[0];
  return { ...x, has_key: hasKey() };
}
