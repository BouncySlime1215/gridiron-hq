/**
 * The betting home page's data, in one request.
 *
 * Deliberately one endpoint rather than five: the landing page's whole job is
 * to answer "how are we doing" at a glance, and that answer should arrive as a
 * single consistent snapshot instead of five independently-loading cards.
 */
import { Router } from 'express';
import { cached, fingerprint } from '../services/compute-cache.js';
import { standing as spreadStanding, allPickResults } from '../services/nfl-auto-picks.js';
import { totalPicksStanding, gradeTotalPicks } from '../services/nfl-props.js';
import { accuracy } from '../services/nfl-market.js';
import { countVariables } from '../services/nfl-features.js';
import { usage as oddsUsage } from '../services/odds-api.js';
import { rows } from '../db/index.js';
import { realBreakEven, riskModes } from '../services/nfl-execution-edge.js';
import { wongHistory, teaserEV } from '../services/nfl-teasers.js';
import { propEdgeEvidence } from '../services/nfl-prop-clv.js';
import { shoppingBoard, findMiddles, executionBoardSummary, bookHold } from '../services/nfl-shopping-board.js';
import { recentMoves, capturesWorthSpending, espnWatchStatus, currentSlate } from '../services/nfl-espn-line-watch.js';
import { findTeaserLegs } from '../services/nfl-teasers.js';
import { sgpAnalysis, propCorrelationTable, fitPropCorrelations, recordSgpQuote,
  sgpQuoteEvidence } from '../services/nfl-prop-correlation.js';
import { requireModelPermission } from '../modeling/authz.js';
import { latestCoverCalibration } from '../services/nfl-cover-calibration.js';
import { abstentionAudit } from '../services/nfl-abstention-audit.js';
import { teaserExecutionBoard } from '../services/nfl-teaser-execution.js';
import { bookFeedStatus } from '../services/book-feeds.js';
import { serveReport } from '../services/report-cache.js';
import { polymarketMovement } from '../services/polymarket-lines.js';

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
 * How hard to bet, and what each setting costs.
 *
 * Defaults to the two-leg Wong teaser rate because that is the only edge here
 * that has ever measured positive, and therefore the only thing any staking
 * ladder legitimately applies to.
 */
r.get('/risk-modes', (req, res, next) => {
  try {
    const hist = wongHistory();
    const supplied = req.query.win_probability != null;
    const p = supplied ? Number(req.query.win_probability) : (hist.win_rate ? hist.win_rate ** 2 : null);
    const price = req.query.price == null ? -110 : Number(req.query.price);
    const bankroll = req.query.bankroll == null ? 100 : Number(req.query.bankroll);
    if (supplied && (!Number.isFinite(p) || p <= 0 || p >= 1)) {
      return res.status(400).json({ error: 'win_probability must be a number strictly between 0 and 1' });
    }
    if (!Number.isFinite(price) || price === 0 || (price > -100 && price < 100)) {
      return res.status(400).json({ error: 'price must be valid American odds (at most -100 or at least +100)' });
    }
    if (!Number.isFinite(bankroll) || bankroll <= 0 || bankroll > 1_000_000_000) {
      return res.status(400).json({ error: 'bankroll must be a positive number no greater than 1,000,000,000 units' });
    }
    res.json({
      ...riskModes({
        winProbability: p,
        americanPrice: price,
        bankrollUnits: bankroll
      }),
      priced_on: supplied
        ? 'the win probability you supplied'
        : `a two-leg Wong teaser at ${(hist.win_rate * 100).toFixed(2)}% per leg over ${hist.legs} legs`
    });
  } catch (e) { next(e); }
});

/**
 * Say what the calibration result means, in words, before saying it in numbers.
 *
 * The hub used to lead with "walk-forward slope 1.3698 (gate 0.7–1.3); model
 * Brier 0.2497 vs market 0.2497". Every term in that sentence is precise and
 * none of it tells the person reading it whether they should bet. It is the
 * house style of a paper, not of a tool someone operates.
 *
 * So the plain sentence comes first and the numbers stay underneath it, because
 * the numbers are still what makes the claim checkable — the fix is ordering and
 * translation, not hiding the evidence.
 *
 * Two distinct failures live in this one gate and they read very differently:
 *   slope < 0.7  the model commits harder than it has earned — a stated 70%
 *                lands nearer 60%, and that is the dangerous direction, because
 *                every bet is sized off the overstated number.
 *   slope > 1.3  the model is too timid — the honest answer is further from
 *                50/50 than it is willing to say. Wasteful, not dangerous.
 * Brier is just average squared error on a probability: lower is better, and the
 * only comparison that matters is against the betting line itself.
 */
function plainCalibration(cal) {
  const m = cal?.metrics;
  if (!m) {
    return { calibration_plain: 'The model has never been scored against finished games, so there is no reason yet to trust a number it prints.',
      calibration_numbers: null,
      calibration_detail: 'no fitted calibration on record' };
  }
  const slope = m.walk_forward_calibration_slope;
  const mine = m.walk_forward_calibrated_brier;
  const mkt = m.walk_forward_market_brier;
  const numbers = `Calibration slope ${slope ?? '—'} (needs to land between 0.7 and 1.3). ` +
    `Model error ${mine ?? '—'} vs the betting line's ${mkt ?? '—'} — lower is better.`;

  let plain;
  if (m.forward_gate_passed) {
    plain = 'The model\'s confidence now matches how often it is actually right, so it is allowed to size real bets.';
  } else if (slope != null && slope < 0.7) {
    plain = 'The model is overconfident. When it says a team wins 70% of the time, it happens closer to ' +
      `${Math.round(50 + 20 * slope)}%. Betting on numbers that overstate themselves is how a bankroll goes to zero, so it stays on fake money.`;
  } else if (slope != null && slope > 1.3) {
    plain = 'The model is too cautious — the true answer is further from a coin flip than it is willing to say. ' +
      'That loses opportunity rather than money, but it is still not calibrated, so it stays on fake money.';
  } else {
    plain = 'The model has not cleared its accuracy check, so it stays on fake money.';
  }
  // The comparison that actually settles it. A model that is merely as good as
  // the line cannot beat the line, because the line charges vig and it doesn't.
  if (mine != null && mkt != null && mine >= mkt - 0.0005) {
    plain += ' It is also no more accurate than the betting line itself, and the line takes a cut — matching it means losing slowly.';
  }
  return { calibration_plain: plain, calibration_numbers: numbers, calibration_detail: numbers };
}

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
    const feeds = bookFeedStatus();
    const poly = polymarketMovement({ hours: 72, limit: 20 });
    const props = propEdgeEvidence();
    const cal = latestCoverCalibration(Number(process.env.NFL_SEASON) || 2026);
    const teaserHist = wongHistory();
    const teaser110 = teaserEV({ americanPrice: -110, legRate: teaserHist.win_rate,
      standardError: teaserHist.standard_error });
    const teaserExecution = teaserExecutionBoard();

    const credits = odds.requests_remaining;
    return res.json({
      // Ordered the way the plan orders them: structural edges first, because
      // those are the ones that do not require beating the market.
      edges: [
        { id: 'execution', label: 'Shop for the best price', live: board.shoppable_sides > 0,
          headline: board.shoppable_sides > 0
            ? `${board.shoppable_sides} bets where one book pays more · best is ${(board.best_edge * 100).toFixed(1)}% better`
            : 'No saved prices to compare',
          detail: board.stale
            ? 'The saved prices are old. Comparing books only works if every price was read at the same moment, so this needs a fresh pull.'
            : 'Books disagree on the same game. This finds the one paying most — it needs no opinion about who wins.',
          blocked_by: board.stale ? 'credits' : null },
        { id: 'teasers', label: 'Teasers', live: teaserExecution.eligible_candidates > 0,
          headline: teaserExecution.eligible_candidates > 0
            ? `${teaserExecution.eligible_candidates} ticket${teaserExecution.eligible_candidates === 1 ? '' : 's'} you can actually place`
            : `Won ${(teaserHist.win_rate * 100).toFixed(1)}% historically — enough to profit only at the right price`,
          detail: teaserExecution.eligible_candidates > 0
            ? 'Two games, one book, both moved through the key numbers 3 and 7. Priced and fresh.'
            : `Moving a spread across 3 and 7 won ${(teaserHist.win_rate * 100).toFixed(1)}% of the time over ` +
              `${teaserHist.legs.toLocaleString()} legs — worth ${(teaser110.ev_per_bet * 100).toFixed(1)}¢ per dollar at -110, ` +
              'and a loss at the -130 most books charge. The whole edge is the price your book offers, and nobody has checked it yet.',
          blocked_by: teaserExecution.eligible_candidates > 0 ? null : teaserExecution.status },
        { id: 'correlation', label: 'Parlay pricing', live: false,
          headline: 'Priced, never tested live',
          detail: 'Legs in one parlay rise and fall together, and books price them as if they do not. The math is fitted, ' +
            'but it has never been checked against a real closing price, so it is not trusted yet.',
          blocked_by: 'forward CLV' },
        { id: 'props', label: 'Player props', live: false,
          headline: `${props.captured_quotes ?? 0} prices saved · ${props.settled ?? 0} finished`,
          detail: props.verdict, blocked_by: 'settled sample' }
      ],
      model: {
        // Stated plainly rather than buried: this is the component that does not work.
        calibration_gate: cal?.metrics?.forward_gate_passed ? 'passed' : 'blocked',
        ...plainCalibration(cal),
        sizing_allowed: !!cal?.metrics?.forward_gate_passed
      },
      data: {
        credits_remaining: credits,
        credits_used: odds.requests_used,
        // The free detector is what keeps a small budget usable, so it is
        // reported next to the metered one rather than hidden on another page.
        free_detector: { events_tracked: movement.events_tracked, moves: movement.moves_detected,
          last_poll: movement.last_poll, worth_capturing: movement.worth_capturing },
        // Free multi-book quotes (Pinnacle, OddsTrader's 11 books, BetRivers,
        // Bovada) and Polymarket's implied line are what actually price the
        // slate now; the metered feed is a supplement.
        free_feeds: (() => {
          const latest = feeds.recent_captures?.[0] ?? null;
          return { enabled: feeds.enabled, latest_capture: latest?.captured_at ?? null,
            books: latest?.books ?? 0, games: latest?.events ?? 0, quotes: latest?.quotes ?? 0 };
        })(),
        line_movement: { source: 'polymarket', games: poly.games, recent_moves: poly.recent_moves?.length ?? 0,
          latest: poly.recent_moves?.[0]?.captured_at ?? null },
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
r.get('/execution/movement', async (req, res, next) => {
  try {
    const { captureTriggerStatus } = await import('../services/nfl-capture-dispatch.js');
    const { bookLagDistribution } = await import('../services/signal-latency.js');
    res.json({
      status: espnWatchStatus(),
      moves: recentMoves({ hours: Math.min(336, Number(req.query.hours) || 72) }),
      worth_capturing: capturesWorthSpending(),
      capture_triggers: captureTriggerStatus(), book_latency: bookLagDistribution()
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
 * Executable teaser tickets, built from per-book spread quotes and the latest
 * manually verified teaser payout at each book. Unlike /candidates, this never
 * treats two legs at different books as one ticket and never trusts a stale or
 * negative-EV price.
 */
r.get('/teasers/execution-board', async (_req, res, next) => {
  try {
    const { teaserExecutionBoard } = await import('../services/nfl-teaser-execution.js');
    res.json(teaserExecutionBoard());
  } catch (e) { next(e); }
});

/** Log a paper or manually placed ticket after re-validating every gate. */
r.post('/teasers/executions', async (req, res, next) => {
  try {
    const { recordTeaserExecution } = await import('../services/nfl-teaser-execution.js');
    const out = recordTeaserExecution(req.body ?? {});
    if (out.error) return res.status(out.reasons ? 409 : 400).json(out);
    res.status(201).json(out);
  } catch (e) { next(e); }
});

/** Forward ticket and leg results, kept separate from historical backtests. */
r.get('/teasers/executions', async (req, res, next) => {
  try {
    const { teaserExecutionLedger } = await import('../services/nfl-teaser-execution.js');
    res.json(teaserExecutionLedger({ limit: Math.min(500, Number(req.query.limit) || 100) }));
  } catch (e) { next(e); }
});

r.post('/teasers/executions/:id/settle', async (req, res, next) => {
  try {
    const { settleTeaserExecution } = await import('../services/nfl-teaser-execution.js');
    const out = settleTeaserExecution(req.params.id, req.body ?? {});
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/**
 * What happened on the games the policy refused. Cached, because a five-season
 * replay is over a minute of blocking CPU.
 */
r.get('/abstentions', (_req, res, next) => {
  try {
    // 66 seconds of synchronous replay. Served from the worker-computed store;
    // a stale answer queues a background refresh and this never blocks the app.
    res.json(serveReport('abstention_audit'));
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
  try { res.json(sgpAnalysis({ legs: req.body?.legs, offeredOdds: req.body?.offered_odds,
    trials: Math.min(200000, Number(req.body?.trials) || 40000) })); }
  catch (e) { next(e); }
});

/** Preserve a manually observed SGP candidate or close; this records but never transmits a wager. */
r.post('/sgp/quotes', requireModelPermission('model:execute'), (req, res, next) => {
  try {
    const out = recordSgpQuote(req.body ?? {});
    if (out.error) return res.status(400).json(out);
    res.status(201).json(out);
  } catch (e) { next(e); }
});

r.get('/sgp/quotes', (_req, res, next) => {
  try { res.json(sgpQuoteEvidence()); } catch (e) { next(e); }
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

/**
 * Decay watch: does a finding that already cleared its gate still hold up on
 * fresh, post-approval data? Distinct from /audits above — this never
 * re-runs a sealed audit, it grades already-shipped artifacts (coordinator
 * weights, calibration gates) against data they have never seen. Report
 * only: flags for human review, changes nothing on its own.
 */
r.get('/decay-watch', async (req, res, next) => {
  try {
    const { decayWatchStatus } = await import('../services/decay-watch.js');
    res.json(decayWatchStatus());
  } catch (e) { next(e); }
});

r.get('/decay-watch/history', async (req, res, next) => {
  try {
    const { decayWatchHistory } = await import('../services/decay-watch.js');
    res.json({ runs: decayWatchHistory(Math.min(200, Number(req.query.limit) || 50)) });
  } catch (e) { next(e); }
});

r.post('/decay-watch/run', async (req, res, next) => {
  try {
    const { runDecayWatch } = await import('../services/decay-watch.js');
    res.json(await runDecayWatch({ minN: Number(req.query.min_n) || undefined,
      alpha: Number(req.query.alpha) || undefined }));
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

/* ------------------------------------------------- decision basis */

/** Compile every recorded decision: what the model leans on, and does it work. */
r.get('/decisions', async (req, res, next) => {
  try {
    const { compileDecisionBases } = await import('../services/decision-basis.js');
    res.json(compileDecisionBases({ minDecisions: Number(req.query.min) || 5 }));
  } catch (e) { next(e); }
});

/** Individual decisions with their deterministic, token-free explanations. */
r.get('/decisions/detail', async (req, res, next) => {
  try {
    const { decisionDetail } = await import('../services/decision-basis.js');
    res.json(decisionDetail({ season: req.query.season ? Number(req.query.season) : null,
      week: req.query.week ? Number(req.query.week) : null, home: req.query.home ?? null }));
  } catch (e) { next(e); }
});

/** Record decision bases for a season. */
r.post('/decisions/record', async (req, res, next) => {
  try {
    const { recordSeasonBases } = await import('../services/decision-basis.js');
    res.json(await recordSeasonBases({ season: Number(req.query.season) || 2025 }));
  } catch (e) { next(e); }
});

export default r;
