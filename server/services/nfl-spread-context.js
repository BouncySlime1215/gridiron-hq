/**
 * How a team performs against the number, rather than against opponents.
 *
 * The ensemble already projects a margin and compares it to the market. What it
 * has never had is context on the two teams' relationship WITH the spread —
 * their record against it, how that splits home and away, whether their scoring
 * margin is being flattered or hidden by the numbers they have been given, and
 * whether their underlying efficiency agrees with any of it.
 *
 * Without that, a pick is a bare number. With it, a pick can be explained:
 * "the model has Buffalo by 6 where the market says 3.5, and Buffalo has beaten
 * the number in 7 of 10 as a home favourite while their opponent's efficiency
 * has been running well behind their record."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT ATS RECORDS ARE, AND ARE NOT
 *
 * A cover record is the single most quoted statistic in football betting and one
 * of the least predictive. Over a full season an average team covers about half
 * the time by construction, because the spread is set to make that true; a 7-3
 * ATS run is inside the noise of ten coin flips and reverts immediately. Nothing
 * here should be read as "this team covers", and the output says so.
 *
 * What the split IS useful for is DESCRIPTION — it tells you what has been
 * happening, which is exactly what a reasoning trace needs. And two of these
 * measures are genuinely more than description:
 *
 *   COVER MARGIN, the average points by which a team beat or missed its number,
 *   carries more information than the win/loss record because it does not throw
 *   away magnitude. A team 5-5 ATS by an average of half a point is a different
 *   team from one 5-5 by six.
 *
 *   THE EFFICIENCY-RECORD GAP is the useful one. A team whose EPA per play is
 *   strong while its record is poor has usually been unlucky rather than bad,
 *   and that gap closes; the reverse also holds. This is the same logic as the
 *   touchdown-regression model applied at team level.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CUTOFF SAFETY
 *
 * Every function takes `throughWeek` and reads games STRICTLY BEFORE it. This is
 * not defensive habit — the whole point of these features is to feed a blind
 * replay, and a single leaked week would make the audit meaningless while
 * looking like a breakthrough. The queries use `week < ?`, never `<=`.
 */
import { rows, row } from '../db/index.js';
import { cached, fingerprint } from './compute-cache.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/**
 * One team's relationship with the number, as of the start of a given week.
 *
 * @param lookback how many prior games to consider. Null walks the whole season
 *   to date; a number takes the most recent N, which is what "lately" means.
 */
export function atsProfile(team, season, { throughWeek = null, lookback = null } = {}) {
  const wk = throughWeek ?? 99;
  const games = rows(
    `SELECT week, opponent, home, spread, total, team_score, opp_score, rest_days, div_game, roof
     FROM game_lines
     WHERE team = ? AND season = ? AND week < ?
       AND spread IS NOT NULL AND team_score IS NOT NULL
     ORDER BY week`, team, season, wk);

  const considered = lookback ? games.slice(-lookback) : games;
  if (!considered.length) {
    return { team, season, through_week: wk, games: 0, insufficient: true,
      note: `No completed games with a recorded spread before week ${wk}.` };
  }

  // A team covers when its own margin beats the points it was giving or getting.
  // `spread` is from this team's perspective: negative means favoured.
  const scored = considered.map(g => {
    const margin = g.team_score - g.opp_score;
    // Cover margin: how far past the number the result landed. A favourite laying
    // 7 that wins by 10 covered by 3; a dog getting 7 that loses by 4 covered by 3.
    const coverMargin = margin + g.spread;
    return {
      week: g.week, opponent: g.opponent, home: !!g.home,
      spread: g.spread, margin, cover_margin: r2(coverMargin),
      covered: coverMargin > 0 ? 1 : coverMargin < 0 ? 0 : null,   // null is a push
      favoured: g.spread < 0, rest_days: g.rest_days, div_game: !!g.div_game
    };
  });

  const split = list => {
    const decided = list.filter(x => x.covered != null);
    const wins = decided.filter(x => x.covered).length;
    return {
      record: `${wins}-${decided.length - wins}${list.length - decided.length ? `-${list.length - decided.length}` : ''}`,
      games: list.length, covers: wins,
      cover_rate: decided.length ? r3(wins / decided.length) : null,
      // The number that carries magnitude rather than throwing it away.
      avg_cover_margin: list.length ? r2(list.reduce((s, x) => s + x.cover_margin, 0) / list.length) : null
    };
  };

  return {
    team, season, through_week: wk, lookback: lookback ?? 'season to date',
    games: considered.length,
    overall: split(scored),
    home: split(scored.filter(x => x.home)),
    away: split(scored.filter(x => !x.home)),
    as_favourite: split(scored.filter(x => x.favoured)),
    as_underdog: split(scored.filter(x => !x.favoured)),
    division: split(scored.filter(x => x.div_game)),
    recent: split(scored.slice(-4)),
    games_detail: scored,
    caveat: 'A cover record is close to a coin flip by construction — the spread is set to make it ' +
      'one. Read the average cover margin rather than the record: it keeps the magnitude that a ' +
      'win/loss count discards, and it is the half of this that carries information.'
  };
}

/**
 * Is a team's record keeping up with how it has actually played?
 *
 * Net EPA per play is the best available summary of team quality per snap, and
 * it is far more stable week to week than either point margin or a cover record.
 * When the two disagree, the efficiency number is usually the one that predicts
 * what happens next — the same reasoning as the touchdown-regression model, one
 * level up.
 */
export function efficiencyGap(team, season, { throughWeek = null } = {}) {
  const wk = throughWeek ?? 99;
  const feats = rows(
    `SELECT week, features FROM nfl_team_week_features
     WHERE team = ? AND season = ? AND week < ? ORDER BY week`, team, season, wk);
  if (feats.length < 2) {
    return { team, season, insufficient: true,
      note: 'Not enough completed weeks to compare efficiency against results.' };
  }

  const parsed = feats.map(f => JSON.parse(f.features));
  const mean = key => {
    const v = parsed.map(x => x[key]).filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const netEpa = mean('net_epa_per_play');
  const offEpa = mean('off_epa_per_play');
  const defEpa = mean('def_epa_per_play');

  // Where this sits in the league, so "0.04" means something.
  const league = leagueEpaDistribution(season, wk);
  const pct = v => {
    if (v == null || !league.values.length) return null;
    return r3(league.values.filter(x => x < v).length / league.values.length);
  };

  const ats = atsProfile(team, season, { throughWeek: wk });
  const coverRate = ats.overall?.cover_rate ?? null;
  const epaPct = pct(netEpa);

  // Both on a 0–1 scale, so the gap is comparable.
  const gap = epaPct != null && coverRate != null ? r3(epaPct - coverRate) : null;

  return {
    team, season, through_week: wk,
    net_epa_per_play: r3(netEpa),
    off_epa_per_play: r3(offEpa),
    def_epa_per_play: r3(defEpa),
    epa_percentile: epaPct,
    ats_cover_rate: coverRate,
    gap,
    reading: gap == null ? null
      : gap >= 0.25
        ? 'Playing considerably better than their record against the number suggests. That gap ' +
          'usually closes in the team\'s favour.'
        : gap <= -0.25
          ? 'Their record against the number is running ahead of how they have actually played. ' +
            'That is the direction that tends to correct against them.'
          : 'Efficiency and cover record broadly agree, so neither is telling you much the other is not.',
    caveat: 'Efficiency is measured on completed weeks only and says nothing about this week\'s ' +
      'matchup, injuries or weather.'
  };
}

/** League-wide net EPA per play up to a cutoff, for percentile context. */
function leagueEpaDistribution(season, throughWeek) {
  return cached(
    `epa-dist:${season}:${throughWeek}`,
    fingerprint([{ table: 'nfl_team_week_features', stamp: 'week' }], `${season}:${throughWeek}`),
    () => {
      const byTeam = new Map();
      for (const f of rows(
        `SELECT team, features FROM nfl_team_week_features
         WHERE season = ? AND week < ?`, season, throughWeek)) {
        const x = JSON.parse(f.features);
        if (!Number.isFinite(x.net_epa_per_play)) continue;
        if (!byTeam.has(f.team)) byTeam.set(f.team, []);
        byTeam.get(f.team).push(x.net_epa_per_play);
      }
      const values = [...byTeam.values()]
        .map(v => v.reduce((a, b) => a + b, 0) / v.length)
        .sort((a, b) => a - b);
      return { values, teams: byTeam.size };
    });
}

/**
 * Situational context for one specific game — the things that are true about
 * this matchup rather than about either team in general.
 */
export function gameContext(season, week, home, away) {
  const g = row(
    `SELECT * FROM game_lines WHERE season = ? AND week = ? AND team = ? AND home = 1`,
    season, week, home);
  // Shape-stable even when the game is missing. A consumer that has to check
  // `insufficient` before touching `situational_notes` will eventually forget,
  // and the reasoning layer below reads this on every pick — a bare `undefined`
  // there turns a missing line into a crash rather than a quieter answer.
  if (!g) {
    return { season, week, home, away, insufficient: true,
      market_spread: null, market_total: null, home_implied_points: null,
      rest_days: { home: null, away: null, edge: null },
      division_game: false, roof: null, surface: null, temp: null, wind: null,
      situational_notes: [],
      note: 'No line on record for this game.' };
  }

  const awayRow = row(
    `SELECT rest_days FROM game_lines WHERE season = ? AND week = ? AND team = ?`,
    season, week, away);

  const restEdge = Number.isFinite(g.rest_days) && Number.isFinite(awayRow?.rest_days)
    ? g.rest_days - awayRow.rest_days : null;

  const notes = [];
  if (g.div_game) notes.push('a division game, which historically runs closer than the number suggests');
  if (restEdge != null && Math.abs(restEdge) >= 3) {
    notes.push(`${restEdge > 0 ? home : away} has ${Math.abs(restEdge)} more days of rest`);
  }
  if (g.roof === 'dome' || g.roof === 'closed') notes.push('indoors, so weather is not a factor');
  if (Number.isFinite(g.wind) && g.wind >= 15) notes.push(`${g.wind} mph wind, which suppresses passing and totals`);
  if (Number.isFinite(g.temp) && g.temp <= 25) notes.push(`${g.temp}°F`);

  return {
    season, week, home, away,
    market_spread: g.spread, market_total: g.total,
    home_implied_points: g.implied_points,
    rest_days: { home: g.rest_days, away: awayRow?.rest_days ?? null, edge: restEdge },
    division_game: !!g.div_game,
    roof: g.roof, surface: g.surface,
    temp: g.temp, wind: g.wind,
    situational_notes: notes
  };
}

/**
 * Everything about one matchup, assembled for a reasoning trace.
 *
 * Deliberately a single call: a reasoning layer that has to make six queries and
 * remember which are cutoff-safe is a reasoning layer that will eventually leak
 * one. The cutoff is applied here, once, and everything downstream inherits it.
 */
export function spreadContext(season, week, home, away, { lookback = null } = {}) {
  return {
    season, week, home, away,
    cutoff: `computed from weeks 1..${week - 1} only`,
    game: gameContext(season, week, home, away),
    home_ats: atsProfile(home, season, { throughWeek: week, lookback }),
    away_ats: atsProfile(away, season, { throughWeek: week, lookback }),
    home_efficiency: efficiencyGap(home, season, { throughWeek: week }),
    away_efficiency: efficiencyGap(away, season, { throughWeek: week })
  };
}

/**
 * The same context, aimed at a fantasy lineup rather than at a bet.
 *
 * This is the wiring that makes a change here reach the whole platform. The
 * betting side reads these to explain a pick; the fantasy side needs a subset of
 * them for a completely different reason, and two of them matter more for a
 * lineup than they ever do for a spread:
 *
 *   WIND. Fifteen miles an hour suppresses passing volume and efficiency
 *   measurably, and it is the single most actionable weather fact in fantasy —
 *   it can turn a start into a sit for a deep receiver while barely moving the
 *   spread, because the market prices it into the total and the fantasy
 *   projection never saw it at all.
 *
 *   THE EFFICIENCY GAP. A team playing better than its record is a team whose
 *   players are cheap. That is the same reasoning as the touchdown-regression
 *   model, one level up, and it belongs in a start/sit call.
 *
 * Deliberately returns notes rather than a multiplier. The game-script model is
 * already fitted and validated for volume; layering a second unfitted adjustment
 * on top of it would double-count the part Vegas has already priced. These are
 * flags for a human, and they say which they are.
 */
export function fantasyContext(team, season, week) {
  const g = row(
    `SELECT team, opponent, home, spread, total, implied_points, rest_days, div_game,
            roof, surface, temp, wind
     FROM game_lines WHERE season = ? AND week = ? AND team = ?`, season, week, team);
  if (!g) return { team, season, week, insufficient: true, flags: [], notes: [] };

  const indoors = g.roof === 'dome' || g.roof === 'closed';
  const flags = [];

  if (!indoors && Number.isFinite(g.wind) && g.wind >= 15) {
    flags.push({
      kind: 'wind', severity: g.wind >= 20 ? 'high' : 'moderate',
      affects: 'passing',
      note: `${g.wind} mph wind. Passing volume and deep accuracy both fall off above about 15 mph, ` +
        'which hurts a boundary receiver far more than a back or a slot target.'
    });
  }
  if (!indoors && Number.isFinite(g.temp) && g.temp <= 25) {
    flags.push({ kind: 'cold', severity: 'moderate', affects: 'passing',
      note: `${g.temp}°F. Cold suppresses scoring modestly; the effect is smaller than most people ` +
        'assume and much smaller than wind.' });
  }
  if (Number.isFinite(g.implied_points)) {
    if (g.implied_points >= 27) {
      flags.push({ kind: 'implied_points', severity: 'high', affects: 'everyone',
        note: `Vegas implies ${g.implied_points} points for ${team}, near the top of a weekly slate. ` +
          'Touchdown equity follows implied points more reliably than any projection does.' });
    } else if (g.implied_points <= 17) {
      flags.push({ kind: 'implied_points', severity: 'high', affects: 'everyone',
        note: `Vegas implies only ${g.implied_points} points for ${team}. There is very little ` +
          'scoring to go round on a number that low.' });
    }
  }
  if (Number.isFinite(g.spread) && g.spread >= 7) {
    flags.push({ kind: 'big_underdog', severity: 'moderate', affects: 'RB',
      note: `${team} is a ${Math.abs(g.spread)}-point underdog. Trailing teams abandon the run, ` +
        'which costs a back carries and helps a pass-catching one.' });
  }
  if (Number.isFinite(g.spread) && g.spread <= -7) {
    flags.push({ kind: 'big_favourite', severity: 'moderate', affects: 'WR',
      note: `${team} is favoured by ${Math.abs(g.spread)}. Leading teams run out the clock, which ` +
        'costs a receiver targets in the fourth quarter.' });
  }

  const eff = efficiencyGap(team, season, { throughWeek: week });
  if (!eff.insufficient && eff.gap != null && Math.abs(eff.gap) >= 0.25) {
    flags.push({
      kind: 'efficiency_gap', severity: 'moderate', affects: 'everyone',
      note: eff.gap > 0
        ? `${team} has been playing better than its results — efficiency in the ` +
          `${Math.round(eff.epa_percentile * 100)}th percentile. Their players are usually cheap in ` +
          'this state, and the gap tends to close their way.'
        : `${team}'s results have been running ahead of how they have played. That corrects against ` +
          'them more often than not.'
    });
  }

  return {
    team, season, week, opponent: g.opponent, home: !!g.home,
    market: { spread: g.spread, total: g.total, implied_points: g.implied_points },
    conditions: { roof: g.roof, indoors, temp: g.temp, wind: g.wind, surface: g.surface },
    rest_days: g.rest_days, division_game: !!g.div_game,
    efficiency: eff.insufficient ? null : {
      net_epa_per_play: eff.net_epa_per_play, percentile: eff.epa_percentile, gap: eff.gap
    },
    flags,
    notes: flags.map(f => f.note),
    caveat: 'Flags, not a multiplier. The game-script model already prices volume from the spread ' +
      'and total and is fitted out of sample; adding a second unfitted adjustment on top would ' +
      'double-count what Vegas has already accounted for.'
  };
}
