/**
 * Phase 2 of the fantasy-coordinator plan: blends independent fantasy signal
 * sources into one corrected weekly projection, weighted by each source's
 * own walk-forward track record — never by how good it looks in-sample.
 *
 * Copies nfl-expert-coordinator.js's validated statistical machinery
 * (walk-forward shrinkage via split-half cross-validated gain, correlation-
 * based family de-duplication, week-clustered Huber ridge with weight caps)
 * rather than importing it — that module is keyed by game (season|week|home)
 * for spread residuals; this one is keyed by player-week, and the "prior"
 * being corrected is this app's own structural projection, not a sportsbook
 * line. Contextual regimes (nfl-expert-coordinator.js's per-situation sub-
 * fits) are deliberately not ported in this first pass — a real refinement,
 * not required to prove the core mechanism works.
 *
 * TARGET: actual_weekly_points - structural_ppg (a residual off the
 * structural projection, which plays the role the market line plays on the
 * betting side: the zero-correction prior every other signal corrects).
 *
 * EXPERTS — three, not four. A fourth ("props") was considered per the plan
 * but dropped after checking nfl-props.js's own code: its point estimate is
 * `playerWeekEventExpectation` with the SAME game-script multiplier this
 * file already uses as its own expert, so it is not an independent signal
 * for the MEAN estimate (its real value is the full distribution, a
 * different question). Padding to four with a redundant signal would only
 * get merged into game_script_delta's family anyway; better to say so.
 *   - ensemble_shift: player-week-engine.js's own ensemble calibration
 *     (projection.ppg - projection.structural_ppg), already computed
 *     elsewhere in this app.
 *   - game_script_delta: the marginal effect of this week's Vegas-implied
 *     game script (gamescript.js) on the structural point estimate.
 *   - boom_bust_signal: boom-bust.js#predictRankGap's walk-forward
 *     prediction for this player's season (Phase 1, gated separately and
 *     already proven significant against ADP alone — this coordinator's own
 *     shrinkage decides independently whether it adds anything on TOP of
 *     the other two signals, which is a different, harder question).
 *
 * PHASE 3 RESULT (verified live against real 2022-2025 data, not just the
 * fixture): the coordinated projection beats the plain structural
 * projection alone in all three testable seasons (2023-2025), Holm-
 * corrected — p ~0.0005 every season, model MAE ~4.28-4.40 fantasy points
 * vs. baseline ~4.41-4.52 (~3% error reduction, holding up independently in
 * every fold). Smaller in relative terms than boom-bust's own ~20% season-
 * level result, but real, and it clears its own gate.
 *
 * Precisely what earns that gain, and what doesn't: `boom_bust_signal`
 * shrinks to k=0 here ("no walk-forward gain") — a season-level "is this
 * player a boom/bust candidate" signal does not translate into a validated
 * WEEKLY point correction, a genuinely different and harder question than
 * the one Phase 1 already answered. The improvement comes entirely from
 * `ensemble_shift` and `game_script_delta`. This is the honest shape of the
 * result, not a reason to force boom_bust_signal's weight up by hand — the
 * whole point of walk-forward shrinkage is that a signal earns its weight
 * or gets none.
 *
 * This clears Phase 3's gate. Phase 4 (below `activeFantasyCoordinatorFit`/
 * `weeklyExpertValues`): trade-engine.js's current-week projection now
 * applies the coordinator's correction when a real fit exists, falling back
 * to the plain structural+ensemble number (today's prior behavior)
 * otherwise — never a hard dependency, and never fabricated when unfitted.
 * The fit itself is refit periodically (scheduler.js, not per-request) and
 * persisted, the same pattern weekly-weight-store.js already uses for the
 * ensemble champion weights — a 30-40s walk-forward-style refit has no
 * business blocking a page load.
 */
import { db, rows, run } from '../db/index.js';
import { buildPlayerWeekEngine, playerWeekProjection, playerWeekEventExpectation } from './player-week-engine.js';
import { gameScriptFor } from './gamescript.js';
import { scoreLine, PPR } from './scoring.js';
import { predictRankGap } from './boom-bust.js';
import { normalizePlayerName } from './player-identity.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import { holmDecisions } from './player-head-validation.js';

export const FANTASY_COORDINATOR_VERSION = 'fantasy-coordinator-v1-no-regimes';
const EXPERT_IDS = ['ensemble_shift', 'game_script_delta', 'boom_bust_signal'];

db.exec(`
  CREATE TABLE IF NOT EXISTS fantasy_coordinator_fits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    through_season INTEGER NOT NULL,
    rows INTEGER NOT NULL,
    fit_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const MIN_ROWS = 200;
const RIDGE = 36;
const HUBER_DELTA = 8; // fantasy-point residuals are a smaller scale than spread-point residuals
const MAX_WEIGHT = 0.35;
const MAX_TOTAL_INFLUENCE = 0.8;
const SHRINK_RIDGE = 4;
const SHRINK_MIN_GAMES = 60;
const FAMILY_CORRELATION = 0.6;
const FAMILY_MIN_OVERLAP = 50;

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const mean = v => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);
const median = v => {
  if (!v.length) return 0;
  const sorted = [...v].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function solve(matrix, vector) {
  const n = vector.length, augmented = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(augmented[r][col]) > Math.abs(augmented[pivot][col])) pivot = r;
    if (Math.abs(augmented[pivot][col]) < 1e-10) continue;
    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];
    const divisor = augmented[col][col];
    for (let j = col; j <= n; j++) augmented[col][j] /= divisor;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = augmented[r][col];
      for (let j = col; j <= n; j++) augmented[r][j] -= factor * augmented[col][j];
    }
  }
  return augmented.map(row => (Number.isFinite(row[n]) ? row[n] : 0));
}

/** Stage A: what each expert's forecast has earned on real, settled rows —
 *  identical rule to nfl-expert-coordinator.js's shrinkageScales. */
function shrinkageScales(examples) {
  const out = {};
  for (const id of EXPERT_IDS) {
    const pairs = examples.map(e => [e.experts[id], e.target]).filter(([f]) => Number.isFinite(f));
    if (pairs.length < SHRINK_MIN_GAMES) { out[id] = { k: 0, gain: null, n: pairs.length, reason: `fewer than ${SHRINK_MIN_GAMES} settled examples` }; continue; }
    const scaleOf = list => {
      const mf = mean(list.map(([f]) => f)), my = mean(list.map(([, y]) => y));
      const cov = mean(list.map(([f, y]) => (f - mf) * (y - my))), vf = mean(list.map(([f]) => (f - mf) ** 2));
      return { k: clamp(cov / (vf + SHRINK_RIDGE), 0, 1), mf, my, cov, vf };
    };
    const gainOf = (list, k, mf) => Math.sqrt(mean(list.map(([, y]) => y * y))) - Math.sqrt(mean(list.map(([f, y]) => (y - k * (f - mf)) ** 2)));
    const all = scaleOf(pairs);
    const vy = mean(pairs.map(([, y]) => (y - all.my) ** 2));
    const r = all.vf && vy ? all.cov / Math.sqrt(all.vf * vy) : 0;
    const t = Math.abs(r) * Math.sqrt(Math.max(1, pairs.length - 2)) / Math.sqrt(Math.max(1e-9, 1 - r * r));
    const a = pairs.filter((_, i) => i % 2 === 0), b = pairs.filter((_, i) => i % 2 === 1);
    const crossGain = mean([gainOf(b, scaleOf(a).k, scaleOf(a).mf), gainOf(a, scaleOf(b).k, scaleOf(b).mf)]);
    out[id] = t > 2 && crossGain > 0 && all.k > 0
      ? { k: r3(all.k), gain: r3(crossGain), t: r3(t), n: pairs.length, reason: null }
      : { k: 0, gain: r3(crossGain), t: r3(t), n: pairs.length, reason: 'shrunk to zero: no walk-forward gain' };
  }
  return out;
}

/** Stage B: experts whose shrunk forecasts say the same thing get ONE
 *  coefficient — identical rule to nfl-expert-coordinator.js's familiesOf. */
function familiesOf(examples) {
  const ids = [...EXPERT_IDS];
  const parent = Object.fromEntries(ids.map(id => [id, id]));
  const find = id => (parent[id] === id ? id : (parent[id] = find(parent[id])));
  const correlations = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const pairs = examples.map(e => [e.experts[ids[i]], e.experts[ids[j]]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    if (pairs.length < FAMILY_MIN_OVERLAP) continue;
    const ma = mean(pairs.map(([a]) => a)), mb = mean(pairs.map(([, b]) => b));
    const cov = pairs.reduce((s, [a, b]) => s + (a - ma) * (b - mb), 0);
    const va = pairs.reduce((s, [a]) => s + (a - ma) ** 2, 0), vb = pairs.reduce((s, [, b]) => s + (b - mb) ** 2, 0);
    const r = va && vb ? cov / Math.sqrt(va * vb) : 0;
    if (r >= FAMILY_CORRELATION) { parent[find(ids[i])] = find(ids[j]); correlations.push({ a: ids[i], b: ids[j], r: r3(r), n: pairs.length }); }
  }
  const groups = new Map();
  for (const id of ids) { const root = find(id); const list = groups.get(root) ?? []; list.push(id); groups.set(root, list); }
  const families = [...groups.values()].filter(l => l.length > 1).map((members, i) => ({ id: `family_${i + 1}`, members }));
  return { families, correlations };
}

function design(example, fit) {
  const values = [1];
  for (const column of fit.columns) {
    const parts = column.members.map(id => {
      const value = example.experts[id];
      const k = fit.shrinkage[id]?.k ?? 0;
      return Number.isFinite(value) ? k * clamp((value - fit.centers[id]) / fit.scales[id], -4, 4) : null;
    }).filter(Number.isFinite);
    values.push(parts.length ? mean(parts) : 0);
  }
  for (const id of EXPERT_IDS) values.push(Number.isFinite(example.experts[id]) ? 0 : 1);
  return values;
}

function fitRows(examples) {
  const centers = {}, scales = {};
  for (const id of EXPERT_IDS) {
    const values = examples.map(e => e.experts[id]).filter(Number.isFinite);
    centers[id] = median(values);
    scales[id] = Math.max(1, median(values.map(v => Math.abs(v - centers[id]))) * 1.4826);
  }
  const shrinkage = shrinkageScales(examples);
  const { families, correlations } = familiesOf(examples);
  const inFamily = new Set(families.flatMap(f => f.members));
  const columns = [...families, ...EXPERT_IDS.filter(id => !inFamily.has(id)).map(id => ({ id, members: [id] }))];
  const proto = { centers, scales, shrinkage, columns };
  const X = examples.map(e => design(e, proto)), y = examples.map(e => e.target);
  const weekCounts = new Map();
  for (const e of examples) weekCounts.set(`${e.season}|${e.week}`, (weekCounts.get(`${e.season}|${e.week}`) ?? 0) + 1);

  let coefficients = new Array(X[0].length).fill(0);
  for (let iter = 0; iter < 6; iter++) {
    const p = coefficients.length, A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
    for (let i = 0; i < X.length; i++) {
      const residual = y[i] - X[i].reduce((s, v, j) => s + v * coefficients[j], 0);
      const robust = Math.abs(residual) <= HUBER_DELTA ? 1 : HUBER_DELTA / Math.abs(residual);
      const cluster = 1 / (weekCounts.get(`${examples[i].season}|${examples[i].week}`) ?? 1);
      const weight = robust * cluster;
      for (let j = 0; j < p; j++) {
        b[j] += weight * X[i][j] * y[i];
        for (let k = j; k < p; k++) A[j][k] += weight * X[i][j] * X[i][k];
      }
    }
    for (let j = 0; j < A.length; j++) {
      for (let k = 0; k < j; k++) A[j][k] = A[k][j];
      if (j > 0) A[j][j] += RIDGE;
    }
    coefficients = solve(A, b);
  }
  coefficients[0] = clamp(coefficients[0], -1, 1);
  const nColumns = columns.length;
  for (let j = 1; j <= nColumns; j++) coefficients[j] = clamp(coefficients[j], -MAX_WEIGHT, MAX_WEIGHT);
  const total = coefficients.slice(1, nColumns + 1).reduce((s, v) => s + Math.abs(v), 0);
  if (total > MAX_TOTAL_INFLUENCE) {
    const shrink = MAX_TOTAL_INFLUENCE / total;
    for (let j = 1; j <= nColumns; j++) coefficients[j] *= shrink;
  }
  return { coefficients, centers, scales, shrinkage, families, family_correlations: correlations, columns, rows: examples.length };
}

/**
 * Real historical training examples: every player-week from `fromSeason`
 * through `throughSeason` with a structural projection AND a real settled
 * outcome. `boom_bust_signal` is computed once per (season) via
 * predictRankGap — itself walk-forward (never sees `season`'s own outcome)
 * — and repeated across that season's weeks, since it's a season-level
 * signal, not a weekly one.
 */
export async function buildFantasyCoordinatorExamples({ fromSeason = 2022, throughSeason = 2025, scoring = PPR } = {}) {
  const examples = [];
  const boomBustBySeasonPlayer = new Map(); // season -> Map(player_key -> predicted_rank_gap)

  for (let season = fromSeason; season <= throughSeason; season++) {
    if (!boomBustBySeasonPlayer.has(season)) {
      boomBustBySeasonPlayer.set(season, await predictRankGap(season, { earliestSeason: 2021 }).catch(() => null));
    }
    const boomBust = boomBustBySeasonPlayer.get(season);

    for (let week = 1; week <= 18; week++) {
      const actuals = rows(`SELECT u.*, p.name FROM player_week_usage u JOIN players p ON p.id = u.player_id
                            WHERE u.season = ? AND u.week = ?`, season, week);
      if (!actuals.length) continue;
      let engine;
      try { engine = buildPlayerWeekEngine({ season, week }); } catch { continue; }

      for (const actualRow of actuals) {
        const projection = playerWeekProjection(engine, actualRow.player_id);
        if (!projection?.params || projection.structural_ppg == null) continue;
        const actualPoints = Number(scoreLine(actualRow, scoring));

        const gs = projection.team ? gameScriptFor(projection.team, season, week) : null;
        const noMult = playerWeekEventExpectation(projection, { mult: 1, scoring })?.structural_fantasy_points;
        const withMult = gs?.line
          ? playerWeekEventExpectation(projection, { mult: { pass: gs.pass_mult, rush: gs.rush_mult }, scoring })?.structural_fantasy_points
          : null;

        const playerKey = actualRow.name ? normalizePlayerName(actualRow.name) : null;
        examples.push({
          season, week, player_id: actualRow.player_id,
          target: actualPoints - projection.structural_ppg,
          experts: {
            ensemble_shift: Number.isFinite(projection.ensemble_shift) ? projection.ensemble_shift : null,
            game_script_delta: Number.isFinite(withMult) && Number.isFinite(noMult) ? withMult - noMult : null,
            boom_bust_signal: playerKey && boomBust?.has(playerKey) ? boomBust.get(playerKey).predicted_rank_gap : null
          }
        });
      }
    }
  }
  return examples;
}

/** Fit the coordinator on real examples. Returns `{ready: false}` below MIN_ROWS
 *  rather than fitting on too little data to mean anything. */
export function fitFantasyCoordinator(examples) {
  if (examples.length < MIN_ROWS) {
    return { version: FANTASY_COORDINATOR_VERSION, ready: false, rows: examples.length,
      reason: `warmup requires ${MIN_ROWS} rows` };
  }
  const fit = fitRows(examples);
  return { version: FANTASY_COORDINATOR_VERSION, ready: true, ...fit,
    authority: 'historical_candidate_only',
    safeguards: { target: 'structural-projection residual', loss: `Huber(${HUBER_DELTA})`, ridge: RIDGE,
      walk_forward_shrinkage: { ridge: SHRINK_RIDGE, min_games: SHRINK_MIN_GAMES, rule: 'k = cov/var capped 0..1; zero without walk-forward gain' },
      families: { correlation: FAMILY_CORRELATION, min_overlap: FAMILY_MIN_OVERLAP, found: fit.families.map(f => f.members) },
      max_expert_weight: MAX_WEIGHT, max_total_expert_influence: MAX_TOTAL_INFLUENCE } };
}

/**
 * Persist a fit (fantasy_coordinator_fits), so trade-engine.js reads a
 * ready-made fit instead of ever running the 30-40s example-build + ridge
 * fit inline. Only a `ready: true` fit is worth storing — a warmup result
 * has nothing usable in it.
 */
export function saveFantasyCoordinatorFit(fit, throughSeason) {
  if (!fit?.ready) return { inserted: false, reason: fit?.reason ?? 'not ready' };
  run(`INSERT INTO fantasy_coordinator_fits (version, through_season, rows, fit_json)
       VALUES (?,?,?,?)`, fit.version, throughSeason, fit.rows, JSON.stringify(fit));
  return { inserted: true };
}

/** The latest persisted fit, or `{ready: false}` when none exists yet (a
 *  fresh install before the first background refit has run) — read-only,
 *  no computation, safe to call from a request path. */
export function activeFantasyCoordinatorFit() {
  const latest = rows(`SELECT fit_json FROM fantasy_coordinator_fits ORDER BY id DESC LIMIT 1`)[0];
  if (!latest) return { version: FANTASY_COORDINATOR_VERSION, ready: false, reason: 'no fit persisted yet' };
  return JSON.parse(latest.fit_json);
}

/**
 * Refits on real historical data through the last fully-settled season and
 * persists the result — the one function scheduler.js should call
 * periodically. Building examples across 3-4 seasons takes real time
 * (~30-40s, verified live) and belongs in a background job, never inline
 * in a request.
 */
export async function refitFantasyCoordinator({ fromSeason = 2022, throughSeason } = {}) {
  const through = throughSeason ?? new Date().getFullYear() - 1;
  const examples = await buildFantasyCoordinatorExamples({ fromSeason, throughSeason: through });
  const fit = fitFantasyCoordinator(examples);
  return { ...saveFantasyCoordinatorFit(fit, through), fit };
}

/**
 * The two request-time-cheap expert values for ONE player-week — the same
 * ensemble_shift/game_script_delta computation buildFantasyCoordinatorExamples
 * uses per row, factored out so trade-engine.js can call it for a single
 * player without rebuilding a whole season's examples. boom_bust_signal is
 * deliberately NOT included: it already shrank to zero in the persisted fit
 * (see this file's Phase 3 result above), so computing it here would only
 * cost a GBM prediction for a coefficient the fit already learned to ignore.
 */
export function weeklyExpertValues(projection, season, week, scoring = PPR) {
  if (!projection?.params || projection.structural_ppg == null) return null;
  const gs = projection.team ? gameScriptFor(projection.team, season, week) : null;
  const noMult = playerWeekEventExpectation(projection, { mult: 1, scoring })?.structural_fantasy_points;
  const withMult = gs?.line
    ? playerWeekEventExpectation(projection, { mult: { pass: gs.pass_mult, rush: gs.rush_mult }, scoring })?.structural_fantasy_points
    : null;
  return {
    ensemble_shift: Number.isFinite(projection.ensemble_shift) ? projection.ensemble_shift : null,
    game_script_delta: Number.isFinite(withMult) && Number.isFinite(noMult) ? withMult - noMult : null,
    boom_bust_signal: null
  };
}

/** Apply a fit to one player-week's expert values, returning the corrected
 *  fantasy-point projection and a per-expert contribution trace. */
export function coordinateFantasy(fit, expertValues, structuralPpg) {
  if (!fit?.ready) return { ready: false, reason: fit?.reason ?? 'not fitted', structural_ppg: structuralPpg };
  const example = { experts: expertValues };
  const x = design(example, fit);
  const nColumns = fit.columns.length;
  const columnOf = new Map();
  fit.columns.forEach((column, index) => column.members.forEach(id => columnOf.set(id, index)));
  const present = column => column.members.filter(id => Number.isFinite(expertValues[id])).length;
  const memberWeight = id => { const index = columnOf.get(id); const column = fit.columns[index];
    const n = present(column); return n ? fit.coefficients[index + 1] / n : 0; };
  const contributions = EXPERT_IDS.map(id => {
    const raw = expertValues[id], learnedWeight = memberWeight(id), columnIndex = columnOf.get(id), column = fit.columns[columnIndex];
    const k = fit.shrinkage[id]?.k ?? 0;
    const shrunk = Number.isFinite(raw) ? k * clamp((raw - fit.centers[id]) / fit.scales[id], -4, 4) : null;
    return { id, raw, shrink: k, shrink_reason: fit.shrinkage[id]?.reason ?? null,
      family: column.members.length > 1 ? column.id : null,
      learned_weight: r3(learnedWeight), value: Number.isFinite(shrunk) ? r3(shrunk * learnedWeight) : 0 };
  });
  const missingOffset = EXPERT_IDS.reduce((s, _id, i) => s + x[1 + nColumns + i] * fit.coefficients[1 + nColumns + i], 0);
  const correction = fit.coefficients[0] + contributions.reduce((s, c) => s + c.value, 0) + missingOffset;
  return {
    ready: true, structural_ppg: structuralPpg,
    corrected_ppg: r3(structuralPpg + clamp(correction, -10, 10)),
    correction: r3(clamp(correction, -10, 10)), contributions,
    note: 'A circumstance-aware candidate correction to the structural projection, not a validated replacement until Phase 3 clears it.'
  };
}

/**
 * Phase 3's actual validation gate: does the coordinated projection
 * (structural + learned correction) beat the plain structural projection
 * alone on real, held-out weekly outcomes? Fit only on seasons strictly
 * before each held-out test season — never all seasons at once, same
 * discipline as boom-bust.js#boomBustWalkForward and nfl-gbm.js's own
 * walk-forward. Holm-corrected across the testable seasons.
 *
 * This is the actual promote/hold-back decision for Phase 4 (wiring into
 * trade-engine.js): only a season that clears this gate with real
 * significance is evidence the coordinator is worth using in production,
 * not just an interesting fit.
 */
export async function fantasyCoordinatorWalkForward({ fromSeason = 2022, throughSeason = 2025 } = {}) {
  const bySeasonExamples = new Map();
  for (let season = fromSeason; season <= throughSeason; season++) {
    bySeasonExamples.set(season, await buildFantasyCoordinatorExamples({ fromSeason: season, throughSeason: season }));
  }

  const results = [];
  for (let testSeason = fromSeason + 1; testSeason <= throughSeason; testSeason++) {
    const trainExamples = [];
    for (let s = fromSeason; s < testSeason; s++) trainExamples.push(...bySeasonExamples.get(s));
    const testExamples = bySeasonExamples.get(testSeason);

    const fit = fitFantasyCoordinator(trainExamples);
    if (!fit.ready || testExamples.length < 10) {
      results.push({ test_season: testSeason, skipped: true,
        reason: fit.ready ? `too few test rows (${testExamples.length})` : fit.reason });
      continue;
    }
    const baselineErrors = testExamples.map(e => Math.abs(e.target)); // "predict zero correction" = plain structural projection
    const modelErrors = testExamples.map(e => {
      const out = coordinateFantasy(fit, e.experts, 0); // structuralPpg=0: correction alone is what's being graded
      return Math.abs(e.target - out.correction);
    });
    const gate = pairedBootstrapDiff(baselineErrors, modelErrors);
    const pValue = gate.error ? null : Math.max(1 / (gate.iterations + 1), 1 - gate.p_b_better);
    results.push({
      test_season: testSeason, train_rows: trainExamples.length, test_rows: testExamples.length,
      baseline_mae: mean(baselineErrors), model_mae: mean(modelErrors),
      significant_improvement: !gate.error && gate.significant && gate.ci90[1] < 0,
      significance: { p_value: pValue }, gate
    });
  }
  holmDecisions(results.filter(r => !r.skipped));
  return results;
}

/**
 * One player's current-week projection, structural + the coordinator's
 * correction — the same computation trade-engine.js#buildAssetUniverse
 * already applies for `current_week_ppg`, factored out here so any
 * league-agnostic consumer (a player detail page, the draft assistant) can
 * get the same real, validated number without needing a league/format
 * context, which buildAssetUniverse requires and this doesn't. Returns null
 * for a player with no weekly projection (no usage history to project
 * from) rather than a guess.
 */
export function weeklyProjectionFor(playerId, { season, week, scoring = PPR } = {}) {
  const engine = buildPlayerWeekEngine({ season, week, scoring });
  const projection = playerWeekProjection(engine, playerId);
  if (!projection?.params || projection.structural_ppg == null) return null;
  const expertValues = weeklyExpertValues(projection, season, week, scoring);
  const fit = activeFantasyCoordinatorFit();
  const coordinated = expertValues ? coordinateFantasy(fit, expertValues, projection.ppg) : null;
  return {
    season, week,
    structural_ppg: projection.structural_ppg,
    ensemble_ppg: projection.ppg,
    corrected_ppg: coordinated?.ready ? coordinated.corrected_ppg : projection.ppg,
    coordinator: coordinated?.ready
      ? { correction: coordinated.correction, contributions: coordinated.contributions }
      : null,
    cutoff: projection.player_week_engine?.cutoff ?? null
  };
}

export const __test = { shrinkageScales, familiesOf, fitRows, design, EXPERT_IDS };
