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
import { isFreshQuote, STALE_BOOK_HOURS } from './book-feeds.js';
import { CAPTURE_WINDOW_MS } from './nfl-shopping-board.js';
import { gameWeather, STADIUMS } from './nfl-weather.js';
import { nfeloFeatures } from './nfelo.js';
import { externalRatingsFeatures } from './nfl-external-ratings.js';

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
    basis: 'Phase 1 §13: +0.47 CLV on the ACTUAL kickoff-hour wind; re-measured on the lead-2 forecast that was knowable (2024–25): +0.28 [0.11, 0.45], 56.2% — under the +0.3 gate. Candidate; the live CLV decides.' },
  // Phase 2 external lines (docs/PROFIT_ROADMAP.md 2.1, 2.6), same convention as
  // ratings_vs_open: value > 0 means the external number sits past the opener
  // toward home. Both passed the study's gate held out on 2024–25.
  nfelo_pre_vs_open: { market: 'spreads', threshold: 0.5,
    basis: 'Phase 2: nfelo pre-regression line vs Pinnacle opener, +0.68 CLV [0.36, 1.05], 63.6%, n 570 held out, Holm p < 0.01' },
  teamrankings_vs_open: { market: 'spreads', threshold: 0.5,
    basis: 'Phase 2: TeamRankings predictive rating vs Pinnacle opener (Wednesday snapshot), +0.55 CLV [0.23, 0.92], 57.7%, n 570 held out, Holm p < 0.01' }
});

const r3 = v => (Number.isFinite(v) ? +v.toFixed(3) : null);
const mean = list => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);

/* ------------------------------------------------------------ line lookups */

function teamNames() {
  return new Map(rows('SELECT abbr, name FROM nfl_teams').map(t => [t.abbr, t.name]));
}

/**
 * Pinnacle's opener for a game and market: the archive's opening row, else
 * the earliest live Pinnacle capture.
 *
 * `receiptAsOf`, when given, also requires the archive row's `fetched_at`
 * (this system's real receipt clock, not the book's own `book_updated_at`
 * content clock -- see migration 052_line_snapshot_receipt_clock.js) to be at
 * or before it: a caller simulating a decision as of some instant must not
 * see an opener this system did not actually hold on file yet. Every current
 * caller (signalsFor, live-only) passes real wall-clock `now`, against which
 * an already-recorded archive row's fetched_at is always in the past, so this
 * is presently a no-op guard rather than an active filter -- it exists so a
 * future backtest/replay caller of this function cannot reintroduce the same
 * receipt-clock leak already closed in shoppingFor (nfl-expert-council.js).
 */
export function openerFor(season, week, home, away, market, names = teamNames(), receiptAsOf = null) {
  const side = market === 'spreads' ? home : 'Over';
  const archived = row(`SELECT line, book_updated_at at FROM nfl_odds_archive
    WHERE season=? AND week=? AND home=? AND market=? AND side=? AND book='pinnacle' AND phase='open'
      ${receiptAsOf ? 'AND fetched_at<=?' : ''} LIMIT 1`,
  ...(receiptAsOf ? [season, week, home, market, side, receiptAsOf] : [season, week, home, market, side]));
  if (archived) return { line: archived.line, at: archived.at, source: 'archive:pinnacle:open' };
  const live = row(`SELECT line, captured_at at FROM nfl_line_snapshots
    WHERE provider='free:pinnacle' AND market=? AND home_team=? AND away_team=? AND side=?
    ORDER BY captured_at ASC LIMIT 1`, market, names.get(home) ?? home, names.get(away) ?? away,
  market === 'spreads' ? (names.get(home) ?? home) : 'Over');
  return live ? { line: live.line, at: live.at, source: 'free:pinnacle:first-capture' } : null;
}

/**
 * How close to kickoff a quote has to be to count as the real close, no
 * caveats. Settlement (below) passes `before = kickoff`; a capture inside
 * this window IS the close. Past it but inside STALE_BOOK_HOURS (book-feeds.js
 * — the same bound the shopping board already uses for "the aggregator
 * stopped tracking this book"), it is the best reachable stand-in, and is
 * marked as one; past STALE_BOOK_HOURS there is no reachable line at all.
 */
const NEAR_KICKOFF_HOURS = 6;

/**
 * Pinnacle's line closest to `before` (settlement passes kickoff), tiered by
 * how far that line actually sits from `before`:
 *   1. a live `nfl_line_snapshots` capture within NEAR_KICKOFF_HOURS — the
 *      real close, `is_fallback: false`.
 *   2. the nearest live capture at or before `before` regardless of tier 1,
 *      when it lands inside STALE_BOOK_HOURS instead — accepted, but
 *      `is_fallback: true` with the actual gap recorded, since it stands in
 *      for a close it is not.
 *   3. failing that, the archive's `phase='close'` row, gated by the SAME
 *      window against `before` rather than trusted on its label alone: on a
 *      live week that row can be a one-time sync from days before kickoff —
 *      verified against real 2026 week 1 data, every archived "close" row for
 *      games not yet played sits 197-2,491 hours from its own kickoff, not a
 *      closing line at all. It earns tier 1 or tier 2 on the same gap check a
 *      live capture would, never a free pass.
 * Beyond STALE_BOOK_HOURS in every tier: no reachable line — return null and
 * let the caller keep waiting rather than settle against noise. A quote is
 * never taken from after `before` — CLV must not leak in-game price action.
 *
 * That invariant used to hold only for the live branch (`captured_at<=?`,
 * above): the archived branch had no `book_updated_at<=?` filter at all, so
 * an archived close row whose book_updated_at fell AFTER `before` could still
 * be picked whenever its gap to `before` was small enough — a quote taken
 * from after the boundary this function exists to enforce. Fixed below by
 * gating the archived query the same way the live one already is.
 *
 * `receiptAsOf`, when given, additionally requires the archive row's
 * `fetched_at` (this system's real receipt clock; see migration
 * 052_line_snapshot_receipt_clock.js) to be at or before it — settleBeatTheClose
 * passes its own `now` here, so a close this system had not actually
 * backfilled yet cannot be used to grade CLV, the same receipt-clock leak
 * already closed in shoppingFor (nfl-expert-council.js).
 */
export function pinnacleLineAt(season, week, home, away, market, before = null, names = teamNames(), receiptAsOf = null) {
  const liveSide = market === 'spreads' ? (names.get(home) ?? home) : 'Over';
  const archiveSide = market === 'spreads' ? home : 'Over';
  const live = row(`SELECT line, captured_at at FROM nfl_line_snapshots
    WHERE provider='free:pinnacle' AND market=? AND home_team=? AND away_team=? AND side=? ${before ? 'AND captured_at<=?' : ''}
    ORDER BY captured_at DESC LIMIT 1`, ...[market, names.get(home) ?? home, names.get(away) ?? away, liveSide, ...(before ? [before] : [])]);
  const archived = row(`SELECT line, book_updated_at at FROM nfl_odds_archive
    WHERE season=? AND week=? AND home=? AND market=? AND side=? AND book='pinnacle' AND phase='close'
      ${before ? 'AND book_updated_at<=?' : ''} ${receiptAsOf ? 'AND fetched_at<=?' : ''} LIMIT 1`,
  ...[season, week, home, market, archiveSide, ...(before ? [before] : []), ...(receiptAsOf ? [receiptAsOf] : [])]);

  // A plain "what's the line right now" read (signalsFor's pinnacle_move_so_far,
  // no `before`) has no kickoff to be near — keep the old, unflagged preference
  // for a live capture over the archive, with no fallback bookkeeping.
  if (!before) return live ? { line: live.line, at: live.at, source: 'free:pinnacle', is_fallback: false }
    : archived ? { line: archived.line, at: archived.at, source: 'archive:pinnacle:close', is_fallback: false } : null;

  const beforeMs = Date.parse(before);
  const gapHours = at => Math.abs(beforeMs - Date.parse(at)) / 3.6e6;
  const candidates = [];
  if (live) candidates.push({ line: live.line, at: live.at, gap: gapHours(live.at), fromLive: true });
  if (archived) candidates.push({ line: archived.line, at: archived.at, gap: gapHours(archived.at), fromLive: false });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.gap - b.gap);
  const best = candidates[0];
  if (best.gap > STALE_BOOK_HOURS) return null; // nothing reachable close enough to trust — stay waiting.
  const isFallback = best.gap > NEAR_KICKOFF_HOURS;
  const source = best.fromLive
    ? (isFallback ? 'free:pinnacle:fallback-window' : 'free:pinnacle')
    : (isFallback ? 'archive:pinnacle:close:fallback' : 'archive:pinnacle:close');
  return { line: best.line, at: best.at, source, is_fallback: isFallback,
    ...(isFallback ? { fallback_reason: `no ${best.fromLive ? 'Pinnacle capture' : 'live Pinnacle capture; nearest source is an archived close row'} within `
      + `${NEAR_KICKOFF_HOURS}h of kickoff; used the nearest available line, ${r3(best.gap)}h away` } : {}) };
}

/**
 * Best reachable quote on the latest capture for one side: the most
 * favourable line, then price, among books whose OWN price is not stale
 * (see `isFreshQuote` — the aggregator can serve a cached number for a book
 * it has not actually re-polled, which is not a real reachable price).
 *
 * Books are polled on separate schedules (book-feeds.js: Pinnacle and
 * OddsTrader every 5 minutes; Kambi/Bovada/FanDuel hourly), so their
 * `captured_at` values legitimately differ by minutes even when every one is
 * still the current standing price. This used to join on one event-wide
 * MAX(captured_at) by exact equality, which silently dropped every book
 * except whichever provider happened to be polled last -- the identical bug
 * `nfl-shopping-board.js#simultaneousQuotes` was fixed for, with the same
 * bounded `CAPTURE_WINDOW_MS` reused here so the two call sites can't drift
 * apart on what "simultaneous" means.
 */
export function bestReachable(home, away, market, side, names = teamNames()) {
  const sideName = side === home ? (names.get(home) ?? home) : side === away ? (names.get(away) ?? away) : side;
  const homeName = names.get(home) ?? home, awayName = names.get(away) ?? away;
  // Each book's OWN latest row for this side, joined back to its own
  // captured_at rather than to one shared timestamp every book must match.
  const allQuotes = rows(`SELECT s.book, s.line, s.price, s.book_updated_at, s.captured_at
     FROM nfl_line_snapshots s
     JOIN (SELECT book, MAX(captured_at) AS captured_at FROM nfl_line_snapshots
           WHERE provider LIKE 'free:%' AND market=? AND home_team=? AND away_team=? AND side=?
           GROUP BY book) latest
       ON latest.book = s.book AND latest.captured_at = s.captured_at
     WHERE s.provider LIKE 'free:%' AND s.market=? AND s.home_team=? AND s.away_team=? AND s.side=?`,
    market, homeName, awayName, sideName, market, homeName, awayName, sideName);
  if (!allQuotes.length) return null;

  const freshest = allQuotes.reduce((m, q) => (Date.parse(q.captured_at) > Date.parse(m) ? q.captured_at : m), allQuotes[0].captured_at);
  // A book whose own latest poll trails the freshest book here by more than
  // the capture window is excluded from the comparison and reported as such
  // -- rather than just being invisible, the way the old equality join left it.
  const withinWindow = allQuotes.filter(q => Date.parse(freshest) - Date.parse(q.captured_at) <= CAPTURE_WINDOW_MS);
  const windowDropped = allQuotes.length - withinWindow.length;

  const quotes = withinWindow.filter(q => isFreshQuote(q.captured_at, q.book_updated_at));
  if (!quotes.length) return null;
  // A bettor wants the largest line for a spread side (more points) or an under, the smallest for an over; then the best price.
  const wantHigh = market === 'spreads' || side === 'Under';
  const ordered = [...quotes].sort((a, b) => (wantHigh ? b.line - a.line : a.line - b.line) || b.price - a.price);
  const { book_updated_at, captured_at, ...best } = ordered[0];
  return { ...best, captured_at: freshest, books: quotes.length,
    // Dropped for a stale book_updated_at stamp among the books actually
    // compared (unchanged meaning from before this fix).
    stale_dropped: withinWindow.length - quotes.length,
    // New: dropped only because that book's own latest poll fell outside the
    // capture window -- previously these books vanished with no count at all.
    window_dropped: windowDropped };
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
    const opener = openerFor(game.season, game.week, game.home, game.away, market, names, now);
    if (!opener) continue;
    const current = pinnacleLineAt(game.season, game.week, game.home, game.away, market, null, names, now);
    const push = (signal, value, detail = {}) => out.push({ market, signal, value: r3(value), opener_line: opener.line, opener_at: opener.at,
      current_line: current?.line ?? null, detail: { ...detail, opener_source: opener.source } });
    if (!pred?.error) {
      // Toward-home / toward-over convention, as in the study: positive means the ratings line sits past the opener on that side.
      push(market === 'spreads' ? 'ratings_vs_open' : 'ratings_vs_open_total',
        market === 'spreads' ? pred.predicted_margin + opener.line : pred.predicted_total - opener.line,
        { predicted_margin: pred.predicted_margin, predicted_total: pred.predicted_total });
    }
    if (market === 'spreads') {
      // External published lines, same sign convention (a home line is negative when home is favoured,
      // so opener − external line is positive when the external number leans further toward home).
      const nf = nfeloFeatures(game.season, game.week, game.home, game.away);
      if (Number.isFinite(nf.nfelo_pre_line)) push('nfelo_pre_vs_open', opener.line - nf.nfelo_pre_line, { nfelo_pre_line: nf.nfelo_pre_line, qb_adj_diff: nf.qb_adj_diff });
      const ext = externalRatingsFeatures(game.season, game.week, game.home, game.away);
      if (Number.isFinite(ext.teamrankings_diff)) push('teamrankings_vs_open', ext.teamrankings_diff + opener.line, { teamrankings_diff: ext.teamrankings_diff, fpi_diff: ext.fpi_diff });
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
    const close = pinnacleLineAt(d.season, d.week, d.home_team, d.away_team, market, kickoff, names, now);
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
      now, r3(clv), result, JSON.stringify({ close_line: close.line, close_at: close.at, close_source: close.source,
        close_is_fallback: close.is_fallback === true, close_fallback_reason: close.fallback_reason ?? null,
        kickoff, stake_units: 0 }), d.id);
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
      captured_at, settled_at, result, clv_points, feature_snapshot_json, outcome_json FROM shadow_decisions
    WHERE ${filters.join(' AND ')} ORDER BY captured_at DESC`, ...params);
  for (const d of decisions) {
    try { d.feature = JSON.parse(d.feature_snapshot_json || '{}'); } catch { d.feature = {}; }
    let outcome = {}; try { outcome = JSON.parse(d.outcome_json || '{}'); } catch { /* leave empty */ }
    d.stale_price = d.feature.stale_price_at_decision === true;
    // Never let a fallback close quote (see pinnacleLineAt) read as an ordinary
    // settlement — carry the flag through to every consumer of this list.
    d.close_is_fallback = outcome.close_is_fallback === true;
    d.close_fallback_reason = outcome.close_fallback_reason ?? null;
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
    decisions: decisions.slice(0, 60).map(d => ({ ...d, feature_snapshot_json: undefined, outcome_json: undefined })),
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
