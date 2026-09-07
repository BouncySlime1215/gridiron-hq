/**
 * Player career lines: hard, multi-season, stat-rooted evidence for the draft
 * advisor. Instead of "reliable target hog" the advice can say
 * "1,000+ rec yds in 3 straight seasons · WR top-12 finish 3 of 4 years".
 *
 * Source: nfl_player_week_features (weekly play-by-play derived rows keyed by
 * the TRUE gsis_id in `player_id`). Season PPR points are rebuilt from those
 * rows with the league's PPR weights (server/services/scoring.js) — the same
 * method the ECR audit validated against ESPN's 2025 actuals at r=0.9987.
 *
 * Everything is precomputed once per process by warmCareerCache(): every
 * regular-season week for the window is aggregated per (gsis, season), then
 * positional ranks are assigned. After that, careerLine() is a Map lookup plus
 * a little arithmetic, so the board can ask for a dozen players every poll.
 *
 * Data caveats (see the report that shipped with this file):
 *  - the feature rows carry no fumble counts, so fumbles_lost is always null
 *    and points omit the -2/fumble term (ESPN's own totals include it, which is
 *    the main source of the small ours-vs-ESPN gap);
 *  - only regular-season weeks (1-18) count; playoffs are excluded on purpose.
 */
import { db, row } from '../db/index.js';
import { PPR } from './scoring.js';

export const SEASON = Number(process.env.NFL_SEASON) || 2026;

// Mirrors the DDL in nfl-pbp.js so this module works on a fresh (test) database
// without importing the play-by-play loader and its side effects.
db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_player_week_features (
    season INTEGER NOT NULL, week INTEGER NOT NULL, player_id TEXT NOT NULL,
    player_name TEXT, team TEXT, opponent TEXT, position TEXT, features TEXT NOT NULL,
    PRIMARY KEY (season, week, player_id)
  );
`);

const DEFAULT_WINDOW = 5;
const REG_SEASON_MAX_WEEK = 18;
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

/** Streak definitions: stat key on the season row -> thresholds (ascending). */
export const STREAK_STATS = Object.freeze({
  rec_yds: [1000, 1200, 1400],
  rush_yds: [1000, 1200],
  targets: [100, 130, 150],
  rec: [80, 100],
  pass_yds: [4000, 4500],
  total_td: [8, 10, 12],
  ppr_points: [200, 250, 300],
  games: [15]
});

const STAT_LABEL = {
  rec_yds: 'rec yds', rush_yds: 'rush yds', targets: 'targets', rec: 'catches',
  pass_yds: 'pass yds', total_td: 'TDs', ppr_points: 'PPR pts', games: 'games'
};

const n = v => (Number.isFinite(v) ? v : 0);

/** PPR points for one weekly feature row — identical to the audit's formula. */
export function weekPoints(f, s = PPR) {
  return n(f.passing_yards) * s.pass_yd + n(f.passing_tds) * s.pass_td + n(f.interceptions) * s.pass_int
    + n(f.rushing_yards) * s.rush_yd + n(f.rushing_tds) * s.rush_td
    + n(f.receptions) * s.rec + n(f.receiving_yards) * s.rec_yd + n(f.receiving_tds) * s.rec_td;
}

function blankSeason(season) {
  return {
    season, games: 0, ppr_points: 0, ppg: 0, pos_rank: null,
    rush_att: 0, rush_yds: 0, rush_td: 0,
    targets: 0, rec: 0, rec_yds: 0, rec_td: 0,
    pass_att: 0, pass_yds: 0, pass_td: 0, int: 0,
    fumbles_lost: null, // not present in the weekly feature rows
    total_td: 0,
    espn_points: null   // ESPN's own season total (player_season_stats), when synced
  };
}

/* ------------------------------------------------------------------ cache */

let cache = null; // { season, window, byGsis: Map<gsis, { position, seasons: Map<season, row> }> }

/**
 * Precompute per-(gsis, season) aggregates and positional ranks for the
 * `window` completed seasons before `season`. Idempotent per (season, window);
 * a request for a wider window than what is cached rebuilds.
 */
export function warmCareerCache(season = SEASON, window = DEFAULT_WINDOW) {
  season = Number(season) || SEASON;
  window = Math.max(1, Number(window) || DEFAULT_WINDOW);
  if (cache && cache.season === season && cache.window >= window) return cache;

  const t0 = performance.now();
  const first = season - window, last = season - 1;
  const byGsis = new Map();
  const perSeasonPos = new Map(); // `${season}|${pos}` -> [seasonRow]

  const stmt = db.prepare(
    `SELECT season, player_id, position, features FROM nfl_player_week_features
     WHERE season BETWEEN ? AND ? AND week BETWEEN 1 AND ?`);
  for (const r of stmt.iterate(first, last, REG_SEASON_MAX_WEEK)) {
    let f;
    try { f = JSON.parse(r.features); } catch { continue; }
    const pos = r.position === 'FB' ? 'RB' : r.position;
    let p = byGsis.get(r.player_id);
    if (!p) { p = { position: pos, positions: new Map(), seasons: new Map() }; byGsis.set(r.player_id, p); }
    p.positions.set(pos, (p.positions.get(pos) ?? 0) + 1);
    let s = p.seasons.get(r.season);
    if (!s) { s = blankSeason(r.season); s._pos = pos; p.seasons.set(r.season, s); }
    s.games++;
    s.ppr_points += weekPoints(f);
    s.rush_att += n(f.carries); s.rush_yds += n(f.rushing_yards); s.rush_td += n(f.rushing_tds);
    s.targets += n(f.targets); s.rec += n(f.receptions); s.rec_yds += n(f.receiving_yards); s.rec_td += n(f.receiving_tds);
    s.pass_att += n(f.pass_attempts); s.pass_yds += n(f.passing_yards); s.pass_td += n(f.passing_tds); s.int += n(f.interceptions);
  }

  for (const p of byGsis.values()) {
    // Position = the one the player logged the most weeks at in the newest season.
    const newest = Math.max(...p.seasons.keys());
    p.position = p.seasons.get(newest)._pos ?? p.position;
    for (const s of p.seasons.values()) {
      s.ppr_points = +s.ppr_points.toFixed(2);
      s.ppg = s.games ? +(s.ppr_points / s.games).toFixed(2) : 0;
      s.total_td = s.rush_td + s.rec_td; // non-passing TDs; pass_td is its own column
      const key = `${s.season}|${s._pos}`;
      if (!perSeasonPos.has(key)) perSeasonPos.set(key, []);
      perSeasonPos.get(key).push(s);
    }
    delete p.positions;
  }

  // Positional rank per season: by PPR points among everyone at that position
  // with >= 1 game. Ties share the higher rank.
  for (const list of perSeasonPos.values()) {
    list.sort((a, b) => b.ppr_points - a.ppr_points);
    let rank = 0;
    list.forEach((s, i) => {
      if (i === 0 || s.ppr_points !== list[i - 1].ppr_points) rank = i + 1;
      s.pos_rank = rank;
      delete s._pos;
    });
  }

  cache = { season, window, first, last, byGsis, warmed_ms: Math.round(performance.now() - t0) };
  return cache;
}

/** Test/diagnostic hook: forget the warmed aggregates. */
export function _resetCareerCache() { cache = null; }

/* --------------------------------------------------------------- lookups */

const GSIS_RE = /^\d{2}-\d{7}$/;

function resolvePlayer(playerId) {
  if (typeof playerId === 'string' && GSIS_RE.test(playerId)) {
    return { player_id: playerId, gsis_id: playerId, position: null, name: null };
  }
  const p = row(`SELECT id, name, position, gsis_id FROM players WHERE id = ?`, playerId);
  if (!p) return { player_id: playerId, gsis_id: null, position: null, name: null };
  return { player_id: p.id, gsis_id: p.gsis_id, position: p.position, name: p.name };
}

let espnStmt = null;
function espnActual(playerId, season) {
  if (typeof playerId !== 'number') return null;
  try {
    if (espnStmt === null) {
      const has = row(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='player_season_stats'`);
      espnStmt = has ? db.prepare(`SELECT fantasy_points FROM player_season_stats WHERE player_id=? AND season=? AND kind='actual'`) : false;
    }
    if (!espnStmt) return null;
    const r = espnStmt.get(playerId, season);
    return r?.fantasy_points ?? null;
  } catch { return null; }
}

/* ------------------------------------------------------------- analysis */

function computeStreaks(seasonRows, windowSeasons) {
  // seasonRows newest first; windowSeasons newest first (full window, gaps included)
  const bySeason = new Map(seasonRows.map(s => [s.season, s]));
  const out = [];
  for (const [stat, thresholds] of Object.entries(STREAK_STATS)) {
    for (const threshold of thresholds) {
      let streak = 0, broken = false, met = 0;
      const values = [];
      for (const yr of windowSeasons) {
        const s = bySeason.get(yr);
        const v = s ? s[stat] : null;
        const ok = s != null && s.games > 0 && v >= threshold;
        if (ok) met++;
        if (!broken) {
          if (ok) { streak++; values.push(v); }
          else broken = true;
        }
      }
      if (met === 0) continue;
      out.push({ stat, threshold, seasons: met, streak, consecutive: streak === met, values });
    }
  }
  return out;
}

const fmt = v => Number(v).toLocaleString('en-US');

function bestStreakPerStat(streaks) {
  // Highest threshold whose current run is >= 2, else highest threshold met >= 2 seasons.
  const best = new Map();
  for (const st of streaks) {
    const cur = best.get(st.stat);
    const score = (st.streak >= 2 ? 100 + st.streak * 10 : st.seasons >= 2 ? 50 + st.seasons * 5 : 0) + st.threshold / 1e4;
    if (!score) continue;
    if (!cur || score > cur.score) best.set(st.stat, { ...st, score });
  }
  return [...best.values()];
}

function buildHeadline(position, seasonRows, streaks, consistency, windowLen) {
  if (!seasonRows.length) return null;
  const facts = [];
  for (const st of bestStreakPerStat(streaks)) {
    if (st.stat === 'games') {
      if (st.streak >= 2) facts.push({ score: 30 + st.streak * 8, text: `${st.threshold}+ games in ${st.streak} straight seasons` });
      continue;
    }
    const label = `${fmt(st.threshold)}+ ${STAT_LABEL[st.stat]}`;
    const weight = st.stat === 'ppr_points' ? 0.8 : 1;
    if (st.streak >= 2) facts.push({ score: weight * (60 + st.streak * 15 + (STREAK_STATS[st.stat].indexOf(st.threshold) * 6)), text: `${label} in ${st.streak} straight seasons` });
    else if (st.seasons >= 2) facts.push({ score: weight * (40 + st.seasons * 8), text: `${label} in ${st.seasons} of ${windowLen} seasons` });
  }
  const yrs = consistency.seasons_counted;
  if (consistency.seasons_top12 >= 1) {
    facts.push({ score: 70 + consistency.seasons_top12 * 15, text: `${position} top-12 finish ${consistency.seasons_top12} of ${yrs} ${yrs === 1 ? 'year' : 'years'}` });
  } else if (consistency.seasons_top24 >= 1) {
    facts.push({ score: 45 + consistency.seasons_top24 * 10, text: `${position} top-24 finish ${consistency.seasons_top24} of ${yrs} ${yrs === 1 ? 'year' : 'years'}` });
  }
  if (!facts.length) {
    const s = seasonRows[0];
    return `${position}${s.pos_rank} finish in ${s.season} (${s.ppg} ppg over ${s.games} games)`;
  }
  facts.sort((a, b) => b.score - a.score);
  return facts.slice(0, 2).map(f => f.text).join(' · ');
}

const pct = (cur, prev) => (prev > 0 && Number.isFinite(cur)) ? Math.round(((cur - prev) / prev) * 100) : null;

function buildTrend(position, seasonRows) {
  if (seasonRows.length < 2) return { points_yoy_pct: null, ppg_yoy_pct: null, role_yoy: null };
  const [cur, prev] = seasonRows;
  if (cur.season !== prev.season + 1) return { points_yoy_pct: null, ppg_yoy_pct: null, role_yoy: null };
  const roleStat = position === 'QB' ? 'pass_att' : position === 'RB' ? 'rush_att' : 'targets';
  const roleLabel = { pass_att: 'pass att', rush_att: 'carries', targets: 'targets' }[roleStat];
  const r = pct(cur[roleStat], prev[roleStat]);
  return {
    points_yoy_pct: pct(cur.ppr_points, prev.ppr_points),
    ppg_yoy_pct: pct(cur.ppg, prev.ppg),
    role_yoy: r == null ? null : `${roleLabel} ${r >= 0 ? '+' : ''}${r}%`
  };
}

function buildConsistency(seasonRows) {
  const pts = seasonRows.map(s => s.ppr_points);
  const games = seasonRows.map(s => s.games);
  const k = seasonRows.length;
  if (!k) {
    return { seasons_counted: 0, mean_points: null, cv_points: null, seasons_top12: 0, seasons_top24: 0, min_games: null, max_games: null, avg_games: null };
  }
  const mean = pts.reduce((a, b) => a + b, 0) / k;
  const sd = Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / k);
  return {
    seasons_counted: k,
    mean_points: +mean.toFixed(1),
    cv_points: mean > 0 ? +(sd / mean).toFixed(3) : null,
    seasons_top12: seasonRows.filter(s => s.pos_rank != null && s.pos_rank <= 12).length,
    seasons_top24: seasonRows.filter(s => s.pos_rank != null && s.pos_rank <= 24).length,
    min_games: Math.min(...games),
    max_games: Math.max(...games),
    avg_games: +(games.reduce((a, b) => a + b, 0) / k).toFixed(1)
  };
}

/* --------------------------------------------------------------- public */

/**
 * Career line for one player (players.id, or a raw gsis_id string).
 * `season` is the upcoming/current season; the window is the `seasons`
 * completed seasons before it. Rookies (no completed season) get seasons: []
 * and headline: null.
 */
export function careerLine(playerId, { seasons = DEFAULT_WINDOW, season = SEASON } = {}) {
  const c = warmCareerCache(season, seasons);
  const who = resolvePlayer(playerId);
  const entry = who.gsis_id ? c.byGsis.get(who.gsis_id) : null;
  const windowSeasons = [];
  for (let yr = season - 1; yr >= season - seasons; yr--) windowSeasons.push(yr);

  const seasonRows = [];
  if (entry) {
    for (const yr of windowSeasons) {
      const s = entry.seasons.get(yr);
      if (s && s.games > 0) seasonRows.push({ ...s, espn_points: espnActual(who.player_id, yr) });
    }
  }
  const position = who.position ?? entry?.position ?? null;
  const rankPosition = entry?.position ?? position;
  const consistency = buildConsistency(seasonRows);
  const streaks = computeStreaks(seasonRows, windowSeasons);
  const headline = buildHeadline(rankPosition, seasonRows, streaks, consistency, windowSeasons.length);
  return {
    player_id: who.player_id,
    gsis_id: who.gsis_id ?? null,
    name: who.name,
    position,
    window: { from: windowSeasons[windowSeasons.length - 1], to: windowSeasons[0] },
    seasons: seasonRows,
    consistency,
    streaks,
    headline,
    trend: buildTrend(rankPosition, seasonRows)
  };
}

/** Map<player_id, careerLine> for a batch (the board asks for ~12 per poll). */
export function careerLines(playerIds, opts = {}) {
  const out = new Map();
  for (const id of playerIds ?? []) out.set(id, careerLine(id, opts));
  return out;
}

/** Positions the cache carries fantasy-relevant ranks for. */
export const CAREER_POSITIONS = SKILL;
