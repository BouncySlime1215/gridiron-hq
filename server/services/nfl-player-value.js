/**
 * Cutoff-safe player availability and replacement-value estimates.
 *
 * These estimates are intentionally a shadow feature. They quantify the size
 * of an availability shock using prior snap share, depth-chart role and prior
 * player efficiency, but they cannot change a production pick until their
 * source timestamps and forward calibration clear the promotion gates.
 */
import './nfl-advanced.js';
// Owns nfl_pregame_snapshot_history, which teamPlayerAvailability reads below.
// Imported for that table's creation: reaching this module through the ensemble
// rather than through a route (a detached replay worker, a script) would
// otherwise hit a missing table.
import './nfl-pregame.js';
import { rows } from '../db/index.js';

const r3 = n => n == null || !Number.isFinite(n) ? null : +n.toFixed(3);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const parse = value => { try { return JSON.parse(value); } catch { return {}; } };
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

const POSITION_VALUE = {
  QB: 4.8, T: 0.65, OT: 0.65, G: 0.55, C: 0.6, OL: 0.55,
  WR: 0.95, TE: 0.7, RB: 0.55, FB: 0.25,
  CB: 0.65, S: 0.5, DB: 0.5, DE: 0.6, EDGE: 0.7, DT: 0.4, DL: 0.45, LB: 0.55,
  K: 0.3, P: 0.15
};

function severity(reportStatus, practiceStatus, injury) {
  const x = `${reportStatus ?? ''} ${practiceStatus ?? ''} ${injury ?? ''}`.toLowerCase();
  if (/injured reserve|reserve\/|physically unable|suspend/.test(x)) return 1;
  if (/\bout\b/.test(String(reportStatus ?? '').toLowerCase())) return 1;
  if (/doubtful/.test(x)) return 0.75;
  if (/not injury related|resting player/.test(x) && !reportStatus) return 0.03;
  if (/questionable/.test(x) && /limited/.test(x)) return 0.45;
  if (/questionable/.test(x)) return 0.32;
  if (/did not participate/.test(x)) return 0.55;
  if (/limited/.test(x)) return 0.22;
  if (/full participation/.test(x)) return 0.05;
  return 0.12;
}

function priorSnaps(season, week, team, playerName) {
  const name = normalize(playerName);
  const candidates = rows(`SELECT season,week,player,offense_pct FROM nfl_snaps
    WHERE team=? AND offense_pct IS NOT NULL AND
      (season=? OR season=?) AND (season<? OR (season=? AND week<?))
    ORDER BY season DESC,week DESC`, team, season, season - 1, season, season, week)
    .filter(x => normalize(x.player) === name).slice(0, 10);
  if (!candidates.length) return { share: null, games: 0 };
  let weighted = 0, weight = 0;
  candidates.forEach((x, i) => { const w = 0.82 ** i; weighted += x.offense_pct * w; weight += w; });
  return { share: r3(weighted / weight), games: candidates.length };
}

function priorPerformance(season, week, gsisId) {
  if (!gsisId) return { games: 0, modifier: 1, summary: {} };
  const history = rows(`SELECT season,week,position,features FROM nfl_player_week_features
    WHERE player_id=? AND (season<? OR (season=? AND week<?))
      AND season>=? ORDER BY season DESC,week DESC LIMIT 12`, gsisId, season, season, week, season - 1);
  if (!history.length) return { games: 0, modifier: 1, summary: {} };
  const values = history.map(x => parse(x.features));
  const avg = key => {
    const a = values.map(x => x[key]).filter(Number.isFinite);
    return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  };
  const position = history[0].position;
  let modifier = 1;
  if (position === 'QB') modifier += clamp((avg('pass_epa_per_att') ?? 0) * 1.4, -0.3, 0.45);
  else modifier += clamp(((avg('target_share') ?? 0) + (avg('carry_share') ?? 0)) * 0.65, 0, 0.35);
  return {
    games: history.length, modifier: r3(modifier),
    summary: {
      pass_epa_per_att: r3(avg('pass_epa_per_att')),
      cpoe: r3(avg('cpoe')),
      target_share: r3(avg('target_share')),
      carry_share: r3(avg('carry_share')),
      wopr: r3(avg('wopr'))
    }
  };
}

function depthRole(season, week, team, gsisId) {
  if (!gsisId) return null;
  return rows(`SELECT season,week,pos_abb,pos_rank,pos_slot,captured FROM nfl_depth
    WHERE team=? AND gsis_id=? AND (season<? OR (season=? AND week<=?))
    ORDER BY season DESC,week DESC,captured DESC LIMIT 1`, team, gsisId, season, season, week)[0] ?? null;
}

function kickoffFor(season, week, team) {
  const g = rows('SELECT gameday,gametime FROM game_lines WHERE season=? AND week=? AND team=?', season, week, team)[0];
  if (!g?.gameday) return null;
  const time = /^\d{2}:\d{2}/.test(g.gametime ?? '') ? g.gametime : '23:59';
  const d = new Date(`${g.gameday}T${time}:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function teamPlayerAvailability(season, week, team) {
  const reports = rows(`SELECT * FROM nfl_injuries WHERE season=? AND week=? AND team=?
    ORDER BY CASE report_status WHEN 'Out' THEN 0 WHEN 'Doubtful' THEN 1 WHEN 'Questionable' THEN 2 ELSE 3 END,full_name`,
  season, week, team);
  const snapshot = rows(`SELECT captured_at,data_cutoff,feature_coverage_json FROM nfl_pregame_snapshot_history
    WHERE season=? AND week=? AND team=? ORDER BY captured_at DESC LIMIT 1`, season, week, team)[0] ?? null;
  const kickoff = kickoffFor(season, week, team);
  let identityMatches = 0, snapMatches = 0, depthMatches = 0;
  const players = reports.map(report => {
    const snaps = priorSnaps(season, week, team, report.full_name);
    const depth = depthRole(season, week, team, report.gsis_id);
    const performance = priorPerformance(season, week, report.gsis_id);
    if (report.gsis_id) identityMatches++;
    if (snaps.games) snapMatches++;
    if (depth) depthMatches++;
    const pos = report.position ?? depth?.pos_abb ?? 'UNK';
    const base = POSITION_VALUE[pos] ?? 0.3;
    const roleShare = snaps.share ?? (depth?.pos_rank ? clamp(1 / depth.pos_rank, 0.25, 1) : 0.45);
    const starterBoost = depth?.pos_rank === 1 ? 1.15 : depth?.pos_rank >= 3 ? 0.65 : 1;
    const unavailableProbability = severity(report.report_status, report.practice_status, report.injury);
    const pointImpact = base * Math.sqrt(clamp(roleShare, 0.05, 1)) * starterBoost * performance.modifier * unavailableProbability;
    return {
      gsis_id: report.gsis_id, player: report.full_name, position: pos,
      report_status: report.report_status, practice_status: report.practice_status, injury: report.injury,
      unavailable_probability: r3(unavailableProbability), prior_snap_share: snaps.share,
      prior_snap_games: snaps.games, depth_rank: depth?.pos_rank ?? null, depth_slot: depth?.pos_slot ?? null,
      prior_efficiency: performance.summary, prior_efficiency_games: performance.games,
      estimated_point_impact: r3(pointImpact),
      uncertainty: !report.gsis_id || !snaps.games ? 'high' : !depth || performance.games < 3 ? 'medium' : 'lower'
    };
  }).sort((a, b) => b.estimated_point_impact - a.estimated_point_impact);
  const burden = clamp(players.reduce((s, x) => s + (x.estimated_point_impact ?? 0), 0), 0, 9);
  const qb = players.find(x => x.position === 'QB') ?? null;
  const capturedBeforeKickoff = Boolean(snapshot?.captured_at && (!kickoff || snapshot.captured_at <= kickoff));
  const coverage = {
    injury_rows: reports.length,
    gsis_identity_rate: reports.length ? r3(identityMatches / reports.length) : null,
    prior_snap_match_rate: reports.length ? r3(snapMatches / reports.length) : null,
    depth_match_rate: reports.length ? r3(depthMatches / reports.length) : null,
    pregame_snapshot: Boolean(snapshot), captured_before_kickoff: capturedBeforeKickoff
  };
  return {
    season, week, team, estimated_points_lost: r3(burden), quarterback: qb,
    material_players: players.filter(x => x.estimated_point_impact >= 0.08).slice(0, 12), coverage,
    evidence_state: !reports.length ? 'availability_unknown' : capturedBeforeKickoff ? 'forward_observed' : 'historical_unverified_timestamp',
    production_eligible: false,
    policy: 'Shadow-only until publication timestamps, calibration and a frozen forward holdout prove incremental value.'
  };
}

export function gamePlayerAvailability(season, week, home, away) {
  const h = teamPlayerAvailability(season, week, home);
  const a = teamPlayerAvailability(season, week, away);
  return {
    home: h, away: a,
    shadow_margin_adjustment: r3((a.estimated_points_lost ?? 0) - (h.estimated_points_lost ?? 0)),
    uncertainty: [h.evidence_state, a.evidence_state].includes('availability_unknown') ? 'high'
      : h.coverage.prior_snap_match_rate < 0.7 || a.coverage.prior_snap_match_rate < 0.7 ? 'medium' : 'lower',
    production_eligible: false,
    note: 'Positive adjustment favors the home team. It is displayed for research and does not enter the production line.'
  };
}
