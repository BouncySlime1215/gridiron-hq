/** NFL market-residual research, ablations and promotion readiness. */
import { db, rows, run } from '../db/index.js';
import { accuracy, nestedEvaluationRows } from './nfl-market.js';
import { trainingIteration, latestTrainingAudit } from './nfl-replay.js';
import { latestCoverCalibration } from './nfl-cover-calibration.js';
import { pregameSnapshotCoverage } from './nfl-pregame.js';
import { closingLineValue } from './line-shopping.js';
import { allPickResults } from './nfl-auto-picks.js';
import { featureContracts, registry, recordGateAudit, gateAudits, evidenceManifests, updateRegistry } from './model-governance.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_feature_ablation_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
  seasons_json TEXT NOT NULL, policy_json TEXT NOT NULL, results_json TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS nfl_residual_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
  data_fingerprint TEXT NOT NULL, result_json TEXT NOT NULL
)`);

const FAMILIES = ['Rating systems', 'Efficiency', 'Context', 'Market'];
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
  const configs = [
    { id: 'all', families: null },
    ...FAMILIES.map(f => ({ id: `only:${f}`, families: [f] })),
    ...FAMILIES.map(f => ({ id: `without:${f}`, families: FAMILIES.filter(x => x !== f) }))
  ];
  const results = configs.map(c => {
    const result = trainingIteration(seasons, { modelOptions: { weighting: 'exponential', families: c.families } });
    return { ...c, overall: result.overall, per_season: result.per_season };
  });
  const policy = { kind: 'diagnostic_only', note: 'Ablations explain contribution; this opened period cannot promote a tuned family set.' };
  run(`INSERT INTO nfl_feature_ablation_audits (created_at,seasons_json,policy_json,results_json)
       VALUES (datetime('now'),?,?,?)`, JSON.stringify(seasons), JSON.stringify(policy), JSON.stringify(results));
  return latestNflFeatureAblations();
}

export function latestNflFeatureAblations() {
  const x = rows('SELECT * FROM nfl_feature_ablation_audits ORDER BY id DESC LIMIT 1')[0];
  return x && { id: x.id, created_at: x.created_at, seasons: JSON.parse(x.seasons_json),
    policy: JSON.parse(x.policy_json), results: JSON.parse(x.results_json) };
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
  const gates = [
    { id: 'market_residual_margin', label: 'Adds unseen value beyond market margin', passed: residual?.summary?.residual_margin_mae < residual?.summary?.market_margin_mae,
      actual: residual?.summary?.residual_margin_mae, target: `< ${residual?.summary?.market_margin_mae ?? 'market'}` },
    { id: 'cover_calibration', label: 'Calibrated cover probability beats market', passed: calibration?.metrics?.forward_gate_passed === true,
      actual: calibration?.metrics?.walk_forward_calibrated_brier ?? null, target: `< ${calibration?.metrics?.walk_forward_market_brier ?? 'market Brier'}` },
    { id: 'exact_policy', label: 'Frozen exact policy has credible positive ROI', passed: !!overall && overall.roi > 0 && (overall.uncertainty?.probability_roi_above_zero ?? 0) >= 0.75,
      actual: overall?.roi ?? null, target: 'ROI > 0 and P(ROI>0) ≥ 75%' },
    { id: 'forward_sample', label: 'Forward evidence sample', passed: forwardSettled.length >= 250, actual: forwardSettled.length, target: '≥ 250 settled decisions' },
    { id: 'clv', label: 'Closing-line value available and positive', passed: clv.available === true && (clv.average_clv ?? null) > 0,
      actual: clv.available ? clv.average_clv ?? 'capturing; not scored' : 'unavailable', target: '> 0 average CLV' },
    { id: 'pregame_coverage', label: 'Current team snapshot coverage', passed: (pregame[0]?.teams ?? 0) >= 32,
      actual: pregame[0]?.teams ?? 0, target: '32 teams' }
  ];
  const evidence = { accuracy: acc, residual, calibration, exact_policy: overall,
    error_analysis: replay?.result?.analysis ?? null, pregame: pregame[0] ?? null,
    clv, ensemble: { source: 'Model room', note: 'Component fitting is intentionally excluded from the operations request; the immutable replay and residual audits are the promotion evidence.' },
    forward_settled: forwardSettled.length };
  const audit = persist ? recordGateAudit({ sport: 'NFL', market: 'spread', modelVersion: 'nfl-ensemble-v1', gates, evidence }) : null;
  if (persist) updateRegistry({ sport: 'NFL', market: 'spread', role: 'challenger', modelVersion: 'nfl-ensemble-v1',
    state: gates.every(x => x.passed) ? 'promotion_eligible' : 'blocked',
    reason: `${gates.filter(x => !x.passed).length}/${gates.length} promotion gates remain blocked at audit #${audit.id}.`, metrics: evidence });
  return {
    sport: 'NFL', generated_at: new Date().toISOString(), verdict: gates.every(x => x.passed) ? 'promotion_eligible' : 'blocked',
    gates, evidence, registry: registry('NFL'), contracts: featureContracts('NFL'),
    latest_ablation: latestNflFeatureAblations(), gate_history: gateAudits('NFL', 10), manifests: evidenceManifests('NFL', 10), persisted_audit: audit
  };
}
