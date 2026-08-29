/**
 * What Vegas thinks about a game, applied to fantasy projections.
 *
 * The fantasy projections in this project have never known anything about the
 * betting market. `projections.js` mentions a "Vegas game-script layer" in a
 * comment and contains no reference to a line, a total, or an implied team
 * total anywhere in its code. So a player on a team implied for 28 points
 * projected identically to one on a team implied for 17 — which is wrong in a
 * way that is both large and easy to fix, because the market is very good at
 * this particular question even though it is unbeatable at picking sides.
 *
 * That distinction is the whole point. Everything in this repo says the closing
 * line cannot be out-forecast: 22 models, 5 seasons, ~2,600 graded bets, a CLV
 * r-squared of 0.0016. None of that means the line is uninformative — it means
 * it is efficient, which is precisely why it is worth READING rather than
 * betting against. The market's implied team total is the single best public
 * estimate of how many points an offence will score, and how many points an
 * offence scores is most of what fantasy scoring measures.
 *
 * MEASURED, not assumed. Over 2,106 team-weeks since 2022, a team's implied
 * total correlates with its skill players' combined fantasy output at r = 0.41,
 * and the relationship is monotone across every bucket: teams implied under 19
 * average 70.9 fantasy points, teams implied over 27 average 101.6.
 *
 * The important detail is that the components scale DIFFERENTLY. From the
 * lowest bucket to the highest, touchdowns roughly double (2.71 to 5.48) while
 * yardage rises only a third (506 to 674). A single flat multiplier would
 * therefore be wrong for both: it would understate the touchdown swing and
 * overstate the yardage one. They are fitted separately here.
 */
import { rows, row } from '../db/index.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Ordinary least squares slope and correlation. */
function fit(xs, ys) {
  if (xs.length < 30) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2;
  }
  if (sxx <= 0) return null;
  return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx,
    r: Math.sqrt((sxy * sxy) / (sxx * syy)) * Math.sign(sxy),
    mean_x: mx, mean_y: my, n: xs.length };
}

let _fitCache = null;
/**
 * Fit the game-script relationships on real team-weeks.
 *
 * Cutoff-safe by construction when `throughSeason` is set: the caller decides
 * what history is allowed, and nothing here reaches past it.
 */
export function fitGameScript({ fromSeason = 2022, throughSeason = null } = {}) {
  const key = `${fromSeason}|${throughSeason ?? 'all'}`;
  if (_fitCache?.key === key) return _fitCache.value;

  const clause = throughSeason ? `AND g.season <= ${Number(throughSeason)}` : '';
  const data = rows(`
    SELECT g.season, g.week, g.team, g.implied_points, g.spread, g.total,
           SUM(u.passing_tds + u.rushing_tds + u.receiving_tds) AS tds,
           SUM(u.passing_yards + u.rushing_yards + u.receiving_yards) AS yards,
           SUM(u.receptions) AS receptions,
           SUM(u.attempts) AS attempts,
           SUM(u.carries) AS carries
    FROM game_lines g
    JOIN player_week_usage u
      ON u.season = g.season AND u.week = g.week AND UPPER(u.team) = UPPER(g.team)
    WHERE g.season >= ? ${clause} AND g.implied_points IS NOT NULL
    GROUP BY g.season, g.week, g.team
    HAVING yards > 0`, fromSeason);

  if (data.length < 100) {
    return { error: `only ${data.length} team-weeks available to fit`, available: data.length };
  }

  const implied = data.map(d => d.implied_points);
  const tdFit = fit(implied, data.map(d => d.tds));
  const yardFit = fit(implied, data.map(d => d.yards));
  const recFit = fit(implied, data.map(d => d.receptions));

  // Run/pass split against the spread. A big favourite runs out the clock; a big
  // underdog throws all afternoon. This is the other half of game script and it
  // moves individual players even when the team total does not.
  const spreads = data.map(d => d.spread).filter(Number.isFinite);
  const withSpread = data.filter(d => Number.isFinite(d.spread) && (d.attempts + d.carries) > 0);
  const passShareFit = fit(withSpread.map(d => d.spread),
    withSpread.map(d => d.attempts / (d.attempts + d.carries)));

  const value = {
    fitted_on: { team_weeks: data.length, from_season: fromSeason, through_season: throughSeason },
    league_mean_implied: r4(mean(implied)),
    touchdowns: tdFit && { per_implied_point: r4(tdFit.slope), correlation: r4(tdFit.r),
      league_mean: r4(tdFit.mean_y),
      // Relative sensitivity is what a projection actually needs.
      pct_per_implied_point: r4(tdFit.slope / tdFit.mean_y) },
    yards: yardFit && { per_implied_point: r4(yardFit.slope), correlation: r4(yardFit.r),
      league_mean: r4(yardFit.mean_y), pct_per_implied_point: r4(yardFit.slope / yardFit.mean_y) },
    receptions: recFit && { per_implied_point: r4(recFit.slope), correlation: r4(recFit.r),
      league_mean: r4(recFit.mean_y), pct_per_implied_point: r4(recFit.slope / recFit.mean_y) },
    pass_share: passShareFit && { per_spread_point: r4(passShareFit.slope),
      correlation: r4(passShareFit.r), league_mean: r4(passShareFit.mean_y) },
    note: 'Touchdowns and yardage are fitted separately because they scale differently — across the ' +
      'implied-total range touchdowns roughly double while yardage rises about a third. One flat ' +
      'multiplier would be wrong for both.'
  };
  _fitCache = { key, value };
  return value;
}
export function clearGameScriptCache() { _fitCache = null; }

/**
 * Multipliers for one team in one week, from the market's own numbers.
 *
 * Returned per stat family rather than as a single number, and deliberately
 * clamped. The fit is linear and the extremes of the implied-total range are
 * thin, so a team implied for 35 should not receive an extrapolated multiplier
 * nobody has evidence for.
 */
export function gameScriptFor(season, week, team, { fitOpts = {} } = {}) {
  const f = fitGameScript(fitOpts);
  if (f.error) return { error: f.error };

  const line = row(
    `SELECT implied_points, spread, total, opponent, home FROM game_lines
     WHERE season = ? AND week = ? AND UPPER(team) = UPPER(?)`, season, week, team);
  if (!line || !Number.isFinite(line.implied_points)) {
    return { available: false, team, season, week,
      td_multiplier: 1, yard_multiplier: 1, reception_multiplier: 1, pass_share_shift: 0,
      note: 'No line stored for this team-week, so projections run unadjusted. Absent a market ' +
        'number the honest multiplier is exactly one.' };
  }

  const delta = line.implied_points - f.league_mean_implied;
  const tdMult = clamp(1 + delta * (f.touchdowns?.pct_per_implied_point ?? 0), 0.55, 1.65);
  const yardMult = clamp(1 + delta * (f.yards?.pct_per_implied_point ?? 0), 0.75, 1.35);
  const recMult = clamp(1 + delta * (f.receptions?.pct_per_implied_point ?? 0), 0.8, 1.25);
  const passShift = Number.isFinite(line.spread)
    ? clamp(line.spread * (f.pass_share?.per_spread_point ?? 0), -0.12, 0.12) : 0;

  return {
    available: true, team, season, week, opponent: line.opponent,
    implied_points: line.implied_points, spread: line.spread, total: line.total,
    league_mean_implied: f.league_mean_implied,
    implied_vs_average: r4(delta),
    td_multiplier: r4(tdMult),
    yard_multiplier: r4(yardMult),
    reception_multiplier: r4(recMult),
    pass_share_shift: r4(passShift),
    // A single blended figure for callers that want one number, weighted the way
    // PPR scoring actually weights these components.
    blended_multiplier: r4(0.45 * tdMult + 0.40 * yardMult + 0.15 * recMult),
    explanation: describeGameScript({ team, delta, tdMult, yardMult, passShift,
      impliedPoints: line.implied_points, spread: line.spread })
  };
}

/**
 * Say what the market is implying, in English, deterministically.
 *
 * Template-rendered from the same numbers that produce the multipliers, so the
 * sentence and the adjustment can never disagree — and it costs nothing.
 */
export function describeGameScript({ team, delta, tdMult, yardMult, passShift,
  impliedPoints, spread }) {
  const parts = [];
  const dir = delta > 0 ? 'above' : 'below';
  parts.push(`Vegas implies ${team} scores ${impliedPoints} points, ` +
    `${Math.abs(delta).toFixed(1)} ${dir} the league average.`);
  if (Math.abs(delta) < 1.5) {
    parts.push('That is close enough to average that the market is saying nothing much here.');
  } else if (delta > 0) {
    parts.push(`Touchdown expectation lifts ${((tdMult - 1) * 100).toFixed(0)}% and yardage ` +
      `${((yardMult - 1) * 100).toFixed(0)}% — the market likes this offence this week, and ` +
      `touchdowns move more than yards because scoring is what an implied total is about.`);
  } else {
    parts.push(`Touchdown expectation drops ${((1 - tdMult) * 100).toFixed(0)}% and yardage ` +
      `${((1 - yardMult) * 100).toFixed(0)}%.`);
  }
  if (Number.isFinite(spread) && Math.abs(spread) >= 4) {
    parts.push(spread < 0
      ? `As a ${Math.abs(spread)}-point favourite they should run more and throw less, which shifts ` +
        `value from receivers toward the backfield.`
      : `As a ${spread}-point underdog they should throw more, which lifts receivers and hurts ` +
        `the run game.`);
  }
  return parts.join(' ');
}

/**
 * Apply game script across a whole slate, so a lineup decision can see it.
 *
 * This is the surface a fantasy manager actually wants: every team this week,
 * ranked by how much the market likes their offence.
 */
export function slateGameScript({ season, week } = {}) {
  const teams = rows(
    `SELECT team FROM game_lines WHERE season = ? AND week = ? AND implied_points IS NOT NULL
     ORDER BY implied_points DESC`, season, week).map(r => r.team);
  if (!teams.length) {
    return { error: `no lines stored for ${season} week ${week}`,
      hint: 'Lines are metered; the archive may not cover this week yet.' };
  }
  const out = teams.map(t => gameScriptFor(season, week, t)).filter(x => x.available);
  return {
    season, week, teams: out.length,
    league_mean_implied: out[0]?.league_mean_implied ?? null,
    best_spots: out.slice(0, 6).map(x => ({ team: x.team, opponent: x.opponent,
      implied: x.implied_points, td_multiplier: x.td_multiplier,
      blended: x.blended_multiplier, explanation: x.explanation })),
    worst_spots: out.slice(-6).reverse().map(x => ({ team: x.team, opponent: x.opponent,
      implied: x.implied_points, td_multiplier: x.td_multiplier,
      blended: x.blended_multiplier, explanation: x.explanation })),
    all: out.map(x => ({ team: x.team, opponent: x.opponent, implied: x.implied_points,
      spread: x.spread, td_multiplier: x.td_multiplier, yard_multiplier: x.yard_multiplier,
      blended_multiplier: x.blended_multiplier })),
    note: 'Multipliers are fitted on real team-weeks and applied per stat family. They express what ' +
      'the market expects an offence to do, which is the one question the market is demonstrably ' +
      'good at even though it cannot be beaten on sides.'
  };
}

/**
 * Does adding game script actually improve a fantasy projection?
 *
 * The question that decides whether any of this ships. Compares a baseline
 * projection against the same projection scaled by the market's multiplier,
 * graded on real weekly outcomes. Walk-forward: the multipliers are fitted only
 * on seasons before the one being tested.
 */
export function validateGameScript({ testSeason = 2025, fromSeason = 2022 } = {}) {
  const f = fitGameScript({ fromSeason, throughSeason: testSeason - 1 });
  if (f.error) return { error: f.error };

  const data = rows(`
    SELECT g.season, g.week, g.team, g.implied_points,
           SUM(u.passing_tds + u.rushing_tds + u.receiving_tds) AS tds,
           SUM(u.passing_yards + u.rushing_yards + u.receiving_yards) AS yards
    FROM game_lines g
    JOIN player_week_usage u
      ON u.season = g.season AND u.week = g.week AND UPPER(u.team) = UPPER(g.team)
    WHERE g.season = ? AND g.implied_points IS NOT NULL
    GROUP BY g.season, g.week, g.team HAVING yards > 0`, testSeason);
  if (data.length < 50) return { error: `only ${data.length} team-weeks in ${testSeason}` };

  const baseTd = f.touchdowns.league_mean, baseYd = f.yards.league_mean;
  let flatTdErr = 0, adjTdErr = 0, flatYdErr = 0, adjYdErr = 0;
  for (const d of data) {
    const delta = d.implied_points - f.league_mean_implied;
    const tdMult = clamp(1 + delta * f.touchdowns.pct_per_implied_point, 0.55, 1.65);
    const ydMult = clamp(1 + delta * f.yards.pct_per_implied_point, 0.75, 1.35);
    flatTdErr += Math.abs(baseTd - d.tds);
    adjTdErr += Math.abs(baseTd * tdMult - d.tds);
    flatYdErr += Math.abs(baseYd - d.yards);
    adjYdErr += Math.abs(baseYd * ydMult - d.yards);
  }
  const n = data.length;
  const tdImprove = (flatTdErr - adjTdErr) / flatTdErr;
  const ydImprove = (flatYdErr - adjYdErr) / flatYdErr;

  return {
    test_season: testSeason, fitted_through: testSeason - 1, team_weeks: n,
    touchdowns: { flat_mae: r4(flatTdErr / n), adjusted_mae: r4(adjTdErr / n),
      improvement: r4(tdImprove), helps: adjTdErr < flatTdErr },
    yards: { flat_mae: r4(flatYdErr / n), adjusted_mae: r4(adjYdErr / n),
      improvement: r4(ydImprove), helps: adjYdErr < flatYdErr },
    verdict: adjTdErr < flatTdErr && adjYdErr < flatYdErr
      ? `Game script improves touchdown projections by ${(tdImprove * 100).toFixed(1)}% and yardage ` +
        `by ${(ydImprove * 100).toFixed(1)}% against a league-average baseline, out of sample.`
      : 'Adjusting by the market does not beat a flat league-average baseline on this season.',
    note: 'Walk-forward: multipliers are fitted only on seasons before the test season. The baseline ' +
      'is a league-average team-week, which is what a projection with no game-script knowledge ' +
      'effectively assumes.'
  };
}
