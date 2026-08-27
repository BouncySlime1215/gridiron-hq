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

export default r;
