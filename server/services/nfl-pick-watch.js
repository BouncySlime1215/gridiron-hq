/**
 * Continuous re-shop of every open model pick, against the live multi-book
 * market — the actual join that has been missing.
 *
 * Pick generation (nfl-auto-picks.js's ensurePicksFor, nfl-props.js's
 * ensureTotalPicks) freezes one stored quote from `game_lines` at the moment
 * a pick is locked and never looks at it again. Meanwhile book-feeds.js and
 * book-feeds-extra.js are capturing a live multi-book snapshot every few
 * minutes to an hour (see scheduler.js), and nfl-execution.js already knows
 * how to rank those books for a decided side (`rankBooks`) — but nothing
 * before this module ever called that ranking FOR a locked pick. A pick could
 * sit there while the market moved a full point against it and nothing would
 * notice.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT (read this before wiring anything to it):
 * This project has no real sportsbook account and no bet-placement API — it
 * only reads public odds pages. This is a monitoring/alerting board, not an
 * order router: it says "here is the current best price for a pick you
 * already locked in, here is how that compares to the price it was locked at,
 * and here is whether the model's own gate has ever actually opened for this
 * market." It never stakes anything on its own, and every row is generated
 * with the same zero-edge floor `nfl-auto-picks.js`/`nfl-props.js` already
 * enforce at generation time: `recommended_stake_units` is 0, and the row
 * reads "watching — no proven edge" until `model-governance.js`'s real
 * registry state for that market says a champion has actually been promoted
 * to production. Nothing here fabricates or bypasses that gate; it only
 * reads it, live, so a future promotion shows up automatically instead of
 * needing a second feature built later.
 *
 * WHICH SIDE THIS ACTUALLY REFRESHES: only the market side. `model_probability`
 * and `model_edge_at_generation` below are copied verbatim from the row
 * frozen at pick time — this module does not re-run the expert coordinator
 * or re-fit anything. Re-running the model live, on every tick, for every
 * open pick would duplicate nfl-model-growth.js's job (which already re-fits
 * once a week actually finalizes) and risks leaking same-week information
 * into a number that is supposed to be frozen. Being honest about that
 * limit is more useful than quietly implying the model view is live when it
 * is not.
 */
import { db, rows, run } from '../db/index.js';
import { rankBooks, breakEvenRate } from './nfl-execution.js';
import { simultaneousQuotes } from './nfl-shopping-board.js';
import { registry } from './model-governance.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_pick_watch_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    checked_at     TEXT NOT NULL,
    pick_source    TEXT NOT NULL,   -- 'spread' | 'total'
    season         INTEGER NOT NULL, week INTEGER NOT NULL, rank INTEGER NOT NULL,
    matchup        TEXT, market TEXT, selection TEXT, side TEXT,
    line_at_generation  REAL, price_at_generation INTEGER, book_at_generation TEXT,
    best_book      TEXT, best_line REAL, best_price INTEGER, books_compared INTEGER,
    break_even_at_generation REAL, break_even_now REAL, direction TEXT,
    model_probability REAL, model_edge_at_generation REAL,
    gate_open      INTEGER NOT NULL, recommended_stake_units REAL NOT NULL,
    status         TEXT NOT NULL, note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pick_watch_log_check
    ON nfl_pick_watch_log(pick_source, season, week, rank, checked_at);
`);

const NOTE_NO_EDGE = 'No proven CLV for this market yet (model-governance.js: no champion has been ' +
  'promoted to production). For shopping/monitoring purposes only — not a recommendation to bet money.';
const NOTE_ACTIONABLE = 'This market\'s champion has been promoted to production in model-governance.js. ' +
  'Actionable — the current best book/price/line and its edge decay are below.';

/** Is there a real, promoted-to-production champion for this market right now? */
export function marketGateOpen(market) {
  const reg = registry('NFL').find(r => r.market === market && r.role === 'champion');
  return reg?.state === 'production';
}

/** Every currently open (game not yet final) spread pick, from nfl_auto_picks. */
function openSpreadPicks() {
  return rows(`
    SELECT p.*, 'spread' AS pick_source FROM nfl_auto_picks p
    JOIN game_lines g ON g.season = p.season AND g.week = p.week AND g.home = 1 AND g.team = p.home_team
    WHERE g.team_score IS NULL AND p.voided_at IS NULL
    ORDER BY p.season, p.week, p.rank
  `);
}

/** Every currently open total pick, from nfl_total_picks. */
function openTotalPicks() {
  return rows(`
    SELECT p.*, 'total' AS pick_source FROM nfl_total_picks p
    JOIN game_lines g ON g.season = p.season AND g.week = p.week AND g.home = 1 AND g.team = p.home_team
    WHERE g.team_score IS NULL
    ORDER BY p.season, p.week, p.rank
  `);
}

const nameOf = () => new Map(rows('SELECT abbr, name FROM nfl_teams').map(t => [t.abbr, t.name]));

/** Find the live simultaneous-quote event for a pick's away@home abbreviation pair. */
function findEvent(events, awayAbbr, homeAbbr) {
  const suffix = `${awayAbbr}@${homeAbbr}`;
  return events.find(e => e.event_id.endsWith(suffix)) ?? null;
}

/**
 * Re-shop one pick against the live snapshot and return a watch row (not yet
 * written). `bookMarket` is the snapshot table's market key ('spreads' or
 * 'totals') — distinct from the pick's own `market` label.
 */
function reshopOne(pick, { bookMarket, events, names }) {
  const ev = findEvent(events, pick.away_team, pick.home_team);
  const base = {
    pick_source: pick.pick_source, season: pick.season, week: pick.week, rank: pick.rank,
    matchup: pick.matchup, market: pick.pick_source, selection: pick.selection ?? null,
    side: pick.side, line_at_generation: pick.line, price_at_generation: pick.american_price,
    book_at_generation: pick.book ?? null,
    model_probability: pick.model_probability, model_edge_at_generation: pick.probability_difference
  };
  const gateOpen = marketGateOpen(pick.pick_source);
  const recommendedUnits = gateOpen ? (Number(process.env.NFL_MODEL_STAKE_UNITS) || 0) : 0;

  if (!ev) {
    return { ...base, best_book: null, best_line: null, best_price: null, books_compared: 0,
      break_even_at_generation: r4(breakEvenRate(pick.american_price)), break_even_now: null,
      direction: 'unknown', gate_open: gateOpen ? 1 : 0, recommended_stake_units: recommendedUnits,
      status: 'watching_no_market_data',
      note: 'No live multi-book snapshot found for this game yet. ' + (gateOpen ? NOTE_ACTIONABLE : NOTE_NO_EDGE) };
  }

  let side;
  if (bookMarket === 'totals') {
    const m = /^(Over|Under)/i.exec(String(pick.side ?? ''));
    side = m ? (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) : null;
  } else {
    side = names.get(pick.selection) ?? null;
  }
  const quotes = side ? ev.quotes.filter(q => String(q.side).toLowerCase() === side.toLowerCase()) : [];
  if (!quotes.length) {
    return { ...base, best_book: null, best_line: null, best_price: null, books_compared: 0,
      break_even_at_generation: r4(breakEvenRate(pick.american_price)), break_even_now: null,
      direction: 'unknown', gate_open: gateOpen ? 1 : 0, recommended_stake_units: recommendedUnits,
      status: 'watching_no_market_data',
      note: 'A live snapshot exists for this game, but no book currently quotes this exact side. ' +
        (gateOpen ? NOTE_ACTIONABLE : NOTE_NO_EDGE) };
  }

  const takingPoints = bookMarket === 'totals' ? /under/i.test(side) : true;
  const ranked = rankBooks(quotes, { market: bookMarket, takingPoints });
  const beGen = r4(breakEvenRate(pick.american_price));
  const beNow = ranked ? ranked.best.break_even : null;
  // Lower break-even required is more favorable — the price improved since
  // the pick was generated. This compares the two on the SAME probability
  // scale rankBooks itself uses, not a raw price diff (see nfl-execution.js's
  // header on why American-odds averaging/diffing is not meaningful directly).
  const direction = beGen == null || beNow == null ? 'unknown'
    : beNow < beGen - 1e-6 ? 'more_favorable' : beNow > beGen + 1e-6 ? 'less_favorable' : 'unchanged';

  return {
    ...base,
    best_book: ranked?.best?.book ?? null, best_line: ranked?.best?.line ?? null,
    best_price: ranked?.best?.price ?? null, books_compared: ranked?.books_compared ?? quotes.length,
    break_even_at_generation: beGen, break_even_now: beNow, direction,
    gate_open: gateOpen ? 1 : 0, recommended_stake_units: recommendedUnits,
    status: gateOpen ? 'actionable' : 'watching_no_action',
    note: gateOpen ? NOTE_ACTIONABLE : NOTE_NO_EDGE
  };
}

function persist(row) {
  const at = new Date().toISOString();
  run(`INSERT INTO nfl_pick_watch_log
       (checked_at, pick_source, season, week, rank, matchup, market, selection, side,
        line_at_generation, price_at_generation, book_at_generation,
        best_book, best_line, best_price, books_compared,
        break_even_at_generation, break_even_now, direction,
        model_probability, model_edge_at_generation,
        gate_open, recommended_stake_units, status, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  at, row.pick_source, row.season, row.week, row.rank, row.matchup, row.market, row.selection, row.side,
  row.line_at_generation, row.price_at_generation, row.book_at_generation,
  row.best_book, row.best_line, row.best_price, row.books_compared,
  row.break_even_at_generation, row.break_even_now, row.direction,
  row.model_probability, row.model_edge_at_generation,
  row.gate_open, row.recommended_stake_units, row.status, row.note);
  return { ...row, checked_at: at };
}

/**
 * Re-shop every currently open spread and total pick, log the result, and
 * return what was written. This is the scheduled job's entry point
 * (scheduler.js's `nfl_pick_watch`); also callable on demand from the route.
 */
export function reshopOpenPicks() {
  const names = nameOf();
  const spreadEvents = simultaneousQuotes('spreads');
  const totalEvents = simultaneousQuotes('totals');

  const spreadRows = openSpreadPicks()
    .map(p => reshopOne(p, { bookMarket: 'spreads', events: spreadEvents, names }));
  const totalRows = openTotalPicks()
    .map(p => reshopOne(p, { bookMarket: 'totals', events: totalEvents, names }));

  const written = [...spreadRows, ...totalRows].map(persist);
  return {
    checked_at: written[0]?.checked_at ?? new Date().toISOString(),
    picks_checked: written.length,
    spread_checked: spreadRows.length, total_checked: totalRows.length,
    more_favorable: written.filter(w => w.direction === 'more_favorable').length,
    less_favorable: written.filter(w => w.direction === 'less_favorable').length,
    actionable: written.filter(w => w.status === 'actionable').length,
    note: 'Every open pick gets a fresh row every run, whether or not anything changed — the same ' +
      'always-log-every-decision discipline nfl-execution.js\'s logExecution uses, so this feature\'s own ' +
      'claims stay checkable.'
  };
}

/**
 * The live board: the CURRENT state of every open pick (most recent watch row
 * per pick), not the history. `nfl-pick-watch-log`/history below is for the
 * time series.
 */
export function pickWatchBoard() {
  // Keyed on \`id\` (autoincrement), not \`checked_at\`: two runs close enough
  // together can share the same millisecond timestamp, and a self-join on
  // checked_at alone would then return both rows for a pick instead of one.
  const latest = rows(`
    SELECT w.* FROM nfl_pick_watch_log w
    JOIN (SELECT pick_source, season, week, rank, MAX(id) AS id
          FROM nfl_pick_watch_log GROUP BY pick_source, season, week, rank) m
      ON m.pick_source = w.pick_source AND m.season = w.season AND m.week = w.week
     AND m.rank = w.rank AND m.id = w.id
    ORDER BY w.pick_source, w.season DESC, w.week DESC, w.rank
  `);
  return {
    picks: latest,
    open: latest.length,
    actionable: latest.filter(w => w.status === 'actionable').length,
    more_favorable: latest.filter(w => w.direction === 'more_favorable').length,
    less_favorable: latest.filter(w => w.direction === 'less_favorable').length,
    any_gate_open: latest.some(w => w.gate_open === 1),
    note: latest.some(w => w.gate_open === 1)
      ? 'At least one market\'s champion is in production — those rows are actionable.'
      : 'Every market here still has zero proven CLV (model-governance.js). Every row below is ' +
        'for shopping/monitoring only; recommended_stake_units is 0 across the board by design.'
  };
}

/** The raw alert log, most recent first — the queryable audit trail. */
export function pickWatchLog({ limit = 200 } = {}) {
  return rows(`SELECT * FROM nfl_pick_watch_log ORDER BY checked_at DESC, id DESC LIMIT ?`, Number(limit) || 200);
}

export const __test = { reshopOne, findEvent };
