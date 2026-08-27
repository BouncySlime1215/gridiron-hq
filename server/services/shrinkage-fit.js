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
 * derivation.
 */
import { db, rows } from '../db/index.js';

const GAMES = 17;
const SEASON_WEIGHT = (s, through) => ({ 0: 1, 1: 0.55, 2: 0.28 })[through - s] ?? 0.12;

db.exec(`
  CREATE TABLE IF NOT EXISTS shrinkage_fits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fitted_at TEXT NOT NULL,
    through_season INTEGER NOT NULL,
    test_season INTEGER,
    crps_fitted REAL,
    crps_hardcoded REAL,
    mae_fitted REAL,
    mae_hardcoded REAL,
    active INTEGER NOT NULL DEFAULT 0,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS shrinkage_k (
    fit_id INTEGER NOT NULL REFERENCES shrinkage_fits(id),
    metric TEXT NOT NULL,
    position TEXT NOT NULL,
    k REAL NOT NULL,
    sigma2_within REAL,
    sigma2_between REAL,
    n_groups INTEGER,
    n_obs INTEGER,
    PRIMARY KEY (fit_id, metric, position)
  );
`);

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
  return { k, sigma2_within: sigma2Within, sigma2_between: sigma2Between, n_groups: I, n_obs: totalN };
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

/** Per-player-week share/count metrics, weighted by recency exactly like the model's own `n`. */
function recencyObservations(log, through, position, valueFn) {
  const out = [];
  for (const u of log) {
    if (position && u.pos !== position) continue;
    const w = SEASON_WEIGHT(u.season, through);
    if (!(w > 0)) continue;
    const value = valueFn(u);
    if (value != null && Number.isFinite(value)) out.push({ group: u.player_id, weight: w, value });
  }
  return out;
}

/** Team pass/rush attempts per team-week, grouped by team — mirrors teamVolume(). */
function teamVolumeObservations(log, through, field) {
  const out = [];
  for (const t of teamWeeks(log)) {
    const w = SEASON_WEIGHT(t.season, through);
    if (!(w > 0)) continue;
    out.push({ group: t.team, weight: w, value: t[field] });
  }
  return out;
}

/** Per-player-season availability (share of team games played), weighted by recency. */
function availabilityObservations(log, through) {
  const bySeason = new Map(); // playerId -> season -> games played
  const firstSeason = new Map();
  for (const u of log) {
    const key = u.player_id;
    const s = bySeason.get(key) ?? new Map();
    s.set(u.season, (s.get(u.season) ?? 0) + 1);
    bySeason.set(key, s);
    firstSeason.set(key, Math.min(firstSeason.get(key) ?? u.season, u.season));
  }
  const out = [];
  for (const [player, seasons] of bySeason) {
    const first = firstSeason.get(player);
    for (let s = first; s <= through; s++) {
      const w = SEASON_WEIGHT(s, through);
      if (!(w > 0)) continue;
      const played = seasons.get(s) ?? 0;
      out.push({ group: player, weight: w, value: played / GAMES });
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
export function buildFitSpecs(through) {
  const log = history(through);
  const specs = [];

  specs.push({ metric: 'team_pass_att', position: 'ALL', observations: teamVolumeObservations(log, through, 'att') });
  specs.push({ metric: 'team_rush_att', position: 'ALL', observations: teamVolumeObservations(log, through, 'car') });

  specs.push({ metric: 'target_share', position: 'ALL',
    observations: recencyObservations(log, through, null, u =>
      u.target_share != null && u.target_share > 0 ? u.target_share : null) });

  // carry_share needs team rush attempts per week, which the model reads off
  // teamVolume() rather than the raw log — recompute the same team-week map.
  const teamCarByWeek = new Map();
  for (const t of teamWeeks(log)) teamCarByWeek.set(`${t.team}|${t.season}|${t.week}`, t.car);
  const carryShareObs = position => {
    const out = [];
    for (const u of log) {
      if (position === 'RB' ? u.pos !== 'RB' : u.pos === 'RB') continue;
      const w = SEASON_WEIGHT(u.season, through);
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
    observations: recencyObservations(log, through, 'QB', u => u.attempts ?? null) });

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
export function fitAllK(through) {
  const specs = buildFitSpecs(through);
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
      if (r.k == null || !Number.isFinite(r.k)) continue;
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

/** The currently-active k-vector, as {metric: {position: k}}, or null if none has ever beaten hardcoded. */
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
