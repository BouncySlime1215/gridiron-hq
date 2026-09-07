/**
 * What an offseason does to a player, quantified and graded out of sample.
 *
 * `nfl-offseason-change.js` established the first half of this: players who
 * change teams keep a median ~74% (WR) / 78% (RB) / 82% (TE) of their prior
 * per-game opportunity, against 95-99% for players who stay, and applying that
 * as a flat mover discount improved early-season opportunity MAE from 3.202 to
 * 3.169 on held-out 2025 weeks 2-5 (WORK_LOG ~236-262). That is a real finding
 * and it is also a very blunt instrument: one number per position, applied to
 * every mover, ignoring the thing that actually decides a mover's fate — how
 * much opportunity was open on the team he moved to.
 *
 * This module asks the finer question. For each player-season T, using only
 * evidence that existed before Week 1 of T (seasons <= T-1 plus the T offseason
 * roster/depth/coaching record), it predicts the LOG RATIO of his opportunity
 * share and his fantasy PPG against T-1, from a set of individually tested
 * change features:
 *
 *   team change x vacated opportunity on the new team (continuous)
 *   depth-chart slot at T vs usage rank at T-1
 *   starting QB change for a team's pass catchers
 *   head-coach change
 *   prior-season games missed (return-to-health)
 *   the net vacated share of the team he is on, mover or not
 *   age x position
 *   team implied-total change (Week 1 line at T vs T-1 season mean)
 *
 * THE MEAN-REVERSION PROBLEM IS THE WHOLE PROBLEM. A player with a 30% target
 * share almost always falls; a player with a 6% share almost always rises;
 * neither has anything to do with the offseason. Every effect here is measured
 * as a residual AFTER a position-specific mean-reversion baseline (log ratio
 * regressed on prior log share), so "movers decline" cannot be a restatement of
 * "the players who move are the ones who had more to lose".
 *
 * Nothing is granted a coefficient for being plausible. `walkForward()` fits on
 * seasons < T and grades on T for T in 2023/2024/2025 against three baselines
 * (no change, mean reversion only, and the flat "movers keep 78%" rule), with a
 * paired bootstrap. docs/OFFSEASON_MODEL.md records what survived and what did
 * not — DRAFT_AUDIT_2021_2025 already found age cliffs and coaching changes
 * unsupported at the PPG level, and both are re-tested here at the share level
 * rather than assumed either way.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not read season-T game results.
 * It does not write to the database. It does not modify the weekly engine. It
 * publishes multipliers and drivers; the preseason projection, the draft
 * advisor and (through team aggregates only) the betting engine decide what to
 * do with them.
 */
import { rows } from '../db/index.js';
import { canonicalTeamCode } from './team-codes.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import { fitGbm, predictGbm } from './nfl-gbm.js';

const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);
/** Depth/roster evidence for the T offseason exists from 2021 (nfl_depth) forward. */
export const FIRST_DEPTH_SEASON = 2021;
/** Weekly usage features exist from 2016. */
export const FIRST_FEATURE_SEASON = 2016;

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const finite = v => (Number.isFinite(v) ? v : null);
const r4 = v => (Number.isFinite(v) ? +v.toFixed(4) : null);
const r3 = v => (Number.isFinite(v) ? +v.toFixed(3) : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** PPR fantasy points from one weekly feature blob. Fumbles are not in the blob. */
export function pprPoints(f) {
  return 0.04 * (f.passing_yards ?? 0) + 4 * (f.passing_tds ?? 0) - 2 * (f.interceptions ?? 0)
    + 0.1 * (f.rushing_yards ?? 0) + 6 * (f.rushing_tds ?? 0)
    + (f.receptions ?? 0) + 0.1 * (f.receiving_yards ?? 0) + 6 * (f.receiving_tds ?? 0);
}

// ---------------------------------------------------------------------------
// Season aggregates
// ---------------------------------------------------------------------------

const seasonCache = new Map();

/**
 * One season of weekly usage collapsed to per-player and per-team totals.
 *
 * `opportunity_share` is already computed per week in nfl_player_week_features
 * (the player's share of his team's targets + carries + attempts that week), so
 * the season figure is the games-played mean of it — a rate, not a total, which
 * is what has to be compared across seasons of different lengths and different
 * games-played counts.
 */
export function seasonAggregate(season) {
  if (seasonCache.has(season)) return seasonCache.get(season);
  const raw = rows(`SELECT season, week, player_id, player_name, team, position, features
                    FROM nfl_player_week_features WHERE season = ?`, season);

  const players = new Map();      // gsis -> aggregate
  const byPlayerTeam = new Map(); // gsis|team -> opportunity counts
  const teamTotals = new Map();   // team -> counts

  for (const row of raw) {
    if (!row.team) continue;
    let f;
    try { f = JSON.parse(row.features); } catch { continue; }
    const team = canonicalTeamCode(row.team);
    const targets = f.targets ?? 0, carries = f.carries ?? 0, attempts = f.pass_attempts ?? 0;
    const opp = targets + carries + attempts;
    const pos = row.position ?? null;

    const t = teamTotals.get(team) ?? { targets: 0, carries: 0, attempts: 0, opportunity: 0 };
    t.targets += targets; t.carries += carries; t.attempts += attempts; t.opportunity += opp;
    teamTotals.set(team, t);

    const ptKey = `${row.player_id}|${team}`;
    const pt = byPlayerTeam.get(ptKey)
      ?? { player_id: row.player_id, team, targets: 0, carries: 0, attempts: 0, opportunity: 0, games: 0 };
    pt.targets += targets; pt.carries += carries; pt.attempts += attempts;
    pt.opportunity += opp; pt.games += 1;
    byPlayerTeam.set(ptKey, pt);

    const p = players.get(row.player_id) ?? {
      player_id: row.player_id, name: row.player_name, position: pos,
      games: 0, targets: 0, carries: 0, attempts: 0, opportunity: 0,
      shareSum: 0, targetShareSum: 0, points: 0, teams: new Map()
    };
    p.games += 1;
    p.targets += targets; p.carries += carries; p.attempts += attempts; p.opportunity += opp;
    p.shareSum += f.opportunity_share ?? 0;
    p.targetShareSum += f.target_share ?? 0;
    p.points += pprPoints(f);
    p.teams.set(team, (p.teams.get(team) ?? 0) + opp + 1); // +1 so a zero-usage week still counts
    if (!p.position && pos) p.position = pos;
    players.set(row.player_id, p);
  }

  for (const p of players.values()) {
    p.team = [...p.teams.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    p.opp_share = p.games ? p.shareSum / p.games : null;
    p.target_share = p.games ? p.targetShareSum / p.games : null;
    p.ppg = p.games ? p.points / p.games : null;
    p.opp_per_game = p.games ? p.opportunity / p.games : null;
  }

  const out = { season, players, byPlayerTeam, teamTotals };
  seasonCache.set(season, out);
  return out;
}

// ---------------------------------------------------------------------------
// Where a player is at the START of season T (no season-T results used)
// ---------------------------------------------------------------------------

const rosterCache = new Map();

/**
 * Team + depth slot for every player as of the start of season T.
 *
 * Preference order, and the reason for it:
 *   1. nfl_depth week 1 (2021+). Captured at the season opener, before any
 *      season-T game is in the features table. This is the clean source and it
 *      covers every walk-forward evaluation season.
 *   2. nfl_roster_snapshots (the configured season, 2026). Dated ESPN captures
 *      with depth_slot/depth_order; the only source that exists before Week 1.
 *   3. Season-T primary usage team. An APPROXIMATION used only to extend the
 *      TRAINING panel back to 2018, where no depth chart was ever recorded. It
 *      reads where the player actually played, so it is not strictly
 *      pre-season; team identity is settled in the offseason for nearly
 *      everyone, but rows built this way are flagged `team_source: 'usage'` and
 *      never appear in an evaluation season.
 */
export function rosterAtSeasonStart(season) {
  if (rosterCache.has(season)) return rosterCache.get(season);
  const out = new Map();
  let source = 'usage';

  const depth = season >= FIRST_DEPTH_SEASON
    ? rows(`SELECT team, gsis_id, pos_abb, pos_rank, captured FROM nfl_depth
            WHERE season = ? AND week = 1 AND gsis_id IS NOT NULL`, season)
    : [];
  if (depth.length > 200) {
    source = 'depth';
    // One player can hold several pos_abb rows (RB and FB). Keep the earliest
    // capture, and among ties the row whose pos_abb matches his listed spot.
    for (const d of depth) {
      const prev = out.get(d.gsis_id);
      if (prev && prev.captured <= d.captured && prev.depth_rank <= (d.pos_rank ?? 99)) continue;
      out.set(d.gsis_id, {
        player_id: d.gsis_id, team: canonicalTeamCode(d.team),
        depth_rank: d.pos_rank ?? null, depth_slot: d.pos_abb ?? null,
        captured: d.captured, source: 'depth'
      });
    }
  } else {
    const snapDate = rows(`SELECT MAX(captured_at) c FROM nfl_roster_snapshots`)[0]?.c ?? null;
    const snaps = snapDate
      ? rows(`SELECT team, gsis_id, position, depth_slot, depth_order, status
              FROM nfl_roster_snapshots WHERE captured_at = ? AND gsis_id IS NOT NULL`, snapDate)
      : [];
    if (snaps.length > 200) {
      source = 'roster_snapshot';
      for (const s of snaps) {
        if (s.status === 'free-agent' || s.status === 'free_agent') continue;
        const prev = out.get(s.gsis_id);
        const rank = Number.isFinite(s.depth_order) ? s.depth_order : null;
        if (prev && (prev.depth_rank ?? 99) <= (rank ?? 99)) continue;
        out.set(s.gsis_id, {
          player_id: s.gsis_id, team: canonicalTeamCode(s.team),
          depth_rank: rank, depth_slot: s.depth_slot ?? s.position ?? null,
          captured: snapDate, source: 'roster_snapshot'
        });
      }
    }
  }

  // Fallback for players with no depth row at all (and for pre-2021 training
  // seasons): where the season-T features say he played.
  const agg = seasonAggregate(season);
  for (const p of agg.players.values()) {
    if (out.has(p.player_id)) continue;
    if (!p.team) continue;
    out.set(p.player_id, {
      player_id: p.player_id, team: p.team, depth_rank: null, depth_slot: p.position,
      captured: null, source: 'usage'
    });
  }

  const result = { season, source, players: out };
  rosterCache.set(season, result);
  return result;
}

/**
 * Team-level offseason context for season T: what left the building, who is
 * calling the plays, who is throwing the ball, and what the market thinks.
 */
export function teamOffseasonSummary(season) {
  const prior = seasonAggregate(season - 1);
  const roster = rosterAtSeasonStart(season);
  const teamOf = new Map([...roster.players.values()].map(r => [r.player_id, r.team]));

  const teams = new Map();
  const touch = team => {
    if (!teams.has(team)) {
      teams.set(team, {
        team, season,
        prior_targets: 0, prior_carries: 0, prior_attempts: 0, prior_opportunity: 0,
        vacated_targets: 0, vacated_carries: 0, vacated_attempts: 0, vacated_opportunity: 0,
        departures: [], arrivals: []
      });
    }
    return teams.get(team);
  };
  for (const t of prior.teamTotals.keys()) touch(t);
  for (const r of roster.players.values()) touch(r.team);

  for (const pt of prior.byPlayerTeam.values()) {
    const t = touch(pt.team);
    t.prior_targets += pt.targets; t.prior_carries += pt.carries;
    t.prior_attempts += pt.attempts; t.prior_opportunity += pt.opportunity;
    const now = teamOf.get(pt.player_id) ?? null;
    if (now !== pt.team) {
      t.vacated_targets += pt.targets; t.vacated_carries += pt.carries;
      t.vacated_attempts += pt.attempts; t.vacated_opportunity += pt.opportunity;
      const p = prior.players.get(pt.player_id);
      if (pt.opportunity > 0) {
        t.departures.push({ player_id: pt.player_id, name: p?.name ?? null, position: p?.position ?? null,
          to: now, prior_opportunity: pt.opportunity, prior_targets: pt.targets, prior_carries: pt.carries });
      }
    }
  }
  for (const r of roster.players.values()) {
    const before = prior.players.get(r.player_id);
    if (!before || before.team === r.team) continue;
    const t = touch(r.team);
    t.arrivals.push({ player_id: r.player_id, name: before.name, position: before.position,
      from: before.team, prior_opportunity: before.opportunity,
      prior_opp_share: r4(before.opp_share) });
  }

  // Coaching: nfl_team_coaches carries HEAD COACH by season, 2015 onward. There
  // is no season-dimensioned coordinator table anywhere in this database
  // (nfl_teams.oc_name is one undated current snapshot), so an OC-change effect
  // is not measurable and is not offered here — see the docs.
  const coaches = new Map(rows('SELECT team, coach FROM nfl_team_coaches WHERE season = ?', season)
    .map(c => [canonicalTeamCode(c.team), c.coach]));
  const priorCoaches = new Map(rows('SELECT team, coach FROM nfl_team_coaches WHERE season = ?', season - 1)
    .map(c => [canonicalTeamCode(c.team), c.coach]));

  const qbNow = qb1ByTeam(season);
  const qbPrior = qb1FromUsage(season - 1);
  // Names for the driver sentences. A QB the model has never seen play (a
  // drafted rookie starter) has no usage row, so fall back to the roster feed.
  const names = new Map([...prior.players.values()].map(p => [p.player_id, p.name]));
  for (const r of rows(`SELECT gsis_id, player_name FROM nfl_roster_snapshots
                        WHERE gsis_id IS NOT NULL GROUP BY gsis_id`)) {
    if (!names.has(r.gsis_id)) names.set(r.gsis_id, r.player_name);
  }
  for (const r of rows(`SELECT gsis_id, player_name FROM nfl_depth
                        WHERE season = ? GROUP BY gsis_id`, season)) {
    if (!names.has(r.gsis_id)) names.set(r.gsis_id, r.player_name);
  }

  const impliedPrior = new Map();
  for (const r of rows(`SELECT team, AVG(implied_points) ip FROM game_lines
                        WHERE season = ? AND implied_points IS NOT NULL GROUP BY team`, season - 1)) {
    impliedPrior.set(canonicalTeamCode(r.team), r.ip);
  }
  const impliedNow = new Map();
  for (const r of rows(`SELECT team, implied_points ip FROM game_lines
                        WHERE season = ? AND week = 1 AND implied_points IS NOT NULL`, season)) {
    impliedNow.set(canonicalTeamCode(r.team), r.ip);
  }

  for (const t of teams.values()) {
    t.vacated_target_share = t.prior_targets > 0 ? r4(t.vacated_targets / t.prior_targets) : null;
    t.vacated_carry_share = t.prior_carries > 0 ? r4(t.vacated_carries / t.prior_carries) : null;
    t.vacated_attempt_share = t.prior_attempts > 0 ? r4(t.vacated_attempts / t.prior_attempts) : null;
    t.vacated_opportunity_share = t.prior_opportunity > 0
      ? r4(t.vacated_opportunity / t.prior_opportunity) : null;
    t.head_coach = coaches.get(t.team) ?? null;
    t.prior_head_coach = priorCoaches.get(t.team) ?? null;
    t.head_coach_change = t.head_coach && t.prior_head_coach ? t.head_coach !== t.prior_head_coach : null;
    t.qb1 = qbNow.get(t.team) ?? null;
    t.prior_qb1 = qbPrior.get(t.team) ?? null;
    t.qb1_name = names.get(t.qb1) ?? null;
    t.prior_qb1_name = names.get(t.prior_qb1) ?? null;
    t.qb1_change = t.qb1 && t.prior_qb1 ? t.qb1 !== t.prior_qb1 : null;
    t.prior_implied_points = r3(impliedPrior.get(t.team) ?? null);
    t.week1_implied_points = r3(impliedNow.get(t.team) ?? null);
    t.implied_points_delta = Number.isFinite(t.prior_implied_points) && Number.isFinite(t.week1_implied_points)
      ? r3(t.week1_implied_points - t.prior_implied_points) : null;
    t.departures.sort((a, b) => b.prior_opportunity - a.prior_opportunity);
    t.arrivals.sort((a, b) => b.prior_opportunity - a.prior_opportunity);
    t.notable_departures = t.departures.slice(0, 5);
    t.notable_arrivals = t.arrivals.slice(0, 5);
  }
  return { season, roster_source: roster.source, teams };
}

/** Team -> gsis of the QB listed first at the start of season T. */
function qb1ByTeam(season) {
  const roster = rosterAtSeasonStart(season);
  const best = new Map();
  for (const r of roster.players.values()) {
    const slot = String(r.depth_slot ?? '').toUpperCase();
    if (slot !== 'QB') continue;
    const rank = r.depth_rank ?? 99;
    const cur = best.get(r.team);
    if (!cur || rank < cur.rank) best.set(r.team, { rank, id: r.player_id });
  }
  return new Map([...best.entries()].map(([team, v]) => [team, v.id]));
}

/** Team -> gsis of the QB who threw the most passes for it in a completed season. */
function qb1FromUsage(season) {
  const agg = seasonAggregate(season);
  const best = new Map();
  for (const pt of agg.byPlayerTeam.values()) {
    if (pt.attempts <= 0) continue;
    const cur = best.get(pt.team);
    if (!cur || pt.attempts > cur.attempts) best.set(pt.team, { attempts: pt.attempts, id: pt.player_id });
  }
  return new Map([...best.entries()].map(([team, v]) => [team, v.id]));
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

const bioCache = { map: null };
function bio() {
  if (bioCache.map) return bioCache.map;
  bioCache.map = new Map(rows(`SELECT gsis_id, birth_date, rookie_season, draft_round, draft_pick
                               FROM nflverse_player_positions`).map(r => [r.gsis_id, r]));
  return bioCache.map;
}

function ageAt(birthDate, season) {
  if (!birthDate) return null;
  const born = Date.parse(`${String(birthDate).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(born)) return null;
  return (Date.parse(`${season}-09-01T00:00:00Z`) - born) / (365.25 * 24 * 3600 * 1000);
}

/** Peak age by position, from dynasty-age-curve's cited anchors. Used as a centre, not a cliff. */
const PEAK_AGE = { RB: 26, WR: 26.5, TE: 27, QB: 29, FB: 27 };

const panelCache = new Map();

/**
 * One row per player who has a season T-1 usage record and is on a season T
 * roster. Features are all knowable before Week 1 of T; outcomes are the log
 * ratio of opportunity share and of PPG.
 *
 * Players who never appear in season T are excluded rather than scored as zero:
 * log(0) has no value and imputing one would put the entire effect in the
 * imputation. Their attrition rate is reported separately by `attrition()`,
 * because "the mover was cut" is a real part of the mover story and hiding it
 * inside a multiplier would overstate what the multiplier does.
 */
export function buildPanel(season, { minPriorGames = 4, minSeasonGames = 3 } = {}) {
  const key = `${season}|${minPriorGames}|${minSeasonGames}`;
  if (panelCache.has(key)) return panelCache.get(key);

  const prior = seasonAggregate(season - 1);
  const prior2 = season - 2 >= FIRST_FEATURE_SEASON ? seasonAggregate(season - 2) : null;
  const summary = teamOffseasonSummary(season);
  const roster = rosterAtSeasonStart(season);
  const bios = bio();
  const current = season <= latestCompletedSeason() ? seasonAggregate(season) : null;

  // Prior-season usage rank inside the player's own position room, on his old
  // team: the honest "was he the RB1 last year" that a depth chart at T can be
  // compared against.
  const priorRank = new Map();
  const byTeamPos = new Map();
  for (const p of prior.players.values()) {
    if (!p.team || !SKILL.has(p.position)) continue;
    const k = `${p.team}|${p.position}`;
    if (!byTeamPos.has(k)) byTeamPos.set(k, []);
    byTeamPos.get(k).push(p);
  }
  for (const list of byTeamPos.values()) {
    list.sort((a, b) => b.opportunity - a.opportunity);
    list.forEach((p, i) => priorRank.set(p.player_id, i + 1));
  }

  const injuryWeeks = new Map();
  for (const r of rows(`SELECT gsis_id, COUNT(*) n FROM nfl_injuries
                        WHERE season = ? AND report_status IN ('Out','Doubtful','IR')
                        GROUP BY gsis_id`, season - 1)) {
    injuryWeeks.set(r.gsis_id, r.n);
  }
  // How many REGULAR-SEASON games the player's old team actually played, so
  // "games missed" is missed games and not a playoff run. game_lines counts
  // postseason weeks too, which silently turned a healthy 17-game season into
  // four missed games for every player on a team that reached a conference
  // championship.
  const teamGames = new Map(rows(`SELECT team, COUNT(DISTINCT week) n FROM nfl_player_week_features
                                  WHERE season = ? AND week <= 18 GROUP BY team`, season - 1)
    .map(r => [canonicalTeamCode(r.team), r.n]));

  const out = [];
  for (const before of prior.players.values()) {
    if (!SKILL.has(before.position)) continue;
    if (before.games < minPriorGames) continue;
    if (!(before.opp_share > 0)) continue;
    const spot = roster.players.get(before.player_id);
    if (!spot?.team) continue;                    // out of the league at T
    const team = spot.team;
    const t = summary.teams.get(team) ?? null;
    const oldTeam = summary.teams.get(before.team) ?? null;

    // Vacated opportunity on the team he is on at T, EXCLUDING himself — a
    // stayer must not be credited with the share he already holds, and a mover
    // must not be credited with the share he brought.
    const selfPrior = prior.byPlayerTeam.get(`${before.player_id}|${team}`)?.opportunity ?? 0;
    const teamPriorOpp = t?.prior_opportunity ?? 0;
    const vacatedOpp = t?.vacated_opportunity ?? 0;
    const vacated = teamPriorOpp > 0
      ? clamp((vacatedOpp - (before.team === team ? 0 : 0)) / teamPriorOpp, 0, 1) : null;
    const denom = teamPriorOpp - selfPrior;
    const vacatedExSelf = denom > 0 ? clamp(vacatedOpp / denom, 0, 1) : vacated;

    const changedTeam = before.team !== team;
    const qbChange = t?.qb1_change === true;
    const hcChange = t?.head_coach_change === true;
    // nfl_depth only ever lists three deep at a position, so a prior usage rank
    // of 6 compared against a listed rank of 3 would read as a two-step
    // promotion for every deep bench player in the league. Both sides are
    // capped at 3 so the delta compares like with like.
    const rank = priorRank.get(before.player_id) ?? null;
    const depthRank = spot.depth_rank ?? null;
    const cappedRank = Number.isFinite(rank) ? Math.min(rank, 3) : null;
    const cappedDepth = Number.isFinite(depthRank) ? Math.min(depthRank, 3) : null;
    const depthDelta = Number.isFinite(cappedDepth) && Number.isFinite(cappedRank)
      ? cappedDepth - cappedRank : null;

    const games = before.games;
    const scheduled = teamGames.get(before.team) ?? 17;
    const missed = clamp(scheduled - games, 0, 17);
    const b = bios.get(before.player_id) ?? {};
    const age = ageAt(b.birth_date, season);
    const peak = PEAK_AGE[before.position] ?? 27;

    const after = current?.players.get(before.player_id) ?? null;
    const playedAtT = !!after && after.games >= 1;
    const usable = after && after.games >= minSeasonGames && after.opp_share > 0;

    const priorPrior = prior2?.players.get(before.player_id) ?? null;

    out.push({
      season, player_id: before.player_id, name: before.name, position: before.position,
      prior_team: before.team, team, team_source: spot.source,
      // --- features (all pre-Week-1 of T) ---
      prior_opp_share: r4(before.opp_share),
      prior_log_share: Math.log(before.opp_share),
      prior_ppg: r3(before.ppg),
      prior_games: games,
      two_year_share_trend: priorPrior?.opp_share > 0 && before.opp_share > 0
        ? r4(Math.log(before.opp_share / priorPrior.opp_share)) : null,
      changed_team: changedTeam ? 1 : 0,
      vacated_share_new_team: r4(vacatedExSelf),
      old_team_vacated_share: oldTeam?.vacated_opportunity_share ?? null,
      depth_rank: depthRank, prior_usage_rank: rank, depth_rank_delta: depthDelta,
      qb1_change: qbChange ? 1 : 0,
      hc_change: hcChange ? 1 : 0,
      games_missed_prior: missed,
      weeks_listed_out_prior: injuryWeeks.get(before.player_id) ?? 0,
      age: r3(age), age_from_peak: Number.isFinite(age) ? r3(age - peak) : null,
      draft_round: b.draft_round ?? null,
      rookie_season: b.rookie_season ?? null,
      implied_points_delta: t?.implied_points_delta ?? null,
      // --- outcomes (season T; null for the projected season) ---
      played_at_t: playedAtT,
      season_games: after?.games ?? 0,
      opp_share: after ? r4(after.opp_share) : null,
      ppg: after ? r3(after.ppg) : null,
      y_share: usable ? Math.log(after.opp_share / before.opp_share) : null,
      y_ppg: usable && after.ppg > 0 && before.ppg > 0 ? Math.log(after.ppg / before.ppg) : null,
      usable
    });
  }
  panelCache.set(key, out);
  return out;
}

let _latest = null;
function latestCompletedSeason() {
  if (_latest != null) return _latest;
  _latest = rows('SELECT MAX(season) s FROM nfl_player_week_features')[0]?.s ?? 2025;
  return _latest;
}

/** Every panel row that has an outcome, for the seasons given. */
export function panelFor(seasons, opts) {
  return seasons.flatMap(s => buildPanel(s, opts)).filter(r => r.usable);
}

// ---------------------------------------------------------------------------
// Mean reversion baseline: everything else is measured against this
// ---------------------------------------------------------------------------

/**
 * Per position, the ordinary least squares fit of the log share ratio on the
 * prior log share. The slope is strongly negative for every position — that is
 * regression to the mean, and it is NOT an offseason effect. Fitting it first
 * and measuring every change feature on the residual is the whole reason the
 * effects below can be read as offseason effects at all.
 */
export function fitMeanReversion(panelRows, field = 'y_share') {
  const byPos = new Map();
  for (const r of panelRows) {
    if (!Number.isFinite(r[field])) continue;
    if (!byPos.has(r.position)) byPos.set(r.position, []);
    byPos.get(r.position).push(r);
  }
  const model = { by_position: {}, pooled: null };
  const ols = list => {
    const xs = list.map(r => r.prior_log_share), ys = list.map(r => r[field]);
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const slope = den > 0 ? num / den : 0;
    return { intercept: my - slope * mx, slope, n: list.length };
  };
  const all = [...byPos.values()].flat();
  model.pooled = all.length ? ols(all) : { intercept: 0, slope: 0, n: 0 };
  for (const [pos, list] of byPos) model.by_position[pos] = list.length >= 40 ? ols(list) : model.pooled;
  return model;
}

export function meanReversionPredict(model, row) {
  const c = model.by_position[row.position] ?? model.pooled;
  if (!c) return 0;
  return c.intercept + c.slope * row.prior_log_share;
}

// ---------------------------------------------------------------------------
// Effect measurement: one tested effect at a time, on the same player set
// ---------------------------------------------------------------------------

function bootstrapCI(values, { iterations = 2000, seed = 7 } = {}) {
  const n = values.length;
  if (n < 10) return { mean: r4(mean(values)), lo: null, hi: null, n };
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const means = new Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)];
    means[it] = sum / n;
  }
  means.sort((a, b) => a - b);
  return {
    mean: r4(mean(values)), n,
    lo: r4(means[Math.floor(iterations * 0.025)]),
    hi: r4(means[Math.floor(iterations * 0.975)])
  };
}

/**
 * The effect definitions. Each is a predicate over a panel row plus a
 * contrast group; the effect size is the difference in mean mean-reversion
 * RESIDUAL between the group and its contrast, in log units, so exp(size) is
 * the multiplier the effect implies.
 */
export const EFFECTS = [
  { key: 'team_change', label: 'changed teams',
    group: r => r.changed_team === 1, contrast: r => r.changed_team === 0 },
  { key: 'team_change_high_vacated', label: 'changed teams into a room with >30% vacated',
    group: r => r.changed_team === 1 && r.vacated_share_new_team > 0.30,
    contrast: r => r.changed_team === 1 && r.vacated_share_new_team <= 0.30 },
  { key: 'vacated_high_stayer', label: 'stayed on a team that vacated >30% of opportunity',
    group: r => r.changed_team === 0 && r.vacated_share_new_team > 0.30,
    contrast: r => r.changed_team === 0 && r.vacated_share_new_team <= 0.30 },
  { key: 'depth_demotion', label: 'depth chart fell vs prior usage rank',
    group: r => r.depth_rank_delta > 0, contrast: r => r.depth_rank_delta === 0 },
  { key: 'depth_promotion', label: 'depth chart rose vs prior usage rank',
    group: r => r.depth_rank_delta < 0, contrast: r => r.depth_rank_delta === 0 },
  { key: 'qb_change', label: 'new starting QB (pass catchers)',
    group: r => r.qb1_change === 1 && r.position !== 'QB',
    contrast: r => r.qb1_change === 0 && r.position !== 'QB' },
  { key: 'hc_change', label: 'new head coach',
    group: r => r.hc_change === 1, contrast: r => r.hc_change === 0 },
  { key: 'injury_return', label: 'missed 4+ games last season',
    group: r => r.games_missed_prior >= 4, contrast: r => r.games_missed_prior <= 1 },
  { key: 'age_past_peak', label: '3+ years past positional peak',
    group: r => r.age_from_peak >= 3, contrast: r => r.age_from_peak != null && r.age_from_peak < 3 },
  { key: 'implied_total_up', label: 'team Week 1 implied total up 2+ points',
    group: r => r.implied_points_delta >= 2,
    contrast: r => r.implied_points_delta != null && r.implied_points_delta < 2 }
];

/**
 * Measure every effect on `seasons`, as a residual against a mean-reversion
 * baseline fitted on the SAME rows. The baseline being in-sample here is
 * deliberate: this function is descriptive (what is the effect, with what n and
 * CI). Whether it survives is decided by `walkForward`, which never lets a
 * coefficient see the season it is graded on.
 */
export function measureEffects(seasons, { field = 'y_share' } = {}) {
  const rowsIn = panelFor(seasons).filter(r => Number.isFinite(r[field]));
  const mr = fitMeanReversion(rowsIn, field);
  const resid = new Map(rowsIn.map(r => [r, r[field] - meanReversionPredict(mr, r)]));

  const results = {};
  for (const eff of EFFECTS) {
    const g = rowsIn.filter(eff.group), c = rowsIn.filter(eff.contrast);
    if (g.length < 20 || c.length < 20) {
      results[eff.key] = { label: eff.label, n_group: g.length, n_contrast: c.length,
        insufficient: true };
      continue;
    }
    const gv = g.map(r => resid.get(r)), cv = c.map(r => resid.get(r));
    const gs = bootstrapCI(gv), cs = bootstrapCI(cv);
    const diff = gs.mean - cs.mean;
    // Difference CI by independent bootstrap of both arms.
    const diffCi = (() => {
      let s = 99;
      const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      const d = new Array(2000);
      for (let it = 0; it < 2000; it++) {
        let a = 0, bsum = 0;
        for (let i = 0; i < gv.length; i++) a += gv[Math.floor(rand() * gv.length)];
        for (let i = 0; i < cv.length; i++) bsum += cv[Math.floor(rand() * cv.length)];
        d[it] = a / gv.length - bsum / cv.length;
      }
      d.sort((x, y) => x - y);
      return { lo: r4(d[50]), hi: r4(d[1949]) };
    })();
    results[eff.key] = {
      label: eff.label, field,
      n_group: g.length, n_contrast: c.length,
      group_residual: gs.mean, contrast_residual: cs.mean,
      effect_log: r4(diff), multiplier: r4(Math.exp(diff)),
      ci_log: diffCi, ci_multiplier: { lo: r4(Math.exp(diffCi.lo)), hi: r4(Math.exp(diffCi.hi)) },
      crosses_zero: diffCi.lo <= 0 && diffCi.hi >= 0,
      group_median_raw: r4(median(g.map(r => Math.exp(r[field])))),
      contrast_median_raw: r4(median(c.map(r => Math.exp(r[field]))))
    };
  }
  return { seasons, field, n: rowsIn.length, mean_reversion: mr, effects: results };
}

/** Who is simply gone at T, by mover status — the part a multiplier cannot express. */
export function attrition(seasons) {
  const all = seasons.flatMap(s => buildPanel(s));
  const rate = list => (list.length ? r4(list.filter(r => r.played_at_t).length / list.length) : null);
  const movers = all.filter(r => r.changed_team === 1), stayers = all.filter(r => r.changed_team === 0);
  const byPos = {};
  for (const pos of ['RB', 'WR', 'TE', 'QB']) {
    byPos[pos] = {
      mover_played_rate: rate(movers.filter(r => r.position === pos)),
      stayer_played_rate: rate(stayers.filter(r => r.position === pos)),
      n_movers: movers.filter(r => r.position === pos).length,
      n_stayers: stayers.filter(r => r.position === pos).length
    };
  }
  return { seasons, mover_played_rate: rate(movers), stayer_played_rate: rate(stayers),
    n_movers: movers.length, n_stayers: stayers.length, by_position: byPos,
    note: 'Rows here are players with a prior-season usage record who appear on a season-T roster. ' +
      '"Played" = at least one season-T game in nfl_player_week_features.' };
}

/**
 * Rookies: draft capital entering a room with vacated share.
 *
 * A first-year player has no prior season, so the ratio framework this module
 * is built on cannot express him at all — there is nothing to multiply. He is
 * therefore measured on the LEVEL instead: what opportunity share does a rookie
 * actually get, as a function of where he was drafted and how much of his
 * position room's opportunity walked out the door?
 *
 * Reported, not shipped into `offseasonAdjustment`, and deliberately so: a
 * level model and a multiplier model are different objects, and quietly
 * returning a level as a multiplier of an undefined prior is exactly the kind
 * of category error this codebase's audits keep catching. The preseason model
 * is the right owner for a rookie's level; what it can take from here is the
 * held-out fact below.
 */
export function measureRookieEntry(seasons, { evaluateOn = [] } = {}) {
  const build = season => {
    const summary = teamOffseasonSummary(season);
    const roster = rosterAtSeasonStart(season);
    const prior = seasonAggregate(season - 1);
    const current = season <= latestCompletedSeason() ? seasonAggregate(season) : null;
    const bios = bio();
    const out = [];
    for (const spot of roster.players.values()) {
      if (prior.players.has(spot.player_id)) continue;         // not a first-year player
      const b = bios.get(spot.player_id);
      if (!b || b.rookie_season !== season) continue;          // true draft rookie only
      const after = current?.players.get(spot.player_id) ?? null;
      const pos = after?.position ?? spot.depth_slot ?? null;
      if (!SKILL.has(pos)) continue;
      const t = summary.teams.get(spot.team) ?? null;
      const pick = b.draft_pick ?? (b.draft_round ? b.draft_round * 32 : null);
      out.push({
        season, player_id: spot.player_id, position: pos, team: spot.team,
        draft_pick: pick, draft_round: b.draft_round ?? null,
        log_pick: pick ? Math.log(pick) : null,
        room_vacated: t?.vacated_opportunity_share ?? null,
        depth_rank: spot.depth_rank ?? null,
        opp_share: after && after.games >= 3 ? after.opp_share : null
      });
    }
    return out;
  };

  const train = seasons.flatMap(build).filter(r => r.opp_share != null && r.log_pick != null);
  if (train.length < 40) return { error: `only ${train.length} rookie rows` };

  // log share ~ log(pick) + room vacated, per position group, OLS.
  const design = r => [1, r.log_pick, r.room_vacated ?? 0];
  const fit = list => {
    const X = list.map(design), y = list.map(r => Math.log(r.opp_share));
    const p = 3, A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
    for (let j = 0; j < p; j++) {
      for (let k = 0; k < p; k++) A[j][k] = X.reduce((s, x) => s + x[j] * x[k], 0);
      A[j][p] = X.reduce((s, x, i) => s + x[j] * y[i], 0);
      A[j][j] += 1e-6;
    }
    for (let c = 0; c < p; c++) {
      let piv = c;
      for (let r2 = c + 1; r2 < p; r2++) if (Math.abs(A[r2][c]) > Math.abs(A[piv][c])) piv = r2;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r2 = 0; r2 < p; r2++) {
        if (r2 === c || Math.abs(A[c][c]) < 1e-12) continue;
        const f = A[r2][c] / A[c][c];
        for (let k = c; k <= p; k++) A[r2][k] -= f * A[c][k];
      }
    }
    return A.map((r2, j) => (Math.abs(A[j][j]) < 1e-12 ? 0 : r2[p] / A[j][j]));
  };
  const w = fit(train);

  const heldOut = {};
  for (const season of evaluateOn) {
    const trainPrior = seasons.filter(s => s < season).flatMap(build)
      .filter(r => r.opp_share != null && r.log_pick != null);
    const test = build(season).filter(r => r.opp_share != null && r.log_pick != null);
    if (trainPrior.length < 40 || test.length < 15) {
      heldOut[season] = { error: `train ${trainPrior.length} / test ${test.length}` };
      continue;
    }
    const wf = fit(trainPrior);
    const pred = test.map(r => design(r).reduce((s, v, i) => s + v * wf[i], 0));
    const truth = test.map(r => Math.log(r.opp_share));
    const flat = mean(trainPrior.map(r => Math.log(r.opp_share)));
    heldOut[season] = {
      n: test.length,
      spearman: r4(spearman(pred, truth)),
      mae: r4(mean(pred.map((p, i) => Math.abs(p - truth[i])))),
      mae_flat_mean: r4(mean(truth.map(t => Math.abs(flat - t)))),
      pick_only_spearman: r4(spearman(test.map(r => -r.log_pick), truth)),
      vacated_only_spearman: r4(spearman(test.map(r => r.room_vacated ?? 0), truth))
    };
  }

  return {
    seasons, n: train.length,
    coefficients: { intercept: r4(w[0]), log_draft_pick: r4(w[1]), room_vacated_share: r4(w[2]) },
    interpretation: 'log(rookie opportunity share) = a + b*log(draft pick) + c*(room vacated share). ' +
      'b is negative if earlier picks get more; c is positive if an emptier room helps.',
    held_out: heldOut,
    note: 'Level model, not a multiplier. Rookies keep opportunity_multiplier 1.0 in ' +
      'offseasonAdjustment because there is no prior season to scale.'
  };
}

// ---------------------------------------------------------------------------
// Fitting: design matrix, ridge, empirical-Bayes effect means, GBM challenger
// ---------------------------------------------------------------------------

/**
 * The design matrix.
 *
 * Demotion and promotion are separate columns rather than one signed step
 * count, because they are not symmetric: falling a slot costs ~29% of share
 * (CI 0.65-0.78) while rising one is worth nothing measurable (1.01, CI
 * 0.96-1.06). One signed coefficient would average a real effect against a null
 * one and get both wrong.
 */
export const FEATURE_NAMES = [
  'prior_log_share', 'is_rb', 'is_wr', 'is_te', 'is_qb',
  'changed_team', 'vacated_share', 'changed_x_vacated',
  'depth_demotion_steps', 'depth_promotion_steps', 'depth_missing', 'depth_rank1',
  'qb1_change', 'hc_change',
  'games_missed', 'age_from_peak', 'age_from_peak_sq',
  'implied_delta', 'implied_missing', 'two_year_trend', 'two_year_missing'
];

/**
 * Features whose own effect test did not replicate. Available to the reference
 * candidates, never in the shipped model, never in a published component.
 *
 * A "new head coach" driver attached to a multiplier of 0.99 reads as an
 * insight and is a coin flip. See docs/OFFSEASON_MODEL.md, "Declined".
 */
export const DECLINED_FEATURES = Object.freeze(['qb1_change', 'hc_change', 'implied_delta']);

/**
 * THE SHIPPED FEATURE SET, and the reason it is this short.
 *
 * The nested ablation (docs/OFFSEASON_MODEL.md) found two things that have to
 * be held together:
 *
 *   1. Over a plain mean-reversion prior, the change block is worth a real,
 *      held-out 0.0091 log units of share MAE (ci90 -0.0156..-0.0028, 2023-25
 *      pooled). That is the case for shipping it.
 *   2. Add the two-year usage trend, the age terms and a flag for whether the
 *      player is listed first on the season-T depth chart, and the change block
 *      is worth 0.0012 and not significant. Those three features SUBSUME it.
 *
 * So the multiplier is real but it is not additional. It is published for a
 * consumer whose prior is a prior-season rate — which is precisely the
 * preseason projection's and the draft advisor's situation — and it must not be
 * stacked on a model that already conditions on the season-T depth chart. That
 * constraint is not a footnote; it is the contract, and it is repeated in the
 * docs and in the feature-contract section for the betting engine.
 */
export const SHIPPED_FEATURES = Object.freeze([
  'prior_log_share', 'is_rb', 'is_wr', 'is_te', 'is_qb',
  'changed_team', 'vacated_share', 'changed_x_vacated',
  'depth_demotion_steps', 'depth_promotion_steps', 'games_missed'
]);

/** Project a full feature vector onto a subset, zeroing everything else. */
export function keepFeatures(vector, names) {
  const out = new Array(FEATURE_NAMES.length).fill(0);
  for (const n of names) { const j = FEATURE_NAMES.indexOf(n); if (j >= 0) out[j] = vector[j]; }
  return out;
}

/** The design row the shipped model actually sees. */
export const shippedVector = r => keepFeatures(featureVector(r), SHIPPED_FEATURES);

export function featureVector(r) {
  const vac = Number.isFinite(r.vacated_share_new_team) ? r.vacated_share_new_team : 0;
  const dd = Number.isFinite(r.depth_rank_delta) ? r.depth_rank_delta : 0;
  const afp = Number.isFinite(r.age_from_peak) ? r.age_from_peak : 0;
  const imp = Number.isFinite(r.implied_points_delta) ? r.implied_points_delta : 0;
  const tyt = Number.isFinite(r.two_year_share_trend) ? r.two_year_share_trend : 0;
  return [
    r.prior_log_share,
    r.position === 'RB' ? 1 : 0, r.position === 'WR' ? 1 : 0,
    r.position === 'TE' ? 1 : 0, r.position === 'QB' ? 1 : 0,
    r.changed_team, vac, r.changed_team * vac,
    Math.max(dd, 0), Math.max(-dd, 0),
    Number.isFinite(r.depth_rank_delta) ? 0 : 1, r.depth_rank === 1 ? 1 : 0,
    r.qb1_change, r.hc_change,
    Math.min(r.games_missed_prior, 12), afp, afp * afp,
    imp, Number.isFinite(r.implied_points_delta) ? 0 : 1,
    tyt, Number.isFinite(r.two_year_share_trend) ? 0 : 1
  ];
}

/** Ridge regression by normal equations with Gaussian elimination. Intercept unpenalised. */
export function fitRidge(X, y, lambda) {
  const p = X[0].length, n = X.length;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    let s = 0; for (let i = 0; i < n; i++) s += X[i][j];
    mu[j] = s / n;
    let v = 0; for (let i = 0; i < n; i++) v += (X[i][j] - mu[j]) ** 2;
    sd[j] = Math.sqrt(v / n) || 1;
  }
  const Z = X.map(row => row.map((v, j) => (v - mu[j]) / sd[j]));
  const yBar = mean(y);
  const A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let j = 0; j < p; j++) {
    for (let k = j; k < p; k++) {
      let s = 0; for (let i = 0; i < n; i++) s += Z[i][j] * Z[i][k];
      A[j][k] = s; A[k][j] = s;
    }
    A[j][j] += lambda;
    let s = 0; for (let i = 0; i < n; i++) s += Z[i][j] * (y[i] - yBar);
    A[j][p] = s;
  }
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) continue;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k];
    }
  }
  const w = new Array(p).fill(0);
  for (let j = 0; j < p; j++) w[j] = Math.abs(A[j][j]) < 1e-12 ? 0 : A[j][p] / A[j][j];
  return { weights: w, mu, sd, intercept: yBar, lambda, featureNames: FEATURE_NAMES };
}

export function predictRidge(model, x) {
  let s = model.intercept;
  for (let j = 0; j < model.weights.length; j++) s += model.weights[j] * (x[j] - model.mu[j]) / model.sd[j];
  return s;
}

/**
 * Empirical-Bayes shrunken effect means: the mean-reversion baseline plus, for
 * each categorical change, its mean residual shrunk toward zero by
 * n / (n + prior). Additive and inspectable — the model you would write on a
 * napkin — and it is the one that has to be beaten before anything fancier
 * earns the slot.
 */
export function fitShrunkenMeans(panelRows, { field = 'y_share', prior = 60 } = {}) {
  const mr = fitMeanReversion(panelRows, field);
  const resid = panelRows.map(r => ({ r, e: r[field] - meanReversionPredict(mr, r) }));
  const cells = [
    { key: 'moved_low_vacated', test: r => r.changed_team === 1 && r.vacated_share_new_team <= 0.30 },
    { key: 'moved_high_vacated', test: r => r.changed_team === 1 && r.vacated_share_new_team > 0.30 },
    { key: 'stayed_high_vacated', test: r => r.changed_team === 0 && r.vacated_share_new_team > 0.30 },
    { key: 'depth_demoted', test: r => r.depth_rank_delta > 0 },
    { key: 'depth_promoted', test: r => r.depth_rank_delta < 0 },
    { key: 'qb1_change', test: r => r.qb1_change === 1 && r.position !== 'QB' },
    { key: 'hc_change', test: r => r.hc_change === 1 },
    { key: 'missed_4plus', test: r => r.games_missed_prior >= 4 },
    { key: 'past_peak', test: r => r.age_from_peak >= 3 }
  ];
  const coef = {};
  for (const c of cells) {
    const hit = resid.filter(x => c.test(x.r));
    const m = hit.length ? mean(hit.map(x => x.e)) : 0;
    coef[c.key] = { raw: r4(m), n: hit.length, value: r4(m * (hit.length / (hit.length + prior))) };
  }
  return { field, mean_reversion: mr, cells, coefficients: coef, prior };
}

export function predictShrunkenMeans(model, row) {
  let s = meanReversionPredict(model.mean_reversion, row);
  for (const c of model.cells) if (c.test(row)) s += model.coefficients[c.key]?.value ?? 0;
  return s;
}

// ---------------------------------------------------------------------------
// Walk-forward
// ---------------------------------------------------------------------------

function spearman(a, b) {
  const rank = v => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const out = new Array(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
      i = j + 1;
    }
    return out;
  };
  const ra = rank(a), rb = rank(b);
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, dbv = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; dbv += (rb[i] - mb) ** 2;
  }
  return da > 0 && dbv > 0 ? num / Math.sqrt(da * dbv) : null;
}

/** The flat rule already in production: movers keep 74/78/82% of prior opportunity. */
export const FLAT_MOVER_FACTOR = { WR: 0.74, RB: 0.78, TE: 0.82, QB: 0.78, FB: 0.78 };
function flatRulePredict(row) {
  return row.changed_team === 1 ? Math.log(FLAT_MOVER_FACTOR[row.position] ?? 0.78) : 0;
}

/**
 * Fit on seasons < T, grade on T. Four candidates against three baselines.
 *
 * The comparison set is identical for every candidate and every baseline: the
 * same test rows, the same outcome, the same paired bootstrap clustered by
 * team-season (teammates share one offense's shocks and are not independent
 * observations).
 */
export const LAMBDA_GRID = Object.freeze([1, 3, 10, 30, 100, 300, 1000]);

/**
 * Ridge penalty by leave-one-SEASON-out inside the training window.
 *
 * Holding out a single season rather than random rows matters: teammates share
 * an offense and rows within a season are not independent, so a random split
 * leaks and picks a penalty far too small. An earlier version held out only the
 * last training season and chose lambda=1 for 2025 and lambda=300 for the other
 * two — an instability that was entirely an artefact of the split.
 */
export function chooseLambda(train, field, grid = LAMBDA_GRID, vec = featureVector) {
  const seasons = [...new Set(train.map(r => r.season))];
  if (seasons.length < 2) return 30;
  let best = null;
  for (const l of grid) {
    let err = 0, n = 0;
    for (const held of seasons) {
      const tr = train.filter(r => r.season !== held), te = train.filter(r => r.season === held);
      if (!te.length || tr.length < 100) continue;
      const m = fitRidge(tr.map(vec), tr.map(r => r[field]), l);
      for (const r of te) { err += Math.abs(predictRidge(m, vec(r)) - r[field]); n++; }
    }
    if (n && (best == null || err / n < best.e)) best = { e: err / n, l };
  }
  return best ? best.l : 30;
}

export function walkForward({
  testSeasons = [2023, 2024, 2025], firstFitSeason = FIRST_DEPTH_SEASON,
  field = 'y_share', lambdas = LAMBDA_GRID, gbm = true
} = {}) {
  const perSeason = [];
  const pooled = {};
  for (const season of testSeasons) {
    const fitSeasons = [];
    for (let s = firstFitSeason; s < season; s++) fitSeasons.push(s);
    const train = panelFor(fitSeasons).filter(r => Number.isFinite(r[field]));
    const test = buildPanel(season).filter(r => r.usable && Number.isFinite(r[field]));
    if (train.length < 200 || test.length < 50) {
      perSeason.push({ season, error: `train ${train.length} / test ${test.length} too thin` });
      continue;
    }

    const mr = fitMeanReversion(train, field);
    const eb = fitShrunkenMeans(train, { field });
    const Xtr = train.map(featureVector), ytr = train.map(r => r[field]);

    const lambda = chooseLambda(train, field, lambdas);
    const ridge = fitRidge(Xtr, ytr, lambda);
    const shippedLambda = chooseLambda(train, field, lambdas, shippedVector);
    const shipped = fitRidge(train.map(shippedVector), ytr, shippedLambda);

    let gbmModel = null;
    if (gbm) {
      try {
        gbmModel = fitGbm(Xtr, ytr, { trees: 120, learningRate: 0.05, maxDepth: 3, minLeaf: 40, seed: 5 });
      } catch { gbmModel = null; }
    }

    const truth = test.map(r => r[field]);
    const preds = {
      no_change: test.map(() => 0),
      flat_mover_rule: test.map(flatRulePredict),
      mean_reversion: test.map(r => meanReversionPredict(mr, r)),
      shrunken_means: test.map(r => predictShrunkenMeans(eb, r)),
      ridge: test.map(r => predictRidge(ridge, featureVector(r))),
      // THE SHIPPED QUANTITY. `offseasonAdjustment` does not publish the ridge
      // prediction — it publishes the ridge's partial effect with respect to
      // the change features only, applied on top of whatever prior the caller
      // already has. This grades exactly that: mean reversion (the caller's
      // prior, stood in for) times the published multiplier. If this row does
      // not beat `mean_reversion`, the multiplier is not worth publishing.
      shipped_adjustment: test.map(r => predictRidge(shipped, shippedVector(r)))
    };
    if (gbmModel) preds.gbm = test.map(r => predictGbm(gbmModel, featureVector(r)));

    const groups = test.map(r => `${r.season}|${r.team}`);
    const err = p => p.map((v, i) => Math.abs(v - truth[i]));
    const baseErr = err(preds.no_change);
    const mrErr = err(preds.mean_reversion);
    const flatErr = err(preds.flat_mover_rule);

    const scored = {};
    for (const [name, p] of Object.entries(preds)) {
      const e = err(p);
      scored[name] = {
        mae: r4(mean(e)), rmse: r4(Math.sqrt(mean(e.map(x => x * x)))),
        spearman: r4(spearman(p, truth)),
        vs_no_change: name === 'no_change' ? null
          : pairedBootstrapDiff(baseErr, e, { iterations: 2000, seed: 13, groups }),
        vs_mean_reversion: name === 'mean_reversion' || name === 'no_change' ? null
          : pairedBootstrapDiff(mrErr, e, { iterations: 2000, seed: 17, groups }),
        vs_flat_rule: name === 'flat_mover_rule' ? null
          : pairedBootstrapDiff(flatErr, e, { iterations: 2000, seed: 19, groups })
      };
      (pooled[name] ??= { errs: [], preds: [], truth: [], groups: [] });
      pooled[name].errs.push(...e); pooled[name].preds.push(...p);
      pooled[name].truth.push(...truth); pooled[name].groups.push(...groups);
    }

    perSeason.push({
      season, fit_seasons: fitSeasons, n_train: train.length, n_test: test.length,
      lambda, shipped_lambda: shippedLambda,
      ridge_weights: Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, r4(ridge.weights[i])])),
      shipped_weights: Object.fromEntries(SHIPPED_FEATURES.map(n =>
        [n, r4(shipped.weights[FEATURE_NAMES.indexOf(n)])])),
      shipped_multiplier_examples: {
        mover_empty_room: r4(Math.exp(partialChangeEffect(shipped,
          { position: 'WR', prior_log_share: Math.log(0.15), changed_team: 1,
            vacated_share_new_team: 0.45, depth_rank_delta: 0, games_missed_prior: 0,
            qb1_change: 0, hc_change: 0, depth_rank: 1 }).total)),
        stayer_demoted: r4(Math.exp(partialChangeEffect(shipped,
          { position: 'RB', prior_log_share: Math.log(0.15), changed_team: 0,
            vacated_share_new_team: 0.05, depth_rank_delta: 1, games_missed_prior: 0,
            qb1_change: 0, hc_change: 0, depth_rank: 2 }).total))
      },
      shrunken_coefficients: eb.coefficients,
      models: scored
    });
  }

  const overall = {};
  const baseP = pooled.no_change, mrP = pooled.mean_reversion, flatP = pooled.flat_mover_rule;
  for (const [name, p] of Object.entries(pooled)) {
    overall[name] = {
      n: p.errs.length, mae: r4(mean(p.errs)),
      spearman: r4(spearman(p.preds, p.truth)),
      vs_no_change: name === 'no_change' ? null
        : pairedBootstrapDiff(baseP.errs, p.errs, { iterations: 4000, seed: 23, groups: p.groups }),
      vs_mean_reversion: name === 'mean_reversion' || name === 'no_change' ? null
        : pairedBootstrapDiff(mrP.errs, p.errs, { iterations: 4000, seed: 29, groups: p.groups }),
      vs_flat_rule: name === 'flat_mover_rule' ? null
        : pairedBootstrapDiff(flatP.errs, p.errs, { iterations: 4000, seed: 31, groups: p.groups })
    };
  }
  return { field, test_seasons: testSeasons, per_season: perSeason, pooled: overall };
}

// ---------------------------------------------------------------------------
// v2: the 66-column offseason feature set
//
// `offseason-data.js` assembles one 66-column row per player-season into
// `off_player_season_features` (2021-2026). This section is the second pass: it
// joins that row onto the SAME panel v1 was fitted and graded on, tests every
// new variable as its own effect line, and then puts them in the ridge and a
// GBM together against the shipped v1 model. Nothing here changes what
// `offseasonAdjustment` publishes unless the walk-forward says it should — see
// docs/OFFSEASON_MODEL.md §9.
//
// LOOK-AHEAD. Every column used below is either a fact about season T-1 or a
// season-T fact settled before Week 1. Three exclusions are deliberate:
//   * `sleeper_depth_chart_order` / `sleeper_injury_status` exist for the
//     current season only — Sleeper publishes a live snapshot with no history,
//     so stamping today's chart onto 2023 would be a leak with no historical
//     counterpart to fit on.
//   * the contract columns are empty after 2022 (the nflverse OTC feed has no
//     signing later than 2022), so they cannot be tested on 2023-25 at all.
//   * `implied_team_points`, `implied_points_delta_vs_prior` and
//     `division_sos_proxy` are season MEANS of per-game closing lines, and the
//     lines for weeks 2+ are set during season T. They are tested, and they are
//     flagged: only the Week-1 line (v1's `implied_points_delta`) is strictly
//     preseason. Both are reported so the difference is visible rather than
//     assumed.
// ---------------------------------------------------------------------------

const v2Cache = new Map();

/**
 * `off_player_season_features` for one season, keyed by gsis.
 *
 * Read with a direct SELECT rather than by importing `offseason-data.js`: that
 * module runs its `CREATE TABLE IF NOT EXISTS` block at import time, and this
 * file is on a runtime read path (and on a synthetic test fixture that has no
 * `off_*` tables at all). A missing table is an empty map, not a throw.
 */
function v2Season(season) {
  if (v2Cache.has(season)) return v2Cache.get(season);
  let map = new Map();
  try {
    map = new Map(rows('SELECT * FROM off_player_season_features WHERE season = ?', season)
      .map(r => [r.gsis_id, r]));
  } catch { map = new Map(); }
  v2Cache.set(season, map);
  return map;
}

/** Attach the 66-column row to each panel row as `.v2` (null when absent). */
export function attachV2Features(panelRows) {
  for (const r of panelRows) {
    if (r.v2 === undefined) r.v2 = v2Season(r.season).get(r.player_id) ?? null;
  }
  return panelRows;
}

/** Coverage of the join and of each candidate column, on a given row set. */
export function v2Coverage(panelRows) {
  attachV2Features(panelRows);
  const joined = panelRows.filter(r => r.v2);
  const cols = {};
  for (const c of V2_COLUMNS) {
    const n = panelRows.filter(r => Number.isFinite(v2Value(r, c.col))).length;
    cols[c.col] = r4(n / (panelRows.length || 1));
  }
  return { n: panelRows.length, joined: joined.length,
    join_rate: r4(joined.length / (panelRows.length || 1)), columns: cols };
}

function v2Value(row, col) {
  const v = row.v2?.[col];
  return Number.isFinite(v) ? v : null;
}

/**
 * The candidate variables, one line each.
 *
 * `block` groups them for the joint model and the ablation. `kind` decides the
 * effect line: a binary column is group-vs-contrast, a continuous one is top
 * tercile vs bottom tercile of the rows that have it (thresholds reported), so
 * "a high prior aDOT" is a statement about a third of the panel rather than
 * about an arbitrary cut.
 */
export const V2_COLUMNS = Object.freeze([
  // Prior-season charting (PFR advanced + NGS). Thin by construction: NGS
  // publishes qualified players only.
  { col: 'prior_adot', block: 'charting', kind: 'continuous', label: 'prior aDOT' },
  { col: 'prior_drop_pct', block: 'charting', kind: 'continuous', label: 'prior drop %' },
  { col: 'prior_broken_tackles', block: 'charting', kind: 'continuous', label: 'prior broken tackles' },
  { col: 'prior_ngs_separation', block: 'charting', kind: 'continuous', label: 'prior NGS separation' },
  { col: 'prior_ngs_cushion', block: 'charting', kind: 'continuous', label: 'prior NGS cushion' },
  { col: 'prior_ngs_air_yards_share', block: 'charting', kind: 'continuous', label: 'prior NGS air-yards share' },
  { col: 'prior_yac_oe', block: 'charting', kind: 'continuous', label: 'prior YAC over expected' },
  { col: 'prior_ryoe_per_att', block: 'charting', kind: 'continuous', label: 'prior RYOE per attempt' },
  // Prior-season role and efficiency.
  { col: 'prior_snap_share', block: 'role', kind: 'continuous', label: 'prior snap share' },
  { col: 'prior_wopr', block: 'role', kind: 'continuous', label: 'prior WOPR' },
  { col: 'prior_air_yard_share', block: 'role', kind: 'continuous', label: 'prior air-yard share' },
  { col: 'prior_epa_per_play', block: 'role', kind: 'continuous', label: 'prior EPA per play' },
  { col: 'prior_xfp_per_game', block: 'role', kind: 'continuous', label: 'prior expected FP/game' },
  { col: 'prior_xfp_diff', block: 'role', kind: 'continuous', label: 'prior actual − expected FP/game' },
  // Competition added at his position over the offseason.
  { col: 'capital_added_at_position', block: 'competition', kind: 'continuous', label: 'R1-3 picks added at his position' },
  { col: 'top_pick_added_at_position', block: 'competition', kind: 'continuous', label: 'best pick added at his position' },
  { col: 'veterans_added_at_position', block: 'competition', kind: 'continuous', label: 'veterans added at his position' },
  { col: 'new_team_vacated_target_share', block: 'competition', kind: 'continuous', label: 'new team vacated target share' },
  { col: 'new_team_vacated_carry_share', block: 'competition', kind: 'continuous', label: 'new team vacated carry share' },
  { col: 'own_team_vacated_share', block: 'competition', kind: 'continuous', label: 'own team vacated share' },
  // Depth chart at T from the August+ snapshot, and its delta vs the end of T-1.
  { col: 'depth_slot_t', block: 'depth', kind: 'continuous', label: 'depth slot at T (Aug+ snapshot)' },
  { col: 'depth_slot_delta', block: 'depth', kind: 'continuous', label: 'depth slot delta vs end of T-1' },
  // Quarterback and coaching, quantified rather than flagged.
  { col: 'qb_qbr_delta', block: 'qb_coach', kind: 'continuous', label: 'new QB1 QBR − old QB1 QBR' },
  { col: 'hc_tenure_years', block: 'qb_coach', kind: 'continuous', label: 'head-coach tenure' },
  // Team context. The three implied-line columns are season means — see the
  // look-ahead note above.
  { col: 'implied_team_points', block: 'team', kind: 'continuous', label: 'team implied points at T', caveat: 'season mean of per-game closing lines' },
  { col: 'implied_points_delta_vs_prior', block: 'team', kind: 'continuous', label: 'implied points delta vs T-1', caveat: 'season mean of per-game closing lines' },
  { col: 'division_sos_proxy', block: 'team', kind: 'continuous', label: 'opponent implied points (SOS)', caveat: 'season mean of per-game closing lines' },
  { col: 'team_pass_rate_prior', block: 'team', kind: 'continuous', label: 'team dropback rate at T-1' },
  { col: 'team_plays_prior', block: 'team', kind: 'continuous', label: 'team plays per game at T-1' },
  { col: 'team_points_per_game_prior', block: 'team', kind: 'continuous', label: 'team points per game at T-1' },
  { col: 'dome_home', block: 'team', kind: 'binary', label: 'home games in a dome' },
  { col: 'bye_week', block: 'team', kind: 'continuous', label: 'bye week' },
  // Injury history at T-1, in more detail than v1's games-missed count.
  { col: 'injury_games_missed_prior', block: 'injury', kind: 'continuous', label: 'weeks listed Out at T-1' },
  { col: 'injury_reports_prior', block: 'injury', kind: 'continuous', label: 'weeks on the injury report at T-1' },
  { col: 'ir_stints_prior', block: 'injury', kind: 'continuous', label: 'IR-length stints at T-1' },
  { col: 'late_season_injury_flag', block: 'injury', kind: 'binary', label: 'Out in the last four weeks of T-1' },
  // Biography.
  { col: 'age_at_season', block: 'bio', kind: 'continuous', label: 'age at T' },
  { col: 'years_exp', block: 'bio', kind: 'continuous', label: 'years of experience' },
  { col: 'draft_round', block: 'bio', kind: 'continuous', label: 'draft round' }
]);

/** Columns that exist in the table and are deliberately NOT tested or fitted. */
export const V2_EXCLUDED = Object.freeze({
  sleeper_depth_chart_order: 'current season only — no history to fit on; using it historically would be a leak',
  sleeper_injury_status: 'current season only — same reason',
  apy: 'the OTC feed has no signing after 2022; empty on every evaluation season',
  apy_cap_pct: 'empty after 2022',
  apy_rank_on_team_at_position: 'empty after 2022',
  contract_year: 'empty after 2022',
  new_contract: 'empty after 2022',
  contract_years_remaining: 'empty after 2022',
  rookie: 'the panel requires a prior season, so every row is 0',
  home_surface: 'a text field, and turf/grass is not an offseason change',
  qb_change: 'already in v1 as qb1_change, and declined there',
  hc_change: 'already in v1 as hc_change, and declined there',
  team_change: 'already in v1 as changed_team, and shipped there'
});

const V2_BLOCK_LIST = ['charting', 'role', 'competition', 'depth', 'qb_coach', 'team', 'injury', 'bio'];
export const V2_BLOCKS = Object.freeze(V2_BLOCK_LIST.slice());

/**
 * Tercile cuts, with the tie case handled explicitly.
 *
 * A discrete column like `capital_added_at_position` is zero for most of the
 * panel, so both tercile points land on 0 and a naive `>= hi` / `<= lo` split
 * puts the same rows in BOTH arms — which silently reports the difference
 * between a group and itself as a null. The high arm is therefore always
 * strictly above the low cut, which for such a column degrades to the only
 * split the data supports: any vs none.
 */
function terciles(values) {
  const s = [...values].sort((a, b) => a - b);
  const lo = s[Math.floor(s.length / 3)], hi = s[Math.floor((2 * s.length) / 3)];
  return { lo, hi: Math.max(hi, lo), tied: hi <= lo };
}

/**
 * One effect line per new variable, on the same rows, the same mean-reversion
 * residual and the same bootstrap v1 used. A continuous variable is cut at its
 * terciles; a binary one is 1 vs 0. `verdict` is REAL when the difference CI
 * excludes zero and both arms clear n=20, otherwise DECLINED.
 */
export function measureV2Effects(seasons = [2021, 2022, 2023, 2024, 2025], { field = 'y_share' } = {}) {
  const rowsIn = attachV2Features(panelFor(seasons)).filter(r => Number.isFinite(r[field]));
  const mr = fitMeanReversion(rowsIn, field);
  const resid = new Map(rowsIn.map(r => [r, r[field] - meanReversionPredict(mr, r)]));
  const diffCi = (gv, cv, seed = 99) => {
    let s = seed >>> 0;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const d = new Array(2000);
    for (let it = 0; it < 2000; it++) {
      let a = 0, b = 0;
      for (let i = 0; i < gv.length; i++) a += gv[Math.floor(rand() * gv.length)];
      for (let i = 0; i < cv.length; i++) b += cv[Math.floor(rand() * cv.length)];
      d[it] = a / gv.length - b / cv.length;
    }
    d.sort((x, y) => x - y);
    return { lo: r4(d[50]), hi: r4(d[1949]) };
  };

  const results = {};
  for (const spec of V2_COLUMNS) {
    const have = rowsIn.filter(r => Number.isFinite(v2Value(r, spec.col)));
    let g, c, cut = null;
    if (spec.kind === 'binary') {
      g = have.filter(r => v2Value(r, spec.col) === 1);
      c = have.filter(r => v2Value(r, spec.col) === 0);
    } else {
      const t = terciles(have.map(r => v2Value(r, spec.col)));
      cut = { low_at_or_below: r4(t.lo), high_at_or_above: r4(t.hi), tercile_tie: t.tied };
      g = have.filter(r => v2Value(r, spec.col) >= t.hi && v2Value(r, spec.col) > t.lo);
      c = have.filter(r => v2Value(r, spec.col) <= t.lo);
    }
    const base = { column: spec.col, block: spec.block, label: spec.label, field,
      kind: spec.kind, cut, caveat: spec.caveat ?? null,
      coverage: r4(have.length / (rowsIn.length || 1)),
      n_group: g.length, n_contrast: c.length,
      per_season_n: seasons.map(s => have.filter(r => r.season === s).length) };
    if (g.length < 20 || c.length < 20) {
      results[spec.col] = { ...base, insufficient: true, verdict: 'DECLINED (n)' };
      continue;
    }
    const gv = g.map(r => resid.get(r)), cv = c.map(r => resid.get(r));
    const d = mean(gv) - mean(cv);
    const ci = diffCi(gv, cv);
    results[spec.col] = { ...base,
      effect_log: r4(d), multiplier: r4(Math.exp(d)),
      ci_multiplier: { lo: r4(Math.exp(ci.lo)), hi: r4(Math.exp(ci.hi)) },
      crosses_zero: ci.lo <= 0 && ci.hi >= 0,
      verdict: ci.lo <= 0 && ci.hi >= 0 ? 'DECLINED' : 'REAL' };
  }
  return { seasons, field, n: rowsIn.length, coverage: v2Coverage(rowsIn), effects: results };
}

/**
 * The v2 design: every v1 column, then two columns per candidate variable — the
 * value (0 when absent) and an explicit missing flag, so "no NGS row" is a state
 * the model can price rather than an average receiver.
 */
export const V2_FEATURE_NAMES = Object.freeze([
  ...FEATURE_NAMES,
  ...V2_COLUMNS.flatMap(c => [`v2_${c.col}`, `v2_${c.col}_missing`])
]);

export function featureVectorV2(r) {
  const base = featureVector(r);
  const extra = [];
  for (const c of V2_COLUMNS) {
    const v = v2Value(r, c.col);
    extra.push(v ?? 0, v == null ? 1 : 0);
  }
  return [...base, ...extra];
}

/** Names of the v2 columns belonging to a set of blocks (plus their flags). */
export function v2BlockFeatures(blocks) {
  const set = new Set(blocks);
  return V2_COLUMNS.filter(c => set.has(c.block)).flatMap(c => [`v2_${c.col}`, `v2_${c.col}_missing`]);
}

/** Project a v2 vector onto a named subset, zeroing the rest. */
export function keepV2(vector, names) {
  const out = new Array(V2_FEATURE_NAMES.length).fill(0);
  for (const n of names) { const j = V2_FEATURE_NAMES.indexOf(n); if (j >= 0) out[j] = vector[j]; }
  return out;
}

const v2Vec = names => r => keepV2(featureVectorV2(r), names);

/**
 * The v2 walk-forward: the SAME held-out seasons, the SAME rows, the same
 * team-season-clustered paired bootstrap as v1, with v1's shipped model as the
 * incumbent every candidate has to beat.
 *
 * `candidates` maps a name to the feature-name list it is allowed to see.
 * Every candidate is a ridge fitted with leave-one-season-out lambda inside the
 * training window, plus one GBM on the full v2 set.
 */
export function walkForwardV2({
  testSeasons = [2023, 2024, 2025], firstFitSeason = FIRST_DEPTH_SEASON,
  field = 'y_share', lambdas = LAMBDA_GRID, gbm = true, candidates = null
} = {}) {
  const allV2 = V2_COLUMNS.flatMap(c => [`v2_${c.col}`, `v2_${c.col}_missing`]);
  const cand = candidates ?? {
    v1_shipped: SHIPPED_FEATURES.slice(),
    v2_all: [...SHIPPED_FEATURES, ...allV2],
    ...Object.fromEntries(V2_BLOCK_LIST.map(b =>
      [`v1_plus_${b}`, [...SHIPPED_FEATURES, ...v2BlockFeatures([b])]]))
  };

  const perSeason = [];
  const pooled = {};
  for (const season of testSeasons) {
    const fitSeasons = [];
    for (let s = firstFitSeason; s < season; s++) fitSeasons.push(s);
    const train = attachV2Features(panelFor(fitSeasons)).filter(r => Number.isFinite(r[field]));
    const test = attachV2Features(buildPanel(season)).filter(r => r.usable && Number.isFinite(r[field]));
    if (train.length < 200 || test.length < 50) {
      perSeason.push({ season, error: `train ${train.length} / test ${test.length} too thin` });
      continue;
    }
    const truth = test.map(r => r[field]);
    const preds = { no_change: test.map(() => 0) };
    const lambdas_used = {};
    for (const [name, names] of Object.entries(cand)) {
      const vec = v2Vec(names);
      const l = chooseLambda(train, field, lambdas, vec);
      lambdas_used[name] = l;
      const m = fitRidge(train.map(vec), train.map(r => r[field]), l);
      preds[name] = test.map(r => predictRidge(m, vec(r)));
    }
    if (gbm) {
      try {
        const g = fitGbm(train.map(featureVectorV2), train.map(r => r[field]),
          { trees: 200, learningRate: 0.05, maxDepth: 3, minLeaf: 40, seed: 5 });
        preds.v2_gbm = test.map(r => predictGbm(g, featureVectorV2(r)));
      } catch { /* the challenger is optional */ }
    }

    const groups = test.map(r => `${r.season}|${r.team}`);
    const err = p => p.map((v, i) => Math.abs(v - truth[i]));
    const incumbent = err(preds.v1_shipped);
    const scored = {};
    for (const [name, p] of Object.entries(preds)) {
      const e = err(p);
      scored[name] = {
        mae: r4(mean(e)), spearman: r4(spearman(p, truth)),
        vs_v1: name === 'v1_shipped' ? null
          : pairedBootstrapDiff(incumbent, e, { iterations: 2000, seed: 41, groups })
      };
      (pooled[name] ??= { errs: [], preds: [], truth: [], groups: [] });
      pooled[name].errs.push(...e); pooled[name].preds.push(...p);
      pooled[name].truth.push(...truth); pooled[name].groups.push(...groups);
    }
    perSeason.push({ season, n_train: train.length, n_test: test.length,
      lambdas: lambdas_used, models: scored });
  }

  const overall = {};
  for (const [name, p] of Object.entries(pooled)) {
    overall[name] = {
      n: p.errs.length, mae: r4(mean(p.errs)), spearman: r4(spearman(p.preds, p.truth)),
      vs_v1: name === 'v1_shipped' ? null
        : pairedBootstrapDiff(pooled.v1_shipped.errs, p.errs,
          { iterations: 4000, seed: 43, groups: p.groups })
    };
  }
  return { field, test_seasons: testSeasons, per_season: perSeason, pooled: overall };
}

/**
 * The v1 nested ablation, re-run with the v2 blocks appended.
 *
 * The question v1 left open is the only one that matters for shipping: is
 * anything in the 66-column set additive OVER a model that already has the
 * two-year usage trend, the age terms and the season-T depth-chart level? Each
 * row adds one block to the row above and is graded on the same held-out rows.
 */
export function ablationV2({ testSeasons = [2023, 2024, 2025], field = 'y_share',
  lambdas = LAMBDA_GRID } = {}) {
  const BASE = ['prior_log_share', 'is_rb', 'is_wr', 'is_te', 'is_qb'];
  const TREND_AGE = ['two_year_trend', 'two_year_missing', 'age_from_peak', 'age_from_peak_sq'];
  const DEPTH_LEVEL = ['depth_rank1', 'depth_missing'];
  const CHANGE = ['changed_team', 'vacated_share', 'changed_x_vacated',
    'depth_demotion_steps', 'depth_promotion_steps', 'games_missed'];
  const ladder = [];
  let acc = [...BASE];
  ladder.push({ name: 'prior share + position', features: [...acc] });
  acc = [...acc, ...TREND_AGE];
  ladder.push({ name: '+ two-year trend, age', features: [...acc] });
  acc = [...acc, ...DEPTH_LEVEL];
  ladder.push({ name: '+ season-T depth level', features: [...acc] });
  acc = [...acc, ...CHANGE];
  ladder.push({ name: '+ v1 change block', features: [...acc] });
  for (const b of V2_BLOCK_LIST) {
    acc = [...acc, ...v2BlockFeatures([b])];
    ladder.push({ name: `+ v2 ${b}`, features: [...acc] });
  }

  const errs = ladder.map(() => []);
  const predsAll = ladder.map(() => []);
  const truthAll = [], groupsAll = [];
  for (const season of testSeasons) {
    const fitSeasons = [];
    for (let s = FIRST_DEPTH_SEASON; s < season; s++) fitSeasons.push(s);
    const train = attachV2Features(panelFor(fitSeasons)).filter(r => Number.isFinite(r[field]));
    const test = attachV2Features(buildPanel(season)).filter(r => r.usable && Number.isFinite(r[field]));
    if (train.length < 200 || test.length < 50) continue;
    const truth = test.map(r => r[field]);
    truthAll.push(...truth);
    groupsAll.push(...test.map(r => `${r.season}|${r.team}`));
    ladder.forEach((step, i) => {
      const vec = v2Vec(step.features);
      const m = fitRidge(train.map(vec), train.map(r => r[field]),
        chooseLambda(train, field, lambdas, vec));
      const p = test.map(r => predictRidge(m, vec(r)));
      predsAll[i].push(...p);
      errs[i].push(...p.map((v, k) => Math.abs(v - truth[k])));
    });
  }
  return {
    field, test_seasons: testSeasons, n: truthAll.length,
    steps: ladder.map((step, i) => ({
      name: step.name, mae: r4(mean(errs[i])),
      spearman: r4(spearman(predsAll[i], truthAll)),
      vs_previous: i === 0 ? null
        : pairedBootstrapDiff(errs[i - 1], errs[i], { iterations: 4000, seed: 47, groups: groupsAll })
    }))
  };
}

/**
 * The partial change effect inside an arbitrary design.
 *
 * `partialChangeEffect` is hard-wired to the v1 `FEATURE_NAMES` layout. This is
 * the same arithmetic against any feature-name list, so a candidate fitted on
 * the v2 design can publish a multiplier the same way and be graded against v1's
 * on identical terms.
 */
export function partialChangeIn(model, row, names, vec) {
  const x = vec(row);
  let total = 0;
  const components = {};
  for (const name of CHANGE_FEATURES) {
    const j = names.indexOf(name);
    if (j < 0) continue;
    const term = model.weights[j] * x[j] / model.sd[j];
    total += term;
    const comp = COMPONENT_OF[name];
    components[comp] = (components[comp] ?? 0) + term;
  }
  return { total, components };
}

/**
 * Grade THE PUBLISHED QUANTITY, not the fit.
 *
 * `offseasonAdjustment` does not publish a prediction; it publishes a
 * multiplier, which the caller applies to a prior of his own. So the decision
 * "does v2 replace v1" cannot be settled by whose full regression fits better —
 * a candidate can win that on better CONTROLS while leaving the multiplier
 * untouched, which is v1 §4's finding wearing a new hat. Here each candidate is
 * scored as `mean-reversion prior + its own change partial`, on the same rows,
 * with the same clustered paired bootstrap.
 */
export function multiplierWalkForward({
  testSeasons = [2023, 2024, 2025], field = 'y_share', lambdas = LAMBDA_GRID,
  candidates = null
} = {}) {
  const allV2 = V2_COLUMNS.flatMap(c => [`v2_${c.col}`, `v2_${c.col}_missing`]);
  const cand = candidates ?? {
    v1_multiplier: SHIPPED_FEATURES.slice(),
    v2_charting_multiplier: [...SHIPPED_FEATURES, ...v2BlockFeatures(['charting'])],
    v2_all_multiplier: [...SHIPPED_FEATURES, ...allV2]
  };
  const perSeason = [];
  const pooled = {};
  for (const season of testSeasons) {
    const fitSeasons = [];
    for (let s = FIRST_DEPTH_SEASON; s < season; s++) fitSeasons.push(s);
    const train = attachV2Features(panelFor(fitSeasons)).filter(r => Number.isFinite(r[field]));
    const test = attachV2Features(buildPanel(season)).filter(r => r.usable && Number.isFinite(r[field]));
    if (train.length < 200 || test.length < 50) continue;
    const mr = fitMeanReversion(train, field);
    const truth = test.map(r => r[field]);
    const preds = { mean_reversion_only: test.map(r => meanReversionPredict(mr, r)) };
    for (const [name, names] of Object.entries(cand)) {
      const vec = v2Vec(names);
      const m = fitRidge(train.map(vec), train.map(r => r[field]),
        chooseLambda(train, field, lambdas, vec));
      const part = r => partialChangeIn(m, r, V2_FEATURE_NAMES, vec).total;
      preds[name] = test.map(r => meanReversionPredict(mr, r) + clampLog(part(r)));
      // The published multiplier is defined against a player with NO change, but
      // the mean-reversion prior a caller holds is fitted on every player,
      // average change included. Adding one to the other therefore charges the
      // league's average change twice. The centred variant subtracts the
      // training-set mean partial, which is the same model with that
      // double-count removed — reported because the difference is a fact about
      // consumption, and because v1 and v2 must be compared with it either
      // present in both or absent from both.
      const bar = mean(train.map(part));
      preds[`${name}_centred`] = test.map(r =>
        meanReversionPredict(mr, r) + clampLog(part(r) - bar));
    }
    const groups = test.map(r => `${r.season}|${r.team}`);
    const err = p => p.map((v, i) => Math.abs(v - truth[i]));
    // Compare like with like: a centred candidate is graded against the centred
    // incumbent, a raw one against the raw incumbent. Comparing across the two
    // measures the centring, not the feature set.
    const incumbentOf = name => (name.endsWith('_centred') ? 'v1_multiplier_centred' : 'v1_multiplier');
    const scored = {};
    for (const [name, p] of Object.entries(preds)) {
      const e = err(p);
      scored[name] = { mae: r4(mean(e)), spearman: r4(spearman(p, truth)),
        vs_v1: name === incumbentOf(name) ? null
          : pairedBootstrapDiff(err(preds[incumbentOf(name)]), e,
            { iterations: 2000, seed: 53, groups }) };
      (pooled[name] ??= { errs: [], preds: [], truth: [], groups: [] });
      pooled[name].errs.push(...e); pooled[name].preds.push(...p);
      pooled[name].truth.push(...truth); pooled[name].groups.push(...groups);
    }
    perSeason.push({ season, n_test: test.length, models: scored });
  }
  const overall = {};
  for (const [name, p] of Object.entries(pooled)) {
    const inc = name.endsWith('_centred') ? 'v1_multiplier_centred' : 'v1_multiplier';
    overall[name] = { n: p.errs.length, mae: r4(mean(p.errs)),
      spearman: r4(spearman(p.preds, p.truth)),
      vs_v1: name === inc ? null
        : pairedBootstrapDiff(pooled[inc].errs, p.errs,
          { iterations: 4000, seed: 59, groups: p.groups }) };
  }
  return { field, test_seasons: testSeasons, per_season: perSeason, pooled: overall };
}

/** The published multiplier is clamped; grade it clamped, or grade a fiction. */
const clampLog = t => Math.log(clamp(Math.exp(t), MULTIPLIER_BOUNDS.lo, MULTIPLIER_BOUNDS.hi));

// ---------------------------------------------------------------------------
// The shipped adjustment
// ---------------------------------------------------------------------------

/**
 * The fit method that ships: ridge on the joint features.
 *
 * Held out on 2023/2024/2025 (docs/OFFSEASON_MODEL.md), ridge beats all three
 * baselines on both outcomes, and the GBM challenger beats ridge by 0.006 log
 * units of share MAE — a margin that is not significant in four of five random
 * seeds and is one-third of ridge's own margin over the mean-reversion
 * baseline. Within noise, the repo's rule is the simpler model, and ridge is
 * additive, which is not a tiebreaker detail here: the published `components`
 * are exact per-effect partial multipliers only because the model is linear.
 * `shrunken_means` — the empirical-Bayes model tried first — did not
 * reliably beat mean reversion and is kept as a reference candidate only.
 */
export const SHIPPED_FIT = 'ridge_shipped_features';

/** Multipliers are clamped: no offseason claim outside this band is credible. */
export const MULTIPLIER_BOUNDS = Object.freeze({ lo: 0.4, hi: 1.6 });

/**
 * Which features are OFFSEASON CHANGES and therefore belong in the published
 * multiplier, and which are merely controls that make the fit honest.
 *
 * `prior_log_share` (mean reversion) and the age terms are controls. Both are
 * real, large and well measured — the mean-reversion slope is about -0.22 for
 * every position, and being 3+ years past the positional peak costs a further
 * ~12% of share — but neither is this module's to apply. The preseason
 * projection already owns the prior-share side of a forecast and
 * `dynasty-age-curve.js` already applies an age multiplier; publishing them
 * again here would double-count them in whatever consumes both. They stay in
 * the regression so the change coefficients are not contaminated, and they are
 * cancelled out of the published number by construction.
 */
const CHANGE_FEATURES = Object.freeze([
  'changed_team', 'vacated_share', 'changed_x_vacated',
  'depth_demotion_steps', 'depth_promotion_steps', 'games_missed'
]);

/** Feature name -> published component, for the exact linear decomposition. */
const COMPONENT_OF = Object.freeze({
  changed_team: 'team_change', changed_x_vacated: 'team_change',
  vacated_share: 'vacated',
  depth_demotion_steps: 'depth', depth_promotion_steps: 'depth',
  games_missed: 'injury_return'
});

/**
 * Materiality thresholds. A change below these is not reported as a driver AND
 * not priced into the multiplier, so `drivers` and the number always agree:
 * empty drivers means exactly 1.0, with no small unexplained nudge hiding
 * behind it.
 */
const MATERIAL = Object.freeze({
  vacated_share: 0.15, games_missed: 3, implied_delta: 1.5
});

/**
 * The change signals present for one player, each with the sentence that
 * explains it and whether it is PRICED.
 *
 * A signal with `priced: false` is a real, correctly detected situation change
 * whose effect on opportunity did not replicate — a new head coach, a new
 * starting QB, a moved implied total. It is still reported, because a human
 * reading a draft board wants to know his receiver has a new quarterback, and
 * because silently dropping it would look like the model failed to notice. It
 * contributes nothing to the multiplier, and its `components` entry is null,
 * which is the model saying "I see it and I cannot price it".
 */
export function changeSignals(row, teams) {
  const t = teams?.get(row.team) ?? null;
  const pct = v => `${Math.round((v ?? 0) * 100)}%`;
  const out = [];
  if (row.changed_team === 1) {
    const vac = row.vacated_share_new_team;
    out.push({ key: 'team_change', priced: true,
      driver: `moved ${row.prior_team}→${row.team}` +
        (Number.isFinite(vac) ? ` into a room with ${pct(vac)} of ${row.season - 1} opportunity vacated` : '') });
  } else if (row.vacated_share_new_team >= MATERIAL.vacated_share) {
    // Name only the departures who competed for the SAME opportunity. A
    // receiver's vacated share is about receivers; listing the quarterback who
    // left reads as a non sequitur even when the arithmetic includes him.
    const room = row.position === 'RB' ? new Set(['RB', 'FB'])
      : row.position === 'QB' ? new Set(['QB']) : new Set(['WR', 'TE']);
    const gone = (t?.departures ?? []).filter(d => room.has(d.position))
      .map(d => d.name).filter(Boolean).slice(0, 2);
    out.push({ key: 'vacated', priced: true,
      driver: `stayed on ${row.team}, which vacated ${pct(row.vacated_share_new_team)} of its opportunity` +
        (gone.length ? ` (${gone.join(', ')} gone)` : '') });
  }
  if (Number.isFinite(row.depth_rank_delta) && row.depth_rank_delta !== 0) {
    out.push({ key: 'depth', priced: true,
      driver: `depth chart ${row.position}${row.prior_usage_rank} → ${row.position}${row.depth_rank}` +
        (row.depth_rank_delta > 0 ? ' (demoted)' : ' (promoted)') });
  }
  if (row.qb1_change === 1 && row.position !== 'QB') {
    out.push({ key: 'qb_change', priced: false,
      driver: `new QB1 on ${row.team}` +
        (t?.prior_qb1 && t?.qb1 ? ` (${t.prior_qb1_name ?? t.prior_qb1}→${t.qb1_name ?? t.qb1})` : '') +
        ' — no measured effect on share' });
  }
  if (row.hc_change === 1) {
    out.push({ key: 'coach_change', priced: false,
      driver: `new head coach on ${row.team} (${t?.prior_head_coach ?? '?'}→${t?.head_coach ?? '?'})` +
        ' — no measured effect on share' });
  }
  if (row.games_missed_prior >= MATERIAL.games_missed) {
    out.push({ key: 'injury_return', priced: true,
      driver: `missed ${row.games_missed_prior} games in ${row.season - 1}` });
  }
  if (Number.isFinite(row.implied_points_delta) && Math.abs(row.implied_points_delta) >= MATERIAL.implied_delta) {
    out.push({ key: 'implied_total', priced: false,
      driver: `${row.team} Week 1 implied total ${row.implied_points_delta > 0 ? 'up' : 'down'} ` +
        `${Math.abs(row.implied_points_delta).toFixed(1)} vs the ${row.season - 1} average` +
        ' — no measured effect on share' });
  }
  return out;
}

/**
 * The published multiplier: the ridge prediction for this player minus the
 * ridge prediction for the same player with every change feature at its
 * no-change value. Controls cancel exactly, so what is left is the offseason
 * effect and nothing else, and because ridge is linear the per-feature terms
 * sum to it — the `components` are a true decomposition, not an attribution
 * heuristic.
 */
export function partialChangeEffect(model, row) {
  const x = shippedVector(row);
  const x0 = [...x];
  for (const name of CHANGE_FEATURES) x0[FEATURE_NAMES.indexOf(name)] = 0;
  const components = {};
  let total = 0;
  for (const name of CHANGE_FEATURES) {
    const j = FEATURE_NAMES.indexOf(name);
    const term = model.weights[j] * (x[j] - x0[j]) / model.sd[j];
    total += term;
    const comp = COMPONENT_OF[name];
    components[comp] = (components[comp] ?? 0) + term;
  }
  return { total, components };
}

const adjustmentCache = new Map();

/**
 * Build every player's offseason adjustment for `season`, fitting the shipped
 * model on every season strictly before it — the same walk-forward boundary the
 * grading used, so what ships is what was graded. Cached per process.
 */
export function offseasonAdjustments(season = Number(process.env.NFL_SEASON) || new Date().getFullYear()) {
  if (adjustmentCache.has(season)) return adjustmentCache.get(season);

  const fitSeasons = [];
  for (let s = FIRST_DEPTH_SEASON; s < season; s++) fitSeasons.push(s);
  const train = panelFor(fitSeasons);
  const trainShare = train.filter(r => Number.isFinite(r.y_share));
  const trainPpg = train.filter(r => Number.isFinite(r.y_ppg));

  const shareModel = trainShare.length >= 150
    ? fitRidge(trainShare.map(shippedVector), trainShare.map(r => r.y_share),
      chooseLambda(trainShare, 'y_share', LAMBDA_GRID, shippedVector)) : null;
  const ppgModel = trainPpg.length >= 150
    ? fitRidge(trainPpg.map(shippedVector), trainPpg.map(r => r.y_ppg),
      chooseLambda(trainPpg, 'y_ppg', LAMBDA_GRID, shippedVector)) : null;
  const nBasis = trainShare.length;

  const summary = teamOffseasonSummary(season);
  const target = buildPanel(season);
  const out = new Map();

  for (const row of target) {
    const signals = changeSignals(row, summary.teams);
    const drivers = signals.map(s => s.driver);
    const priced = new Set(signals.filter(s => s.priced).map(s => s.key));

    let oppMultiplier = 1, ppgMultiplier = 1;
    const components = { team_change: null, depth: null, qb_change: null,
      coach_change: null, injury_return: null, vacated: null, implied_total: null };

    if (priced.size && shareModel) {
      const { total, components: parts } = partialChangeEffect(shareModel, row);
      oppMultiplier = clamp(Math.exp(total), MULTIPLIER_BOUNDS.lo, MULTIPLIER_BOUNDS.hi);
      for (const [k, v] of Object.entries(parts)) {
        if (priced.has(k)) components[k] = r3(Math.exp(v));
      }
    }
    if (priced.size && ppgModel) {
      ppgMultiplier = clamp(Math.exp(partialChangeEffect(ppgModel, row).total),
        MULTIPLIER_BOUNDS.lo, MULTIPLIER_BOUNDS.hi);
    }

    // Confidence is about the EVIDENCE, not the size of the number. A big
    // multiplier off a reconstructed roster row is less trustworthy than a
    // small one off a real depth chart, and the caller needs to see that.
    const confidence = !priced.size ? 'high'
      : row.team_source === 'usage' || row.prior_games < 6 ? 'low'
        : row.prior_games >= 10 && row.depth_rank != null ? 'high' : 'medium';

    out.set(row.player_id, {
      player_id: row.player_id, name: row.name, position: row.position, season,
      team: row.team, prior_team: row.prior_team,
      opportunity_multiplier: r3(oppMultiplier), ppg_multiplier: r3(ppgMultiplier),
      confidence, n_basis: nBasis,
      drivers, components,
      evidence: {
        fit: SHIPPED_FIT, fit_seasons: fitSeasons,
        team_source: row.team_source, prior_games: row.prior_games,
        prior_opp_share: row.prior_opp_share,
        vacated_share_new_team: row.vacated_share_new_team,
        depth_rank: row.depth_rank, prior_usage_rank: row.prior_usage_rank,
        games_missed_prior: row.games_missed_prior
      }
    });
  }

  adjustmentCache.set(season, out);
  return out;
}

const NEUTRAL = season => ({
  season, opportunity_multiplier: 1, ppg_multiplier: 1, confidence: 'low', n_basis: 0,
  drivers: [], components: { team_change: null, depth: null, qb_change: null,
    coach_change: null, injury_return: null, vacated: null, implied_total: null }
});

let _gsisById = null;
function gsisFor(playerId) {
  if (typeof playerId === 'string' && playerId.startsWith('00-')) return playerId;
  if (!_gsisById) {
    _gsisById = new Map(rows('SELECT id, gsis_id FROM players WHERE gsis_id IS NOT NULL')
      .map(r => [Number(r.id), r.gsis_id]));
  }
  return _gsisById.get(Number(playerId)) ?? null;
}

/**
 * The public read. Accepts either a gsis id or this app's `players.id`.
 *
 * A player with no recorded offseason change — and a player with no prior
 * season to compare against, which includes every rookie — gets exactly 1.0 and
 * no drivers. That is the honest answer, not a placeholder: this model has
 * nothing to say about a player whose situation did not change, and saying
 * nothing is what it should then do.
 */
export function offseasonAdjustment(playerId,
  season = Number(process.env.NFL_SEASON) || new Date().getFullYear()) {
  const gsis = gsisFor(playerId);
  if (!gsis) return { ...NEUTRAL(season), player_id: playerId, reason: 'no gsis crosswalk' };
  const found = offseasonAdjustments(season).get(gsis);
  return found ?? { ...NEUTRAL(season), player_id: gsis, reason: 'no prior-season usage record' };
}

/** Drop every cache. Tests and the data-sync path use it; nothing else should. */
export function clearOffseasonModelCache() {
  seasonCache.clear(); rosterCache.clear(); panelCache.clear(); adjustmentCache.clear();
  v2Cache.clear();
  bioCache.map = null; _gsisById = null; _latest = null;
}
