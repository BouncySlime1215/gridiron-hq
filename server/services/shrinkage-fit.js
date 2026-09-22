/**
 * Build Order 1.1 — fit the shrinkage constants instead of hand-picking them.
 *
 * projections.js leans on empirical-Bayes shrinkage everywhere (a rookie's
 * target share regresses hard toward the mean; a veteran's barely moves), but
 * every strength constant (K.share, K.yards_per, K.catch_rate, K.td_rate, plus
 * the /5, /8, /10 "how many targets equal one game" divisors) was chosen by
 * feel, not measurement.
 *
 * The right constant has a name: for `shrink(observed, prior, n, k)`, the
 * minimum-MSE choice is
 *
 *     k* = sigma^2_within / sigma^2_between
 *
 * where sigma^2_within is how much a metric bounces around week to week for
 * ONE player at a fixed n, and sigma^2_between is how much true talent varies
 * ACROSS players. A metric with huge play-to-play noise and little real talent
 * spread (touchdown rate) wants a big k — trust the population, not three
 * games. A metric that is mostly a stable role (target share) wants a small
 * one. That is a one-way random-effects variance decomposition, estimated
 * here by the standard (Searle 1992) method-of-moments ANOVA for unbalanced
 * groups — no iteration, no assumptions beyond "players differ, weeks are
 * noisy around each player's level."
 *
 * Every dataset builder below mirrors the exact grouping and weighting
 * projections.js already uses at each shrink() call site, so a fitted k slots
 * into the existing formula in the same units as the hardcoded one it
 * replaces — see FIT_SPECS for the mapping and MODEL_ROADMAP.md 1.1 for the
 * derivation. (The /5, /8, /10 divisors mentioned above have since been removed
 * from projections.js; they cancelled inside shrink() and never mattered.)
 *
 * STATUS, 2026-09-17: nothing from this file has ever been persisted.
 * shrinkage_fits and shrinkage_k are both empty, activeKVector() returns null,
 * and production runs the hand-picked constants on every call. What the fit
 * would buy, measured walk-forward (fit strictly on seasons <= s-1, substitute
 * ONLY the five volume metrics, weekly MAE / Spearman, weeks 5-18):
 *
 *                 hardcoded        volume k,          volume k,
 *                                  old RECENCY fit    recency-matched fit
 *     2023     4.695 / 0.6155    4.349 / 0.6809     4.342 / 0.6830
 *     2024     4.921 / 0.6285    4.460 / 0.6961     4.448 / 0.6982
 *     2025     4.749 / 0.6194    4.376 / 0.6833     4.363 / 0.6854
 *
 * All three seasons move the same way, which is the only kind of evidence the
 * five-seasons rule accepts. The right-hand column is the fitter AFTER the
 * volume specs were moved onto the recency projections.js actually applies to
 * them (see roleWeightFor) — a further 0.007-0.013, same sign in every season.
 *
 * Do not apply the EFFICIENCY k this file produces: substituting it makes 2025
 * worse (4.773 vs 4.749). And do not persist the volume k without re-running the
 * weekly ensemble promotion afterwards — the promoted ensemble weights were fit
 * against the current, over-shrunk structural head.
 */
import { db, rows } from '../db/index.js';
import { RECENCY } from './projections.js';
import { WEEKLY_ROLE_RECENCY } from './weekly-ensemble.js';

const GAMES = 17;
// Must mirror projections.js's own seasonWeight() exactly: the fit has to be
// trained under the same recency weighting the model will actually apply the
// fitted k under, or the k it produces is optimal for a decay curve that
// doesn't exist in production. projections.js defaults RECENCY.seasonDecay to
// 0.35 (fitted; see its own comment), which decays much faster than this
// script's old standalone {1, 0.55, 0.28, 0.12} table — importing the live
// RECENCY constant keeps the two in lockstep, including the escape hatch
// (seasonDecay: null) that restores the original hand-picked table.
const SEASON_WEIGHT = (s, through) => weightUnder(RECENCY, s, through);

/**
 * One weighting rule, parameterised by the recency config, so a spec can be
 * trained under whichever config its call site actually applies.
 *
 * This exists because the invariant above was being violated for exactly the
 * metrics where the measured accuracy gain lives. projections.js runs TWO
 * recency configs, not one: efficiency and availability use `r` (RECENCY,
 * seasonDecay 0.35), while the volume quantities — teamVolume(), tgtShareW,
 * roleCarries and roleAttempts — are accumulated under `rr`, which production
 * sets to WEEKLY_ROLE_RECENCY (seasonDecay 0.05, weekHalfLife 5). The two
 * differ by 7x in how much a season-old row counts, which changes the effective
 * n a fitted k is estimated against, and therefore changes the k.
 *
 * Note the honest limit on `weekHalfLife` here. It decays weeks WITHIN the
 * cutoff season, and a fit run at a season boundary has no partial cutoff
 * season to decay — production applies it to weeks of the season being
 * predicted, which by construction are not in the training data. Passing
 * `throughWeek` lets a mid-season fit reproduce it; at a season boundary it is
 * correctly a no-op, exactly as projections.js's rowWeight() treats it.
 */
function weightUnder(r, s, through, week = null, throughWeek = null) {
  const back = through - s;
  const seasonW = r.seasonDecay == null
    ? ({ 0: 1, 1: 0.55, 2: 0.28 })[back] ?? 0.12
    : Math.pow(r.seasonDecay, back);
  if (r.weekHalfLife == null || s !== through || throughWeek == null || week == null) return seasonW;
  return seasonW * Math.pow(0.5, Math.max(0, throughWeek - week) / r.weekHalfLife);
}

/** `(season, week) => weight` under RECENCY — efficiency and availability call sites. */
const efficiencyWeightFor = through => (s, _week) => weightUnder(RECENCY, s, through);

/**
 * `(season, week) => weight` under the recency the VOLUME call sites actually apply.
 * projections.js builds `rr = { ...r, ...roleRecency }` and passes it to teamVolume()
 * and to every roleW accumulation, and production sets roleRecency to
 * WEEKLY_ROLE_RECENCY, so that is what these specs are trained under.
 */
const roleWeightFor = (through, throughWeek = null, roleRecency = WEEKLY_ROLE_RECENCY) =>
  (s, week) => weightUnder({ ...RECENCY, ...roleRecency }, s, through, week, throughWeek);

/* ------------------------------------------------------- variance components */

/**
 * One-way random-effects ANOVA, unbalanced groups, method of moments.
 * @param observations [{ group, weight, value }] — `weight` is the amount of
 *   opportunity the observation represents (targets, carries, a recency
 *   factor, ...); `value` is the rate or count measured over that opportunity.
 * @returns {k, sigma2_within, sigma2_between, n_groups, n_obs} or null if
 *   there is not enough data to estimate variance components at all.
 */
export function fitK(observations) {
  const byGroup = new Map();
  let totalW = 0, totalWY = 0, totalN = 0;
  for (const o of observations) {
    if (!(o.weight > 0) || !Number.isFinite(o.value)) continue;
    const g = byGroup.get(o.group) ?? { W: 0, WY: 0, n: 0 };
    g.W += o.weight; g.WY += o.weight * o.value; g.n += 1;
    byGroup.set(o.group, g);
    totalW += o.weight; totalWY += o.weight * o.value; totalN += 1;
  }
  const groups = [...byGroup.values()].filter(g => g.W > 0);
  const I = groups.length;
  if (I < 5 || totalW <= 0) return null;
  const grandMean = totalWY / totalW;

  const groupMean = new Map();
  for (const [g, stat] of byGroup) groupMean.set(g, stat.WY / stat.W);

  let SSW = 0;
  for (const o of observations) {
    if (!(o.weight > 0) || !Number.isFinite(o.value)) continue;
    const gm = groupMean.get(o.group);
    SSW += o.weight * (o.value - gm) ** 2;
  }
  const dfW = totalN - I;
  if (dfW <= 0) return null;
  const sigma2Within = SSW / dfW;

  let SSB = 0;
  for (const g of groups) SSB += g.W * (g.WY / g.W - grandMean) ** 2;
  const dfB = I - 1;
  const MSB = SSB / dfB;

  // Unbalanced one-way ANOVA's average-weight correction (Searle 1992 ch. 3).
  const sumW = groups.reduce((s, g) => s + g.W, 0);
  const sumW2 = groups.reduce((s, g) => s + g.W * g.W, 0);
  const n0 = (sumW - sumW2 / sumW) / dfB;
  if (!(n0 > 0)) return null;

  const sigma2Between = Math.max(0, (MSB - sigma2Within) / n0);
  // No detectable between-player variance: the data can't rule out "everyone
  // is the same," so the safest reading is "trust the prior completely."
  const k = sigma2Between > 1e-9 ? sigma2Within / sigma2Between : Infinity;
  // ICC -- what fraction of the week-to-week variance is the player, not
  // noise. Same two variance components fitK already computed; this reads
  // them the other way around from k, in [0, 1] rather than in weeks/targets/
  // etc. Data & techniques R&D, RELIABILITY-SPEC.md 2026-09-22: this is NOT
  // invariant to the observations' weighting scheme (sigma2_within scales
  // with weight, sigma2_between does not) -- a caller comparing icc across
  // fits MUST hold the weighting scheme fixed, or the comparison is invalid.
  const icc = sigma2Between > 1e-9 ? sigma2Between / (sigma2Between + sigma2Within) : 0;
  return { k, icc, sigma2_within: sigma2Within, sigma2_between: sigma2Between, n_groups: I, n_obs: totalN };
}

/* --------------------------------------------------------- dataset builders */

/** Weekly usage rows through a cutoff, same scope projections.js's history() uses. */
function history(through) {
  return rows(`SELECT u.*, p.position AS pos
               FROM player_week_usage u JOIN players p ON p.id = u.player_id
               WHERE u.season <= ? AND p.position IN ('QB','RB','WR','TE')`, through);
}

/** Team-week pass/rush attempt totals, same aggregation projections.js's teamVolume() does. */
function teamWeeks(log) {
  const byTeamWeek = new Map();
  for (const u of log) {
    const k = `${u.team}|${u.season}|${u.week}`;
    const t = byTeamWeek.get(k) ?? { team: u.team, season: u.season, week: u.week, att: 0, car: 0 };
    t.att += u.attempts ?? 0;
    t.car += u.carries ?? 0;
    byTeamWeek.set(k, t);
  }
  return [...byTeamWeek.values()].filter(t => t.team);
}

/**
 * Raw-opportunity efficiency metrics (yards/catch-rate/td-rate per target,
 * carry, or attempt). Fit per position, in the same units projections.js
 * would use if it passed the raw opportunity count as `n` (see FIT_SPECS —
 * this is what replaces the old count/5, count/8, count/10 conversion).
 */
function efficiencyObservations(log, position, oppField, valueFn) {
  const out = [];
  for (const u of log) {
    if (u.pos !== position) continue;
    const opp = u[oppField] ?? 0;
    if (!(opp > 0)) continue;
    const value = valueFn(u, opp);
    if (Number.isFinite(value)) out.push({ group: u.player_id, weight: opp, value });
  }
  return out;
}

/**
 * Per-player-week share/count metrics, weighted by recency exactly like the model's
 * own `n`. `weightFn(season, week)` is the recency rule of the call site being
 * replaced — ROLE_WEIGHT for the volume metrics, SEASON_WEIGHT otherwise.
 */
function recencyObservations(log, through, position, valueFn, weightFn) {
  const out = [];
  for (const u of log) {
    if (position && u.pos !== position) continue;
    const w = weightFn(u.season, u.week);
    if (!(w > 0)) continue;
    const value = valueFn(u);
    if (value != null && Number.isFinite(value)) out.push({ group: u.player_id, weight: w, value });
  }
  return out;
}

/** Team pass/rush attempts per team-week, grouped by team — mirrors teamVolume(). */
function teamVolumeObservations(log, through, field, weightFn) {
  const out = [];
  for (const t of teamWeeks(log)) {
    const w = weightFn(t.season, t.week);
    if (!(w > 0)) continue;
    out.push({ group: t.team, weight: w, value: t[field] });
  }
  return out;
}

/**
 * Per-player-season availability (share of team games played), weighted by recency.
 *
 * The denominator has to be the games the player's TEAM actually played that season,
 * not a flat 17. projections.js divides by teamG for a reason its own comment spells
 * out — a season that has not finished (or not kicked off) has fewer than 17 team
 * games, and dividing by 17 anyway invents phantom missed games and depresses every
 * play rate. This used to divide by GAMES, so the fit was estimating the variance of
 * a quantity the model never computes. Falls back to 17 only for a (team, season)
 * with no rows at all, which is the same fallback projections.js uses.
 */
function availabilityObservations(log, through) {
  const bySeason = new Map();    // playerId -> season -> games played
  const firstSeason = new Map();
  const latestTeam = new Map();  // playerId -> most recent team seen (mirrors projections' a.team)
  const teamGames = new Map();   // team|season -> distinct weeks played
  const teamWeekSeen = new Set();
  for (const u of log) {
    const key = u.player_id;
    const s = bySeason.get(key) ?? new Map();
    s.set(u.season, (s.get(u.season) ?? 0) + 1);
    bySeason.set(key, s);
    firstSeason.set(key, Math.min(firstSeason.get(key) ?? u.season, u.season));
    latestTeam.set(key, u.team);
    if (u.team) {
      const tw = `${u.team}|${u.season}|${u.week}`;
      if (!teamWeekSeen.has(tw)) {
        teamWeekSeen.add(tw);
        const tk = `${u.team}|${u.season}`;
        teamGames.set(tk, (teamGames.get(tk) ?? 0) + 1);
      }
    }
  }
  const out = [];
  for (const [player, seasons] of bySeason) {
    const first = firstSeason.get(player);
    const team = latestTeam.get(player);
    for (let s = first; s <= through; s++) {
      const w = SEASON_WEIGHT(s, through);
      if (!(w > 0)) continue;
      const teamG = teamGames.get(`${team}|${s}`) ?? GAMES;
      if (!(teamG > 0)) continue;
      const played = seasons.get(s) ?? 0;
      out.push({ group: player, weight: w, value: played / teamG });
    }
  }
  return out;
}

/** QB attempt share of team attempts, per player-season — mirrors the QB availability refinement. */
function qbAttemptShareObservations(log, through) {
  const teamSeasonAtt = new Map(); // team|season -> total attempts (whole team, all QBs)
  const playerSeasonAtt = new Map(); // player|season -> attempts
  const playerTeamSeason = new Map(); // player|season -> team (last seen)
  for (const u of log) {
    if (u.pos !== 'QB') continue;
    const tk = `${u.team}|${u.season}`;
    teamSeasonAtt.set(tk, (teamSeasonAtt.get(tk) ?? 0) + (u.attempts ?? 0));
    const pk = `${u.player_id}|${u.season}`;
    playerSeasonAtt.set(pk, (playerSeasonAtt.get(pk) ?? 0) + (u.attempts ?? 0));
    if (u.team) playerTeamSeason.set(pk, u.team);
  }
  const out = [];
  for (const [pk, att] of playerSeasonAtt) {
    const [playerId, seasonStr] = pk.split('|');
    const season = Number(seasonStr);
    const w = SEASON_WEIGHT(season, through);
    if (!(w > 0)) continue;
    const team = playerTeamSeason.get(pk);
    const teamAtt = teamSeasonAtt.get(`${team}|${season}`) ?? 0;
    if (!(teamAtt > 0)) continue;
    out.push({ group: playerId, weight: w, value: Math.min(1, att / teamAtt) });
  }
  return out;
}

/**
 * Every (metric, position) pair the model shrinks, and how to build its
 * training data from history through a cutoff season. `applyTo` documents
 * exactly which projections.js call site this replaces.
 */
export function buildFitSpecs(through, { throughWeek = null, roleRecency = WEEKLY_ROLE_RECENCY } = {}) {
  const log = history(through);
  const specs = [];
  // The five VOLUME metrics are accumulated in projections.js under `rr`, not `r`.
  // Training them under RECENCY was the defect this pair of weight functions fixes:
  // the fitted k for exactly the metrics that carry the measured accuracy gain was
  // being estimated in the wrong evidence units.
  const roleW = roleWeightFor(through, throughWeek, roleRecency);
  const effW = efficiencyWeightFor(through);

  specs.push({ metric: 'team_pass_att', position: 'ALL', observations: teamVolumeObservations(log, through, 'att', roleW) });
  specs.push({ metric: 'team_rush_att', position: 'ALL', observations: teamVolumeObservations(log, through, 'car', roleW) });

  specs.push({ metric: 'target_share', position: 'ALL',
    observations: recencyObservations(log, through, null, u =>
      u.target_share != null && u.target_share > 0 ? u.target_share : null, roleW) });

  // carry_share needs team rush attempts per week, which the model reads off
  // teamVolume() rather than the raw log — recompute the same team-week map.
  const teamCarByWeek = new Map();
  for (const t of teamWeeks(log)) teamCarByWeek.set(`${t.team}|${t.season}|${t.week}`, t.car);
  const carryShareObs = position => {
    const out = [];
    for (const u of log) {
      if (position === 'RB' ? u.pos !== 'RB' : u.pos === 'RB') continue;
      const w = roleW(u.season, u.week);
      if (!(w > 0)) continue;
      const teamCar = teamCarByWeek.get(`${u.team}|${u.season}|${u.week}`);
      if (!(teamCar > 0)) continue;
      out.push({ group: u.player_id, weight: w, value: (u.carries ?? 0) / teamCar });
    }
    return out;
  };
  specs.push({ metric: 'carry_share', position: 'RB', observations: carryShareObs('RB') });
  specs.push({ metric: 'carry_share', position: 'OTHER', observations: carryShareObs('OTHER') });

  specs.push({ metric: 'qb_attempts', position: 'QB',
    observations: recencyObservations(log, through, 'QB', u => u.attempts ?? null, roleW) });

  for (const position of ['WR', 'RB', 'TE']) {
    specs.push({ metric: 'ypt', position, observations:
      efficiencyObservations(log, position, 'targets', u => (u.receiving_yards ?? 0) / u.targets) });
    specs.push({ metric: 'catch_rate', position, observations:
      efficiencyObservations(log, position, 'targets', u => (u.receptions ?? 0) / u.targets) });
    specs.push({ metric: 'rec_td_rate', position, observations:
      efficiencyObservations(log, position, 'targets', u => (u.receiving_tds ?? 0) / u.targets) });
  }
  for (const position of ['QB', 'RB', 'WR']) {
    specs.push({ metric: 'ypc', position, observations:
      efficiencyObservations(log, position, 'carries', u => (u.rushing_yards ?? 0) / u.carries) });
    specs.push({ metric: 'rush_td_rate', position, observations:
      efficiencyObservations(log, position, 'carries', u => (u.rushing_tds ?? 0) / u.carries) });
  }
  specs.push({ metric: 'ypa', position: 'QB', observations:
    efficiencyObservations(log, 'QB', 'attempts', u => (u.passing_yards ?? 0) / u.attempts) });
  specs.push({ metric: 'pass_td_rate', position: 'QB', observations:
    efficiencyObservations(log, 'QB', 'attempts', u => (u.passing_tds ?? 0) / u.attempts) });
  specs.push({ metric: 'int_rate', position: 'QB', observations:
    efficiencyObservations(log, 'QB', 'attempts', u => (u.interceptions ?? 0) / u.attempts) });

  specs.push({ metric: 'availability', position: 'ALL', observations: availabilityObservations(log, through) });
  specs.push({ metric: 'qb_attempt_share', position: 'QB', observations: qbAttemptShareObservations(log, through) });

  return specs;
}

/** Fits every spec, dropping any that don't have enough data to trust. */
export function fitAllK(through, options = {}) {
  const specs = buildFitSpecs(through, options);
  const results = [];
  for (const spec of specs) {
    const fit = fitK(spec.observations);
    if (!fit) { results.push({ metric: spec.metric, position: spec.position, k: null, reason: 'insufficient data' }); continue; }
    results.push({ metric: spec.metric, position: spec.position, ...fit });
  }
  return results;
}

/** Persists a fit run (and its k-vector) as a new, immutable version. Never marked active here. */
export function saveFit({ through, testSeason, crpsFitted, crpsHardcoded, maeFitted, maeHardcoded, kVector, note }) {
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO shrinkage_fits
        (fitted_at, through_season, test_season, crps_fitted, crps_hardcoded, mae_fitted, mae_hardcoded, active, note)
      VALUES (?,?,?,?,?,?,?,0,?)`)
      .run(new Date().toISOString(), through, testSeason ?? null, crpsFitted ?? null, crpsHardcoded ?? null,
        maeFitted ?? null, maeHardcoded ?? null, note ?? null);
    const fitId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    const ins = db.prepare(`INSERT INTO shrinkage_k
        (fit_id, metric, position, k, sigma2_within, sigma2_between, n_groups, n_obs)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const r of kVector) {
      // k = Infinity is the fit's STRONGEST statement, not a failure: it means the
      // between-player variance came out at or below zero, i.e. the data shows no
      // detectable player signal in this metric and the prior should be trusted
      // outright. This line used to read `!Number.isFinite(r.k)` and dropped it, so
      // the conclusion never reached the database: activeKVector() had no entry,
      // pickK() fell back to the hand-picked constant, and shrinkSafe()'s
      // `k === Infinity -> return prior` branch was unreachable for any persisted
      // fit. A metric the data says carries no signal was being given several
      // pseudo-games of trust in the player's own number — the exact inverse of
      // what was measured. SQLite stores IEEE infinity in a REAL column and
      // node:sqlite reads it back as Infinity, so the sentinel round-trips and
      // shrinkSafe's branch is now live. NaN and null are still genuine failures
      // and are still dropped.
      if (r.k == null || Number.isNaN(r.k)) continue;
      ins.run(fitId, r.metric, r.position, r.k, r.sigma2_within ?? null, r.sigma2_between ?? null,
        r.n_groups ?? null, r.n_obs ?? null);
    }
    db.exec('COMMIT');
    return fitId;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Marks one fit as the active vector projections.js should load. Only one fit is ever active. */
export function activateFit(fitId) {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE shrinkage_fits SET active = 0').run();
    db.prepare('UPDATE shrinkage_fits SET active = 1 WHERE id = ?').run(fitId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * The currently-active k-vector, as {metric: {position: k}}, or null if none has ever
 * beaten hardcoded.
 *
 * A k of Infinity here is meaningful and is passed through deliberately: it is the
 * fitter saying "no detectable between-player variance, use the prior", and
 * projections.js's shrinkSafe() honours it. Distinguish it from a MISSING entry,
 * which means no fit for that (metric, position) exists and the hardcoded constant
 * applies.
 */
export function activeKVector() {
  const fit = rows('SELECT id FROM shrinkage_fits WHERE active = 1 ORDER BY id DESC LIMIT 1')[0];
  if (!fit) return null;
  const out = {};
  for (const r of rows('SELECT metric, position, k FROM shrinkage_k WHERE fit_id = ?', fit.id)) {
    (out[r.metric] ??= {})[r.position] = r.k;
  }
  return out;
}

export function fitHistory(limit = 20) {
  return rows('SELECT * FROM shrinkage_fits ORDER BY id DESC LIMIT ?', limit);
}

/* ------------------------------------------------------- volume-only vector */

/**
 * The only fitted constants measured to help: the five VOLUME metrics (six
 * (metric, position) pairs, because carry_share is split RB / OTHER).
 *
 * The efficiency k from the same fitter is excluded on evidence, not taste:
 * substituting it made 2025 worse (4.773 vs 4.749), because "player" is not a
 * stable group for efficiency within a season and the method-of-moments
 * between-player variance is inflated for those metrics.
 */
export const VOLUME_METRICS = Object.freeze([
  ['team_pass_att', 'ALL'], ['team_rush_att', 'ALL'], ['target_share', 'ALL'],
  ['carry_share', 'RB'], ['carry_share', 'OTHER'], ['qb_attempts', 'QB'],
]);
const VOLUME_METRIC_NAMES = new Set(VOLUME_METRICS.map(([m]) => m));

/** Fit the volume metrics only, on seasons <= `through`. Rows in fitAllK's shape. */
export function volumeKFits(through, options = {}) {
  const want = new Set(VOLUME_METRICS.map(([m, p]) => `${m}|${p}`));
  return fitAllK(through, options)
    .filter(r => want.has(`${r.metric}|${r.position}`) && r.k != null && !Number.isNaN(r.k));
}

/** fitAllK rows -> the {metric: {position: k}} shape buildProjections takes. */
export function toKVector(fits) {
  const out = {};
  for (const r of fits) (out[r.metric] ??= {})[r.position] = r.k;
  return out;
}

/** True when a recency config is the one the volume specs are trained under. */
export function isWeeklyRoleRecency(rr) {
  return rr?.seasonDecay === WEEKLY_ROLE_RECENCY.seasonDecay
    && rr?.weekHalfLife === WEEKLY_ROLE_RECENCY.weekHalfLife;
}

/**
 * The active vector AS IT APPLIES under a given volume recency.
 *
 * A fitted k is only meaningful in the evidence units it was estimated in. The
 * volume specs are trained under WEEKLY_ROLE_RECENCY (seasonDecay 0.05, week
 * half-life 5), which is what the weekly engine applies. Every season-long
 * caller — preseason-model, season-sim, draft-assist, week-postmortem,
 * ceiling-lineup — calls buildProjections with no roleRecency, so its volume
 * evidence is accumulated under RECENCY (seasonDecay 0.35): a season-old game
 * counts seven times more there. Handing those callers a k fitted for the other
 * weighting would be the same units error this file's header describes, just
 * moved to the apply side. So under any other recency the volume entries are
 * withheld and those callers keep the hand-picked constants they were validated
 * with. They are not claimed to be right, only untested with the fitted k.
 */
export function activeKVectorFor(rr, { predictingSeason } = {}) {
  const v = cutoffSafeKVector(predictingSeason);
  if (!v || isWeeklyRoleRecency(rr)) return v;
  const out = {};
  for (const [metric, byPos] of Object.entries(v)) if (!VOLUME_METRIC_NAMES.has(metric)) out[metric] = byPos;
  return Object.keys(out).length ? out : null;
}

/**
 * The active vector as it would have existed BEFORE `predictingSeason`.
 *
 * The production fit is estimated on seasons <= its through_season (2025 for the
 * first one). Handing it to a replay of 2023, 2024 or 2025 lets the constants see
 * the season being graded — a leak no caller would notice, because the numbers
 * just come out slightly better. So when the stored fit's cutoff is not strictly
 * before the season being predicted, the SAME (metric, position) pairs are re-fit
 * on seasons <= predictingSeason - 1 and that vector is used instead, memoised per
 * (fit, season). Production — predicting 2026 from a through-2025 fit — never takes
 * that branch. A caller that omits predictingSeason gets the stored vector
 * unchanged, which is the legacy behaviour; buildProjections always passes it.
 */
const walkForwardCache = new Map();
export function activeFitMeta() {
  return rows('SELECT id, through_season FROM shrinkage_fits WHERE active = 1 ORDER BY id DESC LIMIT 1')[0] ?? null;
}
export function cutoffSafeKVector(predictingSeason) {
  const meta = activeFitMeta();
  if (!meta) return null;
  const stored = activeKVector();
  if (predictingSeason == null || meta.through_season < predictingSeason) return stored;
  const ck = `${meta.id}|${predictingSeason}`;
  if (!walkForwardCache.has(ck)) {
    const want = new Set(Object.entries(stored ?? {})
      .flatMap(([m, byPos]) => Object.keys(byPos).map(p => `${m}|${p}`)));
    const fits = fitAllK(predictingSeason - 1)
      .filter(r => want.has(`${r.metric}|${r.position}`) && r.k != null && !Number.isNaN(r.k));
    const v = toKVector(fits);
    walkForwardCache.set(ck, Object.keys(v).length ? v : null);
  }
  return walkForwardCache.get(ck);
}
