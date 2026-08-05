/** Immutable pregame context snapshots for 2026 forward-shadow evaluation. */
import { db, rows, run } from '../db/index.js';
import { teamWeeks } from './nfl-pbp.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_pregame_snapshot_history (
  season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
  captured_at TEXT NOT NULL, data_cutoff TEXT NOT NULL,
  quarterback_json TEXT NOT NULL, roster_json TEXT NOT NULL,
  injuries_json TEXT NOT NULL, coaching_json TEXT NOT NULL,
  feature_coverage_json TEXT NOT NULL,
  PRIMARY KEY (season, week, team, captured_at)
)`);

const parse = value => { try { return JSON.parse(value); } catch { return null; } };

export function capturePregameSnapshots(season, week) {
  const teams = rows(`SELECT DISTINCT team FROM game_lines WHERE season=? AND week=? ORDER BY team`, season, week);
  const capturedAt = new Date().toISOString();
  let written = 0;
  for (const { team } of teams) {
    const roster = rows(`SELECT rp.espn_id,rp.name,rp.position,rp.status,rp.depth_slot,rp.depth_order,rp.fetched_at
      FROM roster_players rp JOIN nfl_teams t ON t.id=rp.team_id WHERE t.abbr=? ORDER BY rp.depth_order,rp.name`, team);
    const injuries = rows(`SELECT gsis_id,full_name,position,report_status,practice_status,injury
      FROM nfl_injuries WHERE season=? AND week=? AND team=? ORDER BY full_name`, season, week, team);
    const coaching = rows('SELECT head_coach,oc_name,dc_name,off_scheme,def_scheme FROM nfl_teams WHERE abbr=?', team)[0] ?? {};
    const qb = roster.find(p => p.position === 'QB' && (p.depth_order === 1 || /qb/i.test(p.depth_slot ?? '')))
      ?? roster.find(p => p.position === 'QB') ?? null;
    const prior = rows(`SELECT roster_json FROM nfl_pregame_snapshot_history
      WHERE team=? AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC,captured_at DESC LIMIT 1`,
      team, season, season, week)[0];
    const priorIds = new Set((parse(prior?.roster_json) ?? []).map(p => String(p.espn_id)).filter(Boolean));
    const currentIds = new Set(roster.map(p => String(p.espn_id)).filter(Boolean));
    const overlap = priorIds.size ? [...currentIds].filter(id => priorIds.has(id)).length / priorIds.size : null;
    const features = teamWeeks().filter(r => r.team === team &&
      (r.season === season ? r.week < week : r.season === season - 1));
    const cutoffs = roster.map(r => r.fetched_at).filter(Boolean);
    const quote = rows('SELECT fetched_at FROM game_lines WHERE season=? AND week=? AND team=?', season, week, team)[0]?.fetched_at;
    if (quote) cutoffs.push(quote);
    const dataCutoff = cutoffs.sort().at(-1) ?? capturedAt;
    const rosterSummary = roster.map(p => ({ espn_id: p.espn_id, name: p.name, position: p.position,
      status: p.status, depth_slot: p.depth_slot, depth_order: p.depth_order }));
    const coverage = {
      roster_rows: roster.length,
      injury_rows: injuries.length,
      prior_feature_games: features.length,
      roster_continuity: overlap == null ? null : +overlap.toFixed(4),
      production_eligible: false,
      gate: 'Forward snapshots must accumulate before QB, roster, injury, or coaching adjustments can be promoted.'
    };
    run(`INSERT INTO nfl_pregame_snapshot_history
      (season,week,team,captured_at,data_cutoff,quarterback_json,roster_json,injuries_json,coaching_json,feature_coverage_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      season, week, team, capturedAt, dataCutoff, JSON.stringify(qb), JSON.stringify(rosterSummary),
      JSON.stringify(injuries), JSON.stringify(coaching), JSON.stringify(coverage));
    written++;
  }
  return { season, week, captured_at: capturedAt, teams: written, mode: 'forward_shadow' };
}

export function pregameSnapshotFor(season, week, team) {
  const r = rows(`SELECT * FROM nfl_pregame_snapshot_history WHERE season=? AND week=? AND team=?
                  ORDER BY captured_at DESC LIMIT 1`, season, week, team)[0];
  if (!r) return null;
  return { ...r, quarterback: parse(r.quarterback_json), roster: parse(r.roster_json),
    injuries: parse(r.injuries_json), coaching: parse(r.coaching_json),
    feature_coverage: parse(r.feature_coverage_json), quarterback_json: undefined,
    roster_json: undefined, injuries_json: undefined, coaching_json: undefined, feature_coverage_json: undefined };
}

export function pregameSnapshotCoverage() {
  return rows(`SELECT season,week,COUNT(*) teams,MIN(captured_at) first_capture,MAX(captured_at) last_capture
               FROM nfl_pregame_snapshot_history GROUP BY season,week ORDER BY season DESC,week DESC`);
}
