#!/usr/bin/env node
/**
 * PROJ-01-a: ESPN Mistake Map (stage 2 UNDERSTAND). An offline residual study of ESPN's
 * weekly fantasy projection: error = actual - ESPN (positive = ESPN projected too low).
 *
 *   (a) residual model: predicts a correction and a distribution for the error from
 *       situation features, walk-forward (fit on seasons before the graded season);
 *   (b) blind-spot library: each pre-registered spot tested alone, sign per season,
 *       pooled cluster-robust CI, Benjamini-Hochberg across all spots.
 *
 * Pre-registration: docs/evidence/2026-09-23/proj-01-preregistration.md (committed first;
 * --grade refuses to run unless it is committed and unchanged in the working tree).
 * Results: docs/tdd/2026-09-23-proj-01a-mistake-map.tdd.md
 *
 * Produces no served number and changes nothing the app reads. Run it on a COPY of the
 * app database, never the original:
 *
 *   sqlite3 ~/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data.sqlite'"
 *   node scripts/rnd/espn-mistake-map.mjs --baseline --db .local-db/data.sqlite
 *   node scripts/rnd/espn-mistake-map.mjs --grade    --db .local-db/data.sqlite
 *
 * ESPN archive: ~/gridiron-local/rnd/loop/data/espn_proj_hist (public leaguedefaults/3,
 * local only, never committed). 2025 is refused everywhere: this study never opens it.
 * Output: aggregates only (no player rows), printed and optionally written with --out
 * to a path outside the repo. Label: "local copy, not production".
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PREREG = 'docs/evidence/2026-09-23/proj-01-preregistration.md';
export const SEASONS = Object.freeze([2021, 2022, 2023, 2024]);
export const HELD_OUT = 2025;
export const WALK_FORWARD = Object.freeze([2022, 2023, 2024]); // graded seasons; 2023+2024 decide
export const DECIDING = Object.freeze([2023, 2024]);
export const FIRST_WEEK = 1;
export const LAST_WEEK = 17; // week 18 (resting starters) excluded by pre-registration
export const MIN_ESPN = 5.0; // population: ESPN projected >= 5.0 PPR points
const DEFAULT_ARCHIVE = path.join(process.env.HOME ?? '', 'gridiron-local', 'rnd', 'loop', 'data', 'espn_proj_hist');
const POS = Object.freeze({ 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE' });

/**
 * The pre-registered spots: id, predicted sign of the EXCESS error (spot mean error minus
 * the same-season same-position complement's mean error), the positions it applies to.
 * Must match the pre-registration table exactly (the test checks the ids and signs).
 */
export const SPOTS = Object.freeze([
  { id: 'backup_after_injury', sign: +1, positions: ['QB', 'RB', 'TE'] },
  { id: 'rookie_weeks_1_4', sign: -1, positions: ['QB', 'RB', 'WR', 'TE'] },
  { id: 'return_from_absence', sign: -1, positions: ['QB', 'RB', 'WR', 'TE'] },
  { id: 'qb_change', sign: -1, positions: ['RB', 'WR', 'TE'] },
  { id: 'wind_15_plus', sign: -1, positions: ['QB', 'WR', 'TE'] },
  { id: 'blowout_favorite_rb', sign: +1, positions: ['RB'] },
  { id: 'blowout_underdog_rb', sign: -1, positions: ['RB'] }
]);
export const DROPPED_SPOTS = Object.freeze([
  { id: 'team_total_moved_2_5', reason: 'no opening total for 2022 or 2023: game_lines.open_total holds 2021 and 2026 only; nfl_nfelo_games.total_line_open holds 2024 (272 games) and 2 games of 2023' }
]);

export function refuseHoldout(season) {
  if (season >= HELD_OUT) throw new Error(`${season} is not a study season: PROJ-01-a never opens ${HELD_OUT} or later`);
  return season;
}

// ---------------------------------------------------------------- ESPN archive reader
/**
 * ESPN's archived weekly projection, the same reader as BLEND-01's parseEspnArchive
 * (scripts/weekly-blend-tournament.mjs on PR #164's branch: statSourceId 1 = projection,
 * statSplitTypeId 1 = one scoring period, appliedTotal = leaguedefaults/3 full PPR,
 * QB/RB/WR/TE only), plus the actual score from the same payload (statSourceId 0), so
 * projection and outcome share one scoring system.
 */
export function parseEspnArchive(json, season) {
  const out = new Map(); // `${espnId}|${week}` -> { proj, actual, played }
  const position = new Map();
  let players = 0;
  for (const entry of json?.players ?? []) {
    const pl = entry?.player ?? {};
    const pos = POS[pl.defaultPositionId];
    if (!pos || !Number.isFinite(Number(pl.id))) continue;
    players++;
    position.set(Number(pl.id), pos);
    for (const s of pl.stats ?? []) {
      if (s.seasonId !== season || s.statSplitTypeId !== 1) continue;
      if (s.statSourceId !== 0 && s.statSourceId !== 1) continue;
      const week = Number(s.scoringPeriodId);
      const pts = Number(s.appliedTotal);
      if (!Number.isInteger(week) || week < 1 || week > 18 || !Number.isFinite(pts)) continue;
      const k = `${Number(pl.id)}|${week}`;
      const cur = out.get(k) ?? { proj: null, actual: null, played: false };
      if (s.statSourceId === 1) cur.proj = pts;
      else { cur.actual = pts; cur.played = Object.keys(s.stats ?? {}).length > 0; } // DNP weeks carry an empty stat map
      out.set(k, cur);
    }
  }
  return { byEspnWeek: out, position, players };
}

function readArchive(dir, season) {
  refuseHoldout(season);
  const file = path.join(dir, `espn_leaguedefaults3_${season}.json.gz`);
  if (!fs.existsSync(file)) throw new Error(`ESPN archive for ${season} not found at ${file}`);
  return { file: path.basename(file), ...parseEspnArchive(JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')), season) };
}

// ---------------------------------------------------------------- stats helpers
export const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export function normCdf(z) {
  // Abramowitz-Stegun 7.1.26 via erf, |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Inverse normal CDF (Acklam), for BH-adjusted interval widths. */
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Mean of `values` with a cluster-robust (by `groups`, the player) standard error, the
 * two-sided normal p-value against 0, and the 95% interval.
 */
export function clusteredMean(values, groups) {
  const n = values.length;
  if (n < 2) return { n, mean: n ? values[0] : null, se: null, p: null, ci95: null, clusters: n };
  const m = mean(values);
  const sums = new Map();
  values.forEach((v, i) => sums.set(groups[i], (sums.get(groups[i]) ?? 0) + (v - m)));
  const G = sums.size;
  let ss = 0;
  for (const s of sums.values()) ss += s * s;
  const se = G > 1 ? Math.sqrt(ss * G / (G - 1)) / n : null;
  const z = se ? m / se : null;
  return { n, clusters: G, mean: m, se, p: z == null ? null : 2 * (1 - normCdf(Math.abs(z))), ci95: se ? [m - 1.96 * se, m + 1.96 * se] : null };
}

/** Benjamini-Hochberg adjusted q-values, same order as `ps` (nulls stay null). */
export function benjaminiHochberg(ps) {
  const idx = ps.map((p, i) => [p, i]).filter(([p]) => p != null).sort((a, b) => a[0] - b[0]);
  const m = idx.length;
  const q = new Array(ps.length).fill(null);
  let running = 1;
  for (let r = m - 1; r >= 0; r--) {
    running = Math.min(running, idx[r][0] * m / (r + 1));
    q[idx[r][1]] = running;
  }
  return q;
}

/** One-sample KS statistic of `u` against Uniform(0,1) and its asymptotic p-value (Stephens 1970). */
export function ksUniform(u) {
  const x = [...u].sort((a, b) => a - b);
  const n = x.length;
  let d = 0;
  x.forEach((v, i) => { d = Math.max(d, (i + 1) / n - v, v - i / n); });
  const lam = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * d;
  let p = 0;
  for (let j = 1; j <= 100; j++) p += 2 * (-1) ** (j - 1) * Math.exp(-2 * j * j * lam * lam);
  return { n, d, p: Math.min(1, Math.max(0, p)) };
}

/** Deterministic PRNG (mulberry32) for randomized PIT ties. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Randomized PIT of `r` under the empirical distribution `sorted` (ascending). */
export function empiricalPit(sorted, r, u) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < r) lo = mid + 1; else hi = mid; }
  const below = lo;
  let hi2 = lo;
  while (hi2 < sorted.length && sorted[hi2] === r) hi2++;
  const n = sorted.length;
  return (below + u * (hi2 - below) + u * 1) / (n + 1); // +1 slot for the new point itself
}

/** Least-absolute-deviation regression by iteratively reweighted least squares (ridge 1e-6). */
export function ladFit(X, y, { iters = 60, eps = 1e-4 } = {}) {
  const k = X[0].length;
  let beta = new Array(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const A = Array.from({ length: k }, () => new Array(k).fill(0));
    const b = new Array(k).fill(0);
    for (let i = 0; i < X.length; i++) {
      const r = y[i] - X[i].reduce((s, v, j) => s + v * beta[j], 0);
      const w = 1 / Math.max(Math.abs(r), eps);
      for (let a = 0; a < k; a++) {
        b[a] += w * X[i][a] * y[i];
        for (let c = a; c < k; c++) A[a][c] += w * X[i][a] * X[i][c];
      }
    }
    for (let a = 0; a < k; a++) { A[a][a] += 1e-6; for (let c = 0; c < a; c++) A[a][c] = A[c][a]; }
    const next = solve(A, b);
    const delta = Math.max(...next.map((v, j) => Math.abs(v - beta[j])));
    beta = next;
    if (delta < 1e-7) break;
  }
  return beta;
}

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j]; x[r] = s / M[r][r]; }
  return x;
}

// ---------------------------------------------------------------- spot tests
/**
 * Excess error of each spot row: its error minus the mean error of the same season and
 * position rows NOT in the spot (the complement). Returns per-season and pooled results.
 */
export function spotTest(rows, spot) {
  const eligible = rows.filter(r => spot.positions.includes(r.position));
  const comp = new Map();
  for (const r of eligible) {
    if (r.spots[spot.id]) continue;
    const k = `${r.season}|${r.position}`;
    const c = comp.get(k) ?? { s: 0, n: 0 };
    c.s += r.error; c.n++;
    comp.set(k, c);
  }
  const inSpot = eligible.filter(r => r.spots[spot.id]);
  const excess = r => { const c = comp.get(`${r.season}|${r.position}`); return c?.n ? r.error - c.s / c.n : null; };
  const per = {};
  for (const s of SEASONS) {
    const rs = inSpot.filter(r => r.season === s);
    const ex = rs.map(excess).filter(v => v != null);
    per[s] = { n: rs.length, raw_mean: mean(rs.map(r => r.error)), excess_mean: mean(ex),
      sign: ex.length ? Math.sign(mean(ex)) : null };
  }
  const used = inSpot.filter(r => excess(r) != null);
  const pooled = clusteredMean(used.map(excess), used.map(r => r.player));
  const raw = clusteredMean(inSpot.map(r => r.error), inSpot.map(r => r.player));
  return { id: spot.id, predicted_sign: spot.sign, positions: spot.positions, per_season: per, pooled_excess: pooled, pooled_raw: raw };
}

/** The pre-registered verdict for every spot, BH across all tested spots. */
export function spotVerdicts(tests, alpha = 0.05) {
  const q = benjaminiHochberg(tests.map(t => t.pooled_excess.p));
  const m = tests.filter(t => t.pooled_excess.p != null).length;
  const order = tests.map((t, i) => [t.pooled_excess.p ?? Infinity, i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  return tests.map((t, i) => {
    const signs = SEASONS.map(s => t.per_season[s].sign);
    const sameSign = signs.every(s => s === t.predicted_sign);
    const rank = order.indexOf(i) + 1;
    // BH-adjusted interval (Benjamini-Yekutieli 2005 FCR): level 1 - rank*alpha/m
    const zAdj = normInv(1 - (rank * alpha / m) / 2);
    const pe = t.pooled_excess;
    const ciBh = pe.se ? [pe.mean - zAdj * pe.se, pe.mean + zAdj * pe.se] : null;
    const bhPass = q[i] != null && q[i] < alpha;
    const pooledSign = pe.mean == null ? null : Math.sign(pe.mean);
    return { ...t, q_bh: q[i], ci_bh: ciBh, signs, same_sign_all_seasons: sameSign,
      proven: sameSign && bhPass && pooledSign === t.predicted_sign };
  });
}

// ---------------------------------------------------------------- residual model
export const FEATURES = Object.freeze(['intercept', 'rb', 'wr', 'te', 'espn', 'espn_rb', 'espn_wr', 'espn_te',
  'spread', 'implied', 'early_weeks', ...SPOTS.map(s => `spot_${s.id}`)]);

export function featureVector(r) {
  const is = p => (r.position === p ? 1 : 0);
  return [1, is('RB'), is('WR'), is('TE'), r.espn, r.espn * is('RB'), r.espn * is('WR'), r.espn * is('TE'),
    r.spread ?? 0, r.implied ?? 0, r.week <= 4 ? 1 : 0, ...SPOTS.map(s => (r.spots[s.id] ? 1 : 0))];
}

function bucketOf(r, edges) {
  const e = edges[r.position];
  return `${r.position}|${r.espn < e[0] ? 0 : r.espn < e[1] ? 1 : 2}`;
}

/** Walk-forward: fit on seasons < test, grade the test season. */
export function residualModel(rows, testSeason, { seed = 1 } = {}) {
  const train = rows.filter(r => r.season < testSeason);
  const test = rows.filter(r => r.season === testSeason);
  if (train.some(r => r.season >= testSeason)) throw new Error('cutoff');
  const beta = ladFit(train.map(featureVector), train.map(r => r.error));
  const corr = r => featureVector(r).reduce((s, v, j) => s + v * beta[j], 0);
  // terciles of ESPN's projection per position, from the training rows only
  const edges = {};
  for (const p of ['QB', 'RB', 'WR', 'TE']) {
    const xs = train.filter(r => r.position === p).map(r => r.espn).sort((a, b) => a - b);
    edges[p] = [xs[Math.floor(xs.length / 3)], xs[Math.floor(2 * xs.length / 3)]];
  }
  const resid = new Map();
  for (const r of train) { const k = bucketOf(r, edges); if (!resid.has(k)) resid.set(k, []); resid.get(k).push(r.error - corr(r)); }
  for (const v of resid.values()) v.sort((a, b) => a - b);
  const rand = rng(seed + testSeason);
  const pits = [];
  const absE = [], absC = [], players = [];
  for (const r of test) {
    const c = corr(r);
    absE.push(Math.abs(r.error));
    absC.push(Math.abs(r.error - c));
    players.push(r.player);
    pits.push(empiricalPit(resid.get(bucketOf(r, edges)), r.error - c, rand()));
  }
  const maeEspn = mean(absE), maeCorr = mean(absC);
  const dMae = clusteredMean(absC.map((v, i) => v - absE[i]), players);
  const ks = ksUniform(pits);
  // coverage of the central 80% band, a readable companion to the KS test
  const cover80 = mean(pits.map(p => (p >= 0.1 && p <= 0.9 ? 1 : 0)));
  return { test_season: testSeason, fit_seasons: [...new Set(train.map(r => r.season))].sort(), n_fit: train.length, n_test: test.length,
    mae_espn: maeEspn, mae_corrected: maeCorr, d_mae: dMae.mean, d_mae_ci95: dMae.ci95, beats_espn: maeCorr < maeEspn,
    pit_ks_d: ks.d, pit_ks_p: ks.p, pit_ok: ks.p > 0.05, cover80,
    coefficients: Object.fromEntries(FEATURES.map((f, j) => [f, beta[j]])) };
}

// ---------------------------------------------------------------- assembly
export async function assemble({ dbPath, archiveDir, log = () => {} }) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const all = (sql, ...a) => db.prepare(sql).all(...a);

  const espnToGsis = new Map(all('SELECT espn_id, gsis_id FROM players WHERE espn_id > 0 AND gsis_id IS NOT NULL')
    .map(p => [Number(p.espn_id), p.gsis_id]));

  // first season with any stat row, per gsis (nfl_player_week_features starts 2016)
  const firstSeason = new Map(all('SELECT player_id, MIN(season) AS s FROM nfl_player_week_features GROUP BY player_id').map(r => [r.player_id, r.s]));
  const census = {};
  const rows = [];
  for (const season of SEASONS) {
    refuseHoldout(season);
    const arc = readArchive(archiveDir, season);
    const pwf = all('SELECT week, player_id, team, position, features FROM nfl_player_week_features WHERE season = ?', season);
    const teamOf = new Map(); // gsis -> Map(week -> team)
    const played = new Map(); // gsis -> Set(week)
    const qbAtt = new Map(); // team|week -> [gsis, attempts]
    for (const r of pwf) {
      if (!teamOf.has(r.player_id)) teamOf.set(r.player_id, new Map());
      teamOf.get(r.player_id).set(r.week, r.team);
      if (!played.has(r.player_id)) played.set(r.player_id, new Set());
      played.get(r.player_id).add(r.week);
      if (r.position === 'QB') {
        const att = JSON.parse(r.features).pass_attempts ?? 0;
        const k = `${r.team}|${r.week}`;
        const cur = qbAtt.get(k);
        if (!cur || att > cur[1]) qbAtt.set(k, [r.player_id, att]);
      }
    }
    const games = new Map(all('SELECT week, team, spread, implied_points, wind, roof FROM game_lines WHERE season = ?', season)
      .map(g => [`${g.team}|${g.week}`, g]));
    const teamWeeks = new Map(); // team -> sorted weeks with a game
    for (const k of games.keys()) { const [t, w] = k.split('|'); if (!teamWeeks.has(t)) teamWeeks.set(t, []); teamWeeks.get(t).push(Number(w)); }
    for (const v of teamWeeks.values()) v.sort((a, b) => a - b);
    const prevGame = (team, week) => { const ws = teamWeeks.get(team) ?? []; let p = null; for (const w of ws) if (w < week) p = w; return p; };
    const out = new Set(all("SELECT week, gsis_id FROM nfl_injuries WHERE season = ? AND report_status = 'Out'", season).map(r => `${r.gsis_id}|${r.week}`));
    const depth = new Map(); // team|week|pos -> Map(gsis -> rank)
    for (const d of all("SELECT week, team, gsis_id, pos_abb, pos_rank FROM nfl_depth WHERE season = ? AND pos_abb IN ('QB','RB','TE') AND pos_slot = pos_abb", season)) {
      const k = `${d.team}|${d.week}|${d.pos_abb}`;
      if (!depth.has(k)) depth.set(k, new Map());
      const m = depth.get(k);
      if (!m.has(d.gsis_id) || d.pos_rank < m.get(d.gsis_id)) m.set(d.gsis_id, d.pos_rank);
    }
    // ESPN weeks with a non-empty stat line also count as "played" (a gsis-less player keeps his ESPN record)
    const espnPlayed = new Map();
    for (const [k, v] of arc.byEspnWeek) if (v.played) { const [id, w] = k.split('|').map(Number); if (!espnPlayed.has(id)) espnPlayed.set(id, new Set()); espnPlayed.get(id).add(w); }

    const c = { archive: arc.file, skill_players: arc.players, candidate: 0, kept: 0, no_gsis: 0, no_team: 0, bye: 0, no_actual_as_zero: 0 };
    for (const [k, v] of arc.byEspnWeek) {
      const [espnId, week] = k.split('|').map(Number);
      if (week < FIRST_WEEK || week > LAST_WEEK || v.proj == null || v.proj < MIN_ESPN) continue;
      c.candidate++;
      const position = arc.position.get(espnId);
      const gsis = espnToGsis.get(espnId) ?? null;
      if (!gsis) c.no_gsis++;
      const tw = gsis ? teamOf.get(gsis) : null;
      let team = tw?.get(week) ?? null;
      if (!team && tw) { // nearest played week, earlier weeks first
        let best = null;
        for (const [w, t] of tw) if (best == null || Math.abs(w - week) < Math.abs(best[0] - week) || (Math.abs(w - week) === Math.abs(best[0] - week) && w < best[0])) best = [w, t];
        team = best?.[1] ?? null;
      }
      if (!team) c.no_team++;
      const g = team ? games.get(`${team}|${week}`) : null;
      if (team && !g) { c.bye++; continue; }
      const actual = v.actual ?? 0;
      if (v.actual == null) c.no_actual_as_zero++;
      // ---- spots (all pre-game except where the pre-registration says otherwise)
      const weeksPlayed = new Set([...(gsis ? played.get(gsis) ?? [] : []), ...(espnPlayed.get(espnId) ?? [])]);
      const prior = [...weeksPlayed].filter(w => w < week);
      const lastPlayed = prior.length ? Math.max(...prior) : null;
      const pg = team ? prevGame(team, week) : null;
      let backup = false;
      if (team && pg != null && gsis && ['QB', 'RB', 'TE'].includes(position)) {
        const m = depth.get(`${team}|${pg}|${position}`);
        if (m && m.get(gsis) === 2 && !out.has(`${gsis}|${week}`)) {
          backup = [...m].some(([id, rank]) => rank === 1 && out.has(`${id}|${week}`));
        }
      }
      let qbChange = false;
      if (team && pg != null && position !== 'QB') {
        const a = qbAtt.get(`${team}|${week}`), b = qbAtt.get(`${team}|${pg}`);
        qbChange = Boolean(a && b && a[0] !== b[0]);
      }
      const outdoor = g && (g.roof === 'outdoors' || g.roof === 'open');
      const spots = {
        backup_after_injury: backup,
        rookie_weeks_1_4: Boolean(gsis && firstSeason.get(gsis) === season && week <= 4),
        return_from_absence: lastPlayed != null && week - lastPlayed >= 5,
        qb_change: qbChange,
        wind_15_plus: Boolean(outdoor && g.wind != null && g.wind >= 15),
        blowout_favorite_rb: Boolean(g && position === 'RB' && g.spread != null && g.spread <= -7),
        blowout_underdog_rb: Boolean(g && position === 'RB' && g.spread != null && g.spread >= 7)
      };
      rows.push({ season, week, player: espnId, position, espn: v.proj, actual, error: actual - v.proj,
        spread: g?.spread ?? null, implied: g?.implied_points ?? null, spots, has_actual: v.actual != null });
      c.kept++;
    }
    c.spot_counts = Object.fromEntries(SPOTS.map(s => [s.id, rows.filter(r => r.season === season && r.spots[s.id]).length]));
    census[season] = c;
    log(season, JSON.stringify(c));
  }
  db.close();
  return { rows, census };
}

// ---------------------------------------------------------------- baseline + grade
export function baseline(rows) {
  const out = {};
  for (const s of SEASONS) {
    const rs = rows.filter(r => r.season === s);
    out[s] = { n: rs.length, mae_espn: mean(rs.map(r => Math.abs(r.error))), mean_error: mean(rs.map(r => r.error)),
      by_position: Object.fromEntries(['QB', 'RB', 'WR', 'TE'].map(p => {
        const x = rs.filter(r => r.position === p);
        return [p, { n: x.length, mae: mean(x.map(r => Math.abs(r.error))), mean_error: mean(x.map(r => r.error)) }];
      })) };
  }
  return out;
}

function preregCommitted() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  const committed = git('log', '-1', '--format=%H', '--', PREREG);
  if (!committed) throw new Error(`${PREREG} is not committed: commit the pre-registration before --grade`);
  if (git('status', '--porcelain', '--', PREREG)) throw new Error(`${PREREG} has uncommitted changes`);
  return committed;
}

export function grade(rows) {
  const spots = spotVerdicts(SPOTS.map(s => spotTest(rows, s)));
  const models = WALK_FORWARD.map(s => residualModel(rows, s));
  const deciding = models.filter(m => DECIDING.includes(m.test_season));
  const modelPass = deciding.length === DECIDING.length && deciding.every(m => m.beats_espn && m.pit_ok);
  return { spots, dropped_spots: DROPPED_SPOTS, models, verdict: {
    proven_spots: spots.filter(s => s.proven).map(s => s.id),
    dead_spots: [...spots.filter(s => !s.proven).map(s => s.id), ...DROPPED_SPOTS.map(d => d.id)],
    residual_model_counts: modelPass,
    status: spots.some(s => s.proven) || modelPass ? 'built' : 'declined' } };
}

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  const dbPath = arg('--db');
  if (!dbPath) throw new Error('--db <copy of the app database> is required');
  if (path.resolve(dbPath) === path.join(process.env.HOME ?? '', 'gridiron-local', 'data.sqlite')) throw new Error('refusing the live database: use a copy');
  const archiveDir = arg('--espn-archive') ?? DEFAULT_ARCHIVE;
  const log = (...a) => console.error(...a);
  const report = { unit: 'PROJ-01-a', label: 'local copy, not production', population: `ESPN projection >= ${MIN_ESPN}, QB/RB/WR/TE, weeks ${FIRST_WEEK}-${LAST_WEEK}`,
    tree: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() };
  if (process.argv.includes('--grade')) report.prereg_commit = preregCommitted();
  const { rows, census } = await assemble({ dbPath, archiveDir, log });
  report.census = census;
  report.baseline = baseline(rows);
  if (process.argv.includes('--grade')) Object.assign(report, grade(rows));
  const json = JSON.stringify(report, null, 2);
  const out = arg('--out');
  if (out) {
    if (path.resolve(out).startsWith(ROOT + path.sep) && !path.resolve(out).includes(`${path.sep}.local-db${path.sep}`)) throw new Error('--out inside the repo must be under .local-db/');
    fs.writeFileSync(out, json + '\n');
  }
  console.log(json);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
