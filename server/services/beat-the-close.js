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
  ratings_vs_open_total: { market: 'totals', threshold: 1.0, basis: 'Phase 1: totals T0 model +0.36 as a whole; the ratings term alone was weak (+0.08) — candidate, not a passed signal' }
});

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

/** Best reachable quote on the latest capture for one side: the most favourable line, then price. */
export function bestReachable(home, away, market, side, names = teamNames()) {
  const sideName = side === home ? (names.get(home) ?? home) : side === away ? (names.get(away) ?? away) : side;
  const latest = row(`SELECT MAX(captured_at) at FROM nfl_line_snapshots WHERE provider LIKE 'free:%' AND market=? AND home_team=? AND away_team=?`,
    market, names.get(home) ?? home, names.get(away) ?? away)?.at;
  if (!latest) return null;
  const quotes = rows(`SELECT book, line, price FROM nfl_line_snapshots WHERE captured_at=? AND market=? AND home_team=? AND away_team=? AND side=?`,
    latest, market, names.get(home) ?? home, names.get(away) ?? away, sideName);
  if (!quotes.length) return null;
  // A bettor wants the largest line for a spread side (more points) or an under, the smallest for an over; then the best price.
  const wantHigh = market === 'spreads' || side === 'Under';
  const ordered = [...quotes].sort((a, b) => (wantHigh ? b.line - a.line : a.line - b.line) || b.price - a.price);
  return { ...ordered[0], captured_at: latest, books: quotes.length };
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
  let frozen = 0, already = 0, below = 0, noPrice = 0;
  const decisions = [];
  for (const { game, signals } of slateSignals(s, w, now, names)) {
    for (const sig of signals) {
      const rule = RULES[sig.signal];
      if (!rule || !Number.isFinite(sig.centered)) continue;
      if (Math.abs(sig.centered) < rule.threshold) { below++; continue; }
      const side = sig.market === 'spreads' ? (sig.centered > 0 ? game.home : game.away) : (sig.centered > 0 ? 'Over' : 'Under');
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
      run(`INSERT INTO shadow_decisions
        (sport,event_key,market,selection,model_version,probability,market_probability,uncertainty,regime,decision,reason,captured_at,
         season,week,home_team,away_team,line,american_price,quote_at,feature_snapshot_json)
        VALUES ('NFL',?,?,?,?,NULL,NULL,NULL,'beat_the_close','observe',?,?,?,?,?,?,?,?,?,?)`,
      eventKey, marketKey, side, modelVersion, `signal ${sig.signal} centered ${sig.centered} (raw ${sig.value}, slate mean ${sig.slate_mean}) ≥ ${rule.threshold}; zero units; graded by CLV`, now,
      s, w, game.home, game.away, homeLine, quote.price, quote.captured_at, JSON.stringify(feature));
      frozen++;
      decisions.push({ game: `${game.away} at ${game.home}`, market: sig.market, side, signal: sig.signal, value: sig.value, centered: sig.centered, line: quote.line, price: quote.price, book: quote.book, slice: feature.slice });
    }
  }
  return { version: BEAT_THE_CLOSE_VERSION, season: s, week: w, frozen, already_frozen: already, below_threshold: below, no_reachable_price: noPrice, decisions };
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

export function beatTheCloseStatus() {
  const decisions = rows(`SELECT id, season, week, home_team, away_team, market, selection, model_version, line, american_price, quote_at,
      captured_at, settled_at, result, clv_points, feature_snapshot_json FROM shadow_decisions
    WHERE sport='NFL' AND model_version LIKE 'beat-the-close-v%' ORDER BY captured_at DESC`);
  const bySignal = {};
  for (const d of decisions) {
    const signal = d.model_version.split(':').at(-1);
    const b = bySignal[signal] ?? (bySignal[signal] = { frozen: 0, settled: 0, clv: [], won: 0, lost: 0, push: 0 });
    b.frozen++;
    if (d.settled_at != null) { b.settled++; if (Number.isFinite(d.clv_points)) b.clv.push(d.clv_points); if (d.result === 'Won') b.won++; else if (d.result === 'Lost') b.lost++; else if (d.result === 'Push') b.push++; }
  }
  const bySlice = {};
  for (const d of decisions) {
    let slice = 'unknown'; try { slice = JSON.parse(d.feature_snapshot_json || '{}').slice ?? 'unknown'; } catch { /* keep unknown */ }
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
    event_to_move_window: window ? { ...window, examples: window.examples?.slice(0, 8) } : null,
    decisions: decisions.slice(0, 60).map(d => ({ ...d, feature: JSON.parse(d.feature_snapshot_json || '{}'), feature_snapshot_json: undefined })),
    snapshots, latest_signals: latestSignals,
    gate: 'Phase 3: ≥ 200 settled decisions with a week-clustered CLV interval above zero; a signal whose live CLV interval sits below zero two weeks running is retired. Stake stays 0.',
    authority: 'shadow only; no staking authority' };
}
