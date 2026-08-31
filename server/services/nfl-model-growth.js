/**
 * Current-season model growth, end to end.
 *
 * A model does not learn because more code exists. It learns when a newly final
 * game becomes: (1) a result, (2) cutoff-safe team/player features, (3) a label
 * attached to the prediction frozen before kickoff, and (4) a new fit whose
 * training cutoff is recorded. This service owns that whole transition.
 *
 * It is deliberately publication-driven rather than clock-driven. The
 * scheduler may check every few hours, but the expensive nflverse downloads and
 * fit happen only when `game_lines` contains a newly finalized week that the
 * feature warehouse has not absorbed yet. No result means no fake retrain.
 */
import crypto from 'node:crypto';
import { db, row, rows, run } from '../db/index.js';
import { syncAll as syncNflverse } from './nflverse.js';
import { syncPbpSeason } from './nfl-pbp.js';
import { syncNgs, syncPfrAdv, syncSnaps, syncDepthCharts, syncInjuries } from './nfl-advanced.js';
import { settleNflShadowDecisions, shadowLedgerSummary } from './shadow-ledger.js';
import { settleForwardPicks } from './forward-ledger.js';
import { clearAutoPickBoardCache } from './nfl-auto-picks.js';
import { clearNflMarketCache } from './nfl-market.js';
import { fitEnsemble, invalidateEnsembleCaches } from './nfl-ensemble.js';
import { clearPlayerWeekEngineCache } from './player-week-engine.js';
import { clearPlayerValueCache } from './nfl-player-value.js';
import { settleOnlineNeuralExamples, trainOnlineNeuralThroughSettled } from './nfl-online-neural.js';
import { settleRiskLabPredictions, trainRiskLabThroughSettled } from './nfl-risk-lab.js';
import { captureWeeklyPredictions, retrainWeeklyWeights, settleWeeklyPredictions } from './weekly-learning.js';
import { clearNflEngineRegistryCache, recordNflEngineArtifact } from './nfl-engine-registry.js';
import { buildSignalReliabilityArtifact, signalReliabilityStatus } from './nfl-signal-reliability.js';
import { captureForwardExpertWeek, settleForwardExpertPredictions, expertCouncilStatus } from './nfl-expert-council.js';
import { recordPostgameTruthWeek, postgameTruthStatus } from './nfl-postgame-truth.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_model_growth_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  season INTEGER NOT NULL,
  finalized_week INTEGER,
  status TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  after_hash TEXT,
  detail_json TEXT
)`);

const scalar = (sql, ...args) => Number(row(sql, ...args)?.value ?? 0);
const through = (table, season) => scalar(
  `SELECT COALESCE(MAX(week),0) value FROM ${table} WHERE season=?`, season);
const count = (table, season) => scalar(`SELECT COUNT(*) value FROM ${table} WHERE season=?`, season);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => { try { return value ? JSON.parse(value) : null; } catch { return null; } };

function availableSeason() {
  const configured = Number(process.env.NFL_SEASON);
  if (Number.isInteger(configured)) return configured;
  return Number(row('SELECT MAX(season) season FROM game_lines')?.season) || new Date().getFullYear();
}

function warehouseSnapshot(season) {
  const finalizedWeek = scalar(`SELECT COALESCE(MAX(week),0) value FROM game_lines
    WHERE season=? AND home=1 AND team_score IS NOT NULL AND opp_score IS NOT NULL`, season);
  const sources = [
    { id: 'results_and_lines', table: 'game_lines', required: true,
      rows: count('game_lines', season), through_week: finalizedWeek },
    { id: 'team_play_by_play_features', table: 'nfl_team_week_features', required: true,
      rows: count('nfl_team_week_features', season), through_week: through('nfl_team_week_features', season) },
    { id: 'player_play_by_play_features', table: 'nfl_player_week_features', required: true,
      rows: count('nfl_player_week_features', season), through_week: through('nfl_player_week_features', season) },
    { id: 'weekly_player_usage', table: 'player_week_usage', required: true,
      rows: count('player_week_usage', season), through_week: through('player_week_usage', season) },
    { id: 'snap_counts', table: 'nfl_snaps', required: false,
      rows: count('nfl_snaps', season), through_week: through('nfl_snaps', season) },
    { id: 'next_gen_tracking', table: 'nfl_ngs', required: false,
      rows: count('nfl_ngs', season), through_week: through('nfl_ngs', season) },
    { id: 'pfr_player_charting', table: 'nfl_pfr_adv', required: false,
      rows: count('nfl_pfr_adv', season), through_week: through('nfl_pfr_adv', season) },
    { id: 'depth_charts', table: 'nfl_depth', required: false,
      rows: count('nfl_depth', season), through_week: through('nfl_depth', season) },
    { id: 'injury_reports', table: 'nfl_injuries', required: false,
      rows: count('nfl_injuries', season), through_week: through('nfl_injuries', season) }
  ].map(source => ({ ...source,
    prior_season_rows: count(source.table, season - 1),
    prior_season_through_week: through(source.table, season - 1),
    lag_weeks: Math.max(0, finalizedWeek - source.through_week),
    current: finalizedWeek === 0 || source.through_week >= finalizedWeek
  }));
  const core = sources.filter(source => source.required && source.id !== 'results_and_lines');
  const learnedThrough = core.length ? Math.min(...core.map(source => source.through_week)) : 0;
  return { season, finalized_week: finalizedWeek, learned_through_week: learnedThrough, sources };
}

function latestRun() {
  const record = row('SELECT * FROM nfl_model_growth_runs ORDER BY id DESC LIMIT 1');
  return record ? { ...record, detail: parse(record.detail_json), detail_json: undefined } : null;
}

/** Read-only answer to “is the model actually receiving and labeling new data?” */
export function nflModelGrowthStatus(season = availableSeason()) {
  const warehouse = warehouseSnapshot(season);
  const ledger = shadowLedgerSummary('NFL');
  const lagging = warehouse.sources.filter(source => !source.current);
  const fitted = row(`SELECT cutoff,model_version,created_at,data_fingerprint
    FROM nfl_ensemble_fit_artifacts WHERE cutoff=? ORDER BY created_at DESC LIMIT 1`,
  `${season}|${Math.max(1, warehouse.finalized_week + 1)}`) ?? null;
  const state = warehouse.finalized_week === 0 ? 'waiting_for_regular_season_results'
    : lagging.some(source => source.required) ? 'ingest_due'
      : fitted ? 'current' : 'refit_due';
  return {
    state, ...warehouse,
    labeled_examples: {
      independent: ledger.independent_examples,
      settled: ledger.settled,
      selected: ledger.selected,
      selected_settled: ledger.selected_settled,
      rule: 'One frozen row per game, market and model version; evidence horizons are not independent bets.'
    },
    active_fit: fitted,
    latest_run: latestRun(),
    next_action: state === 'waiting_for_regular_season_results'
      ? 'The first cycle will run after Week 1 games become final and nflverse publishes the week.'
      : state === 'ingest_due' ? `Ingest finalized Week ${warehouse.finalized_week}, then build the Week ${warehouse.finalized_week + 1} cutoff fit.`
        : state === 'refit_due' ? `Build and record the Week ${warehouse.finalized_week + 1} cutoff fit.`
          : `Current through finalized Week ${warehouse.finalized_week}; the next outcome remains unseen.`,
    promotion_policy: 'New weeks update weights and evaluation rows. They never auto-promote a betting model; promotion still requires the frozen forward gates.',
    signal_reliability: signalReliabilityStatus()
  };
}

async function attempt(name, fn, detail) {
  try { detail[name] = await fn(); }
  catch (error) { detail[name] = { error: error.message }; }
  return detail[name];
}

/**
 * Settle labels on every check; download/refit only after a new finalized week.
 * Individual feeds fail independently so one late nflverse release does not
 * discard everything another source successfully published.
 */
export async function runNflModelGrowthCycle({ season = availableSeason(), force = false } = {}) {
  const startedAt = new Date().toISOString();
  const before = warehouseSnapshot(season);
  const beforeHash = hash(before);
  const inserted = run(`INSERT INTO nfl_model_growth_runs
    (started_at,season,finalized_week,status,before_hash,detail_json)
    VALUES (?,?,?,?,?,'{}')`, startedAt, season, before.finalized_week, 'running', beforeHash);
  const detail = {
    settlement: {
      shadow: settleNflShadowDecisions(),
      forward: settleForwardPicks(),
      online_neural: settleOnlineNeuralExamples(),
      risk_lab: settleRiskLabPredictions(),
      expert_council: settleForwardExpertPredictions()
    },
    ingestion: {}, fit: null, signal_reliability: null, online_neural: null,
    risk_lab: null, player_learning: null, expert_council: null, postgame_truth: null, engine: null
  };
  try {
    const coreLag = before.sources.some(source => source.required && !source.current);
    const needsFit = before.finalized_week > 0 && !row(
      'SELECT 1 ok FROM nfl_ensemble_fit_artifacts WHERE cutoff=? LIMIT 1',
      `${season}|${before.finalized_week + 1}`);

    if (before.finalized_week > 0 && (force || coreLag)) {
      await attempt('weekly_usage_and_base_snaps', () => syncNflverse([season]), detail.ingestion);
      await attempt('play_by_play', () => syncPbpSeason(season), detail.ingestion);
      await attempt('next_gen_stats', () => syncNgs([season]), detail.ingestion);
      await attempt('pfr_advanced', () => syncPfrAdv([season]), detail.ingestion);
      // The prior season supplies the Week 1 replacement baseline. Re-reading
      // it also backfills defensive participation into databases created before
      // that field was stored.
      await attempt('snap_counts', () => syncSnaps([season - 1, season]), detail.ingestion);
      await attempt('depth_charts', () => syncDepthCharts([season]), detail.ingestion);
      await attempt('injury_reports', () => syncInjuries([season]), detail.ingestion);
    }

    const afterIngest = warehouseSnapshot(season);
    if (afterIngest.finalized_week > 0) {
      detail.postgame_truth = {
        week: recordPostgameTruthWeek(season, afterIngest.finalized_week),
        status: postgameTruthStatus()
      };
    }
    if (afterIngest.finalized_week > 0) {
      detail.signal_reliability = buildSignalReliabilityArtifact(season, afterIngest.finalized_week);
    }
    clearNflEngineRegistryCache();
    const coreCurrent = afterIngest.sources
      .filter(source => source.required && source.id !== 'results_and_lines')
      .every(source => source.current);
    if (afterIngest.finalized_week > 0 && coreCurrent && (force || needsFit || coreLag)) {
      invalidateEnsembleCaches();
      clearNflMarketCache();
      clearAutoPickBoardCache();
      clearPlayerWeekEngineCache();
      clearPlayerValueCache();
      const fitted = fitEnsemble({ beforeSeason: season, beforeWeek: afterIngest.finalized_week + 1 });
      detail.fit = fitted.error ? { error: fitted.error } : {
        cutoff: `${season}|${afterIngest.finalized_week + 1}`,
        games: fitted.games, evaluated_weeks: fitted.evaluated_weeks,
        models: fitted.models.length,
        residual_models_passing: fitted.models.filter(model => model.residual_gate_passed).map(model => model.id)
      };
    }

    // The neural challenger learns only after every game in a week was scored
    // under the old artifact and the same week's feature warehouse is current.
    // This remains outside the refit branch so a transient neural failure can
    // retry after the ensemble artifact has already been persisted.
    if (afterIngest.finalized_week > 0 && coreCurrent) {
      detail.online_neural = trainOnlineNeuralThroughSettled();
      detail.risk_lab = trainRiskLabThroughSettled();
      const playerSettlement = settleWeeklyPredictions();
      const playerTraining = retrainWeeklyWeights();
      clearPlayerWeekEngineCache();
      const nextWeek = afterIngest.finalized_week + 1;
      const playerCapture = nextWeek <= 18
        ? captureWeeklyPredictions(season, nextWeek) : { captured: 0, blocked: true, reason: 'regular season complete' };
      detail.player_learning = {
        settlement: playerSettlement, training: playerTraining, next_week_capture: playerCapture,
        downstream: 'The shared player engine feeds fantasy projections and every player-prop market.'
      };
      detail.expert_council = {
        settlement: detail.settlement.expert_council,
        next_week_capture: nextWeek <= 18
          ? captureForwardExpertWeek(season, nextWeek, { horizon: 'weekly_growth' })
          : { captured: 0, blocked: true, reason: 'regular season complete' },
        status: expertCouncilStatus(),
        downstream: 'Each raw role and abstention is frozen before kickoff; only settled earlier weeks may train the robust coordinator.'
      };
      const coordinatedFitExists = row(`SELECT 1 ok FROM nfl_ensemble_fit_artifacts
        WHERE cutoff=? LIMIT 1`, `${season}|${afterIngest.finalized_week + 1}`);
      if (coordinatedFitExists && !detail.fit?.error) {
        detail.engine = recordNflEngineArtifact(season, afterIngest.finalized_week);
      }
    }

    const after = warehouseSnapshot(season);
    const requiredLag = after.sources.filter(source => source.required && !source.current);
    const status = after.finalized_week === 0 ? 'waiting'
      : requiredLag.length ? 'source_lag'
        : detail.fit?.error ? 'fit_error' : 'ok';
    const finishedAt = new Date().toISOString();
    const result = { status, started_at: startedAt, finished_at: finishedAt,
      before, after, ...detail,
      note: status === 'waiting'
        ? 'No regular-season game is final yet. The cycle settled anything due, skipped every download, and will check again automatically.'
        : status === 'source_lag'
          ? 'A finalized week exists but at least one required nflverse release is not published yet; the scheduler will retry without fabricating rows.'
          : status === 'fit_error'
            ? 'The current week was ingested but the cutoff fit failed; the failed run is retained and will be retried.'
            : 'Outcomes became immutable labels, current-season features were ingested, and the next-week fit was recorded without auto-promotion.' };
    run(`UPDATE nfl_model_growth_runs SET finished_at=?,status=?,after_hash=?,detail_json=? WHERE id=?`,
    finishedAt, status, hash(after), JSON.stringify(result), inserted.lastInsertRowid);
    return result;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    run(`UPDATE nfl_model_growth_runs SET finished_at=?,status='error',detail_json=? WHERE id=?`,
    finishedAt, JSON.stringify({ ...detail, error: error.message }), inserted.lastInsertRowid);
    throw error;
  }
}
