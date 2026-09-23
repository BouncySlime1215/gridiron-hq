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
import { canonicalTeamCode } from './team-codes.js';
import { db, rows, row, run } from '../db/index.js';
import { parseCsv } from './nflverse.js';
import { mean, stdev, keyedNormal, normalCdf } from './stats-util.js';
import { recordSync } from './scheduler.js';

const GAMES_URL = 'https://github.com/nflverse/nfldata/raw/master/data/games.csv';
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

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
    iTemp, iWind, iRoof, iSurface, iAwayRest, iHomeRest, iDiv, iGameday, iGametime, iLocation] =
    ['season', 'week', 'away_team', 'home_team', 'spread_line', 'total_line', 'away_score', 'home_score',
      'away_moneyline', 'home_moneyline', 'away_spread_odds', 'home_spread_odds', 'under_odds', 'over_odds',
      'temp', 'wind', 'roof', 'surface', 'away_rest', 'home_rest', 'div_game', 'gameday', 'gametime', 'location'].map(at);
  if (iSpread < 0 || iTotal < 0) throw new Error('games.csv is missing spread_line/total_line');

  const stmt = db.prepare(`INSERT INTO game_lines
      (season, week, team, opponent, home, spread, total, implied_points, source, fetched_at,
       team_score, opp_score, moneyline, spread_odds, total_over_odds, total_under_odds,
       temp, wind, roof, surface, rest_days, div_game, gameday, gametime, neutral_site)
    VALUES (?,?,?,?,?,?,?,?, 'nflverse', datetime('now'), ?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)
    ON CONFLICT(season, week, team) DO UPDATE SET
      spread=excluded.spread, total=excluded.total, implied_points=excluded.implied_points,
      opponent=excluded.opponent, home=excluded.home, source=excluded.source,
      team_score=excluded.team_score, opp_score=excluded.opp_score, moneyline=excluded.moneyline,
      spread_odds=excluded.spread_odds, total_over_odds=excluded.total_over_odds,
      total_under_odds=excluded.total_under_odds,
      temp=excluded.temp, wind=excluded.wind, roof=excluded.roof, surface=excluded.surface,
      rest_days=excluded.rest_days, div_game=excluded.div_game,
      gameday=excluded.gameday, gametime=excluded.gametime,
      neutral_site=COALESCE(excluded.neutral_site, neutral_site)`);

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
      // One map (team-codes.js): nflverse writes the Rams "LA" and keeps OAK/SD/STL
      // for pre-move seasons; the app keys a franchise by its current code so a
      // relocation does not split one team's history into two identities.
      const home = canonicalTeamCode(r[iHome]), away = canonicalTeamCode(r[iAway]);
      const homeScore = int(r[iHomeScore]), awayScore = int(r[iAwayScore]);
      const homeMl = int(r[iHomeMl]), awayMl = int(r[iAwayMl]);
      const homeSpreadOdds = int(r[iHomeSpreadOdds]), awaySpreadOdds = int(r[iAwaySpreadOdds]);
      const overOdds = int(r[iOverOdds]), underOdds = int(r[iUnderOdds]);
      const temp = int(r[iTemp]), wind = int(r[iWind]);
      const roof = r[iRoof] || null, surface = r[iSurface] || null;
      const divGame = int(r[iDiv]), gameday = r[iGameday] || null, gametime = r[iGametime] || null;
      // nflverse marks international and relocated games 'Neutral' in `location`.
      const neutral = iLocation < 0 ? null : (/neutral/i.test(String(r[iLocation] ?? '')) ? 1 : 0);
      stmt.run(season, week, home, away, 1, homeSpread, total, impliedPoints(homeSpread, total),
        homeScore, awayScore, homeMl, homeSpreadOdds, overOdds, underOdds,
        temp, wind, roof, surface, int(r[iHomeRest]), divGame, gameday, gametime, neutral);
      stmt.run(season, week, away, home, 0, -homeSpread, total, impliedPoints(-homeSpread, total),
        awayScore, homeScore, awayMl, awaySpreadOdds, overOdds, underOdds,
        temp, wind, roof, surface, int(r[iAwayRest]), divGame, gameday, gametime, neutral);
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
  // TODO(a5-simulation, 2026-09-12): the build plan for this pass asked for a
  // preKickoff guard on `stmt`'s spread/total UPDATE, matching closeStmt below
  // (item 7 of Giant Plan section 6). Deliberately NOT applied: the live
  // `spread`/`total` columns updating post-kickoff is exercised and asserted
  // as intentional by test/gamescript-closing-line.test.js ("the live column
  // is allowed to reflect the corrupted mid-game number" — that's their job
  // elsewhere, e.g. line-shopping/movement detection; only the frozen
  // closing_* columns below are meant to stop moving at kickoff). Gating
  // `stmt` the same way would silently stop the live columns from ever
  // updating during a game, contradicting that documented, tested design.
  // Left for a human to resolve: either the plan's premise is wrong (closing_*
  // is correctly the only thing that needs freezing) or there is a narrower
  // guard intended here that this pass could not identify without more
  // context. Not applied either way rather than guessed at.
  const stmt = db.prepare(`INSERT INTO game_lines
      (season, week, team, opponent, home, spread, total, implied_points, source, fetched_at,
       team_score, opp_score, moneyline, spread_odds, total_over_odds, total_under_odds,
       open_spread, open_total, neutral_site, roof)
    VALUES (?,?,?,?,?,?,?,?, 'espn', datetime('now'), ?,?,?,?,?,?,?,?,?,?)
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
      open_total=COALESCE(excluded.open_total, open_total),
      neutral_site=COALESCE(excluded.neutral_site, neutral_site),
      roof=COALESCE(excluded.roof, roof)`);
  // ESPN removes the odds object once a game is final. The score must still land,
  // or nothing downstream (settlement, finalized-week detection, the learning
  // cycle) ever sees a 2026 result. Scores only; the last pre-final line stays.
  const finalStmt = db.prepare(`UPDATE game_lines
      SET team_score=?, opp_score=?, fetched_at=datetime('now'),
          neutral_site=COALESCE(?, neutral_site), roof=COALESCE(?, roof)
      WHERE season=? AND week=? AND team=?`);
  // Freezes the true close. Only ever runs while `now` is strictly before this
  // game's kickoff, so the last write it makes for a given game IS the close —
  // the same "last observation strictly before kickoff" definition clv-core.js
  // uses for props (closingConsensus), just kept as one column instead of a
  // snapshot table since this job already polls hourly and only needs the last
  // value, not the whole tape. Once kickoff passes this is never called again
  // for that row, so the value it last wrote stays frozen for good.
  const closeStmt = db.prepare(`UPDATE game_lines
      SET closing_spread=?, closing_total=? WHERE season=? AND week=? AND team=?`);
  const now = new Date();

  // `Number('')` is 0, not NaN — an unplayed game's blank score/odds columns must
  // stay null, or every future game silently looks like a 0-0 final.
  const int = v => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
  const num = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/^[ou]/i, '')); return Number.isFinite(n) ? n : null; };
  // ESPN abbreviates Washington "WSH"; the app's canonical codes are nflverse's
  // (team-codes.js) — normalize so the two don't split into separate teams.
  const normAbbr = a => (a == null ? a : canonicalTeamCode(a));
  let updated = 0, finals = 0;
  for (let week = 1; week <= weeks; week++) {
    try {
      const url = `${ESPN_SCOREBOARD}?seasontype=2&week=${week}&dates=${season}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of data.events ?? []) {
        const c = ev.competitions?.[0];
        const home = c?.competitors?.find(x => x.homeAway === 'home');
        const away = c?.competitors?.find(x => x.homeAway === 'away');
        if (!home || !away) continue;
        const ha = normAbbr(home.team?.abbreviation), aa = normAbbr(away.team?.abbreviation);
        if (!ha || !aa) continue;
        const isFinal = c.status?.type?.completed === true;
        const hScore = isFinal ? int(home.score) : null, aScore = isFinal ? int(away.score) : null;
        const neutral = c.neutralSite === true ? 1 : c.neutralSite === false ? 0 : null;
        // The venue's roof state is a fact about the building, not the market;
        // it beats games.csv here because ESPN knows the actual stadium of a
        // relocated game (the Melbourne Cricket Ground is open-air).
        const roof = typeof c.venue?.indoor === 'boolean' ? (c.venue.indoor ? 'dome' : 'outdoors') : null;

        const odds = c.odds?.[0];
        if (!odds || odds.overUnder == null || odds.spread == null) {
          if (isFinal && hScore != null && aScore != null) {
            finalStmt.run(hScore, aScore, neutral, roof, season, week, ha);
            finalStmt.run(aScore, hScore, neutral, roof, season, week, aa);
            finals += 2;
          }
          continue;
        }
        // ESPN quotes `spread` from the home side, negative = home favoured.
        const hs = Number(odds.spread), total = Number(odds.overUnder);
        if (!Number.isFinite(hs) || !Number.isFinite(total)) continue;

        // `ev.date` is this event's kickoff in ISO UTC, straight from ESPN — the
        // same field nfl-espn-line-watch.js already reads as commence_time.
        const commenceTime = ev.date ? new Date(ev.date) : null;
        const preKickoff = !!commenceTime && !Number.isNaN(commenceTime.getTime()) && now < commenceTime;

        const homeMl = int(odds.moneyline?.home?.close?.odds ?? odds.moneyline?.home?.odds);
        const awayMl = int(odds.moneyline?.away?.close?.odds ?? odds.moneyline?.away?.odds);
        const homeSpreadOdds = int(odds.pointSpread?.home?.close?.odds ?? odds.homeTeamOdds?.spreadOdds);
        const awaySpreadOdds = int(odds.pointSpread?.away?.close?.odds ?? odds.awayTeamOdds?.spreadOdds);
        const overOdds = int(odds.total?.over?.close?.odds ?? odds.overOdds);
        const underOdds = int(odds.total?.under?.close?.odds ?? odds.underOdds);

        // ESPN reports the opening quote beside the current one. On the scoreboard
        // shape it lives at pointSpread.home.open.line ("-3.5") and total.over.open.line
        // ("o44.5"); the older core-API shape used odds.open.*. Read both.
        const openSpreadV = num(odds.pointSpread?.home?.open?.line)
          ?? num(odds.open?.pointSpread?.alternateDisplayValue ?? odds.open?.spread?.american);
        const openTotalV = num(odds.total?.over?.open?.line)
          ?? num(odds.open?.total?.american ?? odds.open?.total?.alternateDisplayValue);

        stmt.run(season, week, ha, aa, 1, hs, total, impliedPoints(hs, total),
          hScore, aScore, homeMl, homeSpreadOdds, overOdds, underOdds,
          openSpreadV, openTotalV, neutral, roof);
        stmt.run(season, week, aa, ha, 0, -hs, total, impliedPoints(-hs, total),
          aScore, hScore, awayMl, awaySpreadOdds, overOdds, underOdds,
          openSpreadV == null ? null : -openSpreadV, openTotalV, neutral, roof);
        updated += 2;

        if (preKickoff) {
          closeStmt.run(hs, total, season, week, ha);
          closeStmt.run(-hs, total, season, week, aa);
        }
      }
    } catch { /* a missing week is normal out of season */ }
  }
  return { season, updated, finals_scored: finals };
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
  // Historical rows (nflverse) never populate closing_spread/closing_total —
  // COALESCE falls back to spread/total there, so nothing changes for
  // 2021-2025. Current-season rows prefer the frozen close, so the fit is
  // never trained on a spread ESPN's live odds object clobbered mid-game.
  return rows(`SELECT COALESCE(g.closing_spread, g.spread) AS spread,
                      COALESCE(g.closing_total, g.total) AS total,
                      t.att, t.car FROM game_lines g
                    JOIN (SELECT season, week, team,
                                 SUM(COALESCE(attempts,0)) AS att,
                                 SUM(COALESCE(carries,0))  AS car
                          FROM player_week_usage GROUP BY season, week, team) t
                      ON t.season = g.season AND t.week = g.week AND t.team = g.team
                    WHERE COALESCE(g.closing_spread, g.spread) IS NOT NULL
                      AND COALESCE(g.closing_total, g.total) IS NOT NULL AND t.att > 5
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
const _scoreCache = new Map();
export function clearGameScriptCache() { _cache = null; _cutoffCache.clear(); _scoreCache.clear(); }

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

/* ------------------------------------------------ game-script sampler (PROJ-03-a, CE-01 a)
 * One keyed score path per game, consistent with the line: both team totals, the margin,
 * each side's quarter points, pace (expected pass/rush attempts given the drawn score) and
 * the home win probability after each quarter. Every player in the game reads the SAME
 * path for a given key, which is what makes teammates and opponents correlate.
 *
 * Model (pre-registered in docs/tdd/2026-09-23-proj-03a-game-script-sampler.tdd.md):
 *   - team points ~ Gamma(mean = implied points, sd = the |spread| bucket's sd);
 *   - the two teams joined by a Gaussian copula with the bucket's residual correlation;
 *   - quarters split each final by Dirichlet(k/4 x 4), the bridge of a gamma process;
 *   - win probability after quarter q from Stern's (1994) Brownian margin model;
 *   - pace from OLS of team attempts on the realized (margin, total).
 * Params are fitted in memory at the (season, week) cutoff, like modelAt: no store. */

export const SCORE_MODEL_FIRST_SEASON = 2021;
const MIN_BUCKET_TEAM_GAMES = 50;

/** |spread| bucket: 'lt3' (< 3), '3to7' (3..7 inclusive), 'gt7' (> 7). */
export function spreadBucket(spread) {
  const a = Math.abs(spread);
  return a < 3 ? 'lt3' : a <= 7 ? '3to7' : 'gt7';
}

/** Lanczos log-gamma (g = 7, n = 9). */
function logGamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized lower incomplete gamma P(a, x): series below a+1, continued fraction above. */
function gammaP(a, x) {
  if (x <= 0) return 0;
  const lg = logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a, term = sum, ap = a;
    for (let n = 0; n < 500; n++) { ap += 1; term *= x / ap; sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-14) break; }
    return sum * Math.exp(-x + a * Math.log(x) - lg);
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lg) * h;
}

/** Gamma(shape, 1) quantile by safeguarded Newton from a Wilson-Hilferty start. */
export function gammaQuantile(u, shape) {
  if (!(u > 0)) return 0;
  if (!(u < 1)) return Infinity;
  const lg = logGamma(shape);
  const z = Math.sqrt(2) * erfInvApprox(2 * u - 1);
  const wh = shape * (1 - 1 / (9 * shape) + z / (3 * Math.sqrt(shape))) ** 3;
  let x = wh > 0 ? wh : Math.max(1e-8, Math.pow(u * Math.exp(lg + Math.log(shape)), 1 / shape));
  let lo = 0, hi = Infinity;
  for (let i = 0; i < 100; i++) {
    const f = gammaP(shape, x) - u;
    if (f > 0) hi = x; else lo = x;
    if (Math.abs(f) < 1e-12) break;
    const pdf = Math.exp((shape - 1) * Math.log(x) - x - lg);
    let next = pdf > 0 ? x - f / pdf : NaN;
    if (!(next > lo && next < hi)) next = Number.isFinite(hi) ? (lo + hi) / 2 : Math.max(2 * x, x + 1);
    if (Math.abs(next - x) < 1e-12 * Math.max(1, x)) { x = next; break; }
    x = next;
  }
  return x;
}

/** Inverse error function (Giles 2010 single-precision form), only used as a Newton start. */
function erfInvApprox(y) {
  let w = -Math.log((1 - y) * (1 + y)), p;
  if (w < 5) {
    w -= 2.5;
    p = 2.81022636e-08; p = 3.43273939e-07 + p * w; p = -3.5233877e-06 + p * w; p = -4.39150654e-06 + p * w;
    p = 0.00021858087 + p * w; p = -0.00125372503 + p * w; p = -0.00417768164 + p * w; p = 0.246640727 + p * w;
    p = 1.50140941 + p * w;
  } else {
    w = Math.sqrt(w) - 3;
    p = -0.000200214257; p = 0.000100950558 + p * w; p = 0.00134934322 + p * w; p = -0.00367342844 + p * w;
    p = 0.00573950773 + p * w; p = -0.0076224613 + p * w; p = 0.00943887047 + p * w; p = 1.00167406 + p * w;
    p = 2.83297682 + p * w;
  }
  return p * y;
}

const clampU = u => Math.min(1 - 1e-12, Math.max(1e-12, u));
const keyedUniform = (key, counter) => clampU(normalCdf(keyedNormal(key, counter)));

/** Training games (home row only, one per game), scored, before the cutoff, from 2021. */
function scoredGames(season, week) {
  return rows(`SELECT g.season, g.week, g.team, g.opponent,
                      COALESCE(g.closing_spread, g.spread) AS spread,
                      COALESCE(g.closing_total, g.total) AS total,
                      g.team_score, g.opp_score, COALESCE(g.neutral_site, 0) AS neutral
                 FROM game_lines g
                WHERE g.home = 1 AND g.team_score IS NOT NULL AND g.opp_score IS NOT NULL
                  AND COALESCE(g.closing_spread, g.spread) IS NOT NULL
                  AND COALESCE(g.closing_total, g.total) IS NOT NULL
                  AND g.season >= ?
                  AND (g.season < ? OR (g.season = ? AND g.week < ?))`,
    SCORE_MODEL_FIRST_SEASON, season, season, week);
}

/** Team attempts against the realized (team margin, game total), before the cutoff. */
function paceObservations(season, week) {
  return rows(`SELECT g.team_score - g.opp_score AS margin, g.team_score + g.opp_score AS total,
                      t.att, t.car
                 FROM game_lines g
                 JOIN (SELECT season, week, team, SUM(COALESCE(attempts,0)) AS att,
                              SUM(COALESCE(carries,0)) AS car
                         FROM player_week_usage GROUP BY season, week, team) t
                   ON t.season = g.season AND t.week = g.week AND t.team = g.team
                WHERE g.team_score IS NOT NULL AND g.opp_score IS NOT NULL AND t.att > 5
                  AND g.season >= ?
                  AND (g.season < ? OR (g.season = ? AND g.week < ?))`,
    SCORE_MODEL_FIRST_SEASON, season, season, week);
}

function pearson(x, y) {
  const n = x.length;
  if (n < 3) return 0;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/**
 * Score-model params fitted on scored games strictly before (season, week).
 * Returns null when there are fewer than 100 training games.
 */
export function scoreModelAt(season, week) {
  const key = `${season}|${week}`;
  if (_scoreCache.has(key)) return _scoreCache.get(key);
  const games = scoredGames(season, week);
  if (games.length < 100) { _scoreCache.set(key, null); return null; }
  const all = { res: [], hres: [], ares: [], mres: [] };
  const by = { lt3: { res: [], hres: [], ares: [], mres: [] }, '3to7': { res: [], hres: [], ares: [], mres: [] }, gt7: { res: [], hres: [], ares: [], mres: [] } };
  const edges = [], totals = [];
  for (const g of games) {
    const ih = impliedPoints(g.spread, g.total), ia = impliedPoints(-g.spread, g.total);
    const rh = g.team_score - ih, ra = g.opp_score - ia;
    const rm = (g.team_score - g.opp_score) - (-g.spread);
    for (const s of [all, by[spreadBucket(g.spread)]]) { s.res.push(rh, ra); s.hres.push(rh); s.ares.push(ra); s.mres.push(rm); }
    if (!g.neutral) edges.push(-g.spread);
    totals.push(g.total);
  }
  const summarize = s => ({ n: s.res.length, sd: stdev(s.res), margin_sd: stdev(s.mres),
    rho: Math.max(-0.9, Math.min(0.9, pearson(s.hres, s.ares))) });
  const pooled = summarize(all);
  const buckets = {};
  for (const [b, s] of Object.entries(by)) {
    const fit = summarize(s);
    buckets[b] = fit.n >= MIN_BUCKET_TEAM_GAMES ? { ...fit, pooled_fallback: false }
      : { ...pooled, n: fit.n, pooled_fallback: true };
  }
  const pobs = paceObservations(season, week);
  const pace = {
    pass_att: ols(pobs.map(o => o.margin), pobs.map(o => o.total), pobs.map(o => o.att)),
    rush_att: ols(pobs.map(o => o.margin), pobs.map(o => o.total), pobs.map(o => o.car))
  };
  const out = {
    buckets, pooled_sd: pooled.sd, pooled_margin_sd: pooled.margin_sd,
    home_edge: edges.length ? mean(edges) : 0, mean_total: mean(totals),
    pace, games: games.length, fitted_through: { season, week }
  };
  _scoreCache.set(key, out);
  return out;
}

/** Gamma(mean, sd) points quantile. */
function pointsQuantile(u, meanPts, sd) {
  const m = Math.max(1, meanPts);
  const shape = (m / sd) ** 2, scale = sd * sd / m;
  return gammaQuantile(u, shape) * scale;
}

/** The sampler's own team-points CDF and quantile, for calibration and range display. */
export function teamPointsDistribution(meanPts, spread, params) {
  const b = params.buckets[spreadBucket(spread)];
  const m = Math.max(1, meanPts), shape = (m / b.sd) ** 2, scale = b.sd * b.sd / m;
  return {
    mean: m, sd: b.sd, bucket: spreadBucket(spread),
    cdf: y => (y <= 0 ? 0 : gammaP(shape, y / scale)),
    quantile: u => gammaQuantile(u, shape) * scale
  };
}

/**
 * One keyed score path for a game.
 * @param {{home, away, home_spread, total, season, week, neutral?}} game  (gameFor's shape)
 * @param {number} key   a keyedSeed(...) value; the same key always gives the same path
 * @param {object} [params] scoreModelAt(game.season, game.week), passed in for loops
 */
export function sampleGameScript(game, key, params = scoreModelAt(game.season, game.week)) {
  if (!params) return null;
  const s = game.home_spread, T = game.total;
  const bucket = spreadBucket(s);
  const b = params.buckets[bucket];
  const ih = impliedPoints(s, T), ia = impliedPoints(-s, T);
  const z1 = keyedNormal(key, 0);
  const z2 = b.rho * z1 + Math.sqrt(1 - b.rho * b.rho) * keyedNormal(key, 1);
  const hp = pointsQuantile(clampU(normalCdf(z1)), ih, b.sd);
  const ap = pointsQuantile(clampU(normalCdf(z2)), ia, b.sd);
  const quarters = (pts, mu, base) => {
    const shape = (Math.max(1, mu) / b.sd) ** 2 / 4;
    const g = [0, 1, 2, 3].map(i => gammaQuantile(keyedUniform(key, base + i), shape));
    const sum = g.reduce((x, y) => x + y, 0);
    const q = g.map(v => (sum > 0 ? pts * v / sum : pts / 4));
    q[3] = pts - q[0] - q[1] - q[2];               // exact sum, no float drift
    if (q[3] < 0) { q[2] += q[3]; q[3] = 0; }
    return q;
  };
  const hq = quarters(hp, ih, 10), aq = quarters(ap, ia, 20);
  const mu = -s, sigma = b.margin_sd;
  const win = [normalCdf(mu / sigma)];
  let mh = 0;
  for (let q = 0; q < 3; q++) {
    mh += hq[q] - aq[q];
    const rest = 1 - (q + 1) / 4;
    win.push(normalCdf((mh + mu * rest) / (sigma * Math.sqrt(rest))));
  }
  const margin = hp - ap;
  win.push(margin > 0 ? 1 : margin < 0 ? 0 : 0.5);
  const paceFor = teamMargin => {
    const f = params.pace;
    const at = t => (f[t] ? f[t].b0 + f[t].b_spread * teamMargin + f[t].b_total * (hp + ap) : null);
    return { pass_att: at('pass_att'), rush_att: at('rush_att') };
  };
  return {
    season: game.season, week: game.week, home_spread: s, total_line: T, bucket,
    home: { team: game.home, implied: ih, points: hp, quarters: hq, pace: paceFor(margin) },
    away: { team: game.away, implied: ia, points: ap, quarters: aq, pace: paceFor(-margin) },
    total: hp + ap, margin, win_prob_home: win
  };
}

/** Latest rating per team for (source, season) at or before `week`. */
function ratingAsOf(source, season, week, team) {
  return row(`SELECT rating, week FROM nfl_external_ratings
               WHERE source = ? AND season = ? AND week <= ? AND team = ? AND rating IS NOT NULL
               ORDER BY week DESC LIMIT 1`, source, season, week, team)?.rating ?? null;
}

const RATING_SOURCES = ['espn_fpi', 'teamrankings_predictive'];   // nfl-external-ratings.js SOURCES

/**
 * The game a team plays in (season, week), as the sampler's input.
 * Uses the line in game_lines (historical close, or ESPN look-ahead for future weeks);
 * without one, a power-rating spread (home rating - away rating + the market's mean home
 * edge before the cutoff) and the mean pre-cutoff total. Null when neither exists.
 * `opts.opponent` / `opts.home` are required for the rating fallback.
 */
export function gameFor(season, week, team, opts = {}) {
  const line = row(`SELECT team, opponent, home, COALESCE(closing_spread, spread) AS spread,
                           COALESCE(closing_total, total) AS total, COALESCE(neutral_site, 0) AS neutral, source
                      FROM game_lines WHERE season = ? AND week = ? AND team = ?`, season, week, team);
  if (line && line.spread != null && line.total != null && line.opponent) {
    const isHome = !!line.home;
    return { season, week, home: isHome ? team : line.opponent, away: isHome ? line.opponent : team,
      home_spread: isHome ? line.spread : -line.spread, total: line.total, neutral: !!line.neutral,
      source: 'line', line_source: line.source };
  }
  const opp = opts.opponent;
  if (!opp || opts.home == null) return null;
  const home = opts.home ? team : opp, away = opts.home ? opp : team;
  const params = scoreModelAt(season, week);
  if (!params) return null;
  for (const src of RATING_SOURCES) {
    const hr = ratingAsOf(src, season, week, home), ar = ratingAsOf(src, season, week, away);
    if (!Number.isFinite(hr) || !Number.isFinite(ar)) continue;
    const edge = opts.neutral ? 0 : params.home_edge;
    return { season, week, home, away, home_spread: -(hr - ar + edge), total: params.mean_total,
      neutral: !!opts.neutral, source: 'power_rating', rating_source: src };
  }
  return null;
}
