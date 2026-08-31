/** One evidence-first health report for the unified NFL engine. */
import { rows } from '../db/index.js';
import { profitabilityOperations } from './nfl-profitability.js';
import { newsSignalCoverage } from './nfl-news-signal.js';
import { allSources } from './source-registry.js';
import { schedulerStatus } from './scheduler.js';
import { latestCandidateInputAudit } from './nfl-replay.js';
import { latestCandidateRobustnessReport } from './nfl-candidate-analysis.js';
import { nflDataConsistencyAudit } from './nfl-data-consistency.js';
import { signalReliabilityStatus } from './nfl-signal-reliability.js';
import { nflCoordinationAudit } from './nfl-coordination-audit.js';
import { latestHistoricalNeuralReplay } from './nfl-neural-replay.js';
import { expertCouncilStatus } from './nfl-expert-council.js';
import { nflNewsMarketLatency } from './nfl-news-market-latency.js';
import { postgameTruthStatus } from './nfl-postgame-truth.js';

const number = value => Number(value ?? 0);

function newsInventory() {
  const summary = rows(`SELECT COUNT(*) stories,COUNT(DISTINCT source) sources,
      SUM(published_at >= datetime('now','-24 hours')) fresh_24h,
      MAX(ingested_at) latest_ingest,
      AVG(CASE WHEN published_at >= datetime('now','-7 days')
        THEN MAX(0,(julianday(ingested_at)-julianday(published_at))*1440) END) avg_lag_minutes_7d
    FROM news_items`)[0] ?? {};
  return {
    stories: number(summary.stories),
    sources: number(summary.sources),
    fresh_24h: number(summary.fresh_24h),
    latest_ingest: summary.latest_ingest ?? null,
    avg_lag_minutes_7d: summary.avg_lag_minutes_7d == null ? null : +number(summary.avg_lag_minutes_7d).toFixed(1)
  };
}

function sourceHealth() {
  const sources = allSources();
  return {
    registered: sources.length,
    scheduled: sources.filter(source => source.scheduled).length,
    stale: sources.filter(source => source.stale).length,
    never_run: sources.filter(source => source.last_status === 'never run').length,
    erroring: sources.filter(source => source.last_status === 'error').map(source => source.source),
    stale_sources: sources.filter(source => source.stale).map(source => source.source)
  };
}

function challengerBackfill() {
  const exists = rows(`SELECT 1 ok FROM sqlite_master WHERE type='table'
    AND name='nfl_historical_signal_replay' LIMIT 1`).length > 0;
  if (!exists) return { predictions: 0, signals: [] };
  const signals = rows(`SELECT signal_id,COUNT(*) predictions,
      ROUND(SQRT(AVG((projected_margin-actual_margin)*(projected_margin-actual_margin))),3) margin_rmse,
      ROUND(AVG(CASE WHEN market_margin IS NOT NULL AND projected_margin!=market_margin
        AND actual_margin!=market_margin THEN CASE WHEN
        (projected_margin-market_margin)*(actual_margin-market_margin)>0 THEN 1.0 ELSE 0.0 END END),4) ats_direction_rate
    FROM nfl_historical_signal_replay GROUP BY signal_id ORDER BY margin_rmse`);
  return { predictions: signals.reduce((sum, signal) => sum + number(signal.predictions), 0),
    signals, authority: 'historical shadow only; zero active blend weight' };
}

/**
 * This endpoint is intentionally diagnostic rather than predictive. It never
 * converts model confidence into a profit claim and never grants stake authority.
 */
export function nflDiagnostic() {
  const profitability = profitabilityOperations();
  const betting = profitability.readiness?.blind_audit?.final?.betting ?? null;
  const edge = profitability.edge ?? {};
  const signals = newsSignalCoverage();
  const inventory = newsInventory();
  const sources = sourceHealth();
  const scheduler = schedulerStatus();
  const candidateAudit = latestCandidateInputAudit();
  const jobs = Object.fromEntries(scheduler.jobs.map(job => [job.job, {
    status: job.last_status, stale: job.stale, last_run_at: job.last_run_at
  }]));
  const historicalProfit = betting?.profit_units == null
    ? (betting?.units == null ? null : number(betting.units))
    : number(betting.profit_units);

  const bottlenecks = [
    {
      priority: 1, id: 'forward_evidence', severity: 'critical',
      finding: `${number(edge.settled_bets)} forward decisions are settled; ROI and CLV are not established.`,
      action: 'Capture decision-time and closing prices, settle outcomes, and keep staking at zero until the frozen forward gates pass.'
    },
    {
      priority: 2, id: 'news_coverage', severity: number(signals.recent_material_untyped) > 0 ? 'warning' : 'healthy',
      finding: `${number(signals.recent_material_untyped)} recent material stories remain untyped; ${number(signals.quarantined)} claims are quarantined.`,
      action: 'Run deterministic extraction first, use constrained AI only on unresolved known-player stories, and never let unverified prose alter a number.'
    },
    {
      priority: 3, id: 'source_health', severity: sources.erroring.length || sources.stale ? 'warning' : 'healthy',
      finding: `${sources.stale}/${sources.registered} sources are stale; ${sources.never_run} have no successful run recorded.`,
      action: 'Repair erroring feeds and backfill high-value gameplay, injury, depth, snap, and player-usage sources before adding model complexity.'
    },
    {
      priority: 4, id: 'model_promotion', severity: 'guardrail',
      finding: 'Online neural and advanced models remain challengers with zero staking authority.',
      action: 'Promote only after chronological ablation, calibration, positive CLV, and week-clustered forward intervals clear the configured gates.'
    }
  ];

  return {
    generated_at: new Date().toISOString(),
    verdict: profitability.state === 'review_eligible'
      ? 'Evidence gates passed for human review; profitability is still not guaranteed.'
      : 'No proven profitable forward edge. The system remains shadow-only.',
    profitability: {
      state: profitability.state,
      staking_authority: profitability.staking_authority,
      historical_blind_audit: betting ? {
        bets: number(betting.bets), wins: number(betting.wins), losses: number(betting.losses),
        profit_units: historicalProfit,
        roi: betting.roi == null ? null : number(betting.roi),
        evidence_class: 'historical diagnostic; not untouched forward proof'
      } : null,
      forward: {
        shadow_decisions: number(edge.shadow_decisions), settled_bets: number(edge.settled_bets),
        profit_units: edge.profit_units ?? null, roi: edge.roi ?? null,
        mean_clv: edge.mean_clv ?? null, target_settled: 200
      },
      gates: profitability.gates
    },
    news: {
      ...inventory,
      signals: {
        total: number(signals.signals), stories: number(signals.stories), players: number(signals.players),
        verified: number(signals.verified), quarantined: number(signals.quarantined),
        availability: number(signals.availability), role: number(signals.role),
        recent_material_untyped: number(signals.recent_material_untyped)
      },
      ingestion_jobs: { rss_news: jobs.rss_news ?? null, espn_news: jobs.espn_news ?? null,
        twitter_insiders: jobs.twitter_insiders ?? null, typed_signals: jobs.nfl_news_signals ?? null },
      safety_policy: 'Only timestamped, attributed, verified claims can become typed context. AI extraction is enum-constrained, evidence-spanned, and has zero direct numeric authority.'
    },
    data_sources: sources,
    model_growth: profitability.model_growth,
    challenger_backfill: challengerBackfill(),
    candidate_input_audit: candidateAudit,
    candidate_robustness: latestCandidateRobustnessReport(),
    data_consistency: nflDataConsistencyAudit(),
    signal_reliability: signalReliabilityStatus(),
    coordination: nflCoordinationAudit(),
    neural_replay: latestHistoricalNeuralReplay(),
    expert_council: expertCouncilStatus(),
    news_market_latency: nflNewsMarketLatency(),
    postgame_truth: postgameTruthStatus(),
    engine: profitability.gridiron_engine,
    bottlenecks,
    next_profit_review: {
      minimum_evidence: '200 settled independent forward decisions with preserved decision and close prices',
      pass_conditions: ['positive mean and median CLV', 'week-clustered confidence interval above zero',
        'acceptable calibration and identity/settlement coverage', 'no look-ahead or reconstructed quotes'],
      warning: 'A higher backtest hit rate alone is not evidence of future profit.'
    }
  };
}
