/**
 * Cutoff-safe preseason and weekly roster-strength signal.
 *
 * Weekly form is sparse before Week 1, but depth charts, prior snaps, player
 * efficiency, coaching continuity and optional licensed grades still describe
 * the talent that will take the field. This module ranks the full roster and
 * compresses it into team/unit strength plus depth fragility. Current-season
 * evidence receives more recency weight as games settle, so the prior adapts
 * without ever reading the target game's outcome.
 */
import './nfl-advanced.js';
import './nfl-pbp.js';
import { db, rows, run } from '../db/index.js';
import { evidenceAdjustedRookiePrior } from './nfl-rookies.js';
import { coachChanges } from './nfl-coaches.js';
import { schemeChange } from './nfl-scheme.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_external_player_grades (
    provider TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
    team TEXT NOT NULL, player_id TEXT NOT NULL, player_name TEXT,
    position TEXT, overall_grade REAL, facets_json TEXT,
    captured_at TEXT NOT NULL, source_ref TEXT,
    PRIMARY KEY (provider,season,week,team,player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_external_player_grade_cutoff
    ON nfl_external_player_grades(provider,season,week,team);
  CREATE TABLE IF NOT EXISTS player_team_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL,
    player_name TEXT NOT NULL, from_team TEXT, to_team TEXT, detected_at TEXT NOT NULL
  );
`);

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const r2 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(2);
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const parse = value => { try { return JSON.parse(value ?? '{}'); } catch { return {}; } };

const POSITION_IMPORTANCE = {
  QB: 2.6, OT: 1.45, T: 1.45, G: 1.05, C: 1.1, WR: 1.2, TE: 0.9, RB: 0.7, FB: 0.35,
  EDGE: 1.35, DE: 1.25, DT: 0.95, NT: 0.8, LB: 0.9, ILB: 0.9, OLB: 1.0,
  CB: 1.25, S: 1.0, FS: 1.0, SS: 1.0, DB: 1.0, K: 0.45, P: 0.25, LS: 0.1
};
const DEFENSE = new Set(['EDGE', 'DE', 'DT', 'NT', 'DL', 'LB', 'ILB', 'OLB', 'CB', 'DB', 'S', 'FS', 'SS']);
const SPECIAL = new Set(['K', 'P', 'LS']);
const canonicalPosition = value => {
  const position = String(value ?? 'UNK').toUpperCase();
  if (['LT', 'RT', 'T'].includes(position)) return 'OT';
  if (['LG', 'RG', 'OG'].includes(position)) return 'G';
  if (['LILB', 'RILB', 'MLB'].includes(position)) return 'ILB';
  if (['WLB', 'SLB', 'LOLB', 'ROLB'].includes(position)) return 'OLB';
  if (['LDE', 'RDE'].includes(position)) return 'DE';
  if (['LDT', 'RDT'].includes(position)) return 'DT';
  if (['LCB', 'RCB', 'NB'].includes(position)) return 'CB';
  if (['LWR', 'RWR', 'SWR'].includes(position)) return 'WR';
  if (position === 'HB') return 'RB';
  return position;
};
const unitFor = position => SPECIAL.has(position) ? 'special_teams' : DEFENSE.has(position) ? 'defense' : 'offense';
const snapField = position => unitFor(position) === 'defense' ? 'defense_pct'
  : unitFor(position) === 'special_teams' ? 'st_pct' : 'offense_pct';

function gameCutoff(season, week, team) {
  const game = rows(`SELECT gameday FROM game_lines WHERE season=? AND week=? AND team=? LIMIT 1`, season, week, team)[0];
  return game?.gameday ? `${game.gameday}T23:59:59Z` : null;
}

function latestDepth(season, week, team) {
  const cutoff = gameCutoff(season, week, team);
  const candidates = rows(`SELECT * FROM nfl_depth WHERE team=?
    AND (season<? OR (season=? AND week<=?)) ORDER BY season DESC,week DESC,captured DESC,pos_rank`,
  team, season, season, week).filter(row => !cutoff || !row.captured || row.captured <= cutoff);
  if (!candidates.length) return [];
  const target = `${candidates[0].season}|${candidates[0].week}`;
  const seen = new Set();
  let depth = candidates.filter(row => `${row.season}|${row.week}` === target).filter(row => {
    const key = row.gsis_id || `${normalize(row.player_name)}|${row.pos_abb}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const currentSeason = Number(process.env.NFL_SEASON) || new Date().getFullYear();
  if (season === currentSeason) {
    const current = rows(`SELECT p.gsis_id,p.name player_name,p.position pos_abb,p.depth_rank,
        p.slot_code pos_slot FROM players p JOIN nfl_teams t ON t.id=p.team_id
      WHERE t.abbr=? AND p.position!='DEF'`, team);
    const grouped = new Map();
    for (const player of current) {
      const position = canonicalPosition(player.pos_abb);
      const list = grouped.get(position) ?? []; list.push(player); grouped.set(position, list);
    }
    for (const [position, list] of grouped) {
      depth = depth.filter(player => canonicalPosition(player.pos_abb) !== position);
      list.sort((a, b) => (a.depth_rank ?? 99) - (b.depth_rank ?? 99));
      depth.push(...list.map((player, index) => ({ ...player, season, week,
        pos_rank: Math.max(Number(player.depth_rank) || 1, index + 1),
        captured: 'current_local_roster_snapshot' })));
    }
  }
  const deduped = new Map();
  for (const player of depth) {
    const key = player.gsis_id || normalize(player.player_name);
    const existing = deduped.get(key);
    if (!existing || player.captured === 'current_local_roster_snapshot') deduped.set(key, player);
  }
  return [...deduped.values()];
}

function priorSnaps(season, week, team) {
  const result = new Map();
  const history = rows(`SELECT * FROM nfl_snaps WHERE team=?
    AND (season<? OR (season=? AND week<?)) AND season>=?
    ORDER BY season DESC,week DESC`, team, season, season, week, season - 2);
  for (const row of history) {
    const key = normalize(row.player);
    const list = result.get(key) ?? [];
    if (list.length < 12) list.push(row);
    result.set(key, list);
  }
  return result;
}

function priorFeatures(season, week, playerIds) {
  const result = new Map();
  const ids = [...new Set((playerIds ?? []).filter(Boolean).map(String))];
  if (!ids.length) return result;
  for (const row of rows(`SELECT player_id,position,features,season,week FROM nfl_player_week_features
    WHERE (season<? OR (season=? AND week<?)) AND season>=?
      AND player_id IN (${ids.map(() => '?').join(',')})
    ORDER BY season DESC,week DESC`, season, season, week, season - 2, ...ids)) {
    const list = result.get(String(row.player_id)) ?? [];
    if (list.length < 10) list.push({ ...row, parsed: parse(row.features) });
    result.set(String(row.player_id), list);
  }
  return result;
}

function licensedGrades(season, week, team) {
  const all = rows(`SELECT * FROM nfl_external_player_grades WHERE provider='pff' AND team=?
    AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC,captured_at DESC`,
  team, season, season, week);
  const map = new Map();
  for (const grade of all) {
    const keys = [grade.player_id, normalize(grade.player_name)].filter(Boolean);
    for (const key of keys) if (!map.has(String(key))) map.set(String(key), grade);
  }
  return map;
}

function rookieProfiles(season) {
  try {
    const evidence = rows(`SELECT player_id,player_name name,season draft_year,
        json_extract(values_json,'$.draft_round') draft_round,
        json_extract(values_json,'$.draft_pick') draft_pick
      FROM nfl_rookie_evidence WHERE season=? AND evidence_type='draft'
        AND verification_state='verified' ORDER BY available_at DESC,id DESC`, season);
    const configuredSeason = Number(process.env.NFL_SEASON) || new Date().getFullYear();
    const fallback = season === configuredSeason ? rows(`SELECT p.id player_id,a.name,a.draft_round,a.draft_pick,a.draft_year
      FROM player_accolades a JOIN roster_players r ON r.id=a.roster_player_id
      LEFT JOIN players p ON p.espn_id=r.espn_id WHERE a.draft_year=?`, season) : [];
    const map = new Map();
    for (const item of [...evidence, ...fallback]) if (!map.has(normalize(item.name))) map.set(normalize(item.name), item);
    return map;
  } catch { return new Map(); }
}

function teamChangeProfiles(cutoff) {
  try {
    const changes = rows(`SELECT player_name,from_team,to_team,effective_at detected_at
      FROM nfl_player_roster_events
      WHERE effective_at<=? AND verification_state='verified'
        AND event_type IN ('traded','signed','claimed','waived','released')
      UNION ALL
      SELECT player_name,from_team,to_team,detected_at FROM player_team_changes
      WHERE detected_at<=?
      ORDER BY detected_at DESC`, cutoff ?? new Date().toISOString(), cutoff ?? new Date().toISOString());
    const map = new Map();
    for (const change of changes) if (!map.has(normalize(change.player_name))) {
      map.set(normalize(change.player_name), change);
    }
    return map;
  } catch { return new Map(); }
}

function weightedMean(values) {
  const usable = values.filter(item => Number.isFinite(item.value));
  const weight = usable.reduce((sum, item) => sum + item.weight, 0);
  return weight ? usable.reduce((sum, item) => sum + item.value * item.weight, 0) / weight : null;
}

function performanceScore(featureRows, position) {
  if (!featureRows?.length) return null;
  const avg = key => weightedMean(featureRows.map((row, index) => ({
    value: row.parsed[key], weight: 0.82 ** index
  })));
  let z = 0;
  if (position === 'QB') z = (avg('pass_epa_per_att') ?? 0) * 55 + (avg('cpoe') ?? 0) * 1.2;
  else if (['WR', 'TE', 'RB', 'FB'].includes(position)) {
    z = ((avg('target_share') ?? 0) + (avg('carry_share') ?? 0)) * 32
      + (avg('wopr') ?? 0) * 4;
  } else z = (avg('opportunity_share') ?? 0) * 18;
  return clamp(60 + z, 35, 95);
}

function rankPlayer(player, snapMap, featureMap, gradeMap, rookieMap, changeMap) {
  const position = canonicalPosition(player.pos_abb);
  const depthRank = Number(player.pos_rank) || 9;
  const snaps = snapMap.get(normalize(player.player_name)) ?? [];
  const snap = weightedMean(snaps.map((row, index) => ({
    value: row[snapField(position)], weight: 0.84 ** index
  })));
  const features = featureMap.get(String(player.gsis_id));
  const performance = performanceScore(features, position);
  const external = gradeMap.get(String(player.gsis_id)) ?? gradeMap.get(normalize(player.player_name));
  const rookie = rookieMap.get(normalize(player.player_name));
  const rookiePrior = rookie ? evidenceAdjustedRookiePrior({ playerId: rookie.player_id,
    season: player.season, position, draftPick: rookie.draft_pick, depthRank,
    cutoff: gameCutoff(player.season, player.week) ?? `${player.season}-09-01T00:00:00Z` }) : null;
  const rookieRating = rookiePrior ? clamp(48 + rookiePrior.opportunity_per_game * 2.1, 45, 86) : null;
  const teamChange = changeMap.get(normalize(player.player_name));
  const depthPrior = clamp(91 - 9 * (depthRank - 1), 38, 94);
  const participation = snap == null ? null : clamp(42 + snap * 52, 35, 96);
  const evidence = [
    { value: depthPrior, weight: 0.5 },
    { value: participation, weight: 0.23 },
    { value: performance, weight: 0.17 },
    { value: external?.overall_grade, weight: 0.10 }
  ];
  if (rookieRating != null) evidence.push({ value: rookieRating, weight: 0.28 });
  let rating = weightedMean(evidence);
  // A traded veteran retains skill but his new role/scheme begins less certain;
  // shrink toward league average until new-team snaps arrive.
  if (teamChange && teamChange.from_team && teamChange.to_team && teamChange.from_team !== teamChange.to_team
    && !snaps.some(row => row.season === player.season)) rating = 0.88 * rating + 0.12 * 60;
  const sample = Math.max(snaps.length, features?.length ?? 0);
  return {
    player_id: player.gsis_id ?? null, player: player.player_name, position,
    unit: unitFor(position), depth_rank: depthRank, depth_slot: player.pos_slot ?? null,
    rating: r2(rating), importance: POSITION_IMPORTANCE[position] ?? 0.55,
    prior_snap_share: r2(snap), performance_score: r2(performance),
    licensed_pff_grade: external?.overall_grade ?? null,
    rookie: rookie ? { draft_round: rookie.draft_round, draft_pick: rookie.draft_pick,
      opportunity_prior: rookiePrior } : null,
    team_change: teamChange ? { from_team: teamChange.from_team, to_team: teamChange.to_team,
      detected_at: teamChange.detected_at } : null,
    evidence_games: sample,
    reliability: external || sample >= 8 ? 'higher' : sample >= 3 ? 'medium' : 'prior-heavy'
  };
}

const cache = new Map();
export function clearRosterStrengthCache() { cache.clear(); }

export function teamRosterStrength(season, week, team) {
  const key = `${season}|${week}|${team}`;
  if (cache.has(key)) return cache.get(key);
  const chart = latestDepth(season, week, team);
  if (!chart.length) {
    const missing = { season, week, team, available: false, players: [], reason: 'no cutoff-safe depth chart' };
    cache.set(key, missing); return missing;
  }
  const snapMap = priorSnaps(season, week, team);
  const featureMap = priorFeatures(season, week, chart.map(player => player.gsis_id));
  const gradeMap = licensedGrades(season, week, team);
  const rookieMap = rookieProfiles(season);
  const changeMap = teamChangeProfiles(gameCutoff(season, week, team));
  const players = chart.map(player => rankPlayer({ ...player, season, week }, snapMap, featureMap, gradeMap, rookieMap, changeMap))
    .sort((a, b) => b.rating - a.rating);
  const byGroup = new Map();
  for (const player of players) {
    const group = `${player.unit}|${player.position}`;
    const list = byGroup.get(group) ?? []; list.push(player); byGroup.set(group, list);
  }
  const starters = players.filter(player => player.depth_rank === 1);
  const starterScore = weightedMean(starters.map(player => ({ value: player.rating, weight: player.importance })));
  const groupDepth = [...byGroup.values()].map(group => {
    const starter = group.find(player => player.depth_rank === 1) ?? group[0];
    const backup = group.find(player => player.depth_rank === 2);
    return backup ? clamp(backup.rating / Math.max(starter.rating, 1), 0, 1.1) * 100 : 25;
  });
  const depthScore = groupDepth.length ? groupDepth.reduce((sum, value) => sum + value, 0) / groupDepth.length : null;
  const unitScores = Object.fromEntries(['offense', 'defense', 'special_teams'].map(unit => [unit,
    r2(weightedMean(players.filter(player => player.unit === unit && player.depth_rank <= 2)
      .map(player => ({ value: player.rating, weight: player.importance / player.depth_rank }))))]));
  const rosterScore = starterScore == null || depthScore == null ? null : 0.78 * starterScore + 0.22 * depthScore;
  const result = {
    season, week, team, available: rosterScore != null,
    roster_score: r2(rosterScore), starter_score: r2(starterScore), depth_score: r2(depthScore),
    fragility: r2(depthScore == null ? null : 100 - depthScore), unit_scores: unitScores,
    players: players.map((player, index) => ({ ...player, team_rank: index + 1 })),
    coverage: {
      players: players.length,
      with_prior_snaps: players.filter(player => player.prior_snap_share != null).length,
      with_performance: players.filter(player => player.performance_score != null).length,
      with_licensed_pff: players.filter(player => player.licensed_pff_grade != null).length
    },
    preseason_context: {
      rookies_ranked: players.filter(player => player.rookie).length,
      team_changes_ranked: players.filter(player => player.team_change).length,
      coach_change: coachChanges(season).get(team) ?? null,
      scheme_change: schemeChange(team, season)
    },
    cutoff_policy: 'Depth snapshot before target game; snaps, player features and external grades strictly before target week.'
  };
  cache.set(key, result); return result;
}

export function rosterStrengthWeek(season, week) {
  const teams = rows(`SELECT DISTINCT team FROM game_lines WHERE season=? AND week=?
    UNION SELECT DISTINCT team FROM nfl_depth WHERE season<=? ORDER BY team`, season, week, season);
  return new Map(teams.map(({ team }) => [String(team).toUpperCase(), teamRosterStrength(season, week, team)]));
}

export function importLicensedPffGrades(items, { sourceRef = 'licensed_pff_api' } = {}) {
  let stored = 0;
  for (const item of items ?? []) {
    const grade = Number(item.overall_grade ?? item.grade ?? item.overall);
    const season = Number(item.season), week = Number(item.week);
    const team = String(item.team ?? '').toUpperCase();
    const playerId = String(item.player_id ?? item.gsis_id ?? '');
    if (!season || !week || !team || !playerId || !Number.isFinite(grade)) continue;
    run(`INSERT INTO nfl_external_player_grades
      (provider,season,week,team,player_id,player_name,position,overall_grade,facets_json,captured_at,source_ref)
      VALUES ('pff',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,season,week,team,player_id) DO UPDATE SET
      player_name=excluded.player_name,position=excluded.position,overall_grade=excluded.overall_grade,
      facets_json=excluded.facets_json,captured_at=excluded.captured_at,source_ref=excluded.source_ref`,
    season, week, team, playerId, item.player_name ?? item.name ?? null, item.position ?? null,
    grade, JSON.stringify(item.facets ?? {}), item.captured_at ?? new Date().toISOString(), sourceRef);
    stored++;
  }
  clearRosterStrengthCache();
  return { stored, provider: 'pff', source_ref: sourceRef };
}

export function pffConnectorStatus() {
  const latest = rows(`SELECT COUNT(*) rows,MAX(captured_at) latest_capture FROM nfl_external_player_grades
    WHERE provider='pff'`)[0];
  return {
    configured: Boolean(process.env.PFF_API_BASE_URL && process.env.PFF_API_TOKEN),
    licensed_rows: Number(latest?.rows ?? 0), latest_capture: latest?.latest_capture ?? null,
    mode: 'optional licensed API/import only',
    required_env: ['PFF_API_BASE_URL', 'PFF_API_TOKEN', 'PFF_PLAYER_GRADES_PATH'],
    policy: 'No scraping or browser-cookie automation. PFF data is used only through authorized API/CLI exports.'
  };
}

export async function syncLicensedPffGrades(season, week) {
  const base = process.env.PFF_API_BASE_URL, token = process.env.PFF_API_TOKEN;
  const path = process.env.PFF_PLAYER_GRADES_PATH;
  if (!base || !token || !path) throw new Error('licensed PFF connector is not configured');
  const url = new URL(path, base);
  url.searchParams.set('season', String(season)); url.searchParams.set('week', String(week));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`PFF API returned HTTP ${response.status}`);
  const payload = await response.json();
  const items = Array.isArray(payload) ? payload : payload.data ?? payload.items ?? payload.results ?? [];
  return importLicensedPffGrades(items.map(item => ({ ...item, season: item.season ?? season, week: item.week ?? week })),
    { sourceRef: url.origin });
}
