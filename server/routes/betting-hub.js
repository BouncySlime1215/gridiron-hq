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
import { abstentionAudit } from '../services/nfl-abstention-audit.js';

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
      hold: bookHold({ sport: 'nfl' })
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

/**
 * The vig, per book, in any sport we hold two-sided quotes for.
 *
 * Nothing in the hold calculation knows what sport it is looking at — a hold is
 * a property of two prices. Pointing it at MLB shows that player props cost
 * roughly double what NFL sides do, which is the single most important fact
 * about whether a prop edge is worth chasing.
 */
r.get('/hold', (req, res, next) => {
  try {
    const sport = req.query.sport === 'mlb' ? 'mlb' : 'nfl';
    const nfl = bookHold({ sport: 'nfl' });
    const mlb = bookHold({ sport: 'mlb' });
    res.json({
      requested: sport,
      hold: sport === 'mlb' ? mlb : nfl,
      comparison: (nfl.books?.length && mlb.books?.length) ? {
        nfl_cheapest: nfl.books[0], mlb_cheapest: mlb.books[0],
        prop_premium: +(mlb.books[0].hold - nfl.books[0].hold).toFixed(4),
        note: 'MLB rows are player props and NFL rows are sides. Props carry the higher margin ' +
          'in every book measured, so a prop edge has to be materially larger than a sides edge ' +
          'to clear the same bar.'
      } : null
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

/**
 * What happened on the games the policy refused. Cached, because a five-season
 * replay is over a minute of blocking CPU.
 */
r.get('/abstentions', (_req, res, next) => {
  try { res.json(abstentionAudit()); } catch (e) { next(e); }
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

/**
 * Do our signals lead the market, or follow it?
 *
 * The one question modelling cannot answer and latency can. Free — measured
 * against the ESPN reference line, not the metered odds feed.
 */
r.get('/latency', async (req, res, next) => {
  try {
    const { signalLeadTimes } = await import('../services/signal-latency.js');
    res.json(signalLeadTimes({
      windowHours: Math.min(168, Number(req.query.window_hours) || 48),
      sinceDays: Math.min(365, Number(req.query.since_days) || 60) }));
  } catch (e) { next(e); }
});

/** Which feeds are actually running, and does anything downstream read them. */
r.get('/pipeline', async (req, res, next) => {
  try {
    const { pipelineHealth } = await import('../services/signal-latency.js');
    const { schedulerStatus } = await import('../services/scheduler.js');
    res.json({ ...pipelineHealth(), scheduler: schedulerStatus() });
  } catch (e) { next(e); }
});

/* ------------------------------------------------- execution and auditing */

/**
 * Route a decided bet to the book that pays most for it.
 *
 * The only surface here built on a measured positive: book hold spans 3.09% to
 * 5.54%, worth 1.22 points off the win rate you need, and it requires being
 * right about nothing.
 */
r.get('/execution/route', async (req, res, next) => {
  try {
    const { routeBet } = await import('../services/nfl-execution.js');
    res.json(routeBet({ eventId: req.query.event_id ?? null, matchup: req.query.matchup ?? null,
      market: req.query.market ?? 'spreads', side: req.query.side,
      stakeUnits: Number(req.query.units) || 1 }));
  } catch (e) { next(e); }
});

/** Route the whole slate and report what the routing is worth in aggregate. */
r.get('/execution/slate', async (req, res, next) => {
  try {
    const { routeSlate } = await import('../services/nfl-execution.js');
    res.json(routeSlate({ market: req.query.market ?? 'spreads',
      limit: Math.min(80, Number(req.query.limit) || 40) }));
  } catch (e) { next(e); }
});

/** Record a routing decision so the shopping claim stays checkable. */
r.post('/execution/log', async (req, res, next) => {
  try {
    const { routeBet, logExecution } = await import('../services/nfl-execution.js');
    const route = routeBet({ eventId: req.query.event_id ?? null, matchup: req.query.matchup ?? null,
      market: req.query.market ?? 'spreads', side: req.query.side,
      stakeUnits: Number(req.query.units) || 1 });
    if (route.error) return res.json(route);
    res.json({ ...logExecution(route, { note: req.query.note ?? null }), route });
  } catch (e) { next(e); }
});

/** Cumulative realised savings from routing. */
r.get('/execution/ledger', async (req, res, next) => {
  try {
    const { executionLedger } = await import('../services/nfl-execution.js');
    res.json(executionLedger({ limit: Math.min(500, Number(req.query.limit) || 100) }));
  } catch (e) { next(e); }
});

/**
 * The audit registry: preregistered, sealed-on-first-run, and counted against a
 * multiple-comparisons correction so repeated testing cannot quietly manufacture
 * a discovery.
 */
r.get('/audits', async (req, res, next) => {
  try {
    const { auditHistory } = await import('../services/audit-registry.js');
    res.json(auditHistory({ alpha: Number(req.query.alpha) || 0.05 }));
  } catch (e) { next(e); }
});

r.get('/audits/:id', async (req, res, next) => {
  try {
    const { auditDetail } = await import('../services/audit-registry.js');
    res.json(auditDetail(Number(req.params.id)));
  } catch (e) { next(e); }
});

/** Is every built module actually wired into the running application? */
r.get('/system/connectivity', async (req, res, next) => {
  try {
    const { connectivityAudit } = await import('../services/system-connectivity.js');
    res.json(connectivityAudit({ expectedOrphans: [] }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------- prediction markets */

/** Snapshot Kalshi + Polymarket NFL markets and the public trade tape. */
r.post('/prediction/capture', async (req, res, next) => {
  try {
    const m = await import('../services/prediction-markets.js');
    const [kalshi, flow, poly] = await Promise.all([
      m.captureKalshi({}), m.captureKalshiFlow({}), m.capturePolymarket({})
    ]);
    res.json({ kalshi, flow, polymarket: poly, status: m.predictionMarketStatus() });
  } catch (e) { next(e); }
});

/** What the prediction-market corpus holds. */
r.get('/prediction/status', async (req, res, next) => {
  try {
    const { predictionMarketStatus } = await import('../services/prediction-markets.js');
    res.json(predictionMarketStatus());
  } catch (e) { next(e); }
});

/** Where the exchange disagrees with the sportsbook reference line. */
r.get('/prediction/divergence', async (req, res, next) => {
  try {
    const { exchangeVsBook } = await import('../services/prediction-markets.js');
    res.json(exchangeVsBook({ minGap: Number(req.query.min_gap) || 0.02 }));
  } catch (e) { next(e); }
});

/** Large aggressive orders — the closest thing to a public whale tape. */
r.get('/prediction/flow', async (req, res, next) => {
  try {
    const { whaleFlow } = await import('../services/prediction-markets.js');
    res.json(whaleFlow({ hours: Number(req.query.hours) || 48,
      minNotional: Number(req.query.min_notional) || 500 }));
  } catch (e) { next(e); }
});

/** What each venue really costs once the exchange's trading fee is included. */
r.get('/prediction/cost', async (req, res, next) => {
  try {
    const { venueCostComparison } = await import('../services/prediction-markets.js');
    res.json(venueCostComparison({}));
  } catch (e) { next(e); }
});

/* --------------------------------------------- polymarket and live edge */

/** Ingest NFL markets, real order books, and hourly price history. */
r.post('/polymarket/ingest', async (req, res, next) => {
  try {
    const m = await import('../services/polymarket.js');
    const markets = await m.ingestPolymarketNfl({});
    const books = await m.captureOrderBooks({ minVolume: Number(req.query.min_volume) || 1000 });
    const history = req.query.history === '1' ? await m.ingestPriceHistory({}) : { skipped: true };
    res.json({ markets, books, history, status: m.polymarketStatus() });
  } catch (e) { next(e); }
});

/** What Polymarket costs, conditional on depth. */
r.get('/polymarket/cost', async (req, res, next) => {
  try {
    const { polymarketCost } = await import('../services/polymarket.js');
    res.json(polymarketCost({}));
  } catch (e) { next(e); }
});

r.get('/polymarket/status', async (req, res, next) => {
  try {
    const { polymarketStatus } = await import('../services/polymarket.js');
    res.json(polymarketStatus());
  } catch (e) { next(e); }
});

/** Do prices move after news, and how fast? */
r.get('/polymarket/news-response', async (req, res, next) => {
  try {
    const { newsPriceResponse } = await import('../services/polymarket.js');
    res.json(newsPriceResponse({ windowHours: Number(req.query.hours) || 6 }));
  } catch (e) { next(e); }
});

/** Live in-game board: ESPN state, validated model, tradeable price. */
r.get('/live/board', async (req, res, next) => {
  try {
    const { liveBoard } = await import('../services/live-edge.js');
    res.json(await liveBoard({}));
  } catch (e) { next(e); }
});

/** Price one hypothetical live state against a market probability. */
r.get('/live/edge', async (req, res, next) => {
  try {
    const { liveEdge } = await import('../services/live-edge.js');
    res.json(liveEdge({
      homeScore: Number(req.query.home) || 0, awayScore: Number(req.query.away) || 0,
      secondsLeft: Number(req.query.seconds) || 900,
      marketProbability: req.query.market == null ? null : Number(req.query.market),
      depth: req.query.depth == null ? null : Number(req.query.depth),
      secondsSinceStateChange: req.query.since == null ? null : Number(req.query.since) }));
  } catch (e) { next(e); }
});

r.get('/live/status', async (req, res, next) => {
  try {
    const { liveEdgeStatus } = await import('../services/live-edge.js');
    res.json(liveEdgeStatus());
  } catch (e) { next(e); }
});

export default r;
