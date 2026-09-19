/**
 * The injury-return model: will he play in week w+k, and how many of the remaining
 * weeks will he play at all.
 *
 * WHAT THIS IS NOT. `who-plays.js` answers "does he play THIS week", from the
 * official injury report, beat-reporter signals and snap counts, with a precedence
 * rule between them. That is a different question and it stays where it is. This
 * module answers the rest-of-season question, which no report covers: a player put
 * on injured reserve in week 4 has no week-12 injury report, and the engine still
 * has to price him.
 *
 * WHY IT IS NEEDED. `ros-projection.js`'s own header (line 66) says "ros_ppg is per
 * game PLAYED and carries no availability term, so a consumer that wants expected
 * points per calendar week must apply one", and `trade-engine.js:360` repeats the
 * caveat — "no availability term — per game played". This is WO / O2 in the master
 * plan.
 *
 * Precisely which weeks are affected, because the answer is not "all of them".
 * `trade-engine.js:359` DOES discount the current week: `currentWeekPpg` is
 * multiplied by `activeProbability`, which `contingency.js` supplies from the
 * injury report (defaulting to 0.92 when the fitted tables are absent). Every
 * LATER week is not discounted at all — `rosPpg` and `playoffPpg` at lines 366-378
 * are the raw per-game rate times a schedule term. So a player on injured reserve
 * is correctly priced at roughly zero for this Sunday and at a healthy rate for the
 * whole rest of the season, which is the half that decides a trade.
 *
 * WHAT THE DATA SAYS, measured on `nfl_roster_weekly` joined to `player_week_snaps`,
 * QB/RB/WR/TE, 2021-2025 (226,713 panel rows):
 *
 *   state at week w                          P(records a snap in week w+1)
 *   ---------------------------------------  -----------------------------
 *   ACT, played this week            n=29244            87.5%
 *   ACT, did not play this week       n=6242            20.7%
 *   RES / R01, 1 week out              n=733             0.0%
 *   RES / R01, 2 weeks out             n=688             0.1%
 *   RES / R01, 3-4 weeks out          n=1226             6.0%
 *   RES / R01, 5-8 weeks out          n=1432             2.2%
 *   RES / R01, 9+ weeks out           n=1579             0.4%
 *   RES / R48 (designated to return)   n=323            11-24% by weeks out
 *   RES / R59 (short-term), 1 wk out   n=129            62.8%
 *
 * Two things fall out of that table. First, the incumbent assumption (P = 1) is not
 * slightly wrong for an injured-reserve player, it is wrong by about a hundred
 * points: an R01 player essentially never plays the following week. Second, the
 * NFL's own detail code carries most of the signal — R48 and R59 are different
 * forecasts from R01, not noise around it — so a model that only knows "on IR"
 * throws away the part that matters. Over 2021-2025 only 43% of IR spells belonging
 * to a player who had already played that season ended in another snap that season
 * at all; for R01 alone it is 32%, with a mean return lag of 6.0 weeks.
 *
 * DESIGN: A MEASURED CURVE PER HORIZON, NOT A CHAIN. For each state at week w and
 * each horizon k, P(he records a snap in week w+k) is the observed frequency of
 * exactly that, over every player-week in the fit that had a real week w+k.
 *
 * The first version of this module was a three-state Markov chain — out, active and
 * playing, active and idle — advanced k times. It is written down here because the
 * reason it was replaced is the interesting part. The chain was well calibrated on
 * reserve players and badly calibrated on healthy ones: against 2025 held out, a
 * player who was active and played this week was predicted to play in four weeks
 * 69.8% of the time against an observed 79.3%, a 9.5-point understatement, worst at
 * horizons 4 to 6. The cause is that a chain is memoryless and the question is not:
 * the 20.7% "active but idle -> plays next week" rate pools genuine deep-bench
 * players with a starter who missed one week, so every pass through the idle state
 * bled probability off a starter who was never at risk of losing his job. Measuring
 * the horizon directly cannot make that mistake, because it never has to assume the
 * intervening weeks are independent draws.
 *
 * The cost of measuring directly is thinner cells at long horizons, which is a
 * visible, reportable cost rather than a silent bias, and it is handled by the
 * fallback ladder below.
 *
 * SHRINKAGE AND POOLING, stated because both are decisions. Detail codes are grouped
 * by what the code MEANS, never by how the outcome turned out — grouping on outcome
 * is how a small cell becomes a confident wrong answer. Only R48 (designated to
 * return) and R59 (short-term) get their own group, because only those two have a
 * documented meaning that implies a different return path; every other reserve code
 * pools into `long_term`, including ones this fit has never seen. A cell below
 * MIN_CELL observations falls back to its group at the same horizon, then to all
 * reserve weeks at that horizon, and every prediction reports which of those it came
 * from. Beyond the fitted horizon the last fitted value is held flat, and says so.
 * Nothing is fitted per position: the fit was inspected per position and the
 * differences inside reserve were smaller than the cell noise, so a position term
 * would be decoration.
 *
 * NOT GATED. This module computes and reports; nothing in the engine reads it yet.
 * `scripts/audit-injury-return.mjs` is the walk-forward test that has to pass before
 * a consumer is wired to it, and its result belongs in the PR that wires one.
 */
import { rows } from '../db/index.js';

/** Roster statuses that mean "cannot take a snap this week", measured at 0% played. */
const UNAVAILABLE = new Set(['RES', 'DEV', 'INA', 'CUT', 'RET', 'EXE', 'TRC', 'TRD', 'PUP']);

/** The reserve codes with a documented meaning that implies its own return path. */
const DETAIL_GROUPS = Object.freeze({ R48: 'designated_to_return', R59: 'short_term' });

/** Weeks-already-out buckets. The hazard is not monotone in weeks out, so buckets. */
export const OUT_BUCKETS = Object.freeze(['1', '2', '3-4', '5-8', '9+']);

export const FANTASY_POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE']);

/** A cell below this many observations reports its parent's rate, not its own. */
const MIN_CELL = 40;

/** Horizons fitted. A fantasy season is at most 18 weeks, so 17 covers week 1 to the end. */
export const MAX_HORIZON = 17;

export const bucketOf = weeksOut =>
  (weeksOut <= 1 ? '1' : weeksOut <= 2 ? '2' : weeksOut <= 4 ? '3-4' : weeksOut <= 8 ? '5-8' : '9+');

export const groupOf = statusDetail => DETAIL_GROUPS[String(statusDetail ?? '').toUpperCase()] ?? 'long_term';

/**
 * The panel the fit and the grader both read: one row per player-week, in player
 * then week order, with `played` taken from snaps rather than from the status code.
 * A status says where the team put him; only a snap says he took the field.
 */
export function availabilityPanel({ seasons, positions = FANTASY_POSITIONS } = {}) {
  const seasonList = [...new Set((seasons ?? []).map(Number).filter(Number.isInteger))];
  if (!seasonList.length) return [];
  const seasonHoles = seasonList.map(() => '?').join(',');
  const posHoles = positions.map(() => '?').join(',');
  return rows(`SELECT rw.season, rw.week, rw.gsis_id, rw.position, rw.status, rw.status_detail,
      CASE WHEN s.player_id IS NOT NULL AND s.offense_snaps > 0 THEN 1 ELSE 0 END AS played
    FROM nfl_roster_weekly rw
    LEFT JOIN players p ON p.gsis_id = rw.gsis_id
    LEFT JOIN player_week_snaps s
      ON s.player_id = p.id AND s.season = rw.season AND s.week = rw.week
    WHERE rw.season IN (${seasonHoles}) AND rw.position IN (${posHoles})
    ORDER BY rw.gsis_id, rw.season, rw.week`, ...seasonList, ...positions);
}

/** Group a flat panel into one week-ordered list per (player, season). */
export function bySeasonAndPlayer(panel) {
  const out = new Map();
  for (const r of panel) {
    const key = `${r.gsis_id}|${r.season}`;
    const list = out.get(key);
    if (list) list.push(r); else out.set(key, [r]);
  }
  return out;
}

/**
 * Walk one player-season and label every week with the state the model conditions
 * on. `weeksOut` counts the current unbroken run of unavailable weeks, so a player
 * who returns and is hurt again starts a fresh count — which is what a team's own
 * timeline does.
 */
export function stateSequence(weeks) {
  let out = 0;
  return weeks.map(w => {
    const unavailable = UNAVAILABLE.has(w.status);
    out = unavailable ? out + 1 : 0;
    return {
      ...w,
      state: unavailable ? 'ir' : w.played ? 'active_played' : 'active_idle',
      weeks_out: unavailable ? out : 0,
      group: unavailable ? groupOf(w.status_detail) : null,
      bucket: unavailable ? bucketOf(out) : null
    };
  });
}

/** The cell key a state reads its curve from. */
export function stateKey({ state, group, bucket }) {
  return state === 'ir' ? `ir|${group}|${bucket}` : state;
}

/**
 * Which states a prediction request is in, from the raw fields a caller has.
 * Exported so a consumer does not have to reimplement the RES/DEV/INA grouping.
 */
export function stateOf({ status, statusDetail = null, weeksOut = 0, playedLastWeek = false } = {}) {
  const unavailable = UNAVAILABLE.has(String(status ?? '').toUpperCase());
  if (!unavailable) return { state: playedLastWeek ? 'active_played' : 'active_idle', group: null, bucket: null };
  const out = Math.max(1, Math.trunc(weeksOut) || 1);
  return { state: 'ir', group: groupOf(statusDetail), bucket: bucketOf(out) };
}

/**
 * Fit the curve on the given seasons.
 *
 * Every number is a plain observed frequency with its own denominator kept beside
 * it, and no rate is smoothed toward a prior invented here — a cell that is too thin
 * falls back to a real parent rate instead.
 *
 * ADJACENCY IS REQUIRED ALL THE WAY ALONG THE PATH, not just at its end. The panel
 * can skip a week for a player who is on no roster at all, and counting week w+3 as
 * the 3-horizon outcome when week w+1 is missing would grade a different question.
 */
export function fitInjuryReturn({ seasons, positions = FANTASY_POSITIONS, panel = null,
  maxHorizon = MAX_HORIZON } = {}) {
  const sequences = [...bySeasonAndPlayer(panel ?? availabilityPanel({ seasons, positions })).values()]
    .map(stateSequence);

  // cells: key -> k -> {n, hits}; groups and all: the two fallback levels.
  const cells = new Map(), groups = new Map(), all = new Map();
  const bump = (map, key, k, hit) => {
    const byK = map.get(key) ?? new Map();
    const cell = byK.get(k) ?? { n: 0, hits: 0 };
    cell.n++; if (hit) cell.hits++;
    byK.set(k, cell); map.set(key, byK);
  };

  let playerSeasons = 0;
  for (const weeks of sequences) {
    playerSeasons++;
    const byWeek = new Map(weeks.map(w => [w.week, w]));
    for (const here of weeks) {
      const key = stateKey(here);
      for (let k = 1; k <= maxHorizon; k++) {
        const target = byWeek.get(here.week + k);
        if (!target || !byWeek.get(here.week + k - 1)) break;
        const hit = target.played === 1;
        bump(cells, key, k, hit);
        if (here.state === 'ir') { bump(groups, here.group, k, hit); bump(all, 'reserve', k, hit); }
      }
    }
  }

  const flatten = map => Object.fromEntries([...map].map(([key, byK]) => [key,
    Object.fromEntries([...byK].sort((a, b) => a[0] - b[0])
      .map(([k, v]) => [k, { n: v.n, rate: v.hits / v.n }]))]));

  return Object.freeze({
    seasons: [...new Set((seasons ?? []).map(Number))].sort(),
    positions: [...positions],
    min_cell: MIN_CELL,
    max_horizon: maxHorizon,
    curve: flatten(cells),
    group_curve: flatten(groups),
    reserve_curve: flatten(all).reserve ?? {},
    player_seasons: playerSeasons
  });
}

/**
 * The rate this fit will actually use for a state at horizon k, with the reason.
 *
 * Returning the reason is not decoration: "0.4% because 1,579 reserve weeks say so"
 * and "0.4% because the cell was empty and it fell back twice" are different claims,
 * and a caller that shows a number to Nick has to be able to tell them apart.
 *
 * `held_flat` marks a horizon past the end of the fit, where the last fitted value is
 * carried forward. That is a real extrapolation and it is labelled as one.
 */
export function curveFor(fit, state, k) {
  const wanted = Math.max(1, Math.trunc(k) || 1);
  const key = stateKey(state);
  const pick = (table, basis) => {
    if (!table) return null;
    const exact = table[wanted];
    if (exact && exact.n >= fit.min_cell) return { rate: exact.rate, n: exact.n, basis, held_flat: false };
    // Past the fit's reach (or into its thin tail): hold the deepest horizon that is
    // itself above MIN_CELL, rather than reporting a rate built on a handful of rows.
    const deepest = Object.entries(table)
      .map(([kk, v]) => [Number(kk), v])
      .filter(([kk, v]) => kk < wanted && v.n >= fit.min_cell)
      .sort((a, b) => b[0] - a[0])[0];
    if (deepest) return { rate: deepest[1].rate, n: deepest[1].n, basis, held_flat: true };
    return null;
  };
  return pick(fit.curve[key], 'cell')
    ?? (state.state === 'ir' ? pick(fit.group_curve[state.group], 'group') : null)
    ?? (state.state === 'ir' ? pick(fit.reserve_curve, 'all_reserve') : null)
    ?? { rate: null, n: 0, basis: 'none', held_flat: false };
}

/**
 * P(records a snap in week w+k), k = 1..horizon, for a player in a known state.
 *
 * Returns an empty series rather than guesses when the fit has nothing to say about
 * this state at all, which is what an unfitted model should do.
 */
export function playProbabilities(fit, { horizon = 8, ...state } = {}) {
  const here = stateOf(state);
  const series = [];
  for (let k = 1; k <= Math.max(0, Math.trunc(horizon) || 0); k++) {
    const c = curveFor(fit, here, k);
    if (c.rate == null) return [];
    series.push({ k, p_plays: c.rate, n: c.n, basis: c.basis, held_flat: c.held_flat });
  }
  return series;
}

/**
 * The availability term: expected number of the remaining `weeksLeft` weeks in which
 * this player records a snap.
 *
 * A bye week is a known zero and is passed in rather than inferred, because the
 * schedule lives in `game_lines` and this module deliberately does not read it — the
 * caller already has it (`trade-engine.js` computes `sched.bye`).
 */
export function expectedGamesRemaining(fit, { weeksLeft, byeWeeksLeft = 0, ...state } = {}) {
  const horizon = Math.max(0, Math.trunc(weeksLeft) || 0);
  if (!horizon) return { expected_games: 0, weeks_left: 0, per_week: [] };
  const series = playProbabilities(fit, { ...state, horizon });
  if (!series.length) return { expected_games: null, weeks_left: horizon, per_week: [] };
  const total = series.reduce((sum, s) => sum + s.p_plays, 0);
  // Byes are removed proportionally: which specific weeks they fall on would change
  // the answer only if the curve were still moving fast at that point, and taking
  // the mean rate is the honest version of not knowing which weeks they are.
  const byes = Math.max(0, Math.min(horizon, Math.trunc(byeWeeksLeft) || 0));
  const expected = total * ((horizon - byes) / horizon);
  return { expected_games: expected, weeks_left: horizon, bye_weeks_left: byes,
    share_of_weeks: expected / horizon,
    horizons_held_flat: series.filter(s => s.held_flat).length,
    per_week: series };
}
