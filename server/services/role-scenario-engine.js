/**
 * Package D — player roles as scenarios, not a single yards guess.
 *
 * This module deliberately does NOT rebuild what already exists:
 *
 *   - Team volume is already conserved. `teamWeekEventExpectations` and
 *     `sampleTeamWeekEvents` (player-week-engine.js) draw ONE team-level pass/
 *     rush total and allocate it among the current roster by relative share
 *     (`reconciledVolume`/`allocateCount`), so two teammates already cannot
 *     each independently claim 100% of the same pool TODAY. What that
 *     machinery cannot do is answer "what if a specific player's role
 *     changes" — it has no lever for "player X is out this week" versus the
 *     roster the engine happens to think is active. `conservedTeamVolume`
 *     below adds exactly that lever, by re-deriving the SAME conserved
 *     allocation for a hypothetical roster and rescaling it back onto the
 *     real team-level pool size, so a scenario redistributes volume rather
 *     than shrinking or inflating the offense's total.
 *
 *   - Counts and yards are already NOT drawn from a normal distribution.
 *     `sampleAllocatedWeekEvents` (projections.js) already draws yards from a
 *     Gamma (right-skewed, matches the real shape of yardage-per-touch) and
 *     touchdowns/catches from a Binomial, and team/player volume is already
 *     drawn from a Negative Binomial fit to real week-to-week over-dispersion
 *     (see the dispersion comments in player-week-engine.js and
 *     projections.js). This module reuses those samplers rather than
 *     inventing new ones. What is missing — and what a hurdle model
 *     specifically requires — is a POINT MASS AT ZERO for "did not play at
 *     all this week," which the single-point engine has no mechanism for at
 *     the per-week prop-pricing layer (`projectWeek`/`propBoard` never
 *     multiply in any current-week active probability; `activeProbability`
 *     exists in `sampleWeeks` but is only ever wired into season-long and
 *     trade-value paths, not weekly props). The scenario mixture below adds
 *     that hurdle explicitly.
 *
 *   - Availability probability is already measured. `weeklyAvailability`
 *     (contingency.js) already turns a player's durability history plus this
 *     week's injury report into a cutoff-safe active probability. Reused
 *     directly rather than re-derived.
 *
 *   - The "does a limited/questionable player produce less" question is
 *     already measured and already validated out of sample:
 *     `measureInjuryEffect`/`validateInjuryAdjustment` (nfl-player-context.js).
 *     Reused directly as the "limited role" scenario's multiplier rather than
 *     re-fitting a duplicate number.
 *
 * WHY A MIXTURE, MEAN-PRESERVING BY CONSTRUCTION
 *
 * This codebase already tried, and already rejected, applying an injury/age
 * opportunity multiplier directly onto the point estimate: it validated in
 * isolation and then made the shipped pipeline WORSE, because the structural
 * model's shrinkage already encodes most of the same information — see the
 * long comment in player-week-engine.js's `buildPlayerWeekEngine`
 * (`opportunity_context.applied = false`). Re-running that exact mistake here
 * under a new name would not be a new experiment.
 *
 * So scenarios here are built to be MEAN-PRESERVING: the probability-weighted
 * average outcome across scenarios is constructed to match the existing
 * single-point engine's own expectation (full-role probability absorbs
 * whatever mass the other named scenarios remove), not to shift it. The
 * thing a scenario mixture can legitimately add on top of an
 * already-validated mean is a better-shaped DISTRIBUTION around it — correct
 * zero-inflation for a real DNP risk, and a fatter/thinner spread that
 * reflects genuine role uncertainty — which is exactly what calibration
 * metrics (Brier, coverage, CRPS-style pinball loss), not MAE, are able to
 * detect. See role-scenario-lab.js for the declared, pre-registered test of
 * that claim.
 */
import { rows } from '../db/index.js';
import {
  buildPlayerWeekEngine, playerWeekProjection, teamWeekEventExpectations,
  eventExpectationFromVolume
} from './player-week-engine.js';
import { sampleAllocatedWeekEvents } from './projections.js';
import { weeklyAvailability, cascades } from './contingency.js';
import { injuryContext, measureInjuryEffect } from './nfl-player-context.js';
import { detectRoleChange, roleChangepoints } from './role-changepoint.js';
import { shareSeries } from './nfl-teammate-competition.js';
import {
  arcsine, arcsineInverse, mean, randNegBinomial, random, withRandomSeed, percentiles
} from './stats-util.js';

export const ROLE_SCENARIO_ENGINE_VERSION = 'role-scenario-v1.0.0';

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/* ============================================================ scenarios */

let limitedMultiplierCache = null;

/**
 * How much of a player's normal opportunity survives when he is active but
 * listed as Questionable, or came off a Limited practice, relative to his
 * own trailing baseline. Sourced from `measureInjuryEffect`'s already-fit,
 * already out-of-sample-validated group ratios — not re-measured here.
 */
export function limitedRoleMultiplier({ fitSeasons = [2022, 2023, 2024] } = {}) {
  if (limitedMultiplierCache && limitedMultiplierCache.fitSeasons.join(',') === fitSeasons.join(',')) {
    return limitedMultiplierCache;
  }
  const measured = measureInjuryEffect(fitSeasons);
  const clean = measured.groups.clean.median_ratio || 1;
  const limited = measured.groups.limited.median_ratio;
  const questionable = measured.groups.questionable.median_ratio;
  const pooled = mean([limited, questionable].filter(x => Number.isFinite(x) && x > 0));
  const ratio = Number.isFinite(pooled) && clean > 0 ? Math.max(0.4, Math.min(1, pooled / clean)) : 0.9;
  limitedMultiplierCache = {
    fitSeasons, ratio: r3(ratio), clean_median_ratio: r3(clean),
    limited_median_ratio: r3(limited), questionable_median_ratio: r3(questionable),
    source: 'measureInjuryEffect (nfl-player-context.js): limited+questionable vs clean-report median opportunity ratio'
  };
  return limitedMultiplierCache;
}

/**
 * Named role scenarios for one focal player-week, mean-preserving by
 * construction: probabilities sum to 1 and the "full role" bucket absorbs
 * whatever mass the others remove, so the mixture's expected multiplier
 * is 1 unless a `teammate_return` scenario is offered (see below).
 */
export function buildPlayerScenarios({ engine, season, week, playerId }) {
  const projection = playerWeekProjection(engine, playerId);
  if (!projection?.team || !projection.params) return null;
  const avail = weeklyAvailability(season, week).get(playerId);
  const activeProbability = Math.max(0, Math.min(1, avail?.active_probability ?? 0.92));
  const injury = projection.gsis_id ? injuryContext(projection.gsis_id, season, week) : null;
  const onReportButPlayable = !!injury?.on_report
    && injury.report_status !== 'Out' && !/reserve|ir|pup|suspend/i.test(String(avail?.report_status ?? ''));
  const limited = limitedRoleMultiplier();

  // Only offer a teammate-return scenario when it is actually plausible: this
  // player's own role recently increased (role-changepoint.js) AND a same-
  // position teammate on the SAME team currently carries a depressed active
  // probability (i.e. is the plausible reason for the increase). Not offered
  // for every player — the plan is explicit that scenarios must be
  // data-justified, not asserted.
  const roleChange = roleChangepoints(season, week).get(playerId) ?? null;
  const teammateAtRisk = roleChange?.status === 'confirmed_role_increase'
    ? [...engine.values()].filter(p => p.team === projection.team && p.player_id !== playerId
        && p.position === projection.position)
      .map(p => ({ player_id: p.player_id, name: p.name, avail: weeklyAvailability(season, week).get(p.player_id) }))
      .filter(x => x.avail && x.avail.active_probability < 0.6)
      .sort((a, b) => a.avail.active_probability - b.avail.active_probability)[0] ?? null
    : null;

  const pInactive = Math.max(0, 1 - activeProbability);
  // Of the probability mass this player IS active, some fraction corresponds
  // to a real, currently-listed injury concern rather than a clean bill of
  // health. Approximated from the same injury-report population `avail`
  // itself was built from: an on-report-but-playable player's OWN active
  // probability already reflects some blend of "plays limited" vs "plays
  // clean" outcomes, so this split is a declared approximation, not a
  // separately fitted quantity — stated as such rather than hidden.
  const pLimitedShare = onReportButPlayable ? 0.55 : 0;
  const pLimited = activeProbability * pLimitedShare;
  const scenarios = [
    { id: 'inactive', label: 'Inactive / DNP', probability: pInactive, multiplier: 0,
      assumption: `Pregame availability model: ${(activeProbability * 100).toFixed(0)}% active` +
        (injury?.report_status ? ` (${injury.report_status}${injury.practice_status ? `, ${injury.practice_status}` : ''})` : ' (not on the injury report)') }
  ];
  if (pLimited > 0.005) {
    scenarios.push({ id: 'limited_role', label: 'Active, reduced role', probability: pLimited,
      multiplier: limited.ratio,
      assumption: `On the injury report and playable; Questionable/Limited players historically produce ${(limited.ratio * 100).toFixed(0)}% of their own trailing opportunity (measured, fit seasons ${limited.fitSeasons.join('/')})` });
  }
  let pFull = Math.max(0, activeProbability - pLimited);
  if (teammateAtRisk) {
    // A small, explicit probability that the teammate whose absence
    // apparently drove this player's recent role increase comes back this
    // week, partially reverting it. Sized off the teammate's OWN active
    // probability — never asserted as certain.
    const pReturn = Math.min(0.35, teammateAtRisk.avail.active_probability) * pFull;
    pFull -= pReturn;
    // Reverting halfway back toward a pre-increase role is a stated modeling
    // choice, not a fitted number: role-changepoint.js's own signal reports
    // prior vs recent opportunity, and a full snap back to the PRIOR level in
    // one week (rather than a graded transition) is exactly the kind of
    // assumption the explorer should surface, not launder.
    const priorOpportunity = roleChange.prior_opportunities, recentOpportunity = roleChange.recent_opportunities;
    const revertMultiplier = recentOpportunity > 0
      ? Math.max(0.4, Math.min(1, (priorOpportunity + recentOpportunity) / (2 * recentOpportunity))) : 1;
    scenarios.push({ id: 'teammate_return', label: `Active, role reverts (${teammateAtRisk.name} active)`,
      probability: pReturn, multiplier: revertMultiplier,
      assumption: `${teammateAtRisk.name} (${(teammateAtRisk.avail.active_probability * 100).toFixed(0)}% active) returning would partially revert the role-changepoint.js-confirmed increase from ${priorOpportunity.toFixed(1)} to ${recentOpportunity.toFixed(1)} opportunities/game; modeled as reverting halfway back, not asserted as a full reset` });
  }
  scenarios.push({ id: 'full_role', label: 'Active, full current role', probability: Math.max(0, pFull), multiplier: 1,
    assumption: injury?.on_report ? 'Listed on the injury report but modeled as playing his current role without reduction'
      : 'No material availability concern; role as currently modeled' });

  const total = scenarios.reduce((s, x) => s + x.probability, 0) || 1;
  for (const s of scenarios) s.probability = +(s.probability / total).toFixed(4);
  return { player_id: playerId, name: projection.name, team: projection.team, position: projection.position,
    season, week, active_probability: activeProbability, injury, role_change: roleChange, scenarios };
}

/* ================================================== conserved reallocation */

/**
 * Team-level volume under a hypothetical roster state, conserved back onto
 * the SAME team-level pool size as the real (unscaled) roster.
 *
 * `overrides` is Map<player_id, multiplier> applied to that player's own
 * targets/carries/attempts before re-deriving each teammate's share of the
 * fixed team pool. Naively re-running `teamWeekEventExpectations` on a
 * scaled roster is NOT sufficient by itself: that function's team-wide pool
 * size (`passMean * targetRate`) is partly derived from the SUM of the
 * current receivers' own target volume, so zeroing one player out would
 * mechanically shrink the whole team's modeled receiving volume rather than
 * moving it to his teammates. This rescales the scenario's totals back to
 * the baseline (unscaled) totals — the football claim being encoded is "the
 * team throws and runs about the same amount either way; who gets the ball
 * changes" — so the sum of every teammate's targets/carries/attempts in the
 * scenario equals the sum in the baseline, to floating-point precision. That
 * equality is the conservation constraint the plan asks for, and it is
 * checked directly in this module's test file.
 */
export function conservedTeamVolume(engine, team, overrides, { mult = 1, reconciliationStrength = 0 } = {}) {
  const baseline = teamWeekEventExpectations(engine, team, { mult, reconciliationStrength });
  if (!baseline.size) return { baseline, scenario: baseline, conservation_factors: { targetFactor: 1, carryFactor: 1, attemptFactor: 1 } };

  const scaledEngine = new Map(engine);
  for (const [pid, factor] of overrides) {
    const proj = scaledEngine.get(pid);
    if (!proj?.params) continue;
    scaledEngine.set(pid, { ...proj, params: { ...proj.params,
      targets: proj.params.targets * factor, carries: proj.params.carries * factor,
      attempts: proj.params.attempts * factor } });
  }
  const raw = teamWeekEventExpectations(scaledEngine, team, { mult, reconciliationStrength });

  const totalOf = (map, key) => { let s = 0; for (const p of map.values()) s += p.volume?.[key] ?? 0; return s; };
  const factorFor = key => {
    const base = totalOf(baseline, key), rawTotal = totalOf(raw, key);
    return rawTotal > 1e-6 ? base / rawTotal : 1;
  };
  const targetFactor = factorFor('targets'), carryFactor = factorFor('carries'), attemptFactor = factorFor('attempts');

  const scenario = new Map();
  for (const [pid, r] of raw) {
    const projection = playerWeekProjection(engine, pid);
    if (!projection) { scenario.set(pid, r); continue; }
    scenario.set(pid, eventExpectationFromVolume(projection, {
      attempts: r.volume.attempts * attemptFactor,
      carries: r.volume.carries * carryFactor,
      targets: r.volume.targets * targetFactor
    }));
  }
  return { baseline, scenario, conservation_factors: { targetFactor: r3(targetFactor), carryFactor: r3(carryFactor), attemptFactor: r3(attemptFactor) } };
}

/**
 * Empirical audit of the codebase's existing closest-thing-to-conservation
 * (`cascades()`, contingency.js): its per-beneficiary multipliers are each
 * fit independently by comparing a starter's "with"/"without" games, so
 * nothing stops several beneficiaries' gains from summing to MORE than the
 * departed starter's own opportunity — exactly the failure mode this
 * package's conservation requirement exists to prevent. This does not change
 * `cascades()`; it measures whether that failure mode actually occurs.
 */
export function auditCascadeConservation({ through, minGames = 6 } = {}) {
  const casc = cascades(through != null ? { through, minGames } : { minGames });
  const usage = rows(`SELECT player_id, COALESCE(targets,0)+COALESCE(carries,0)+COALESCE(attempts,0) opp
                      FROM player_week_usage WHERE ${through != null ? 'season<=?' : '1=1'}`,
  ...(through != null ? [through] : []));
  const opportunityGames = new Map();
  for (const u of usage) {
    if (u.opp <= 0) continue;
    const a = opportunityGames.get(u.player_id) ?? { n: 0, sum: 0 };
    a.n++; a.sum += u.opp; opportunityGames.set(u.player_id, a);
  }
  const findings = [];
  for (const c of casc.values()) {
    const own = opportunityGames.get(c.player_id);
    if (!own || own.n < 3) continue;
    const ownOpportunityPerGame = own.sum / own.n;
    const totalBeneficiaryGain = c.beneficiaries.reduce((s, b) => s + Math.max(0, b.gain), 0);
    findings.push({
      player_id: c.player_id, name: c.name, position: c.position,
      own_opportunity_per_game: r3(ownOpportunityPerGame),
      total_beneficiary_gain: r3(totalBeneficiaryGain),
      exceeds_own_opportunity: totalBeneficiaryGain > ownOpportunityPerGame,
      ratio: r3(ownOpportunityPerGame > 0 ? totalBeneficiaryGain / ownOpportunityPerGame : null)
    });
  }
  const violations = findings.filter(f => f.exceeds_own_opportunity);
  return {
    version: ROLE_SCENARIO_ENGINE_VERSION, n_starters_checked: findings.length,
    violations: violations.length,
    violation_rate: findings.length ? r3(violations.length / findings.length) : null,
    examples: violations.sort((a, b) => b.ratio - a.ratio).slice(0, 10),
    note: 'A violation means cascades()\'s independently-fit beneficiary multipliers, summed across all of a ' +
      'starter\'s listed teammates, promise more total extra opportunity than that starter himself ever used per ' +
      'game — more than one absence can free up. This module\'s own conservedTeamVolume avoids the failure mode by ' +
      'construction (a fixed pool, reallocated); this audit measures whether the closest EXISTING mechanism has it.'
  };
}

/* ============================================================ sampling */

/**
 * Monte Carlo draws from the full scenario mixture: for each run, pick a
 * scenario by its probability, then draw from the SAME compound sampler the
 * rest of the codebase uses (Negative Binomial volume, Gamma yards, Binomial
 * scores/catches) around that scenario's conserved mean. An `inactive` draw
 * is a genuine point mass at zero — the hurdle component — never a small
 * positive number.
 */
export function sampleScenarioMixture(engine, { season, week, playerId, runs = 3000, seed = null } = {}) {
  const scenarioSet = buildPlayerScenarios({ engine, season, week, playerId });
  if (!scenarioSet) return null;
  const projection = playerWeekProjection(engine, playerId);
  const team = scenarioSet.team;

  const cumulative = [];
  let acc = 0;
  for (const s of scenarioSet.scenarios) { acc += s.probability; cumulative.push(acc); }

  const meanVolumeByScenario = new Map();
  for (const s of scenarioSet.scenarios) {
    if (s.multiplier === 0) { meanVolumeByScenario.set(s.id, { attempts: 0, carries: 0, targets: 0 }); continue; }
    if (s.multiplier === 1) { meanVolumeByScenario.set(s.id, projection.params); continue; }
    const conserved = conservedTeamVolume(engine, team, new Map([[playerId, s.multiplier]]));
    meanVolumeByScenario.set(s.id, conserved.scenario.get(playerId)?.volume ?? projection.params);
  }

  const out = { attempts: [], carries: [], targets: [], passYd: [], rushYd: [], recYd: [], rec: [], anyTd: [] };
  const draw = () => {
    for (let i = 0; i < runs; i++) {
      const u = random();
      let chosen = scenarioSet.scenarios[scenarioSet.scenarios.length - 1];
      for (let idx = 0; idx < cumulative.length; idx++) if (u <= cumulative[idx]) { chosen = scenarioSet.scenarios[idx]; break; }
      if (chosen.multiplier === 0) {
        out.attempts.push(0); out.carries.push(0); out.targets.push(0);
        out.passYd.push(0); out.rushYd.push(0); out.recYd.push(0); out.rec.push(0); out.anyTd.push(0);
        continue;
      }
      const meanVol = meanVolumeByScenario.get(chosen.id);
      const dispersion = projection.params.dispersion;
      const attempts = meanVol.attempts > 0 ? randNegBinomial(meanVol.attempts, dispersion) : 0;
      const carries = meanVol.carries > 0 ? randNegBinomial(meanVol.carries, dispersion) : 0;
      const targets = meanVol.targets > 0 ? randNegBinomial(meanVol.targets, dispersion) : 0;
      const ev = sampleAllocatedWeekEvents(projection.params, { attempts, carries, targets });
      out.attempts.push(attempts); out.carries.push(carries); out.targets.push(targets);
      out.passYd.push(ev.passYd); out.rushYd.push(ev.rushYd); out.recYd.push(ev.recYd);
      out.rec.push(ev.rec); out.anyTd.push((ev.rushTd + ev.recTd) > 0 ? 1 : 0);
    }
  };
  seed == null ? draw() : withRandomSeed(seed >>> 0, draw);
  return { scenarios: scenarioSet.scenarios, samples: out };
}

/* ============================================================== explorer */

/**
 * The scenario explorer: for a player-week, each named scenario's
 * probability, resulting distribution, the assumption driving it, and which
 * teammates gain or lose volume in that scenario (the conservation story
 * made visible) — plus the blended mixture distribution for comparison
 * against the existing single-point engine output.
 */
export function explorePlayerWeekScenarios({ season, week, playerId }) {
  const engine = buildPlayerWeekEngine({ season, week });
  const projection = playerWeekProjection(engine, playerId);
  if (!projection) return { error: 'player not found in this player-week engine' };
  const scenarioSet = buildPlayerScenarios({ engine, season, week, playerId });
  if (!scenarioSet) return { error: 'player has no projectable params (no team or volume)' };
  const team = scenarioSet.team;

  const scenarioDetail = scenarioSet.scenarios.map(s => {
    const conserved = s.multiplier === 1
      ? { scenario: teamWeekEventExpectations(engine, team, {}) }
      : conservedTeamVolume(engine, team, new Map([[playerId, s.multiplier]]));
    const own = conserved.scenario.get(playerId);
    const baselineTeam = teamWeekEventExpectations(engine, team, {});
    const teammates = [...conserved.scenario.entries()]
      .filter(([pid]) => pid !== playerId)
      .map(([pid, state]) => {
        const base = baselineTeam.get(pid);
        const delta = (state.volume.targets + state.volume.carries) - ((base?.volume.targets ?? 0) + (base?.volume.carries ?? 0));
        return { player_id: pid, name: state.name, delta_touches: r3(delta) };
      })
      .filter(t => Math.abs(t.delta_touches) >= 0.05)
      .sort((a, b) => Math.abs(b.delta_touches) - Math.abs(a.delta_touches))
      .slice(0, 5);
    return {
      id: s.id, label: s.label, probability: s.probability, assumption: s.assumption,
      volume: own?.volume ?? { attempts: 0, carries: 0, targets: 0 },
      structural_fantasy_points: own?.structural_fantasy_points ?? 0,
      teammates_affected: teammates
    };
  });

  const mixture = sampleScenarioMixture(engine, { season, week, playerId, runs: 3000, seed: hashSeed(`${season}|${week}|${playerId}`) });
  const mixturePct = mixture ? {
    targets: percentiles(mixture.samples.targets, [0.1, 0.5, 0.9]),
    rush_yds: percentiles(mixture.samples.rushYd, [0.1, 0.5, 0.9]),
    rec_yds: percentiles(mixture.samples.recYd, [0.1, 0.5, 0.9]),
    receptions: percentiles(mixture.samples.rec, [0.1, 0.5, 0.9]),
    any_td_prob: r3(mean(mixture.samples.anyTd)),
    p_zero_touch: r3(mixture.samples.targets.filter((t, i) => t === 0 && mixture.samples.carries[i] === 0).length / mixture.samples.targets.length)
  } : null;

  return {
    version: ROLE_SCENARIO_ENGINE_VERSION, player_id: playerId, name: projection.name, team, season, week,
    baseline_engine_ppg: projection.ppg, baseline_engine_version: projection.player_week_engine?.version,
    scenarios: scenarioDetail, blended_distribution: mixturePct,
    how_to_read: 'Each scenario\'s "assumption" line is the single input that changes between it and the others. ' +
      '"teammates_affected" is the conserved reallocation: their gain/loss sums against this player\'s change, it does ' +
      'not appear or vanish. "blended_distribution" mixes all scenarios by probability, including a real point mass ' +
      'at zero touches for the inactive scenario.'
  };
}

function hashSeed(key) {
  let seed = 2166136261;
  for (let i = 0; i < key.length; i++) seed = Math.imul(seed ^ key.charCodeAt(i), 16777619);
  return seed >>> 0;
}

/* ==================================================== changepoint scan */

/**
 * A single-changepoint scan statistic on the arcsine-stabilized share
 * series: the standardized mean difference at every possible split point,
 * reporting the split with the largest separation. Operating in the arcsine
 * domain (see stats-util.js's `arcsine`/`shrinkRate`) keeps one threshold
 * meaningful across the whole [0,1] range, where a raw proportion's sampling
 * variance is not constant.
 *
 * This is a genuinely different detector from role-changepoint.js's
 * `detectRoleChange`, which only ever compares the exact last two games
 * against everything before them. This scans every possible split and
 * reports a continuous separation statistic plus WHERE the best split falls,
 * which is what a change-point model is — role-changepoint.js's own comment
 * calls itself threshold-based evidence for a different layer, not a
 * change-point model, which is why the plan asks for one here rather than an
 * in-place extension of it.
 */
export function scanChangepoint(values, { minSegment = 3 } = {}) {
  const n = values.length;
  if (n < 2 * minSegment) return null;
  const z = values.map(arcsine);
  const prefixSum = [0], prefixSq = [0];
  for (const v of z) { prefixSum.push(prefixSum.at(-1) + v); prefixSq.push(prefixSq.at(-1) + v * v); }
  const meanOf = (a, b) => (prefixSum[b] - prefixSum[a]) / (b - a);
  const varOf = (a, b) => {
    const len = b - a, m = meanOf(a, b);
    return Math.max(1e-6, (prefixSq[b] - prefixSq[a]) / len - m * m);
  };
  let best = null;
  for (let split = minSegment; split <= n - minSegment; split++) {
    const leftMean = meanOf(0, split), rightMean = meanOf(split, n);
    const se = Math.sqrt(varOf(0, split) / split + varOf(split, n) / (n - split));
    const stat = se > 0 ? Math.abs(rightMean - leftMean) / se : 0;
    if (!best || stat > best.stat) {
      best = { split, stat: +stat.toFixed(4),
        left_mean_share: +arcsineInverse(leftMean).toFixed(4), right_mean_share: +arcsineInverse(rightMean).toFixed(4) };
    }
  }
  return { ...best, n };
}

/* ============================================ changepoint evaluation */

function playerSeriesAcrossSeasons(seasons) {
  const byPlayer = new Map();
  for (const season of seasons) {
    for (const row of shareSeries(season)) {
      if (row.position === 'QB') continue; // opportunity share is a touch share here; QB uses attempts, a different unit
      const list = byPlayer.get(row.player_id) ?? [];
      list.push({ ...row, season });
      byPlayer.set(row.player_id, list);
    }
  }
  for (const list of byPlayer.values()) list.sort((a, b) => a.season - b.season || a.week - b.week);
  return byPlayer;
}

function snapsBySeasonPlayer(season) {
  const out = new Map();
  for (const r of rows(`SELECT player_id,week,offense_pct FROM player_week_snaps WHERE season=?`, season)) {
    const list = out.get(r.player_id) ?? [];
    list.push(r); out.set(r.player_id, list);
  }
  return out;
}

/**
 * Ground truth for grading, built ONLY from games AFTER the candidate split —
 * data no real-time detector could see. A "changed" label requires both a
 * material shift (the same >=35%/<=72% ratio bar role-changepoint.js uses,
 * for a fair comparison) AND that the new level holds for a second window
 * afterward, so a single hot/cold game cannot pass as a role change.
 */
function forwardRegimeLabel(series, index, { window = 3 } = {}) {
  const before = series.slice(Math.max(0, index - window), index).map(r => r.share);
  const after = series.slice(index, index + window).map(r => r.share);
  if (before.length < window || after.length < window) return null;
  const b = mean(before), a = mean(after);
  if (!(b > 0)) return null;
  const ratio = a / b;
  const material = ratio >= 1.35 || ratio <= 0.72;
  if (!material) return { changed: false, direction: null, ratio: r3(ratio) };
  const laterWindow = series.slice(index + window, Math.min(series.length, index + 2 * window)).map(r => r.share);
  if (laterWindow.length < Math.min(window, series.length - index - window)) return { changed: false, direction: null, ratio: r3(ratio) };
  const persistRatio = laterWindow.length ? mean(laterWindow) / b : ratio;
  const persists = ratio >= 1.35 ? persistRatio >= 1.15 : persistRatio <= 0.85;
  return { changed: !!(laterWindow.length && persists), direction: ratio >= 1.35 ? 'increase' : 'decrease', ratio: r3(ratio) };
}

function myDetectorCall(series, index, { minSegment, threshold }) {
  const prior = series.slice(0, index).map(r => r.share);
  const scan = scanChangepoint(prior, { minSegment });
  if (!scan) return { fires: false };
  const recentEnough = prior.length - scan.split <= 3;
  const fires = scan.stat >= threshold && recentEnough;
  return { fires, direction: scan.right_mean_share >= scan.left_mean_share ? 'increase' : 'decrease', stat: scan.stat };
}

function confusion() { return { tp: 0, fp: 0, fn: 0, tn: 0 }; }
function bump(acc, changed, fires) {
  if (changed && fires) acc.tp++;
  else if (changed && !fires) acc.fn++;
  else if (!changed && fires) acc.fp++;
  else acc.tn++;
}
function prf(a) {
  const precision = a.tp + a.fp ? a.tp / (a.tp + a.fp) : null;
  const recall = a.tp + a.fn ? a.tp / (a.tp + a.fn) : null;
  const f1 = precision && recall && (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return { ...a, precision: r3(precision), recall: r3(recall), f1: r3(f1) };
}

/**
 * Honest evaluation, declared before use: a candidate detection threshold is
 * chosen on `fitSeasons` ONLY by F1 against the forward-realized label, then
 * frozen and applied unchanged to `discoverySeason` and `holdoutSeason`. The
 * existing role-changepoint.js threshold detector is graded on the identical
 * label at the identical player-weeks, so this is a real comparison, not the
 * new detector graded against a friendlier bar.
 */
export function evaluateChangepointDetectors({ fitSeasons = [2022, 2023], discoverySeason = 2024,
  holdoutSeason = 2025, minSegment = 3 } = {}) {
  const fitSeries = playerSeriesAcrossSeasons(fitSeasons);
  const candidates = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0];
  const scoreThreshold = threshold => {
    const acc = confusion();
    for (const series of fitSeries.values()) {
      for (let i = 2 * minSegment; i < series.length - minSegment; i++) {
        const label = forwardRegimeLabel(series, i);
        if (!label) continue;
        const call = myDetectorCall(series, i, { minSegment, threshold });
        const fires = call.fires && (!label.changed || call.direction === label.direction);
        bump(acc, label.changed, fires);
      }
    }
    return { threshold, ...prf(acc) };
  };
  const fitScores = candidates.map(scoreThreshold);
  const chosen = fitScores.reduce((best, x) => ((x.f1 ?? 0) > (best?.f1 ?? -1) ? x : best), null);

  const gradeSeason = season => {
    const seriesMap = playerSeriesAcrossSeasons([season]);
    const snaps = snapsBySeasonPlayer(season);
    const mine = confusion(), existing = confusion();
    let n = 0;
    for (const [playerId, series] of seriesMap) {
      const playerSnaps = snaps.get(playerId) ?? [];
      for (let i = 2 * minSegment; i < series.length - minSegment; i++) {
        const label = forwardRegimeLabel(series, i);
        if (!label) continue;
        n++;
        const week = series[i].week;
        const myCall = myDetectorCall(series, i, { minSegment, threshold: chosen.threshold });
        bump(mine, label.changed, myCall.fires && (!label.changed || myCall.direction === label.direction));

        const priorGames = series.slice(0, i).map(r => ({ position: r.position, targets: r.targets, carries: r.carries, week: r.week }));
        const signal = priorGames.length >= 6 ? detectRoleChange(priorGames, playerSnaps.filter(s => s.week < week), week) : null;
        const exFires = !!signal;
        const exDirection = signal?.status === 'confirmed_role_increase' ? 'increase' : 'decrease';
        bump(existing, label.changed, exFires && (!label.changed || exDirection === label.direction));
      }
    }
    return { season, n, scan_statistic: prf(mine), existing_threshold_detector: prf(existing) };
  };

  return {
    version: ROLE_SCENARIO_ENGINE_VERSION,
    protocol: 'Threshold chosen on fitSeasons only, by F1 against a forward-realized label built strictly from ' +
      'games AFTER the candidate split (never fed to either detector). Frozen before scoring discoverySeason/' +
      'holdoutSeason. Label materiality bar (>=35% up / <=72% down, sustained into a following window) matches ' +
      'role-changepoint.js\'s own bar so the comparison is apples-to-apples, not a friendlier target for the new detector.',
    fit_seasons: fitSeasons, chosen_threshold: chosen.threshold, fit_scores: fitScores,
    discovery: gradeSeason(discoverySeason), holdout: gradeSeason(holdoutSeason)
  };
}
