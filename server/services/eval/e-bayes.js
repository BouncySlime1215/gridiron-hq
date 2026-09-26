/**
 * E-BAYES (shadow): a pooled hierarchical acceptance model, per manager, with partial pooling
 * across the leagues. It NEVER drives a served P(yes): p-yes.js attaches its table as
 * `shadow_e_bayes` only with GRIDIRON_EBAYES_SHADOW=1, and no served reader looks at it.
 * Pre-registration and pass bar: docs/tdd/2026-09-25-e-bayes.tdd.md.
 *
 * MODEL. Three-level beta-binomial on decided offers (y = 1 yes, 0 no):
 *   global rate  mu_g = (acc + 1) / (n + 2)
 *   league rate  mu_l = (acc_l + kL mu_g) / (n_l + kL)        (league ~ Beta(kL mu_g, kL (1 - mu_g)))
 *   manager p    p_m  = (acc_m + kM mu_l) / (n_m + kM)        (manager ~ Beta(kM mu_l, kM (1 - mu_l)))
 * kL and kM are empirical Bayes: the maximum beta-binomial marginal likelihood on a fixed log grid,
 * from the answers known before the cutoff. A manager is (league, roster id); the offer's content is
 * not read, like the activity baseline it challenges.
 *
 * CUTOFF. Only offers RESOLVED strictly before `now` count (eval/e1-league.js's rule), so a fit at
 * an offer's proposal time is exactly what the model would have said at first sight.
 */
import { activityBaseline, minOffersToDecide, MIN_GAIN, P_CLIP } from './e1.js';
import { scoreAsOf } from './e1-league.js';
import { confidenceSequence } from './sequential.js';
import { blendP, blendState } from '../p-yes-blend.js';

export const SHADOW_ENV = 'GRIDIRON_EBAYES_SHADOW';
export const LABEL = 'E-BAYES pooled per-manager acceptance (shadow, not served)';
/** Used when a level has fewer than two groups to fit from. Manager 5 = E1's SHRINK_K. */
export const DEFAULT_KAPPA = Object.freeze({ league: 20, manager: 5 });
/** Log-spaced grid 0.5 .. 500 for kappa. */
export const KAPPA_GRID = Object.freeze(Array.from({ length: 61 }, (_, i) => 0.5 * 10 ** (i / 20)));
const PASS_BAR = 'forward log-loss gain vs the served blend: n >= minOffersToDecide, 95% anytime-valid CS lower > 0, mean gain >= 0.01';

/** The shadow is on only when its own flag says exactly '1' (never via preview mode). */
export function eBayesShadowOn(env = process.env) {
  return env[SHADOW_ENV] === '1';
}

const t = s => (s == null ? NaN : Date.parse(s));
const resolvedTime = o => (Number.isFinite(t(o.resolved_at)) ? t(o.resolved_at) : t(o.proposed_at));
const cutOf = now => (typeof now === 'number' ? now : Date.parse(now));
const clipP = p => Math.min(1 - P_CLIP, Math.max(P_CLIP, p));
const ll = (p, y) => -(y ? Math.log(clipP(p)) : Math.log(1 - clipP(p)));

// Lanczos log-gamma (g = 7), accurate to ~1e-13 for x > 0.
const LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const z = x - 1;
  let a = LG[0];
  const tt = z + 7.5;
  for (let i = 1; i < 9; i++) a += LG[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(tt) - tt + Math.log(a);
}
const lbeta = (a, b) => lgamma(a) + lgamma(b) - lgamma(a + b);

/** Beta-binomial log marginal (binomial coefficient dropped: constant in kappa). */
function logMarginal(groups, kappa) {
  let s = 0;
  for (const { acc, n, mu } of groups) {
    const m = Math.min(1 - 1e-6, Math.max(1e-6, mu));
    const a = kappa * m, b = kappa * (1 - m);
    s += lbeta(a + acc, b + n - acc) - lbeta(a, b);
  }
  return s;
}

/** Empirical-Bayes kappa over groups [{ acc, n, mu }]; the default with fewer than two groups. */
export function fitKappa(groups, fallback) {
  const live = groups.filter(g => g.n > 0);
  if (live.length < 2) return fallback;
  let best = KAPPA_GRID[0], top = -Infinity;
  for (const k of KAPPA_GRID) {
    const v = logMarginal(live, k);
    if (v > top + 1e-12) { top = v; best = k; }
  }
  return best;
}

/**
 * Fit on the decided offers resolved strictly before `now`. `kappa` pins both levels (tests).
 * Returns { global: { mu, acc, n }, leagues: Map league -> { mu, acc, n },
 *   managers: Map 'league:team' -> { acc, n }, kappa: { league, manager }, as_of }.
 */
export function fitPooled(offers, { now = Date.now(), kappa = null } = {}) {
  const cut = cutOf(now);
  const known = offers.filter(o => (o.y === 0 || o.y === 1) && resolvedTime(o) < cut);
  const leagues = new Map(), managers = new Map();
  let acc = 0;
  for (const o of known) {
    acc += o.y;
    const l = String(o.league_id), k = `${l}:${o.counterparty_team_id}`;
    const L = leagues.get(l) ?? { acc: 0, n: 0 }; L.acc += o.y; L.n += 1; leagues.set(l, L);
    const M = managers.get(k) ?? { acc: 0, n: 0, league: l }; M.acc += o.y; M.n += 1; managers.set(k, M);
  }
  const muG = (acc + 1) / (known.length + 2);
  const kL = kappa?.league ?? fitKappa([...leagues.values()].map(g => ({ ...g, mu: muG })), DEFAULT_KAPPA.league);
  for (const L of leagues.values()) L.mu = (L.acc + kL * muG) / (L.n + kL);
  const kM = kappa?.manager ?? fitKappa([...managers.values()].map(g => ({ ...g, mu: leagues.get(g.league).mu })), DEFAULT_KAPPA.manager);
  return { global: { mu: muG, acc, n: known.length }, leagues, managers, kappa: { league: kL, manager: kM },
    as_of: Number.isFinite(cut) ? new Date(cut).toISOString() : null };
}

/** Posterior mean for one manager: { p, n, level: 'manager' | 'league' | 'global' }. */
export function predict(model, leagueId, teamId) {
  const l = String(leagueId);
  const L = model.leagues.get(l);
  if (!L) return { p: model.global.mu, n: 0, level: 'global' };
  const M = model.managers.get(`${l}:${teamId}`);
  if (!M) return { p: L.mu, n: 0, level: 'league' };
  const kM = model.kappa.manager;
  return { p: (M.acc + kM * L.mu) / (M.n + kM), n: M.n, level: 'manager' };
}

/** The shadow table p-yes.js attaches under the flag: per team, plus the unseen-manager row. */
export function shadowTable(offers, leagueId, teams, { now = Date.now() } = {}) {
  const m = fitPooled(offers, { now });
  return { byTeam: new Map(teams.map(team => [String(team), predict(m, leagueId, team)])),
    unseen: predict(m, leagueId, '__unseen__'), kappa: { ...m.kappa }, n: m.global.n, as_of: m.as_of, label: LABEL };
}

/** The pre-registered verdict from a grade { n, ci, gain } (gain = blend loss - E-BAYES loss). */
export function verdictOf({ n, ci, gain }) {
  if (!n || !ci || ci[0] == null) return 'not_decided';
  if (ci[1] < 0) return 'fail';
  if (n >= minOffersToDecide() && ci[0] > 0 && gain >= MIN_GAIN) return 'pass';
  return 'not_decided';
}

/**
 * Forward grade over decided offers (e1-league.js#mergeOffers shape), in proposal order. Each
 * offer is scored by E-BAYES fitted before its proposal and by the SERVED blend with the weights
 * as they stood then (baseline and clone are the grader's as-of predictions).
 */
export function gradeForward(offers) {
  const scored = scoreAsOf(offers.filter(o => o.y === 0 || o.y === 1));
  const base = activityBaseline(scored, scored.map(o => o.prior));
  const order = scored.map((o, i) => i).sort((a, b) => t(scored[a].proposed_at) - t(scored[b].proposed_at) || a - b);
  const rows = order.map(i => {
    const o = scored[i];
    const at = t(o.proposed_at);
    const w = blendState(offers, o.league_id, { now: at }).weights;
    const p = { e_bayes: predict(fitPooled(offers, { now: at }), o.league_id, o.counterparty_team_id).p,
      blend: blendP(w, { baseline: base[i], clone: o.p }), baseline: base[i] };
    const loss = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, ll(v, o.y)]));
    return { league_id: String(o.league_id), team: String(o.counterparty_team_id), proposed_at: o.proposed_at, y: o.y, p, loss };
  });
  const n = rows.length;
  const R = Math.log((1 - P_CLIP) / P_CLIP);
  const mean = k => (n ? rows.reduce((s, r) => s + r.loss[k], 0) / n : null);
  const cs = vs => (n ? confidenceSequence(rows.map(r => r.loss[vs] - r.loss.e_bayes), { lo: -R, hi: R, alpha: 0.05, ref: 0 }) : null);
  const vsBlend = cs('blend'), vsBase = cs('baseline');
  const grade = { n, gain: vsBlend?.mean ?? null, ci: vsBlend ? [vsBlend.lower, vsBlend.upper] : null };
  return { n, min_n: minOffersToDecide(), pass_bar: PASS_BAR,
    log_loss: { e_bayes: mean('e_bayes'), blend: mean('blend'), baseline: mean('baseline') },
    vs_blend: grade, vs_baseline: { gain: vsBase?.mean ?? null, ci: vsBase ? [vsBase.lower, vsBase.upper] : null },
    verdict: verdictOf(grade), rows };
}
