/**
 * Beat the close, Phase 2: the live test (docs/BEAT_THE_CLOSE_PLAN.md).
 *
 * Phase 1 found one signal that predicts the open-to-close move at a time
 * you could act: the walk-forward ratings line minus Pinnacle's opener
 * (+0.58 points of CLV, 57.7% direction, 570 held-out games; +1.04 on
 * favourites of three or fewer). This module runs it forward at zero units:
 *
 *   1. `snapshotSignals`  — at every capture, store each Phase 1 signal's
 *                           current value per game (`nfl_signal_snapshots`),
 *                           which is the open-to-close path the archive lacks.
 *   2. `decideBeatTheClose` — when a signal clears its threshold, freeze one
 *                           shadow decision per game/market/signal at the best
 *                           reachable price on the latest board, strategy
 *                           `beat-the-close`, stake 0.
 *   3. `settleBeatTheClose` — after kickoff, grade by CLV against Pinnacle's
 *                           last pre-kickoff line (and record the result, which
 *                           is context, not the gate).
 *
 * Nothing here has staking authority. Two consecutive weeks with a signal's
 * live CLV interval below zero retire its rule; that judgement lives in the
 * weekly read, not in code that could quietly keep betting.
 */
import { db, rows, run, row } from '../db/index.js';
import { predictGame } from './nfl-market.js';
import { teamEventVector } from './nfl-event-archive.js';
import { currentNflWeek } from './weekly-learning.js';
import { gameCutoff } from './game-cutoff.js';
import { verifiedEventMarketLatency } from './nfl-news-market-latency.js';
import { isFreshQuote } from './book-feeds.js';
import { gameWeather, STADIUMS } from './nfl-weather.js';

export const BEAT_THE_CLOSE_VERSION = 'beat-the-close-v1.1';
/**
 * Rules act on the signal CENTERED across the week's slate. The study's
 * logistic fit carried an intercept, so its "direction" was relative to the
 * training mean, not to zero; live, the ratings line sits a constant above
 * the market on totals (a season-level scoring drift) and slightly toward
 * home on spreads, and an uncentered threshold would bet every under.
 */
export const RULES = Object.freeze({
  ratings_vs_open: { market: 'spreads', threshold: 0.5, basis: 'Phase 1: +0.58 CLV, 57.7%, n 570 held out; strongest on favourites ≤ 3' },
  ratings_vs_open_total: { market: 'totals', threshold: 1.0, basis: 'Phase 1: totals T0 model +0.36 as a whole; the ratings term alone was weak (+0.08) — candidate, not a passed signal' },
  // Not centered across the slate and not bidirectional, unlike the two rules
  // above: the study measured an ABSOLUTE kickoff-hour wind speed against the
  // held-out totals close, in one direction only (nothing found a calm-air
  // Over edge). `side` and `requireNotMovedDown` route this through a
  // different branch of decideBeatTheClose() below.
  wind_total: { market: 'totals', threshold: 25, side: 'Under', requireNotMovedDown: 0.5,
    basis: 'Phase 1 §13: +0.47 CLV, 62.1%, n 753 outdoor held out, Holm p < 0.01; the opener does not price kickoff-hour wind' }
});

/**
 * One row per rule, tracking retirement — never deleted, only ever written
 * forward. `consecutive_negative_weeks` counts weekly reads in a row whose
 * bootstrap interval sat entirely below zero; two in a row retires the rule.
 * `last_read_season`/`last_read_week` make weeklyRead() idempotent — calling
 * it twice for the same week must not double-count that week's read.
 */
db.exec(`CREATE TABLE IF NOT EXISTS nfl_rule_state (
  signal TEXT PRIMARY KEY,
  consecutive_negative_weeks INTEGER NOT NULL DEFAULT 0,
  last_read_season INTEGER, last_read_week INTEGER,
  retired_at TEXT, retired_reason TEXT
)`);

db.exec(`CREATE TABLE IF NOT EXISTS nfl_signal_snapshots (
  captured_at TEXT NOT NULL,
  season INTEGER NOT NULL, week INTEGER NOT NULL,
  home TEXT NOT NULL, away TEXT NOT NULL,
  market TEXT NOT NULL, signal TEXT NOT NULL,
  value REAL, opener_line REAL, current_line REAL, opener_at TEXT,
  detail_json TEXT,
  PRIMARY KEY (captured_at, season, week, home, market, signal)
)`);

const r3 = v => (Number.isFinite(v) ? +v.toFixed(3) : null);
const mean = list => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);

/* ------------------------------------------------------------ line lookups */

function teamNames() {
  return new Map(rows('SELECT abbr, name FROM nfl_teams').map(t => [t.abbr, t.name]));
}

/** Pinnacle's opener for a game and market: the archive's opening row, else the earliest live Pinnacle capture. */
export function openerFor(season, week, home, away, market, names = teamNames()) {
  const side = market === 'spreads' ? home : 'Over';
  const archived = row(`SELECT line, book_updated_at at FROM nfl_odds_archive
    WHERE season=? AND week=? AND home=? AND market=? AND side=? AND book='pinnacle' AND phase='open' LIMIT 1`,
  season, week, home, market, side);
  if (archived) return { line: archived.line, at: archived.at, source: 'archive:pinnacle:open' };
  const live = row(`SELECT line, captured_at at FROM nfl_line_snapshots
    WHERE provider='free:pinnacle' AND market=? AND home_team=? AND away_team=? AND side=?
    ORDER BY captured_at ASC LIMIT 1`, market, names.get(home) ?? home, names.get(away) ?? away,
  market === 'spreads' ? (names.get(home) ?? home) : 'Over');
  return live ? { line: live.line, at: live.at, source: 'free:pinnacle:first-capture' } : null;
}

/** Pinnacle's latest line at or before `before` (default now). */
export function pinnacleLineAt(season, week, home, away, market, before = null, names = teamNames()) {
  const side = market === 'spreads' ? (names.get(home) ?? home) : 'Over';
  const live = row(`SELECT line, captured_at at FROM nfl_line_snapshots
    WHERE provider='free:pinnacle' AND market=? AND home_team=? AND away_team=? AND side=? ${before ? 'AND captured_at<=?' : ''}
    ORDER BY captured_at DESC LIMIT 1`, ...[market, names.get(home) ?? home, names.get(away) ?? away, side, ...(before ? [before] : [])]);
  if (live) return { line: live.line, at: live.at, source: 'free:pinnacle' };
  const archived = row(`SELECT line, book_updated_at at FROM nfl_odds_archive
    WHERE season=? AND week=? AND home=? AND market=? AND side=? AND book='pinnacle' AND phase='close' LIMIT 1`,
  season, week, home, market, market === 'spreads' ? home : 'Over');
  return archived ? { line: archived.line, at: archived.at, source: 'archive:pinnacle:close' } : null;
}

/**
 * Best reachable quote on the latest capture for one side: the most
 * favourable line, then price, among books whose OWN price is not stale
 * (see `isFreshQuote` — the aggregator can serve a cached number for a book
 * it has not actually re-polled, which is not a real reachable price).
 */
export function bestReachable(home, away, market, side, names = teamNames()) {
  const sideName = side === home ? (names.get(home) ?? home) : side === away ? (names.get(away) ?? away) : side;
  const latest = row(`SELECT MAX(captured_at) at FROM nfl_line_snapshots WHERE provider LIKE 'free:%' AND market=? AND home_team=? AND away_team=?`,
    market, names.get(home) ?? home, names.get(away) ?? away)?.at;
  if (!latest) return null;
  const allQuotes = rows(`SELECT book, line, price, book_updated_at FROM nfl_line_snapshots WHERE captured_at=? AND market=? AND home_team=? AND away_team=? AND side=?`,
    latest, market, names.get(home) ?? home, names.get(away) ?? away, sideName);
  const quotes = allQuotes.filter(q => isFreshQuote(latest, q.book_updated_at));
  if (!quotes.length) return null;
  // A bettor wants the largest line for a spread side (more points) or an under, the smallest for an over; then the best price.
  const wantHigh = market === 'spreads' || side === 'Under';
  const ordered = [...quotes].sort((a, b) => (wantHigh ? b.line - a.line : a.line - b.line) || b.price - a.price);
  const { book_updated_at, ...best } = ordered[0];
  return { ...best, captured_at: latest, books: quotes.length, stale_dropped: allQuotes.length - quotes.length };
}

/* ------------------------------------------------------------- signals */

function liveGames(season, week) {
  return rows(`SELECT season,week,team home,opponent away,gameday,gametime,spread,total FROM game_lines
    WHERE season=? AND week=? AND home=1 ORDER BY gameday, gametime, team`, season, week);
}

/** Every Phase 1 signal's current value for one game, per market. */
export function signalsFor(game, { now = new Date().toISOString(), names = teamNames() } = {}) {
  const out = [];
  const pred = predictGame(game.home, game.away, game.season);
  for (const market of ['spreads', 'totals']) {
    const opener = openerFor(game.season, game.week, game.home, game.away, market, names);
    if (!opener) continue;
    const current = pinnacleLineAt(game.season, game.week, game.home, game.away, market, null, names);
    const push = (signal, value, detail = {}) => out.push({ market, signal, value: r3(value), opener_line: opener.line, opener_at: opener.at,
      current_line: current?.line ?? null, detail: { ...detail, opener_source: opener.source } });
    if (!pred?.error) {
      // Toward-home / toward-over convention, as in the study: positive means the ratings line sits past the opener on that side.
      push(market === 'spreads' ? 'ratings_vs_open' : 'ratings_vs_open_total',
        market === 'spreads' ? pred.predicted_margin + opener.line : pred.predicted_total - opener.line,
        { predicted_margin: pred.predicted_margin, predicted_total: pred.predicted_total });
    }
    const at0 = { home: teamEventVector(game.home, { before: opener.at, sinceDays: 10 }), away: teamEventVector(game.away, { before: opener.at, sinceDays: 10 }) };
    const atT = { home: teamEventVector(game.home, { before: now, sinceDays: 10 }), away: teamEventVector(game.away, { before: now, sinceDays: 10 }) };
    const qbOut = side => atT[side].active_player_states.filter(e => e.position === 'QB' && /out|reserve|doubtful/i.test(String(e.status_after ?? '')) && e.available_at > opener.at).length;
    push('qb_out_delta', qbOut('away') - qbOut('home'));
    push('injury_burden_delta', (atT.away.injury_burden - at0.away.injury_burden) - (atT.home.injury_burden - at0.home.injury_burden));
    push('trades_since_open', (atT.home.trade_arrivals - at0.home.trade_arrivals) + (atT.away.trade_arrivals - at0.away.trade_arrivals));
    if (current) push('pinnacle_move_so_far', market === 'spreads' ? opener.line - current.line : current.line - opener.line);
    if (market === 'totals' && !STADIUMS[game.home]?.indoor) {
      const weather = gameWeather(game.season, game.week, game.home);
      if (weather && Number.isFinite(weather.wind_kmh)) {
        // Pushed under the same name as its RULES key — decideBeatTheClose()
        // looks a decision up by RULES[sig.signal], so the two must match
        // exactly, the same convention ratings_vs_open[_total] already follow.
        push('wind_total', weather.wind_kmh, { source: weather.source, gust_kmh: weather.gust_kmh, fetched_at: weather.fetched_at });
      }
    }
  }
  return out;
}

/** Every unplayed game's signals for the week, with each signal also centered across the slate. */
function slateSignals(s, w, now, names) {
  const slate = [];
  for (const game of liveGames(s, w)) {
    const kickoff = gameCutoff(s, w, game.home);
    if (kickoff && kickoff <= now) continue;
    slate.push({ game, signals: signalsFor(game, { now, names }) });
  }
  const sums = new Map();
  for (const { signals } of slate) for (const sig of signals) {
    const key = `${sig.market}|${sig.signal}`; const e = sums.get(key) ?? { sum: 0, n: 0 };
    if (Number.isFinite(sig.value)) { e.sum += sig.value; e.n++; } sums.set(key, e);
  }
  for (const { signals } of slate) for (const sig of signals) {
    const e = sums.get(`${sig.market}|${sig.signal}`);
    sig.slate_mean = e?.n ? r3(e.sum / e.n) : null;
    sig.centered = Number.isFinite(sig.value) && e?.n >= 4 ? r3(sig.value - e.sum / e.n) : null;
  }
  return slate;
}

export function snapshotSignals({ season = null, week = null, now = new Date().toISOString() } = {}) {
  const s = season ?? (Number(process.env.NFL_SEASON) || new Date().getUTCFullYear());
  const w = week ?? currentNflWeek(s).week;
  const names = teamNames();
  let written = 0, games = 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO nfl_signal_snapshots
    (captured_at,season,week,home,away,market,signal,value,opener_line,current_line,opener_at,detail_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const { game, signals } of slateSignals(s, w, now, names)) {
    games++;
    for (const sig of signals) {
      const r = stmt.run(now, s, w, game.home, game.away, sig.market, sig.signal, sig.value, sig.opener_line, sig.current_line, sig.opener_at,
        JSON.stringify({ ...sig.detail, centered: sig.centered, slate_mean: sig.slate_mean }));
      written += Number(r.changes ?? 0);
    }
  }
  return { version: BEAT_THE_CLOSE_VERSION, season: s, week: w, captured_at: now, games, signals_written: written };
}

/* ------------------------------------------------------------- decisions */

export function decideBeatTheClose({ season = null, week = null, now = new Date().toISOString() } = {}) {
  const s = season ?? (Number(process.env.NFL_SEASON) || new Date().getUTCFullYear());
  const w = week ?? currentNflWeek(s).week;
  const names = teamNames();
  const retired = retiredSignals();
  let frozen = 0, already = 0, below = 0, noPrice = 0, retiredSkipped = 0;
  const decisions = [];
  for (const { game, signals } of slateSignals(s, w, now, names)) {
    for (const sig of signals) {
      const rule = RULES[sig.signal];
      if (!rule) continue;
      if (retired.has(sig.signal)) { retiredSkipped++; continue; }
      let side;
      if (rule.side) {
        // One-directional, absolute-threshold rule (wind_total): the raw
        // forecast value against a fixed line, not the slate-centered value,
        // and only while the total has not already drifted the predicted
        // way — betting the under after the market has already priced the
        // wind in is not the measured edge.
        if (!Number.isFinite(sig.value) || sig.value < rule.threshold) { below++; continue; }
        if (rule.requireNotMovedDown != null) {
          const movedTowardUnder = Number.isFinite(sig.current_line) && Number.isFinite(sig.opener_line)
            ? sig.opener_line - sig.current_line : 0;
          if (movedTowardUnder >= rule.requireNotMovedDown) { below++; continue; }
        }
        side = rule.side;
      } else {
        if (!Number.isFinite(sig.centered)) continue;
        if (Math.abs(sig.centered) < rule.threshold) { below++; continue; }
        side = sig.market === 'spreads' ? (sig.centered > 0 ? game.home : game.away) : (sig.centered > 0 ? 'Over' : 'Under');
      }
      const modelVersion = `${BEAT_THE_CLOSE_VERSION}:${sig.signal}`;
      const eventKey = `${s}:${w}:${game.home}:${game.away}`;
      const marketKey = sig.market === 'spreads' ? 'spread' : 'total';
      if (row(`SELECT id FROM shadow_decisions WHERE sport='NFL' AND event_key=? AND market=? AND model_version=? LIMIT 1`, eventKey, marketKey, modelVersion)) { already++; continue; }
      const quote = bestReachable(game.home, game.away, sig.market, side, names);
      if (!quote) { noPrice++; continue; }
      const favouriteSize = Math.abs(sig.opener_line);
      const feature = { strategy: 'beat_the_close', signal: sig.signal, value: sig.value, centered: sig.centered, slate_mean: sig.slate_mean, threshold: rule.threshold, opener_line: sig.opener_line,
        opener_at: sig.opener_at, pinnacle_now: sig.current_line, side, bet_line_basis: 'home-perspective line at the chosen book',
        slice: sig.market === 'spreads' ? (favouriteSize <= 3 ? 'favourite ≤ 3' : favouriteSize <= 7 ? 'favourite 3.5–7' : 'favourite > 7') : 'totals',
        book: quote.book, books_on_board: quote.books, stake_units: 0, basis: rule.basis, decided_at: now };
      // Store the line in HOME-perspective terms for spreads so settlement is one formula.
      const homeLine = sig.market === 'spreads' ? (side === game.home ? quote.line : -quote.line) : quote.line;
      const reason = rule.side
        ? `signal ${sig.signal} ${sig.value} ≥ ${rule.threshold} and the total has not moved down since the opener; zero units; graded by CLV`
        : `signal ${sig.signal} centered ${sig.centered} (raw ${sig.value}, slate mean ${sig.slate_mean}) ≥ ${rule.threshold}; zero units; graded by CLV`;
      run(`INSERT INTO shadow_decisions
        (sport,event_key,market,selection,model_version,probability,market_probability,uncertainty,regime,decision,reason,captured_at,
         season,week,home_team,away_team,line,american_price,quote_at,feature_snapshot_json)
        VALUES ('NFL',?,?,?,?,NULL,NULL,NULL,'beat_the_close','observe',?,?,?,?,?,?,?,?,?,?)`,
      eventKey, marketKey, side, modelVersion, reason, now,
      s, w, game.home, game.away, homeLine, quote.price, quote.captured_at, JSON.stringify(feature));
      frozen++;
      decisions.push({ game: `${game.away} at ${game.home}`, market: sig.market, side, signal: sig.signal, value: sig.value, centered: sig.centered, line: quote.line, price: quote.price, book: quote.book, slice: feature.slice });
    }
  }
  return { version: BEAT_THE_CLOSE_VERSION, season: s, week: w, frozen, already_frozen: already, below_threshold: below,
    no_reachable_price: noPrice, retired_skipped: retiredSkipped, decisions };
}

/* ------------------------------------------------------------ settlement */

export function settleBeatTheClose({ now = new Date().toISOString() } = {}) {
  const names = teamNames();
  const pending = rows(`SELECT d.*, g.team_score, g.opp_score FROM shadow_decisions d
    JOIN game_lines g ON g.season=d.season AND g.week=d.week AND g.team=d.home_team AND g.home=1
    WHERE d.sport='NFL' AND d.model_version LIKE 'beat-the-close-v%' AND d.settled_at IS NULL`);
  let settled = 0, waiting = 0;
  for (const d of pending) {
    const kickoff = gameCutoff(d.season, d.week, d.home_team);
    if (!kickoff || kickoff > now) { waiting++; continue; }
    const market = d.market === 'spread' ? 'spreads' : 'totals';
    const close = pinnacleLineAt(d.season, d.week, d.home_team, d.away_team, market, kickoff, names);
    if (!close) { waiting++; continue; }
    // CLV in points toward the side taken, home-perspective lines for spreads.
    const clv = market === 'spreads'
      ? (d.selection === d.home_team ? d.line - close.line : close.line - d.line)
      : (d.selection === 'Over' ? close.line - d.line : d.line - close.line);
    let result = null;
    if (Number.isFinite(d.team_score) && Number.isFinite(d.opp_score)) {
      const margin = d.team_score - d.opp_score, total = d.team_score + d.opp_score;
      const edge = market === 'spreads' ? (d.selection === d.home_team ? margin + d.line : -(margin + d.line))
        : (d.selection === 'Over' ? total - d.line : d.line - total);
      result = edge > 0 ? 'Won' : edge < 0 ? 'Lost' : 'Push';
    }
    run(`UPDATE shadow_decisions SET settled_at=?, clv_points=?, result=?, outcome_json=? WHERE id=?`,
      now, r3(clv), result, JSON.stringify({ close_line: close.line, close_at: close.at, close_source: close.source, kickoff, stake_units: 0 }), d.id);
    settled++;
  }
  return { version: BEAT_THE_CLOSE_VERSION, settled, waiting };
}

/** One call for the scheduler: snapshot, decide, settle. */
export function runBeatTheClose(options = {}) {
  const snapshot = snapshotSignals(options);
  const decided = decideBeatTheClose(options);
  const settlement = settleBeatTheClose(options);
  return { snapshot, decided, settlement };
}

/* ---------------------------------------------------------------- status */

/**
 * Every beat-the-close decision, parsed and split into clean vs stale-price
 * (see book-feeds.js#isFreshQuote — a decision frozen at a price the book
 * had stopped updating is kept as a row, since frozen rows are never
 * rewritten, but it is not evidence about the signal). Shared by
 * beatTheCloseStatus() and weeklyRead() so the exclusion rule can't drift
 * between the two.
 */
function cleanDecisions({ signal = null, throughSeason = null, throughWeek = null } = {}) {
  const filters = [`sport='NFL'`, `model_version LIKE 'beat-the-close-v%'`];
  const params = [];
  if (signal) { filters.push('model_version=?'); params.push(`${BEAT_THE_CLOSE_VERSION}:${signal}`); }
  if (throughSeason != null) { filters.push('(season < ? OR (season = ? AND week <= ?))'); params.push(throughSeason, throughSeason, throughWeek); }
  const decisions = rows(`SELECT id, season, week, home_team, away_team, market, selection, model_version, line, american_price, quote_at,
      captured_at, settled_at, result, clv_points, feature_snapshot_json FROM shadow_decisions
    WHERE ${filters.join(' AND ')} ORDER BY captured_at DESC`, ...params);
  for (const d of decisions) {
    try { d.feature = JSON.parse(d.feature_snapshot_json || '{}'); } catch { d.feature = {}; }
    d.stale_price = d.feature.stale_price_at_decision === true;
  }
  const clean = decisions.filter(d => !d.stale_price);
  return { all: decisions, clean, excludedStale: decisions.length - clean.length };
}

export function beatTheCloseStatus() {
  const { all: decisions, clean, excludedStale } = cleanDecisions();
  const bySignal = {};
  for (const d of clean) {
    const signal = d.model_version.split(':').at(-1);
    const b = bySignal[signal] ?? (bySignal[signal] = { frozen: 0, settled: 0, clv: [], won: 0, lost: 0, push: 0 });
    b.frozen++;
    if (d.settled_at != null) { b.settled++; if (Number.isFinite(d.clv_points)) b.clv.push(d.clv_points); if (d.result === 'Won') b.won++; else if (d.result === 'Lost') b.lost++; else if (d.result === 'Push') b.push++; }
  }
  const bySlice = {};
  for (const d of clean) {
    const slice = d.feature.slice ?? 'unknown';
    const b = bySlice[slice] ?? (bySlice[slice] = { frozen: 0, settled: 0, clv: [] });
    b.frozen++; if (d.settled_at != null) { b.settled++; if (Number.isFinite(d.clv_points)) b.clv.push(d.clv_points); }
  }
  const sliceSummary = Object.fromEntries(Object.entries(bySlice).map(([slice, b]) => [slice, { frozen: b.frozen, settled: b.settled, mean_clv: r3(mean(b.clv)), readable: b.clv.length >= 30 }]));
  const summary = Object.fromEntries(Object.entries(bySignal).map(([signal, b]) => [signal, { frozen: b.frozen, settled: b.settled,
    mean_clv: r3(mean(b.clv)), positive_share: b.clv.length ? r3(b.clv.filter(v => v > 0).length / b.clv.length) : null,
    record: `${b.won}-${b.lost}${b.push ? `-${b.push}` : ''}`, rule: RULES[signal] ?? null,
    readable: b.clv.length >= 30 }]));
  const snapshots = rows(`SELECT season, week, COUNT(DISTINCT captured_at) captures, COUNT(DISTINCT home) games, MAX(captured_at) latest
    FROM nfl_signal_snapshots GROUP BY season, week ORDER BY season DESC, week DESC LIMIT 4`);
  const latestSignals = rows(`SELECT home, away, market, signal, value, opener_line, current_line FROM nfl_signal_snapshots
    WHERE captured_at=(SELECT MAX(captured_at) FROM nfl_signal_snapshots) AND signal IN ('ratings_vs_open','ratings_vs_open_total','pinnacle_move_so_far') ORDER BY home, market, signal`);
  let window = null;
  try { window = verifiedEventMarketLatency({ limit: 400, since: '2026-08-01T00:00:00Z' }); } catch (error) { window = { error: error.message }; }
  return { version: BEAT_THE_CLOSE_VERSION, rules: RULES, by_signal: summary, by_slice: sliceSummary,
    excluded_stale: excludedStale,
    excluded_stale_rule: 'decisions whose chosen quote was stamped more than STALE_BOOK_HOURS before the board are kept as rows but excluded from every read above',
    event_to_move_window: window ? { ...window, examples: window.examples?.slice(0, 8) } : null,
    decisions: decisions.slice(0, 60).map(d => ({ ...d, feature_snapshot_json: undefined })),
    snapshots, latest_signals: latestSignals,
    gate: 'Phase 3: ≥ 200 settled decisions with a week-clustered CLV interval above zero; a signal whose live CLV interval sits below zero two weeks running is retired. Stake stays 0.',
    authority: 'shadow only; no staking authority' };
}

/* ------------------------------------------------------------ weekly read */

const BOOTSTRAP_ITERS = 1000;
function seededRandom(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/**
 * Every rule's read as of one settled week: mean CLV over all clean settled
 * history through that week (a single week is too small to bootstrap on its
 * own), a week-clustered bootstrap interval (resampling WEEKS, not
 * decisions, since games in the same week share news and weather), direction
 * and positive share, and the historical coefficient the rule was built
 * from, for comparison. Also advances retirement state in `nfl_rule_state`:
 * two consecutive weekly reads whose interval sits entirely below zero
 * retire the rule. Calling this twice for the same (season, week) is a
 * no-op on the retirement counter — the state table's `last_read_*` guards
 * it — so a re-triggered read never double-counts a bad week.
 */
export function weeklyRead(season, week) {
  const reads = {};
  const rand = seededRandom(20260902);
  for (const signal of Object.keys(RULES)) {
    const { clean } = cleanDecisions({ signal, throughSeason: season, throughWeek: week });
    const settled = clean.filter(d => d.settled_at != null && Number.isFinite(d.clv_points));
    const thisWeek = settled.filter(d => d.season === season && d.week === week);
    const byWeek = new Map();
    for (const d of settled) { const key = `${d.season}|${d.week}`; const list = byWeek.get(key) ?? []; list.push(d.clv_points); byWeek.set(key, list); }
    const clusters = [...byWeek.values()];
    let interval = null, meanClv = null;
    if (clusters.length >= 2) {
      const means = [];
      for (let b = 0; b < BOOTSTRAP_ITERS; b++) {
        const sample = [];
        for (let i = 0; i < clusters.length; i++) sample.push(...clusters[Math.floor(rand() * clusters.length)]);
        means.push(mean(sample));
      }
      means.sort((a, b) => a - b);
      interval = [r3(means[Math.floor(0.025 * means.length)]), r3(means[Math.floor(0.975 * means.length)])];
      meanClv = r3(mean(settled.map(d => d.clv_points)));
    }
    const belowZero = interval != null && interval[1] < 0;

    const state = row('SELECT * FROM nfl_rule_state WHERE signal=?', signal)
      ?? { signal, consecutive_negative_weeks: 0, last_read_season: null, last_read_week: null, retired_at: null, retired_reason: null };
    const alreadyReadThisWeek = state.last_read_season === season && state.last_read_week === week;
    if (!alreadyReadThisWeek && interval != null) {
      const nextStreak = belowZero ? state.consecutive_negative_weeks + 1 : 0;
      const retiring = !state.retired_at && nextStreak >= 2;
      run(`INSERT INTO nfl_rule_state (signal,consecutive_negative_weeks,last_read_season,last_read_week,retired_at,retired_reason)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(signal) DO UPDATE SET consecutive_negative_weeks=excluded.consecutive_negative_weeks,
             last_read_season=excluded.last_read_season, last_read_week=excluded.last_read_week,
             retired_at=COALESCE(nfl_rule_state.retired_at, excluded.retired_at),
             retired_reason=COALESCE(nfl_rule_state.retired_reason, excluded.retired_reason)`,
      signal, nextStreak, season, week,
      retiring ? new Date().toISOString() : null,
      retiring ? `two consecutive weekly reads (through ${season} W${week}) with the CLV interval entirely below zero` : null);
    }
    const freshState = row('SELECT * FROM nfl_rule_state WHERE signal=?', signal);
    reads[signal] = {
      week: { settled: thisWeek.length, mean_clv: thisWeek.length ? r3(mean(thisWeek.map(d => d.clv_points))) : null },
      through_week: { settled: settled.length, weeks: clusters.length, mean_clv: meanClv, clv_interval: interval,
        positive_share: settled.length ? r3(settled.filter(d => d.clv_points > 0).length / settled.length) : null,
        readable: settled.length >= 30 },
      historical_basis: RULES[signal].basis,
      retired_at: freshState?.retired_at ?? null, retired_reason: freshState?.retired_reason ?? null,
      consecutive_negative_weeks: freshState?.consecutive_negative_weeks ?? 0
    };
  }
  return { version: BEAT_THE_CLOSE_VERSION, season, week, reads };
}

/** Retired signals ({signal: retired_at}), read fresh on every call — never cached. */
function retiredSignals() {
  return new Map(rows('SELECT signal, retired_at FROM nfl_rule_state WHERE retired_at IS NOT NULL').map(r => [r.signal, r.retired_at]));
}
