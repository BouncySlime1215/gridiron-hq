/** Public rookie-data acquisition.
 *
 * Draft and combine data come from nflverse's CC-BY-4.0 release assets. The
 * join uses GSIS/PFR ids carried by the draft file; name matching is only a
 * final unambiguous fallback. Athletic percentiles are calculated within
 * position using only combine classes at or before that player's class.
 */
import { rows } from '../db/index.js';
import { parseCsv } from './nflverse.js';
import { fitRookieEvidenceModel, importRookieEvidence } from './nfl-rookies.js';
import { normalizePlayerName } from './player-identity.js';
import { recordSync } from './scheduler.js';

const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const DRAFT_URL = `${RELEASE}/draft_picks/draft_picks.csv`;
const COMBINE_URL = `${RELEASE}/combine/combine.csv`;
const COLLEGE_URL = season => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/player_stats/csv/player_stats_${season}.csv`;
const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const numeric = value => value == null || value === '' || value === 'NA' ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;

async function csv(url) {
  const response = await fetch(url, { headers: { Accept: 'text/csv' }, signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`${url.split('/').pop()} returned HTTP ${response.status}`);
  const parsed = parseCsv(await response.text());
  return parsed.records.map(record => Object.fromEntries(parsed.header.map((name, index) => [name, record[index]])));
}

const percentile = (sorted, value, higherIsBetter = true) => {
  if (!sorted?.length || !Number.isFinite(value)) return null;
  let below = 0;
  while (below < sorted.length && sorted[below] < value) below++;
  let equal = below;
  while (equal < sorted.length && sorted[equal] === value) equal++;
  const rank = (below + equal - 1) / 2;
  const p = sorted.length === 1 ? 0.5 : rank / (sorted.length - 1);
  return higherIsBetter ? p : 1 - p;
};

const METRICS = [
  ['forty', false, 0.30], ['vertical', true, 0.17], ['broad_jump', true, 0.17],
  ['cone', false, 0.14], ['shuttle', false, 0.14], ['bench', true, 0.08]
];

function playerIndexes() {
  const players = rows(`SELECT id,name,position,gsis_id FROM players`);
  const gsis = new Map(players.filter(player => player.gsis_id).map(player => [String(player.gsis_id), player]));
  const names = new Map();
  for (const player of players) {
    const key = normalizePlayerName(player.name), list = names.get(key) ?? [];
    list.push(player); names.set(key, list);
  }
  return { gsis, names };
}

export async function syncPublicRookieEvidence({ fromSeason = 2000,
  throughSeason = Number(process.env.NFL_SEASON) || new Date().getFullYear() } = {}) {
  try {
    const [draftRows, combineRows] = await Promise.all([csv(DRAFT_URL), csv(COMBINE_URL)]);
    const index = playerIndexes(), draftByPfr = new Map(), draftByNameSeason = new Map();
    const draftEvidence = [];
    for (const item of draftRows) {
      const season = Number(item.season), position = String(item.position ?? '').toUpperCase();
      if (season < fromSeason || season > throughSeason || !POSITIONS.has(position)) continue;
      const player = index.gsis.get(String(item.gsis_id))
        ?? (index.names.get(normalizePlayerName(item.pfr_player_name))?.length === 1
          ? index.names.get(normalizePlayerName(item.pfr_player_name))[0] : null);
      const link = { ...item, season, position, player };
      if (item.pfr_player_id) draftByPfr.set(String(item.pfr_player_id), link);
      draftByNameSeason.set(`${season}|${normalizePlayerName(item.pfr_player_name)}`, link);
      if (!player) continue;
      draftEvidence.push({ player_id: player.id, player_name: player.name, position,
        season, evidence_type: 'draft', college: item.college,
        values: { draft_round: numeric(item.round), draft_pick: numeric(item.pick) },
        available_at: `${season}-05-01T00:00:00Z`, source: 'nflverse draft picks',
        source_ref: `nflverse-draft:${season}:${item.pick}:${item.gsis_id || item.pfr_player_id}` });
    }

    const eligible = combineRows.map(item => ({ ...item, season: Number(item.season),
      position: String(item.pos ?? '').toUpperCase() }))
      .filter(item => item.season >= fromSeason && item.season <= throughSeason && POSITIONS.has(item.position));
    const cohorts = new Map();
    for (const position of POSITIONS) for (let season = fromSeason; season <= throughSeason; season++) {
      const prior = eligible.filter(item => item.position === position && item.season <= season);
      cohorts.set(`${position}|${season}`, Object.fromEntries(METRICS.map(([metric]) => [metric,
        prior.map(item => numeric(item[metric])).filter(Number.isFinite).sort((a, b) => a - b)])));
    }
    const combineEvidence = [];
    for (const item of eligible) {
      const draft = draftByPfr.get(String(item.pfr_id))
        ?? draftByNameSeason.get(`${item.season}|${normalizePlayerName(item.player_name)}`);
      const player = draft?.player ?? (index.names.get(normalizePlayerName(item.player_name))?.length === 1
        ? index.names.get(normalizePlayerName(item.player_name))[0] : null);
      if (!player) continue;
      const cohort = cohorts.get(`${item.position}|${item.season}`), components = [];
      const values = {};
      for (const [metric, higher, weight] of METRICS) {
        const raw = numeric(item[metric]);
        if (raw == null) continue;
        values[metric] = raw;
        const p = percentile(cohort[metric], raw, higher);
        if (p != null) components.push({ value: p, weight });
      }
      const totalWeight = components.reduce((sum, component) => sum + component.weight, 0);
      if (components.length < 2 || !totalWeight) continue;
      values.athletic_percentile = components.reduce((sum, component) => sum + component.value * component.weight, 0) / totalWeight;
      values.metrics_observed = components.length;
      combineEvidence.push({ player_id: player.id, player_name: player.name, position: item.position,
        season: item.season, evidence_type: 'combine', college: item.school,
        values, available_at: `${item.season}-03-15T00:00:00Z`, source: 'nflverse combine',
        source_ref: `nflverse-combine:${item.season}:${item.pfr_id || normalizePlayerName(item.player_name)}` });
    }
    const draft = importRookieEvidence(draftEvidence), combine = importRookieEvidence(combineEvidence);
    const preseason = syncVerifiedPreseasonRookieRoles(throughSeason);
    const result = { from_season: fromSeason, through_season: throughSeason,
      draft: { source_rows: draftRows.length, ...draft },
      combine: { source_rows: combineRows.length, ...combine }, preseason,
      sources: [DRAFT_URL, COMBINE_URL], license: 'CC-BY-4.0' };
    recordSync('nfl_rookie_public', 'ok', result);
    return result;
  } catch (error) {
    recordSync('nfl_rookie_public', 'error', error.message);
    throw error;
  }
}

/** Verified news can describe a rookie role; prose never supplies a number. */
export function syncVerifiedPreseasonRookieRoles(season) {
  const signals = rows(`SELECT s.news_id,s.player_id,s.player_name,s.role_delta,s.confidence,
      s.published_at,s.source,s.source_url,e.player_id rookie_id,e.position,e.college
    FROM nfl_news_signals s JOIN nfl_rookie_evidence e
      ON CAST(e.player_id AS TEXT)=s.player_id AND e.season=? AND e.evidence_type='draft'
    WHERE s.signal_type='role' AND s.verification_state='verified'
      AND s.published_at>=? AND s.published_at<?
    ORDER BY s.published_at`, season, `${season}-01-01T00:00:00Z`, `${season}-09-15T00:00:00Z`);
  return importRookieEvidence(signals.map(signal => ({ player_id: signal.rookie_id,
    player_name: signal.player_name, position: signal.position, college: signal.college,
    season, evidence_type: 'preseason_role',
    values: { role_percentile: Math.max(0, Math.min(1, 0.5 + Number(signal.role_delta ?? 0))),
      claim_confidence: signal.confidence },
    available_at: signal.published_at, source: signal.source,
    source_ref: `${signal.source_url ?? 'verified-news'}#news-${signal.news_id}` })));
}

export function rookieAcquisitionStatus() {
  const coverage = rows(`SELECT evidence_type,COUNT(*) rows,COUNT(DISTINCT player_id) players,
      MIN(season) first_season,MAX(season) last_season,MAX(captured_at) latest
    FROM nfl_rookie_evidence GROUP BY evidence_type ORDER BY evidence_type`);
  const season = Number(process.env.NFL_SEASON) || new Date().getFullYear();
  return {
    coverage,
    model: fitRookieEvidenceModel(season),
    automatic_public: {
      draft: { configured: true, source: DRAFT_URL, key_required: false },
      combine: { configured: true, source: COMBINE_URL, key_required: false }
    },
    backfill_available: {
      college_play_level: {
        configured: true, key_required: false,
        source_pattern: 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/player_stats/csv/player_stats_{season}.csv',
        status: 'public streaming adapter available; aggregates player production and opponent SRS without loading the full file into memory'
      }
    },
    optional_authorized: {
      cfbd: { configured: Boolean(process.env.CFBD_API_KEY), key_required: true,
        purpose: 'richer player usage, ratings and team opponent context; never required for core operation' },
      pff: { configured: Boolean(process.env.PFF_API_TOKEN), key_required: true,
        purpose: 'licensed player grades; no scraping or cookie automation' }
    }
  };
}

function csvLine(line) {
  const fields = [];
  let field = '', quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { fields.push(field); field = ''; }
    else if (char !== '\r') field += char;
  }
  fields.push(field);
  return fields;
}

async function streamCollegeRows(season, onRow) {
  const url = COLLEGE_URL(season);
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`college player stats ${season} returned HTTP ${response.status}`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let carry = '', header = null, count = 0;
  for (;;) {
    const { done, value } = await reader.read();
    carry += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = carry.split('\n'); carry = done ? '' : lines.pop();
    for (const line of lines) {
      if (!line) continue;
      if (!header) { header = csvLine(line); continue; }
      const values = csvLine(line);
      if (values.length !== header.length) continue;
      const row = Object.fromEntries(header.map((name, index) => [name, values[index]]));
      onRow(row); count++;
    }
    if (done) break;
  }
  return { url, rows: count };
}

const stat = () => ({ attempts: 0, completions: 0, pass_yards: 0, carries: 0,
  rush_yards: 0, targets: 0, receptions: 0, receiving_yards: 0, opponentWeights: new Map() });
const add = (map, key) => { if (!map.has(key)) map.set(key, stat()); return map.get(key); };
const sameSchool = (expected, actual) => {
  const a = normalizePlayerName(expected), b = normalizePlayerName(actual);
  return !a || !b || a === b || a.includes(b) || b.includes(a);
};

function opponentRatings(games) {
  const teams = new Set();
  for (const game of games.values()) { teams.add(game.team); teams.add(game.opponent); }
  let ratings = new Map([...teams].map(team => [team, 0]));
  for (let iteration = 0; iteration < 40; iteration++) {
    const sums = new Map(), counts = new Map();
    for (const game of games.values()) {
      const value = Math.max(-35, Math.min(35, game.margin)) + (ratings.get(game.opponent) ?? 0);
      sums.set(game.team, (sums.get(game.team) ?? 0) + value);
      counts.set(game.team, (counts.get(game.team) ?? 0) + 1);
    }
    const next = new Map([...teams].map(team => {
      const n = counts.get(team) ?? 0, raw = n ? (sums.get(team) ?? 0) / n : 0;
      return [team, raw * n / (n + 3)];
    }));
    const center = [...next.values()].reduce((sum, value) => sum + value, 0) / Math.max(1, next.size);
    ratings = new Map([...next].map(([team, value]) => [team, value - center]));
  }
  const sorted = [...ratings.values()].sort((a, b) => a - b);
  return { ratings, percentiles: new Map([...ratings].map(([team, value]) => [team, percentile(sorted, value, true)])) };
}

function rankWithin(list, getter) {
  const values = list.map(getter).filter(Number.isFinite).sort((a, b) => a - b);
  return value => percentile(values, value, true);
}

async function collegeSeasonEvidence(season) {
  const draftSeason = season + 1;
  const candidates = rows(`SELECT player_id,player_name,position,college FROM nfl_rookie_evidence
    WHERE season=? AND evidence_type='draft' AND verification_state='verified'`, draftSeason);
  const byName = new Map();
  for (const candidate of candidates) {
    const key = normalizePlayerName(candidate.player_name), list = byName.get(key) ?? [];
    list.push(candidate); byName.set(key, list);
  }
  const players = new Map(), teams = new Map(), games = new Map(), matchedTeams = new Map();
  const seenPlays = new Set();
  const source = await streamCollegeRows(season, row => {
    const gameKey = `${row.game_id}|${row.team}`;
    // Rows are chronological. Overwrite so the last play supplies the final
    // score; the first row is commonly 0-0 and is not a game outcome.
    games.set(gameKey, { team: row.team, opponent: row.opponent,
      margin: (numeric(row.team_score) ?? 0) - (numeric(row.opponent_score) ?? 0) });
    const team = add(teams, row.team);
    const event = (nameField, yardsField, kind) => {
      const name = row[nameField];
      if (!name || name === 'NA') return;
      const playKey = `${row.play_id}|${kind}|${normalizePlayerName(name)}`;
      if (seenPlays.has(playKey)) return;
      seenPlays.add(playKey);
      const candidateList = byName.get(normalizePlayerName(name)) ?? [];
      const candidate = candidateList.length === 1 && sameSchool(candidateList[0].college, row.team) ? candidateList[0] : null;
      const player = candidate ? add(players, String(candidate.player_id)) : null;
      if (candidate) matchedTeams.set(String(candidate.player_id), row.team);
      const yards = numeric(row[yardsField]) ?? 0;
      if (kind === 'completion') { team.attempts++; team.completions++; team.pass_yards += yards;
        if (player) { player.attempts++; player.completions++; player.pass_yards += yards; } }
      if (kind === 'incompletion' || kind === 'interception') { team.attempts++; if (player) player.attempts++; }
      if (kind === 'rush') { team.carries++; team.rush_yards += yards; if (player) { player.carries++; player.rush_yards += yards; } }
      if (kind === 'target') { team.targets++; if (player) player.targets++; }
      if (kind === 'reception') { team.receptions++; team.receiving_yards += yards;
        if (player) { player.receptions++; player.receiving_yards += yards; } }
      if (player && ['completion','incompletion','interception','rush','target'].includes(kind)) {
        player.opponentWeights.set(row.opponent, (player.opponentWeights.get(row.opponent) ?? 0) + 1);
      }
    };
    event('completion_player', 'completion_yds', 'completion');
    event('incompletion_player', null, 'incompletion');
    event('interception_thrown_player', null, 'interception');
    event('rush_player', 'rush_yds', 'rush');
    // A completed target is represented by reception_player; an incomplete
    // target uses target_player. Count one target per play, never both.
    if (row.reception_player && row.reception_player !== 'NA') event('reception_player', 'reception_yds', 'target');
    else event('target_player', null, 'target');
    event('reception_player', 'reception_yds', 'reception');
  });
  const strength = opponentRatings(games), profiles = [];
  for (const candidate of candidates) {
    const player = players.get(String(candidate.player_id)), teamName = matchedTeams.get(String(candidate.player_id));
    const team = teamName ? teams.get(teamName) : null;
    if (!player || !team) continue;
    const position = candidate.position;
    const volume = position === 'QB' ? player.attempts / Math.max(1, team.attempts)
      : position === 'RB' ? 0.7 * player.carries / Math.max(1, team.carries) + 0.3 * player.targets / Math.max(1, team.targets)
        : player.targets / Math.max(1, team.targets);
    const efficiency = position === 'QB' ? player.pass_yards / Math.max(1, player.attempts)
      : position === 'RB' ? (player.rush_yards + player.receiving_yards) / Math.max(1, player.carries + player.targets)
        : player.receiving_yards / Math.max(1, player.targets);
    let opponentWeight = 0, opponentSum = 0;
    for (const [opponent, weight] of player.opponentWeights) {
      opponentWeight += weight; opponentSum += weight * (strength.percentiles.get(opponent) ?? 0.5);
    }
    profiles.push({ candidate, player, team: teamName, volume, efficiency,
      opponent_strength: opponentWeight ? opponentSum / opponentWeight : null });
  }
  const evidence = [];
  for (const position of POSITIONS) {
    const group = profiles.filter(profile => profile.candidate.position === position);
    const volumeRank = rankWithin(group, profile => profile.volume), efficiencyRank = rankWithin(group, profile => profile.efficiency);
    for (const profile of group) {
      const production = 0.75 * volumeRank(profile.volume) + 0.25 * efficiencyRank(profile.efficiency);
      const common = { player_id: profile.candidate.player_id, player_name: profile.candidate.player_name,
        position, season: draftSeason, college: profile.team,
        available_at: `${draftSeason}-01-20T00:00:00Z`, source: 'SportsDataverse cfbfastR player stats' };
      evidence.push({ ...common, evidence_type: 'college_production', values: {
        production_percentile: production, volume_share: profile.volume, efficiency: profile.efficiency,
        attempts: profile.player.attempts, carries: profile.player.carries, targets: profile.player.targets },
      source_ref: `${source.url}#${profile.candidate.player_id}:production` });
      evidence.push({ ...common, evidence_type: 'opponent_strength',
        values: { opponent_strength_percentile: profile.opponent_strength, method: true },
        source_ref: `${source.url}#${profile.candidate.player_id}:opponents` });
    }
  }
  return { season, draft_season: draftSeason, source_rows: source.rows, candidates: candidates.length,
    matched: profiles.length, games: games.size, imported: importRookieEvidence(evidence), source: source.url,
    method: 'play-level production shares plus 40-iteration margin SRS; opponent ratings weighted by player opportunities' };
}

export async function syncPublicCollegeEvidence({ fromSeason = 2020, throughSeason = 2025 } = {}) {
  const seasons = [];
  try {
    for (let season = fromSeason; season <= throughSeason; season++) seasons.push(await collegeSeasonEvidence(season));
    const result = { seasons, from_season: fromSeason, through_season: throughSeason,
      key_required: false, source: 'SportsDataverse cfbfastR-data' };
    recordSync('nfl_rookie_college', 'ok', result);
    return result;
  } catch (error) {
    recordSync('nfl_rookie_college', 'error', error.message);
    throw error;
  }
}

export const __test = { percentile, opponentRatings };
