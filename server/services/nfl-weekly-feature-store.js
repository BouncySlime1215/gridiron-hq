/**
 * High-dimensional weekly feature factory.
 *
 * Raw metrics become useful state only when their history, trend, volatility,
 * coverage and missingness are represented at the prediction cutoff. The store
 * generates those transformations uniformly and freezes the resulting vector.
 */
import crypto from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { nflKickoffDate } from './date-util.js';

export const WEEKLY_FEATURE_STORE_VERSION = 'nfl-weekly-feature-store-v1';
export const TRUSTED_HISTORY_START = Math.max(1999, Number(process.env.NFL_TRUSTED_HISTORY_START) || 2022);

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_feature_dictionary (
    feature_id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,source_family TEXT NOT NULL,
    source_metric TEXT NOT NULL,transform TEXT NOT NULL,version TEXT NOT NULL,
    description TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nfl_team_feature_vectors (
    season INTEGER NOT NULL,week INTEGER NOT NULL,team TEXT NOT NULL,version TEXT NOT NULL,
    cutoff TEXT NOT NULL,evidence_hash TEXT NOT NULL,feature_count INTEGER NOT NULL,
    coverage REAL NOT NULL,vector_json TEXT NOT NULL,missing_json TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(season,week,team,version)
  );
  CREATE TABLE IF NOT EXISTS nfl_player_feature_vectors (
    season INTEGER NOT NULL,week INTEGER NOT NULL,player_id TEXT NOT NULL,player_name TEXT,
    position TEXT,team TEXT,version TEXT NOT NULL,cutoff TEXT NOT NULL,evidence_hash TEXT NOT NULL,
    feature_count INTEGER NOT NULL,coverage REAL NOT NULL,vector_json TEXT NOT NULL,
    missing_json TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(season,week,player_id,version)
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_team_feature_vector_cutoff
    ON nfl_team_feature_vectors(season,week,team);
  CREATE INDEX IF NOT EXISTS idx_nfl_player_feature_vector_cutoff
    ON nfl_player_feature_vectors(season,week,team,position);
  CREATE TRIGGER IF NOT EXISTS nfl_team_feature_vectors_no_update BEFORE UPDATE ON nfl_team_feature_vectors
    BEGIN SELECT RAISE(ABORT, 'weekly team feature vectors are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_team_feature_vectors_no_delete BEFORE DELETE ON nfl_team_feature_vectors
    BEGIN SELECT RAISE(ABORT, 'weekly team feature vectors are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_player_feature_vectors_no_update BEFORE UPDATE ON nfl_player_feature_vectors
    BEGIN SELECT RAISE(ABORT, 'weekly player feature vectors are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_player_feature_vectors_no_delete BEFORE DELETE ON nfl_player_feature_vectors
    BEGIN SELECT RAISE(ABORT, 'weekly player feature vectors are immutable'); END;
`);

const TRANSFORMS = Object.freeze(['latest', 'mean_3', 'mean_6', 'mean_12', 'ewma_6',
  'slope_6', 'sd_6', 'min_6', 'max_6', 'delta_1', 'z_latest', 'coverage_12', 'missing']);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
};
const sha = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const parse = (value, fallback = {}) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const optionalRows = (sql, ...args) => { try { return rows(sql, ...args); } catch { return []; } };
const finite = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sd = values => {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};
const r6 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(6);

function kickoff(season, week, team) {
  const game = rows(`SELECT gameday,gametime FROM game_lines WHERE season=? AND week=? AND team=? LIMIT 1`,
  season, week, team)[0];
  return game?.gameday
    ? nflKickoffDate(game.gameday, game.gametime || '23:59')?.toISOString() ?? `${game.gameday}T23:59:59Z`
    : `${season}-W${week}-pregame`;
}

function numericObject(object, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(object ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(result, numericObject(value, `${prefix}${key}_`));
    else if (finite(value) != null) result[`${prefix}${key}`] = finite(value);
  }
  return result;
}

function slope(values) {
  if (values.length < 2) return null;
  const xMean = (values.length - 1) / 2, yMean = mean(values);
  let numerator = 0, denominator = 0;
  for (let i = 0; i < values.length; i++) {
    numerator += (i - xMean) * (values[i] - yMean); denominator += (i - xMean) ** 2;
  }
  return denominator ? numerator / denominator : null;
}

function ewma(values, alpha = 0.35) {
  if (!values.length) return null;
  let state = values.at(-1);
  for (let i = values.length - 2; i >= 0; i--) state = alpha * values[i] + (1 - alpha) * state;
  return state;
}

function metricUniverse(history) {
  const keys = new Set();
  for (const observation of history) for (const key of Object.keys(observation.values)) keys.add(key);
  return [...keys].sort();
}

function transforms(history, leagueLatest = new Map()) {
  const vector = {}, missing = [];
  for (const metric of metricUniverse(history)) {
    const observations = history.map(item => item.values[metric]).filter(value => finite(value) != null);
    const recent = observations.slice(0, 12), six = recent.slice(0, 6);
    const latest = recent[0] ?? null, prior = recent[1] ?? null;
    const league = leagueLatest.get(metric) ?? [];
    const leagueMean = mean(league), leagueSd = sd(league);
    const values = {
      latest, mean_3: mean(recent.slice(0, 3)), mean_6: mean(six), mean_12: mean(recent),
      ewma_6: ewma(six), slope_6: slope([...six].reverse()), sd_6: sd(six),
      min_6: six.length ? Math.min(...six) : null, max_6: six.length ? Math.max(...six) : null,
      delta_1: latest != null && prior != null ? latest - prior : null,
      z_latest: latest != null && leagueMean != null && leagueSd > 1e-9 ? (latest - leagueMean) / leagueSd : null,
      coverage_12: recent.length / 12, missing: latest == null ? 1 : 0
    };
    for (const transform of TRANSFORMS) {
      const id = `${metric}__${transform}`, value = r6(values[transform]);
      if (value == null) missing.push(id); else vector[id] = value;
    }
  }
  return { vector, missing, raw_metrics: metricUniverse(history).length };
}

function register(entityType, sourceFamily, vector) {
  const now = new Date().toISOString();
  for (const id of Object.keys(vector)) {
    const marker = id.lastIndexOf('__'), metric = id.slice(0, marker), transform = id.slice(marker + 2);
    run(`INSERT OR IGNORE INTO nfl_feature_dictionary
      (feature_id,entity_type,source_family,source_metric,transform,version,description,created_at)
      VALUES (?,?,?,?,?,?,?,?)`, `${entityType}:${id}`, entityType, sourceFamily, metric, transform,
    WEEKLY_FEATURE_STORE_VERSION, `${transform} of cutoff-safe ${metric} history`, now);
  }
}

function teamHistory(season, week, team, limit = 12) {
  const base = rows(`SELECT season,week,features FROM nfl_team_week_features
    WHERE team=? AND season>=? AND (season<? OR (season=? AND week<?))
    ORDER BY season DESC,week DESC LIMIT ?`, team, TRUSTED_HISTORY_START, season, season, week, limit)
    .map(item => ({ season: item.season, week: item.week, values: numericObject(parse(item.features)) }));
  const byStamp = new Map(base.map(item => [`${item.season}|${item.week}`, item]));
  const merge = (items, prefix = '') => {
    for (const item of items) {
      const key = `${item.season}|${item.week}`;
      const target = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
      Object.assign(target.values, numericObject(item, prefix));
      delete target.values[`${prefix}season`]; delete target.values[`${prefix}week`];
      byStamp.set(key, target);
    }
  };
  merge(optionalRows(`SELECT season,week,
      AVG(offense_pct) avg_offense_participation,AVG(defense_pct) avg_defense_participation,
      SUM(offense_snaps) offense_player_snaps,SUM(defense_snaps) defense_player_snaps,
      SUM(CASE WHEN offense_pct>=0.5 THEN 1 ELSE 0 END) offensive_core_players,
      SUM(CASE WHEN defense_pct>=0.5 THEN 1 ELSE 0 END) defensive_core_players
    FROM nfl_snaps WHERE team=? AND season>=? AND (season<? OR (season=? AND week<?))
    GROUP BY season,week ORDER BY season DESC,week DESC LIMIT ?`, team, TRUSTED_HISTORY_START,
  season, season, week, limit), 'snap_');
  merge(optionalRows(`SELECT season,week,COUNT(*) listed,
      SUM(CASE WHEN lower(COALESCE(report_status,''))='out' THEN 1 ELSE 0 END) out_count,
      SUM(CASE WHEN lower(COALESCE(report_status,''))='doubtful' THEN 1 ELSE 0 END) doubtful_count,
      SUM(CASE WHEN lower(COALESCE(report_status,''))='questionable' THEN 1 ELSE 0 END) questionable_count,
      SUM(CASE WHEN lower(COALESCE(practice_status,'')) LIKE '%did not%' THEN 1 ELSE 0 END) did_not_practice
    FROM nfl_injuries WHERE team=? AND season>=? AND (season<? OR (season=? AND week<?))
    GROUP BY season,week ORDER BY season DESC,week DESC LIMIT ?`, team, TRUSTED_HISTORY_START,
  season, season, week, limit), 'injury_');
  merge(optionalRows(`SELECT season,CAST(substr(game_id,6,2) AS INTEGER) week,
      AVG(CASE WHEN offense_formation='SHOTGUN' THEN 1.0 ELSE 0.0 END) shotgun_share,
      AVG(CASE WHEN offense_formation='EMPTY' THEN 1.0 ELSE 0.0 END) empty_share,
      AVG(CASE WHEN offense_formation='SINGLEBACK' THEN 1.0 ELSE 0.0 END) singleback_share,
      AVG(defenders_in_box) defenders_in_box,AVG(pass_rushers) pass_rushers,COUNT(*) plays
    FROM nfl_play_formations WHERE possession=? AND season>=? AND
      (season<? OR (season=? AND CAST(substr(game_id,6,2) AS INTEGER)<?))
    GROUP BY season,CAST(substr(game_id,6,2) AS INTEGER)
    ORDER BY season DESC,week DESC LIMIT ?`, team, TRUSTED_HISTORY_START,
  season, season, week, limit), 'formation_');
  merge(optionalRows(`SELECT f.season,CAST(substr(f.game_id,6,2) AS INTEGER) week,
      AVG(c.motion) motion_share,AVG(c.play_action) play_action_share,AVG(c.screen) screen_share,
      AVG(c.rpo) rpo_share,AVG(c.out_of_pocket) out_of_pocket_share,
      AVG(c.contested) contested_share,AVG(c.defense_box) charted_box,COUNT(*) charted_plays
    FROM nfl_play_formations f JOIN nfl_play_charting c
      ON c.game_id=f.game_id AND c.play_id=f.play_id
    WHERE f.possession=? AND f.season>=? AND (f.season<? OR
      (f.season=? AND CAST(substr(f.game_id,6,2) AS INTEGER)<?))
    GROUP BY f.season,CAST(substr(f.game_id,6,2) AS INTEGER)
    ORDER BY f.season DESC,week DESC LIMIT ?`, team, TRUSTED_HISTORY_START,
  season, season, week, limit), 'charting_');
  return [...byStamp.values()].sort((a, b) => b.season - a.season || b.week - a.week).slice(0, limit);
}

function teamLeagueLatest(season, week) {
  const latest = rows(`SELECT f.team,f.features FROM nfl_team_week_features f
    JOIN (SELECT team,MAX(season*100+week) stamp FROM nfl_team_week_features
      WHERE season>=? AND (season<? OR (season=? AND week<?)) GROUP BY team) x
    ON x.team=f.team AND x.stamp=f.season*100+f.week`, TRUSTED_HISTORY_START, season, season, week);
  const map = new Map();
  for (const item of latest) for (const [metric, value] of Object.entries(numericObject(parse(item.features)))) {
    const list = map.get(metric) ?? []; list.push(value); map.set(metric, list);
  }
  return map;
}

export function buildTeamFeatureVector(season, week, team) {
  const history = teamHistory(season, week, team);
  if (!history.length) return { error: 'no earlier team-week observations' };
  const result = transforms(history, teamLeagueLatest(season, week));
  const cutoff = kickoff(season, week, team), evidenceHash = sha({ season, week, team, cutoff, history });
  return { version: WEEKLY_FEATURE_STORE_VERSION, entity_type: 'team', season, week, team,
    cutoff, evidence_hash: evidenceHash, feature_count: Object.keys(result.vector).length,
    raw_metrics: result.raw_metrics, coverage: result.raw_metrics
      ? Object.keys(result.vector).length / (result.raw_metrics * TRANSFORMS.length) : 0,
    vector: result.vector, missing: result.missing };
}

export function freezeTeamFeatureVector(season, week, team) {
  const existing = rows(`SELECT * FROM nfl_team_feature_vectors WHERE season=? AND week=? AND team=? AND version=?`,
  season, week, team, WEEKLY_FEATURE_STORE_VERSION)[0];
  if (existing) return { existing: true, ...existing, vector: parse(existing.vector_json) };
  const built = buildTeamFeatureVector(season, week, team);
  if (built.error) return built;
  register('team', 'nfl_team_week_features', built.vector);
  run(`INSERT INTO nfl_team_feature_vectors
    (season,week,team,version,cutoff,evidence_hash,feature_count,coverage,vector_json,missing_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, season, week, team, WEEKLY_FEATURE_STORE_VERSION,
  built.cutoff, built.evidence_hash, built.feature_count, built.coverage,
  JSON.stringify(built.vector), JSON.stringify(built.missing), new Date().toISOString());
  return { existing: false, ...built };
}

export function getFrozenTeamFeatureVector(season, week, team) {
  const item = rows(`SELECT * FROM nfl_team_feature_vectors
    WHERE season=? AND week=? AND team=? AND version=?`,
  season, week, team, WEEKLY_FEATURE_STORE_VERSION)[0];
  return item ? { ...item, vector: parse(item.vector_json), missing: parse(item.missing_json, []) } : null;
}

function playerHistory(season, week, playerId, playerName, limit = 12) {
  const base = rows(`SELECT season,week,position,features FROM nfl_player_week_features
    WHERE player_id=? AND season>=? AND (season<? OR (season=? AND week<?))
    ORDER BY season DESC,week DESC LIMIT ?`, playerId, TRUSTED_HISTORY_START,
  season, season, week, limit);
  const byStamp = new Map(base.map(item => [`${item.season}|${item.week}`, {
    season: item.season, week: item.week, position: item.position,
    values: numericObject(parse(item.features), 'base_') }]));
  for (const item of rows(`SELECT season,week,kind,stats FROM nfl_ngs WHERE player_id=?
    AND season>=? AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC`,
  playerId, TRUSTED_HISTORY_START, season, season, week)) {
    const key = `${item.season}|${item.week}`;
    const row = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
    Object.assign(row.values, numericObject(parse(item.stats), `ngs_${item.kind}_`)); byStamp.set(key, row);
  }
  if (playerName) for (const item of rows(`SELECT season,week,kind,stats FROM nfl_pfr_adv
    WHERE player_name=? AND season>=? AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC`,
  playerName, TRUSTED_HISTORY_START, season, season, week)) {
    const key = `${item.season}|${item.week}`;
    const row = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
    Object.assign(row.values, numericObject(parse(item.stats), `pfr_${item.kind}_`)); byStamp.set(key, row);
  }
  if (playerName) for (const item of optionalRows(`SELECT season,week,offense_snaps,offense_pct,
      defense_snaps,defense_pct,st_pct FROM nfl_snaps WHERE player=?
      AND season>=? AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC LIMIT ?`,
  playerName, TRUSTED_HISTORY_START, season, season, week, limit)) {
    const key = `${item.season}|${item.week}`;
    const row = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
    Object.assign(row.values, numericObject(item, 'snap_'));
    delete row.values.snap_season; delete row.values.snap_week; byStamp.set(key, row);
  }
  for (const item of optionalRows(`SELECT season,week,report_status,practice_status FROM nfl_injuries
      WHERE gsis_id=? AND season>=? AND (season<? OR (season=? AND week<?))
      ORDER BY season DESC,week DESC LIMIT ?`, playerId, TRUSTED_HISTORY_START,
  season, season, week, limit)) {
    const severity = value => /out/i.test(value ?? '') ? 1 : /doubtful|did not/i.test(value ?? '') ? 0.75
      : /questionable|limited/i.test(value ?? '') ? 0.4 : 0;
    const key = `${item.season}|${item.week}`;
    const row = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
    row.values.injury_game_status_severity = severity(item.report_status);
    row.values.injury_practice_status_severity = severity(item.practice_status); byStamp.set(key, row);
  }
  const grades = rows(`SELECT season,week,overall_grade,facets_json FROM nfl_external_player_grades
    WHERE provider='pff' AND (player_id=? OR player_name=?)
      AND season>=? AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC LIMIT ?`,
  playerId, playerName ?? '', TRUSTED_HISTORY_START, season, season, week, limit);
  for (const item of grades) {
    const key = `${item.season}|${item.week}`;
    const row = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
    row.values.pff_overall_grade = finite(item.overall_grade);
    Object.assign(row.values, numericObject(parse(item.facets_json), 'pff_')); byStamp.set(key, row);
  }
  return [...byStamp.values()].sort((a, b) => b.season - a.season || b.week - a.week).slice(0, limit);
}

export function buildPlayerFeatureVector(season, week, playerId, { playerName = null,
  team = null, position = null } = {}) {
  const history = playerHistory(season, week, String(playerId), playerName);
  if (!history.length) return { error: 'no earlier player observations' };
  const result = transforms(history, new Map()), cutoff = team ? kickoff(season, week, team) : `${season}-W${week}-pregame`;
  const evidenceHash = sha({ season, week, playerId, cutoff, history });
  return { version: WEEKLY_FEATURE_STORE_VERSION, entity_type: 'player', season, week,
    player_id: String(playerId), player_name: playerName, team, position: position ?? history[0]?.position,
    cutoff, evidence_hash: evidenceHash, feature_count: Object.keys(result.vector).length,
    raw_metrics: result.raw_metrics, coverage: result.raw_metrics
      ? Object.keys(result.vector).length / (result.raw_metrics * TRANSFORMS.length) : 0,
    vector: result.vector, missing: result.missing };
}

export function freezePlayerFeatureVector(season, week, playerId, options = {}) {
  const existing = rows(`SELECT * FROM nfl_player_feature_vectors
    WHERE season=? AND week=? AND player_id=? AND version=?`,
  season, week, String(playerId), WEEKLY_FEATURE_STORE_VERSION)[0];
  if (existing) return { existing: true, ...existing, vector: parse(existing.vector_json) };
  const built = buildPlayerFeatureVector(season, week, playerId, options);
  if (built.error) return built;
  register('player', 'player+ngs+pfr+pff', built.vector);
  run(`INSERT INTO nfl_player_feature_vectors
    (season,week,player_id,player_name,position,team,version,cutoff,evidence_hash,feature_count,
     coverage,vector_json,missing_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  season, week, String(playerId), built.player_name, built.position, built.team,
  WEEKLY_FEATURE_STORE_VERSION, built.cutoff, built.evidence_hash, built.feature_count,
  built.coverage, JSON.stringify(built.vector), JSON.stringify(built.missing), new Date().toISOString());
  return { existing: false, ...built };
}

export function getFrozenPlayerFeatureVector(season, week, playerId) {
  const item = rows(`SELECT * FROM nfl_player_feature_vectors
    WHERE season=? AND week=? AND player_id=? AND version=?`,
  season, week, String(playerId), WEEKLY_FEATURE_STORE_VERSION)[0];
  return item ? { ...item, vector: parse(item.vector_json), missing: parse(item.missing_json, []) } : null;
}

export function backfillTeamFeatureVectors({ seasons = [2021, 2022, 2023, 2024, 2025],
  startWeek = 5, endWeek = 18 } = {}) {
  const targets = rows(`SELECT DISTINCT season,week,team FROM game_lines
    WHERE season IN (${seasons.map(() => '?').join(',')}) AND week BETWEEN ? AND ?
    ORDER BY season,week,team`, ...seasons, startWeek, endWeek);
  let frozen = 0, existing = 0;
  const failures = [];
  for (const target of targets) {
    const result = freezeTeamFeatureVector(target.season, target.week, target.team);
    if (result.error) failures.push({ ...target, error: result.error });
    else if (result.existing) existing++;
    else frozen++;
  }
  return { version: WEEKLY_FEATURE_STORE_VERSION, targets: targets.length, frozen, existing, failures };
}

export function backfillPlayerFeatureVectors({ seasons = [2021, 2022, 2023, 2024, 2025],
  startWeek = 5, endWeek = 18, teams = null } = {}) {
  const teamFilter = teams?.length ? ` AND current.team IN (${teams.map(() => '?').join(',')})` : '';
  const targets = rows(`SELECT current.season,current.week,current.player_id,current.player_name,
      current.team,current.position FROM nfl_player_week_features current
    WHERE current.season IN (${seasons.map(() => '?').join(',')})
      AND current.week BETWEEN ? AND ?${teamFilter}
    ORDER BY current.season,current.week,current.team,current.player_id`,
  ...seasons, startWeek, endWeek, ...(teams ?? []));
  let frozen = 0, existing = 0;
  const failures = [];
  for (const target of targets) {
    const result = freezePlayerFeatureVector(target.season, target.week, target.player_id, {
      playerName: target.player_name, team: target.team, position: target.position
    });
    if (result.error) failures.push({ ...target, error: result.error });
    else if (result.existing) existing++;
    else frozen++;
  }
  return { version: WEEKLY_FEATURE_STORE_VERSION, targets: targets.length, frozen, existing, failures };
}

/** Freeze the exact team/player state that every model will share next week. */
export function freezeWeeklyFeatureState(season, week) {
  const teams = rows(`SELECT DISTINCT team FROM game_lines WHERE season=? AND week=? ORDER BY team`,
  season, week).map(item => item.team);
  if (!teams.length) return { version: WEEKLY_FEATURE_STORE_VERSION, season, week,
    blocked: true, reason: 'target-week schedule is not loaded' };
  const teamResults = teams.map(team => freezeTeamFeatureVector(season, week, team));
  const latestPlayers = optionalRows(`SELECT p.player_id,p.player_name,p.team,p.position
    FROM nfl_player_week_features p JOIN (
      SELECT player_id,MAX(season*100+week) stamp FROM nfl_player_week_features
      WHERE season>=? AND (season<? OR (season=? AND week<?)) GROUP BY player_id
    ) latest ON latest.player_id=p.player_id AND latest.stamp=p.season*100+p.week
    WHERE p.team IN (${teams.map(() => '?').join(',')})
    ORDER BY p.team,p.player_id`, TRUSTED_HISTORY_START, season, season, week, ...teams);
  const playerResults = latestPlayers.map(player => freezePlayerFeatureVector(season, week,
    player.player_id, { playerName: player.player_name, team: player.team, position: player.position }));
  const summarize = results => ({ targets: results.length,
    frozen: results.filter(item => !item.error && !item.existing).length,
    existing: results.filter(item => item.existing).length,
    failures: results.filter(item => item.error).map(item => item.error),
    avg_features: results.filter(item => Number.isFinite(item.feature_count)).length
      ? r6(mean(results.filter(item => Number.isFinite(item.feature_count)).map(item => item.feature_count))) : null,
    avg_coverage: results.filter(item => Number.isFinite(item.coverage)).length
      ? r6(mean(results.filter(item => Number.isFinite(item.coverage)).map(item => item.coverage))) : null });
  return { version: WEEKLY_FEATURE_STORE_VERSION, season, week,
    teams: summarize(teamResults), players: summarize(playerResults),
    contract: 'All observations are strictly earlier than the target week and frozen before downstream inference.' };
}

export function weeklyFeatureStoreStatus() {
  const dictionary = rows(`SELECT entity_type,COUNT(*) features,COUNT(DISTINCT source_metric) raw_metrics
    FROM nfl_feature_dictionary WHERE version=? GROUP BY entity_type`, WEEKLY_FEATURE_STORE_VERSION);
  const teams = rows(`SELECT season,COUNT(*) vectors,ROUND(AVG(feature_count),1) avg_features,
      ROUND(AVG(coverage),3) avg_coverage FROM nfl_team_feature_vectors
    WHERE version=? GROUP BY season ORDER BY season`, WEEKLY_FEATURE_STORE_VERSION);
  const players = rows(`SELECT season,COUNT(*) vectors,ROUND(AVG(feature_count),1) avg_features,
      ROUND(AVG(coverage),3) avg_coverage FROM nfl_player_feature_vectors
    WHERE version=? GROUP BY season ORDER BY season`, WEEKLY_FEATURE_STORE_VERSION);
  return { version: WEEKLY_FEATURE_STORE_VERSION, transforms: TRANSFORMS,
    trusted_history_start: TRUSTED_HISTORY_START,
    declared_raw_current: { team: 183, player: 67, next_gen: 23, pfr_advanced: 30 },
    potential: { team: 183 * TRANSFORMS.length, player_public_plus_licensed: 120 * TRANSFORMS.length },
    dictionary, team_vectors: teams, player_vectors: players,
    policy: 'Feature count is reported with coverage; missing values remain explicit and never become zero evidence. Earlier quarantined seasons are not used in rolling state.' };
}

export const __test = { transforms, slope, ewma, numericObject, TRANSFORMS };
