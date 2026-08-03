/**
 * The variable catalog and every feature derived on top of raw play-by-play.
 *
 * nfl-pbp.js produces per-week measurements. This file turns those into the
 * things a model can actually use before a game kicks off: form over rolling
 * windows, opponent-adjusted efficiency, historical betting behaviour, and the
 * venue/weather/rest context that games are played in.
 *
 * Two rules hold throughout:
 *  - Nothing reads the target week. Every function takes the week being
 *    predicted and only ever looks at strictly earlier games, so a feature can
 *    never leak the result it is meant to predict.
 *  - Every variable is registered in CATALOG with a plain-language definition.
 *    The count is meant to be auditable rather than asserted — /api/nfl-features
 *    /catalog returns the list, and countVariables() proves the total.
 */
import { rows } from '../db/index.js';
import { teamWeeks, playerWeeks } from './nfl-pbp.js';

const div = (a, b) => (b > 0 ? a / b : null);
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/* ------------------------------------------------------------------ catalog */

/** Every play-by-play variable, generated for both offense and defense. */
const SIDE_VARS = [
  ['plays', 'Snaps run', 'count'],
  ['epa_per_play', 'Expected points added per play — the single best efficiency summary', 'rate'],
  ['pass_epa_per_play', 'EPA per dropback', 'rate'],
  ['rush_epa_per_play', 'EPA per rush', 'rate'],
  ['success_rate', 'Share of plays gaining enough to stay on schedule', 'rate'],
  ['pass_success_rate', 'Success rate on dropbacks', 'rate'],
  ['rush_success_rate', 'Success rate on runs', 'rate'],
  ['pass_rate', 'Share of plays that were dropbacks', 'rate'],
  ['explosive_pass_rate', 'Share of attempts gaining 20+ yards', 'rate'],
  ['explosive_rush_rate', 'Share of carries gaining 10+ yards', 'rate'],
  ['explosive_play_rate', 'Combined explosive play share', 'rate'],
  ['yards_per_attempt', 'Passing yards per attempt', 'rate'],
  ['yards_per_carry', 'Rushing yards per carry', 'rate'],
  ['completion_pct', 'Completion percentage', 'rate'],
  ['cpoe', 'Completion percentage over expected — accuracy adjusted for throw difficulty', 'rate'],
  ['adot', 'Average depth of target', 'rate'],
  ['yac_per_completion', 'Yards after catch per completion', 'rate'],
  ['deep_attempt_rate', 'Share of throws travelling 15+ air yards', 'rate'],
  ['proe', 'Pass rate over expected — play-calling aggression vs situation', 'rate'],
  ['xpass', 'Expected pass probability given situation', 'rate'],
  ['sack_rate', 'Sacks per dropback', 'rate'],
  ['qb_hit_rate', 'QB hits per dropback', 'rate'],
  ['scramble_rate', 'Scrambles per dropback', 'rate'],
  ['int_rate', 'Interceptions per attempt', 'rate'],
  ['fumble_rate', 'Fumbles per play', 'rate'],
  ['turnover_rate', 'Combined giveaways per play', 'rate'],
  ['penalty_count', 'Penalties', 'count'],
  ['first_down_rate', 'Share of plays producing a first down', 'rate'],
  ['third_down_rate', 'Third down conversion rate', 'rate'],
  ['third_down_distance', 'Average yards to go on third down', 'rate'],
  ['third_down_attempts', 'Third downs faced', 'count'],
  ['fourth_down_rate', 'Fourth down conversion rate', 'rate'],
  ['red_zone_plays', 'Plays inside the 20', 'count'],
  ['red_zone_td_rate', 'Touchdown rate on red zone plays', 'rate'],
  ['goal_to_go_td_rate', 'Touchdown rate in goal-to-go situations', 'rate'],
  ['early_down_epa', 'EPA on first and second down', 'rate'],
  ['early_down_pass_rate', 'Pass rate on early downs', 'rate'],
  ['neutral_pass_rate', 'Pass rate within one score — true play-calling identity', 'rate'],
  ['leading_pass_rate', 'Pass rate while ahead', 'rate'],
  ['trailing_pass_rate', 'Pass rate while behind', 'rate'],
  ['first_half_epa', 'EPA per play before halftime', 'rate'],
  ['second_half_epa', 'EPA per play after halftime — adjustment quality', 'rate'],
  ['half_epa_delta', 'Second half EPA minus first half', 'rate'],
  ['shotgun_rate', 'Share of snaps from shotgun', 'rate'],
  ['no_huddle_rate', 'Share of snaps with no huddle', 'rate'],
  ['drives', 'Drives', 'count'],
  ['plays_per_drive', 'Average plays per drive — sustain', 'rate'],
  ['series_success_rate', 'Share of series producing a first down or score', 'rate'],
  ['td_per_drive', 'Touchdowns per drive', 'rate'],
  ['pass_td', 'Passing touchdowns', 'count'],
  ['rush_td', 'Rushing touchdowns', 'count'],

  /* ---- advanced ---- */
  ['epa_neutral_wp', 'EPA per play with garbage time removed (win probability between 10% and 90%)', 'rate'],
  ['success_rate_neutral_wp', 'Success rate in competitive game states only', 'rate'],
  ['garbage_time_share', 'Share of snaps played in a decided game', 'rate'],
  ['wpa_total', 'Total win probability added', 'count'],
  ['wpa_per_play', 'Win probability added per play', 'rate'],
  ['stuff_rate', 'Share of carries held to no gain or a loss', 'rate'],
  ['tfl_rate', 'Tackles for loss per play', 'rate'],
  ['havoc_rate', 'Combined tackles for loss, forced fumbles, passes defended and interceptions per play', 'rate'],
  ['forced_fumbles', 'Forced fumbles', 'count'],
  ['passes_defended', 'Passes defended', 'count'],
  ['yards_per_play', 'Yards gained per play', 'rate'],
  ['sack_yards', 'Yards lost to sacks', 'count'],
  ['avg_yards_to_go', 'Average distance to a first down', 'rate'],
  ['epa_volatility', 'Standard deviation of play EPA — boom-bust versus steady', 'rate'],
  ['epa_own_territory', 'EPA per play inside a team’s own 40', 'rate'],
  ['epa_midfield', 'EPA per play between the 40s', 'rate'],
  ['epa_opp_territory', 'EPA per play inside the opponent’s 40', 'rate'],
  ['epa_q4_close', 'EPA per play in the fourth quarter within one score', 'rate'],
  ['second_and_long_epa', 'EPA on second and eight or longer', 'rate'],
  ['third_and_short_rate', 'Conversion rate on third and three or less', 'rate'],
  ['third_and_long_rate', 'Conversion rate on third and seven or more', 'rate'],
  ['deep_pass_epa', 'EPA on throws travelling 15+ air yards', 'rate'],
  ['short_pass_epa', 'EPA on throws under 15 air yards', 'rate'],
  ['pressure_epa', 'EPA on dropbacks where the quarterback was hit', 'rate'],
  ['clean_pocket_epa', 'EPA on dropbacks with a clean pocket', 'rate'],
  ['pressure_epa_delta', 'Pressured EPA minus clean pocket EPA — how much pressure actually costs', 'rate'],
  ['yac_over_expected', 'Yards after catch above what an average player would gain on the same throws', 'rate'],
  ['drive_td_rate', 'Share of drives ending in a touchdown', 'rate'],
  ['drive_fg_rate', 'Share of drives ending in a field goal', 'rate'],
  ['drive_punt_rate', 'Share of drives ending in a punt', 'rate'],
  ['drive_turnover_rate', 'Share of drives ending in a turnover or downs', 'rate'],
  ['drive_scoring_rate', 'Share of drives producing points', 'rate'],
  ['three_and_out_rate', 'Share of drives ending in a three and out', 'rate'],
  ['avg_drive_start', 'Average starting field position in yards from a team’s own goal', 'rate'],
  ['seconds_per_drive', 'Average time of possession per drive', 'rate'],
  ['avg_drive_plays', 'Average plays per drive', 'rate'],
  ['yards_per_drive', 'Average yards gained per drive', 'rate']
];

const NET_VARS = [
  ['net_epa_per_play', 'Offensive EPA per play minus defensive EPA allowed'],
  ['net_success_rate', 'Success rate minus success rate allowed'],
  ['net_explosive_rate', 'Explosive rate minus explosive rate allowed'],
  ['net_turnover_rate', 'Takeaway rate minus giveaway rate'],
  ['net_third_down', 'Third down rate minus third down rate allowed'],
  ['net_sack_rate', 'Sack rate generated minus allowed'],
  ['net_red_zone_td_rate', 'Red zone TD rate minus allowed']
];

const PLAYER_VARS = [
  ['dropbacks', 'Dropbacks'], ['pass_attempts', 'Pass attempts'], ['completions', 'Completions'],
  ['completion_pct', 'Completion percentage'], ['passing_yards', 'Passing yards'],
  ['yards_per_attempt', 'Yards per attempt'], ['passing_tds', 'Passing touchdowns'],
  ['interceptions', 'Interceptions'], ['pass_td_rate', 'Pass TD per attempt'],
  ['int_rate', 'Interception per attempt'], ['sacks_taken', 'Sacks taken'],
  ['sack_rate', 'Sack rate per dropback'], ['pass_epa_per_att', 'Passing EPA per attempt'],
  ['adot', 'Average depth of target thrown'], ['cpoe', 'Completion pct over expected'],
  ['deep_attempt_rate', 'Share of throws 15+ air yards'], ['scrambles', 'Scrambles'],
  ['pass_rz_attempts', 'Red zone pass attempts'],
  ['carries', 'Carries'], ['rushing_yards', 'Rushing yards'], ['yards_per_carry', 'Yards per carry'],
  ['rushing_tds', 'Rushing touchdowns'], ['rush_epa_per_carry', 'Rushing EPA per carry'],
  ['rush_success_rate', 'Rush success rate'], ['explosive_rush_rate', 'Share of carries 10+ yards'],
  ['rush_td_rate', 'Rush TD per carry'], ['red_zone_carries', 'Carries inside the 20'],
  ['goal_line_carries', 'Goal-to-go carries'], ['carry_share', 'Share of team carries'],
  ['targets', 'Targets'], ['receptions', 'Receptions'], ['catch_rate', 'Catch rate'],
  ['receiving_yards', 'Receiving yards'], ['yards_per_reception', 'Yards per reception'],
  ['yards_per_target', 'Yards per target'], ['receiving_tds', 'Receiving touchdowns'],
  ['rec_td_rate', 'Receiving TD per target'], ['air_yards', 'Air yards'],
  ['rec_adot', 'Average depth of target received'], ['yac', 'Yards after catch'],
  ['yac_per_reception', 'YAC per reception'], ['rec_epa_per_target', 'Receiving EPA per target'],
  ['rec_success_rate', 'Receiving success rate'], ['explosive_rec_rate', 'Share of catches 20+ yards'],
  ['deep_target_rate', 'Share of targets 15+ air yards'], ['red_zone_targets', 'Targets inside the 20'],
  ['target_share', 'Share of team targets'], ['air_yards_share', 'Share of team air yards'],
  ['wopr', 'Weighted opportunity rating — 1.5x target share + 0.7x air yards share'],
  ['total_touches', 'Carries plus receptions'], ['total_yards', 'All-purpose yards'],
  ['total_tds', 'Total touchdowns']
];

const BETTING_VARS = [
  ['ats_cover_rate', 'Share of games covering the spread'],
  ['ats_margin_avg', 'Average margin relative to the spread'],
  ['ats_as_favorite', 'Cover rate when favoured'],
  ['ats_as_underdog', 'Cover rate when an underdog'],
  ['ats_home', 'Cover rate at home'],
  ['ats_away', 'Cover rate on the road'],
  ['ats_last3', 'Cover rate over the last three games'],
  ['ats_last5', 'Cover rate over the last five games'],
  ['ats_divisional', 'Cover rate in divisional games'],
  ['ats_nondivisional', 'Cover rate outside the division'],
  ['ats_off_long_rest', 'Cover rate with extra rest'],
  ['ats_short_week', 'Cover rate on a short week'],
  ['over_rate', 'Share of games going over the total'],
  ['over_rate_last3', 'Over rate across the last three games'],
  ['over_rate_last5', 'Over rate across the last five games'],
  ['over_rate_home', 'Over rate at home'],
  ['over_rate_away', 'Over rate on the road'],
  ['total_actual_avg', 'Average combined points scored'],
  ['total_closing_avg', 'Average closing total'],
  ['total_vs_closing_avg', 'Actual combined points minus the closing total'],
  ['points_for_avg', 'Points scored per game'],
  ['points_against_avg', 'Points allowed per game'],
  ['points_vs_implied_avg', 'Points scored minus the market implied team total'],
  ['opp_points_vs_implied_avg', 'Points allowed minus opponent implied total'],
  ['margin_avg', 'Average scoring margin'],
  ['moneyline_win_rate', 'Straight-up win rate'],
  ['favorite_rate', 'Share of games favoured by the market'],
  ['closing_spread_avg', 'Average closing spread'],
  ['cover_streak', 'Consecutive games covering (negative if failing)'],
  ['over_streak', 'Consecutive overs (negative if unders)']
];

const CONTEXT_VARS = [
  ['is_home', 'Playing at home'],
  ['is_dome', 'Roof closed or fixed — no weather effect'],
  ['temp', 'Kickoff temperature in Fahrenheit'],
  ['wind', 'Kickoff wind speed in mph'],
  ['is_cold', 'Temperature below freezing'],
  ['is_windy', 'Wind at or above 15 mph — the level that measurably hurts passing and kicking'],
  ['is_turf', 'Artificial surface'],
  ['rest_days', 'Days since the previous game'],
  ['is_short_week', 'Six days rest or fewer'],
  ['is_off_bye', 'Ten or more days rest'],
  ['is_divisional', 'Divisional opponent'],
  ['is_primetime', 'Kickoff at 20:00 local or later'],
  ['kickoff_hour', 'Scheduled kickoff hour'],
  ['closing_spread', 'This team’s closing spread'],
  ['closing_total', 'Closing game total'],
  ['implied_team_total', 'Market implied points for this team'],
  ['dome_epa_delta', 'EPA per play indoors minus outdoors'],
  ['cold_epa_delta', 'EPA per play in freezing games minus otherwise'],
  ['wind_epa_delta', 'EPA per play in windy games minus otherwise']
];

const FORM_METRICS = [
  ['off_epa_per_play', 'offensive EPA per play'],
  ['def_epa_per_play', 'defensive EPA allowed per play'],
  ['off_success_rate', 'offensive success rate'],
  ['def_success_rate', 'defensive success rate allowed'],
  ['net_epa_per_play', 'net EPA per play'],
  ['off_proe', 'pass rate over expected'],
  ['off_explosive_play_rate', 'explosive play rate'],
  ['off_red_zone_td_rate', 'red zone touchdown rate']
];

const ADJUSTED_VARS = [
  ['opp_adj_off_epa', 'Offensive EPA per play adjusted for defences faced'],
  ['opp_adj_def_epa', 'Defensive EPA allowed adjusted for offences faced'],
  ['sos_played', 'Average opponent net EPA faced so far'],
  ['sos_remaining', 'Average opponent net EPA still to be played'],
  ['pace_seconds_per_play', 'Situation-neutral seconds per play'],
  ['opp_adj_net_epa', 'Opponent-adjusted net EPA per play']
];

/** The full registry — every variable this system computes, with definitions. */
export function catalog() {
  const out = [];
  for (const side of ['off', 'def']) {
    const label = side === 'off' ? 'Offense' : 'Defense';
    for (const [k, desc, kind] of SIDE_VARS) {
      out.push({
        key: `${side}_${k}`, scope: 'team', group: `${label} (play-by-play)`,
        kind, description: `${label}: ${desc}`
      });
    }
  }
  for (const [k, d] of NET_VARS) out.push({ key: k, scope: 'team', group: 'Net team strength', kind: 'rate', description: d });
  for (const [k, d] of BETTING_VARS) out.push({ key: k, scope: 'team', group: 'Historical betting trends', kind: 'rate', description: d });
  for (const [k, d] of CONTEXT_VARS) out.push({ key: k, scope: 'team', group: 'Weather, venue and rest', kind: 'context', description: d });
  for (const w of [3, 5]) {
    for (const [k, d] of FORM_METRICS) {
      out.push({ key: `${k}_last${w}`, scope: 'team', group: 'Rolling form', kind: 'rate', description: `Average ${d} over the last ${w} games` });
    }
  }
  for (const [k, d] of FORM_METRICS) {
    out.push({ key: `${k}_trend`, scope: 'team', group: 'Rolling form', kind: 'rate', description: `Last three games of ${d} minus the season average — direction of travel` });
  }
  for (const [k, d] of ADJUSTED_VARS) out.push({ key: k, scope: 'team', group: 'Opponent adjusted', kind: 'rate', description: d });
  for (const [k, d] of PLAYER_VARS) out.push({ key: k, scope: 'player', group: 'Player usage and efficiency', kind: 'mixed', description: d });
  for (const w of [3, 5]) {
    for (const k of ['targets', 'carries', 'target_share', 'carry_share', 'wopr', 'total_yards', 'total_touches']) {
      out.push({ key: `${k}_last${w}`, scope: 'player', group: 'Player rolling form', kind: 'rate', description: `Average ${k.replace(/_/g, ' ')} over the last ${w} games` });
    }
  }
  return out;
}

export function countVariables() {
  const c = catalog();
  const byGroup = {};
  for (const v of c) byGroup[v.group] = (byGroup[v.group] ?? 0) + 1;
  return {
    total: c.length,
    team: c.filter(v => v.scope === 'team').length,
    player: c.filter(v => v.scope === 'player').length,
    by_group: byGroup
  };
}

/* -------------------------------------------------- historical betting trends */

const covered = g => {
  // spread is stated from this team's perspective, negative = favoured.
  const margin = g.team_score - g.opp_score;
  return margin + g.spread === 0 ? null : margin + g.spread > 0;
};

/**
 * Betting behaviour for one team using only games before `week`.
 * Everything here is a tendency, not a prediction — the model decides what to
 * do with a team that has covered six straight, including ignoring it.
 */
export function bettingTrends(season, week, team) {
  const g = rows(`SELECT * FROM game_lines
                  WHERE season = ? AND week < ? AND team = ?
                    AND team_score IS NOT NULL AND spread IS NOT NULL
                  ORDER BY week`, season, week, team);
  if (!g.length) return Object.fromEntries(BETTING_VARS.map(([k]) => [k, null]));

  const ats = g.map(covered).filter(v => v !== null);
  const rate = arr => (arr.length ? avg(arr.map(Boolean).map(Number)) : null);
  const overs = g.filter(x => x.total != null).map(x => (x.team_score + x.opp_score) - x.total);
  const streak = (arr, want) => {
    let n = 0;
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] === want) n++; else break; }
    return want ? n : -n;
  };
  const sub = f => g.filter(f).map(covered).filter(v => v !== null);
  const lastN = (arr, n) => arr.slice(-n);

  const atsAll = ats;
  const overBools = overs.map(v => v > 0);

  return {
    ats_cover_rate: r3(rate(atsAll)),
    ats_margin_avg: r3(avg(g.map(x => (x.team_score - x.opp_score) + x.spread))),
    ats_as_favorite: r3(rate(sub(x => x.spread < 0))),
    ats_as_underdog: r3(rate(sub(x => x.spread > 0))),
    ats_home: r3(rate(sub(x => x.home === 1))),
    ats_away: r3(rate(sub(x => x.home === 0))),
    ats_last3: r3(rate(lastN(atsAll, 3))),
    ats_last5: r3(rate(lastN(atsAll, 5))),
    ats_divisional: r3(rate(sub(x => x.div_game === 1))),
    ats_nondivisional: r3(rate(sub(x => x.div_game === 0))),
    ats_off_long_rest: r3(rate(sub(x => (x.rest_days ?? 7) >= 10))),
    ats_short_week: r3(rate(sub(x => (x.rest_days ?? 7) <= 6))),
    over_rate: r3(rate(overBools)),
    over_rate_last3: r3(rate(lastN(overBools, 3))),
    over_rate_last5: r3(rate(lastN(overBools, 5))),
    over_rate_home: r3(rate(g.filter(x => x.home === 1 && x.total != null).map(x => (x.team_score + x.opp_score) > x.total))),
    over_rate_away: r3(rate(g.filter(x => x.home === 0 && x.total != null).map(x => (x.team_score + x.opp_score) > x.total))),
    total_actual_avg: r3(avg(g.map(x => x.team_score + x.opp_score))),
    total_closing_avg: r3(avg(g.filter(x => x.total != null).map(x => x.total))),
    total_vs_closing_avg: r3(avg(overs)),
    points_for_avg: r3(avg(g.map(x => x.team_score))),
    points_against_avg: r3(avg(g.map(x => x.opp_score))),
    points_vs_implied_avg: r3(avg(g.filter(x => x.implied_points != null).map(x => x.team_score - x.implied_points))),
    opp_points_vs_implied_avg: r3(avg(g.filter(x => x.total != null && x.implied_points != null)
      .map(x => x.opp_score - (x.total - x.implied_points)))),
    margin_avg: r3(avg(g.map(x => x.team_score - x.opp_score))),
    moneyline_win_rate: r3(avg(g.map(x => Number(x.team_score > x.opp_score)))),
    favorite_rate: r3(avg(g.map(x => Number(x.spread < 0)))),
    closing_spread_avg: r3(avg(g.map(x => x.spread))),
    cover_streak: atsAll.length ? streak(atsAll, atsAll[atsAll.length - 1]) : null,
    over_streak: overBools.length ? streak(overBools, overBools[overBools.length - 1]) : null
  };
}

/* ------------------------------------------------------ context and form */

/** Venue, weather, rest and market context for a specific upcoming game. */
export function gameContext(season, week, team) {
  const g = rows(`SELECT * FROM game_lines WHERE season=? AND week=? AND team=?`, season, week, team)[0];
  const hist = teamWeeks(season, team).filter(t => t.week < week);
  const withCtx = hist.map(h => {
    const line = rows(`SELECT roof, temp, wind FROM game_lines WHERE season=? AND week=? AND team=?`,
      season, h.week, team)[0];
    return { epa: h.features.off_epa_per_play, ...line };
  }).filter(x => x.epa != null);

  const dome = withCtx.filter(x => x.roof === 'dome' || x.roof === 'closed');
  const outdoor = withCtx.filter(x => x.roof && x.roof !== 'dome' && x.roof !== 'closed');
  const cold = withCtx.filter(x => x.temp != null && x.temp < 32);
  const warm = withCtx.filter(x => x.temp != null && x.temp >= 32);
  const windy = withCtx.filter(x => x.wind != null && x.wind >= 15);
  const calm = withCtx.filter(x => x.wind != null && x.wind < 15);
  const delta = (a, b) => (a.length && b.length ? r3(avg(a.map(x => x.epa)) - avg(b.map(x => x.epa))) : null);

  const hour = g?.gametime ? Number(String(g.gametime).split(':')[0]) : null;
  return {
    is_home: g ? g.home : null,
    is_dome: g?.roof ? Number(g.roof === 'dome' || g.roof === 'closed') : null,
    temp: g?.temp ?? null,
    wind: g?.wind ?? null,
    is_cold: g?.temp != null ? Number(g.temp < 32) : null,
    is_windy: g?.wind != null ? Number(g.wind >= 15) : null,
    is_turf: g?.surface ? Number(!/grass/i.test(g.surface)) : null,
    rest_days: g?.rest_days ?? null,
    is_short_week: g?.rest_days != null ? Number(g.rest_days <= 6) : null,
    is_off_bye: g?.rest_days != null ? Number(g.rest_days >= 10) : null,
    is_divisional: g?.div_game ?? null,
    is_primetime: hour != null ? Number(hour >= 20) : null,
    kickoff_hour: hour,
    closing_spread: g?.spread ?? null,
    closing_total: g?.total ?? null,
    implied_team_total: g?.implied_points ?? null,
    dome_epa_delta: delta(dome, outdoor),
    cold_epa_delta: delta(cold, warm),
    wind_epa_delta: delta(windy, calm)
  };
}

/** Rolling-window form and its direction of travel. */
export function formFeatures(season, week, team) {
  const hist = teamWeeks(season, team).filter(t => t.week < week);
  const out = {};
  const series = k => hist.map(h => h.features[k]).filter(v => v != null);
  for (const w of [3, 5]) {
    for (const [k] of FORM_METRICS) out[`${k}_last${w}`] = r3(avg(series(k).slice(-w)));
  }
  for (const [k] of FORM_METRICS) {
    const all = series(k);
    const seasonAvg = avg(all), last3 = avg(all.slice(-3));
    out[`${k}_trend`] = seasonAvg != null && last3 != null ? r3(last3 - seasonAvg) : null;
  }
  return out;
}

/**
 * Opponent-adjusted efficiency: a team's raw EPA minus the average EPA its
 * opponents allowed to everyone else. A good offense that played four elite
 * defences should not be graded the same as one that played four bad ones.
 */
export function adjustedFeatures(season, week, team) {
  const all = teamWeeks(season).filter(t => t.week < week);
  if (!all.length) return Object.fromEntries(ADJUSTED_VARS.map(([k]) => [k, null]));

  const leagueOff = avg(all.map(t => t.features.off_epa_per_play).filter(v => v != null)) ?? 0;
  const byTeam = new Map();
  for (const t of all) {
    const e = byTeam.get(t.team) ?? { off: [], def: [], opps: [] };
    if (t.features.off_epa_per_play != null) e.off.push(t.features.off_epa_per_play);
    if (t.features.def_epa_per_play != null) e.def.push(t.features.def_epa_per_play);
    if (t.opponent) e.opps.push(t.opponent);
    byTeam.set(t.team, e);
  }
  const defStrength = new Map([...byTeam].map(([k, v]) => [k, avg(v.def) ?? leagueOff]));
  const offStrength = new Map([...byTeam].map(([k, v]) => [k, avg(v.off) ?? leagueOff]));

  const me = byTeam.get(team);
  if (!me) return Object.fromEntries(ADJUSTED_VARS.map(([k]) => [k, null]));

  const oppDefFaced = avg(me.opps.map(o => defStrength.get(o) ?? leagueOff));
  const oppOffFaced = avg(me.opps.map(o => offStrength.get(o) ?? leagueOff));
  const rawOff = avg(me.off), rawDef = avg(me.def);

  const remaining = rows(`SELECT opponent FROM game_lines
                          WHERE season=? AND week>=? AND team=? AND opponent IS NOT NULL`,
                          season, week, team).map(r => r.opponent);
  const netOf = t => (offStrength.get(t) ?? 0) - (defStrength.get(t) ?? 0);

  const adjOff = rawOff != null && oppDefFaced != null ? rawOff - (oppDefFaced - leagueOff) : null;
  const adjDef = rawDef != null && oppOffFaced != null ? rawDef - (oppOffFaced - leagueOff) : null;
  return {
    opp_adj_off_epa: r3(adjOff),
    opp_adj_def_epa: r3(adjDef),
    sos_played: r3(avg(me.opps.map(netOf))),
    sos_remaining: remaining.length ? r3(avg(remaining.map(netOf))) : null,
    pace_seconds_per_play: null, // reserved: needs drive clock deltas, not yet ingested
    opp_adj_net_epa: adjOff != null && adjDef != null ? r3(adjOff - adjDef) : null
  };
}

/** Everything for one team-week, in one object. */
export function teamFeatureVector(season, week, team) {
  const seasonToDate = teamWeeks(season, team).filter(t => t.week < week);
  const base = {};
  if (seasonToDate.length) {
    const keys = Object.keys(seasonToDate[0].features);
    for (const k of keys) {
      const vals = seasonToDate.map(t => t.features[k]).filter(v => v != null);
      base[k] = vals.length ? r3(avg(vals)) : null;
    }
  }
  return {
    ...base,
    ...bettingTrends(season, week, team),
    ...gameContext(season, week, team),
    ...formFeatures(season, week, team),
    ...adjustedFeatures(season, week, team)
  };
}

/** Player rolling form on top of his per-week measurements. */
export function playerFeatureVector(season, week, playerId) {
  const hist = playerWeeks(season, playerId).filter(p => p.week < week);
  if (!hist.length) return null;
  const keys = Object.keys(hist[0].features);
  const out = {};
  for (const k of keys) {
    const vals = hist.map(h => h.features[k]).filter(v => v != null);
    out[k] = vals.length ? r3(avg(vals)) : null;
  }
  for (const w of [3, 5]) {
    for (const k of ['targets', 'carries', 'target_share', 'carry_share', 'wopr', 'total_yards', 'total_touches']) {
      const vals = hist.map(h => h.features[k]).filter(v => v != null).slice(-w);
      out[`${k}_last${w}`] = vals.length ? r3(avg(vals)) : null;
    }
  }
  const last = hist[hist.length - 1];
  return { player_id: playerId, name: last.player_name, team: last.team, position: last.position, features: out };
}
