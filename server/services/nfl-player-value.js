/**
 * Cutoff-safe, roster-wide availability and replacement-value estimates.
 *
 * Value is not an injury count. It is the gap between the role/quality a player
 * supplied before this game and the next player the depth chart says will take
 * those snaps. Quarterback keeps its dedicated EPA-per-attempt replacement
 * model; every other unit uses prior offensive/defensive participation, depth
 * order and bounded prior production. All outputs remain shadow features until
 * forward ablation proves that they improve the market baseline.
 */
import './nfl-advanced.js';
import './nfl-pregame.js';
import { rows } from '../db/index.js';
import { nflKickoffDate } from './date-util.js';
import { quarterbackPicture } from './football-context.js';

const r3 = n => n == null || !Number.isFinite(n) ? null : +n.toFixed(3);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const parse = value => { try { return JSON.parse(value); } catch { return {}; } };
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const nameSignature = value => {
  const tokens = String(value ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return tokens.length >= 2 ? `${tokens[0][0]}${tokens.at(-1)}` : tokens[0] ?? '';
};

// Maximum point-scale loss for a full-role starter before the observed backup
// is credited. These establish a monotone prior, not production coefficients;
// the chronological ensemble fit must learn whether the packet adds signal.
const POSITION_VALUE = {
  QB: 4.8, T: 0.75, OT: 0.75, G: 0.6, C: 0.65, OL: 0.6,
  WR: 1.0, TE: 0.75, RB: 0.6, FB: 0.25,
  CB: 0.75, S: 0.6, FS: 0.6, SS: 0.6, DB: 0.55,
  DE: 0.7, EDGE: 0.8, DT: 0.5, NT: 0.45, DL: 0.5,
  LB: 0.65, ILB: 0.6, OLB: 0.7,
  K: 0.3, P: 0.15, LS: 0.05
};
const DEFENSE = new Set(['CB', 'S', 'FS', 'SS', 'DB', 'DE', 'EDGE', 'DT', 'NT', 'DL', 'LB', 'ILB', 'OLB']);
const SPECIAL = new Set(['K', 'P', 'LS']);

const positionGroup = position => {
  const pos = String(position ?? 'UNK').toUpperCase();
  if (['T', 'OT'].includes(pos)) return 'T';
  if (['G', 'OG'].includes(pos)) return 'G';
  if (['S', 'FS', 'SS'].includes(pos)) return 'S';
  if (['CB', 'DB'].includes(pos)) return 'CB';
  if (['DE', 'EDGE'].includes(pos)) return 'EDGE';
  if (['DT', 'NT', 'DL'].includes(pos)) return 'IDL';
  if (['LB', 'ILB', 'OLB'].includes(pos)) return 'LB';
  return pos;
};
const unitFor = position => {
  const pos = String(position ?? '').toUpperCase();
  if (SPECIAL.has(pos)) return 'special_teams';
  return DEFENSE.has(pos) ? 'defense' : 'offense';
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

function priorParticipation(season, week, team, playerName, position) {
  const name = normalize(playerName);
  const side = unitFor(position);
  const candidates = rows(`SELECT season,week,player,offense_pct,defense_pct,st_pct FROM nfl_snaps
    WHERE team=? AND (season=? OR season=?) AND (season<? OR (season=? AND week<?))
    ORDER BY season DESC,week DESC`, team, season, season - 1, season, season, week)
    .filter(x => normalize(x.player) === name).slice(0, 10);
  const pct = candidate => side === 'defense' ? candidate.defense_pct
    : side === 'special_teams' ? candidate.st_pct : candidate.offense_pct;
  const usable = candidates.map((candidate, index) => ({ value: pct(candidate), weight: 0.82 ** index }))
    .filter(candidate => Number.isFinite(candidate.value));
  if (!usable.length) return { share: null, games: 0, side, source: `${side}_snap_share_missing` };
  const weight = usable.reduce((sum, candidate) => sum + candidate.weight, 0);
  return {
    share: r3(usable.reduce((sum, candidate) => sum + candidate.value * candidate.weight, 0) / weight),
    games: usable.length, side, source: `${side}_snap_share`
  };
}

function priorPerformance(season, week, gsisId, position) {
  if (!gsisId) return { games: 0, modifier: 1, summary: {}, source: 'identity_missing' };
  const history = rows(`SELECT season,week,position,features FROM nfl_player_week_features
    WHERE player_id=? AND (season<? OR (season=? AND week<?))
      AND season>=? ORDER BY season DESC,week DESC LIMIT 12`, gsisId, season, season, week, season - 1);
  if (!history.length) return { games: 0, modifier: 1, summary: {}, source: 'individual_box_feature_unavailable' };
  const values = history.map(item => parse(item.features));
  const avg = key => {
    const available = values.map(item => item[key]).filter(Number.isFinite);
    return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
  };
  const pos = String(position ?? history[0].position ?? '').toUpperCase();
  let modifier = 1;
  if (pos === 'QB') modifier += clamp((avg('pass_epa_per_att') ?? 0) * 1.4, -0.3, 0.45);
  else if (['RB', 'WR', 'TE', 'FB'].includes(pos)) {
    modifier += clamp(((avg('target_share') ?? 0) + (avg('carry_share') ?? 0)) * 0.65, 0, 0.35);
  }
  return {
    games: history.length, modifier: r3(modifier), source: 'prior_player_play_by_play',
    summary: {
      pass_epa_per_att: r3(avg('pass_epa_per_att')), cpoe: r3(avg('cpoe')),
      target_share: r3(avg('target_share')), carry_share: r3(avg('carry_share')),
      wopr: r3(avg('wopr')), opportunity_share: r3(avg('opportunity_share'))
    }
  };
}

/** Charted and tracking features that ordinary play-by-play cannot assign to a
 * defender or receiver. Values are deliberately compressed into a bounded
 * quality multiplier; the raw summary and sample size travel with the packet
 * so the learner can later replace this prior with measured coefficients. */
function priorAdvancedPerformance(season, week, team, playerName, gsisId, position) {
  const name = normalize(playerName);
  const pfrCandidates = rows(`SELECT season,week,kind,player_name,stats FROM nfl_pfr_adv
    WHERE team=? AND (season<? OR (season=? AND week<?)) AND season>=?
    ORDER BY season DESC,week DESC`, team, season, season, week, season - 1);
  const exact = pfrCandidates.filter(item => normalize(item.player_name) === name);
  const signature = nameSignature(playerName);
  const signatureMatches = pfrCandidates.filter(item => nameSignature(item.player_name) === signature);
  const signatureNames = new Set(signatureMatches.map(item => normalize(item.player_name)));
  // PFR often abbreviates first names ("T. Smith"). A team + first-initial +
  // surname match is accepted only when it resolves to one charted identity;
  // ambiguous signatures abstain instead of attaching another player's stats.
  const pfrMatch = exact.length ? 'exact_name'
    : signature && signatureNames.size === 1 ? 'unique_team_initial_surname' : null;
  const pfr = (exact.length ? exact : pfrMatch ? signatureMatches : []).slice(0, 12);
  const ngs = gsisId ? rows(`SELECT season,week,kind,stats FROM nfl_ngs
    WHERE player_id=? AND (season<? OR (season=? AND week<?)) AND season>=?
    ORDER BY season DESC,week DESC LIMIT 12`, gsisId, season, season, week, season - 1) : [];
  const documents = [...pfr.map(item => ({ ...parse(item.stats), kind: `pfr_${item.kind}` })),
    ...ngs.map(item => ({ ...parse(item.stats), kind: `ngs_${item.kind}` }))];
  const avg = key => {
    const values = documents.map(item => item[key]).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const pos = String(position ?? '').toUpperCase();
  let modifier = 1;
  if (DEFENSE.has(pos)) {
    const pressure = avg('def_pressures'), sack = avg('def_sacks');
    const yardsPerTarget = avg('def_yards_allowed_per_tgt');
    const ratingAllowed = avg('def_passer_rating_allowed');
    const tackles = avg('def_tackles_combined'), missed = avg('def_missed_tackles');
    if (pressure != null) modifier += clamp((pressure - 1.5) * 0.035, -0.08, 0.18);
    if (sack != null) modifier += clamp((sack - 0.25) * 0.05, -0.04, 0.12);
    if (yardsPerTarget != null) modifier += clamp((7.2 - yardsPerTarget) * 0.025, -0.12, 0.12);
    if (ratingAllowed != null) modifier += clamp((92 - ratingAllowed) * 0.002, -0.1, 0.12);
    if (tackles > 0 && missed != null) modifier += clamp((0.1 - missed / tackles) * 0.45, -0.12, 0.05);
  } else if (pos === 'QB') {
    modifier += clamp((avg('completion_percentage_above_expectation') ?? 0) * 0.012, -0.16, 0.2);
    modifier += clamp((3 - (avg('passing_bad_throw_pct') ?? 3)) * 0.012, -0.1, 0.1);
  } else if (['RB', 'WR', 'TE', 'FB'].includes(pos)) {
    modifier += clamp((avg('avg_yac_above_expectation') ?? 0) * 0.045, -0.1, 0.14);
    modifier += clamp(((avg('avg_separation') ?? 2.9) - 2.9) * 0.05, -0.08, 0.12);
    modifier += clamp((5 - (avg('receiving_drop_pct') ?? 5)) * 0.01, -0.08, 0.08);
  }
  const summaryKeys = ['def_pressures', 'def_sacks', 'def_tackles_combined', 'def_missed_tackles',
    'def_yards_allowed_per_tgt', 'def_passer_rating_allowed',
    'completion_percentage_above_expectation', 'avg_time_to_throw', 'passing_bad_throw_pct',
    'avg_separation', 'avg_yac_above_expectation', 'receiving_drop_pct',
    'rush_yards_over_expected_per_att'];
  return {
    games: new Set([...pfr, ...ngs].map(item => `${item.season}|${item.week}`)).size,
    pfr_games: new Set(pfr.map(item => `${item.season}|${item.week}`)).size,
    ngs_games: new Set(ngs.map(item => `${item.season}|${item.week}`)).size,
    modifier: r3(clamp(modifier, 0.7, 1.35)),
    summary: Object.fromEntries(summaryKeys.map(key => [key, r3(avg(key))]).filter(([, value]) => value != null)),
    source: documents.length ? 'prior_pfr_charting_and_next_gen_tracking' : 'advanced_player_features_unavailable',
    identity_match: pfr.length ? pfrMatch : ngs.length ? 'gsis_id' : null
  };
}

function kickoffFor(season, week, team) {
  const game = rows('SELECT gameday,gametime FROM game_lines WHERE season=? AND week=? AND team=?', season, week, team)[0];
  if (!game?.gameday) return null;
  const time = /^\d{2}:\d{2}/.test(game.gametime ?? '') ? game.gametime : '23:59';
  return nflKickoffDate(game.gameday, time)?.toISOString() ?? null;
}

/** Latest full depth packet that existed by the target game. */
function depthChart(season, week, team, kickoff) {
  const all = rows(`SELECT season,week,team,gsis_id,player_name,pos_abb,pos_rank,pos_slot,captured
    FROM nfl_depth WHERE season=? AND week<=? AND team=? ORDER BY week DESC,captured DESC,pos_rank`,
  season, week, team).filter(player => !kickoff || !player.captured
    || String(player.captured).slice(0, 10) <= kickoff.slice(0, 10));
  if (!all.length) return [];
  const latestWeek = all[0].week;
  const seen = new Set(), out = [];
  for (const player of all) {
    if (player.week !== latestWeek) continue;
    const key = `${player.gsis_id}|${player.pos_abb}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(player);
  }
  return out;
}

function reportKey(report) {
  return report.gsis_id ? `id:${report.gsis_id}` : `name:${normalize(report.full_name)}`;
}

function playerPacket({ player, report, chart, reportsById, season, week, team, qb }) {
  const position = String(report?.position ?? player?.pos_abb ?? 'UNK').toUpperCase();
  const name = report?.full_name ?? player?.player_name ?? 'Unknown player';
  const gsisId = report?.gsis_id ?? player?.gsis_id ?? null;
  const participation = priorParticipation(season, week, team, name, position);
  const performance = priorPerformance(season, week, gsisId, position);
  const advanced = priorAdvancedPerformance(season, week, team, name, gsisId, position);
  const depthRank = player?.pos_rank ?? null;
  const roleShare = participation.share ?? (depthRank ? clamp(1 / depthRank, 0.2, 1) : 0.35);
  const starterBoost = depthRank === 1 ? 1.15 : depthRank >= 3 ? 0.65 : 1;
  const group = positionGroup(position);
  const next = chart.filter(candidate => candidate.gsis_id !== gsisId
      && positionGroup(candidate.pos_abb) === group
      && (depthRank == null || (candidate.pos_rank ?? 99) > depthRank))
    .sort((a, b) => (a.pos_rank ?? 99) - (b.pos_rank ?? 99))[0] ?? null;
  const nextParticipation = next
    ? priorParticipation(season, week, team, next.player_name, next.pos_abb) : null;
  const nextPerformance = next
    ? priorPerformance(season, week, next.gsis_id, next.pos_abb) : null;
  const nextAdvanced = next
    ? priorAdvancedPerformance(season, week, team, next.player_name, next.gsis_id, next.pos_abb) : null;
  const nextReport = next ? reportsById.get(`id:${next.gsis_id}`)
    ?? reportsById.get(`name:${normalize(next.player_name)}`) : null;
  const nextAvailable = nextReport
    ? 1 - severity(nextReport.report_status, nextReport.practice_status, nextReport.injury) : 1;
  const roleCoverage = nextParticipation?.share != null
    ? clamp(nextParticipation.share / Math.max(roleShare, 0.1), 0, 1) : next ? 0.35 : 0;
  const starterQuality = performance.modifier * advanced.modifier;
  const nextQuality = nextPerformance && nextAdvanced
    ? nextPerformance.modifier * nextAdvanced.modifier : 0.8;
  const qualityCoverage = nextPerformance
    ? clamp(nextQuality / Math.max(starterQuality, 0.5), 0.6, 1.05) : 0.8;
  const replacementCoverage = clamp(roleCoverage * qualityCoverage * nextAvailable, 0, 1);
  const base = POSITION_VALUE[position] ?? 0.35;
  const qualityModifier = clamp(performance.modifier * advanced.modifier, 0.65, 1.55);
  const unreplaced = base * Math.sqrt(clamp(roleShare, 0.05, 1)) * starterBoost * qualityModifier;
  // A proven next man can cover some, never all, of a starter's modeled value.
  // The 45% cap prevents a package player's snap share from pretending he is
  // identical to the starter he played beside.
  let fullLoss = unreplaced * (1 - 0.45 * replacementCoverage);
  let unavailableProbability = report
    ? severity(report.report_status, report.practice_status, report.injury) : 0;
  let expectedLoss = fullLoss * unavailableProbability;
  let method = 'position_role_minus_depth_replacement';

  // Preserve the stronger QB model: actual starter/backup EPA per attempt times
  // a normal passing workload, rather than the generic positional prior.
  if (position === 'QB' && report && qb?.starter
    && normalize(qb.starter.name) === normalize(name) && !qb.insufficient) {
    unavailableProbability = qb.miss_probability ?? unavailableProbability;
    expectedLoss = Math.max(0, qb.downgrade_points ?? expectedLoss);
    fullLoss = unavailableProbability > 0 ? expectedLoss / unavailableProbability : fullLoss;
    method = 'quarterback_epa_to_observed_backup';
  }

  return {
    gsis_id: gsisId, player: name, position, unit: unitFor(position),
    depth_rank: depthRank, depth_slot: player?.pos_slot ?? null,
    report_status: report?.report_status ?? null,
    practice_status: report?.practice_status ?? null,
    injury: report?.injury ?? null,
    unavailable_probability: r3(unavailableProbability),
    prior_snap_share: participation.share, prior_snap_games: participation.games,
    participation_source: participation.source,
    prior_efficiency: performance.summary, prior_efficiency_games: performance.games,
    prior_efficiency_source: performance.source,
    prior_advanced: advanced.summary, prior_advanced_games: advanced.games,
    prior_advanced_source: advanced.source, prior_advanced_identity_match: advanced.identity_match,
    quality_modifier: r3(qualityModifier),
    replacement: next ? {
      gsis_id: next.gsis_id, player: next.player_name, position: next.pos_abb,
      depth_rank: next.pos_rank, prior_snap_share: nextParticipation?.share ?? null,
      availability_probability: r3(nextAvailable), coverage: r3(replacementCoverage)
    } : null,
    full_loss_point_value: r3(fullLoss), estimated_point_impact: r3(expectedLoss),
    valuation_method: method,
    uncertainty: !gsisId || !participation.games ? 'high'
      : !next || performance.games < 3 ? 'medium' : 'lower'
  };
}

let availabilityCache = new Map();
export function clearPlayerValueCache() { availabilityCache = new Map(); }

export function teamPlayerAvailability(season, week, team) {
  const cacheKey = `${season}|${week}|${team}`;
  if (availabilityCache.has(cacheKey)) return availabilityCache.get(cacheKey);
  const reports = rows(`SELECT * FROM nfl_injuries WHERE season=? AND week=? AND team=?
    ORDER BY CASE report_status WHEN 'Out' THEN 0 WHEN 'Doubtful' THEN 1 WHEN 'Questionable' THEN 2 ELSE 3 END,full_name`,
  season, week, team);
  const snapshot = rows(`SELECT captured_at,data_cutoff,feature_coverage_json FROM nfl_pregame_snapshot_history
    WHERE season=? AND week=? AND team=? ORDER BY captured_at DESC LIMIT 1`, season, week, team)[0] ?? null;
  const kickoff = kickoffFor(season, week, team);
  const chart = depthChart(season, week, team, kickoff);
  const reportIndex = new Map();
  for (const report of reports) {
    reportIndex.set(reportKey(report), report);
    reportIndex.set(`name:${normalize(report.full_name)}`, report);
  }
  const qb = quarterbackPicture(team, season, week);
  const chartById = new Map(chart.map(player => [`id:${player.gsis_id}`, player]));
  const chartByName = new Map(chart.map(player => [`name:${normalize(player.player_name)}`, player]));
  const injuryPlayers = reports.map(report => playerPacket({
    player: chartById.get(reportKey(report)) ?? chartByName.get(`name:${normalize(report.full_name)}`) ?? null,
    report, chart, reportsById: reportIndex, season, week, team, qb
  })).sort((a, b) => b.estimated_point_impact - a.estimated_point_impact);

  // Full-team value map: starters and direct backups, including healthy players.
  // This answers “who matters if he gets hurt?” before an injury appears.
  const rosterValueChart = chart.filter(player => (player.pos_rank ?? 99) <= 2).map(player => playerPacket({
    player, report: reportIndex.get(`id:${player.gsis_id}`)
      ?? reportIndex.get(`name:${normalize(player.player_name)}`) ?? null,
    chart, reportsById: reportIndex, season, week, team, qb
  })).sort((a, b) => b.full_loss_point_value - a.full_loss_point_value);
  const rosterIds = new Set(rosterValueChart.map(player => player.gsis_id).filter(Boolean));
  for (const player of injuryPlayers) if (!player.gsis_id || !rosterIds.has(player.gsis_id)) rosterValueChart.push(player);

  const pointsByUnit = Object.fromEntries(['offense', 'defense', 'special_teams'].map(unit => [unit,
    r3(injuryPlayers.filter(player => player.unit === unit)
      .reduce((sum, player) => sum + (player.estimated_point_impact ?? 0), 0))]));
  const burden = clamp(Object.values(pointsByUnit).reduce((sum, value) => sum + (value ?? 0), 0), 0, 9);
  const capturedBeforeKickoff = Boolean(snapshot?.captured_at && (!kickoff || snapshot.captured_at <= kickoff));
  const defensiveReports = reports.filter(report => DEFENSE.has(String(report.position).toUpperCase()));
  const coverage = {
    injury_rows: reports.length, roster_players_valued: rosterValueChart.length,
    gsis_identity_rate: reports.length ? r3(reports.filter(report => report.gsis_id).length / reports.length) : null,
    prior_snap_match_rate: reports.length
      ? r3(injuryPlayers.filter(player => player.prior_snap_games).length / reports.length) : null,
    advanced_feature_match_rate: reports.length
      ? r3(injuryPlayers.filter(player => player.prior_advanced_games).length / reports.length) : null,
    defensive_snap_match_rate: defensiveReports.length
      ? r3(injuryPlayers.filter(player => player.unit === 'defense'
        && player.participation_source === 'defense_snap_share').length / defensiveReports.length) : null,
    replacement_match_rate: reports.length
      ? r3(injuryPlayers.filter(player => player.replacement).length / reports.length) : null,
    depth_match_rate: reports.length
      ? r3(injuryPlayers.filter(player => player.depth_rank != null).length / reports.length) : null,
    pregame_snapshot: Boolean(snapshot), captured_before_kickoff: capturedBeforeKickoff
  };
  const result = {
    season, week, team, estimated_points_lost: r3(burden), points_lost_by_unit: pointsByUnit,
    quarterback_model: qb,
    material_players: injuryPlayers.filter(player => player.estimated_point_impact >= 0.05).slice(0, 16),
    roster_value_chart: rosterValueChart.sort((a, b) => b.full_loss_point_value - a.full_loss_point_value).slice(0, 30),
    coverage,
    evidence_state: !reports.length ? 'availability_unknown'
      : capturedBeforeKickoff ? 'forward_observed' : 'historical_unverified_timestamp',
    production_eligible: false,
    policy: 'Roster-wide starter-to-replacement values are shadow-only until chronological ablation and frozen forward calibration prove incremental value.'
  };
  availabilityCache.set(cacheKey, result);
  return result;
}

export function gamePlayerAvailability(season, week, home, away) {
  const h = teamPlayerAvailability(season, week, home);
  const a = teamPlayerAvailability(season, week, away);
  return {
    home: h, away: a,
    shadow_margin_adjustment: r3((a.estimated_points_lost ?? 0) - (h.estimated_points_lost ?? 0)),
    unit_edges: Object.fromEntries(['offense', 'defense', 'special_teams'].map(unit => [unit,
      r3((a.points_lost_by_unit?.[unit] ?? 0) - (h.points_lost_by_unit?.[unit] ?? 0))])),
    uncertainty: [h.evidence_state, a.evidence_state].includes('availability_unknown') ? 'high'
      : h.coverage.prior_snap_match_rate < 0.7 || a.coverage.prior_snap_match_rate < 0.7 ? 'medium' : 'lower',
    production_eligible: false,
    note: 'Positive adjustment favors the home team. Values compare each player with the next depth-chart option and remain research-only.'
  };
}
