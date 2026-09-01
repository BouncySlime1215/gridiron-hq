/** Evidence-backed inventory of the variables that can exist at each weekly cutoff. */
import crypto from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { WEEKLY_FEATURE_STORE_VERSION, weeklyFeatureStoreStatus } from './nfl-weekly-feature-store.js';

export const FEATURE_COVERAGE_VERSION = 'nfl-feature-coverage-v1';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_feature_coverage_snapshots (
    season INTEGER NOT NULL,week INTEGER NOT NULL,version TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(season,week,version)
  );
  CREATE TRIGGER IF NOT EXISTS nfl_feature_coverage_snapshots_no_update
    BEFORE UPDATE ON nfl_feature_coverage_snapshots BEGIN
      SELECT RAISE(ABORT, 'feature coverage snapshots are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_feature_coverage_snapshots_no_delete
    BEFORE DELETE ON nfl_feature_coverage_snapshots BEGIN
      SELECT RAISE(ABORT, 'feature coverage snapshots are immutable'); END;
`);

const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tableExists = name => Boolean(rows(`SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?`, name)[0]);
const safe = (sql, ...args) => { try { return rows(sql, ...args); } catch { return []; } };

function jsonFamily(id, table, jsonColumn, { kind = null, entity = null } = {}) {
  if (!tableExists(table)) return { id, table, available: false, reason: 'table_missing' };
  const columns = safe(`PRAGMA table_info(${table})`).map(item => item.name);
  if (!columns.includes(jsonColumn)) return { id, table, available: false, reason: 'json_column_missing' };
  const byYear = safe(`SELECT t.season,COUNT(DISTINCT t.rowid) rows,
      COUNT(DISTINCT j.key) declared_variables,
      SUM(CASE WHEN j.value IS NOT NULL AND CAST(j.value AS TEXT) NOT IN ('','null') THEN 1 ELSE 0 END) populated_values
    FROM ${table} t LEFT JOIN json_each(t.${jsonColumn}) j
    GROUP BY t.season ORDER BY t.season`);
  const variables = safe(`SELECT DISTINCT j.key variable FROM ${table} t,json_each(t.${jsonColumn}) j
    WHERE j.key IS NOT NULL ORDER BY j.key`).map(item => item.variable);
  const kinds = kind && columns.includes(kind)
    ? safe(`SELECT ${kind} kind,COUNT(*) rows,COUNT(DISTINCT season) seasons FROM ${table} GROUP BY ${kind}`) : [];
  return { id, table, entity, available: true, variables: variables.length,
    variable_names: variables, rows: byYear.reduce((sum, item) => sum + Number(item.rows), 0),
    by_year: byYear, kinds };
}

function columnFamily(id, table, ignored = []) {
  if (!tableExists(table)) return { id, table, available: false, reason: 'table_missing' };
  const columns = safe(`PRAGMA table_info(${table})`).map(item => item.name)
    .filter(name => !ignored.includes(name));
  const byYear = safe(`SELECT season,COUNT(*) rows FROM ${table} GROUP BY season ORDER BY season`);
  return { id, table, available: true, variables: columns.length, variable_names: columns,
    rows: byYear.reduce((sum, item) => sum + Number(item.rows), 0), by_year: byYear };
}

export function nflFeatureCoverage() {
  const families = [
    jsonFamily('team_week_play', 'nfl_team_week_features', 'features', { entity: 'team' }),
    jsonFamily('player_week_play', 'nfl_player_week_features', 'features', { entity: 'player' }),
    jsonFamily('next_gen_stats', 'nfl_ngs', 'stats', { kind: 'kind', entity: 'player' }),
    jsonFamily('pfr_advanced', 'nfl_pfr_adv', 'stats', { kind: 'kind', entity: 'player' }),
    jsonFamily('licensed_pff', 'nfl_external_player_grades', 'facets_json', { entity: 'player' }),
    columnFamily('play_by_play', 'nfl_play_by_play', ['event_id', 'season', 'week', 'sequence', 'text']),
    columnFamily('snap_counts', 'nfl_snaps', ['season', 'week', 'player_id', 'player_name', 'team', 'position']),
    columnFamily('injury_reports', 'nfl_injuries', ['season', 'week', 'gsis_id', 'full_name', 'team']),
    columnFamily('depth_charts', 'nfl_depth', ['season', 'week', 'gsis_id', 'full_name', 'team']),
    columnFamily('formation_participation', 'nfl_play_formations', ['game_id', 'play_id', 'season', 'possession']),
    columnFamily('ftn_charting', 'nfl_play_charting', ['game_id', 'play_id', 'season', 'week']),
    columnFamily('market_and_game', 'game_lines', ['season', 'week', 'team', 'opponent', 'source', 'fetched_at'])
  ];
  const publicRaw = families.filter(item => item.available && item.id !== 'licensed_pff')
    .reduce((sum, item) => sum + item.variables, 0);
  const licensedRaw = families.find(item => item.id === 'licensed_pff')?.variables ?? 0;
  const store = weeklyFeatureStoreStatus();
  return { version: FEATURE_COVERAGE_VERSION, generated_at: new Date().toISOString(),
    raw_variables: { public: publicRaw, optional_licensed_pff: licensedRaw,
      total_when_licensed: publicRaw + licensedRaw },
    transformation_contract: { version: WEEKLY_FEATURE_STORE_VERSION,
      transforms_per_longitudinal_metric: store.transforms.length,
      note: 'Potential is never reported as populated. Frozen vector counts and coverage are the authority.' },
    frozen_feature_store: store, families,
    source_policy: {
      nflverse: 'public weekly source; source lag and HTTP failures remain visible',
      pff: 'optional licensed import only; no scraping and no fabricated grades',
      news: 'timestamped verified facts are stored separately from numeric measurements',
      missing: 'missing evidence is a flag, never a zero'
    } };
}

export function freezeFeatureCoverageSnapshot(season, week) {
  const existing = rows(`SELECT snapshot_json FROM nfl_feature_coverage_snapshots
    WHERE season=? AND week=? AND version=?`, season, week, FEATURE_COVERAGE_VERSION)[0];
  if (existing) return { existing: true, snapshot: JSON.parse(existing.snapshot_json) };
  const snapshot = nflFeatureCoverage();
  const evidenceHash = sha({ season, week, families: snapshot.families,
    raw: snapshot.raw_variables, store: snapshot.frozen_feature_store });
  run(`INSERT INTO nfl_feature_coverage_snapshots
    (season,week,version,evidence_hash,snapshot_json,created_at) VALUES (?,?,?,?,?,?)`,
  season, week, FEATURE_COVERAGE_VERSION, evidenceHash, JSON.stringify(snapshot), new Date().toISOString());
  return { existing: false, evidence_hash: evidenceHash, snapshot };
}
