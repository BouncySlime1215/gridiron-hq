/**
 * Postgame truth packets: what actually happened, not merely the final score.
 *
 * This layer is intentionally downstream of prediction. It may classify errors
 * and create next-week training context, but it cannot rewrite a frozen pick or
 * censor a chaotic loss. Every valid final remains a label.
 */
import crypto from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { teamTrends } from './weekly-trends.js';
import { nflKickoffDate } from './date-util.js';
import { playerNewsSignal } from './nfl-news-signal.js';

export const POSTGAME_TRUTH_VERSION = 'nfl-postgame-truth-v2';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_postgame_truth_packets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
    version TEXT NOT NULL, source_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(season,week,home,version,source_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_postgame_truth_week ON nfl_postgame_truth_packets(season,week,home);
  CREATE TRIGGER IF NOT EXISTS nfl_postgame_truth_no_update BEFORE UPDATE ON nfl_postgame_truth_packets
    BEGIN SELECT RAISE(ABORT, 'postgame truth packets are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_postgame_truth_no_delete BEFORE DELETE ON nfl_postgame_truth_packets
    BEGIN SELECT RAISE(ABORT, 'postgame truth packets are immutable'); END;
`);

const r3 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(3);
const parse = value => { try { return JSON.parse(value); } catch { return {}; } };
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const playerSignature = value => {
  const parts = String(value ?? '').toLowerCase().replace(/-/g, '').replace(/[^a-z0-9 ]/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
  return parts.length ? `${parts[0][0]}${parts.slice(1).join('')}` : '';
};
const nameParts = value => {
  const parts = String(value ?? '').toLowerCase().replace(/-/g, '').replace(/[^a-z0-9 ]/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? '', surname: parts.slice(1).join('') };
};
const playerAliases = value => {
  const { first, surname } = nameParts(value);
  if (!first || !surname) return [];
  return [...new Set([`${first[0]}${surname}`, ...(first.length > 1 ? [`${first.slice(0, 2)}${surname}`] : [])])];
};
const namesMatch = (left, right) => {
  const a = nameParts(left), b = nameParts(right);
  if (!a.first || !b.first || a.surname !== b.surname) return false;
  if (a.first.length <= 2) return b.first.startsWith(a.first);
  if (b.first.length <= 2) return a.first.startsWith(b.first);
  return a.first === b.first;
};
const stablePlayerKey = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const TEAM_CODE_ALIASES = Object.freeze({ BLT: 'BAL', ARZ: 'ARI', LA: 'LAR', JAC: 'JAX', WAS: 'WSH', OAK: 'LV', SD: 'LAC' });
const canonicalTeam = value => TEAM_CODE_ALIASES[String(value ?? '').toUpperCase()] ?? String(value ?? '').toUpperCase();

function gameRows(season, week, home) {
  const game = rows(`SELECT season,week,team home,opponent away,team_score home_score,opp_score away_score,
    spread,total,temp,wind,roof,surface,rest_days,div_game,gameday,gametime FROM game_lines
    WHERE season=? AND week=? AND team=? AND home=1 LIMIT 1`, season, week, home)[0];
  if (!game || !Number.isFinite(game.home_score) || !Number.isFinite(game.away_score)) return { game, plays: [], teams: [], players: [], snaps: [] };
  // game_lines carries nflverse codes (WAS); the ESPN play log carries ESPN codes
  // (WSH). Accept either spelling on both sides, or every Washington packet is
  // silently empty — 158 of 158 were, before this.
  const pbpHome = canonicalTeam(game.home), pbpAway = canonicalTeam(game.away);
  const plays = rows(`SELECT * FROM nfl_play_by_play WHERE season=? AND week=?
    AND ((offense IN (?,?) AND defense IN (?,?)) OR (offense IN (?,?) AND defense IN (?,?)))
    ORDER BY sequence,play_id`,
  season, week, game.home, pbpHome, game.away, pbpAway, game.away, pbpAway, game.home, pbpHome);
  const teams = rows(`SELECT team,opponent,features FROM nfl_team_week_features
    WHERE season=? AND week=? AND team IN (?,?)`, season, week, game.home, game.away)
    .map(row => ({ ...row, features: parse(row.features) }));
  const players = rows(`SELECT player_id,player_name,team,opponent,position,features FROM nfl_player_week_features
    WHERE season=? AND week=? AND team IN (?,?)`, season, week, game.home, game.away)
    .map(row => ({ ...row, features: parse(row.features) }));
  const snaps = rows(`SELECT player,team,position,offense_snaps,offense_pct,defense_snaps,defense_pct,st_pct
    FROM nfl_snaps WHERE season=? AND week=? AND team IN (?,?)`, season, week, game.home, game.away);
  return { game, plays, teams, players, snaps };
}

function summarizePlayByPlay(plays, home, away) {
  // ESPN also assigns downs to punts, field goals, timeouts and administrative
  // rows. Treating every row with a down as a play inflated pace/pass-rate.
  const scrimmageTypes = new Set(['pass', 'incompletion', 'interception', 'sack', 'rush', 'fumble']);
  const scrimmage = plays.filter(play => play.offense && play.defense && scrimmageTypes.has(play.play_type));
  const byTeam = team => {
    const offense = scrimmage.filter(play => play.offense === team);
    const pass = offense.filter(play => ['pass', 'incompletion', 'interception', 'sack'].includes(play.play_type));
    const rush = offense.filter(play => play.play_type === 'rush');
    const explosives = offense.filter(play => (pass.includes(play) && play.yards_gained >= 20)
      || (rush.includes(play) && play.yards_gained >= 10));
    return { plays: offense.length, pass_plays: pass.length, rushes: rush.length,
      pass_rate: offense.length ? r3(pass.length / offense.length) : null,
      yards: offense.reduce((sum, play) => sum + (play.yards_gained ?? 0), 0),
      explosives: explosives.length, explosive_rate: offense.length ? r3(explosives.length / offense.length) : null,
      turnovers: offense.filter(play => play.is_turnover).length,
      sacks: offense.filter(play => play.play_type === 'sack').length,
      red_zone_plays: offense.filter(play => play.yards_to_endzone <= 20).length,
      third_downs: offense.filter(play => play.down === 3).length,
      fourth_downs: offense.filter(play => play.down === 4).length,
      no_huddle_rate: offense.length ? r3(offense.filter(play => play.no_huddle).length / offense.length) : null,
      shotgun_rate: offense.length ? r3(offense.filter(play => play.shotgun).length / offense.length) : null };
  };
  const challenges = plays.filter(play => /\bchalleng(?:e|ed)\b/i.test(play.text ?? '')).map(play => ({
    period: play.period, clock_seconds: play.clock_seconds, text: play.text,
    result: /reversed|overturned/i.test(play.text ?? '') ? 'reversed'
      : /upheld|stands/i.test(play.text ?? '') ? 'upheld' : 'unknown'
  }));
  const scoring = plays.filter(play => play.is_scoring).map(play => ({ period: play.period,
    clock_seconds: play.clock_seconds, offense: play.offense, play_type: play.play_type,
    yards: play.yards_gained, text: play.text }));
  const nonOffensiveScores = scoring.filter(play => /return|blocked|interception|fumble/i.test(play.text ?? ''));
  const injuryEvents = plays.filter(play => /\b(?:injur(?:y|ed)|concussion|medical cart|walked off|limped off)\b/i.test(play.text ?? ''))
    .map(play => ({ period: play.period, clock_seconds: play.clock_seconds, offense: play.offense, text: play.text })).slice(0, 20);
  const leadChanges = [];
  let priorLeader = 0;
  for (const play of plays) {
    const leader = Math.sign((play.home_score ?? 0) - (play.away_score ?? 0));
    if (leader && priorLeader && leader !== priorLeader) leadChanges.push({ period: play.period, clock_seconds: play.clock_seconds });
    if (leader) priorLeader = leader;
  }
  return { source: 'ESPN preserved play-by-play', rows: plays.length, scrimmage_plays: scrimmage.length,
    teams: { [home]: byTeam(home), [away]: byTeam(away) }, penalties: plays.filter(play => play.is_penalty).length,
    scoring_plays: scoring.length, non_offensive_scores: nonOffensiveScores, challenges,
    injury_events: injuryEvents,
    challenges_reversed: challenges.filter(item => item.result === 'reversed').length,
    lead_changes: leadChanges.length,
    high_leverage_events: plays.filter(play => play.is_turnover || play.is_scoring || /challenge/i.test(play.text ?? ''))
      .map(play => ({ period: play.period, clock_seconds: play.clock_seconds, offense: play.offense,
        turnover: Boolean(play.is_turnover), scoring: Boolean(play.is_scoring), text: play.text })).slice(0, 30) };
}

const groupFor = position => {
  const p = String(position ?? '').toUpperCase();
  if (p === 'QB') return 'QB';
  if (['RB', 'FB'].includes(p)) return 'RB';
  if (['WR'].includes(p)) return 'WR';
  if (['TE'].includes(p)) return 'TE';
  if (['T', 'G', 'C', 'OL', 'OT', 'OG'].includes(p)) return 'OL';
  if (['DE', 'DT', 'NT', 'DL', 'EDGE'].includes(p)) return 'DL';
  if (['LB', 'ILB', 'OLB'].includes(p)) return 'LB';
  if (['CB', 'DB', 'S', 'FS', 'SS'].includes(p)) return 'DB';
  return ['K', 'P', 'LS'].includes(p) ? 'ST' : (p || 'OTHER');
};

function playerImpact(player) {
  const f = player.features;
  const passEpa = Number.isFinite(f.pass_epa_per_att) ? f.pass_epa_per_att * (f.pass_attempts ?? 0) : 0;
  const rushEpa = Number.isFinite(f.rush_epa_per_carry) ? f.rush_epa_per_carry * (f.carries ?? 0) : 0;
  const recEpa = Number.isFinite(f.rec_epa_per_target) ? f.rec_epa_per_target * (f.targets ?? 0) : 0;
  return passEpa + rushEpa + recEpa;
}

function playerAndGroupTruth(players, snaps, season, week) {
  // Feature rows use compact play-by-play names ("J.Goff") while nflverse
  // snaps use full names ("Jared Goff"). Join on team + position + a stable
  // first-initial/surname key, and refuse ambiguous matches.
  const snapCandidates = new Map();
  for (const snap of snaps) {
    const key = `${snap.team}|${groupFor(snap.position)}|${playerSignature(snap.player)}`;
    snapCandidates.set(key, [...(snapCandidates.get(key) ?? []), snap]);
  }
  const enriched = players.map(player => {
    const f = player.features, actualOpportunity = (f.pass_attempts ?? 0) + (f.carries ?? 0) + (f.targets ?? 0);
    const prior = rows(`SELECT week,features FROM nfl_player_week_features WHERE season=? AND player_id=? AND week<? ORDER BY week DESC LIMIT 4`,
    season, player.player_id, week).map(row => ({ week: row.week, f: parse(row.features) }));
    const priorOpportunity = prior.map(row => (row.f.pass_attempts ?? 0) + (row.f.carries ?? 0) + (row.f.targets ?? 0));
    const expectedOpportunity = median(priorOpportunity);
    const candidates = snapCandidates.get(`${player.team}|${groupFor(player.position)}|${playerSignature(player.player_name)}`) ?? [];
    const snap = candidates.length === 1 ? candidates[0] : null;
    return { player_id: player.player_id, player: player.player_name, team: player.team, position: player.position,
      group: groupFor(player.position), actual_opportunity: actualOpportunity, expected_opportunity: r3(expectedOpportunity),
      opportunity_delta: expectedOpportunity == null ? null : r3(actualOpportunity - expectedOpportunity),
      opportunity_share: f.opportunity_share ?? null, touches: f.total_touches ?? 0, targets: f.targets ?? 0,
      carries: f.carries ?? 0, total_yards: f.total_yards ?? 0, touchdowns: f.total_tds ?? 0,
      epa_contribution: r3(playerImpact(player)), wpa: f.wpa_total ?? null,
      offense_snaps: snap?.offense_snaps ?? null, defense_snaps: snap?.defense_snaps ?? null };
  });
  const groups = [];
  for (const team of new Set([...players.map(player => player.team), ...snaps.map(snap => snap.team)])) {
    for (const group of new Set([...enriched.filter(player => player.team === team).map(player => player.group),
      ...snaps.filter(snap => snap.team === team).map(snap => groupFor(snap.position))])) {
      const ps = enriched.filter(player => player.team === team && player.group === group);
      const ss = snaps.filter(snap => snap.team === team && groupFor(snap.position) === group);
      groups.push({ team, group, players: new Set([...ps.map(player => player.player), ...ss.map(snap => snap.player)]).size,
        offense_snaps: ss.reduce((sum, snap) => sum + (snap.offense_snaps ?? 0), 0),
        defense_snaps: ss.reduce((sum, snap) => sum + (snap.defense_snaps ?? 0), 0),
        opportunity: ps.reduce((sum, player) => sum + player.actual_opportunity, 0),
        yards: ps.reduce((sum, player) => sum + player.total_yards, 0),
        touchdowns: ps.reduce((sum, player) => sum + player.touchdowns, 0),
        epa_contribution: r3(ps.reduce((sum, player) => sum + (player.epa_contribution ?? 0), 0)) });
    }
  }
  const usageSurprises = enriched.filter(player => player.expected_opportunity != null && Math.abs(player.opportunity_delta) >= 5)
    .sort((a, b) => Math.abs(b.opportunity_delta) - Math.abs(a.opportunity_delta)).slice(0, 12)
    .map(player => ({ ...player, direction: player.opportunity_delta > 0 ? 'role_expanded' : 'role_contracted',
      training_state: 'candidate role change; requires next-week confirmation before structural promotion' }));
  const stars = [...enriched].sort((a, b) => Math.abs(b.epa_contribution ?? 0) - Math.abs(a.epa_contribution ?? 0)).slice(0, 10);
  return { players: enriched, position_groups: groups, usage_surprises: usageSurprises, stars };
}

const POSITION_EXIT_VALUE = Object.freeze({
  QB: 4.8, RB: 0.6, WR: 1, TE: 0.75, OL: 0.6, T: 0.75, G: 0.6, C: 0.65,
  DL: 0.55, DE: 0.7, DT: 0.5, LB: 0.65, DB: 0.65, CB: 0.75, S: 0.6,
  K: 0.3, P: 0.15, ST: 0.1
});

function phasePerformance(plays, team, fromSequence, toSequence, home) {
  const types = new Set(['pass', 'incompletion', 'interception', 'sack', 'rush', 'fumble']);
  const selected = plays.filter(play => play.sequence > fromSequence && play.sequence <= toSequence && types.has(play.play_type));
  const summarize = side => {
    const sample = selected.filter(play => side === 'offense' ? play.offense === team : play.defense === team);
    const success = sample.filter(play => {
      const gain = play.yards_gained ?? 0, distance = Math.max(1, play.distance ?? 10);
      return gain >= (play.down === 1 ? 0.4 : play.down === 2 ? 0.6 : 1) * distance;
    }).length;
    const explosive = sample.filter(play => (['pass', 'incompletion', 'interception', 'sack'].includes(play.play_type)
      ? (play.yards_gained ?? 0) >= 20 : (play.yards_gained ?? 0) >= 10)).length;
    return { plays: sample.length, yards_per_play: sample.length ? r3(sample.reduce((sum, play) => sum + (play.yards_gained ?? 0), 0) / sample.length) : null,
      success_rate: sample.length ? r3(success / sample.length) : null,
      explosive_rate: sample.length ? r3(explosive / sample.length) : null,
      turnovers: sample.filter(play => side === 'offense' ? play.is_turnover : play.is_turnover).length,
      sacks: sample.filter(play => play.play_type === 'sack').length };
  };
  const offense = summarize('offense'), defense = summarize('defense');
  const scoreAt = sequence => {
    const state = [...plays].reverse().find(play => play.sequence <= sequence
      && Number.isFinite(play.home_score) && Number.isFinite(play.away_score));
    return state ? (team === home ? state.home_score - state.away_score : state.away_score - state.home_score) : 0;
  };
  const netPoints = scoreAt(toSequence) - scoreAt(fromSequence);
  return { offense, defense,
    net_yards_per_play: Number.isFinite(offense.yards_per_play) && Number.isFinite(defense.yards_per_play)
      ? r3(offense.yards_per_play - defense.yards_per_play) : null,
    net_points: r3(netPoints),
    sample_warning: Math.min(offense.plays, defense.plays) < 12 ? 'small within-game sample; explanatory only' : null };
}

function inGameInjuryTruth(plays, snaps, playerTruth, season, week, home, away) {
  const exits = [], returns = [];
  const exitPattern = /\b([A-Z]{2,3})-([A-Z][A-Za-z.'-]+) was injured during the play/gi;
  const returnPattern = /\b([A-Z]{2,3})-([A-Z][A-Za-z.'-]+) has returned to the game/gi;
  for (const play of plays) {
    for (const [pattern, destination, kind] of [[exitPattern, exits, 'exit'], [returnPattern, returns, 'return']]) {
      pattern.lastIndex = 0;
      for (let match; (match = pattern.exec(play.text ?? ''));) destination.push({ kind,
        team: canonicalTeam(match[1]), compact_name: match[2], sequence: play.sequence,
        period: play.period, clock_seconds: play.clock_seconds, text: play.text });
    }
  }
  const snapIndex = new Map();
  for (const snap of snaps) {
    for (const alias of playerAliases(snap.player)) {
      const key = `${snap.team}|${alias}`;
      snapIndex.set(key, [...(snapIndex.get(key) ?? []), snap]);
    }
  }
  const featureIndex = new Map();
  for (const player of playerTruth.players) {
    for (const alias of playerAliases(player.player)) {
      const key = `${player.team}|${alias}`;
      featureIndex.set(key, [...(featureIndex.get(key) ?? []), player]);
    }
  }
  const maxSequence = Math.max(1, ...plays.map(play => Number(play.sequence) || 0));
  return exits.filter(exit => [home, away].includes(exit.team)).map(exit => {
    const key = `${exit.team}|${playerAliases(exit.compact_name).at(-1) ?? playerSignature(exit.compact_name)}`;
    const snapMatches = snapIndex.get(key) ?? [], featureMatches = featureIndex.get(key) ?? [];
    const snap = snapMatches.length === 1 ? snapMatches[0] : null;
    const player = featureMatches.length === 1 ? featureMatches[0] : null;
    const returned = returns.find(item => item.team === exit.team
      && namesMatch(item.compact_name, exit.compact_name) && item.sequence > exit.sequence) ?? null;
    const endSequence = returned?.sequence ?? maxSequence;
    const roleShare = Math.max(snap?.offense_pct ?? 0, snap?.defense_pct ?? 0, snap?.st_pct ?? 0);
    const position = snap?.position ?? player?.position ?? null, group = groupFor(position);
    const priorRows = player?.player_id ? rows(`SELECT features FROM nfl_player_week_features
      WHERE player_id=? AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC LIMIT 8`,
    player.player_id, season, season, week).map(row => parse(row.features)) : [];
    const priorEpa = median(priorRows.map(features => playerImpact({ features })).filter(Number.isFinite));
    const quality = priorEpa == null ? 1 : clamp(1 + priorEpa / 45, 0.75, 1.35);
    const fullLoss = r3((POSITION_EXIT_VALUE[position] ?? POSITION_EXIT_VALUE[group] ?? 0.35)
      * Math.sqrt(clamp(roleShare || 0.25, 0.05, 1)) * quality);
    const gameFractionMissed = r3(clamp((endSequence - exit.sequence) / maxSequence, 0, 1));
    const breakingPoint = !returned && (position === 'QB' || roleShare >= 0.5 || fullLoss >= 0.5);
    const carryProbability = returned ? 0.04 : breakingPoint ? 0.68 : 0.42;
    return { team: exit.team, opponent: exit.team === home ? away : home,
      player: snap?.player ?? player?.player ?? exit.compact_name, compact_name: exit.compact_name,
      player_id: player?.player_id ?? null, position, group, exit: { sequence: exit.sequence, period: exit.period,
        clock_seconds: exit.clock_seconds, text: exit.text },
      returned_in_game: Boolean(returned), return: returned ? { sequence: returned.sequence, period: returned.period,
        clock_seconds: returned.clock_seconds, text: returned.text } : null,
      role: { offense_snap_share: snap?.offense_pct ?? null, defense_snap_share: snap?.defense_pct ?? null,
        special_teams_share: snap?.st_pct ?? null, game_fraction_missed: gameFractionMissed },
      value: { prior_game_epa_contribution: r3(priorEpa), replacement_adjusted_full_loss_points: fullLoss,
        expected_next_game_impact_if_unresolved: r3(fullLoss * carryProbability), method: 'prior EPA contribution + position value + pre-exit role share' },
      breaking_point: breakingPoint,
      team_before_exit: phasePerformance(plays, exit.team, -1, exit.sequence, home),
      team_after_exit: phasePerformance(plays, exit.team, exit.sequence, endSequence, home),
      carry_forward: { state: returned ? 'cleared_in_game' : 'pending_official_availability',
        unavailable_probability: carryProbability,
        rule: returned ? 'Do not carry an absence after a documented in-game return.'
          : 'Carry into the next game until a newer official report or verified availability claim clears or updates it.' } };
  });
}

function priorTeamMeans(season, week, team) {
  const prior = rows(`SELECT features FROM nfl_team_week_features WHERE season=? AND team=? AND week<? ORDER BY week DESC LIMIT 4`,
  season, team, week).map(row => parse(row.features));
  const keys = ['off_epa_per_play', 'off_success_rate', 'off_pass_epa_per_play', 'off_rush_epa_per_play',
    'off_explosive_play_rate', 'off_turnover_rate', 'off_sack_rate', 'off_red_zone_td_rate',
    'def_epa_per_play', 'def_explosive_play_rate', 'def_turnover_rate'];
  return Object.fromEntries(keys.map(key => [key, r3(mean(prior.map(item => item[key]).filter(Number.isFinite)))]));
}

function teamActualization(teams, season, week) {
  return teams.map(team => {
    const baseline = priorTeamMeans(season, week, team.team);
    const deltas = Object.fromEntries(Object.keys(baseline).map(key => [key,
      Number.isFinite(team.features[key]) && Number.isFinite(baseline[key]) ? r3(team.features[key] - baseline[key]) : null]));
    return { team: team.team, opponent: team.opponent, actual: team.features, prior_four_mean: baseline, delta: deltas,
      trends: teamTrends(team.team, season, { throughWeek: week, lookback: 3 }),
      policy: 'One-game deltas are error context only. Only multiplicity-corrected multi-week trends may become candidate features.' };
  });
}

function frozenExpertComparison(season, week, home, actualResidual, expertPacket = null) {
  if (expertPacket?.experts?.length) return { evidence_class: 'current_blind_audit_week',
    experts: expertPacket.experts.map(prediction => ({ expert_id: prediction.id,
      captured_at: expertPacket.game?.evidence_cutoff ?? null, evidence_hash: expertPacket.evidence_hash,
      forecast_residual: prediction.forecast_residual, uncertainty: prediction.uncertainty,
      authority: prediction.authority, missing_reason: prediction.missing_reason,
      error: Number.isFinite(actualResidual) && Number.isFinite(prediction.forecast_residual) ? r3(prediction.forecast_residual - actualResidual) : null,
      absolute_error: Number.isFinite(actualResidual) && Number.isFinite(prediction.forecast_residual) ? r3(Math.abs(prediction.forecast_residual - actualResidual)) : null,
      direction_correct: Number.isFinite(actualResidual) && Number.isFinite(prediction.forecast_residual) && Math.abs(prediction.forecast_residual) > 1e-9
        && Math.abs(actualResidual) > 1e-9 ? Math.sign(prediction.forecast_residual) === Math.sign(actualResidual) : null })) };
  let predictions = rows(`SELECT expert_id,captured_at,evidence_hash,forecast_residual,uncertainty,authority,missing_reason
    FROM nfl_expert_forward_predictions WHERE season=? AND week=? AND home=?
      AND captured_at=(SELECT MAX(q.captured_at) FROM nfl_expert_forward_predictions q
        WHERE q.season=? AND q.week=? AND q.home=? AND q.expert_id=nfl_expert_forward_predictions.expert_id)
    ORDER BY expert_id`, season, week, home, season, week, home);
  let evidenceClass = 'forward_frozen';
  if (!predictions.length) {
    predictions = rows(`SELECT expert_id,created_at captured_at,evidence_hash,forecast_residual,uncertainty,authority,missing_reason
      FROM nfl_weekly_expert_examples WHERE season=? AND week=? AND home=?
      AND audit_run_id=(SELECT MAX(audit_run_id) FROM nfl_weekly_expert_examples WHERE season=? AND week=? AND home=?)
      ORDER BY expert_id`, season, week, home, season, week, home);
    evidenceClass = predictions.length ? 'historical_algorithmic_replay' : 'no_frozen_expert_packet';
  }
  return { evidence_class: evidenceClass, experts: predictions.map(prediction => ({ ...prediction,
    error: Number.isFinite(actualResidual) && Number.isFinite(prediction.forecast_residual) ? r3(prediction.forecast_residual - actualResidual) : null,
    absolute_error: Number.isFinite(actualResidual) && Number.isFinite(prediction.forecast_residual) ? r3(Math.abs(prediction.forecast_residual - actualResidual)) : null,
    direction_correct: Number.isFinite(actualResidual) && Number.isFinite(prediction.forecast_residual) && Math.abs(prediction.forecast_residual) > 1e-9
      && Math.abs(actualResidual) > 1e-9 ? Math.sign(prediction.forecast_residual) === Math.sign(actualResidual) : null })) };
}

function filtration({ game, pbp, teams, players, snaps }) {
  const core = teams.length === 2 && players.length > 0 && Number.isFinite(game.spread);
  const deep = pbp.scrimmage_plays >= 80 && snaps.length >= 22;
  const turnovers = Object.values(pbp.teams).reduce((sum, team) => sum + (team.turnovers ?? 0), 0);
  const explosives = Object.values(pbp.teams).reduce((sum, team) => sum + (team.explosives ?? 0), 0);
  const varianceMarkers = [
    ...(turnovers >= 4 ? [`${turnovers} turnovers`] : []),
    ...(pbp.non_offensive_scores.length ? [`${pbp.non_offensive_scores.length} non-offensive scores`] : []),
    ...(explosives >= 10 ? [`${explosives} explosive plays`] : []),
    ...(pbp.challenges_reversed >= 2 ? [`${pbp.challenges_reversed} reversed challenges`] : [])
  ];
  return { core_training_eligible: core, deep_postgame_eligible: deep,
    completeness: { reciprocal_team_features: teams.length === 2, player_feature_rows: players.length,
      market_identity: Number.isFinite(game.spread),
      snap_rows: snaps.length, play_by_play_rows: pbp.rows, scrimmage_plays: pbp.scrimmage_plays },
    variance_markers: varianceMarkers,
    sample_weight: core ? 1 : 0,
    rule: core ? 'Keep the game as a training label. Variance markers become features; they never justify deleting a loss.'
      : 'Quarantine from training because the final game lacks reciprocal team/player truth, not because of its result.',
    game_final: Number.isFinite(game.home_score) && Number.isFinite(game.away_score) };
}

export function buildPostgameTruth(season, week, home, { expertPacket = null } = {}) {
  const source = gameRows(season, week, home), { game } = source;
  if (!game || !Number.isFinite(game.home_score) || !Number.isFinite(game.away_score)) return { error: 'game is not final' };
  const pbp = summarizePlayByPlay(source.plays, game.home, game.away);
  const playerTruth = playerAndGroupTruth(source.players, source.snaps, season, week);
  const actualMargin = game.home_score - game.away_score;
  const marketMargin = Number.isFinite(game.spread) ? -game.spread : null;
  const actualResidual = marketMargin == null ? null : actualMargin - marketMargin;
  const teamTruth = teamActualization(source.teams, season, week);
  const experts = frozenExpertComparison(season, week, game.home, actualResidual, expertPacket);
  const inGameInjuries = inGameInjuryTruth(source.plays, source.snaps, playerTruth, season, week, game.home, game.away);
  const payload = {
    version: POSTGAME_TRUTH_VERSION,
    game: { ...game, actual_margin: actualMargin, actual_total: game.home_score + game.away_score,
      market_margin: marketMargin, market_residual: actualResidual },
    gameplay: pbp,
    team_actualization: teamTruth,
    player_actualization: playerTruth,
    position_groups: playerTruth.position_groups,
    usage_surprises: playerTruth.usage_surprises,
    stars: playerTruth.stars,
    in_game_injuries: inGameInjuries,
    conditions: { temperature_f: game.temp, wind_mph: game.wind, roof: game.roof, surface: game.surface,
      source: 'settled game record; compare with a preserved pregame weather vintage before attributing forecast error' },
    expert_comparison: experts
  };
  payload.filtration = filtration({ game, pbp, teams: source.teams, players: source.players, snaps: source.snaps });
  payload.source_hash = hash({ game, plays: source.plays, teams: source.teams, players: source.players, snaps: source.snaps,
    inGameInjuries,
    expertEvidence: experts.experts.map(expert => expert.evidence_hash) });
  payload.interpretation = {
      structural: teamTruth.flatMap(team => (team.trends.trends ?? []).map(trend => ({ team: team.team, ...trend }))),
      suggestive: teamTruth.flatMap(team => (team.trends.suggestive ?? []).map(trend => ({ team: team.team, ...trend }))),
    randomness: payload.filtration.variance_markers,
    warning: 'Postgame labels explain and route learning. They do not retroactively change the frozen pregame probability.'
  };
  return payload;
}

function availabilityFromReport(report) {
  if (!report) return null;
  const status = String(report.report_status ?? '').toLowerCase();
  const practice = String(report.practice_status ?? '').toLowerCase();
  if (status === 'out') return { probability: 1, state: 'confirmed_out' };
  if (status === 'doubtful') return { probability: 0.75, state: 'doubtful' };
  if (status === 'questionable') return { probability: practice.includes('full') ? 0.15 : 0.38, state: 'questionable' };
  if (practice.includes('full')) return { probability: 0.04, state: 'cleared_by_full_practice' };
  if (practice.includes('limited')) return { probability: 0.24, state: 'limited' };
  if (practice.includes('did not')) return { probability: 0.58, state: 'did_not_practice' };
  return { probability: 0.18, state: 'listed_without_final_status' };
}

function targetKickoff(season, week, team) {
  const game = rows(`SELECT gameday,gametime FROM game_lines WHERE season=? AND week=? AND team=? LIMIT 1`, season, week, team)[0];
  return game?.gameday ? nflKickoffDate(game.gameday, game.gametime || '23:59')?.toISOString() ?? null : null;
}

function carryoverForTeam(season, week, team) {
  const priorPackets = rows(`SELECT payload_json FROM nfl_postgame_truth_packets
    WHERE (home=? OR away=?) AND (season<? OR (season=? AND week<?))
    ORDER BY season DESC,week DESC,id DESC LIMIT 12`, team, team, season, season, week).map(row => parse(row.payload_json));
  const latestByPlayer = new Map();
  for (const packet of priorPackets) for (const injury of packet.in_game_injuries ?? []) {
    if (injury.team !== team) continue;
    const key = stablePlayerKey(injury.player);
    if (!latestByPlayer.has(key)) latestByPlayer.set(key, { ...injury, source_game: packet.game });
  }
  const reports = rows(`SELECT * FROM nfl_injuries WHERE season=? AND week=? AND team=?`, season, week, team);
  const cutoff = targetKickoff(season, week, team) ?? new Date().toISOString();
  const players = [];
  for (const injury of latestByPlayer.values()) {
    if (injury.returned_in_game) continue;
    const report = reports.find(item => namesMatch(item.full_name, injury.player)) ?? null;
    const reportState = availabilityFromReport(report);
    const news = playerNewsSignal(injury.player, { team, before: cutoff, maxAgeDays: 35 })?.availability ?? null;
    let probability = injury.carry_forward?.unavailable_probability ?? 0.42;
    let state = 'unresolved_from_game_exit', resolutionSource = 'postgame_play_by_play';
    if (reportState) { probability = reportState.probability; state = reportState.state; resolutionSource = 'official_weekly_report'; }
    if (news && reportState?.state !== 'confirmed_out') {
      probability = news.unavailable_probability;
      state = news.status === 'available_positive' ? 'returning' : news.status;
      resolutionSource = 'newer_verified_news';
    }
    const fullLoss = injury.value?.replacement_adjusted_full_loss_points ?? 0;
    const alreadyInRosterPacket = Boolean(report);
    players.push({ player: injury.player, position: injury.position, prior_game: injury.source_game,
      exit: injury.exit, breaking_point: injury.breaking_point, state, unavailable_probability: r3(probability),
      full_loss_points: fullLoss, expected_point_impact: r3(fullLoss * probability),
      incremental_point_impact: alreadyInRosterPacket ? 0 : r3(fullLoss * probability),
      already_in_official_roster_packet: alreadyInRosterPacket,
      resolution_source: resolutionSource, official_report: report ? { report_status: report.report_status,
        practice_status: report.practice_status, injury: report.injury } : null,
      verified_news: news ? { status: news.status, confidence: news.confidence, published_at: news.published_at,
        source: news.source, source_url: news.source_url } : null });
  }
  // A player who was officially out in the previous game can create a return
  // signal even when the play-by-play has no in-game exit to discover.
  const previousReports = rows(`SELECT * FROM nfl_injuries WHERE team=? AND report_status='Out'
    AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC LIMIT 80`, team, season, season, week);
  for (const prior of previousReports) {
    const key = stablePlayerKey(prior.full_name);
    if (players.some(player => namesMatch(player.player, prior.full_name))) continue;
    const current = reports.find(item => namesMatch(item.full_name, prior.full_name)) ?? null;
    const reportState = availabilityFromReport(current);
    const news = playerNewsSignal(prior.full_name, { team, before: cutoff, maxAgeDays: 35 })?.availability ?? null;
    const cleared = reportState?.probability <= 0.15 || news?.status === 'available_positive';
    if (!cleared) continue;
    const group = groupFor(prior.position), returnValue = r3((POSITION_EXIT_VALUE[prior.position] ?? POSITION_EXIT_VALUE[group] ?? 0.35) * 0.6);
    players.push({ player: prior.full_name, position: prior.position, prior_game: { season: prior.season, week: prior.week },
      state: 'returning', unavailable_probability: reportState?.probability ?? news?.unavailable_probability ?? 0.06,
      full_loss_points: returnValue, expected_point_impact: r3(-returnValue * (1 - (reportState?.probability ?? news?.unavailable_probability ?? 0.06))),
      incremental_point_impact: r3(-returnValue * (1 - (reportState?.probability ?? news?.unavailable_probability ?? 0.06))),
      already_in_official_roster_packet: Boolean(current), resolution_source: current ? 'official_weekly_report' : 'newer_verified_news',
      official_report: current ? { report_status: current.report_status, practice_status: current.practice_status, injury: current.injury } : null,
      verified_news: news ? { status: news.status, confidence: news.confidence, published_at: news.published_at,
        source: news.source, source_url: news.source_url } : null });
  }
  return { team, cutoff, players, expected_points: r3(players.reduce((sum, player) => sum + (player.expected_point_impact ?? 0), 0)),
    incremental_points: r3(players.reduce((sum, player) => sum + (player.incremental_point_impact ?? 0), 0)) };
}

export function gameInjuryCarryover(season, week, home, away) {
  const homeState = carryoverForTeam(season, week, home), awayState = carryoverForTeam(season, week, away);
  return { version: POSTGAME_TRUTH_VERSION, season, week, home: homeState, away: awayState,
    candidate_margin_adjustment: r3((awayState.expected_points ?? 0) - (homeState.expected_points ?? 0)),
    incremental_margin_adjustment: r3((awayState.incremental_points ?? 0) - (homeState.incremental_points ?? 0)),
    production_eligible: false,
    rule: 'Raw injury/return opinion is recorded. The coordinator learns its weight chronologically; official reports prevent double-counting the roster packet.' };
}

export function persistPostgameTruth(packet) {
  if (packet?.error) return { inserted: 0, error: packet.error };
  const result = run(`INSERT OR IGNORE INTO nfl_postgame_truth_packets
    (season,week,home,away,version,source_hash,created_at,payload_json)
    VALUES (?,?,?,?,?,?,datetime('now'),?)`, packet.game.season, packet.game.week, packet.game.home, packet.game.away,
  packet.version, packet.source_hash, JSON.stringify(packet));
  return { inserted: result.changes, source_hash: packet.source_hash };
}

export function recordPostgameTruthWeek(season, week) {
  const games = rows(`SELECT team home FROM game_lines WHERE season=? AND week=? AND home=1
    AND team_score IS NOT NULL AND opp_score IS NOT NULL ORDER BY team`, season, week);
  const results = games.map(({ home }) => {
    const packet = buildPostgameTruth(season, week, home);
    return { home, ...persistPostgameTruth(packet), filtration: packet.filtration ?? null };
  });
  return { version: POSTGAME_TRUTH_VERSION, season, week, games: games.length,
    inserted: results.reduce((sum, item) => sum + (item.inserted ?? 0), 0), results };
}

export function postgameAuditSummary(packet) {
  if (packet?.error) return packet;
  return { game: packet.game, source_hash: packet.source_hash, filtration: packet.filtration,
    gameplay: { rows: packet.gameplay.rows, scrimmage_plays: packet.gameplay.scrimmage_plays,
      penalties: packet.gameplay.penalties, scoring_plays: packet.gameplay.scoring_plays,
      challenges: packet.gameplay.challenges.length, challenges_reversed: packet.gameplay.challenges_reversed,
      non_offensive_scores: packet.gameplay.non_offensive_scores.length, lead_changes: packet.gameplay.lead_changes,
      injury_events: packet.gameplay.injury_events?.length ?? 0 },
    in_game_injuries: (packet.in_game_injuries ?? []).map(injury => ({ player: injury.player, team: injury.team,
      position: injury.position, returned_in_game: injury.returned_in_game, breaking_point: injury.breaking_point,
      expected_next_game_impact_if_unresolved: injury.value?.expected_next_game_impact_if_unresolved,
      before: injury.team_before_exit, after: injury.team_after_exit })),
    usage_surprises: packet.usage_surprises.slice(0, 8), stars: packet.stars.slice(0, 6),
    structural_trends: packet.interpretation.structural.slice(0, 8),
    expert_errors: [...packet.expert_comparison.experts].filter(expert => expert.absolute_error != null)
      .sort((a, b) => a.absolute_error - b.absolute_error).map(expert => ({ expert_id: expert.expert_id,
        forecast_residual: expert.forecast_residual, absolute_error: expert.absolute_error,
        direction_correct: expert.direction_correct })).slice(0, 12) };
}

export function postgameTruthStatus({ limit = 20 } = {}) {
  const summary = rows(`SELECT COUNT(*) packets,COUNT(DISTINCT season||'-'||week) weeks,MAX(created_at) latest
    FROM nfl_postgame_truth_packets`)[0];
  const latest = rows(`SELECT season,week,home,away,created_at,payload_json FROM nfl_postgame_truth_packets
    ORDER BY id DESC LIMIT ?`, limit).map(row => { const packet = parse(row.payload_json); return {
      season: row.season, week: row.week, home: row.home, away: row.away, created_at: row.created_at,
      training_eligible: packet.filtration?.core_training_eligible ?? false,
      deep_coverage: packet.filtration?.deep_postgame_eligible ?? false,
      variance_markers: packet.filtration?.variance_markers ?? [],
      usage_surprises: packet.usage_surprises?.length ?? 0,
      unresolved_in_game_injuries: packet.in_game_injuries?.filter(injury => !injury.returned_in_game).length ?? 0,
      structural_trends: packet.interpretation?.structural?.length ?? 0 } });
  return { version: POSTGAME_TRUTH_VERSION, packets: Number(summary?.packets ?? 0), weeks: Number(summary?.weeks ?? 0),
    latest_at: summary?.latest ?? null, latest,
    connection: 'final result + official gameplay + player/position usage + frozen expert packet → immutable truth packet → weekly learner' };
}

export const __test = { summarizePlayByPlay, playerImpact, filtration, groupFor, inGameInjuryTruth,
  availabilityFromReport, namesMatch };
