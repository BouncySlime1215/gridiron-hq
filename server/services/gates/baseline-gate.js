/**
 * Beat-the-dumb-baseline gates (plan item C12): the one instrument.
 *
 * "Nothing ships unless it beats the dumb version." Start/sit is graded against
 * "start the higher season average" (C-01, start-sit-gate.js); waivers will be
 * graded against "add the highest projected free agent" (C-02) and trades against
 * "offer fair value" (C-03). All three reduce to the same question, so they share
 * this module rather than each growing a harness:
 *
 *   Where our policy and the dumb baseline DISAGREED, whose pick did better?
 *
 * Input is a list of disagreements, each naming both picks and what each actually
 * produced. Output is the decision win rate, points per decision, a player-clustered
 * and a week-clustered 90% interval, the minimum detectable effect at 80% power, and
 * every week our policy lost, none hidden. Pre-registration of the method:
 * docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md.
 *
 * WHY TWO INTERVALS. A decision involves two players (ours and the baseline's), and
 * each player recurs across many decisions and weeks, so decisions are not
 * independent draws. backtest-significance.js#pairedBootstrapDiff resamples clusters,
 * but a unit carries ONE cluster key, and a start/sit pair has two. The player
 * interval here is the crossed-factor ("pigeonhole") bootstrap of Owen (2007, Annals
 * of Applied Statistics 1(2)): resample players with replacement and weight each
 * decision by the product of its two players' resample counts. The week interval
 * is pairedBootstrapDiff itself, grouped by season-week: every pair in a week shares
 * that week's scores. The ship rule wants both.
 */
import { pairedBootstrapDiff } from '../backtest-significance.js';
import { random, withRandomSeed } from '../stats-util.js';

/** z(0.95) + z(0.80): the minimum detectable effect of a two-sided 90% test at 80% power (Bloom 1995). */
export const MDE_Z = 1.6449 + 0.8416;

export const SIGN_CONVENTION =
  'points = our pick minus the dumb pick, in actual points; positive favours our policy. '
  + 'Win rate is the share of disagreements our pick outscored, a tie counting half; above 0.5 favours our policy.';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** One disagreement's result: 1 / 0.5 / 0 and the points margin, our pick minus theirs. */
export function decisionOutcome(d) {
  const points = d.policy_points - d.baseline_points;
  return { win: points > 0 ? 1 : points === 0 ? 0.5 : 0, points };
}

/**
 * The player-clustered (two-factor) bootstrap of several per-decision statistics
 * at once, so every statistic sees the same resamples.
 *
 * @param decisions  [{policy_id, baseline_id, ...}]
 * @param series     {name: number[]} aligned with `decisions`
 * @returns {name: {ci90: [lo, hi], se}} plus `degenerate_draws` (resamples where no
 *   decision kept any weight, skipped rather than counted as a value)
 */
export function pigeonholeBootstrap(decisions, series, { iterations = 2000, seed = 1 } = {}) {
  const index = new Map();
  const idOf = key => {
    if (!index.has(key)) index.set(key, index.size);
    return index.get(key);
  };
  const a = decisions.map(d => idOf(String(d.policy_id)));
  const b = decisions.map(d => idOf(String(d.baseline_id)));
  const players = index.size;
  const names = Object.keys(series);
  const draws = Object.fromEntries(names.map(n => [n, []]));
  let degenerate = 0;
  if (players > 0 && decisions.length > 0) {
    withRandomSeed(seed, () => {
      const counts = new Int32Array(players);
      for (let it = 0; it < iterations; it++) {
        counts.fill(0);
        for (let i = 0; i < players; i++) counts[Math.floor(random() * players)]++;
        let den = 0;
        const num = names.map(() => 0);
        for (let k = 0; k < decisions.length; k++) {
          const w = counts[a[k]] * counts[b[k]];
          if (!w) continue;
          den += w;
          for (let j = 0; j < names.length; j++) num[j] += w * series[names[j]][k];
        }
        if (!den) { degenerate++; continue; }
        for (let j = 0; j < names.length; j++) draws[names[j]].push(num[j] / den);
      }
    });
  }
  const out = { degenerate_draws: degenerate, players };
  for (const n of names) {
    const v = draws[n].sort((x, y) => x - y);
    if (v.length < 2) { out[n] = { ci90: null, se: null }; continue; }
    const m = mean(v);
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
    out[n] = { ci90: [v[Math.floor(v.length * 0.05)], v[Math.floor(v.length * 0.95)]], se: sd };
  }
  return out;
}

/**
 * Grade a list of disagreements.
 *
 * @param decisions [{season, week, policy_id, baseline_id, policy_points, baseline_points}]
 * @returns n, players, win_rate, points_per_decision, ci90 {player, week}, se, mde80,
 *   per_week (every graded week) and failing_weeks (every week whose points per
 *   decision is below 0, never truncated).
 */
export function gradeDecisions(decisions, { iterations = 2000, seed = 1 } = {}) {
  const outcomes = decisions.map(decisionOutcome);
  const wins = outcomes.map(o => o.win);
  const points = outcomes.map(o => o.points);
  const n = decisions.length;

  const byWeek = new Map();
  decisions.forEach((d, i) => {
    const key = `${d.season}-${d.week}`;
    if (!byWeek.has(key)) byWeek.set(key, { season: d.season, week: d.week, wins: [], points: [] });
    byWeek.get(key).wins.push(wins[i]);
    byWeek.get(key).points.push(points[i]);
  });
  const perWeek = [...byWeek.values()]
    .sort((x, y) => x.season - y.season || x.week - y.week)
    .map(w => {
      const ppd = r4(mean(w.points));
      return { season: w.season, week: w.week, n: w.points.length, win_rate: r4(mean(w.wins)),
        points_per_decision: ppd, failing: ppd < 0 };
    });

  const player = pigeonholeBootstrap(decisions, { points, win: wins }, { iterations, seed });
  const groups = decisions.map(d => `${d.season}-${d.week}`);
  const weekPts = n ? pairedBootstrapDiff(decisions.map(d => d.baseline_points), decisions.map(d => d.policy_points),
    { iterations, seed, groups }) : { error: 'no disagreements' };
  const weekWr = n ? pairedBootstrapDiff(decisions.map(() => 0.5), wins, { iterations, seed, groups })
    : { error: 'no disagreements' };

  const se = { points: r4(player.points.se), win_rate: r4(player.win.se) };
  return {
    n,
    players: player.players,
    win_rate: r4(mean(wins)),
    points_per_decision: r4(mean(points)),
    ci90: {
      player: {
        points: player.points.ci90?.map(r4) ?? null,
        win_rate: player.win.ci90?.map(r4) ?? null,
        degenerate_draws: player.degenerate_draws,
      },
      week: {
        points: weekPts.error ? null : weekPts.ci90,
        win_rate: weekWr.error ? null : [r4(0.5 + weekWr.ci90[0]), r4(0.5 + weekWr.ci90[1])],
        clusters: byWeek.size,
        note: weekPts.error ?? null,
      },
    },
    se,
    mde80: {
      points: player.points.se == null ? null : r4(MDE_Z * player.points.se),
      win_rate: player.win.se == null ? null : r4(MDE_Z * player.win.se),
    },
    iterations, seed,
    per_week: perWeek,
    failing_weeks: perWeek.filter(w => w.failing),
  };
}

/**
 * The pre-registered ship rule (prereg §8), as a pure function of two grades.
 *
 * Past window: G1 player-clustered points CI lower bound > 0; G2 week-clustered points
 * CI lower bound > 0; G3 player-clustered win-rate CI lower bound > 0.5. Forward
 * window: G4 points per decision > 0 with at least one disagreement. Every bound is
 * strict: a bound sitting exactly on the line has not cleared it.
 */
export function baselineGateVerdict({ past, forward }) {
  const lo = ci => (Array.isArray(ci) && Number.isFinite(ci[0]) ? ci[0] : null);
  const hi = ci => (Array.isArray(ci) && Number.isFinite(ci[1]) ? ci[1] : null);
  const playerPts = past?.ci90?.player?.points;
  const weekPts = past?.ci90?.week?.points;
  const playerWr = past?.ci90?.player?.win_rate;
  const gates = [
    { id: 'G1', label: 'points per decision, player-clustered 90% CI lower bound > 0',
      value: lo(playerPts), passed: lo(playerPts) != null && lo(playerPts) > 0 },
    { id: 'G2', label: 'points per decision, week-clustered 90% CI lower bound > 0',
      value: lo(weekPts), passed: lo(weekPts) != null && lo(weekPts) > 0 },
    { id: 'G3', label: 'decision win rate, player-clustered 90% CI lower bound > 0.5',
      value: lo(playerWr), passed: lo(playerWr) != null && lo(playerWr) > 0.5 },
    { id: 'G4', label: 'forward weeks: points per decision > 0 with at least one disagreement',
      value: forward?.points_per_decision ?? null,
      passed: (forward?.n ?? 0) > 0 && Number.isFinite(forward?.points_per_decision) && forward.points_per_decision > 0 },
  ];
  const [g1, g2, g3, g4] = gates.map(g => g.passed);
  let verdict;
  if (!past || !(past.n > 0)) verdict = 'no_disagreements';
  else if (g1 && g2 && g3) verdict = g4 ? 'beats_dumb' : 'beats_dumb_unconfirmed_forward';
  else if (hi(playerPts) != null && hi(playerPts) < 0) verdict = 'loses_to_dumb';
  else verdict = 'not_distinguishable';
  return { verdict, gates };
}
