/** Cross-season coverage audit for every input family used by the NFL engine. */
import { db, rows } from '../db/index.js';

const SEASONS = [2021, 2022, 2023, 2024, 2025];
const CORE_FEATURES = [
  'net_epa_per_play', 'off_epa_per_play', 'def_epa_per_play',
  'off_epa_neutral_wp', 'def_epa_neutral_wp',
  'off_early_down_epa', 'def_early_down_epa',
  'off_pass_epa_per_play', 'def_pass_epa_per_play',
  'off_rush_epa_per_play', 'def_rush_epa_per_play',
  'off_explosive_pass_rate', 'def_explosive_pass_rate',
  'off_pressure_epa', 'def_pressure_epa',
  'off_series_success_rate', 'def_series_success_rate',
  'off_avg_drive_start', 'def_avg_drive_start',
  'off_second_half_epa', 'def_second_half_epa'
];

const exists = table => Boolean(db.prepare(`SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?`).get(table));
const r3 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(3);

function tableCoverage(table, { team = false, note = null, modelUse = 'context' } = {}) {
  if (!exists(table)) return { id: table, model_use: modelUse, note, seasons: SEASONS.map(season => ({ season, rows: 0, weeks: 0, teams: team ? 0 : null })) };
  const teamSql = team ? ',COUNT(DISTINCT team) teams' : '';
  const found = new Map(rows(`SELECT season,COUNT(*) rows,COUNT(DISTINCT week) weeks${teamSql}
    FROM ${table} WHERE season BETWEEN 2021 AND 2025 GROUP BY season`).map(item => [item.season, item]));
  return { id: table, model_use: modelUse, note, seasons: SEASONS.map(season => {
    const item = found.get(season) ?? {};
    return { season, rows: Number(item.rows ?? 0), weeks: Number(item.weeks ?? 0), teams: team ? Number(item.teams ?? 0) : null };
  }) };
}

function featureCoverage() {
  if (!exists('nfl_team_week_features')) return { required: CORE_FEATURES,
    per_season: SEASONS.map(season => ({ season, rows: 0, required_fields: CORE_FEATURES.length,
      complete_rows: 0, field_completeness: 0, missing_fields: CORE_FEATURES.map(key => ({ key, present: 0 })) })),
    schema_match_2022: SEASONS.map(season => ({ season, matches: false, keys: 0 })) };
  const perSeason = SEASONS.map(season => {
    const featureRows = rows('SELECT features FROM nfl_team_week_features WHERE season=?', season);
    const parsed = featureRows.map(item => {
      try { return JSON.parse(item.features); } catch { return {}; }
    });
    const missing = CORE_FEATURES.map(key => ({ key,
      present: parsed.filter(item => item[key] != null && Number.isFinite(Number(item[key]))).length }))
      .filter(item => item.present !== parsed.length);
    return { season, rows: parsed.length, required_fields: CORE_FEATURES.length,
      complete_rows: parsed.filter(item => CORE_FEATURES.every(key => item[key] != null && Number.isFinite(Number(item[key])))).length,
      field_completeness: parsed.length ? r3(1 - missing.reduce((sum, item) => sum + (parsed.length - item.present), 0) /
        (parsed.length * CORE_FEATURES.length)) : 0,
      missing_fields: missing };
  });
  const keySets = SEASONS.map(season => {
    const item = rows('SELECT features FROM nfl_team_week_features WHERE season=? LIMIT 1', season)[0];
    if (!item) return { season, keys: [] };
    try { return { season, keys: Object.keys(JSON.parse(item.features)).sort() }; } catch { return { season, keys: [] }; }
  });
  const reference = keySets.find(item => item.season === 2022)?.keys ?? [];
  return { required: CORE_FEATURES, per_season: perSeason,
    schema_match_2022: keySets.map(item => ({ season: item.season,
      matches: item.keys.length === reference.length && item.keys.every((key, index) => key === reference[index]), keys: item.keys.length })) };
}

function lineCoverage() {
  if (!exists('game_lines')) return [];
  return rows(`SELECT season,COUNT(*) rows,COUNT(DISTINCT week) weeks,COUNT(DISTINCT team) teams,
      ROUND(AVG(spread IS NOT NULL),3) spread,ROUND(AVG(total IS NOT NULL),3) total,
      ROUND(AVG(spread_odds IS NOT NULL),3) spread_price,
      ROUND(AVG(open_spread IS NOT NULL),3) open_spread,
      ROUND(AVG(open_total IS NOT NULL),3) open_total,
      ROUND(AVG(team_score IS NOT NULL AND opp_score IS NOT NULL),3) settled,
      ROUND(AVG(rest_days IS NOT NULL),3) rest,
      ROUND(AVG(roof IS NOT NULL),3) roof,ROUND(AVG(surface IS NOT NULL),3) surface,
      ROUND(AVG(temp IS NOT NULL),3) temperature,ROUND(AVG(wind IS NOT NULL),3) wind
    FROM game_lines WHERE season BETWEEN 2021 AND 2025 GROUP BY season ORDER BY season`);
}

function payloadValidity() {
  const teamFeatures = SEASONS.map(season => {
    const items = exists('nfl_team_week_features')
      ? rows('SELECT features FROM nfl_team_week_features WHERE season=?', season) : [];
    let parseFailures = 0;
    const values = Object.fromEntries(CORE_FEATURES.map(key => [key, []]));
    for (const item of items) {
      let parsed; try { parsed = JSON.parse(item.features); } catch { parseFailures++; continue; }
      for (const key of CORE_FEATURES) if (parsed[key] != null && Number.isFinite(Number(parsed[key]))) values[key].push(Number(parsed[key]));
    }
    const varying = Object.entries(values).filter(([, list]) => new Set(list.map(value => value.toFixed(8))).size > 1).length;
    return { season, rows: items.length, parse_failures: parseFailures,
      finite_values: Object.values(values).reduce((sum, list) => sum + list.length, 0),
      expected_values: items.length * CORE_FEATURES.length,
      varying_fields: varying, required_fields: CORE_FEATURES.length,
      completeness: items.length ? r3(Object.values(values).reduce((sum, list) => sum + list.length, 0) /
        (items.length * CORE_FEATURES.length)) : 0,
      valid: items.length > 0 && parseFailures === 0 && varying === CORE_FEATURES.length
        && Object.values(values).every(list => list.length / items.length >= 0.97) };
  });
  const market = exists('game_lines') ? rows(`SELECT gl.season,COUNT(*) home_games,
      SUM(gl.spread IS NULL OR gl.total IS NULL OR gl.team_score IS NULL OR gl.opp_score IS NULL) invalid_rows,
      SUM(away.team IS NOT NULL AND away.opponent=gl.team AND away.home=0
        AND away.team_score=gl.opp_score AND away.opp_score=gl.team_score) reciprocal_games
    FROM game_lines gl LEFT JOIN game_lines away
      ON away.season=gl.season AND away.week=gl.week AND away.team=gl.opponent
    WHERE gl.home=1 AND gl.season BETWEEN 2021 AND 2025 GROUP BY gl.season ORDER BY gl.season`) : [];
  const snaps = exists('nfl_snaps') ? rows(`SELECT season,COUNT(*) rows,
      SUM(player IS NULL OR team IS NULL OR week IS NULL) invalid_identity,
      SUM(COALESCE(offense_snaps,0)+COALESCE(defense_snaps,0)>0) active_rows,
      COUNT(DISTINCT player) players FROM nfl_snaps
    WHERE season BETWEEN 2021 AND 2025 GROUP BY season ORDER BY season`) : [];
  const usage = exists('player_week_usage') ? rows(`SELECT season,COUNT(*) rows,
      SUM(player_id IS NULL OR week IS NULL) invalid_identity,
      SUM(COALESCE(attempts,0)+COALESCE(carries,0)+COALESCE(targets,0)>0) opportunity_rows,
      COUNT(DISTINCT player_id) players FROM player_week_usage
    WHERE season BETWEEN 2021 AND 2025 GROUP BY season ORDER BY season`) : [];
  const ngs = SEASONS.map(season => {
    const items = exists('nfl_ngs') ? rows('SELECT stats FROM nfl_ngs WHERE season=?', season) : [];
    let parseFailures = 0, numericPayloads = 0;
    for (const item of items) {
      let parsed; try { parsed = JSON.parse(item.stats); } catch { parseFailures++; continue; }
      if (Object.values(parsed).some(value => value != null && Number.isFinite(Number(value)))) numericPayloads++;
    }
    return { season, rows: items.length, parse_failures: parseFailures, numeric_payloads: numericPayloads,
      valid: items.length > 0 && parseFailures === 0 && numericPayloads / items.length >= 0.95 };
  });
  const bySeason = SEASONS.map(season => {
    const feature = teamFeatures.find(item => item.season === season);
    const line = market.find(item => item.season === season);
    const snap = snaps.find(item => item.season === season);
    const player = usage.find(item => item.season === season);
    const tracking = ngs.find(item => item.season === season);
    const checks = {
      team_features: Boolean(feature?.valid),
      market: Boolean(line && Number(line.invalid_rows) === 0 && Number(line.reciprocal_games) === Number(line.home_games)),
      snaps: Boolean(snap && Number(snap.invalid_identity) === 0 && Number(snap.active_rows) / Number(snap.rows) >= 0.7),
      usage: Boolean(player && Number(player.invalid_identity) === 0 && Number(player.opportunity_rows) / Number(player.rows) >= 0.5),
      next_gen_stats: Boolean(tracking?.valid)
    };
    return { season, valid: Object.values(checks).every(Boolean), checks };
  });
  return { by_season: bySeason, team_features: teamFeatures, market, snaps, usage, next_gen_stats: ngs };
}

function classify(feeds) {
  const byId = new Map(feeds.map(feed => [feed.id, feed]));
  const count = (id, season) => byId.get(id)?.seasons.find(item => item.season === season)?.rows ?? 0;
  const coreIds = ['nfl_team_week_features', 'nfl_player_week_features', 'game_lines',
    'nfl_snaps', 'nfl_ngs', 'player_week_usage', 'player_week_snaps'];
  const comparable = SEASONS.every(season => coreIds.every(id => count(id, season) > 0));
  return { comparable_2021_core: comparable, classes: [
    { id: 'core_game_and_player', seasons: '2021–2025', comparable,
      policy: 'Eligible for cross-season replay; required fields must be present and never imputed as zero.' },
    { id: 'injury_reports', seasons: '2023–2025', comparable: false,
      policy: 'Availability signal abstains before 2023; never interpret absence as healthy.' },
    { id: 'pfr_charting', seasons: '2024–2025', comparable: false,
      policy: 'PFR charting abstains before 2024 and is evaluated only on coverage-matched windows.' },
    { id: 'depth_snapshots', seasons: '2021–2025', comparable: true,
      policy: 'Weekly nflverse archives cover 2021–2024; timestamped live snapshots cover 2025 onward.' }
  ] };
}

export function nflDataConsistencyAudit() {
  const feeds = [
    tableCoverage('nfl_team_week_features', { team: true, modelUse: 'core game prediction' }),
    tableCoverage('nfl_player_week_features', { team: true, modelUse: 'player/game context' }),
    tableCoverage('game_lines', { team: true, modelUse: 'market and settlement' }),
    tableCoverage('nfl_snaps', { team: true, modelUse: 'player participation and injury value' }),
    tableCoverage('nfl_ngs', { team: true, modelUse: 'advanced player efficiency' }),
    tableCoverage('player_week_usage', { team: true, modelUse: 'fantasy/player opportunity' }),
    tableCoverage('player_week_snaps', { modelUse: 'fantasy/player participation' }),
    tableCoverage('nfl_pfr_adv', { team: true, modelUse: 'charted challenger', note: 'Published/local coverage begins in 2024.' }),
    tableCoverage('nfl_injuries', { team: true, modelUse: 'availability challenger', note: 'Published coverage begins in 2023.' }),
    tableCoverage('nfl_depth', { team: true, modelUse: 'roster-strength challenger',
      note: 'Weekly archives cover 2021–2024; timestamped live snapshots cover 2025 onward.' })
  ];
  const features = featureCoverage();
  const classification = classify(feeds);
  const validity = payloadValidity();
  const featureRates = features.per_season.map(item => item.field_completeness);
  const featureConsistent = featureRates.every(rate => rate >= 0.995)
    && Math.max(...featureRates) - Math.min(...featureRates) <= 0.005;
  return { generated_at: new Date().toISOString(), seasons: SEASONS,
    verdict: classification.comparable_2021_core && featureConsistent && validity.by_season.every(item => item.valid)
      ? '2021 core inputs are coverage-consistent with 2022–2025 after backfill. Later-only feeds remain isolated challengers.'
      : 'At least one core year is not coverage-consistent; cross-season promotion remains blocked.',
    features: { ...features, consistent: featureConsistent }, payload_validity: validity,
    market_fields: lineCoverage(), feeds, ...classification,
    historical_market_policy: 'Completed-game replays use the same stored spread/total field in every season. Sparse opening lines are excluded from historical model inputs; real openers remain available for live forecasts.',
    guardrails: [
      'Missing inputs abstain; they are never converted to numeric zero.',
      'Every replay reports component coverage by season.',
      'Later-only signals require coverage-matched and leave-one-season-out evaluation.',
      'No season may be removed from a headline result because it lowers performance.'
    ] };
}
