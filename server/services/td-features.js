/**
 * Week-level touchdown features.
 *
 * Touchdowns are the highest-variance component of a fantasy week and the one
 * the structural head treats most crudely: it shrinks every player's rec/rush/
 * pass TD rate toward a single positional constant with K=70 (activeKVector),
 * then multiplies by projected volume. That produces a smooth, almost
 * player-constant TD expectation, which is the right first approximation and
 * the wrong last one.
 *
 * Everything here is built as a STRICTLY PRIOR aggregate: for a target
 * (season S, week W) only rows with season = S and week < W are read. There is
 * no cross-season carry and no same-week term, so the leak argument is a single
 * inequality that can be checked by reading `emitPriorSeries` below. The one
 * exception is the OPPONENT IDENTITY for week W, which is schedule information
 * and is known days before kickoff; opponent STATISTICS are, like everything
 * else, prior-weeks only.
 *
 * Why the emphasis on week level: the player-level axis of this projection is
 * saturated (an oracle that knows a player's true season mean, computed
 * leave-one-out, loses to the production ensemble). A season aggregate of a
 * defensive stat is a player-level feature wearing a hat. So each feature here
 * is either (i) a regression-to-expectation term that says this particular
 * player is owed or has been paid, or (ii) a product of a prior role share with
 * a week-specific matchup, which moves from week to week for a fixed player.
 */

/**
 * STATUS (2026-09-18, plan section 00 part F, WD): built 2026-09-17, never wired to a
 * grading harness or gate, and never run. Reviewed against `study/features/feature-store.md`
 * (the consolidated feature-store study that DID run) - that study tested general points/MAE
 * on player-level and week-level aggregates; it never tested TOUCHDOWN RATE specifically, which
 * is the one hypothesis here. NOT superseded, and NOT wired into anything live. Before this
 * ships or is deleted, it needs a walk-forward test through the same procedure as the rest of
 * this branch: fit <= s-1, validate 2024/2025 once, player-clustered bootstrap, graded on
 * TD-rate error and on start/sit pair accuracy - not assumed to help because the argument reads
 * well.
 */

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

export const TD_FEATURE_KEYS = [
  // regression anchor: what his usage earned vs what he banked
  'xtd_pg', 'xtd_gap', 'xtd_games',
  // scoring-opportunity role, prior weeks
  'ez_tgt_pg', 'rz_tgt_pg', 'rz_carry_pg', 'gl_carry_pg', 'g2g_tgt_pg', 'deep_tgt_rate',
  // goal-line PERSONNEL: on the field for goal-to-go snaps, not necessarily touching it
  'gl_share', 'gl_snaps_pg', 'gl_rank',
  // team context, prior weeks
  'team_rz_td_rate', 'team_rz_plays_pg', 'team_g2g_plays_pg', 'team_fourth_rate', 'team_two_pt_rate',
  // week-level matchup: opponent for THIS week (schedule), their prior-weeks defence
  'opp_rz_td_allowed', 'opp_g2g_td_allowed', 'opp_td_per_drive',
  // interactions - the part that actually varies within a player across weeks
  'gl_expected', 'rz_matchup',
];

/**
 * Walk one player's (or team's) season in week order and emit, for every week,
 * the aggregate of every row STRICTLY BEFORE it. This is the only place a
 * prior window is formed; every feature below routes through it, so "does this
 * leak" reduces to reading this function.
 */
function emitPriorSeries(rowsByKey, emit) {
  for (const [key, list] of rowsByKey) {
    list.sort((a, b) => a.week - b.week);
    for (let w = 2; w <= 18; w++) {
      const prior = [];
      for (const r of list) { if (r.week < w) prior.push(r); else break; }
      if (!prior.length) continue;
      emit(key, w, prior);
    }
  }
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

/**
 * xTD regression anchor.
 *
 * nfl_ffopportunity_weekly carries expected_touchdowns from a model of down,
 * distance and field position. A back with four expected touchdowns and six
 * actual has been paid ahead of his work and regresses; one at one of four is
 * owed. Both terms are carried separately rather than folded, because the level
 * (how many scoring chances he gets) and the gap (whether he has converted
 * above rate) are different processes and the fit should be allowed to price
 * them differently — or to price the gap at zero, which is the null result this
 * is built to be able to return.
 */
function xtdFeatures(appDb, seasons) {
  const lo = Math.min(...seasons), hi = Math.max(...seasons);
  const src = appDb.prepare(`
    SELECT f.season, f.week, p.id AS player_id, f.expected_touchdowns AS xtd,
           u.rushing_tds AS rtd, u.receiving_tds AS ctd, u.passing_tds AS ptd
    FROM nfl_ffopportunity_weekly f
    JOIN players p ON p.gsis_id = f.player_gsis_id
    LEFT JOIN player_week_usage u
      ON u.player_id = p.id AND u.season = f.season AND u.week = f.week
    WHERE f.season BETWEEN ? AND ?`).all(lo, hi);

  const byPS = new Map();
  for (const r of src) {
    const xtd = num(r.xtd);
    if (xtd == null) continue;
    push(byPS, `${r.player_id}|${r.season}`, {
      week: r.week, xtd,
      td: (num(r.rtd) ?? 0) + (num(r.ctd) ?? 0) + (num(r.ptd) ?? 0),
    });
  }
  const out = new Map();
  emitPriorSeries(byPS, (key, week, prior) => {
    const [pid, season] = key.split('|');
    const x = mean(prior.map(r => r.xtd));
    const a = mean(prior.map(r => r.td));
    out.set(`${pid}|${season}|${week}`, {
      xtd_pg: x,
      // positive = he has out-scored his opportunity and is due to give it back
      xtd_gap: a - x,
      xtd_games: prior.length,
    });
  });
  return out;
}

/**
 * Scoring-opportunity role from the 67-key player-week blob.
 *
 * These are usage counts, not outcomes: end-zone targets, red-zone and
 * goal-line carries, deep target rate. Prior-weeks per-game means.
 */
function usageFeatures(appDb, seasons) {
  const lo = Math.min(...seasons), hi = Math.max(...seasons);
  const src = appDb.prepare(`
    SELECT f.season, f.week, p.id AS player_id, f.features
    FROM nfl_player_week_features f
    JOIN players p ON p.gsis_id = f.player_id
    WHERE f.season BETWEEN ? AND ?`).all(lo, hi);
  const byPS = new Map();
  for (const r of src) {
    let f; try { f = JSON.parse(r.features); } catch { continue; }
    push(byPS, `${r.player_id}|${r.season}`, {
      week: r.week,
      ez: num(f.end_zone_targets) ?? 0,
      rzt: num(f.red_zone_targets) ?? 0,
      rzc: num(f.red_zone_carries) ?? 0,
      glc: num(f.goal_line_carries) ?? 0,
      g2g: num(f.goal_to_go_targets) ?? 0,
      deep: num(f.deep_target_rate),
    });
  }
  const out = new Map();
  emitPriorSeries(byPS, (key, week, prior) => {
    const [pid, season] = key.split('|');
    const deep = prior.map(r => r.deep).filter(v => v != null);
    out.set(`${pid}|${season}|${week}`, {
      ez_tgt_pg: mean(prior.map(r => r.ez)),
      rz_tgt_pg: mean(prior.map(r => r.rzt)),
      rz_carry_pg: mean(prior.map(r => r.rzc)),
      gl_carry_pg: mean(prior.map(r => r.glc)),
      g2g_tgt_pg: mean(prior.map(r => r.g2g)),
      deep_tgt_rate: deep.length ? mean(deep) : 0,
    });
  });
  return out;
}

/**
 * GOAL-LINE PERSONNEL.
 *
 * Who is physically on the field when the offence has first-and-goal, from
 * pbp_participation's offense_players (gsis ids, one row per play, 2016-2025
 * complete). This is deliberately not a touch statistic: the goal-line back is
 * the one who is ON for those snaps, and the between-the-20s back can be the
 * same depth-chart slot with the same carry share and never see one. A
 * personnel share is also available for a player who has not yet been fed
 * there, which a red-zone carry count is not.
 *
 * gl_share  = share of his team's prior goal-to-go snaps he was on the field for
 * gl_snaps_pg = those snaps per prior game
 * gl_rank   = his rank among his own team's skill players by prior g2g snaps
 *             (1 = the goal-line guy), 9 when he has none
 */
function goalLinePersonnel(nflDb, gsisToPlayer, seasons) {
  const lo = Math.min(...seasons), hi = Math.max(...seasons);
  const plays = nflDb.prepare(`
    SELECT p.season, p.week, p.posteam, pp.offense_players
    FROM play_by_play p
    JOIN pbp_participation pp
      ON pp.nflverse_game_id = p.game_id AND pp.play_id = p.play_id
    WHERE p.season BETWEEN ? AND ? AND p.goal_to_go = 1
      AND p.play_type IN ('run', 'pass') AND pp.offense_players IS NOT NULL`).all(lo, hi);

  // player-week and team-week snap counts, one pass
  const byPlayer = new Map();   // `${pid}|${season}` -> [{week, snaps, team}]
  const byTeam = new Map();     // `${team}|${season}` -> [{week, plays}]
  const playerWeek = new Map(), teamWeek = new Map();
  for (const pl of plays) {
    const tk = `${pl.posteam}|${pl.season}|${pl.week}`;
    teamWeek.set(tk, (teamWeek.get(tk) ?? 0) + 1);
    for (const g of String(pl.offense_players).split(';')) {
      const pid = gsisToPlayer.get(g);
      if (!pid) continue;                       // linemen and defenders on the field for a goal-line package
      const k = `${pid}|${pl.season}|${pl.week}|${pl.posteam}`;
      playerWeek.set(k, (playerWeek.get(k) ?? 0) + 1);
    }
  }
  for (const [k, snaps] of playerWeek) {
    const [pid, season, week, team] = k.split('|');
    push(byPlayer, `${pid}|${season}`, { week: +week, snaps, team });
  }
  for (const [k, n] of teamWeek) {
    const [team, season, week] = k.split('|');
    push(byTeam, `${team}|${season}`, { week: +week, plays: n });
  }

  // prior team goal-to-go volume, per game
  const teamPrior = new Map();
  emitPriorSeries(byTeam, (key, week, prior) => {
    const [team, season] = key.split('|');
    teamPrior.set(`${team}|${season}|${week}`, {
      total: prior.reduce((s, r) => s + r.plays, 0),
      per_game: mean(prior.map(r => r.plays)),
    });
  });

  const out = new Map();
  emitPriorSeries(byPlayer, (key, week, prior) => {
    const [pid, season] = key.split('|');
    const team = prior.at(-1).team;
    const snaps = prior.reduce((s, r) => s + r.snaps, 0);
    const tp = teamPrior.get(`${team}|${season}|${week}`);
    out.set(`${pid}|${season}|${week}`, {
      gl_share: tp && tp.total ? snaps / tp.total : 0,
      gl_snaps_pg: snaps / prior.length,
      team_g2g_plays_pg: tp ? tp.per_game : 0,
    });
  });

  // Rank within team: computed after the fact because it needs every player on
  // the roster for that team-week at once.
  const roster = new Map();     // `${team}|${season}|${week}` -> [[pid, share]]
  for (const [k, v] of out) {
    const [pid, season, week] = k.split('|');
    const last = byPlayer.get(`${pid}|${season}`).filter(r => r.week < +week).at(-1);
    if (!last) continue;
    push(roster, `${last.team}|${season}|${week}`, [k, v.gl_snaps_pg]);
  }
  for (const [, list] of roster) {
    list.sort((a, b) => b[1] - a[1]);
    list.forEach(([k], i) => { out.get(k).gl_rank = i + 1; });
  }
  for (const v of out.values()) if (v.gl_rank == null) v.gl_rank = 9;
  return { map: out, teamPrior, plays: plays.length };
}

/**
 * Team and opponent red-zone context, prior weeks only.
 *
 * nfl_team_week_features stores one week's rates per row, so the prior-weeks
 * mean has to be formed here rather than read off. off_fourth_down_rate doubles
 * as the kicker-quality proxy the brief asks for: a team that does not trust
 * its kicker goes for it more, and a fourth-down conversion inside the
 * opponent's half is a touchdown chance a field goal attempt is not.
 */
function teamContext(appDb, seasons) {
  const lo = Math.min(...seasons), hi = Math.max(...seasons);
  const src = appDb.prepare(`
    SELECT season, week, team, features FROM nfl_team_week_features
    WHERE season BETWEEN ? AND ?`).all(lo, hi);
  const byTS = new Map();
  for (const r of src) {
    let f; try { f = JSON.parse(r.features); } catch { continue; }
    push(byTS, `${r.team}|${r.season}`, {
      week: r.week,
      off_rz_td: num(f.off_red_zone_td_rate) ?? 0,
      off_rz_plays: num(f.off_red_zone_plays) ?? 0,
      off_fourth: num(f.off_fourth_down_rate) ?? 0,
      off_td_drive: num(f.off_td_per_drive) ?? 0,
      def_rz_td: num(f.def_red_zone_td_rate) ?? 0,
      def_g2g_td: num(f.def_goal_to_go_td_rate) ?? 0,
      def_td_drive: num(f.def_td_per_drive) ?? 0,
    });
  }
  const out = new Map();
  emitPriorSeries(byTS, (key, week, prior) => {
    const [team, season] = key.split('|');
    out.set(`${team}|${season}|${week}`, {
      team_rz_td_rate: mean(prior.map(r => r.off_rz_td)),
      team_rz_plays_pg: mean(prior.map(r => r.off_rz_plays)),
      team_fourth_rate: mean(prior.map(r => r.off_fourth)),
      team_td_per_drive: mean(prior.map(r => r.off_td_drive)),
      opp_rz_td_allowed: mean(prior.map(r => r.def_rz_td)),
      opp_g2g_td_allowed: mean(prior.map(r => r.def_g2g_td)),
      opp_td_per_drive: mean(prior.map(r => r.def_td_drive)),
    });
  });
  return out;
}

/**
 * Two-point tendency, from play-by-play: attempts per touchdown scored, prior
 * weeks. A team that goes for two often hands its skill players extra scoring
 * chances that the TD rate model never sees.
 */
function twoPointTendency(nflDb, seasons) {
  const lo = Math.min(...seasons), hi = Math.max(...seasons);
  const src = nflDb.prepare(`
    SELECT season, week, posteam,
           SUM(COALESCE(two_point_attempt, 0)) AS att,
           SUM(CASE WHEN touchdown = 1 AND td_team = posteam THEN 1 ELSE 0 END) AS tds
    FROM play_by_play
    WHERE season BETWEEN ? AND ? AND posteam IS NOT NULL
    GROUP BY season, week, posteam`).all(lo, hi);
  const byTS = new Map();
  for (const r of src) push(byTS, `${r.posteam}|${r.season}`, { week: r.week, att: r.att ?? 0, tds: r.tds ?? 0 });
  const out = new Map();
  emitPriorSeries(byTS, (key, week, prior) => {
    const [team, season] = key.split('|');
    const att = prior.reduce((s, r) => s + r.att, 0);
    const tds = prior.reduce((s, r) => s + r.tds, 0);
    out.set(`${team}|${season}|${week}`, { team_two_pt_rate: tds ? att / tds : 0 });
  });
  return out;
}

/**
 * Assemble every feature onto one key per player-week.
 *
 * `schedule` supplies this week's team and opponent — schedule information,
 * published before kickoff. Opponent STATISTICS are prior-weeks only.
 */
export function buildTdFeatures({ appDb, nflDb, seasons = [2021, 2022, 2023, 2024, 2025] }) {
  const lo = Math.min(...seasons), hi = Math.max(...seasons);

  const gsisToPlayer = new Map();
  for (const r of appDb.prepare('SELECT id, gsis_id FROM players WHERE gsis_id IS NOT NULL').all()) {
    gsisToPlayer.set(r.gsis_id, r.id);
  }

  const xtd = xtdFeatures(appDb, seasons);
  const usage = usageFeatures(appDb, seasons);
  const gl = goalLinePersonnel(nflDb, gsisToPlayer, seasons);
  const team = teamContext(appDb, seasons);
  const twop = twoPointTendency(nflDb, seasons);

  // Schedule: team and opponent for each player-week actually played.
  const schedule = appDb.prepare(`
    SELECT season, week, player_id, team, opponent, position
    FROM player_week_usage WHERE season BETWEEN ? AND ?`).all(lo, hi);

  const out = new Map();
  for (const s of schedule) {
    const k = `${s.player_id}|${s.season}|${s.week}`;
    const x = xtd.get(k), u = usage.get(k), g = gl.map.get(k);
    const t = s.team ? team.get(`${s.team}|${s.season}|${s.week}`) : null;
    const o = s.opponent ? team.get(`${s.opponent}|${s.season}|${s.week}`) : null;
    const tp = s.team ? twop.get(`${s.team}|${s.season}|${s.week}`) : null;
    if (!x && !u && !g) continue;

    const f = {
      xtd_pg: x?.xtd_pg ?? null,
      xtd_gap: x?.xtd_gap ?? null,
      xtd_games: x?.xtd_games ?? 0,
      ez_tgt_pg: u?.ez_tgt_pg ?? 0,
      rz_tgt_pg: u?.rz_tgt_pg ?? 0,
      rz_carry_pg: u?.rz_carry_pg ?? 0,
      gl_carry_pg: u?.gl_carry_pg ?? 0,
      g2g_tgt_pg: u?.g2g_tgt_pg ?? 0,
      deep_tgt_rate: u?.deep_tgt_rate ?? 0,
      gl_share: g?.gl_share ?? 0,
      gl_snaps_pg: g?.gl_snaps_pg ?? 0,
      gl_rank: g?.gl_rank ?? 9,
      team_g2g_plays_pg: g?.team_g2g_plays_pg ?? 0,
      team_rz_td_rate: t?.team_rz_td_rate ?? null,
      team_rz_plays_pg: t?.team_rz_plays_pg ?? null,
      team_fourth_rate: t?.team_fourth_rate ?? null,
      team_two_pt_rate: tp?.team_two_pt_rate ?? 0,
      opp_rz_td_allowed: o?.opp_rz_td_allowed ?? null,
      opp_g2g_td_allowed: o?.opp_g2g_td_allowed ?? null,
      opp_td_per_drive: o?.opp_td_per_drive ?? null,
      position: s.position,
    };
    // The two interactions. These are the only terms that move week to week for
    // a player whose role is fixed, which is the whole point of the exercise:
    // his share of the goal-line package times how many goal-line snaps this
    // particular opponent is likely to concede.
    f.gl_expected = f.gl_share * f.team_g2g_plays_pg * (1 + (f.opp_g2g_td_allowed ?? 0));
    f.rz_matchup = (f.rz_tgt_pg + f.rz_carry_pg) * (1 + (f.opp_rz_td_allowed ?? 0));
    out.set(k, f);
  }

  return {
    features: out,
    meta: {
      seasons: [lo, hi],
      xtd_rows: xtd.size, usage_rows: usage.size, gl_rows: gl.map.size,
      goal_to_go_plays: gl.plays, team_rows: team.size, joined: out.size,
    },
  };
}

/**
 * Actual touchdown POINTS for a player-week, in the harness's scoring. This is
 * the grading target: the component, not the whole score.
 */
export function actualTdPoints(u, scoring) {
  return scoring.rush_td * (u.rushing_tds ?? 0)
    + scoring.rec_td * (u.receiving_tds ?? 0)
    + scoring.pass_td * (u.passing_tds ?? 0);
}

/**
 * The structural head's own TD component, read off the projection params the
 * production model builds. Volume times shrunken rate, scored — exactly the
 * TD part of `structuralPpg` in projections.js and nothing else.
 */
export function structuralTdPoints(params, scoring) {
  if (!params) return null;
  return scoring.rec_td * (params.targets * params.rec_td_rate)
    + scoring.rush_td * (params.carries * params.rush_td_rate)
    + scoring.pass_td * (params.attempts * params.pass_td_rate);
}
