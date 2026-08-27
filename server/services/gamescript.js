/**
 * Game script from betting markets.
 *
 * The spread and the total are the market's forecast of how a game will be played, and
 * they move fantasy volume more than almost any matchup analysis does. A three-point
 * underdog in a 51-point game throws all afternoon; a ten-point favourite in a 38-point
 * game runs out the clock. Same players, very different weeks.
 *
 * The mapping from (spread, total) to pass and rush volume is *fitted* on four seasons
 * of real games rather than assumed, so the coefficients are measured rather than
 * invented — and the fit is reported, so it is obvious how much of the variation this
 * actually explains.
 *
 * Lines come from two free sources: nflverse's historical `games.csv` for fitting, and
 * ESPN's public scoreboard for the current slate. Neither needs an API key.
 */
import { db, rows, row, run } from '../db/index.js';
import { parseCsv } from './nflverse.js';
import { mean } from './stats-util.js';
import { recordSync } from './scheduler.js';

const GAMES_URL = 'https://github.com/nflverse/nfldata/raw/master/data/games.csv';
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

db.exec(`
  CREATE TABLE IF NOT EXISTS game_lines (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT,
    home INTEGER,
    spread REAL,          -- from this team's perspective; negative = favoured
    total REAL,
    implied_points REAL,  -- this team's share of the total
    source TEXT,
    fetched_at TEXT,
    PRIMARY KEY (season, week, team)
  );
  CREATE TABLE IF NOT EXISTS gamescript_model (
    target TEXT PRIMARY KEY,   -- 'pass_att' | 'rush_att'
    b0 REAL, b_spread REAL, b_total REAL,
    r2 REAL, n INTEGER, fitted_at TEXT
  );
`);

// Real final scores and real sportsbook prices (not just the spread/total numbers), added
// alongside the original columns — both are already sitting in the same nflverse/ESPN
// responses this file already fetches, and the NFL win/cover/total model needs them.
const glCols = db.prepare(`PRAGMA table_info(game_lines)`).all().map(c => c.name);
for (const [col, type] of [
  ['team_score', 'INTEGER'], ['opp_score', 'INTEGER'], ['moneyline', 'INTEGER'],
  ['spread_odds', 'INTEGER'], ['total_over_odds', 'INTEGER'], ['total_under_odds', 'INTEGER'],
  // Game context: weather, surface, rest and divisional status all come from the
  // same games.csv row already being read, and drive a whole family of betting
  // variables (dome vs wind, short week, off a bye, division familiarity).
  ['temp', 'INTEGER'], ['wind', 'INTEGER'], ['roof', 'TEXT'], ['surface', 'TEXT'],
  ['rest_days', 'INTEGER'], ['div_game', 'INTEGER'], ['gameday', 'TEXT'], ['gametime', 'TEXT'],
  // Opening numbers, so line movement (and reverse line movement) is measurable
  // rather than inferred. ESPN reports both the open and the current quote.
  ['open_spread', 'REAL'], ['open_total', 'REAL'], ['book_count', 'INTEGER']
]) {
  if (!glCols.includes(col)) db.exec(`ALTER TABLE game_lines ADD COLUMN ${col} ${type}`);
}

/**
 * A team's implied point total: half the game total, adjusted by half the spread.
 * This is the single most useful derived quantity from a line — it is the market's
 * direct forecast of how many points an offense will score.
 */
const impliedPoints = (spread, total) => total / 2 - spread / 2;

/* ------------------------------------------------------------------ ingest */

/** Historical lines, 1999-present, for fitting. */
export async function syncHistoricalLines() {
  try {
    return await syncHistoricalLinesImpl();
  } catch (e) { recordSync('nflverse_historical_lines', 'error', e.message); throw e; }
}

async function syncHistoricalLinesImpl() {
  const res = await fetch(GAMES_URL, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`games.csv -> HTTP ${res.status}`);
  const { header, records } = parseCsv(await res.text());
  const at = n => header.indexOf(n);
  const [iS, iW, iAway, iHome, iSpread, iTotal, iAwayScore, iHomeScore,
    iAwayMl, iHomeMl, iAwaySpreadOdds, iHomeSpreadOdds, iUnderOdds, iOverOdds,
    iTemp, iWind, iRoof, iSurface, iAwayRest, iHomeRest, iDiv, iGameday, iGametime] =
    ['season', 'week', 'away_team', 'home_team', 'spread_line', 'total_line', 'away_score', 'home_score',
      'away_moneyline', 'home_moneyline', 'away_spread_odds', 'home_spread_odds', 'under_odds', 'over_odds',
      'temp', 'wind', 'roof', 'surface', 'away_rest', 'home_rest', 'div_game', 'gameday', 'gametime'].map(at);
  if (iSpread < 0 || iTotal < 0) throw new Error('games.csv is missing spread_line/total_line');

  const stmt = db.prepare(`INSERT INTO game_lines
      (season, week, team, opponent, home, spread, total, implied_points, source, fetched_at,
       team_score, opp_score, moneyline, spread_odds, total_over_odds, total_under_odds,
       temp, wind, roof, surface, rest_days, div_game, gameday, gametime)
    VALUES (?,?,?,?,?,?,?,?, 'nflverse', datetime('now'), ?,?,?,?,?,?, ?,?,?,?,?,?,?,?)
    ON CONFLICT(season, week, team) DO UPDATE SET
      spread=excluded.spread, total=excluded.total, implied_points=excluded.implied_points,
      opponent=excluded.opponent, home=excluded.home, source=excluded.source,
      team_score=excluded.team_score, opp_score=excluded.opp_score, moneyline=excluded.moneyline,
      spread_odds=excluded.spread_odds, total_over_odds=excluded.total_over_odds,
      total_under_odds=excluded.total_under_odds,
      temp=excluded.temp, wind=excluded.wind, roof=excluded.roof, surface=excluded.surface,
      rest_days=excluded.rest_days, div_game=excluded.div_game,
      gameday=excluded.gameday, gametime=excluded.gametime`);

  // `Number('')` is 0, not NaN — an unplayed game's blank score/odds columns must
  // stay null, or every future game silently looks like a 0-0 final.
  const int = v => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of records) {
      const season = Number(r[iS]), week = Number(r[iW]);
      const total = Number(r[iTotal]);
      // nflverse states spread_line from the HOME team's perspective, positive = home favoured.
      const homeSpread = -Number(r[iSpread]);
      if (!Number.isFinite(total) || !Number.isFinite(homeSpread) || !season || !week) continue;
      // nflverse abbreviates the Rams "LA"; the rest of this app (and ESPN) uses "LAR" —
      // without this they split into two team identities for the same current franchise.
      const home = r[iHome] === 'LA' ? 'LAR' : r[iHome], away = r[iAway] === 'LA' ? 'LAR' : r[iAway];
      const homeScore = int(r[iHomeScore]), awayScore = int(r[iAwayScore]);
      const homeMl = int(r[iHomeMl]), awayMl = int(r[iAwayMl]);
      const homeSpreadOdds = int(r[iHomeSpreadOdds]), awaySpreadOdds = int(r[iAwaySpreadOdds]);
      const overOdds = int(r[iOverOdds]), underOdds = int(r[iUnderOdds]);
      const temp = int(r[iTemp]), wind = int(r[iWind]);
      const roof = r[iRoof] || null, surface = r[iSurface] || null;
      const divGame = int(r[iDiv]), gameday = r[iGameday] || null, gametime = r[iGametime] || null;
      stmt.run(season, week, home, away, 1, homeSpread, total, impliedPoints(homeSpread, total),
        homeScore, awayScore, homeMl, homeSpreadOdds, overOdds, underOdds,
        temp, wind, roof, surface, int(r[iHomeRest]), divGame, gameday, gametime);
      stmt.run(season, week, away, home, 0, -homeSpread, total, impliedPoints(-homeSpread, total),
        awayScore, homeScore, awayMl, awaySpreadOdds, overOdds, underOdds,
        temp, wind, roof, surface, int(r[iAwayRest]), divGame, gameday, gametime);
      n += 2;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const result = { rows: n };
  recordSync('nflverse_historical_lines', 'ok', result);
  return result;
}

/**
 * Current-slate lines from ESPN, which carry live sportsbook numbers — including,
 * when the primary provider quotes them, real moneyline/spread/total prices (not
 * just the spread and total numbers), which is what a genuine no-vig market
 * probability needs. `COALESCE` on the odds/score columns means a refresh before
 * a book posts real prices, or before a game goes final, never clobbers real data
 * already stored with a null.
 */
export async function syncCurrentLines(season, weeks = 18) {
  const stmt = db.prepare(`INSERT INTO game_lines
      (season, week, team, opponent, home, spread, total, implied_points, source, fetched_at,
       team_score, opp_score, moneyline, spread_odds, total_over_odds, total_under_odds,
       open_spread, open_total)
    VALUES (?,?,?,?,?,?,?,?, 'espn', datetime('now'), ?,?,?,?,?,?,?,?)
    ON CONFLICT(season, week, team) DO UPDATE SET
      spread=excluded.spread, total=excluded.total, implied_points=excluded.implied_points,
      source=excluded.source, fetched_at=excluded.fetched_at,
      team_score=COALESCE(excluded.team_score, team_score),
      opp_score=COALESCE(excluded.opp_score, opp_score),
      moneyline=COALESCE(excluded.moneyline, moneyline),
      spread_odds=COALESCE(excluded.spread_odds, spread_odds),
      total_over_odds=COALESCE(excluded.total_over_odds, total_over_odds),
      total_under_odds=COALESCE(excluded.total_under_odds, total_under_odds),
      open_spread=COALESCE(excluded.open_spread, open_spread),
      open_total=COALESCE(excluded.open_total, open_total)`);

  // `Number('')` is 0, not NaN — an unplayed game's blank score/odds columns must
  // stay null, or every future game silently looks like a 0-0 final.
  const int = v => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
  let updated = 0;
  for (let week = 1; week <= weeks; week++) {
    try {
      const url = `${ESPN_SCOREBOARD}?seasontype=2&week=${week}&dates=${season}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of data.events ?? []) {
        const c = ev.competitions?.[0];
        const odds = c?.odds?.[0];
        if (!odds || odds.overUnder == null || odds.spread == null) continue;
        const home = c.competitors?.find(x => x.homeAway === 'home');
        const away = c.competitors?.find(x => x.homeAway === 'away');
        if (!home || !away) continue;
        // ESPN quotes `spread` from the home side, negative = home favoured.
        const hs = Number(odds.spread), total = Number(odds.overUnder);
        // ESPN abbreviates Washington "WSH"; nflverse's historical data (and the rest of
        // this app) uses "WAS" — normalize so the two don't split into separate teams.
        const normAbbr = a => (a === 'WSH' ? 'WAS' : a);
        const ha = normAbbr(home.team?.abbreviation), aa = normAbbr(away.team?.abbreviation);
        if (!ha || !aa || !Number.isFinite(hs) || !Number.isFinite(total)) continue;

        const isFinal = c.status?.type?.completed === true;
        const hScore = isFinal ? int(home.score) : null, aScore = isFinal ? int(away.score) : null;
        const homeMl = int(odds.moneyline?.home?.close?.odds ?? odds.moneyline?.home?.odds);
        const awayMl = int(odds.moneyline?.away?.close?.odds ?? odds.moneyline?.away?.odds);
        const homeSpreadOdds = int(odds.pointSpread?.home?.close?.odds ?? odds.homeTeamOdds?.spreadOdds);
        const awaySpreadOdds = int(odds.pointSpread?.away?.close?.odds ?? odds.awayTeamOdds?.spreadOdds);
        const overOdds = int(odds.total?.over?.close?.odds ?? odds.overOdds);
        const underOdds = int(odds.total?.under?.close?.odds ?? odds.underOdds);

        // ESPN reports the opening quote alongside the current one; spread opens
        // are stated from the home side, matching `odds.spread`.
        const openTotal = Number(odds.open?.total?.american ?? odds.open?.total?.alternateDisplayValue);
        const openSpreadRaw = Number(odds.open?.pointSpread?.alternateDisplayValue
          ?? odds.open?.spread?.american ?? odds.open?.spread?.alternateDisplayValue);
        const openTotalV = Number.isFinite(openTotal) ? openTotal : null;
        const openSpreadV = Number.isFinite(openSpreadRaw) ? openSpreadRaw : null;

        stmt.run(season, week, ha, aa, 1, hs, total, impliedPoints(hs, total),
          hScore, aScore, homeMl, homeSpreadOdds, overOdds, underOdds,
          openSpreadV, openTotalV);
        stmt.run(season, week, aa, ha, 0, -hs, total, impliedPoints(-hs, total),
          aScore, hScore, awayMl, awaySpreadOdds, overOdds, underOdds,
          openSpreadV == null ? null : -openSpreadV, openTotalV);
        updated += 2;
      }
    } catch { /* a missing week is normal out of season */ }
  }
  return { season, updated };
}

/* --------------------------------------------------------------- fitting */

/** Ordinary least squares for y ~ b0 + b1*x1 + b2*x2, via 3x3 normal equations. */
function ols(x1, x2, y) {
  const n = y.length;
  if (n < 30) return null;
  // Build X'X and X'y for the design [1, x1, x2].
  let s11 = n, s12 = 0, s13 = 0, s22 = 0, s23 = 0, s33 = 0, t1 = 0, t2 = 0, t3 = 0;
  for (let i = 0; i < n; i++) {
    const a = x1[i], b = x2[i], v = y[i];
    s12 += a; s13 += b;
    s22 += a * a; s23 += a * b; s33 += b * b;
    t1 += v; t2 += a * v; t3 += b * v;
  }
  const A = [[s11, s12, s13], [s12, s22, s23], [s13, s23, s33]];
  const B = [t1, t2, t3];
  // Gaussian elimination with partial pivoting.
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (Math.abs(A[p][i]) < 1e-10) return null;
    [A[i], A[p]] = [A[p], A[i]]; [B[i], B[p]] = [B[p], B[i]];
    for (let r = i + 1; r < 3; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < 3; c++) A[r][c] -= f * A[i][c];
      B[r] -= f * B[i];
    }
  }
  const beta = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = B[i];
    for (let c = i + 1; c < 3; c++) s -= A[i][c] * beta[c];
    beta[i] = s / A[i][i];
  }
  const ybar = mean(y);
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = beta[0] + beta[1] * x1[i] + beta[2] * x2[i];
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - ybar) ** 2;
  }
  return { b0: beta[0], b_spread: beta[1], b_total: beta[2], r2: ssTot ? 1 - ssRes / ssTot : 0, n };
}

/**
 * Fit team pass and rush volume against the line.
 *
 * The expected signs are worth stating up front, because they are the sanity check:
 * a bigger underdog (positive spread) should throw more and run less, and a higher
 * total should raise both.
 */
function observations(beforeSeason = null, beforeWeek = null) {
  return rows(`SELECT g.spread, g.total, t.att, t.car FROM game_lines g
                    JOIN (SELECT season, week, team,
                                 SUM(COALESCE(attempts,0)) AS att,
                                 SUM(COALESCE(carries,0))  AS car
                          FROM player_week_usage GROUP BY season, week, team) t
                      ON t.season = g.season AND t.week = g.week AND t.team = g.team
                    WHERE g.spread IS NOT NULL AND g.total IS NOT NULL AND t.att > 5
                      AND (? IS NULL OR g.season < ? OR (g.season = ? AND g.week < ?))`,
                    beforeSeason, beforeSeason, beforeSeason, beforeWeek ?? 1);
}

function fitObservations(obs) {
  if (obs.length < 100) return { error: `only ${obs.length} matched team-games — sync lines and usage first` };

  const spread = obs.map(o => o.spread), total = obs.map(o => o.total);
  const fits = {
    pass_att: ols(spread, total, obs.map(o => o.att)),
    rush_att: ols(spread, total, obs.map(o => o.car))
  };
  return { fits, n: obs.length };
}

export function fitGameScript() {
  const fitted = fitObservations(observations());
  if (fitted.error) return fitted;
  const { fits } = fitted;
  const stmt = db.prepare(`INSERT INTO gamescript_model (target, b0, b_spread, b_total, r2, n, fitted_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(target) DO UPDATE SET b0=excluded.b0, b_spread=excluded.b_spread,
      b_total=excluded.b_total, r2=excluded.r2, n=excluded.n, fitted_at=excluded.fitted_at`);
  const out = {};
  for (const [target, f] of Object.entries(fits)) {
    if (!f) continue;
    stmt.run(target, f.b0, f.b_spread, f.b_total, f.r2, f.n);
    out[target] = {
      intercept: +f.b0.toFixed(2),
      per_point_of_spread: +f.b_spread.toFixed(3),
      per_point_of_total: +f.b_total.toFixed(3),
      r2: +f.r2.toFixed(4), n: f.n
    };
  }
  _cache = null;
  return out;
}

/* ---------------------------------------------------------------- apply */

let _cache = null;
const _cutoffCache = new Map();
export function clearGameScriptCache() { _cache = null; _cutoffCache.clear(); }

function model() {
  if (_cache) return _cache;
  const m = new Map(rows('SELECT * FROM gamescript_model').map(r => [r.target, r]));
  // League-average line, so multipliers are relative to a neutral game.
  const avg = row(`SELECT AVG(total) AS total FROM game_lines WHERE total IS NOT NULL`);
  _cache = { m, avgTotal: avg?.total ?? 44.5 };
  return _cache;
}

function modelAt(season, week) {
  const key = `${season}|${week}`;
  if (_cutoffCache.has(key)) return _cutoffCache.get(key);
  const obs = observations(season, week);
  const fitted = fitObservations(obs);
  if (fitted.error) return model();
  const m = new Map(Object.entries(fitted.fits).filter(([, v]) => v));
  const priorLines = rows(`SELECT total FROM game_lines
                           WHERE total IS NOT NULL
                             AND (season < ? OR (season = ? AND week < ?))`, season, season, week);
  const avgTotal = priorLines.length ? mean(priorLines.map(x => x.total)) : 44.5;
  const out = { m, avgTotal, cutoff: { season, week }, observations: fitted.n };
  _cutoffCache.set(key, out);
  return out;
}

/**
 * Volume multipliers for one team in one week, relative to a neutral game script.
 * Returns 1/1 when no line exists, so out-of-season behaviour is simply "no adjustment".
 */
export function gameScriptFor(team, season, week) {
  const { m, avgTotal, cutoff = null, observations: n = null } = modelAt(season, week);
  const line = row('SELECT * FROM game_lines WHERE season=? AND week=? AND team=?', season, week, team);
  if (!line || !m.size) return { pass_mult: 1, rush_mult: 1, line: null };

  const predict = t => {
    const f = m.get(t);
    if (!f) return null;
    const actual = f.b0 + f.b_spread * line.spread + f.b_total * line.total;
    const neutral = f.b0 + f.b_spread * 0 + f.b_total * avgTotal;
    return neutral > 0 ? actual / neutral : 1;
  };
  const clamp = v => (v == null ? 1 : Math.max(0.75, Math.min(1.3, v)));
  return {
    pass_mult: +clamp(predict('pass_att')).toFixed(3),
    rush_mult: +clamp(predict('rush_att')).toFixed(3),
    line: {
      spread: line.spread, total: line.total,
      implied_points: line.implied_points == null ? null : +line.implied_points.toFixed(1),
      opponent: line.opponent, home: !!line.home, source: line.source
    },
    fitted_through: cutoff,
    training_observations: n
  };
}

/** Every line we hold for a season, for display. */
export function linesFor(season, week = null) {
  return rows(`SELECT * FROM game_lines WHERE season = ? ${week ? 'AND week = ?' : ''}
               ORDER BY week, team`, season, ...(week ? [week] : []));
}
