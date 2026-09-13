/**
 * Bottom-up team total (Giant Plan Step 4b): sum Gridiron's own player-level
 * fantasy projections — the same usage x efficiency parameters
 * `buildPlayerWeekEngine` feeds fantasy scoring and props — into an implied
 * team point total, and compare that against the spread ensemble's own
 * top-down team-total forecast.
 *
 * WHY THIS IS A GENUINELY DIFFERENT DATA PATH (and where it secretly isn't):
 * `projections.js` anchors every player's own attempts/carries/targets to
 * `teamVolume()` — a team-level, recency-weighted average of that TEAM's own
 * real pass/rush attempts (see projections.js:247-271). That means the
 * *pace* half of a bottom-up total is not actually summed from players at
 * all; it is the same kind of team-level historical rate the top-down
 * ensemble's own team-efficiency components already use. The genuinely
 * player-level contribution — the part a team-aggregate stat cannot see — is
 * the ROSTER-WEIGHTED EFFICIENCY blend: this team's specific starting RB's
 * ypc and this specific WR1's catch rate, reacting to roster changes
 * immediately rather than only after enough team-level box scores
 * accumulate. Step 3 of the giant-plan instructions (measuring whether the
 * skill here is usage or efficiency) is really asking the sharper version of
 * this same question, and `teamBottomUpScenarios` below answers it directly
 * by nulling each half in turn.
 *
 * CORRELATION, NOT INDEPENDENT SUMMATION:
 * `sampleTeamWeekEvents` (player-week-engine.js) already gets the *volume*
 * side of team-mate correlation right — attempts/carries/targets are drawn
 * as one team-level draw and then split, so teammates cannot all run more
 * plays than the team ran. What it does NOT correlate is the EFFICIENCY
 * draw: `sampleAllocatedWeekEvents` (projections.js) draws each player's
 * yards-per-touch and TD binomial independently, so a real shared-game
 * effect (this offense had a big day; garbage time inflated every stat line)
 * is invisible to it. That is exactly the "naive independent summation"
 * failure mode the instructions warn about, and it is exactly what the
 * ALREADY-FITTED `nfl-prop-correlation.js` archetypes exist to measure —
 * they are fit on residuals off each player's own mean, the same "on a day
 * this team's box score runs hot, who runs hot together" question. This
 * module borrows that table (`propPairCorrelation`, `samePlayerCorrelation`,
 * `conditioned`) directly rather than re-fitting anything.
 */
import { eventExpectationFromVolume, teamWeekEventExpectations } from './player-week-engine.js';
import { conditioned, propPairCorrelation, samePlayerCorrelation } from './nfl-prop-correlation.js';
import { correlatedNormals, normalCdf, randn, withRandomSeed } from './stats-util.js';
import { rows } from '../db/index.js';

export const BOTTOM_UP_TEAM_TOTAL_VERSION = 'bottom-up-team-total-v1';

/* ------------------------------------------------------------- calibration */

/**
 * Solve a small (n x n) linear system by Gauss-Jordan elimination with
 * partial pivoting. Just the arithmetic OLS needs — not a modelling choice.
 */
function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (Math.abs(M[col][col]) < 1e-9) return null;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Real historical yards+TDs -> team-points calibration, OLS fit on real
 * team-weeks (`player_week_usage` summed by team, joined to the real
 * `game_lines.team_score`). Fit ONLY on seasons <= `maxSeason` so a
 * walk-forward test on later seasons never trains on its own answers.
 *
 * This is the same model-risk step `props-total-consistency.js` took on with
 * its yards->points fit, now for two predictors instead of one, and it has
 * the identical honest limitation: `player_week_usage` never sees field
 * goals, defensive/special-teams scoring, or two-point tries. The OLS
 * intercept and slopes absorb whatever of that correlates with offensive
 * yards and touchdowns; they do not model it.
 */
export function fitTeamTotalCalibration({ maxSeason } = {}) {
  const filter = Number.isInteger(maxSeason) ? 'WHERE season <= ?' : '';
  const args = Number.isInteger(maxSeason) ? [maxSeason] : [];
  const byTeamWeek = rows(`SELECT season, week, team,
      SUM(CASE WHEN position='QB' THEN passing_yards ELSE 0 END) pass_yards,
      SUM(rushing_yards) rush_yards,
      SUM(rushing_tds) + SUM(receiving_tds) tds
    FROM player_week_usage ${filter}
    GROUP BY season, week, team`, ...args);

  const pairs = [];
  for (const r of byTeamWeek) {
    const gl = rows(`SELECT team_score FROM game_lines WHERE season=? AND week=? AND team=?`,
      r.season, r.week, r.team)[0];
    if (!gl || gl.team_score == null) continue;
    pairs.push({ yards: (r.pass_yards ?? 0) + (r.rush_yards ?? 0), tds: r.tds ?? 0, points: gl.team_score });
  }
  const n = pairs.length;
  if (n < 30) return { error: 'not enough real team-weeks to fit a calibration', n };

  const mx1 = pairs.reduce((s, p) => s + p.yards, 0) / n;
  const mx2 = pairs.reduce((s, p) => s + p.tds, 0) / n;
  const my = pairs.reduce((s, p) => s + p.points, 0) / n;
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0, syy = 0;
  for (const p of pairs) {
    const x1 = p.yards - mx1, x2 = p.tds - mx2, y = p.points - my;
    s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2; s1y += x1 * y; s2y += x2 * y; syy += y * y;
  }
  const beta = solveLinear([[s11, s12], [s12, s22]], [s1y, s2y]);
  if (!beta) return { error: 'yards and TD counts were collinear in the fit sample', n };
  const [yardsCoef, tdCoef] = beta;
  const intercept = my - yardsCoef * mx1 - tdCoef * mx2;
  let ssRes = 0;
  for (const p of pairs) {
    const fitted = intercept + yardsCoef * p.yards + tdCoef * p.tds;
    ssRes += (p.points - fitted) ** 2;
  }
  const r2 = syy > 0 ? 1 - ssRes / syy : null;
  return {
    intercept: +intercept.toFixed(4), yards_coef: +yardsCoef.toFixed(6), td_coef: +tdCoef.toFixed(4),
    r2: r2 == null ? null : +r2.toFixed(4), n, max_season: maxSeason ?? null,
    rmse_in_sample: +Math.sqrt(ssRes / n).toFixed(3)
  };
}

/**
 * Position-average efficiency, measured from real box scores through
 * `maxSeason`. Used ONLY by the usage-vs-efficiency ablation below — never by
 * the full bottom-up total, which always uses each player's own projected
 * rates.
 */
export function positionAverageEfficiency({ maxSeason } = {}) {
  const filter = Number.isInteger(maxSeason) ? 'AND season <= ?' : '';
  const args = Number.isInteger(maxSeason) ? [maxSeason] : [];
  const out = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const r = rows(`SELECT
        SUM(passing_yards) py, SUM(attempts) att, SUM(passing_tds) ptd, SUM(interceptions) ints,
        SUM(rushing_yards) ry, SUM(carries) car, SUM(rushing_tds) rtd,
        SUM(receiving_yards) recy, SUM(targets) tgt, SUM(receptions) rec, SUM(receiving_tds) rectd
      FROM player_week_usage WHERE position=? ${filter}`, pos, ...args)[0];
    out[pos] = {
      ypa: r.att > 0 ? r.py / r.att : 0,
      pass_td_rate: r.att > 0 ? r.ptd / r.att : 0,
      int_rate: r.att > 0 ? r.ints / r.att : 0,
      ypc: r.car > 0 ? r.ry / r.car : 0,
      rush_td_rate: r.car > 0 ? r.rtd / r.car : 0,
      ypt: r.tgt > 0 ? r.recy / r.tgt : 0,
      catch_rate: r.tgt > 0 ? r.rec / r.tgt : 0,
      rec_td_rate: r.tgt > 0 ? r.rectd / r.tgt : 0
    };
  }
  return out;
}

/**
 * Position-level sigma for the yards legs the Monte Carlo shocks, measured
 * from real box scores through `maxSeason`. Eligibility floors match the
 * "real touches, not garbage-time cameos" filters `props-total-consistency`
 * used for the same purpose.
 */
export function positionStatSigma({ maxSeason } = {}) {
  const filter = Number.isInteger(maxSeason) ? 'AND season <= ?' : '';
  const args = Number.isInteger(maxSeason) ? [maxSeason] : [];
  const sigmaOf = (sql, ...a) => {
    const vals = rows(sql, ...a).map(r => r.v);
    if (vals.length < 30) return null;
    const m = vals.reduce((s, x) => s + x, 0) / vals.length;
    return Math.sqrt(vals.reduce((s, x) => s + (x - m) ** 2, 0) / (vals.length - 1));
  };
  return {
    passing_yards: sigmaOf(`SELECT passing_yards v FROM player_week_usage WHERE position='QB' AND attempts>=20 ${filter}`, ...args) ?? 75,
    rushing_yards: {
      QB: sigmaOf(`SELECT rushing_yards v FROM player_week_usage WHERE position='QB' AND carries>=3 ${filter}`, ...args) ?? 15,
      RB: sigmaOf(`SELECT rushing_yards v FROM player_week_usage WHERE position='RB' AND carries>=8 ${filter}`, ...args) ?? 30,
      WR: sigmaOf(`SELECT rushing_yards v FROM player_week_usage WHERE position='WR' AND carries>=1 ${filter}`, ...args) ?? 8,
      TE: 5
    }
  };
}

/* --------------------------------------------------------------- aggregate */

/** Per-player event expectations for one team, from the shared, cutoff-safe engine. */
export function teamBottomUpPlayers(engine, team) {
  return [...teamWeekEventExpectations(engine, team).values()];
}

/** Sum a set of player event-expectation objects into a team point total. */
function aggregatePoints(players, calibration) {
  let passYards = 0, rushYards = 0, tds = 0;
  for (const p of players) {
    if (p.position === 'QB') passYards += p.events.passYd;
    rushYards += p.events.rushYd;
    tds += p.events.rushTd + p.events.recTd;
  }
  const yards = passYards + rushYards;
  const points = calibration.intercept + calibration.yards_coef * yards + calibration.td_coef * tds;
  return { points: +points.toFixed(2), pass_yards: +passYards.toFixed(1), rush_yards: +rushYards.toFixed(1),
    offensive_tds: +tds.toFixed(3) };
}

/**
 * The usage-vs-efficiency test the instructions called out by name. Three
 * scenarios built from the SAME player list and the SAME `eventExpectationFromVolume`
 * math the production engine uses — nothing here is a new football model,
 * only different inputs to the existing one:
 *
 *  - full:              each player's own projected volume AND own projected
 *                        efficiency (what the bottom-up total actually ships).
 *  - usage_nulled:       each player's own efficiency, but touches spread
 *                        evenly across teammates at the same role instead of
 *                        by projected share. If the team total barely moves,
 *                        knowing WHO gets the ball is not where the skill is.
 *  - efficiency_nulled:  each player's own projected touches, but at the
 *                        POSITION-AVERAGE rate instead of their own. If the
 *                        team total moves a lot, the skill is in efficiency.
 */
export function teamBottomUpScenarios(engine, team, { calibration, leagueAvg }) {
  const players = teamBottomUpPlayers(engine, team);
  const full = aggregatePoints(players, calibration);

  const rushers = players.filter(p => p.volume.carries > 0);
  const receivers = players.filter(p => p.volume.targets > 0);
  const totalCarries = rushers.reduce((s, p) => s + p.volume.carries, 0);
  const totalTargets = receivers.reduce((s, p) => s + p.volume.targets, 0);
  const usageNulledPlayers = players.map(p => {
    const carries = p.volume.carries > 0 ? totalCarries / rushers.length : 0;
    const targets = p.volume.targets > 0 ? totalTargets / receivers.length : 0;
    const proj = { player_id: p.player_id, name: p.name, team: p.team, position: p.position, params: p.efficiency };
    return eventExpectationFromVolume(proj, { attempts: p.volume.attempts, carries, targets });
  });
  const usageNulled = aggregatePoints(usageNulledPlayers, calibration);

  const efficiencyNulledPlayers = players.map(p => {
    const avg = leagueAvg[p.position] ?? p.efficiency;
    const proj = { player_id: p.player_id, name: p.name, team: p.team, position: p.position, params: avg };
    return eventExpectationFromVolume(proj, p.volume);
  });
  const efficiencyNulled = aggregatePoints(efficiencyNulledPlayers, calibration);

  return { full, usage_nulled: usageNulled, efficiency_nulled: efficiencyNulled, participants: players.length };
}

/* ---------------------------------------------------------- correlated MC */

/**
 * Correlated Monte Carlo team-total distribution. Legs are scoped to exactly
 * the quantities `aggregatePoints` sums (one team passer's passing yards,
 * every rusher's rushing yards, every scorer's TD count) — nothing wider,
 * so every leg here is a real input to the number being reported, not a
 * side quantity along for the ride.
 *
 * Reuses the fitted `prop_correlation_estimates` table (`propPairCorrelation`,
 * `samePlayerCorrelation`) and its own `conditioned()` PD-repair, exactly as
 * `sgpAnalysis` does for same-game-parlay pricing — same archetypes, same
 * numerical treatment, applied to a different sum.
 */
export function teamBottomUpDistribution(engine, team, {
  calibration, trials = 4000, seed = null, sigmas
} = {}) {
  const players = teamBottomUpPlayers(engine, team);
  const legs = [];
  // Baseline: the deterministic mean of every player who does NOT clear the
  // eligibility floor below is still counted every trial, just not shocked.
  // (Bug found and fixed via this module's own consistency check — see
  // PROPS_TO_SPREAD_REPORT.md.) The fitted sigmas are measured on QUALIFYING
  // players only (QB attempts>=20, RB carries>=8, ...) — the same "real
  // touches, not garbage-time cameos" floor `playerPropEligibility`
  // (player-week-engine.js) already uses for props markets. Applying a
  // starter-level sigma to a third-string back's 2-carry mean is not a small
  // approximation: `Math.max(0, mean + z*sigma)` clamps the (large) negative
  // half of that draw to zero while leaving the positive half alone, which
  // pushes E[max(0,X)] toward `sigma/sqrt(2*pi)` — tens of yards above a
  // near-zero true mean — for every thin-usage player on the roster. Gating
  // which players get a stochastic leg at all, at the same thresholds the
  // sigmas were fit on, is the fix; their real contribution is not dropped,
  // only its variance is (there being no reliable sigma for it to draw from).
  // Eligibility floors match `positionStatSigma`'s OWN fit-eligibility floors
  // EXACTLY (attempts>=20 for QB passing, carries>=8/1 for RB/WR rushing) —
  // not merely similar ones. A leg with a lower floor than its sigma was fit
  // on reproduces the same bug at a smaller scale: a 5-carry back's mean is
  // still far enough below the RB-population sigma to get inflated by the
  // clamp below.
  const RUSH_FLOOR = { QB: 3, RB: 8, WR: 1, TE: 1 };
  let baselinePassYards = 0, baselineRushYards = 0, baselineTds = 0;
  for (const p of players) {
    const qbEligible = p.position === 'QB' && p.volume.attempts >= 20;
    const rushEligible = p.volume.carries >= (RUSH_FLOOR[p.position] ?? 8);
    const tdMean = p.events.rushTd + p.events.recTd;
    if (p.position === 'QB') {
      if (qbEligible) legs.push({ player_id: p.player_id, team: p.team, position: p.position,
        stat: 'passing_yards', mean: p.events.passYd, kind: 'passing_yards' });
      else baselinePassYards += p.events.passYd;
    }
    if (p.volume.carries > 0) {
      if (rushEligible) legs.push({ player_id: p.player_id, team: p.team, position: p.position,
        stat: 'rushing_yards', mean: p.events.rushYd, kind: 'rushing_yards' });
      else baselineRushYards += p.events.rushYd;
    }
    const tdEligible = p.volume.carries >= 4 || p.volume.targets >= 2;
    if ((p.volume.carries > 0 || p.volume.targets > 0) && tdMean > 0) {
      if (tdEligible) {
        // No fitted archetype distinguishes rushing_tds from receiving_tds —
        // only the combined 'anytime_td' market is ever quoted (see QUOTED in
        // nfl-prop-correlation.js), so that is the correlation this borrows.
        // The marginal being shocked (an expected TD COUNT) is continuous,
        // not the binary anytime-td indicator the archetype was fit on; using
        // its correlation as a same-game co-movement proxy for TD counts is
        // an approximation, stated here rather than hidden in the number.
        legs.push({ player_id: p.player_id, team: p.team, position: p.position,
          stat: 'anytime_td', mean: tdMean, kind: 'td_count' });
      } else baselineTds += tdMean;
    }
  }
  if (!legs.length) return null;

  const n = legs.length;
  const matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    if (i === j) return 1;
    const a = legs[i], b = legs[j];
    const rho = a.player_id === b.player_id ? samePlayerCorrelation(a.stat, b.stat) : propPairCorrelation(a, b);
    return Math.max(-0.95, Math.min(0.95, rho ?? 0));
  }));
  const L = conditioned(matrix);

  const sigmaFor = leg => {
    if (leg.kind === 'passing_yards') return sigmas.passing_yards;
    if (leg.kind === 'rushing_yards') return sigmas.rushing_yards[leg.position] ?? sigmas.rushing_yards.RB;
    return Math.sqrt(Math.max(leg.mean, 0.05)); // Poisson-ish sd for a TD count
  };
  const stdNormalPdf = x => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  /**
   * Exact E[max(0, mean + sigma*Z)] - mean for Z ~ N(0,1): the eligibility
   * floors above remove the WORST cases, but no floor makes this zero, and
   * the "raise the eligibility bar" approach was tried first and left a
   * measured ~4-point average team-total bias even after matching the
   * sigma-fit populations exactly (see PROPS_TO_SPREAD_REPORT.md) — the
   * clamp itself, not merely a population mismatch, is what shifts the mean.
   * Every simulated leg is re-centered by exactly this amount, a constant
   * per leg, so the trial-to-trial correlation and variance this module
   * exists to measure are untouched; only the location is corrected back to
   * the same mean `teamBottomUpScenarios` reports deterministically.
   */
  const clampExcess = (mean, sigma) => {
    if (!(sigma > 0)) return 0;
    const r = mean / sigma;
    return mean * (normalCdf(r) - 1) + sigma * stdNormalPdf(r);
  };
  const bias = legs.map(leg => clampExcess(leg.mean, sigmaFor(leg)));

  // The naive comparison run draws each leg from its OWN independent standard
  // normal (no Cholesky factor at all) — precisely the "badly wrong variance"
  // baseline this module exists to beat, using the same `randn()` the rest of
  // this codebase's sampler already relies on rather than a second RNG.
  const runTrials = correlate => {
    const out = new Float64Array(trials);
    for (let t = 0; t < trials; t++) {
      const z = correlate ? correlatedNormals(L) : legs.map(() => randn());
      let passYards = baselinePassYards, rushYards = baselineRushYards, tds = baselineTds;
      for (let i = 0; i < n; i++) {
        const leg = legs[i];
        const val = Math.max(0, leg.mean + z[i] * sigmaFor(leg)) - bias[i];
        if (leg.kind === 'passing_yards') passYards += val;
        else if (leg.kind === 'rushing_yards') rushYards += val;
        else tds += val;
      }
      out[t] = calibration.intercept + calibration.yards_coef * (passYards + rushYards) + calibration.td_coef * tds;
    }
    return out;
  };

  const summarize = arr => {
    const m = arr.reduce((s, x) => s + x, 0) / arr.length;
    const sd = Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, arr.length - 1));
    return { mean: +m.toFixed(2), sd: +sd.toFixed(2) };
  };

  const run = () => ({ correlated: summarize(runTrials(true)), naive: summarize(runTrials(false)) });
  const { correlated, naive } = seed == null ? run() : withRandomSeed(seed >>> 0, run);
  return {
    version: BOTTOM_UP_TEAM_TOTAL_VERSION, team, trials, legs: n,
    baseline_points_untouched: +(calibration.yards_coef * (baselinePassYards + baselineRushYards)
      + calibration.td_coef * baselineTds).toFixed(2),
    mean_points: correlated.mean,
    sd_points_correlated: correlated.sd,
    sd_points_naive_independent: naive.sd,
    variance_ratio_naive_over_correlated: correlated.sd > 0
      ? +((naive.sd / correlated.sd) ** 2).toFixed(3) : null
  };
}
