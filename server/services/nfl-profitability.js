/** Operational controls for the evidence-gated NFL profitability plan. */
import { db, rows, run } from '../db/index.js';
import { propClvStatus, propDecisionPolicyHash, PROP_DECISION_POLICY,
  propEdgeEvidence, propHorizonCoverage, propMarketScorecards,
  propMatchCoverage, propSettlementHealth } from './nfl-prop-clv.js';
import { usage as oddsUsage } from './odds-api.js';
import { ffOpportunityStatus } from './ffopportunity.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_teaser_price_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    book TEXT NOT NULL,
    teaser_points REAL NOT NULL,
    legs INTEGER NOT NULL,
    american_price INTEGER NOT NULL,
    different_games_required INTEGER NOT NULL DEFAULT 1,
    push_rule TEXT,
    reachable INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    UNIQUE(captured_at,book,teaser_points,legs)
  );
`);

export const EXTERNAL_MODEL_SOURCES = Object.freeze([
  {
    id: 'nfldata_games', repo: 'nflverse/nfldata', license: 'source dataset; upstream repository has no detected SPDX license',
    url: 'https://github.com/nflverse/nfldata/blob/master/data/games.csv',
    pinned_commit: '36f4383926648f038ab2ebb777d6b1d68380f5e3',
    role: 'Historical closing spreads, totals, prices, results, weather, rest and venue context',
    integration: 'production_data', copied_code: false
  },
  {
    id: 'nflfastr', repo: 'nflverse/nflfastR', license: 'GPL-3.0-style upstream license; no code copied',
    url: 'https://github.com/nflverse/nflfastR',
    pinned_commit: '5048fc4c9845b00275479257a0f734fe156932c7',
    role: 'Production play-by-play and weekly usage substrate: EPA, CPOE, shares, air yards and game state',
    integration: 'production_data_pipeline', copied_code: false
  },
  {
    id: 'ffopportunity', repo: 'ffverse/ffopportunity', license: 'GPL-3.0; no code copied',
    url: 'https://github.com/ffverse/ffopportunity',
    pinned_commit: '74dcb35a112a71e5349b36abe940316067ec4fec',
    role: 'Expected fantasy opportunity benchmark, ingested weekly and exposed cutoff-safe to the shared player engine',
    integration: 'connected_shadow_benchmark', copied_code: false
  },
  {
    id: 'nfl4th', repo: 'nflverse/nfl4th', license: 'GPL-family upstream license; no code copied',
    url: 'https://github.com/nflverse/nfl4th',
    pinned_commit: 'aca8c66fee105c1e5355c0daf962f64d4353e42b',
    role: 'Game-state and win-probability benchmark concepts',
    integration: 'independent_shadow_features', copied_code: false
  }
]);

export function recordTeaserPrice(input = {}) {
  const book = String(input.book ?? '').trim();
  const teaserPoints = Number(input.teaser_points);
  const legs = Number(input.legs ?? 2);
  const price = Number(input.american_price);
  if (!book || !Number.isFinite(teaserPoints) || !Number.isInteger(legs) || !Number.isInteger(price)) {
    return { error: 'book, teaser_points, integer legs, and integer american_price are required' };
  }
  if (teaserPoints < 5 || teaserPoints > 8 || legs < 2 || legs > 6 || price < -400 || price > 300) {
    return { error: 'teaser configuration is outside the supported validation range' };
  }
  const capturedAt = input.captured_at ? new Date(input.captured_at).toISOString() : new Date().toISOString();
  const result = run(`INSERT INTO nfl_teaser_price_ledger
    (captured_at,book,teaser_points,legs,american_price,different_games_required,push_rule,reachable,notes)
    VALUES (?,?,?,?,?,?,?,?,?)`, capturedAt, book, teaserPoints, legs, price,
  input.different_games_required === false ? 0 : 1, input.push_rule ?? null,
  input.reachable === true ? 1 : 0, input.notes ?? null);
  return { id: result.lastInsertRowid, captured_at: capturedAt, book,
    teaser_points: teaserPoints, legs, american_price: price,
    qualified_wong_price: legs === 2 && teaserPoints === 6 && price >= -115 && input.reachable === true };
}

export function teaserPriceLedger() {
  const prices = rows('SELECT * FROM nfl_teaser_price_ledger ORDER BY captured_at DESC,id DESC LIMIT 100');
  const latestReachable = prices.find(price => price.reachable === 1 && price.legs === 2 && price.teaser_points === 6);
  return {
    prices,
    latest_reachable: latestReachable ?? null,
    wong_price_gate_passed: Boolean(latestReachable && latestReachable.american_price >= -115),
    rule: 'Two-team six-point teaser, different games, both 3 and 7 crossed; recommend only at a reachable price of -115 or better.',
    status: !latestReachable ? 'price_required'
      : latestReachable.american_price >= -115 ? 'eligible_price_observed' : 'offered_price_destroys_edge'
  };
}

function historicalLineCoverage() {
  const summary = rows(`SELECT MIN(season) min_season,MAX(season) max_season,
      COUNT(*) rows,COUNT(DISTINCT season) seasons,
      SUM(spread IS NOT NULL) spread_rows,SUM(total IS NOT NULL) total_rows,
      SUM(open_spread IS NOT NULL) opening_rows
    FROM game_lines`)[0];
  const bySeason = rows(`SELECT season,COUNT(*) rows,SUM(spread IS NOT NULL) spread_rows,
      SUM(total IS NOT NULL) total_rows,SUM(team_score IS NOT NULL) settled_rows
    FROM game_lines GROUP BY season ORDER BY season DESC`);
  return {
    ...summary, by_season: bySeason,
    source: EXTERNAL_MODEL_SOURCES[0],
    limitation: 'nfldata supplies consensus/closing fields, not a trustworthy multi-book historical opener. Opening-line edge remains forward-capture only.'
  };
}

export function profitabilityOperations() {
  const matches = propMatchCoverage();
  const horizons = propHorizonCoverage();
  const settlements = propSettlementHealth();
  const edge = propEdgeEvidence();
  const teaser = teaserPriceLedger();
  const gates = [
    { id: 'model_match', label: 'Supported quote coverage ≥95%', passed: matches.passed,
      actual: matches.rate, target: 0.95 },
    ...horizons.horizons.map(h => ({ id: `capture_t${h.hours_before_kickoff}`,
      label: `T-${h.hours_before_kickoff}h capture ≥90%`, passed: h.passed, actual: h.rate, target: 0.9 })),
    { id: 'settlement', label: 'Result resolution ≥99%', passed: settlements.passed,
      actual: settlements.resolution_rate, target: 0.99 },
    { id: 'forward_sample', label: 'At least 200 settled independent props',
      passed: (edge.settled_bets ?? 0) >= 200, actual: edge.settled_bets ?? 0, target: 200 },
    { id: 'teaser_price', label: 'Reachable Wong teaser price ≥-115', passed: teaser.wong_price_gate_passed,
      actual: teaser.latest_reachable?.american_price ?? null, target: -115 }
  ];
  const alerts = [];
  for (const horizon of horizons.horizons) if (horizon.missed > 0) alerts.push({
    severity: 'critical', code: `missed_t${horizon.hours_before_kickoff}_capture`,
    message: `${horizon.missed} event window(s) passed without a T-${horizon.hours_before_kickoff}h quote. They cannot be reconstructed after kickoff.`
  });
  if (settlements.overdue > 0) alerts.push({ severity: 'critical', code: 'settlement_overdue',
    message: `${settlements.overdue} final prop quote(s) remain unresolved more than 24 hours after kickoff.` });
  if (matches.unresolved > 0) alerts.push({ severity: matches.passed ? 'warning' : 'critical', code: 'identity_unresolved',
    message: `${matches.unresolved} quote(s) still lack a canonical player identity; they remain excluded rather than guessed.` });
  if (!oddsUsage().has_key) alerts.push({ severity: 'critical', code: 'odds_key_runtime_missing',
    message: 'The running process cannot read ODDS_API_KEY, so scheduled prop capture will not continue.' });
  return {
    generated_at: new Date().toISOString(), state: gates.every(gate => gate.passed) ? 'review_eligible' : 'shadow_only',
    policy: { ...PROP_DECISION_POLICY, hash: propDecisionPolicyHash() },
    gates, alerts, prop_quotes: propClvStatus(), match_coverage: matches,
    capture_horizons: horizons, settlement: settlements, edge, teaser,
    market_scorecards: propMarketScorecards(),
    historical_lines: historicalLineCoverage(), external_sources: EXTERNAL_MODEL_SOURCES,
    external_benchmarks: { ffopportunity: ffOpportunityStatus() },
    odds_api: oddsUsage(),
    staking_authority: gates.every(gate => gate.passed) ? 'human-reviewed capped pilot only' : '0 model-derived units'
  };
}
