/** Resumable, chronological development backfill for the unified engine. */
import { db, row, rows, run } from '../db/index.js';
import { syncAll as syncNflverse } from './nflverse.js';
import { syncPbpSeason } from './nfl-pbp.js';
import { syncNgs, syncPfrAdv, syncSnaps, syncDepthCharts, syncInjuries } from './nfl-advanced.js';
import { ensembleLine, fitEnsemble, invalidateEnsembleCaches } from './nfl-ensemble.js';
import { nflEngineVersionFor, recordNflEngineArtifact } from './nfl-engine-registry.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_engine_backfill_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL, finished_at TEXT,
  start_season INTEGER NOT NULL, end_season INTEGER NOT NULL,
  ingest_requested INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, detail_json TEXT
);
CREATE TABLE IF NOT EXISTS nfl_engine_backfill_checkpoints (
  run_id INTEGER NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
  stage TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, detail_json TEXT,
  PRIMARY KEY(run_id,season,week,stage),
  FOREIGN KEY(run_id) REFERENCES nfl_engine_backfill_runs(id)
);
CREATE TABLE IF NOT EXISTS nfl_historical_engine_replay (
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
  engine_version TEXT NOT NULL, generated_at TEXT NOT NULL,
  market_margin REAL, projected_margin REAL, projected_total REAL,
  actual_margin REAL NOT NULL, actual_total REAL NOT NULL,
  classification TEXT NOT NULL DEFAULT 'historical_development_replay',
  PRIMARY KEY(season,week,home,engine_version)
);
`);

const sourceTables = ['game_lines', 'nfl_team_week_features', 'nfl_player_week_features',
  'player_week_usage', 'nfl_snaps', 'nfl_ngs', 'nfl_pfr_adv', 'nfl_depth', 'nfl_injuries'];
const tableExists = table => Boolean(row(`SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?`, table));
const count = (table, season) => tableExists(table)
  ? Number(row(`SELECT COUNT(*) n FROM ${table} WHERE season=?`, season)?.n ?? 0) : 0;
const through = (table, season) => tableExists(table)
  ? Number(row(`SELECT COALESCE(MAX(week),0) n FROM ${table} WHERE season=?`, season)?.n ?? 0) : 0;

export function nflBackfillPlan({ startSeason = 2022, endSeason = 2025 } = {}) {
  const start = Number(startSeason), end = Number(endSeason);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
    throw new Error('backfill requires an ordered integer season range');
  }
  const seasons = [];
  for (let season = start; season <= end; season++) {
    const games = Number(row(`SELECT COUNT(*) n FROM game_lines WHERE season=? AND home=1`, season)?.n ?? 0);
    const complete = Number(row(`SELECT COUNT(*) n FROM game_lines WHERE season=? AND home=1
      AND team_score IS NOT NULL AND opp_score IS NOT NULL`, season)?.n ?? 0);
    const sources = Object.fromEntries(sourceTables.map(table => [table,
      { rows: count(table, season), through_week: through(table, season) }]));
    seasons.push({ season, games, completed_games: complete, sources,
      ready_for_local_replay: games > 0 && complete === games && sources.nfl_team_week_features.rows > 0 });
  }
  return {
    classification: 'historical_development_only', start_season: start, end_season: end, seasons,
    stages: ['optional source ingest', 'cutoff-safe weekly fit', 'week prediction', 'outcome grading', 'bias slices', 'artifact seal'],
    leakage_rule: 'Week W fits and predictions may consume only seasons before W or weeks strictly before W.',
    missing_news_rule: 'Historical news is used only when a real publication timestamp and verified source exist; missing news is an explicit mask, never reconstructed prose.',
    forward_claim: 'Historical replay can train and reject candidates. It cannot substitute for the frozen 2026 forward ledger.'
  };
}

async function ingestSeason(season) {
  const detail = {};
  const attempt = async (id, fn) => { try { detail[id] = await fn(); } catch (error) { detail[id] = { error: error.message }; } };
  await attempt('weekly', () => syncNflverse([season]));
  await attempt('pbp', () => syncPbpSeason(season));
  await attempt('ngs', () => syncNgs([season]));
  await attempt('pfr', () => syncPfrAdv([season]));
  await attempt('snaps', () => syncSnaps([season]));
  await attempt('depth', () => syncDepthCharts([season]));
  await attempt('injuries', () => syncInjuries([season]));
  return detail;
}

function checkpoint(runId, season, week, stage, status, detail) {
  run(`INSERT INTO nfl_engine_backfill_checkpoints
    (run_id,season,week,stage,status,completed_at,detail_json) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(run_id,season,week,stage) DO UPDATE SET status=excluded.status,
      completed_at=excluded.completed_at,detail_json=excluded.detail_json`,
  runId, season, week, stage, status, new Date().toISOString(), JSON.stringify(detail ?? {}));
}

export function historicalReplayBiasAudit({ startSeason = 2022, endSeason = 2025 } = {}) {
  const data = rows(`SELECT * FROM nfl_historical_engine_replay WHERE season BETWEEN ? AND ?
    ORDER BY season,week,home`, startSeason, endSeason);
  const score = subset => {
    const decisions = subset.map(item => {
      const edge = item.projected_margin - item.market_margin;
      const result = item.actual_margin - item.market_margin;
      return { edge, result, decided: edge !== 0 && result !== 0, win: Math.sign(edge) === Math.sign(result) };
    }).filter(item => item.decided);
    return { n: subset.length, decisions: decisions.length,
      hit_rate: decisions.length ? +(decisions.filter(item => item.win).length / decisions.length).toFixed(4) : null,
      mean_margin_error: subset.length ? +(subset.reduce((sum, item) => sum + item.projected_margin - item.actual_margin, 0) / subset.length).toFixed(3) : null };
  };
  return {
    overall: score(data),
    home_favorite: score(data.filter(item => item.market_margin > 0)),
    home_underdog: score(data.filter(item => item.market_margin < 0)),
    close_games: score(data.filter(item => Math.abs(item.market_margin) <= 3)),
    large_spreads: score(data.filter(item => Math.abs(item.market_margin) >= 7)),
    by_season: Object.fromEntries([...new Set(data.map(item => item.season))].map(season =>
      [season, score(data.filter(item => item.season === season))])),
    caveat: 'These slices measure systematic error and favorite/home asymmetry. They do not prove absence of social, injury-reporting, or selection bias.'
  };
}

export async function runNflEngineBackfill({ startSeason = 2022, endSeason = 2025,
  ingest = false, maxWeeks = null } = {}) {
  const plan = nflBackfillPlan({ startSeason, endSeason });
  const startedAt = new Date().toISOString();
  const created = run(`INSERT INTO nfl_engine_backfill_runs
    (started_at,start_season,end_season,ingest_requested,status,detail_json)
    VALUES (?,?,?,?,?,'{}')`, startedAt, plan.start_season, plan.end_season, ingest ? 1 : 0, 'running');
  const runId = Number(created.lastInsertRowid), detail = { ingestion: {}, weeks: [] };
  try {
    let processed = 0;
    for (let season = plan.start_season; season <= plan.end_season; season++) {
      if (ingest) detail.ingestion[season] = await ingestSeason(season);
      const weeks = rows(`SELECT DISTINCT week FROM game_lines WHERE season=? AND home=1
        AND team_score IS NOT NULL AND opp_score IS NOT NULL ORDER BY week`, season).map(item => Number(item.week));
      for (const week of weeks) {
        if (maxWeeks != null && processed >= Number(maxWeeks)) break;
        invalidateEnsembleCaches();
        const fit = fitEnsemble({ beforeSeason: season, beforeWeek: week });
        if (fit.error) { checkpoint(runId, season, week, 'fit', 'blocked', fit); continue; }
        checkpoint(runId, season, week, 'fit', 'complete', { games: fit.games, cutoff: fit.weight_cutoff });
        const slate = rows(`SELECT team home,opponent away,spread,team_score,opp_score
          FROM game_lines WHERE season=? AND week=? AND home=1 AND team_score IS NOT NULL`, season, week);
        let written = 0;
        for (const game of slate) {
          const prediction = ensembleLine(season, week, game.home, game.away,
            { blendMode: 'market_residual', includeEvidence: false });
          if (prediction.error || prediction.ensemble.projected_margin == null) continue;
          const marketMargin = game.spread == null ? null : -Number(game.spread);
          written += run(`INSERT OR IGNORE INTO nfl_historical_engine_replay
            (season,week,home,away,engine_version,generated_at,market_margin,projected_margin,
             projected_total,actual_margin,actual_total)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, season, week, game.home, game.away,
          nflEngineVersionFor(season, week), new Date().toISOString(), marketMargin,
          prediction.ensemble.projected_margin, prediction.ensemble.projected_total,
          game.team_score - game.opp_score, game.team_score + game.opp_score).changes;
        }
        checkpoint(runId, season, week, 'replay', 'complete', { games: slate.length, written });
        detail.weeks.push({ season, week, games: slate.length, written });
        processed++;
      }
      const lastWeek = weeks.at(-1);
      if (lastWeek) recordNflEngineArtifact(season, lastWeek);
      if (maxWeeks != null && processed >= Number(maxWeeks)) break;
    }
    const result = { run_id: runId, status: 'complete', started_at: startedAt,
      finished_at: new Date().toISOString(), plan, ...detail,
      bias_audit: historicalReplayBiasAudit({ startSeason: plan.start_season, endSeason: plan.end_season }) };
    run(`UPDATE nfl_engine_backfill_runs SET finished_at=?,status='complete',detail_json=? WHERE id=?`,
    result.finished_at, JSON.stringify(result), runId);
    return result;
  } catch (error) {
    run(`UPDATE nfl_engine_backfill_runs SET finished_at=?,status='error',detail_json=? WHERE id=?`,
    new Date().toISOString(), JSON.stringify({ ...detail, error: error.message }), runId);
    throw error;
  }
}

export function nflBackfillStatus() {
  const latest = row(`SELECT * FROM nfl_engine_backfill_runs ORDER BY id DESC LIMIT 1`);
  return { latest: latest ? { ...latest, detail: JSON.parse(latest.detail_json ?? '{}'), detail_json: undefined } : null,
    replay_rows: Number(row(`SELECT COUNT(*) n FROM nfl_historical_engine_replay`)?.n ?? 0),
    plan: nflBackfillPlan() };
}

