/**
 * LIVE-BLEND: the served P(yes) is a blend of the models the E1 grader already scores, with each
 * model's weight EARNED online from graded offers instead of set by hand or held back for a gate.
 *
 * MODELS. baseline = the E1 activity-only baseline (eval/e1.js#activityBaseline: the responder's
 * accept rate over offers resolved before, shrunk to the league rate); clone = the CLONE-01a/b band
 * (trade-acceptance.js#acceptanceBand, replayed as of each offer by eval/e1-league.js#scoreAsOf).
 * The ACTIVITY-01 intensity term (#334) is not on main, so it is not a model here; `activity` in
 * the summary says so. Adding it = one more entry in MODELS plus its as-of prediction per offer.
 *
 * WEIGHTS. Bayesian model averaging on log loss (exponential weights with eta = 1): each graded
 * offer multiplies a model's weight by the probability it gave the answer that happened, then the
 * weights are clamped to [0.05, 0.95] so neither model is ever switched fully off or on. The clone
 * starts at 0.25 and the baseline at 0.75. Offers are graded in the order their answers became
 * known, and only answers known before `now` count; each offer's two predictions are the as-of
 * ones the grader uses (forward only). So the weights move when, and only when, a newly settled
 * offer is graded.
 *
 * POOLING. All leagues' offers are one pool. A league's own weights (its offers only, same prior)
 * are shrunk to the pool's: w = lambda * league + (1 - lambda) * pool, lambda = n / (n + 20).
 *
 * PROBES (shadow). probeEIG = the expected information a yes/no from this offer would give about
 * which model is right (mutual information between the answer and the model, in nats). Used only
 * as a tie-breaker between plans that already pass every rule, and only with GRIDIRON_PYES_PROBES=1.
 */
import { activityBaseline } from './eval/e1.js';
import { scoreAsOf } from './eval/e1-league.js';
import { confidenceSequence } from './eval/sequential.js';

export const BLEND_ENV = 'GRIDIRON_PYES_BLEND';
export const PROBES_ENV = 'GRIDIRON_PYES_PROBES';
export const BLEND_BASIS = 'pyes_blend';
export const BLEND_LABEL = 'blend of activity baseline and clone, weights earned on graded offers (E1 pending)';
export const MODELS = Object.freeze(['baseline', 'clone']);
export const PRIOR = Object.freeze({ baseline: 0.75, clone: 0.25 });
export const W_CLAMP = Object.freeze([0.05, 0.95]);
export const SHRINK_K = 20;
/** The grader's clip (eval/e1.js P_CLIP): no model is charged more than log(1/0.02) for one offer. */
export const P_CLIP = 0.02;
export const ACTIVITY_ABSENT = 'ACTIVITY-01 (#334) is not merged, so the activity-intensity term is not blended';

const clipP = p => Math.min(1 - P_CLIP, Math.max(P_CLIP, p));
const ll = (p, y) => -(y ? Math.log(clipP(p)) : Math.log(1 - clipP(p)));
const t = s => (s == null ? NaN : Date.parse(s));
const resolvedTime = o => (Number.isFinite(t(o.resolved_at)) ? t(o.resolved_at) : t(o.proposed_at));

/** Clamp every weight to W_CLAMP and renormalise, repeated until both hold (exact for two models). */
export function clampWeights(w) {
  const [lo, hi] = W_CLAMP;
  let out = { ...w };
  for (let k = 0; k < 20; k++) {
    const c = Object.fromEntries(MODELS.map(m => [m, Math.min(hi, Math.max(lo, out[m]))]));
    const s = MODELS.reduce((a, m) => a + c[m], 0);
    out = Object.fromEntries(MODELS.map(m => [m, c[m] / s]));
    if (MODELS.every(m => out[m] >= lo - 1e-12 && out[m] <= hi + 1e-12)) break;
  }
  return out;
}

/**
 * The decided offers whose answers were known before `now`, in the order they became known, each
 * with both models' as-of predictions: [{ league_id, y, p: { baseline, clone } }].
 */
export function gradedOffers(offers, { now = Date.now() } = {}) {
  const scored = scoreAsOf(offers);
  const base = activityBaseline(scored, scored.map(o => o.prior));
  const cut = typeof now === 'number' ? now : Date.parse(now);
  return scored.map((o, i) => ({ o, i, at: resolvedTime(o) }))
    .filter(x => Number.isFinite(x.at) && x.at < cut)
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map(({ o, i }) => ({ league_id: String(o.league_id), proposed_at: o.proposed_at, y: o.y, p: { baseline: base[i], clone: o.p } }));
}

/** Weights after grading `graded` in order from `prior`, and each model's record vs the baseline. */
export function hedge(graded, prior = PRIOR) {
  let w = clampWeights(prior);
  const rec = Object.fromEntries(MODELS.map(m => [m, { n: 0, loss: 0, wins: 0, losses: 0 }]));
  for (const g of graded) {
    const loss = Object.fromEntries(MODELS.map(m => [m, ll(g.p[m], g.y)]));
    // Bayes: w_m <- w_m * P_m(answer); in log space, minus the log loss.
    const raw = Object.fromEntries(MODELS.map(m => [m, Math.log(w[m]) - loss[m]]));
    const top = Math.max(...MODELS.map(m => raw[m]));
    const s = MODELS.reduce((a, m) => a + Math.exp(raw[m] - top), 0);
    w = clampWeights(Object.fromEntries(MODELS.map(m => [m, Math.exp(raw[m] - top) / s])));
    for (const m of MODELS) {
      rec[m].n += 1; rec[m].loss += loss[m];
      if (m !== 'baseline') {
        if (loss[m] < loss.baseline) rec[m].wins += 1;
        else if (loss[m] > loss.baseline) rec[m].losses += 1;
      }
    }
  }
  return { weights: w, record: rec, n: graded.length };
}

/**
 * The served blend state for one league as of `now`: pooled weights, the league's own, and the
 * shrunk weights that are served. `offers`: e1-league.js#mergeOffers shape (every league).
 */
export function blendState(offers, leagueId, { now = Date.now(), prior = PRIOR } = {}) {
  const graded = gradedOffers(offers, { now });
  const pool = hedge(graded, prior);
  const own = hedge(graded.filter(g => g.league_id === String(leagueId)), prior);
  const lambda = own.n / (own.n + SHRINK_K);
  const weights = clampWeights(Object.fromEntries(MODELS.map(m => [m, lambda * own.weights[m] + (1 - lambda) * pool.weights[m]])));
  return { weights, prior: { ...prior }, pooled: pool, league: own, lambda, shrink_k: SHRINK_K, clamp: [...W_CLAMP],
    as_of: new Date(now).toISOString() };
}

/** The blended probability: sum of weight x model p. */
export function blendP(weights, preds) {
  return MODELS.reduce((a, m) => a + weights[m] * preds[m], 0);
}

const H = p => { const q = clipP(p); return -(q * Math.log(q) + (1 - q) * Math.log(1 - q)); };

/** Expected information (nats) a yes/no to this offer gives about which model is right. >= 0. */
export function probeEIG(weights, preds) {
  const v = H(blendP(weights, preds)) - MODELS.reduce((a, m) => a + weights[m] * H(preds[m]), 0);
  return Math.max(0, v);
}

/** Probes are a shadow tie-breaker: on only when the env says exactly '1'. */
export function probesOn(env = process.env) {
  return env[PROBES_ENV] === '1';
}

const r4 = x => Math.round(x * 1e4) / 1e4;

/**
 * plans.json `p_yes_basis` value: per model, the served weight, its prior, and its record vs the
 * baseline ("clone 3-1 vs baseline, 30% weight"), n and mean log loss, pooled over all leagues.
 */
export function basisSummary(state) {
  const models = MODELS.map(m => {
    const r = state.pooled.record[m];
    return { id: m, weight: r4(state.weights[m]), prior_weight: state.prior[m], n: r.n,
      log_loss: r.n ? r4(r.loss / r.n) : null,
      ...(m === 'baseline' ? {} : { wins: r.wins, losses: r.losses }) };
  });
  return { models, n_graded: state.pooled.n, league_n: state.league.n, lambda: r4(state.lambda),
    shrink_k: state.shrink_k, clamp: state.clamp, as_of: state.as_of, activity: ACTIVITY_ABSENT };
}

/**
 * THE PRE-REGISTERED METRIC (docs/tdd/2026-09-25-live-blend.tdd.md): forward-only log loss of the
 * served blend vs the activity baseline. Each settled offer, in proposal order, is scored by the
 * blend with the weights as they stood when it was PROPOSED (only answers known before then), so
 * no offer grades the weights that predict it. gain = baseline log loss - blend log loss per offer
 * (> 0: the blend is better), with E1's 95% anytime-valid confidence sequence.
 */
export function prequential(offers) {
  const all = gradedOffers(offers, { now: Infinity })
    .map((g, i) => ({ g, i })).sort((a, b) => Date.parse(a.g.proposed_at) - Date.parse(b.g.proposed_at) || a.i - b.i).map(x => x.g);
  const d = [], lb = [], lx = [];
  for (const g of all) {
    const w = blendState(offers, g.league_id, { now: Date.parse(g.proposed_at) }).weights;
    const a = ll(g.p.baseline, g.y), b = ll(blendP(w, g.p), g.y);
    lb.push(a); lx.push(b); d.push(a - b);
  }
  const n = d.length;
  const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  if (!n) return { n, log_loss_blend: null, log_loss_baseline: null, gain: null, ci: null };
  const R = Math.log((1 - P_CLIP) / P_CLIP);
  const cs = confidenceSequence(d, { lo: -R, hi: R, alpha: 0.05, ref: 0 });
  return { n, log_loss_blend: mean(lx), log_loss_baseline: mean(lb), gain: cs.mean, ci: [cs.lower, cs.upper] };
}
