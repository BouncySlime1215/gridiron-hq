/**
 * E3-ESPN: are title / playoff odds calibrated on Nick's OWN ESPN league
 * history, not only on Sleeper (E3 passed on 906 Sleeper league-seasons)?
 *
 * A SANITY CHECK, NEVER PROOF. The local history holds 4 gradeable ESPN
 * league-seasons (36 team-seasons): 2023-24 in the two leagues that have
 * history. With one champion per league-season the title row rests on 4
 * outcomes. The row is therefore always `not_enough_data` (it never raises or
 * clears the brain-report fallback rule); `detail.sanity` says whether the
 * small sample is consistent with the Sleeper result or contradicts it.
 *
 * WHAT IS REPLAYED. The season simulator's own structure, as of the end of
 * week 7 of each past season: the league's real remaining fixtures, its
 * seeding (league-rules.js#seedStandings: division winners first, then wins,
 * then points for), median game when the league plays one
 * (season-sim.js#addMedianResults), and its fixed bracket
 * (season-sim.js#playBracket). Each team's weekly score is
 * Normal(mu_i, sigma_L), mu_i its week 1-7 mean shrunk to the league mean
 * with k = 21 (frozen from the Sleeper E3 fit on 2021-22; nothing is fitted on
 * ESPN data), sigma_L the league's pooled within-team sd over weeks 1-7.
 *
 * WHAT IS NOT REPLAYED, and why. The served sim draws player-level pools from
 * rosters and projections (availability fit, SIM-KDST, SIM-CALIB). For
 * 2023-2025 ESPN served only the frozen END-of-season roster
 * (league_roster_history.is_final_snapshot = 1, week 0): it knows who won the
 * season, so a player-level week-7 replay cannot be built without leakage.
 * Those player-level pieces therefore cannot enter this replay; this grades
 * the structure on Nick's leagues, like E3 does on Sleeper.
 *
 * BASELINE (standings only). The same simulator with every team given the
 * league-mean strength: week-7 wins and points for carried in, the real
 * schedule and bracket, no points-based strength. Parameter-free, so nothing
 * is fitted on the graded seasons. (Sleeper E3 used a logistic on week-7 wins
 * fitted on 2021-22; that fit was not stored, so it is not reused here.)
 *
 * AS-OF. Points from weeks after GRADE_WEEK never reach the simulator:
 * asOfWeek() strips them before anything else reads the rows (leakage test in
 * test/eval-e3-espn.test.js). Fixtures (who plays whom) are known pre-season.
 * Outcomes (league_season_teams.playoff_seed, final_rank) are read only to grade.
 *
 * HELD OUT. 2025 is Nick's untouched holdout (docs/evidence/STATS-METHOD.md) and
 * 2026 is in progress: only seasons <= MAX_SEASON are read (SQL filter + assert).
 *
 * PAST-SEASON RULES (stated guesses). The 2023-24 settings were not stored, so
 * playoff team count, divisions and tiebreaker come from the league's 2026
 * payload, as the CE-05 seed replay did (docs/evidence/2026-09-23/
 * league-rules-replay.md, which reproduced every 2023-24 seed). The number of
 * playoff weeks per round is read from the season's own playoff weeks
 * (league_week_scores.is_playoff), because league 1 played one-week rounds in
 * 2023-24 and plays two-week rounds in 2026. `format_consistent` in the detail
 * says whether replaying the real bracket with the real playoff scores
 * reproduces the real champion.
 */
import { STATUS, result } from './common.js';
import { bootstrapCI, brier, calibrationSlope, mean, moreNeeded, reliabilityBuckets, rng, round } from './stats.js';
import { leagueRules, seedStandings, simRulesProblem } from '../league-rules.js';
import { __test as simInternals } from '../season-sim.js';

const { playBracket, addMedianResults } = simInternals;

export const CHECK = 'E3-ESPN';
export const NAME = 'Title-odds calibration (Nick\'s ESPN history, week-7 replay)';
export const GRADE_WEEK = 7;
export const SHRINK_K = 21;
export const MAX_SEASON = 2024;
export const RUNS = 5000;
export const MIN_LEAGUE_SEASONS = 30;
const PASS_BAR = 'sanity check only (low power): Brier gain vs standings-only and reliability slope reported, never graded pass/fail';
const LOW_POWER = 'low power: a handful of league-seasons and one champion per league-season; a sanity check, never proof';

/* ------------------------------------------------------------------ as-of */

/** Week rows as known at the end of `week`: later points are removed, fixtures kept. */
export function asOfWeek(weekRows, week = GRADE_WEEK) {
  return weekRows.map(r => (r.week <= week ? { ...r } : { ...r, points: null }));
}

/**
 * The state of one league-season at the end of GRADE_WEEK, from as-of rows only.
 * `rows`: league_week_scores rows of one league-season (regular season and playoffs).
 */
export function leagueSeasonState(rows, { week = GRADE_WEEK, medianGame = false } = {}) {
  const known = asOfWeek(rows, week);
  const regular = known.filter(r => !r.is_playoff);
  const ids = [...new Set(regular.map(r => String(r.roster_id)))].sort();
  const regWeeks = [...new Set(regular.map(r => r.week))].sort((a, b) => a - b);
  const playoffWeeks = [...new Set(known.filter(r => r.is_playoff).map(r => r.week))].sort((a, b) => a - b);
  const byWeek = new Map(regWeeks.map(w => [w, regular.filter(r => r.week === w)]));

  const played = regWeeks.filter(w => w <= week);
  const pts = new Map(ids.map(id => [id, []]));
  for (const w of played) for (const r of byWeek.get(w)) {
    if (r.points == null) throw new Error(`week ${w} team ${r.roster_id} has no points`);
    pts.get(String(r.roster_id)).push(Number(r.points));
  }
  // Remaining fixtures: pairs from opponent ids (each pair listed once).
  const fixtures = new Map();
  for (const w of regWeeks.filter(x => x > week)) {
    const seen = new Set();
    const pairs = [];
    for (const r of byWeek.get(w)) {
      const a = String(r.roster_id), b = r.opponent_roster_id == null ? null : String(r.opponent_roster_id);
      if (!b || seen.has(a) || seen.has(b)) continue;
      seen.add(a); seen.add(b); pairs.push([a, b]);
    }
    fixtures.set(w, pairs);
  }
  // Real record through `week`.
  const record = new Map(ids.map(id => [id, { w: 0, pf: 0 }]));
  for (const w of played) {
    const score = new Map(byWeek.get(w).map(r => [String(r.roster_id), Number(r.points)]));
    for (const r of byWeek.get(w)) {
      const a = String(r.roster_id), b = r.opponent_roster_id == null ? null : String(r.opponent_roster_id);
      const rec = record.get(a);
      rec.pf += score.get(a);
      if (b == null || !score.has(b)) continue;
      if (score.get(a) > score.get(b)) rec.w += 1; else if (score.get(a) === score.get(b)) rec.w += 0.5;
    }
    if (medianGame) addMedianResults(score, record);
  }
  const means = new Map(ids.map(id => [id, mean(pts.get(id))]));
  const leagueMean = mean([...means.values()]);
  let ss = 0, dof = 0;
  for (const id of ids) {
    const xs = pts.get(id), m = means.get(id);
    for (const x of xs) ss += (x - m) ** 2;
    dof += xs.length - 1;
  }
  return {
    ids, regWeeks, playoffWeeks, played, fixtures, record, means, leagueMean,
    sigma: dof > 0 ? Math.sqrt(ss / dof) : 0,
    weekScores: new Map(played.map(w => [w, new Map(byWeek.get(w).map(r => [String(r.roster_id), Number(r.points)]))])),
  };
}

/** The bracket schedule for a past season: 2026 rules' field size, the season's own playoff weeks. */
export function pastSeasonSchedule(rules, playoffWeeks) {
  const teams = rules.schedule.playoff_teams;
  const rounds = Math.ceil(Math.log2(teams));
  if (!(teams >= 2)) throw new Error('league rules: playoff team count missing');
  const perRound = playoffWeeks.length % rounds === 0 && playoffWeeks.length >= rounds
    ? playoffWeeks.length / rounds : null;
  const weeks = perRound
    ? Array.from({ length: rounds }, (_, r) => playoffWeeks.slice(r * perRound, (r + 1) * perRound))
    : rules.schedule.playoff_weeks;
  return { playoff_teams: teams, playoff_weeks: weeks, reseed: !!rules.schedule.reseed,
    round_weeks_source: perRound ? 'season_playoff_weeks' : 'rules_2026' };
}

/* -------------------------------------------------------------- simulate */

function normalFrom(rand) {
  let spare = null;
  return () => {
    if (spare != null) { const s = spare; spare = null; return s; }
    const u = 1 - rand(), v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

/**
 * P(playoffs), P(title) per team from the week-7 state.
 * strength 'points': mu shrunk with SHRINK_K; 'standings': every team at the league mean.
 */
export function simulateFromState(state, rules, schedule, { strength = 'points', runs = RUNS, seed = 7, k = SHRINK_K } = {}) {
  const { ids, played, fixtures, record, means, leagueMean, sigma } = state;
  const n0 = played.length;
  const mu = new Map(ids.map(id => [id, strength === 'points'
    ? (n0 * means.get(id) + k * leagueMean) / (n0 + k) : leagueMean]));
  const gauss = normalFrom(rng(seed));
  const draw = id => mu.get(id) + sigma * gauss();
  const remaining = [...fixtures.keys()].sort((a, b) => a - b);
  const medianGame = rules.median_game === true;
  const hits = new Map(ids.map(id => [id, { playoffs: 0, title: 0 }]));
  for (let run = 0; run < runs; run += 1) {
    const rec = new Map(ids.map(id => [id, { ...record.get(id) }]));
    for (const w of remaining) {
      const score = new Map(ids.map(id => [id, draw(id)]));
      for (const [a, b] of fixtures.get(w)) {
        const sa = score.get(a), sb = score.get(b);
        if (sa > sb) rec.get(a).w += 1; else if (sb > sa) rec.get(b).w += 1;
        else { rec.get(a).w += 0.5; rec.get(b).w += 0.5; }
      }
      for (const [id, s] of score) rec.get(id).pf += s;
      if (medianGame) addMedianResults(score, rec);
    }
    const seeded = seedStandings([...rec].map(([id, r]) => ({ id, w: r.w, pf: r.pf })), rules);
    const field = seeded.slice(0, schedule.playoff_teams);
    for (const id of field) hits.get(id).playoffs += 1;
    const b = playBracket(field, schedule, (id, weeks) => weeks.reduce(s => s + draw(id), 0));
    if (b.champion) hits.get(b.champion).title += 1;
  }
  return new Map(ids.map(id => [id, { p_playoffs: hits.get(id).playoffs / runs, p_title: hits.get(id).title / runs }]));
}

/** Rules for a past season: 2026 settings, with the division map keyed to that season's team ids. */
export function pastSeasonRules(rules, ids) {
  if (!rules.seeding.division_winners_first) return rules;
  return { ...rules, seeding: { ...rules.seeding,
    team_division: Object.fromEntries(ids.map(id => [id, rules.seeding.team_division?.[id] ?? null])) } };
}

/**
 * Does the real bracket, played with the real playoff scores under `schedule`,
 * crown the real champion from the real seeds? Structural check only.
 */
export function formatConsistent(weekRows, teams, schedule) {
  const bySeed = [...teams].sort((a, b) => a.playoff_seed - b.playoff_seed).map(t => String(t.roster_id));
  const field = bySeed.slice(0, schedule.playoff_teams);
  const pts = new Map(weekRows.filter(r => r.is_playoff).map(r => [`${r.roster_id}:${r.week}`, Number(r.points) || 0]));
  const b = playBracket(field, schedule, (id, weeks) => weeks.reduce((s, w) => s + (pts.get(`${id}:${w}`) ?? 0), 0));
  const champ = teams.find(t => t.final_rank === 1);
  return !!champ && b.champion === String(champ.roster_id);
}

/** One graded row per team of one league-season. */
export function replayLeagueSeason({ league_id, season, weekRows, teams, rules, runs = RUNS }) {
  if (season > MAX_SEASON) throw new Error(`E3-ESPN: season ${season} is held out (max ${MAX_SEASON})`);
  const state = leagueSeasonState(weekRows, { medianGame: rules.median_game === true });
  const r = pastSeasonRules(rules, state.ids);
  const schedule = pastSeasonSchedule(r, state.playoffWeeks);
  const seed = (Number(league_id) * 10007 + Number(season)) >>> 0;
  const sim = simulateFromState(state, r, schedule, { strength: 'points', runs, seed });
  const base = simulateFromState(state, r, schedule, { strength: 'standings', runs, seed: seed + 1 });
  const consistent = formatConsistent(weekRows, teams, schedule);
  return teams.map(t => {
    const id = String(t.roster_id);
    return {
      league_id, season, team_id: id,
      p_playoffs: sim.get(id).p_playoffs, p_title: sim.get(id).p_title,
      base_playoffs: base.get(id).p_playoffs, base_title: base.get(id).p_title,
      made_playoffs: t.playoff_seed <= schedule.playoff_teams ? 1 : 0,
      won_title: t.final_rank === 1 ? 1 : 0,
      format_consistent: consistent, round_weeks_source: schedule.round_weeks_source,
    };
  });
}

/* ------------------------------------------------------------------ grade */

function target(rows, pKey, bKey, yKey, clusters, seed) {
  const n = rows.length;
  const p = rows.map(r => r[pKey]), b = rows.map(r => r[bKey]), y = rows.map(r => r[yKey]);
  const gainOf = idx => brier(idx.map(i => b[i]), idx.map(i => y[i])) - brier(idx.map(i => p[i]), idx.map(i => y[i]));
  const all = rows.map((_, i) => i);
  return {
    brier_sim: round(brier(p, y), 5), brier_base: round(brier(b, y), 5),
    brier_gain: round(gainOf(all), 5),
    brier_gain_ci: bootstrapCI(n, gainOf, { clusters, seed })?.map(v => round(v, 5)) ?? null,
    slope: round(calibrationSlope(p, y), 3),
    slope_ci: bootstrapCI(n, idx => calibrationSlope(idx.map(i => p[i]), idx.map(i => y[i])),
      { clusters, reps: 300, seed: seed + 4 })?.map(v => round(v, 3)) ?? null,
    base_rate: round(mean(y), 4), mean_sim: round(mean(p), 4), mean_base: round(mean(b), 4),
    reliability: reliabilityBuckets(p, y),
  };
}

/** The E3-ESPN row from replayed team rows. Always not_enough_data: it is a sanity check. */
export function grade(rows, { reason = null, excluded = {} } = {}) {
  const common = { check: CHECK, name: NAME, metricName: 'brier_gain_playoffs_vs_standings', passBar: PASS_BAR };
  const clusters = rows.map(r => `${r.league_id}:${r.season}`);
  const leagueSeasons = new Set(clusters).size;
  if (!rows.length) {
    return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, n: 0, needsN: MIN_LEAGUE_SEASONS, needsUnit: 'league_seasons',
      needsText: `needs ${MIN_LEAGUE_SEASONS} more league-seasons${reason ? ` (${reason})` : ''}`,
      detail: { low_power: LOW_POWER, excluded, ...(reason ? { reason } : {}) } });
  }
  const playoffs = target(rows, 'p_playoffs', 'base_playoffs', 'made_playoffs', clusters, 303);
  const title = target(rows, 'p_title', 'base_title', 'won_title', clusters, 313);
  const ci = playoffs.brier_gain_ci;
  const sanity = !ci ? 'inconclusive'
    : ci[1] < 0 ? 'contradicts_sleeper (sim worse than standings-only on this small sample)'
      : ci[0] > 0 ? 'consistent_with_sleeper (sim beats standings-only on this small sample)'
        : 'inconclusive (CI spans 0)';
  const sc = playoffs.slope_ci;
  const slopeFlag = !sc ? 'no slope CI'
    : sc[1] < 0.8 ? 'playoff slope CI wholly below 0.8: over-confident on this small sample'
      : sc[0] > 1.2 ? 'playoff slope CI wholly above 1.2: under-confident on this small sample'
        : 'playoff slope CI overlaps 0.8-1.2';
  const needs = Math.max(MIN_LEAGUE_SEASONS - leagueSeasons,
    ci ? moreNeeded(leagueSeasons, ci[1] - ci[0], Math.max(Math.abs(playoffs.brier_gain), 1e-3) * 2) : 1, 1);
  const bySeason = {};
  for (const r of rows) (bySeason[r.season] ??= new Set()).add(r.league_id);
  return result({
    ...common, status: STATUS.NOT_ENOUGH_DATA, metric: playoffs.brier_gain, ci, n: rows.length,
    needsN: needs, needsUnit: 'league_seasons',
    needsText: `sanity check only: ${leagueSeasons} league-seasons, needs ${needs} more league-seasons to grade`,
    source: 'live',
    detail: {
      kind: 'historical_replay', low_power: LOW_POWER, sanity, slope_flag: slopeFlag, n_team_seasons: rows.length, n_league_seasons: leagueSeasons,
      seasons: Object.fromEntries(Object.entries(bySeason).map(([s, set]) => [s, set.size])),
      gain_sign: 'brier(standings-only) - brier(sim); positive = sim better',
      playoffs, title,
      format_consistent_league_seasons: new Set(rows.filter(r => r.format_consistent).map(r => `${r.league_id}:${r.season}`)).size,
      grade_week: GRADE_WEEK, shrink_k: SHRINK_K, shrink_k_source: 'Sleeper E3 fit 2021-22 (frozen)', runs: RUNS,
      baseline: 'standings only: same simulator, every team at the league-mean strength, week-7 record and PF carried in',
      replay: 'season-sim structure (seedStandings, playBracket, median game) on team-level week 1-7 scores',
      not_replayed: 'player-level pools (availability fit, SIM-KDST, SIM-CALIB): 2023-25 rosters exist only as the frozen end-of-season snapshot',
      rules_source: '2026 league payload (playoff teams, divisions, tiebreaker); round lengths from each season\'s playoff weeks',
      held_out: `seasons > ${MAX_SEASON} not read (2025 holdout, 2026 in progress)`,
      excluded,
    },
  });
}

/* ------------------------------------------------------------------- load */

/** Replayable league-seasons from the app database. Reads no credentials. */
export function load(database, { runs = RUNS } = {}) {
  const has = t => database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  for (const t of ['leagues', 'league_week_scores', 'league_season_teams']) {
    if (!has(t)) return { rows: [], reason: `source table ${t} is not built yet`, excluded: {} };
  }
  const leagues = database.prepare(`SELECT id, platform, payload FROM leagues WHERE platform = 'espn' ORDER BY id`).all();
  const rows = [];
  const excluded = { held_out_2025_plus: 0, no_rules: 0, incomplete: 0, error: 0, errors: [] };
  excluded.held_out_2025_plus = database.prepare(`SELECT COUNT(DISTINCT league_id || ':' || season) n
    FROM league_season_teams WHERE season > ? AND season < 2026`).get(MAX_SEASON).n;
  for (const lg of leagues) {
    let rules;
    try { rules = leagueRules(lg); } catch (e) { excluded.no_rules += 1; excluded.errors.push(String(e?.message ?? e).slice(0, 200)); continue; }
    const problem = simRulesProblem(rules);
    if (problem) { excluded.no_rules += 1; excluded.errors.push(problem.error.slice(0, 200)); continue; }
    const seasons = database.prepare(`SELECT DISTINCT season FROM league_season_teams
      WHERE league_id = ? AND season <= ? ORDER BY season`).all(lg.id, MAX_SEASON).map(r => r.season);
    for (const season of seasons) {
      if (season > MAX_SEASON) throw new Error('E3-ESPN: held-out season leaked into the load');
      const weekRows = database.prepare(`SELECT week, roster_id, points, opponent_roster_id, is_playoff
        FROM league_week_scores WHERE league_id = ? AND season = ? ORDER BY week, roster_id`).all(lg.id, season);
      const teams = database.prepare(`SELECT roster_id, playoff_seed, final_rank FROM league_season_teams
        WHERE league_id = ? AND season = ?`).all(lg.id, season);
      const regWeeksPlayed = new Set(weekRows.filter(r => !r.is_playoff && r.week <= GRADE_WEEK).map(r => r.week)).size;
      if (regWeeksPlayed < GRADE_WEEK || teams.some(t => t.playoff_seed == null || t.final_rank == null)
        || teams.filter(t => t.final_rank === 1).length !== 1) { excluded.incomplete += 1; continue; }
      try {
        rows.push(...replayLeagueSeason({ league_id: lg.id, season, weekRows, teams, rules, runs }));
      } catch (e) { excluded.error += 1; excluded.errors.push(`${season}: ${String(e?.message ?? e).slice(0, 200)}`); }
    }
  }
  return { rows, excluded };
}

export function run(database, opts = {}) {
  const { rows, reason, excluded } = load(database, opts);
  return grade(rows, { reason, excluded });
}
