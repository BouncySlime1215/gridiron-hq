/**
 * The betting home page's data, in one request.
 *
 * Deliberately one endpoint rather than five: the landing page's whole job is
 * to answer "how are we doing" at a glance, and that answer should arrive as a
 * single consistent snapshot instead of five independently-loading cards.
 */
import { Router } from 'express';
import { standing as spreadStanding, allPickResults } from '../services/nfl-auto-picks.js';
import { totalPicksStanding, gradeTotalPicks } from '../services/nfl-props.js';
import { accuracy } from '../services/nfl-market.js';
import { countVariables } from '../services/nfl-features.js';
import { usage as oddsUsage } from '../services/odds-api.js';
import { rows } from '../db/index.js';
import { realBreakEven } from '../services/nfl-execution-edge.js';
import { wongHistory, teaserEV } from '../services/nfl-teasers.js';
import { propEdgeEvidence } from '../services/nfl-prop-clv.js';
import { shoppingBoard, findMiddles, executionBoardSummary, bookHold } from '../services/nfl-shopping-board.js';
import { recentMoves, capturesWorthSpending, espnWatchStatus, currentSlate } from '../services/nfl-espn-line-watch.js';
import { findTeaserLegs } from '../services/nfl-teasers.js';
import { sgpAnalysis, propCorrelationTable, fitPropCorrelations } from '../services/nfl-prop-correlation.js';
import { requireModelPermission } from '../modeling/authz.js';
import { latestCoverCalibration } from '../services/nfl-cover-calibration.js';

const r = Router();

/** Combines the spread and total ledgers into one NFL record. */
function nflStanding() {
  const spreads = allPickResults();
  const totals = gradeTotalPicks();
  const all = [...spreads, ...totals];
  const settled = all.filter(x => x.status === 'Won' || x.status === 'Lost');
  const wins = settled.filter(x => x.status === 'Won').length;
  const losses = settled.filter(x => x.status === 'Lost').length;
  return {
    wins, losses,
    pushes: all.filter(x => x.status === 'Push').length,
    pending: all.filter(x => x.status === 'Pending').length,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    units: +all.reduce((s, x) => s + (x.units ?? 0), 0).toFixed(2),
    bets: all.length,
    by_market: {
      spread: spreadStanding(),
      total: totalPicksStanding()
    }
  };
}

/**
 * MLB's ledger lives in localStorage-backed auto-picks on the client for the
 * slip, but the auto-pick table is server-side, so the record is computed the
 * same way here. Grading needs the results feed, which the props route already
 * proxies — so this reports only what can be settled from stored picks.
 */
function mlbStanding() {
  const picks = rows(`SELECT * FROM props_auto_picks ORDER BY pick_date DESC, rank`);
  return {
    tracked_picks: picks.length,
    days_tracked: new Set(picks.map(p => p.pick_date)).size,
    latest_slate: picks[0]?.pick_date ?? null,
    note: 'Grading runs client-side against the results feed on the Auto Picks page.'
  };
}

/**
 * What actually has a case for being +EV right now, cached hourly.
 *
 * Prediction (win-accuracy/margin-MAE above) and execution are different
 * questions — 0 of 21 spread models beat the closing line, but the teaser
 * edge and real vig are properties of the MARKET, not a forecast, so they
 * don't need the same walk-forward re-fit on every request.
 */
let edgeCache = null;
function edgeSnapshot() {
  if (edgeCache && Date.now() - edgeCache.at < 3600e3) return edgeCache.value;
  let value;
  try {
    const hist = wongHistory();
    value = {
      teaser: { ...hist, ev_at_110: teaserEV({ americanPrice: -110, legRate: hist.win_rate, standardError: hist.standard_error }),
        ev_at_130: teaserEV({ americanPrice: -130, legRate: hist.win_rate, standardError: hist.standard_error }) },
      break_even: realBreakEven(),
      prop_edge: propEdgeEvidence()
    };
  } catch (e) { value = { error: e.message }; }
  edgeCache = { at: Date.now(), value };
  return value;
}

r.get('/summary', (req, res, next) => {
  try {
    let modelAccuracy = null;
    try { modelAccuracy = accuracy(); } catch { /* model not fitted yet */ }
    res.json({
      nfl: {
        standing: nflStanding(),
        model: modelAccuracy?.error ? null : modelAccuracy,
        variables: countVariables()
      },
      mlb: { standing: mlbStanding() },
      odds_api: oddsUsage(),
      edges: edgeSnapshot()
    });
  } catch (e) { next(e); }
});

/**
 * The shopping board. Deliberately a plain GET with no permission gate: it
 * reads snapshots already captured and forecasts nothing, so there is no model
 * to protect and no credits to spend.
 */
r.get('/execution/board', (req, res, next) => {
  try {
    const market = ['spreads', 'totals', 'h2h'].includes(req.query.market) ? req.query.market : 'spreads';
    res.json({
      market,
      summary: executionBoardSummary(),
      sides: shoppingBoard({ market, limit: Math.min(60, Number(req.query.limit) || 25) }),
      middles: market === 'spreads' ? findMiddles({ limit: 12 }) : [],
      // The largest cost a bettor actually controls, and the only lever on this
      // board that works without any forecast being correct.
      hold: bookHold()
    });
  } catch (e) { next(e); }
});

/**
 * One honest read on operational health.
 *
 * The hub used to lead with the auto-pick model, which is the one component
 * measured as settled-negative. This is the strip that replaces that framing:
 * what is actually working, what is blocked, and on what. Every field is a
 * live measurement, not a status someone typed in.
 */
r.get('/status', (_req, res, next) => {
  try {
    const odds = oddsUsage();
    const board = executionBoardSummary();
    const movement = espnWatchStatus();
    const props = propEdgeEvidence();
    const cal = latestCoverCalibration(Number(process.env.NFL_SEASON) || 2026);
    const teaserHist = wongHistory();
    const teaser110 = teaserEV({ americanPrice: -110, legRate: teaserHist.win_rate,
      standardError: teaserHist.standard_error });

    const credits = odds.requests_remaining;
    return res.json({
      // Ordered the way the plan orders them: structural edges first, because
      // those are the ones that do not require beating the market.
      edges: [
        { id: 'execution', label: 'Line shopping', live: board.shoppable_sides > 0,
          headline: board.shoppable_sides > 0
            ? `${board.shoppable_sides} shoppable sides · best ${(board.best_edge * 100).toFixed(1)}%` : 'No stored quotes',
          detail: board.stale ? 'Stored snapshots are stale — fresh capture needs credits.'
            : 'Priced from simultaneous multi-book quotes.',
          blocked_by: board.stale ? 'credits' : null },
        { id: 'teasers', label: 'Wong teasers', live: teaser110.ev_per_bet > 0,
          headline: `${(teaser110.ev_per_bet * 100).toFixed(2)}% EV at -110`,
          detail: `${teaserHist.win_rate ? (teaserHist.win_rate * 100).toFixed(1) : '—'}% on ${teaserHist.legs?.toLocaleString?.() ?? '—'} legs. The price is the whole edge.`,
          blocked_by: null },
        { id: 'correlation', label: 'Parlay correlation', live: true,
          headline: 'Copula priced', detail: 'Fitted on local usage history; owes forward CLV before sizing.',
          blocked_by: null },
        { id: 'props', label: 'Prop edge', live: false,
          headline: `${props.captured_quotes ?? 0} quotes · ${props.settled ?? 0} settled`,
          detail: props.verdict, blocked_by: 'settled sample' }
      ],
      model: {
        // Stated plainly rather than buried: this is the component that does not work.
        calibration_gate: cal?.metrics?.forward_gate_passed ? 'passed' : 'blocked',
        calibration_detail: cal
          ? `walk-forward slope ${cal.metrics.walk_forward_calibration_slope ?? '—'} (gate 0.7–1.3); model Brier ${cal.metrics.walk_forward_calibrated_brier ?? '—'} vs market ${cal.metrics.walk_forward_market_brier ?? '—'}`
          : 'no fitted calibration on record',
        sizing_allowed: !!cal?.metrics?.forward_gate_passed
      },
      data: {
        credits_remaining: credits,
        credits_used: odds.requests_used,
        // The free detector is what keeps a small budget usable, so it is
        // reported next to the metered one rather than hidden on another page.
        free_detector: { events_tracked: movement.events_tracked, moves: movement.moves_detected,
          last_poll: movement.last_poll, worth_capturing: movement.worth_capturing },
        capture_stale: board.stale, latest_multibook_capture: board.latest_capture
      }
    });
  } catch (e) { next(e); }
});

/** Reference-line movement log. Free to read and free to fill — no credits involved. */
r.get('/execution/movement', (req, res, next) => {
  try {
    res.json({
      status: espnWatchStatus(),
      moves: recentMoves({ hours: Math.min(336, Number(req.query.hours) || 72) }),
      worth_capturing: capturesWorthSpending()
    });
  } catch (e) { next(e); }
});

/**
 * Wong teaser candidates on the live slate, fed from the free ESPN reference
 * lines rather than the paid API.
 *
 * `price` is a query parameter and defaults to the -110 the historical +6.50%
 * EV was measured at, because the price is the whole edge: the identical bet is
 * -1.30% at -130. Nothing here can see what your book is actually offering, so
 * the honest contract is "tell me your price and I will tell you if it clears".
 */
r.get('/teasers/candidates', (req, res, next) => {
  try {
    const price = Number.isFinite(Number(req.query.price)) ? Number(req.query.price) : -110;
    const slate = currentSlate();
    const out = findTeaserLegs(slate.sides, { americanPrice: price });
    res.json({
      season: slate.season, week: slate.week, games_on_slate: slate.games,
      quoted_price: price, source: 'ESPN reference lines (free)',
      ...out,
      price_note: 'Teasers are not quoted by the odds API, so this cannot verify availability. ' +
        'Check the price at your book and re-query with ?price= to see whether it still clears.'
    });
  } catch (e) { next(e); }
});

/** Fitted prop-stat correlations — the input to same-game parlay pricing. */
r.get('/sgp/correlations', (req, res, next) => {
  try { res.json({ correlations: propCorrelationTable({ limit: Math.min(120, Number(req.query.limit) || 40) }) }); }
  catch (e) { next(e); }
});

/**
 * Price a same-game parlay against the joint distribution. Read-only maths on
 * data already local — no credits, no model promotion, nothing persisted.
 */
r.post('/sgp/price', (req, res, next) => {
  try { res.json(sgpAnalysis({ legs: req.body?.legs, trials: Math.min(200000, Number(req.body?.trials) || 40000) })); }
  catch (e) { next(e); }
});

/** Refit from local usage history. Cheap, but a write, so it stays gated. */
r.post('/sgp/fit', requireModelPermission('model:train'), (_req, res, next) => {
  try { res.json(fitPropCorrelations()); } catch (e) { next(e); }
});

export default r;
