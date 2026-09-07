/**
 * Challenger TD-prop calibration heads on WEEKLY-grain context features.
 *
 * Second attempt at one hypothesis. The first
 * (`nfl-prop-player-heads.js` + `nfl-props-player-features.js`,
 * docs/PROPS_PLAYER_ENGINES.md) was declined 0/3 and 0/3, and diagnosed its own
 * failure as a grain problem: the features were season-level constants, and a
 * constant across a player's 17 weeks cannot explain why one of his weeks
 * differs from another. This module re-asks the same question with features
 * that move week to week inside a player-season
 * (`nfl-props-player-features-weekly.js`).
 *
 * Everything the first attempt fixed as method is kept, deliberately and
 * unchanged, so the two results are comparable:
 *
 *  - the challenger STACKS on the shipped head rather than replacing it. An
 *    earlier Platt-instead-of-isotonic form lost on head shape rather than on
 *    features and was correctly discarded as an unfair comparison; stacking
 *    means a null result is a statement about the features;
 *  - the baseline is the shipped policy run by the shipped code — the same
 *    TD_CALIBRATION_HEADS library, the same `fitHead`, the same lowest-training-
 *    Brier selection `walkForwardTdCalibration` performs;
 *  - true walk-forward: the head for test season T is fit only on seasons < T,
 *    and WHICH variant runs is chosen on an inner chronological split;
 *  - significance is a paired bootstrap on per-row squared error, blocked by
 *    game, because player-weeks from one game share script and weather;
 *  - the bar, fixed before any number was read: a significant Brier improvement
 *    on at least 2 of 3 held-out seasons.
 *
 * The `matchup` block is never folded into the default "everything" variant.
 * `nfl-opponent.js` documents opponent adjustment making weekly stat
 * predictions monotonically worse through double counting with the betting
 * line, and the probability being calibrated here is built from game-script-
 * adjusted volume, so the same risk applies. It gets its own ablation arm and
 * its own combined variant, so the double count is measured rather than either
 * repeated blind or assumed away.
 *
 * This is a research harness. Nothing here is wired into `calibrateAnytimeTd`,
 * the prop board or the pick generator, and it persists no calibration fit.
 */
import { TD_CALIBRATION_HEADS, fitHead, applyTdCalibrator } from './nfl-prop-calibration.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import { recordGateAudit } from './model-governance.js';
import { propPlayerWeeklyFeatures, WEEKLY_FEATURE_BLOCKS } from './nfl-props-player-features-weekly.js';

export const WEEKLY_CHALLENGER_MODEL_VERSION = 'player-head-registry-v1-weekly-context';

const clamp = p => Math.max(0.001, Math.min(0.999, Number(p)));
const logit = p => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export const TD_PROP_MARKETS = Object.freeze({
  anytime_td: { p: 'anytime_td', y: 'anytime_td' },
  multi_td: { p: 'multi_td', y: 'multi_td' }
});

/**
 * Candidate variants. `platt_only` is the control — the same augmented fitter
 * with zero features — so a win cannot be an artifact of the fitter differing
 * from the shipped head, and a loss cannot be blamed on one either.
 *
 * `weekly_core` is trend+newrole: the hypothesis proper, without the block the
 * opponent-adjustment failure warns about. `weekly_all` adds matchup, so the
 * selector can take it if it genuinely helps and the ablation can price it if
 * it does not.
 */
export const WEEKLY_CHALLENGER_HEADS = Object.freeze([
  { id: 'platt_only', blocks: [] },
  { id: 'weekly_trend', blocks: ['trend'] },
  { id: 'weekly_newrole', blocks: ['newrole'] },
  { id: 'weekly_matchup', blocks: ['matchup'] },
  { id: 'weekly_core', blocks: ['trend', 'newrole'] },
  { id: 'weekly_all', blocks: ['trend', 'newrole', 'matchup'] }
].map(Object.freeze));

const namesFor = blocks => blocks.flatMap(b => WEEKLY_FEATURE_BLOCKS[b] ?? []);

/** Replay rows -> calibration rows for one TD market, with weekly features attached. */
export function weeklyChallengerRows(replayRows, market = 'anytime_td') {
  const spec = TD_PROP_MARKETS[market];
  if (!spec) throw new Error(`unknown TD prop market ${market}`);
  const featureCache = new Map();
  const featuresFor = season => {
    if (!featureCache.has(season)) featureCache.set(season, propPlayerWeeklyFeatures(season));
    return featureCache.get(season);
  };
  return replayRows
    .filter(r => r.eligibility?.markets?.player_anytime_td)
    .map(r => {
      const p = r.market?.[spec.p], y = r.actual?.[spec.y];
      if (!Number.isFinite(p) || !Number.isFinite(y)) return null;
      const x = featuresFor(r.season).get(`${r.week}|${r.player_id}`) ?? null;
      // Home/away is not on the row, so the block key is the unordered team
      // pair plus the week — the same game either way.
      const game = `${r.season}|${r.week}|${[r.team, r.opponent].filter(Boolean).sort().join('-')}`;
      return { p: clamp(p), y, position: r.position, season: r.season, week: r.week,
        player_id: r.player_id, game, x };
    })
    .filter(r => r && r.x);
}

/* ------------------------------------------------------- augmented fitter */

/** Train-only standardization, so the test season never sets the scale. */
function standardizer(train, names) {
  const stats = names.map(name => {
    const vals = train.map(r => r.x[name] ?? 0);
    const m = mean(vals) ?? 0;
    const sd = Math.sqrt((mean(vals.map(v => (v - m) ** 2)) ?? 0)) || 1;
    return { name, m, sd };
  });
  return row => stats.map(s => ((row.x[s.name] ?? 0) - s.m) / s.sd);
}

/**
 * Ridge logistic on [logit(base p), features..., 1]. The slope on logit(p) is
 * shrunk toward 1 and feature slopes toward 0, so with no signal the head
 * collapses to the identity map rather than to an intercept-only model.
 */
function fitAugmented(train, names, { ridge = 10, iterations = 60, base = r => r.p } = {}) {
  const std = standardizer(train, names);
  const d = names.length + 2;
  const design = train.map(r => [logit(base(r)), ...std(r), 1]);
  const target = Array(d).fill(0); target[0] = 1;
  let beta = target.slice();
  for (let it = 0; it < iterations; it++) {
    const grad = Array(d).fill(0);
    const h = Array.from({ length: d }, () => Array(d).fill(0));
    for (let k = 0; k < train.length; k++) {
      const x = design[k];
      const pred = sigmoid(x.reduce((s, v, i) => s + v * beta[i], 0));
      const w = Math.max(1e-5, pred * (1 - pred));
      for (let i = 0; i < d; i++) {
        grad[i] += x[i] * (train[k].y - pred);
        for (let j = 0; j < d; j++) h[i][j] += x[i] * x[j] * w;
      }
    }
    for (let i = 0; i < d - 1; i++) { grad[i] -= ridge * (beta[i] - target[i]); h[i][i] += ridge; }
    const step = solve(h, grad);
    if (!step) break;
    beta = beta.map((v, i) => v + Math.max(-1, Math.min(1, step[i])));
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return { names, std, beta, base };
}

function solve(a, b) {
  const n = b.length, m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    if (Math.abs(m[col][col]) < 1e-10) return null;
    const dv = m[col][col];
    for (let j = col; j <= n; j++) m[col][j] /= dv;
    for (let r = 0; r < n; r++) if (r !== col) {
      const f = m[r][col];
      for (let j = col; j <= n; j++) m[r][j] -= f * m[col][j];
    }
  }
  return m.map(row => row[n]);
}

export function applyAugmented(model, row) {
  const x = [logit(model.base(row)), ...model.std(row), 1];
  return clamp(sigmoid(x.reduce((s, v, i) => s + v * model.beta[i], 0)));
}

/* ------------------------------------------------------------- evaluation */

const brierOf = (rows, prob) => mean(rows.map(r => (prob(r) - r.y) ** 2));
const logLossOf = (rows, prob) => mean(rows.map(r => {
  const p = prob(r); return -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
}));
function eceOf(rows, prob) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const r of rows) {
    const p = prob(r), b = bins[Math.min(9, Math.floor(p * 10))];
    b.n++; b.p += p; b.y += r.y;
  }
  return bins.reduce((s, b) => s + (b.n ? (b.n / rows.length) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0);
}

/** The shipped policy: fit every library head on train, keep the best on train. */
function shippedBaseline(train) {
  const scored = TD_CALIBRATION_HEADS
    .map(spec => { const model = fitHead(train, spec); return { spec, model, brier: brierOf(train, r => applyTdCalibrator(model, r.p, r)) }; })
    .sort((a, b) => a.brier - b.brier);
  return scored[0];
}

/**
 * The challenger's own variant choice, made without the test season.
 *
 * Training Brier would always crown the widest variant, since more features
 * cannot fit worse. So the choice is made on the newest training season held
 * out of the fit, and only then is the winner refit on the whole window.
 */
function selectChallenger(train, { stack = true } = {}) {
  const seasons = [...new Set(train.map(r => r.season))].sort((a, b) => a - b);
  const inner = seasons.at(-1);
  const innerTrain = seasons.length >= 2 ? train.filter(r => r.season < inner) : train;
  const innerVal = seasons.length >= 2 ? train.filter(r => r.season === inner) : train;
  const innerBaseModel = stack ? shippedBaseline(innerTrain).model : null;
  const outerBaseModel = stack ? shippedBaseline(train).model : null;
  const innerBase = stack ? r => applyTdCalibrator(innerBaseModel, r.p, r) : r => r.p;
  const outerBase = stack ? r => applyTdCalibrator(outerBaseModel, r.p, r) : r => r.p;

  const scored = WEEKLY_CHALLENGER_HEADS.map(spec => {
    const model = fitAugmented(innerTrain, namesFor(spec.blocks), { base: innerBase });
    return { spec, inner_brier: brierOf(innerVal, r => applyAugmented(model, r)) };
  }).sort((a, b) => a.inner_brier - b.inner_brier);
  const chosen = scored[0];
  return { spec: chosen.spec,
    model: fitAugmented(train, namesFor(chosen.spec.blocks), { base: outerBase }),
    outer_base: outerBase, stack,
    inner_season: seasons.length >= 2 ? inner : null,
    inner_ranking: scored.map(s => ({ id: s.spec.id, inner_brier: +s.inner_brier.toFixed(5) })) };
}

/**
 * Does any single weekly block move the needle, holding head shape fixed?
 *
 * The headline comparison picks one variant and grades it against the shipped
 * head. If that loses, the next honest question is whether the features carried
 * signal the selection step discarded. Each block is graded against the
 * identical no-feature control on the same rows, so a real-but-unselected
 * signal cannot hide behind the selection — and so the `matchup` block's
 * double-counting risk is measured on its own rather than assumed.
 */
export function ablateWeeklyChallengerTd(replayRows, {
  market = 'anytime_td', testSeasons = [2023, 2024, 2025], minTrain = 500,
  bootstrapIterations = 4000, stack = true
} = {}) {
  const all = weeklyChallengerRows(replayRows, market);
  const out = [];
  for (const season of testSeasons) {
    const train = all.filter(r => r.season < season);
    const test = all.filter(r => r.season === season);
    if (train.length < minTrain || !test.length) { out.push({ season, skipped: true }); continue; }
    const baseModel = stack ? shippedBaseline(train).model : null;
    const base = stack ? r => applyTdCalibrator(baseModel, r.p, r) : r => r.p;
    const fits = Object.fromEntries(WEEKLY_CHALLENGER_HEADS.map(spec =>
      [spec.id, fitAugmented(train, namesFor(spec.blocks), { base })]));
    const err = id => test.map(r => (applyAugmented(fits[id], r) - r.y) ** 2);
    const control = err('platt_only');
    out.push({ season, test_n: test.length,
      control_brier: +mean(control).toFixed(5),
      blocks: WEEKLY_CHALLENGER_HEADS.filter(s => s.blocks.length).map(spec => {
        const e = err(spec.id);
        const boot = pairedBootstrapDiff(control, e,
          { iterations: bootstrapIterations, seed: 20260907, groups: test.map(r => r.game) });
        return { id: spec.id, brier: +mean(e).toFixed(5),
          exact_diff: +(mean(e) - mean(control)).toExponential(3),
          mean_diff: boot.mean_diff, ci90: boot.ci90, significant: boot.significant,
          helps: boot.significant === true && boot.mean_diff < 0 };
      }) });
  }
  return { market, stack, per_season: out,
    note: 'mean_diff is block minus the no-feature control on Brier; negative favours the block.' };
}

/** Walk-forward challenger-vs-shipped comparison for one TD market. */
export function walkForwardWeeklyChallengerTd(replayRows, {
  market = 'anytime_td', testSeasons = [2023, 2024, 2025], minTrain = 500,
  bootstrapIterations = 4000, stack = true
} = {}) {
  const all = weeklyChallengerRows(replayRows, market);
  const perSeason = [];
  const pooled = { base: [], cand: [], groups: [] };

  for (const season of testSeasons) {
    const train = all.filter(r => r.season < season);
    const test = all.filter(r => r.season === season);
    if (train.length < minTrain || !test.length) {
      perSeason.push({ season, skipped: true, train_n: train.length, test_n: test.length,
        why: `only ${train.length} prior-season rows (need ${minTrain})` });
      continue;
    }
    const base = shippedBaseline(train);
    const chal = selectChallenger(train, { stack });
    const bp = r => applyTdCalibrator(base.model, r.p, r);
    const cp = r => applyAugmented(chal.model, r);

    const baseErr = test.map(r => (bp(r) - r.y) ** 2);
    const candErr = test.map(r => (cp(r) - r.y) ** 2);
    const boot = pairedBootstrapDiff(baseErr, candErr,
      { iterations: bootstrapIterations, seed: 20260907, groups: test.map(r => r.game) });

    pooled.base.push(...baseErr); pooled.cand.push(...candErr);
    pooled.groups.push(...test.map(r => r.game));

    const rate = mean(test.map(r => r.y));
    const clim = rate * (1 - rate);
    perSeason.push({
      season, test_n: test.length, train_n: train.length, base_rate: +rate.toFixed(4),
      shipped_head: base.spec.id, challenger_head: chal.spec.id, stacked: chal.stack,
      challenger_inner_season: chal.inner_season,
      challenger_inner_ranking: chal.inner_ranking,
      shipped: { brier: +mean(baseErr).toFixed(5), log_loss: +logLossOf(test, bp).toFixed(5),
        ece: +eceOf(test, bp).toFixed(5), brier_skill: +(1 - mean(baseErr) / clim).toFixed(4) },
      challenger: { brier: +mean(candErr).toFixed(5), log_loss: +logLossOf(test, cp).toFixed(5),
        ece: +eceOf(test, cp).toFixed(5), brier_skill: +(1 - mean(candErr) / clim).toFixed(4) },
      // pairedBootstrapDiff rounds to 4 decimals, which is coarse next to a
      // Brier gap that lives in the fifth. The unrounded difference is carried
      // alongside so the write-up quotes a real number, not a rounded zero.
      exact_diff: +(mean(candErr) - mean(baseErr)).toExponential(3),
      bootstrap: boot,
      wins: boot.significant === true && boot.mean_diff < 0
    });
  }

  const graded = perSeason.filter(s => !s.skipped);
  const pooledBoot = pooled.base.length >= 10
    ? pairedBootstrapDiff(pooled.base, pooled.cand,
      { iterations: bootstrapIterations, seed: 20260907, groups: pooled.groups })
    : null;
  const seasonsWon = graded.filter(s => s.wins).length;
  return {
    market, test_seasons: testSeasons,
    per_season: perSeason,
    pooled: pooledBoot ? { n: pooled.base.length,
      shipped_brier: +mean(pooled.base).toFixed(5), challenger_brier: +mean(pooled.cand).toFixed(5),
      exact_diff: +(mean(pooled.cand) - mean(pooled.base)).toExponential(3),
      bootstrap: pooledBoot } : null,
    seasons_graded: graded.length, seasons_won: seasonsWon,
    bar: 'significant Brier improvement on at least 2 of 3 held-out seasons',
    verdict: graded.length >= 2 && seasonsWon >= 2
      ? 'challenger clears the pre-stated bar on backtest; forward CLV gate still unmet'
      : 'challenger does NOT clear the pre-stated bar — no promotion'
  };
}

/**
 * File the result through model-governance.js, whatever it says.
 *
 * `recordGateAudit` writes verdict `blocked` unless every gate passes, and
 * `promoteEligibleAudit` refuses anything that is not `promotion_eligible`, so
 * this is append-only provenance and cannot promote anything by itself. The
 * forward-CLV gate is recorded as FAILED, not as "not applicable": it is a
 * claim about real quotes captured before kickoff and settled afterwards, and
 * no backtest can supply it.
 */
export function recordWeeklyChallengerGateAudit(results) {
  const gates = [];
  for (const res of results) {
    const graded = res.per_season.filter(s => !s.skipped);
    gates.push({
      id: `chronological_accuracy_${res.market}`,
      passed: res.seasons_graded >= 2 && res.seasons_won >= 2,
      detail: res.bar,
      observed: `${res.seasons_won}/${res.seasons_graded} held-out seasons with a significant Brier gain`,
      per_season: graded.map(s => ({ season: s.season, n: s.test_n,
        shipped_brier: s.shipped.brier, challenger_brier: s.challenger.brier,
        shipped_ece: s.shipped.ece, challenger_ece: s.challenger.ece,
        chosen_variant: s.challenger_head,
        mean_diff: s.bootstrap.mean_diff, ci90: s.bootstrap.ci90,
        significant: s.bootstrap.significant, wins: s.wins }))
    });
    gates.push({
      id: `calibration_${res.market}`,
      passed: graded.length > 0 && graded.every(s => s.challenger.ece < s.shipped.ece),
      detail: 'challenger ECE below the shipped head on every graded season',
      observed: graded.map(s => `${s.season}: ${s.challenger.ece} vs ${s.shipped.ece}`).join('; ')
    });
  }
  gates.push({
    id: 'forward_clv',
    passed: false,
    detail: 'closing-line value on real captured prop quotes, settled forward',
    observed: 'not satisfiable by a backtest; the live prop quote table has no settled TD bets yet'
  });
  return recordGateAudit({
    sport: 'NFL', market: 'player_props', modelVersion: WEEKLY_CHALLENGER_MODEL_VERSION, gates,
    evidence: {
      harness: 'server/services/nfl-prop-player-weekly-heads.js walkForwardWeeklyChallengerTd',
      features: 'server/services/nfl-props-player-features-weekly.js (in-season role trend, early-season churn interaction, opponent red-zone defense)',
      grain: 'weekly — every feature varies week to week within a player-season; this is the redo of the season-level attempt recorded as player-head-registry-v1-engine-context',
      baseline: 'shipped TD_CALIBRATION_HEADS selection, fit on prior seasons only',
      significance: 'paired bootstrap on per-row squared error, blocked by game',
      documented: 'docs/PROPS_PLAYER_ENGINES_WEEKLY.md'
    }
  });
}
