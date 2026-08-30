/** Operational controls for the evidence-gated NFL profitability plan. */
import { db, rows, run } from '../db/index.js';
import { propClvStatus, propDecisionPolicyHash, PROP_DECISION_POLICY,
  propEdgeEvidence, propHorizonCoverage, propMarketScorecards,
  propMatchCoverage, propSettlementHealth } from './nfl-prop-clv.js';
import { usage as oddsUsage } from './odds-api.js';
import { ffOpportunityStatus } from './ffopportunity.js';
import { validationFirewall } from './nfl-evidence.js';
import { nflModelGrowthStatus } from './nfl-model-growth.js';
import { nflOnlineNeuralStatus } from './nfl-online-neural.js';
import { weeklyLearningStatus } from './weekly-learning.js';

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

const tableExists = name => Boolean(rows(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name)[0]);
const parse = (value, fallback = null) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };

/**
 * A progress plan built from live ledgers, not hand-authored percentages.
 * Completion never means "profitable": each phase names the economic evidence
 * it still owes, and historically failed forecasting remains visibly retired.
 */
function profitabilityPhases({ matches, horizons, settlements, edge, teaser, growth }) {
  const firewall = validationFirewall();
  const blindRow = tableExists('nfl_blind_audit_runs')
    ? rows(`SELECT id,status,next_ordinal,spec_json,final_json,created_at
            FROM nfl_blind_audit_runs ORDER BY id DESC LIMIT 1`)[0] : null;
  const blindSpec = parse(blindRow?.spec_json, {}), blindFinal = parse(blindRow?.final_json, null);
  const blindTotal = blindSpec?.schedule?.length ?? 0;
  const aiRow = tableExists('nfl_ai_replay_runs')
    ? rows(`SELECT id,status,result_json,created_at FROM nfl_ai_replay_runs ORDER BY id DESC LIMIT 1`)[0] : null;
  const aiResult = parse(aiRow?.result_json, null);
  const teaserExecutions = tableExists('nfl_teaser_executions')
    ? rows(`SELECT COUNT(*) tickets,
        SUM(mode='paper') paper,SUM(mode='placed') placed,
        SUM(status!='open') settled,COALESCE(SUM(CASE WHEN mode='placed' THEN profit_units ELSE 0 END),0) profit
        FROM nfl_teaser_executions`)[0] : { tickets: 0, paper: 0, placed: 0, settled: 0, profit: 0 };
  const teaserLegs = tableExists('nfl_teaser_execution_legs')
    ? rows(`SELECT COUNT(*) graded FROM nfl_teaser_execution_legs WHERE result IS NOT NULL`)[0]?.graded ?? 0 : 0;
  const watches = tableExists('nfl_tweet_line_watch')
    ? rows(`SELECT COUNT(*) watches,SUM(resolved=1) resolved FROM nfl_tweet_line_watch`)[0]
    : { watches: 0, resolved: 0 };
  const pricedCloses = Number(edge.settled_bets ?? 0);

  const phases = [
    {
      id: 'integrity', order: 0, title: 'Evidence integrity', state: blindRow?.status === 'complete' ? 'complete' : 'in_progress',
      completed: Number(blindRow?.next_ordinal ?? 0), total: blindTotal || 70,
      headline: blindRow?.status === 'complete' ? 'Historical audit sealed' : 'Historical audit still opening weeks',
      detail: blindFinal?.betting
        ? `${blindFinal.betting.bets} historical bets · ${blindFinal.betting.roi == null ? 'ROI unavailable' : `${(blindFinal.betting.roi * 100).toFixed(1)}% ROI`}. Diagnostic evidence only.`
        : 'The week-chain freezes code, inputs and policy before each historical week opens.',
      next_action: firewall.forward.settled
        ? `Keep settling frozen 2026 decisions (${firewall.forward.settled}/${firewall.forward.target}).`
        : 'Start the frozen 2026 pre-kickoff shadow ledger; historical data cannot become untouched proof.'
    },
    {
      id: 'teaser', order: 1, title: 'Model-free teaser pilot',
      state: teaserExecutions.settled > 0 ? 'measuring' : teaser.wong_price_gate_passed ? 'ready' : 'action_required',
      completed: 1 + Number(teaser.wong_price_gate_passed) + Number(teaserExecutions.tickets > 0) + Number(teaserLegs >= 100), total: 4,
      headline: teaser.wong_price_gate_passed ? `${teaserExecutions.tickets} forward tickets logged` : 'Closest path: verify a reachable price',
      detail: 'Historical leg edge is measured. Profit still depends on same-book execution at −115 or better and forward replication.',
      next_action: !teaser.wong_price_gate_passed ? 'Enter the current two-team, six-point teaser payout from a reachable book.'
        : teaserExecutions.tickets === 0 ? 'Paper-track the first server-validated cross-game ticket.'
        : `Accumulate 100 graded forward legs (${teaserLegs}/100) before treating the historical rate as durable.`
    },
    {
      id: 'news_latency', order: 2, title: 'News-to-line latency', state: Number(watches.resolved ?? 0) >= 30 ? 'review_ready' : 'measuring',
      completed: Math.min(Number(watches.resolved ?? 0), 30), total: 30,
      headline: `${Number(watches.resolved ?? 0)}/${Number(watches.watches ?? 0)} watches resolved`,
      detail: 'Typed news is useful only if a reachable book consistently moves after the source arrives.',
      next_action: 'Keep the free reference-line watcher running and resolve at least 30 timestamped news responses before estimating a lag edge.'
    },
    {
      id: 'props', order: 3, title: 'Props and correlation CLV', state: pricedCloses >= 200 ? 'review_ready' : 'measuring',
      completed: pricedCloses, total: 200,
      headline: `${edge.shadow_decisions ?? 0} decisions · ${pricedCloses}/200 priced closes`,
      detail: `${matches.rate == null ? '—' : `${(matches.rate * 100).toFixed(1)}%`} quote resolution; capture and settlement gates remain independent.`,
      next_action: pricedCloses === 0
        ? 'Preserve the first closing prices; settled outcomes without a close do not measure edge.'
        : 'Continue until mean and median CLV are positive and the week-clustered interval clears zero.'
    },
    {
      id: 'forecast_model', order: 4, title: 'Forecast-model learning',
      state: growth.state === 'current' ? 'measuring' : 'building_data',
      completed: firewall.forward.settled, total: firewall.forward.target,
      headline: growth.state === 'current'
        ? `Feature warehouse and fit current through Week ${growth.learned_through_week}`
        : growth.state === 'waiting_for_regular_season_results'
          ? 'Learning loop armed; waiting for the first finalized week'
          : `Learning pipeline needs attention: ${growth.state.replaceAll('_', ' ')}`,
      detail: 'The failed historical model remains retired from staking. New finalized weeks now become cutoff-safe features and immutable labels for challenger research.',
      next_action: 'Keep forecasts paper-only while the automatic ingest/refit loop accumulates 250 independent forward decisions and positive CLV.'
    }
  ];

  return {
    closest_path: 'teaser',
    verdict: teaser.wong_price_gate_passed
      ? 'Execution-ready for a capped paper pilot; forward profitability is not yet proven.'
      : 'One manual price check away from testing the only measured-positive strategy; zero forward profit proof so far.',
    blind_audit: { id: blindRow?.id ?? null, status: blindRow?.status ?? 'not_started', opened: Number(blindRow?.next_ordinal ?? 0), total: blindTotal,
      classification: blindSpec?.classification ?? null, final: blindFinal, forward: firewall.forward },
    ai_review: { id: aiRow?.id ?? null, status: aiRow?.status ?? 'not_started', reviewed: aiResult?.reviewed ?? 0,
      kept: aiResult?.kept ?? 0, staked: aiResult?.total_units_staked ?? 0, evidence_status: aiResult?.evidence_status ?? null },
    phases
  };
}

export function profitabilityOperations() {
  const matches = propMatchCoverage();
  const horizons = propHorizonCoverage();
  const settlements = propSettlementHealth();
  const edge = propEdgeEvidence();
  const teaser = teaserPriceLedger();
  const growth = nflModelGrowthStatus();
  const neural = nflOnlineNeuralStatus();
  const playerLearning = weeklyLearningStatus();
  const readiness = profitabilityPhases({ matches, horizons, settlements, edge, teaser, growth });
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
    readiness,
    policy: { ...PROP_DECISION_POLICY, hash: propDecisionPolicyHash() },
    gates, alerts, prop_quotes: propClvStatus(), match_coverage: matches,
    capture_horizons: horizons, settlement: settlements, edge, teaser,
    market_scorecards: propMarketScorecards(),
    historical_lines: historicalLineCoverage(), external_sources: EXTERNAL_MODEL_SOURCES,
    model_growth: growth,
    online_neural: neural,
    balanced_online_system: {
      policy: 'Fast weekly adaptation inside bounded challengers; slow promotion into champion behavior; every market keeps its own scorecard.',
      layers: [
        { id: 'feature_warehouse', label: 'Gameplay and advanced data', state: growth.state,
          detail: `Cutoff-safe team, player, snap, depth, injury, PFR and NGS rows through Week ${growth.learned_through_week}.` },
        { id: 'team_ensemble', label: 'Spread and total ensemble', state: growth.active_fit ? 'adaptive' : 'waiting',
          detail: growth.active_fit ? `Next-week fit ${growth.active_fit.model_version}.` : 'The first finalized week will create the current-season fit.' },
        { id: 'roster_value', label: 'Whole-roster injury value', state: 'adaptive_shadow',
          detail: 'Offense, defense and special teams are valued against the observed next man up.' },
        { id: 'player_engine', label: 'Fantasy and usage engine', state: playerLearning.champion.source === 'adaptive' ? 'adaptive' : 'collecting',
          detail: `${Number(playerLearning.snapshots?.settled ?? 0)} frozen player outcomes settled; ${playerLearning.champion.id} is active.` },
        { id: 'props', label: 'Player prop heads', state: 'inherits_player_engine',
          detail: 'Passing, rushing, receiving, receptions and TD share the updated player state but retain separate calibration gates.' },
        { id: 'neural_residual', label: 'Online neural residual', state: neural.production_eligible ? 'review_eligible' : 'adaptive_shadow',
          detail: `${neural.trained_weeks} complete weeks trained; it cannot size a bet before its clustered forward gate passes.` }
      ]
    },
    external_benchmarks: { ffopportunity: ffOpportunityStatus() },
    odds_api: oddsUsage(),
    staking_authority: gates.every(gate => gate.passed) ? 'human-reviewed capped pilot only' : '0 model-derived units'
  };
}
