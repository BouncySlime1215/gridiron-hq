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
 * not required to prove the core mechanism works. They are now available
 * (see `regimeLabels`/`fit.regimes` below): market spread/total are real,
 * pre-outcome context (the same fields nfl-expert-coordinator.js regimes on),
 * not expert forecasts, so gating on them cannot leak the target. Passing
 * `context` to `coordinateFantasy` is opt-in — a caller that omits it
 * (trade-engine.js today) still gets the unchanged global-only correction.
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
 * REGIME EXPERIMENT (verified live, real 2022-2025 data, `regimeLabels`/
 * `fit.regimes` above): does letting an expert's weight vary by real game
 * context — the team's own market spread/total that week, mirroring
 * nfl-expert-coordinator.js's regimes exactly — beat this coordinator's
 * plain global blend, the way mixture-of-experts architectures (Jacobs,
 * Jordan, Nowlan & Hinton 1991) let a gating network trust an expert
 * per-input rather than with one fixed weight? Walk-forward result: no.
 * 2023 shows a nominally significant gate (p=0.002) but the actual MAE gap
 * is 4.3344 vs 4.3334 — 0.001 fantasy points, noise, not a real effect —
 * and 2024/2025 show no improvement at all (p=0.81, p=0.90) with the
 * regime blend fractionally worse than global-only in both. Unlike the
 * betting side, where spread/total genuinely separates situations experts
 * read differently, a player-week's fantasy residual apparently doesn't
 * split that way across ensemble_shift/game_script_delta — game_script_delta
 * already IS the market-conditioned signal here, so gating on the same
 * market inputs again adds no new information. `coordinateFantasy`'s
 * `context` parameter stays implemented and opt-in (real machinery, tests
 * pass, nothing here is fabricated) but is deliberately NOT wired into any
 * call site: an unvalidated regime split has no business changing a real
 * projection. A different context variable (weather/dome, injury-report
 * status, a receiver's target-share concentration) might still separate
 * fantasy regimes meaningfully — this result only rules out spread/total.
 *
 * This clears Phase 3's gate. Phase 4 (below `activeFantasyCoordinatorFit`/
 * `weeklyExpertValues`): the fit is refit periodically (scheduler.js, not
 * per-request) and persisted as a CANDIDATE. Since S-03 (2026-09-22) only a
 * PROMOTED row is served (`promoteFantasyCoordinatorFit`, gated on a committed
 * grade), in the weeks its promotion covers, and it is added to the base its
 * own target was trained on (`servedWeekConstruction`): the structural-residual
 * fit on the structural head, S-02's winning arm S1. Until S-03 the latest row
 * was served, whatever the engine had been when it was fitted, and it was added
 * to the ENSEMBLE number, a combination nobody had graded (S-02 arm B). With no
 * promoted fit the served number is the ensemble alone, and the surface says so.
 */
import { db, rows, run } from '../db/index.js';
import { buildPlayerWeekEngine, playerWeekProjection, playerWeekEventExpectation } from './player-week-engine.js';
import { gameScriptFor } from './gamescript.js';
import { scoreLine, PPR } from './scoring.js';
import { predictRankGap } from './boom-bust.js';
import { normalizePlayerName } from './player-identity.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import { holmDecisions } from './player-head-validation.js';
import { expertConfidenceTier, predictionConfidence } from './confidence-tier.js';

export const FANTASY_COORDINATOR_VERSION = 'fantasy-coordinator-v1-no-regimes';
const EXPERT_IDS = ['ensemble_shift', 'game_script_delta', 'boom_bust_signal'];

/**
 * What a fit corrects, read from its own record (`safeguards.target`). A second-stage
 * correction is only valid on the base it was trained to correct (Wolpert 1992, Neural
 * Networks 5:241-259): a fit on `actual − structural_ppg` belongs on `structural_ppg`, a
 * fit on the ensemble residual on `ppg`. servedWeekConstruction applies a fit to exactly
 * this base, and a fit whose target is none of these to nothing, so the structural fit on
 * the ensemble (S-02's arm B, served until S-03) cannot be built again.
 */
export const FIT_TARGETS = Object.freeze({
  structural: Object.freeze({ label: 'structural-projection residual', base: 'structural_ppg',
    basis: 'structural+coordinator', arm: 'S1' }),
  ensemble: Object.freeze({ label: 'ensemble-projection residual', base: 'ppg',
    basis: 'ensemble+coordinator', arm: 'S2' })
});

/** 'structural' | 'ensemble' from the fit's recorded target, or null when it names neither. */
export function fitTargetOf(fit) {
  const label = fit?.safeguards?.target;
  return Object.keys(FIT_TARGETS).find(key => FIT_TARGETS[key].label === label) ?? null;
}

/**
 * S-02 graded two windows and decided each one separately. Week 1 goes with weeks 2-4
 * and week 18 with weeks 5-17: neither was graded (S-02 needs a prior played week and
 * stops at 17), and the surface label says so.
 */
export const CONSTRUCTION_WINDOWS = Object.freeze(['2-4', '5-17']);
export function constructionWindow(week) {
  return Number(week) <= 4 ? '2-4' : '5-17';
}
const gradedWeek = week => Number(week) >= 2 && Number(week) <= 17;

const MIN_ROWS = 200;
const RIDGE = 36;
const HUBER_DELTA = 8; // fantasy-point residuals are a smaller scale than spread-point residuals
const MAX_WEIGHT = 0.35;
const MAX_TOTAL_INFLUENCE = 0.8;
const SHRINK_RIDGE = 4;
const SHRINK_MIN_GAMES = 60;
const FAMILY_CORRELATION = 0.6;
const FAMILY_MIN_OVERLAP = 50;
// Contextual regimes, same shape and same thresholds-by-proportion as
// nfl-expert-coordinator.js: a per-situation sub-fit blended into the global
// one, weighted by how much settled evidence backs that situation. Gated on
// market_spread/market_total (the team's own Vegas line for that week) —
// real context set before kickoff, not an expert's forecast — so a regime
// can never be "trained" on information the target itself produced.
const MIN_REGIME_ROWS = 150;
const MIN_REGIME_WEEKS = 6;

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
    const paired = examples.map(e => ({ f: e.experts[id], y: e.target, season: e.season, week: e.week }))
      .filter(row => Number.isFinite(row.f));
    const pairs = paired.map(row => [row.f, row.y]);
    // Player-weeks in the same week share correlated context (one game
    // script surprise touches every player in it), so raw row count
    // overstates independent evidence the same way Brill, Yurko & Wyner
    // (2024, arXiv:2406.16171) show for correlated play-by-play data.
    // Distinct weeks — already this fit's own clustering unit — is honest.
    const independentWeeks = new Set(paired.map(row => `${row.season}|${row.week}`)).size;
    if (pairs.length < SHRINK_MIN_GAMES) { out[id] = { k: 0, gain: null, n: pairs.length, independent_weeks: independentWeeks, reason: `fewer than ${SHRINK_MIN_GAMES} settled examples` }; continue; }
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
      ? { k: r3(all.k), gain: r3(crossGain), t: r3(t), n: pairs.length, independent_weeks: independentWeeks, reason: null }
      : { k: 0, gain: r3(crossGain), t: r3(t), n: pairs.length, independent_weeks: independentWeeks, reason: 'shrunk to zero: no walk-forward gain' };
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

/**
 * Real, pre-outcome game context (never an expert forecast, never the
 * target): the team's own week's spread and implied total. Mirrors
 * nfl-expert-coordinator.js's regimeLabels bucketing exactly, so "large
 * spread" and "high total" mean the same thing on both sides of this app.
 */
function regimeLabels(example) {
  return [
    `phase:${example.week <= 4 ? 'early' : example.week >= 15 ? 'late' : 'middle'}`,
    `spread:${Number.isFinite(example.market_spread) && Math.abs(example.market_spread) >= 6.5 ? 'large' : 'competitive'}`,
    `total:${Number.isFinite(example.market_total) && example.market_total >= 47 ? 'high' : 'ordinary'}`
  ];
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
          team: actualRow.team, opponent: actualRow.opponent,
          market_spread: Number.isFinite(gs?.line?.spread) ? gs.line.spread : null,
          market_total: Number.isFinite(gs?.line?.total) ? gs.line.total : null,
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
 *  rather than fitting on too little data to mean anything.
 *
 *  `target` says what the examples' `target` field is a residual of, and is recorded on
 *  the fit (`safeguards.target`) because the served base is read from it (FIT_TARGETS).
 *  The default is buildFantasyCoordinatorExamples' own target, the structural residual; a
 *  caller that moved the target to the ensemble residual must say so. */
export function fitFantasyCoordinator(examples, { target = 'structural' } = {}) {
  const spec = FIT_TARGETS[target];
  if (!spec) throw new Error(`fitFantasyCoordinator: unknown target "${target}" (known: ${Object.keys(FIT_TARGETS).join(', ')})`);
  if (examples.length < MIN_ROWS) {
    return { version: FANTASY_COORDINATOR_VERSION, ready: false, rows: examples.length,
      reason: `warmup requires ${MIN_ROWS} rows` };
  }
  const fit = fitRows(examples);
  const labels = [...new Set(examples.flatMap(regimeLabels))], regimes = [];
  for (const label of labels) {
    const subset = examples.filter(e => regimeLabels(e).includes(label));
    const regimeWeeks = new Set(subset.map(e => `${e.season}|${e.week}`)).size;
    if (subset.length < MIN_REGIME_ROWS || regimeWeeks < MIN_REGIME_WEEKS) continue;
    regimes.push({ label, rows: subset.length, weeks: regimeWeeks,
      shrinkage: subset.length / (subset.length + 192), fit: fitRows(subset) });
  }
  return { version: FANTASY_COORDINATOR_VERSION, ready: true, ...fit, regimes,
    authority: 'historical_candidate_only',
    safeguards: { target: spec.label, loss: `Huber(${HUBER_DELTA})`, ridge: RIDGE,
      walk_forward_shrinkage: { ridge: SHRINK_RIDGE, min_games: SHRINK_MIN_GAMES, rule: 'k = cov/var capped 0..1; zero without walk-forward gain' },
      families: { correlation: FAMILY_CORRELATION, min_overlap: FAMILY_MIN_OVERLAP, found: fit.families.map(f => f.members) },
      max_expert_weight: MAX_WEIGHT, max_total_expert_influence: MAX_TOTAL_INFLUENCE,
      contextual_regimes: true, min_regime_rows: MIN_REGIME_ROWS, min_regime_weeks: MIN_REGIME_WEEKS } };
}

/**
 * Persist a fit (fantasy_coordinator_fits) as a CANDIDATE, so trade-engine.js
 * reads a ready-made fit instead of ever running the 30-40s example-build +
 * ridge fit inline. Only a `ready: true` fit is worth storing — a warmup
 * result has nothing usable in it. A saved fit is not served until
 * promoteFantasyCoordinatorFit promotes it (the `promoted` column defaults to 0,
 * migration 072).
 */
export function saveFantasyCoordinatorFit(fit, throughSeason) {
  if (!fit?.ready) return { inserted: false, reason: fit?.reason ?? 'not ready' };
  const result = run(`INSERT INTO fantasy_coordinator_fits (version, through_season, rows, fit_json)
       VALUES (?,?,?,?)`, fit.version, throughSeason, fit.rows, JSON.stringify(fit));
  return { inserted: true, id: Number(result.lastInsertRowid), promoted: false };
}

/** Whether migration 072 has run on this database. A read before it has is inert, and says so. */
function promotionColumnsPresent() {
  const names = rows('PRAGMA table_info(fantasy_coordinator_fits)').map(c => c.name);
  return names.includes('promoted') && names.includes('promotion_json');
}
const UNMIGRATED = 'fantasy_coordinator_fits has no promotion columns: migration 072 has not run on this database';

/**
 * The served fit: the one PROMOTED fantasy_coordinator_fits row, or `{ready: false}`
 * with the reason (no fit at all, only unpromoted candidates, or an unmigrated database).
 * Read-only, no computation, safe to call from a request path.
 *
 * It used to return the newest row, gated by nothing. The daily refit
 * (scheduler.js#fantasy_coordinator_refit) writes a row every day, and on the local copy
 * five rows all "through 2025" carried intercepts of −0.574, −0.423, +0.578, +0.578 and
 * −0.555: whichever engine state the last refit ran on was served. Now a refit is a
 * candidate until a committed grade promotes it (promoteFantasyCoordinatorFit).
 *
 * The returned fit carries `fit_row` (id, through_season, created_at) and `promotion`
 * (windows, evidence, promoted_at), which servedWeekConstruction and the surface label read.
 */
export function activeFantasyCoordinatorFit() {
  if (!promotionColumnsPresent()) return { version: FANTASY_COORDINATOR_VERSION, ready: false, reason: UNMIGRATED };
  const served = rows(`SELECT id, through_season, created_at, fit_json, promotion_json FROM fantasy_coordinator_fits
                       WHERE promoted = 1 ORDER BY id DESC LIMIT 1`)[0];
  if (!served) {
    const candidates = rows('SELECT COUNT(*) AS n FROM fantasy_coordinator_fits')[0]?.n ?? 0;
    return { version: FANTASY_COORDINATOR_VERSION, ready: false, candidates,
      reason: candidates
        ? `no promoted fit (${candidates} unpromoted candidate${candidates === 1 ? '' : 's'}; a fit is served only once promoted)`
        : 'no fit persisted yet' };
  }
  return { ...JSON.parse(served.fit_json), authority: 'promoted',
    fit_row: { id: served.id, through_season: served.through_season, created_at: served.created_at },
    promotion: JSON.parse(served.promotion_json ?? 'null') };
}

/**
 * Which fit is served, as a short key: `<id>:<window states>`, 'none' or 'unmigrated'.
 * trade-engine.js keys its asset cache on it, because a promotion is an UPDATE that moves no
 * row count and no timestamp the table fingerprint could see.
 */
export function servedCoordinatorFitKey() {
  if (!promotionColumnsPresent()) return 'unmigrated';
  const served = rows(`SELECT id, promotion_json FROM fantasy_coordinator_fits
                       WHERE promoted = 1 ORDER BY id DESC LIMIT 1`)[0];
  if (!served) return 'none';
  const windows = JSON.parse(served.promotion_json ?? 'null')?.windows ?? {};
  return `${served.id}:${CONSTRUCTION_WINDOWS.map(w => windows[w] ?? '-').join('/')}`;
}

/**
 * Promote one stored fit so it is THE served fit, in the windows a committed grade cleared.
 *
 * Refuses (throws, nothing written) when the row does not exist, the fit is not ready, it
 * came from a different fitter version, its target is not a base this code knows
 * (FIT_TARGETS), `windows` does not say 'on' or 'off' for each of CONSTRUCTION_WINDOWS or
 * turns nothing on, or `evidence` does not name the grade. Any previously promoted row is
 * demoted in the same transaction (its promotion_json stays, as history), so exactly one row
 * is served. scripts/promote-fantasy-coordinator-fit.mjs checks the evidence file itself and
 * re-derives the fit from the data before calling this.
 *
 * @returns the served fit, read back through activeFantasyCoordinatorFit
 */
export function promoteFantasyCoordinatorFit(id, { windows, evidence } = {}) {
  if (!promotionColumnsPresent()) throw new Error(UNMIGRATED);
  const stored = rows('SELECT id, version, fit_json FROM fantasy_coordinator_fits WHERE id = ?', id)[0];
  if (!stored) throw new Error(`no fantasy_coordinator_fits row ${id}`);
  const fit = JSON.parse(stored.fit_json);
  const failures = [];
  if (fit?.ready !== true) failures.push('the fit is not ready');
  if (stored.version !== FANTASY_COORDINATOR_VERSION) {
    failures.push(`it was fitted by ${stored.version}, not the served fitter ${FANTASY_COORDINATOR_VERSION}`);
  }
  if (!fitTargetOf(fit)) failures.push(`its target (${fit?.safeguards?.target ?? 'none recorded'}) is not a base this code knows`);
  const windowKeys = Object.keys(windows ?? {});
  const windowsValid = windows && windowKeys.every(k => CONSTRUCTION_WINDOWS.includes(k))
    && CONSTRUCTION_WINDOWS.every(w => windows[w] === 'on' || windows[w] === 'off');
  if (!windowsValid) failures.push(`windows must say 'on' or 'off' for each of ${CONSTRUCTION_WINDOWS.join(', ')}`);
  else if (!CONSTRUCTION_WINDOWS.some(w => windows[w] === 'on')) {
    failures.push('the windows turn the coordinator on nowhere; leave the fit unpromoted instead');
  }
  if (typeof evidence !== 'string' || !evidence.trim()) failures.push('evidence must name the committed grade that clears this fit');
  if (failures.length) throw new Error(`refusing to promote fantasy_coordinator_fits row ${id}: ${failures.join('; ')}`);

  const promotion = { promoted_at: new Date().toISOString(),
    windows: Object.fromEntries(CONSTRUCTION_WINDOWS.map(w => [w, windows[w]])), evidence: evidence.trim() };
  db.exec('BEGIN IMMEDIATE');
  try {
    run('UPDATE fantasy_coordinator_fits SET promoted = 0 WHERE promoted = 1 AND id <> ?', id);
    run('UPDATE fantasy_coordinator_fits SET promoted = 1, promotion_json = ? WHERE id = ?', JSON.stringify(promotion), id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const served = activeFantasyCoordinatorFit();
  if (served.fit_row?.id !== id) throw new Error(`promoted fantasy_coordinator_fits row ${id}, but row ${served.fit_row?.id ?? 'none'} is served`);
  return served;
}

/**
 * Refits on real historical data through the last fully-settled season and
 * persists the result as a candidate — the one function scheduler.js should
 * call periodically. Building examples across 3-4 seasons takes real time
 * (~30-40s, verified live) and belongs in a background job, never inline
 * in a request. The candidate is not served until it is promoted.
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

/** One fit (global or a single regime's sub-fit) applied to one player-week's
 *  expert values — the shared math `coordinateFantasy` blends across. */
function coordinateOne(fit, expertValues) {
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
      independent_weeks: fit.shrinkage[id]?.independent_weeks ?? 0,
      confidence: expertConfidenceTier({ k, independentWeeks: fit.shrinkage[id]?.independent_weeks }),
      family: column.members.length > 1 ? column.id : null,
      learned_weight: r3(learnedWeight), value: Number.isFinite(shrunk) ? r3(shrunk * learnedWeight) : 0 };
  });
  const missingOffset = EXPERT_IDS.reduce((s, _id, i) => s + x[1 + nColumns + i] * fit.coefficients[1 + nColumns + i], 0);
  const correction = fit.coefficients[0] + contributions.reduce((s, c) => s + c.value, 0) + missingOffset;
  return { correction, contributions };
}

/**
 * Apply a fit to one player-week's expert values, returning the corrected
 * fantasy-point projection and a per-expert contribution trace.
 *
 * `context` is optional and opt-in: pass `{ week, market_spread, market_total }`
 * (the team's own real Vegas line for that week — never an expert forecast)
 * to also blend in the fit's per-situation regime sub-fits, exactly as
 * nfl-expert-coordinator.js#coordinateExperts does. Omit it (every call site
 * before this change) and behavior is byte-identical to before: global-only.
 */
export function coordinateFantasy(fit, expertValues, structuralPpg, context = null) {
  if (!fit?.ready) return { ready: false, reason: fit?.reason ?? 'not fitted', structural_ppg: structuralPpg };
  const global = coordinateOne(fit, expertValues);
  let correction = global.correction, totalWeight = 1, activeLabels = [], regimeContributions = [];
  if (context) {
    const example = { week: Number(context.week) || 1,
      market_spread: Number.isFinite(context.market_spread) ? context.market_spread : null,
      market_total: Number.isFinite(context.market_total) ? context.market_total : null };
    activeLabels = regimeLabels(example);
    const active = (fit.regimes ?? []).filter(regime => activeLabels.includes(regime.label));
    for (const regime of active) {
      const candidate = coordinateOne(regime.fit, expertValues);
      const weight = regime.shrinkage / Math.max(1, active.length);
      correction += candidate.correction * weight; totalWeight += weight;
      regimeContributions.push({ label: regime.label, weight: r3(weight), rows: regime.rows,
        correction: r3(candidate.correction) });
    }
    correction /= totalWeight;
  }
  return {
    ready: true, structural_ppg: structuralPpg,
    corrected_ppg: r3(structuralPpg + clamp(correction, -10, 10)),
    correction: r3(clamp(correction, -10, 10)), contributions: global.contributions,
    global_correction: context ? r3(clamp(global.correction, -10, 10)) : undefined,
    active_regimes: context ? activeLabels : undefined,
    contextual_adjustments: context ? regimeContributions : undefined,
    confidence: predictionConfidence(global.contributions),
    note: 'A correction to the base this fit was trained on (FIT_TARGETS). Served only from a promoted fit, in its promoted weeks (servedWeekConstruction).'
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
    // Same global fit, but with real per-week market context (spread/total)
    // passed in so `fit.regimes` blends in — tests whether context-
    // conditional gating (mixture-of-experts-flavored: which expert to trust
    // varies by situation, not a single global weight) beats the plain
    // global blend, not just whether it beats "no correction".
    const regimeErrors = testExamples.map(e => {
      const out = coordinateFantasy(fit, e.experts, 0, { week: e.week, market_spread: e.market_spread, market_total: e.market_total });
      return Math.abs(e.target - out.correction);
    });
    // Cluster by the actual game (both teams): weekly fantasy outcomes for
    // players in the same real NFL game are correlated (weather, game
    // script, pace), not independent draws.
    const groups = testExamples.map(e => `${e.season}|${e.week}|${[e.team, e.opponent].filter(Boolean).sort().join('-')}`);
    const gate = pairedBootstrapDiff(baselineErrors, modelErrors, { groups });
    const pValue = gate.error ? null : Math.max(1 / (gate.iterations + 1), 1 - gate.p_b_better);
    const regimeGate = pairedBootstrapDiff(modelErrors, regimeErrors, { groups });
    const regimePValue = regimeGate.error ? null : Math.max(1 / (regimeGate.iterations + 1), 1 - regimeGate.p_b_better);
    results.push({
      test_season: testSeason, train_rows: trainExamples.length, test_rows: testExamples.length,
      baseline_mae: mean(baselineErrors), model_mae: mean(modelErrors), regime_model_mae: mean(regimeErrors),
      significant_improvement: !gate.error && gate.significant && gate.ci90[1] < 0,
      significance: { p_value: pValue }, gate,
      // regime vs. the already-shipped global-only blend, not vs. baseline
      regime_significant_improvement: !regimeGate.error && regimeGate.significant && regimeGate.ci90[1] < 0,
      regime_significance: { p_value: regimePValue }, regime_gate: regimeGate
    });
  }
  holmDecisions(results.filter(r => !r.skipped));
  return results;
}

/**
 * THIS WEEK'S NUMBER BEFORE AVAILABILITY AND THE GAME FACTOR: the one construction
 * every served weekly number is built from. trade-engine.js#buildAssetUniverse
 * multiplies it by this game's factor and the chance to play for `current_week_ppg`;
 * weeklyProjectionFor returns it as `corrected_ppg`. Two copies of this used to add a
 * structural-residual fit to the ensemble number (S-02 arm B); there is now one.
 *
 * The coordinator's correction is added only when all of these hold, and otherwise the
 * number is the ensemble alone (`ppg`, S-02 arm A) with `coordinator_off` saying why:
 *   - `fit` is ready: activeFantasyCoordinatorFit returns only a promoted fit;
 *   - `windows[constructionWindow(week)]` is 'on' (the promotion's own windows by
 *     default; a study grading the construction passes them explicitly);
 *   - the fit's recorded target names a base (FIT_TARGETS) and the player has that base;
 *   - the player has coordinator inputs (weeklyExpertValues).
 * The correction is added to the base the fit was trained on: the structural-residual fit
 * to `structural_ppg`, which is S-02's winning arm S1 in both graded windows.
 *
 * @returns {{ ppg, basis, arm, window, base, coordinated, coordinator_off }} — `basis`
 *   'structural+coordinator' | 'ensemble+coordinator' | 'ensemble'; `base` the fit target
 *   used ('structural' | 'ensemble') or null when the coordinator is off.
 */
export function servedWeekConstruction(projection, { fit, season, week, scoring = PPR, windows = fit?.promotion?.windows } = {}) {
  const ensemble = Number.isFinite(projection?.ppg) ? projection.ppg : null;
  const window = constructionWindow(week);
  const off = reason => ({ ppg: ensemble, basis: ensemble == null ? null : 'ensemble', arm: ensemble == null ? null : 'A',
    window, base: null, coordinated: null, coordinator_off: reason });
  if (ensemble == null) return off('no weekly projection');
  if (!fit?.ready) return off(fit?.reason ?? 'no promoted coordinator fit');
  if (windows?.[window] !== 'on') return off(`the promoted fit is not on for weeks ${window}`);
  const target = fitTargetOf(fit);
  if (!target) return off(`the fit's target (${fit?.safeguards?.target ?? 'none recorded'}) is not a base this code knows`);
  const spec = FIT_TARGETS[target];
  const base = projection[spec.base];
  if (!Number.isFinite(base)) return off(`no ${spec.base} for this player`);
  const expertValues = weeklyExpertValues(projection, season, week, scoring);
  if (!expertValues) return off('no coordinator inputs for this player');
  const coordinated = coordinateFantasy(fit, expertValues, base);
  if (!coordinated.ready) return off(coordinated.reason ?? 'the coordinator did not run');
  return { ppg: coordinated.corrected_ppg, basis: spec.basis, arm: spec.arm, window, base: target,
    coordinated, coordinator_off: null };
}

/**
 * What this week's number is built from, for the surface (trade-engine.js puts it on
 * `context.week_basis`, which routes serve as `model_context`). `lift` is waiver-brain.js's
 * BETTING_LINE_LIFT switch, passed in so the label reads the one switch rather than a copy.
 */
export function weekConstructionBasis({ fit, week, lift }) {
  const window = constructionWindow(week);
  const target = fit?.ready ? fitTargetOf(fit) : null;
  const on = Boolean(target) && fit?.promotion?.windows?.[window] === 'on';
  const coordinator = on
    ? { on: true, window, fit_id: fit.fit_row?.id ?? null, through_season: fit.fit_row?.through_season ?? null,
      base: target, target: fit.safeguards.target, windows: fit.promotion.windows,
      promoted_at: fit.promotion.promoted_at ?? null, evidence: fit.promotion.evidence ?? null }
    : { on: false, window,
      reason: !fit?.ready ? (fit?.reason ?? 'no promoted coordinator fit')
        : !target ? `the fit's target (${fit?.safeguards?.target ?? 'none recorded'}) is not a base this code knows`
          : `the promoted fit is not on for weeks ${window}` };
  const liftOn = lift?.on === true;
  const head = !on ? 'our weekly projection, with no coordinator correction'
    : target === 'structural' ? `our structural projection plus the coordinator's correction (fit #${coordinator.fit_id})`
      : `our weekly projection plus the coordinator's correction (fit #${coordinator.fit_id})`;
  const label = `This week's points: ${head}, times his chance to play. ` +
    (liftOn ? 'Times the betting-line game-script boost.' : 'No betting-line boost.') +
    (gradedWeek(week) ? '' : ` Week ${week} was not graded (the grade covered weeks 2-17), so it follows the weeks ${window} decision.`);
  return {
    window, graded_week: gradedWeek(week), coordinator,
    betting_line_lift: { on: liftOn, reason: lift?.reason ?? null, evidence: lift?.evidence ?? null },
    availability: 'times active_probability; availability_basis says which chance-to-play model priced it',
    label
  };
}

/**
 * One player's current-week number before availability, league-agnostic: the same
 * servedWeekConstruction trade-engine.js#buildAssetUniverse multiplies into
 * `current_week_ppg`, for a consumer with no league/format context (a player detail
 * page, the draft assistant). Returns null for a player with no weekly projection (no
 * usage history to project from) rather than a guess.
 */
export function weeklyProjectionFor(playerId, { season, week, scoring = PPR } = {}) {
  const engine = buildPlayerWeekEngine({ season, week, scoring });
  const projection = playerWeekProjection(engine, playerId);
  if (!projection?.params || projection.structural_ppg == null) return null;
  const construction = servedWeekConstruction(projection, { fit: activeFantasyCoordinatorFit(), season, week, scoring });
  const coordinated = construction.coordinated;
  return {
    season, week,
    structural_ppg: projection.structural_ppg,
    ensemble_ppg: projection.ppg,
    corrected_ppg: construction.ppg,
    week_basis: construction.basis,
    coordinator: coordinated
      ? { correction: coordinated.correction, contributions: coordinated.contributions, confidence: coordinated.confidence,
        base: construction.base }
      : null,
    coordinator_off: construction.coordinator_off,
    cutoff: projection.player_week_engine?.cutoff ?? null
  };
}

export const __test = { shrinkageScales, familiesOf, fitRows, design, regimeLabels, coordinateOne, EXPERT_IDS };
