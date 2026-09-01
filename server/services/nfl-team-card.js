/**
 * Immutable shared team state for every NFL model.
 *
 * A prediction system becomes incoherent when the simulator, neural head,
 * injury model and explanation layer each assemble a slightly different team.
 * This module builds that state once, hashes it, and freezes it. Downstream
 * models consume the same card or fail explicitly.
 */
import crypto from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { nflKickoffDate } from './date-util.js';
import { teamRosterStrength } from './nfl-roster-strength.js';
import { teamNewsSignals } from './nfl-news-signal.js';
import { teamEventVector } from './nfl-event-archive.js';
import { buildTeamFeatureVector } from './nfl-weekly-feature-store.js';

// v2 follows the completed historical depth/team-code reconciliation. v1 cards
// remain immutable evidence of the earlier source snapshot; refreshed evidence
// must receive a new identity instead of colliding with those rows.
export const TEAM_CARD_VERSION = 'nfl-team-card-v2-reconciled-depth';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_team_cards (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT NOT NULL,
    horizon TEXT NOT NULL,
    version TEXT NOT NULL,
    cutoff TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,
    card_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (season,week,team,horizon,version)
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_team_cards_cutoff ON nfl_team_cards(cutoff,season,week);
  CREATE TRIGGER IF NOT EXISTS nfl_team_cards_no_update BEFORE UPDATE ON nfl_team_cards
    BEGIN SELECT RAISE(ABORT, 'frozen team cards are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_team_cards_no_delete BEFORE DELETE ON nfl_team_cards
    BEGIN SELECT RAISE(ABORT, 'frozen team cards are immutable'); END;
`);

const r3 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(3);
const parse = (value, fallback = {}) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
};
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function gameRow(season, week, team) {
  return rows(`SELECT season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,
      temp,wind,roof,surface,rest_days,div_game,gameday,gametime,open_spread,open_total,book_count
    FROM game_lines WHERE season=? AND week=? AND team=? LIMIT 1`, season, week, team)[0] ?? null;
}

function kickoff(game) {
  if (!game?.gameday) return null;
  return nflKickoffDate(game.gameday, game.gametime || '23:59')?.toISOString() ?? null;
}

function priorTeamFeatures(season, week, team, limit = 8) {
  return rows(`SELECT season,week,features FROM nfl_team_week_features
    WHERE team=? AND (season<? OR (season=? AND week<?))
    ORDER BY season DESC,week DESC LIMIT ?`, team, season, season, week, limit)
    .map(item => ({ season: item.season, week: item.week, ...parse(item.features) }));
}

function weighted(values, key) {
  const usable = values.map((item, index) => ({ value: Number(item[key]), weight: 0.82 ** index }))
    .filter(item => Number.isFinite(item.value));
  const total = usable.reduce((sum, item) => sum + item.weight, 0);
  return total ? r3(usable.reduce((sum, item) => sum + item.value * item.weight, 0) / total) : null;
}

const TENDENCY_FIELDS = Object.freeze([
  'off_epa_per_play', 'off_success_rate', 'off_explosive_play_rate', 'off_turnover_rate',
  'off_sack_rate', 'off_neutral_pass_rate', 'off_proe', 'off_no_huddle_rate',
  'off_plays_per_drive', 'off_seconds_per_drive', 'off_drive_td_rate', 'off_drive_fg_rate',
  'off_three_and_out_rate', 'off_third_down_rate', 'off_red_zone_td_rate',
  'def_epa_per_play', 'def_success_rate', 'def_explosive_play_rate', 'def_turnover_rate',
  'def_sack_rate', 'def_pressure_rate', 'def_third_down_rate', 'def_red_zone_td_rate'
]);

function tendencies(season, week, team) {
  const history = priorTeamFeatures(season, week, team);
  const values = Object.fromEntries(TENDENCY_FIELDS.map(key => [key, weighted(history, key)]));
  return { games: history.length, through: history[0] ? `${history[0].season}-W${history[0].week}` : null,
    values, missing: Object.entries(values).filter(([, value]) => value == null).map(([key]) => key) };
}

function injuryReport(season, week, team, cutoff) {
  const items = rows(`SELECT gsis_id,full_name,position,report_status,practice_status,injury,modified_at
    FROM nfl_injuries WHERE season=? AND week=? AND team=?
      AND (modified_at IS NULL OR modified_at<=?)
    ORDER BY CASE lower(COALESCE(report_status,''))
      WHEN 'out' THEN 1 WHEN 'doubtful' THEN 2 WHEN 'questionable' THEN 3 ELSE 4 END,full_name`,
  season, week, team, cutoff);
  return { source: 'nflverse_weekly_injury_report', cutoff, players: items.map(item => ({
    id: item.gsis_id, name: item.full_name, position: item.position,
    game_status: item.report_status, practice_status: item.practice_status, injury: item.injury,
    modified_at: item.modified_at
  })) };
}

function rosterEvents(team, cutoff) {
  try {
    return rows(`SELECT player_id,gsis_id,player_name,event_type,from_team,to_team,roster_status,
        effective_at,source,source_url,confidence
      FROM nfl_player_roster_events
      WHERE verification_state='verified' AND effective_at<=?
        AND (from_team=? OR to_team=?)
      ORDER BY effective_at DESC,id DESC LIMIT 40`, cutoff, team, team);
  } catch { return []; }
}

function coach(season, team) {
  try {
    return rows(`SELECT coach,games,fetched_at FROM nfl_team_coaches
      WHERE season=? AND team=? ORDER BY games DESC,fetched_at DESC LIMIT 1`, season, team)[0] ?? null;
  } catch { return null; }
}

function official(season, week, team, opponent, home) {
  try {
    const homeTeam = home ? team : opponent, awayTeam = home ? opponent : team;
    const gameId = `${season}_${String(week).padStart(2, '0')}_${awayTeam}_${homeTeam}`;
    const crew = rows(`SELECT name,position,official_id FROM nfl_officials
      WHERE season=? AND week=? AND game_id=? ORDER BY position,name`, season, week, gameId);
    return crew.length ? { game_id: gameId, crew } : null;
  } catch { return null; }
}

function news(team, cutoff) {
  const result = teamNewsSignals(team, { before: cutoff, maxAgeDays: 21 });
  return result ?? { evidence_state: 'feed_coverage_missing', signals: [] };
}

function rosterSummary(roster) {
  if (!roster?.available) return { available: false, reason: roster?.reason ?? 'roster unavailable' };
  return {
    available: true, roster_score: roster.roster_score, starter_score: roster.starter_score,
    depth_score: roster.depth_score, fragility: roster.fragility, unit_scores: roster.unit_scores,
    coverage: roster.coverage, cutoff_policy: roster.cutoff_policy,
    players: (roster.players ?? []).map(player => ({
      id: player.player_id, name: player.player, position: player.position, unit: player.unit,
      depth_rank: player.depth_rank, depth_slot: player.depth_slot, rating: player.rating,
      importance: player.importance, prior_snap_share: player.prior_snap_share,
      performance_score: player.performance_score, evidence_games: player.evidence_games,
      reliability: player.reliability, rookie: player.rookie, team_change: player.team_change
    }))
  };
}

function market(game) {
  if (!game) return { available: false };
  return { available: Number.isFinite(game.spread), spread: game.spread, total: game.total,
    implied_points: game.implied_points, open_spread: game.open_spread, open_total: game.open_total,
    book_count: game.book_count, source: game.source, captured_at: game.fetched_at };
}

function environment(game) {
  return { home: Boolean(game.home), temperature_f: game.temp, wind_mph: game.wind,
    roof: game.roof, surface: game.surface, rest_days: game.rest_days,
    divisional: Boolean(game.div_game), gameday: game.gameday, gametime: game.gametime };
}

export function buildTeamCard(season, week, team, { horizon = 'pregame', cutoff: requestedCutoff = null } = {}) {
  const game = gameRow(season, week, team);
  if (!game?.opponent) return { error: `schedule row unavailable for ${season} W${week} ${team}` };
  const gameKickoff = kickoff(game);
  const cutoff = requestedCutoff ?? gameKickoff;
  if (!cutoff) return { error: `kickoff unavailable for ${season} W${week} ${team}` };
  if (horizon === 'pregame' && gameKickoff && cutoff > gameKickoff) {
    return { error: `pregame cutoff ${cutoff} is after kickoff ${gameKickoff}` };
  }
  const roster = rosterSummary(teamRosterStrength(season, week, team));
  const weeklyFeatures = buildTeamFeatureVector(season, week, team);
  const card = {
    version: TEAM_CARD_VERSION, season, week, team, opponent: game.opponent, horizon, cutoff,
    schedule: environment(game), market: market(game), roster,
    weekly_feature_state: weeklyFeatures.error ? { available: false, reason: weeklyFeatures.error } : {
      available: true, version: weeklyFeatures.version, evidence_hash: weeklyFeatures.evidence_hash,
      feature_count: weeklyFeatures.feature_count, raw_metrics: weeklyFeatures.raw_metrics,
      coverage: weeklyFeatures.coverage, vector: weeklyFeatures.vector, missing: weeklyFeatures.missing
    },
    tendencies: tendencies(season, week, team), injuries: injuryReport(season, week, team, cutoff),
    verified_news: news(team, cutoff), verified_event_state: teamEventVector(team, { before: cutoff }),
    roster_events: rosterEvents(team, cutoff),
    coaching: coach(season, team), officials: official(season, week, team, game.opponent, Boolean(game.home)),
    contracts: {
      no_target_week_results: true,
      tendency_history_strictly_before_week: true,
      weekly_features_strictly_before_week: true,
      news_at_or_before_cutoff: true,
      immutable_after_freeze: true
    }
  };
  return { card, evidence_hash: hash(card) };
}

export function freezeTeamCard(season, week, team, options = {}) {
  const built = buildTeamCard(season, week, team, options);
  if (built.error) return built;
  const { card, evidence_hash: evidenceHash } = built;
  const existing = rows(`SELECT evidence_hash,card_json,cutoff FROM nfl_team_cards
    WHERE season=? AND week=? AND team=? AND horizon=? AND version=?`,
  season, week, team, card.horizon, TEAM_CARD_VERSION)[0];
  if (existing) {
    if (existing.evidence_hash !== evidenceHash) {
      return { error: 'team card conflict: the same frozen identity produced different evidence',
        existing_hash: existing.evidence_hash, candidate_hash: evidenceHash };
    }
    return { frozen: true, existing: true, evidence_hash: evidenceHash, card: parse(existing.card_json) };
  }
  run(`INSERT INTO nfl_team_cards
      (season,week,team,opponent,horizon,version,cutoff,evidence_hash,card_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, season, week, team, card.opponent, card.horizon,
  TEAM_CARD_VERSION, card.cutoff, evidenceHash, JSON.stringify(card), new Date().toISOString());
  return { frozen: true, existing: false, evidence_hash: evidenceHash, card };
}

export function getFrozenTeamCard(season, week, team, { horizon = 'pregame' } = {}) {
  const item = rows(`SELECT * FROM nfl_team_cards
    WHERE season=? AND week=? AND team=? AND horizon=? AND version=?`,
  season, week, team, horizon, TEAM_CARD_VERSION)[0];
  return item ? { ...item, card: parse(item.card_json) } : null;
}

export function matchupTeamCards(season, week, home, away, options = {}) {
  const homeCard = getFrozenTeamCard(season, week, home, options)
    ?? freezeTeamCard(season, week, home, options);
  const awayCard = getFrozenTeamCard(season, week, away, options)
    ?? freezeTeamCard(season, week, away, options);
  if (homeCard?.error || awayCard?.error) return { error: homeCard?.error ?? awayCard?.error,
    home: homeCard, away: awayCard };
  const homePayload = homeCard.card ?? homeCard, awayPayload = awayCard.card ?? awayCard;
  return { version: TEAM_CARD_VERSION, season, week, home: homePayload, away: awayPayload,
    evidence_hash: hash({ home: homeCard.evidence_hash, away: awayCard.evidence_hash }) };
}

export function backfillTeamCards({ seasons = [2021, 2022, 2023, 2024, 2025], startWeek = 5,
  endWeek = 18, onProgress = null } = {}) {
  const games = rows(`SELECT season,week,team FROM game_lines
    WHERE home=1 AND season IN (${seasons.map(() => '?').join(',')}) AND week BETWEEN ? AND ?
    ORDER BY season,week,team`, ...seasons, startWeek, endWeek);
  let frozen = 0, existing = 0;
  const failures = [];
  for (let index = 0; index < games.length; index++) {
    const game = games[index];
    for (const team of [game.team, rows(`SELECT opponent FROM game_lines
      WHERE season=? AND week=? AND team=? LIMIT 1`, game.season, game.week, game.team)[0]?.opponent]) {
      if (!team) continue;
      const result = freezeTeamCard(game.season, game.week, team);
      if (result.error) failures.push({ ...game, team, error: result.error });
      else if (result.existing) existing++;
      else frozen++;
    }
    if (onProgress && (index % 5 === 0 || index === games.length - 1)) {
      onProgress({ current: index + 1, total: games.length, frozen, existing,
        failures: failures.length, season: game.season, week: game.week, home: game.team });
    }
  }
  return { version: TEAM_CARD_VERSION, games: games.length, frozen, existing, failures,
    complete: failures.length === 0 };
}

export function teamCardCoverage() {
  return rows(`SELECT season,COUNT(*) cards,COUNT(DISTINCT team) teams,MIN(week) first_week,
      MAX(week) last_week,COUNT(DISTINCT evidence_hash) unique_cards
    FROM nfl_team_cards WHERE version=? GROUP BY season ORDER BY season`, TEAM_CARD_VERSION);
}
