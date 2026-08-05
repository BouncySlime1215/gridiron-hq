/**
 * First-party MLB projections.
 *
 * The MLB board was proxying a separate repo's published CSVs, which meant the
 * whole hub went stale whenever that pipeline stopped running — and it did, for
 * sixteen days. Since this project now ingests MLB games and player logs
 * directly, there is no reason to depend on someone else's schedule.
 *
 * Same philosophy as the football side: volume x rate, shrunk toward a
 * population mean so a two-game sample does not masquerade as a true talent
 * level, then simulated rather than reported as a point estimate. A prop asks
 * "does he clear 1.5 total bases", which is a question about a distribution.
 */
import { rows } from '../db/index.js';
import { mean } from './stats-util.js';
import { starterFor } from './mlb.js';

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const leagueCache = new Map();
const battingEnvironmentCache = new Map();
const opponentKCache = new Map();

/**
 * Shrinks an observed rate toward a prior. With `k` games of prior weight, a
 * player with few games sits near the league mean and earns his own number as
 * the sample grows. Without this, a hitter who is 3-for-6 projects as a .500
 * hitter, which is how naive projection systems embarrass themselves.
 */
const shrink = (observed, prior, n, k) =>
  n + k > 0 ? (observed * n + prior * k) / (n + k) : prior;

/* ------------------------------------------------------------- population */

/** League-average rates from the seasons on hand, used as the shrink target. */
function leagueRates(season, throughDate) {
  const key = `${season}|${throughDate}`;
  if (leagueCache.has(key)) return leagueCache.get(key);
  const b = rows(`SELECT SUM(at_bats) ab, SUM(hits) h, SUM(total_bases) tb,
                         SUM(home_runs) hr, COUNT(*) g
                  FROM mlb_batter_games
                  WHERE season = ? AND date < ? AND at_bats > 0`, season, throughDate)[0];
  const p = rows(`SELECT SUM(strikeouts) k, SUM(innings_pitched) ip, SUM(earned_runs) er,
                         SUM(batters_faced) bf, COUNT(*) g
                  FROM mlb_pitcher_games
                  WHERE season = ? AND date < ? AND innings_pitched > 0`, season, throughDate)[0];
  const out = {
    tb_per_ab: b?.ab ? b.tb / b.ab : 0.4,
    hit_per_ab: b?.ab ? b.h / b.ab : 0.25,
    hr_per_ab: b?.ab ? b.hr / b.ab : 0.035,
    ab_per_game: b?.g ? b.ab / b.g : 3.8,
    k_per_bf: p?.bf ? p.k / p.bf : 0.22,
    er_per_bf: p?.bf ? p.er / p.bf : 0.105,
    bf_per_start: 24
  };
  leagueCache.set(key, out);
  return out;
}

/* ---------------------------------------------------------------- batters */

/**
 * Projects a batter's line for one game.
 * `throughDate` keeps this honest — only games strictly before it are used.
 */
export function projectBatter(playerId, season, throughDate, { opponentId = null, venue = null } = {}) {
  const g = rows(`SELECT * FROM mlb_batter_games
                  WHERE player_id = ? AND season = ? AND date < ?
                  ORDER BY date`, playerId, season, throughDate);
  if (g.length < 5) return null;

  // Population priors must obey the same cutoff as the player history. Using the
  // completed season here made a July backtest borrow league rates from August
  // and September even though the player's own query was correctly date-bounded.
  const lg = leagueRates(season, throughDate);
  const ab = g.reduce((s, x) => s + x.at_bats, 0);
  const tb = g.reduce((s, x) => s + x.total_bases, 0);
  const hits = g.reduce((s, x) => s + x.hits, 0);
  const hr = g.reduce((s, x) => s + x.home_runs, 0);

  // Recent form carries real information for hitters, but a 10-game hot streak
  // is mostly noise, so it is blended rather than trusted outright.
  const recent = g.slice(-15);
  const recentAb = recent.reduce((s, x) => s + x.at_bats, 0);
  const recentTb = recent.reduce((s, x) => s + x.total_bases, 0);

  const tbRateAll = ab > 0 ? tb / ab : lg.tb_per_ab;
  const tbRateRecent = recentAb > 0 ? recentTb / recentAb : tbRateAll;
  const baseTbRate = shrink(0.7 * tbRateAll + 0.3 * tbRateRecent, lg.tb_per_ab, ab, 60);
  const matchup = battingEnvironment(season, throughDate, opponentId, venue);
  const tbRate = baseTbRate * matchup.factor;

  const expectedAb = shrink(ab / g.length, lg.ab_per_game, g.length, 10);

  const hitRate = shrink(ab > 0 ? hits / ab : lg.hit_per_ab, lg.hit_per_ab, ab, 60);
  const hrRate = shrink(ab > 0 ? hr / ab : lg.hr_per_ab, lg.hr_per_ab, ab, 120);
  const hrPerHit = Math.min(0.9, hrRate / Math.max(0.01, hitRate));
  const basesPerHit = tbRate / Math.max(0.01, hitRate);
  // Preserve the projected TB/AB exactly in the simulation. After separating
  // home runs, represent the remaining extra-base value as a mixture of adjacent
  // integer outcomes instead of the old hard-coded 28% double rate.
  const nonHrBases = Math.max(1, Math.min(3,
    (basesPerHit - 4 * hrPerHit) / Math.max(0.01, 1 - hrPerHit)));

  return {
    player_id: playerId,
    name: g[g.length - 1].player_name,
    team_id: g[g.length - 1].team_id,
    games: g.length,
    expected_ab: r3(expectedAb),
    tb_per_ab: r3(tbRate),
    hit_per_ab: r3(hitRate),
    hr_per_ab: r3(hrRate),
    hr_per_hit: r3(hrPerHit),
    non_hr_bases: r3(nonHrBases),
    matchup_factor: r3(matchup.factor),
    matchup_context: matchup,
    projected_tb: r3(expectedAb * tbRate)
  };
}

function battingEnvironment(season, throughDate, opponentId, venue) {
  const key = `${season}|${throughDate}|${opponentId ?? ''}|${venue ?? ''}`;
  if (battingEnvironmentCache.has(key)) return battingEnvironmentCache.get(key);
  const lg = rows(`SELECT SUM(earned_runs) er, SUM(batters_faced) bf
                   FROM mlb_pitcher_games WHERE season=? AND date<? AND batters_faced>0`,
                  season, throughDate)[0];
  const opp = opponentId == null ? null : rows(`SELECT SUM(earned_runs) er, SUM(batters_faced) bf
                                                FROM mlb_pitcher_games
                                                WHERE season=? AND date<? AND team_id=? AND batters_faced>0`,
                                               season, throughDate, opponentId)[0];
  const lgEr = lg?.bf ? lg.er / lg.bf : 0.105;
  const oppEr = opp?.bf ? shrink(opp.er / opp.bf, lgEr, opp.bf, 600) : lgEr;
  const pitching = Math.max(0.9, Math.min(1.1, (oppEr / Math.max(0.01, lgEr)) ** 0.45));

  const park = venue ? rows(`SELECT SUM(b.total_bases) tb, SUM(b.at_bats) ab
                             FROM mlb_batter_games b JOIN mlb_games g ON g.game_pk=b.game_pk
                             WHERE b.season=? AND b.date<? AND g.venue=? AND b.at_bats>0`,
                            season, throughDate, venue)[0] : null;
  const leagueTb = rows(`SELECT SUM(total_bases) tb, SUM(at_bats) ab FROM mlb_batter_games
                         WHERE season=? AND date<? AND at_bats>0`, season, throughDate)[0];
  const lgTb = leagueTb?.ab ? leagueTb.tb / leagueTb.ab : 0.4;
  const parkTb = park?.ab ? shrink(park.tb / park.ab, lgTb, park.ab, 1000) : lgTb;
  const parkFactor = Math.max(0.92, Math.min(1.08, parkTb / Math.max(0.01, lgTb)));
  const out = { factor: pitching * parkFactor, opponent_pitching_factor: pitching, park_factor: parkFactor };
  battingEnvironmentCache.set(key, out);
  return out;
}

/** Simulated distribution of a batter's total bases, and the over probabilities. */
export function batterTotalBases(proj, lines = [0.5, 1.5, 2.5]) {
  if (!proj) return null;
  const severity = positiveBaseDistribution(proj);
  return {
    ...proj,
    mean_tb: r3(proj.expected_ab * proj.tb_per_ab),
    probabilities: Object.fromEntries(lines.map(l =>
      [`over_${l}`, r3(compoundPoissonOver(proj.expected_ab * proj.hit_per_ab, severity, l))]))
  };
}

/** Conditional base value for a hit, preserving the projection's exact mean. */
function positiveBaseDistribution(proj) {
  const hr = Math.max(0, Math.min(1, proj.hr_per_hit));
  const x = Math.max(1, Math.min(3, proj.non_hr_bases));
  const lo = Math.floor(x), hi = Math.ceil(x), up = x - lo;
  const f = [0, 0, 0, 0, hr];
  f[lo] += (1 - hr) * (1 - up);
  f[hi] += (1 - hr) * up;
  return f;
}

/** Exact tail of a compound Poisson with integer severities (Panjer recursion). */
function compoundPoissonOver(rate, severity, line) {
  const max = Math.floor(line);
  const p = new Array(max + 1).fill(0);
  p[0] = Math.exp(-Math.max(0, rate));
  for (let n = 1; n <= max; n++) {
    let s = 0;
    for (let j = 1; j <= Math.min(n, severity.length - 1); j++) s += j * severity[j] * p[n - j];
    p[n] = rate * s / n;
  }
  return Math.max(0, Math.min(1, 1 - p.reduce((s, v) => s + v, 0)));
}

/* --------------------------------------------------------------- pitchers */

export function projectPitcher(playerId, season, throughDate, { opponentId = null } = {}) {
  const g = rows(`SELECT * FROM mlb_pitcher_games
                  WHERE player_id = ? AND season = ? AND date < ? AND games_started = 1
                  ORDER BY date`, playerId, season, throughDate);
  if (g.length < 3) return null;

  const lg = leagueRates(season, throughDate);
  const bf = g.reduce((s, x) => s + (x.batters_faced ?? 0), 0);
  const k = g.reduce((s, x) => s + x.strikeouts, 0);
  const ip = g.reduce((s, x) => s + (x.innings_pitched ?? 0), 0);

  const baseKRate = shrink(bf > 0 ? k / bf : lg.k_per_bf, lg.k_per_bf, bf, 200);
  const opponent = opponentStrikeoutFactor(season, throughDate, opponentId);
  const kRate = baseKRate * opponent;
  const expectedBf = shrink(g.length ? bf / g.length : lg.bf_per_start, lg.bf_per_start, g.length, 5);
  const er = g.reduce((s, x) => s + (x.earned_runs ?? 0), 0);
  const leagueErRate = lg.er_per_bf;
  const erRate = shrink(bf ? er / bf : leagueErRate, leagueErRate, bf, 250);

  return {
    player_id: playerId,
    name: g[g.length - 1].player_name,
    team_id: g[g.length - 1].team_id,
    starts: g.length,
    expected_bf: r3(expectedBf),
    k_per_bf: r3(kRate),
    opponent_k_factor: r3(opponent),
    run_environment_factor: r3(Math.max(0.82, Math.min(1.18, erRate / Math.max(0.01, leagueErRate)))),
    ip_per_start: r3(g.length ? ip / g.length : 5),
    projected_k: r3(expectedBf * kRate)
  };
}

function opponentStrikeoutFactor(season, throughDate, opponentId) {
  if (opponentId == null) return 1;
  const key = `${season}|${throughDate}|${opponentId}`;
  if (opponentKCache.has(key)) return opponentKCache.get(key);
  const league = rows(`SELECT SUM(strikeouts) k, SUM(batters_faced) bf FROM mlb_pitcher_games
                       WHERE season=? AND date<? AND batters_faced>0`, season, throughDate)[0];
  const opp = rows(`SELECT SUM(strikeouts) k, SUM(batters_faced) bf FROM mlb_pitcher_games
                    WHERE season=? AND date<? AND opponent_id=? AND batters_faced>0`,
                   season, throughDate, opponentId)[0];
  const lg = league?.bf ? league.k / league.bf : 0.22;
  const rate = opp?.bf ? shrink(opp.k / opp.bf, lg, opp.bf, 500) : lg;
  const out = Math.max(0.88, Math.min(1.12, rate / Math.max(0.01, lg)));
  opponentKCache.set(key, out);
  return out;
}

export function pitcherStrikeouts(proj, lines = [4.5, 5.5, 6.5, 7.5]) {
  if (!proj) return null;
  // Poisson thinning: if BF ~ Poisson(lambda) and each BF becomes a strikeout
  // independently with probability p, K is exactly Poisson(lambda*p).
  const lambda = proj.expected_bf * Math.min(0.6, proj.k_per_bf);
  return {
    ...proj,
    mean_k: r3(lambda),
    probabilities: Object.fromEntries(lines.map(l =>
      [`over_${l}`, r3(1 - poissonCdf(Math.floor(l), lambda))]))
  };
}

function poissonCdf(k, lambda) {
  let term = Math.exp(-lambda), sum = term;
  for (let i = 1; i <= k; i++) { term *= lambda / i; sum += term; }
  return Math.max(0, Math.min(1, sum));
}

/* ------------------------------------------------------------------- NRFI */

/**
 * No runs in the first inning, from the two starting pitchers and the two
 * lineups that face them. Uses each team's own first-inning history rather than
 * a league constant, since lineup construction genuinely differs.
 */
export function nrfiFor(season, homeTeamId, awayTeamId, throughDate, { venue = null } = {}) {
  const teamFirst = teamId => {
    const g = rows(`SELECT first_inning_home_runs h, first_inning_away_runs a, home_team_id, away_team_id
                    FROM mlb_games
                    WHERE season = ? AND date < ? AND (home_team_id = ? OR away_team_id = ?)`,
      season, throughDate, teamId, teamId);
    if (!g.length) return null;
    const scored = g.filter(x => (x.home_team_id === teamId ? x.h : x.a) > 0).length;
    return { games: g.length, first_inning_score_rate: scored / g.length };
  };
  const h = teamFirst(homeTeamId), a = teamFirst(awayTeamId);
  if (!h || !a) return null;
  // First-inning rates are noisy even over a full season. Shrink each offense
  // toward the date-bounded league rate instead of treating a 10-game streak as
  // true talent. Twelve games of prior weight keeps the estimate responsive.
  const league = rows(`SELECT AVG(CASE WHEN first_inning_home_runs > 0 THEN 1.0 ELSE 0.0 END) home_rate,
                              AVG(CASE WHEN first_inning_away_runs > 0 THEN 1.0 ELSE 0.0 END) away_rate
                       FROM mlb_games
                       WHERE season = ? AND date < ? AND yrfi IS NOT NULL`, season, throughDate)[0];
  const prior = ((league?.home_rate ?? 0.27) + (league?.away_rate ?? 0.23)) / 2;
  const hRate = shrink(h.first_inning_score_rate, prior, h.games, 12);
  const aRate = shrink(a.first_inning_score_rate, prior, a.games, 12);
  const homeStarter = starterFor(homeTeamId, throughDate);
  const awayStarter = starterFor(awayTeamId, throughDate);
  const hp = homeStarter ? projectPitcher(homeStarter.player_id, season, throughDate, { opponentId: awayTeamId }) : null;
  const ap = awayStarter ? projectPitcher(awayStarter.player_id, season, throughDate, { opponentId: homeTeamId }) : null;
  const venueRows = venue ? rows(`SELECT yrfi FROM mlb_games
                                  WHERE season=? AND date<? AND venue=? AND yrfi IS NOT NULL`,
                                 season, throughDate, venue) : [];
  const allRows = rows(`SELECT yrfi FROM mlb_games WHERE season=? AND date<? AND yrfi IS NOT NULL`, season, throughDate);
  const leagueYrfi = allRows.length ? mean(allRows.map(x => x.yrfi)) : 0.5;
  const venueYrfi = venueRows.length
    ? shrink(mean(venueRows.map(x => x.yrfi)), leagueYrfi, venueRows.length, 40)
    : leagueYrfi;
  const park = Math.max(0.9, Math.min(1.1, venueYrfi / Math.max(0.05, leagueYrfi)));
  const hAdj = Math.max(0.04, Math.min(0.65, hRate * (ap?.run_environment_factor ?? 1) * park));
  const aAdj = Math.max(0.04, Math.min(0.65, aRate * (hp?.run_environment_factor ?? 1) * park));
  // Independence is an approximation — the two halves of an inning are played
  // against different pitchers, so it is a reasonable one.
  const pNoRun = (1 - hAdj) * (1 - aAdj);
  return {
    home_first_inning_rate: r3(hAdj),
    away_first_inning_rate: r3(aAdj),
    park_factor: r3(park),
    home_starter: homeStarter?.player_name ?? null,
    away_starter: awayStarter?.player_name ?? null,
    games_sampled: h.games + a.games,
    nrfi_probability: r3(pNoRun),
    yrfi_probability: r3(1 - pNoRun)
  };
}

/* ------------------------------------------------------------------ board */

/** Today's games from our own schedule table — never a proxied slate. */
export function slateFor(date) {
  return rows(`SELECT game_pk, date, home_team, away_team, home_team_id, away_team_id, venue
               FROM mlb_games WHERE date = ? ORDER BY game_pk`, date);
}

/**
 * A full first-party board for one date: NRFI per game, plus the batters and
 * pitchers with enough history to project.
 */
export function boardFor(requestedDate, { season: seasonOpt, limit = 40 } = {}) {
  let date = requestedDate;
  let season = seasonOpt ?? Number(String(date).slice(0, 4));
  let games = slateFor(date);
  let fellBack = null;

  // Asking for a date that has not been synced yet — most often today, before
  // the day's games have been pulled — should show the most recent real slate
  // rather than an empty page. The substitution is reported, not hidden.
  if (!games.length) {
    const latest = rows(`SELECT date FROM mlb_games WHERE date <= ? ORDER BY date DESC LIMIT 1`, date)[0];
    if (latest?.date) {
      fellBack = { requested: requestedDate, showing: latest.date };
      date = latest.date;
      season = Number(String(date).slice(0, 4));
      games = slateFor(date);
    }
  }

  if (!games.length) {
    return {
      date, season, games: [], batters: [], pitchers: [],
      note: `No games stored on or before ${requestedDate}. Sync a season first (POST /api/mlb/sync?season=${season}).`
    };
  }

  const teamIds = new Set(games.flatMap(g => [g.home_team_id, g.away_team_id]));

  const withNrfi = games.map(g => ({
    ...g,
    matchup: `${g.away_team} at ${g.home_team}`,
    nrfi: nrfiFor(season, g.home_team_id, g.away_team_id, date, { venue: g.venue })
  }));

  // Only project players on teams actually playing today.
  const batterIds = rows(`SELECT player_id, MAX(date) last_seen FROM mlb_batter_games
                          WHERE season = ? AND date < ? AND team_id IN (${[...teamIds].map(() => '?').join(',')})
                          GROUP BY player_id HAVING COUNT(*) >= 15`,
                          season, date, ...teamIds).map(r => r.player_id);

  // The pitcher for each of today's games specifically — confirmed probable
  // for today/future, the real box-score starter for past dates — rather than
  // the best arm anywhere in a five-man rotation. A rotation makes any given
  // starter wrong four days out of five if his talent alone is the filter.
  const pitcherIds = [...new Set(games.flatMap(g =>
    [starterFor(g.home_team_id, date), starterFor(g.away_team_id, date)]
  ).filter(Boolean).map(s => s.player_id))];

  const batters = batterIds
    .map(id => {
      const last = rows(`SELECT team_id FROM mlb_batter_games WHERE player_id=? AND date<? ORDER BY date DESC LIMIT 1`, id, date)[0];
      const game = games.find(g => g.home_team_id === last?.team_id || g.away_team_id === last?.team_id);
      if (!game) return null;
      const opponentId = game.home_team_id === last.team_id ? game.away_team_id : game.home_team_id;
      return batterTotalBases(projectBatter(id, season, date, { opponentId, venue: game.venue }));
    })
    .filter(Boolean)
    .sort((a, b) => b.mean_tb - a.mean_tb)
    .slice(0, limit);

  const pitchers = pitcherIds
    .map(id => {
      const start = games.flatMap(g => [
        { game: g, team: g.home_team_id, opp: g.away_team_id, starter: starterFor(g.home_team_id, date) },
        { game: g, team: g.away_team_id, opp: g.home_team_id, starter: starterFor(g.away_team_id, date) }
      ]).find(x => x.starter?.player_id === id);
      return start ? pitcherStrikeouts(projectPitcher(id, season, date, { opponentId: start.opp })) : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mean_k - a.mean_k)
    .slice(0, limit);

  return {
    date, season,
    games: withNrfi,
    batters, pitchers,
    fell_back: fellBack,
    source: 'first-party — built from this project\'s own MLB Stats API ingestion',
    note: fellBack
      ? `No games were stored for ${fellBack.requested}, so this shows the most recent slate (${fellBack.showing}). Run a sync to pull newer games.`
      : 'Projections use only games before this date. No market prices are attached; this is the model side only.'
  };
}

/** How much MLB history is actually available to project from. */
export function coverage() {
  return {
    games: rows(`SELECT season, COUNT(*) games, MIN(date) first, MAX(date) last
                 FROM mlb_games GROUP BY season ORDER BY season`),
    batters: rows(`SELECT season, COUNT(*) rows, COUNT(DISTINCT player_id) players
                   FROM mlb_batter_games GROUP BY season ORDER BY season`),
    pitchers: rows(`SELECT season, COUNT(*) rows, COUNT(DISTINCT player_id) players
                    FROM mlb_pitcher_games GROUP BY season ORDER BY season`)
  };
}

export const __test = { positiveBaseDistribution, compoundPoissonOver, poissonCdf };
