#!/usr/bin/env node
/**
 * Resumable 2022-2025 evidence rebuild and correctly named chronological audit.
 *
 * 2021 is intentionally excluded from model evaluation. Its source coverage is
 * measured elsewhere and remains available for repair, never silently zero-filled.
 */
import { db, rows, run } from '../server/db/index.js';
import { syncNgs, syncPfrAdv, syncSnaps, syncDepthCharts, syncInjuries,
  reconcileHistoricalTeamCodes } from '../server/services/nfl-advanced.js';
import { syncVerifiedEventArchive } from '../server/services/nfl-event-archive.js';
import { ingestCharting, ingestFormations } from '../server/services/nfl-formations.js';
import { backfillTeamFeatureVectors, backfillPlayerFeatureVectors,
  weeklyFeatureStoreStatus } from '../server/services/nfl-weekly-feature-store.js';
import { backfillTeamCards, teamCardCoverage } from '../server/services/nfl-team-card.js';
import { simulationCalibrationFor } from '../server/services/nfl-sim-calibration.js';
import { fitOrthogonalSpecialists } from '../server/services/nfl-orthogonal-specialists.js';
import { nflFeatureCoverage, freezeFeatureCoverageSnapshot } from '../server/services/nfl-feature-coverage.js';
import { preregisterBlindAudit, runNextBlindAuditWeek,
  blindAuditStatus, failBlindAudit } from '../server/services/nfl-blind-audit.js';
import { backfillPossessionLedger, liveLedgerStatus } from '../server/services/nfl-live-ledger.js';

const SEASONS = [2022, 2023, 2024, 2025];
const START_WEEK = 5, END_WEEK = 18;
// A rebuild contract gets a new key whenever persisted outputs or audit
// provenance change. Reusing v1 after its audit memory was reset would make the
// runner skip completed checkpoints and then point at a deleted audit id.
const RUN_KEY = 'nfl-2022-2025-shared-state-v2-decision-provenance';
const AUDIT_LABEL = 'NFL 2022-2025 cutoff-safe reconstruction audit · scoped NFL identity v4';
const AUDIT_PHASE = 'audit_preregistration_v4';
const CHRONOLOGICAL_PHASE = 'chronological_audit_v4';
const LEDGER_TRIALS = Math.max(80, Number(process.env.NFL_LEDGER_TRIALS) || 120);
const LEDGER_GAMES = Math.max(1, Number(process.env.NFL_LEDGER_GAMES) || 10000);
const log = (phase, value) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), phase, value })}\n`);

db.exec(`CREATE TABLE IF NOT EXISTS nfl_rebuild_checkpoints (
  run_key TEXT NOT NULL,phase TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,
  finished_at TEXT,result_json TEXT,error TEXT,PRIMARY KEY(run_key,phase)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS nfl_rebuild_progress (
  run_key TEXT NOT NULL,phase TEXT NOT NULL,current INTEGER NOT NULL,total INTEGER NOT NULL,
  unit TEXT NOT NULL,status TEXT NOT NULL,detail_json TEXT,updated_at TEXT NOT NULL,
  PRIMARY KEY(run_key,phase)
)`);

function recordProgress(phaseName, state, unit = 'items', status = 'running') {
  const current = Math.max(0, Number(state.current) || 0), total = Math.max(0, Number(state.total) || 0);
  run(`INSERT INTO nfl_rebuild_progress
    (run_key,phase,current,total,unit,status,detail_json,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(run_key,phase) DO UPDATE SET current=excluded.current,total=excluded.total,
      unit=excluded.unit,status=excluded.status,detail_json=excluded.detail_json,
      updated_at=excluded.updated_at`, RUN_KEY, phaseName, current, total, unit, status,
  JSON.stringify(state), new Date().toISOString());
}

async function phase(name, fn) {
  const prior = rows(`SELECT * FROM nfl_rebuild_checkpoints WHERE run_key=? AND phase=?`, RUN_KEY, name)[0];
  if (prior?.status === 'complete') {
    const saved = prior.result_json ? JSON.parse(prior.result_json) : null;
    if (saved?.complete === false) {
      log(name, { resumed: true, invalidated_incomplete_checkpoint: true,
        failures: saved.failures?.length ?? null });
    } else {
      const total = Number(saved?.targets ?? saved?.games ?? 0);
      if (total) recordProgress(name, { current: total, total, resumed: true },
        saved?.games != null ? 'games' : 'items', 'complete');
      log(name, { resumed: true, skipped_completed_phase: true });
      return saved;
    }
  }
  run(`INSERT INTO nfl_rebuild_checkpoints(run_key,phase,status,started_at)
    VALUES (?,?,?,?) ON CONFLICT(run_key,phase) DO UPDATE SET status=excluded.status,
      started_at=excluded.started_at,finished_at=NULL,error=NULL`,
  RUN_KEY, name, 'running', new Date().toISOString());
  log(name, { status: 'started' });
  try {
    const result = await fn();
    run(`UPDATE nfl_rebuild_checkpoints SET status='complete',finished_at=?,result_json=?
      WHERE run_key=? AND phase=?`, new Date().toISOString(), JSON.stringify(result), RUN_KEY, name);
    log(name, result);
    const total = Number(result?.targets ?? result?.games ?? 0);
    if (total) recordProgress(name, { current: total, total }, result?.games != null ? 'games' : 'items', 'complete');
    else {
      const tracked = rows(`SELECT current,total,unit,detail_json FROM nfl_rebuild_progress
        WHERE run_key=? AND phase=?`, RUN_KEY, name)[0];
      if (tracked) recordProgress(name, { ...(tracked.detail_json ? JSON.parse(tracked.detail_json) : {}),
        current: tracked.total, total: tracked.total }, tracked.unit, 'complete');
    }
    return result;
  } catch (error) {
    run(`UPDATE nfl_rebuild_checkpoints SET status='failed',finished_at=?,error=?
      WHERE run_key=? AND phase=?`, new Date().toISOString(), error.message, RUN_KEY, name);
    log(name, { status: 'failed', error: error.message });
    const tracked = rows(`SELECT current,total,unit,detail_json FROM nfl_rebuild_progress
      WHERE run_key=? AND phase=?`, RUN_KEY, name)[0];
    if (tracked) recordProgress(name, { ...(tracked.detail_json ? JSON.parse(tracked.detail_json) : {}),
      current: tracked.current, total: tracked.total, error: error.message }, tracked.unit, 'failed');
    throw error;
  }
}

await phase('advanced_public_sources', async () => ({
  ngs: await syncNgs(SEASONS), pfr_advanced: await syncPfrAdv(SEASONS),
  snaps: await syncSnaps(SEASONS), depth: await syncDepthCharts(SEASONS),
  injuries: await syncInjuries(SEASONS)
}));

await phase('verified_events', () => syncVerifiedEventArchive({
  seasons: SEASONS, includeWeeklyRosters: true
}));

await phase('charted_play_context', async () => {
  const formations = [], charting = [];
  const retry = async (label, fn, attempts = 3) => {
    let last;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await fn();
        if (result?.error) throw new Error(result.error);
        return { ...result, attempt };
      } catch (error) {
        last = error;
        log('source_retry', { label, attempt, error: error.message });
      }
    }
    throw new Error(`${label} failed after ${attempts} attempts: ${last?.message}`);
  };
  for (const season of SEASONS.filter(value => value <= 2023)) {
    const existing = Number(rows(`SELECT COUNT(*) n FROM nfl_play_formations WHERE season=?`, season)[0]?.n ?? 0);
    formations.push(existing > 1000 ? { season, existing, skipped_complete_season: true }
      : await retry(`formations ${season}`, () => ingestFormations(season)));
  }
  for (const season of SEASONS) {
    const existing = Number(rows(`SELECT COUNT(*) n FROM nfl_play_charting WHERE season=?`, season)[0]?.n ?? 0);
    charting.push(existing > 1000 ? { season, existing, skipped_complete_season: true }
      : await retry(`FTN charting ${season}`, () => ingestCharting(season)));
  }
  return { formations, charting };
});

await phase('team_code_reconciliation', () => reconcileHistoricalTeamCodes());

await phase('team_feature_vectors', () => backfillTeamFeatureVectors({
  seasons: SEASONS, startWeek: START_WEEK, endWeek: END_WEEK,
  onProgress: state => recordProgress('team_feature_vectors', state, 'team-weeks')
}));

await phase('missing_team_vector_repair', () => backfillTeamFeatureVectors({
  seasons: SEASONS, startWeek: START_WEEK, endWeek: END_WEEK,
  onProgress: state => recordProgress('missing_team_vector_repair', state, 'team-weeks')
}));

await phase('player_feature_vectors', () => backfillPlayerFeatureVectors({
  seasons: SEASONS, startWeek: START_WEEK, endWeek: END_WEEK,
  onProgress: state => recordProgress('player_feature_vectors', state, 'player-weeks')
}));

await phase('frozen_team_cards', () => {
  const result = backfillTeamCards({
    seasons: SEASONS, startWeek: START_WEEK, endWeek: END_WEEK,
    onProgress: state => recordProgress('frozen_team_cards', state, 'games')
  });
  if (!result.complete) throw new Error(`frozen team cards incomplete: ${result.failures.length} conflicts or missing cards`);
  return result;
});

await phase('weekly_calibration_and_specialists', () => {
  const calibration = [], specialists = [];
  let current = 0;
  for (const season of SEASONS) for (let week = START_WEEK; week <= END_WEEK; week++) {
    calibration.push(simulationCalibrationFor(season, week, { persist: true }));
    specialists.push(fitOrthogonalSpecialists(season, week, { persist: true }));
    current++;
    recordProgress('weekly_calibration_and_specialists', { current, total: SEASONS.length
      * (END_WEEK - START_WEEK + 1), season, week }, 'season-weeks');
  }
  return { calibration: calibration.map(item => ({ season: item.season, week: item.week,
    available: item.available, games: item.games, plays: item.plays, error: item.error })),
  specialists: specialists.map(item => ({ through: item.through, training_games: item.training_games,
    validation_games: item.validation_games, error: item.error })) };
});

await phase('coverage_snapshot', () => {
  const snapshots = [];
  const inventory = nflFeatureCoverage();
  for (let index = 0; index < SEASONS.length; index++) {
    snapshots.push(freezeFeatureCoverageSnapshot(SEASONS[index], END_WEEK, { snapshot: inventory }));
    recordProgress('coverage_snapshot', { current: index + 1, total: SEASONS.length,
      season: SEASONS[index] }, 'seasons');
  }
  return { inventory, feature_store: weeklyFeatureStoreStatus(),
    team_cards: teamCardCoverage(), snapshots: snapshots.map(item => ({ existing: item.existing,
      evidence_hash: item.evidence_hash })) };
});

const registration = await phase(AUDIT_PHASE, () => preregisterBlindAudit({
  label: AUDIT_LABEL,
  seasons: SEASONS, startWeek: START_WEEK, endWeek: END_WEEK
}));
const auditId = registration?.id ?? rows(`SELECT id FROM nfl_blind_audit_runs
  WHERE label=? ORDER BY id DESC LIMIT 1`,
AUDIT_LABEL)[0]?.id;
if (!auditId) throw new Error('audit preregistration completed without a recoverable audit id');

await phase(CHRONOLOGICAL_PHASE, () => {
  let status = blindAuditStatus(auditId);
  const totalGames = Number(rows(`SELECT COUNT(*) n FROM game_lines WHERE home=1
    AND season BETWEEN 2022 AND 2025 AND week BETWEEN ? AND ?`, START_WEEK, END_WEEK)[0]?.n ?? 0);
  try {
    while (status.status !== 'complete') {
      status = runNextBlindAuditWeek(auditId);
      const completedGames = Number(rows(`SELECT COUNT(*) n FROM game_lines g WHERE g.home=1
        AND g.season BETWEEN 2022 AND 2025 AND g.week BETWEEN ? AND ? AND EXISTS (
          SELECT 1 FROM nfl_blind_audit_weeks w WHERE w.run_id=? AND w.season=g.season AND w.week=g.week
        )`, START_WEEK, END_WEEK, auditId)[0]?.n ?? 0);
      recordProgress(CHRONOLOGICAL_PHASE, { current: completedGames, total: totalGames,
        weeks_opened: status.progress.opened, weeks_total: status.progress.total,
        average_week_ms: status.performance?.average_total_ms ?? null,
        estimated_remaining_ms: status.performance?.estimated_remaining_ms ?? null,
        processing_rate_games_per_minute: status.performance?.average_total_ms
          ? +((completedGames / status.progress.opened) * 60000
            / status.performance.average_total_ms).toFixed(2) : null }, 'games');
      log('chronological_audit_progress', status.progress);
    }
  } catch (error) {
    failBlindAudit(auditId, error);
    throw error;
  }
  return status;
});

await phase('possession_ledger_reconstruction', () => backfillPossessionLedger({
  seasons: SEASONS, maxGames: LEDGER_GAMES, trials: LEDGER_TRIALS, maxPossessionsPerGame: 28,
  onProgress: state => recordProgress('possession_ledger_reconstruction', state, 'games')
}));

await phase('final_status', () => ({ audit: blindAuditStatus(auditId),
  possession_ledger: liveLedgerStatus(), features: weeklyFeatureStoreStatus(),
  cards: teamCardCoverage() }));

log('complete', { run_key: RUN_KEY, audit_id: auditId,
  untouched_forward_test: '2026 forward_live rows only; no 2026 outcome has been used for training.' });
