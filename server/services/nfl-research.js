/** NFL market-residual research, ablations and promotion readiness. */
import { rows, run } from '../db/index.js';
import { accuracy, nestedEvaluationRows } from './nfl-market.js';
import { FORWARD_SAMPLE_TARGETS } from './nfl-policy.js';
import { trainingIteration, latestTrainingAudit } from './nfl-replay.js';
import { latestCoverCalibration } from './nfl-cover-calibration.js';
import { pregameSnapshotCoverage } from './nfl-pregame.js';
import { closingLineValue } from './line-shopping.js';
import { allPickResults } from './nfl-auto-picks.js';
import { featureContracts, registry, recordGateAudit, gateAudits, evidenceManifests, updateRegistry } from './model-governance.js';
import { featureContracts as ensembleFeatureContracts } from './nfl-ensemble.js';
import { nflIntelligence } from './model-intelligence.js';
import { nflEvidenceCoverage } from './nfl-evidence.js';
import { declareTrial, scoreTrial, scoredTrialSequence } from './research-trials.js';
import { effectiveTrialCount, deflatedSharpeRatio, reconstructBetReturns, sharpeStatsFromReturns } from './trial-statistics.js';

/**
 * The ensemble's REAL family list, read from the model catalog rather than
 * restated here (Codex audit finding, main plan section 8.6).
 *
 * This was a hardcoded four-element array: 'Rating systems', 'Efficiency',
 * 'Context', 'Market'. The ensemble actually has FIVE families — the missing
 * one being 'Roster availability', which is precisely the
 * "availability/roster" group section 8.6 asks to test. Because `families`
 * acts as a WHITELIST in `ensembleLine`, every `without:X` configuration was
 * silently dropping roster availability TOO, so every ablation delta ever
 * produced by this harness measured the removal of two families while
 * reporting one. Deriving the list from `nflFeatureFamilies()` means a family
 * added to the ensemble can never again be silently omitted from its own
 * ablation.
 */
function ablationFamilies() {
  return [...new Set(ensembleFeatureContracts().map(m => m.family))].filter(Boolean).sort();
}
const r3 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(3);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const mae = (a, key) => r3(mean(a.map(x => Math.abs(x.actual - x[key]))));

function fitResidualWeight(train, modelKey, marketKey, actualKey) {
  const usable = train.filter(x => x[modelKey] != null && x[marketKey] != null);
  // Locked ridge anchor: a model has to earn movement away from the market.
  const lambda = 100;
  let xy = 0, xx = lambda;
  for (const x of usable) {
    const signal = x[modelKey] - x[marketKey];
    xy += signal * (x[actualKey] - x[marketKey]);
    xx += signal * signal;
  }
  return Math.max(-1, Math.min(1, xy / xx));
}

/**
 * Tests the only production-relevant question: does the model add unseen
 * information after the sportsbook line? Residual weights for each season are
 * fitted only on earlier outer-fold predictions.
 */
export function nflResidualAudit() {
  const nested = nestedEvaluationRows();
  if (nested.error) return nested;
  const raw = nested.rows.map(x => ({
    season: x.g.season, actual_margin: x.actualMargin, actual_total: x.actualTotal,
    model_margin: x.predMargin, model_total: x.predTotal,
    market_margin: x.g.home_spread == null ? null : -x.g.home_spread,
    market_total: x.g.total
  }));
  const seasons = [...new Set(raw.map(x => x.season))].sort((a, b) => a - b);
  const scored = [], perSeason = [];
  for (const season of seasons.slice(1)) {
    const train = raw.filter(x => x.season < season);
    const test = raw.filter(x => x.season === season && x.market_margin != null && x.market_total != null);
    if (!train.length || !test.length) continue;
    const marginWeight = fitResidualWeight(train, 'model_margin', 'market_margin', 'actual_margin');
    const totalWeight = fitResidualWeight(train, 'model_total', 'market_total', 'actual_total');
    const fold = test.map(x => ({
      season, actual: x.actual_margin, market: x.market_margin,
      model: x.model_margin, residual: x.market_margin + marginWeight * (x.model_margin - x.market_margin),
      actual_total: x.actual_total, market_total: x.market_total, model_total: x.model_total,
      residual_total: x.market_total + totalWeight * (x.model_total - x.market_total)
    }));
    scored.push(...fold);
    perSeason.push({ season, n: fold.length, margin_weight: r3(marginWeight), total_weight: r3(totalWeight),
      market_margin_mae: mae(fold, 'market'), residual_margin_mae: mae(fold, 'residual'),
      market_total_mae: r3(mean(fold.map(x => Math.abs(x.actual_total - x.market_total)))),
      residual_total_mae: r3(mean(fold.map(x => Math.abs(x.actual_total - x.residual_total)))) });
  }
  const summary = {
    n: scored.length,
    market_margin_mae: mae(scored, 'market'), residual_margin_mae: mae(scored, 'residual'),
    raw_model_margin_mae: mae(scored, 'model'),
    market_total_mae: r3(mean(scored.map(x => Math.abs(x.actual_total - x.market_total)))),
    residual_total_mae: r3(mean(scored.map(x => Math.abs(x.actual_total - x.residual_total)))),
    raw_model_total_mae: r3(mean(scored.map(x => Math.abs(x.actual_total - x.model_total))))
  };
  return {
    method: 'nested market-residual ridge; each residual weight fitted only on earlier outer-fold seasons',
    training_anchor: 'market', ridge_lambda: 100, evaluation_seasons: seasons.slice(1), summary, per_season: perSeason,
    verdict: summary.residual_margin_mae < summary.market_margin_mae
      ? 'The football model adds unseen margin information after shrinkage.'
      : 'The football model has not added unseen margin information beyond the market.'
  };
}

function dataFingerprint() {
  const x = rows(`SELECT COUNT(*) rows,MAX(season) max_season,MAX(week) max_week,
    SUM(CASE WHEN team_score IS NOT NULL THEN 1 ELSE 0 END) completed FROM game_lines`)[0];
  return JSON.stringify(x);
}

export function latestNflResidualAudit() {
  const x = rows('SELECT * FROM nfl_residual_audits WHERE data_fingerprint=? ORDER BY id DESC LIMIT 1', dataFingerprint())[0];
  return x ? JSON.parse(x.result_json) : null;
}

export function refreshNflResidualAudit() {
  const result = { ...nflResidualAudit(), accuracy: accuracy() };
  run(`INSERT INTO nfl_residual_audits (created_at,data_fingerprint,result_json)
       VALUES (datetime('now'),?,?)`, dataFingerprint(), JSON.stringify(result));
  return result;
}

export function runNflFeatureAblations(seasons = [2021, 2022, 2023, 2024, 2025]) {
  const families = ablationFamilies();
  // How many models each family actually contributes. A family with none is
  // reported as having NO NUMERICAL CONSUMER rather than being run and
  // reported as a zero-effect scientific result -- section 8.6 asks for that
  // distinction explicitly.
  const modelsByFamily = ensembleFeatureContracts().reduce((acc, m) => {
    acc[m.family] = (acc[m.family] ?? 0) + 1; return acc;
  }, {});
  const configs = [
    { id: 'all', families: null },
    ...families.map(f => ({ id: `only:${f}`, families: [f] })),
    ...families.map(f => ({ id: `without:${f}`, families: families.filter(x => x !== f) }))
  ];
  const results = configs.map(c => {
    const result = trainingIteration(seasons, { modelOptions: { weighting: 'exponential', families: c.families } });
    return { ...c, overall: result.overall, per_season: result.per_season };
  });
  const policy = { kind: 'diagnostic_only',
    families_tested: families, models_per_family: modelsByFamily,
    ablation_kind: 'refit_leave_one_family_out',
    ablation_note: 'Each configuration REFITS the ensemble over the remaining families rather than zeroing a ' +
      'trained input, so this is a true leave-one-family-out ablation and not a sensitivity test that pushes ' +
      'the model outside its training distribution (main plan section 8.6).',
    note: 'Ablations explain contribution; this opened period cannot promote a tuned family set.' };
  run(`INSERT INTO nfl_feature_ablation_audits (created_at,seasons_json,policy_json,results_json)
       VALUES (datetime('now'),?,?,?)`, JSON.stringify(seasons), JSON.stringify(policy), JSON.stringify(results));
  return latestNflFeatureAblations();
}

export function latestNflFeatureAblations() {
  const x = rows('SELECT * FROM nfl_feature_ablation_audits ORDER BY id DESC LIMIT 1')[0];
  return x && { id: x.id, created_at: x.created_at, seasons: JSON.parse(x.seasons_json),
    policy: JSON.parse(x.policy_json), results: JSON.parse(x.results_json) };
}

const OVERFITTING_TRIAL_KIND = 'nfl_operations_sharpe';
// Geyer's own minimum for a real autocorrelation-time estimate
// (trial-statistics.js's geyerIntegratedAutocorrelationTime: below this it
// returns tau=1, i.e. explicitly "no correction applied rather than an
// unstable one"). Below that floor, correcting for repeated looks is not
// meaningfully possible yet, so this gate fails closed rather than passing
// on a correction it cannot actually compute.
const MIN_LIVE_TRIALS_FOR_DSR = 8;
const DSR_PASS_THRESHOLD = 0.95;

/**
 * The overfitting/safeguard audit the research corpus flagged as missing: a
 * naive win/ROI number does not say whether it is real skill or just the
 * best-looking result of repeatedly re-evaluating the same frozen policy as
 * more data lands. This registers each `persist:true` run's exact-policy
 * result as one more REAL, live, chronologically-timestamped trial (never
 * backfilled -- "now" really is when this evidence was observed, which is
 * exactly what a live call is, not the silent defaulting research-trials.js
 * warns against for a *backfill*), keyed on the result's own content so
 * re-running against unchanged data does not inflate the trial count. Once
 * enough real live trials exist, asks whether the best Sharpe ratio seen
 * across them survives Bailey & López de Prado's deflation for how many
 * effectively-independent looks (Geyer's autocorrelation-time correction)
 * that history represents.
 *
 * This is deliberately scoped to this project's OWN live re-evaluation
 * history, not the hand-backfilled `candidate_input_audit` trial kinds
 * `scripts/run-purged-evaluation.mjs` reports on -- those were reconstructed
 * from committed/documented history with real but transcribed numbers, a
 * one-time demonstration explicitly documented as not a repeatable, high-
 * power estimate. A live promotion gate needs a live, ongoing, automatically
 * -growing sequence, not a hand-transcribed snapshot re-read forever.
 */
function overfittingGate(overall, persist) {
  if (persist && overall && Number(overall.bets) > 0) {
    const key = JSON.stringify({ bets: overall.bets, wins: overall.wins, losses: overall.losses, units: overall.units });
    const rec = reconstructBetReturns(overall);
    const stats = rec ? sharpeStatsFromReturns(rec.returns) : null;
    if (stats && Number.isFinite(stats.sharpe)) {
      const now = new Date().toISOString();
      const detail = { n: stats.n, skewness: stats.skewness, kurtosis: stats.kurtosis, source: 'nflOperations exact_policy overall' };
      declareTrial({ kind: OVERFITTING_TRIAL_KIND, key, declaredAt: now, metric: 'sharpe', value: stats.sharpe, status: 'scored', detail });
      scoreTrial(OVERFITTING_TRIAL_KIND, key, { scoredAt: now, metric: 'sharpe', value: stats.sharpe, detail });
    }
  }

  const sequence = scoredTrialSequence({ kind: OVERFITTING_TRIAL_KIND, normalize: t => t.value });
  const label = 'Best observed edge survives correction for repeated live looks at the same evidence';
  if (sequence.length < MIN_LIVE_TRIALS_FOR_DSR) {
    return { id: 'overfitting_correction', label, passed: false,
      actual: `${sequence.length} live trial(s) registered`,
      target: `≥ ${MIN_LIVE_TRIALS_FOR_DSR} live trials before a deflated-Sharpe correction can be computed at all` };
  }

  const sharpeValues = sequence.map(t => t.z);
  const mean = sharpeValues.reduce((s, v) => s + v, 0) / sharpeValues.length;
  const std = Math.sqrt(sharpeValues.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, sharpeValues.length - 1));
  const bestIndex = sharpeValues.reduce((best, v, i) => (v > sharpeValues[best] ? i : best), 0);
  const best = sequence[bestIndex];
  const effN = effectiveTrialCount(sharpeValues);
  const dsr = deflatedSharpeRatio({ sharpe: best.z, n: best.detail?.n ?? null, skewness: best.detail?.skewness ?? 0,
    kurtosis: best.detail?.kurtosis ?? 3, nTrialsEffective: effN.n_effective, sharpeStdAcrossTrials: std });
  return { id: 'overfitting_correction', label,
    passed: dsr.dsr != null && dsr.dsr >= DSR_PASS_THRESHOLD,
    actual: dsr.dsr != null
      ? `DSR=${dsr.dsr.toFixed(4)} over ${effN.n_effective.toFixed(2)} effective trials (${sequence.length} raw, tau=${effN.tau_integrated_autocorrelation_time.toFixed(2)})`
      : 'unavailable',
    target: `DSR ≥ ${DSR_PASS_THRESHOLD}` };
}

export function nflOperations({ persist = false, refreshResidual = false } = {}) {
  const residual = refreshResidual ? refreshNflResidualAudit() : latestNflResidualAudit() ?? refreshNflResidualAudit();
  const acc = residual.accuracy ?? accuracy();
  const calibration = latestCoverCalibration(2027);
  const replay = latestTrainingAudit();
  const pregame = pregameSnapshotCoverage();
  const clv = closingLineValue();
  const picks = allPickResults();
  const forwardSettled = picks.filter(x => ['Won', 'Lost'].includes(x.status) && x.quote_at && x.selected_at);
  const overall = replay?.result?.overall ?? null;
  const dataEvidence = nflEvidenceCoverage();
  const historicalSeasons = dataEvidence.seasons.filter(x => x.season <= 2025);
  const preservedHistoricalQuotes = historicalSeasons.reduce((n, x) => n + x.preserved_line_events, 0);
  const gates = [
    { id: 'market_residual_margin', label: 'Adds unseen value beyond market margin', passed: residual?.summary?.residual_margin_mae < residual?.summary?.market_margin_mae,
      actual: residual?.summary?.residual_margin_mae, target: `< ${residual?.summary?.market_margin_mae ?? 'market'}` },
    { id: 'cover_calibration', label: 'Calibrated cover probability beats market', passed: calibration?.metrics?.forward_gate_passed === true,
      actual: calibration?.metrics?.walk_forward_calibrated_brier ?? null, target: `< ${calibration?.metrics?.walk_forward_market_brier ?? 'market Brier'}` },
    { id: 'exact_policy', label: 'Frozen exact policy has credible positive ROI', passed: !!overall && overall.roi > 0 && (overall.uncertainty?.probability_roi_above_zero ?? 0) >= 0.75,
      actual: overall?.roi ?? null, target: 'ROI > 0 and P(ROI>0) ≥ 75%' },
    { id: 'forward_sample', label: 'Forward evidence sample', passed: forwardSettled.length >= FORWARD_SAMPLE_TARGETS.overall, actual: forwardSettled.length, target: `≥ ${FORWARD_SAMPLE_TARGETS.overall} settled decisions` },
    { id: 'quote_provenance', label: 'Decision-time quote provenance is preserved', passed: preservedHistoricalQuotes >= 1000,
      actual: preservedHistoricalQuotes, target: '≥ 1,000 historical events with immutable quote snapshots' },
    { id: 'untouched_holdout', label: 'Untouched forward holdout is mature', passed: dataEvidence.firewall.untouched_gate_passed,
      actual: dataEvidence.firewall.forward.settled, target: `≥ ${dataEvidence.firewall.forward.target} settled frozen decisions` },
    { id: 'clv', label: 'Closing-line value available and positive', passed: clv.available === true && (clv.average_clv ?? null) > 0,
      actual: clv.available ? clv.average_clv ?? 'capturing; not scored' : 'unavailable', target: '> 0 average CLV' },
    { id: 'pregame_coverage', label: 'Current team snapshot coverage', passed: (pregame[0]?.teams ?? 0) >= 32,
      actual: pregame[0]?.teams ?? 0, target: '32 teams' },
    overfittingGate(overall, persist)
  ];
  const evidence = { accuracy: acc, residual, calibration, exact_policy: overall,
    error_analysis: replay?.result?.analysis ?? null, pregame: pregame[0] ?? null,
    clv, ensemble: { source: 'Model room', note: 'Component fitting is intentionally excluded from the operations request; the immutable replay and residual audits are the promotion evidence.' },
    forward_settled: forwardSettled.length, data_provenance: dataEvidence };
  const audit = persist ? recordGateAudit({ sport: 'NFL', market: 'spread', modelVersion: 'nfl-ensemble-v1', gates, evidence }) : null;
  if (persist) updateRegistry({ sport: 'NFL', market: 'spread', role: 'challenger', modelVersion: 'nfl-ensemble-v1',
    state: gates.every(x => x.passed) ? 'promotion_eligible' : 'blocked',
    reason: `${gates.filter(x => !x.passed).length}/${gates.length} promotion gates remain blocked at audit #${audit.id}.`, metrics: evidence });
  return {
    sport: 'NFL', generated_at: new Date().toISOString(), verdict: gates.every(x => x.passed) ? 'promotion_eligible' : 'blocked',
    gates, evidence, registry: registry('NFL'), contracts: featureContracts('NFL'),
    latest_ablation: latestNflFeatureAblations(), gate_history: gateAudits('NFL', 10), manifests: evidenceManifests('NFL', 10),
    intelligence: nflIntelligence(), persisted_audit: audit
  };
}
