/**
 * LIVING-01a: per-manager engagement state and activity rates.
 *
 * A slow hidden state per manager-season, ENGAGED / DRIFTING / CHECKED_OUT, that
 * emits each week's players added (Poisson) and whether he started a dead or empty
 * slot (Bernoulli). On top of the state, each manager's add volume is scaled by his
 * own rate, shrunk to the population (gamma-Poisson: `rho` below), and his trade
 * and lineup-error rates are reported shrunk the same way.
 *
 * Evidence and grade: docs/evidence/2026-09-23/living-01a-activity-model.md, fit on
 * Sleeper 2021-22 by scripts/living01a-fit.mjs, graded on 2023 and 2024 separately.
 * Post-loss "tilt" is NOT modelled: two R&D lenses found no population effect.
 *
 * This file has two halves:
 *   1. pure math (no database): the filter, the EM fit, the checkout probability and
 *      the shrunk rates. The fit script grades exactly these functions.
 *   2. the engine producer 'activity' (field `activity.manager`), registered on the
 *      ONE ENGINE spine. It reads ESPN transactions from engine_events (the spine's
 *      as-of log, the same ADD items #203's manager-signals counts), reads #203's
 *      last-week dead starts from manager_signals rather than recounting them, and
 *      writes one engine_state row per manager with a reason_chain. It runs only when
 *      GRIDIRON_LIVING01A_ENABLED=1, or when preview-mode.js (PREVIEW-01) says preview is on.
 */
import { registerField } from './registry.js';

export const STATES = Object.freeze(['engaged', 'drifting', 'checked_out']);
export const MODEL_VERSION = 'living01a-1';
export const FLAG = 'GRIDIRON_LIVING01A_ENABLED';

/* ------------------------------------------------------------------ math */

const K = STATES.length;
const LOG_FACT = [0];
const logFact = n => {
  for (let i = LOG_FACT.length; i <= n; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
  return LOG_FACT[n];
};
export const poissonLogPmf = (k, mu) => (mu <= 0 ? (k === 0 ? 0 : -Infinity) : k * Math.log(mu) - mu - logFact(k));
const clampP = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = p => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = x => 1 / (1 + Math.exp(-x));

/** P(dead or empty starter) in state s in a week with `byeFrac` of NFL teams on bye. */
export function errorProb(params, s, byeFrac = 0) {
  return sigmoid(params.errLogit[s] + params.errBye * (Number.isFinite(byeFrac) ? byeFrac : 0));
}

/**
 * The online (as-of) filter over one manager-season. `weeks` is an array, week 1
 * first, of { adds: int|null, err: 0|1|null, byeFrac?: number } where null is
 * UNKNOWN (never zero). For each week it returns what was known BEFORE that week:
 *   prior      P(state) for the week
 *   rho        the manager's shrunk add-volume multiplier
 *   addsMean   expected adds, and addsLogLik (log P of the adds actually seen)
 *   errProb    P(dead or empty starter)
 * and, after the week, `post` (the filtered state). `final` is the filtered state
 * after the last week and the prior for the week after it.
 */
export function filterSeason(params, weeks) {
  const { pi, A, lam, alpha } = params;
  let prior = [...pi];
  let addsSeen = 0;
  let expoSeen = 0;
  const out = [];
  for (const wk of weeks) {
    const rho = (alpha + addsSeen) / (alpha + expoSeen);
    const mus = lam.map(l => rho * l);
    const addsMean = prior.reduce((a, p, s) => a + p * mus[s], 0);
    const eps = STATES.map((_, s) => errorProb(params, s, wk.byeFrac));
    const errP = prior.reduce((a, p, s) => a + p * eps[s], 0);
    const like = STATES.map((_, s) => {
      let l = 1;
      if (wk.adds != null) l *= Math.exp(poissonLogPmf(wk.adds, mus[s]));
      if (wk.err != null) l *= wk.err ? eps[s] : 1 - eps[s];
      return l;
    });
    let post = prior.map((p, s) => p * like[s]);
    const z = post.reduce((a, b) => a + b, 0);
    post = z > 0 ? post.map(p => p / z) : [...prior];
    let addsLogLik = null;
    if (wk.adds != null) {
      const m = prior.reduce((a, p, s) => a + p * Math.exp(poissonLogPmf(wk.adds, mus[s])), 0);
      addsLogLik = Math.log(Math.max(m, 1e-300));
      addsSeen += wk.adds;
      expoSeen += addsMean / rho;
    }
    out.push({ prior, rho, addsMean, addsLogLik, errProb: errP, post });
    prior = STATES.map((_, j) => post.reduce((a, p, i) => a + p * A[i][j], 0));
  }
  const rho = (alpha + addsSeen) / (alpha + expoSeen);
  return { weeks: out, final: { post: out.length ? out[out.length - 1].post : [...pi], nextPrior: prior, rho } };
}

/**
 * P(no adds in any of the next `weeksLeft` weeks), from the prior for the next week.
 * The checkout grade's score: "stops adding for the rest of the season".
 */
export function pNoMoreAdds(params, nextPrior, rho, weeksLeft) {
  let v = [...nextPrior];
  for (let w = 0; w < weeksLeft; w++) {
    v = v.map((p, s) => p * Math.exp(-rho * params.lam[s]));
    if (w < weeksLeft - 1) v = STATES.map((_, j) => v.reduce((a, p, i) => a + p * params.A[i][j], 0));
  }
  return v.reduce((a, b) => a + b, 0);
}

/**
 * The shrunk rate: (prior * priorWeight + events) / (priorWeight + exposure).
 * Gamma-Poisson posterior mean for counts; beta-binomial for 0/1 weeks.
 */
export function shrunkRate(events, exposure, popRate, priorWeight) {
  return (popRate * priorWeight + events) / (priorWeight + exposure);
}

/** Forward-backward on one season with rho fixed from the online filter. */
function smooth(params, weeks, rhos) {
  const T = weeks.length;
  const like = weeks.map((wk, t) => STATES.map((_, s) => {
    let l = 1;
    if (wk.adds != null) l *= Math.exp(poissonLogPmf(wk.adds, rhos[t] * params.lam[s]));
    if (wk.err != null) { const e = errorProb(params, s, wk.byeFrac); l *= wk.err ? e : 1 - e; }
    return Math.max(l, 1e-300);
  }));
  const a = []; const c = [];
  for (let t = 0; t < T; t++) {
    const pr = t === 0 ? params.pi : STATES.map((_, j) => a[t - 1].reduce((acc, p, i) => acc + p * params.A[i][j], 0));
    const v = pr.map((p, s) => p * like[t][s]);
    const z = v.reduce((x, y) => x + y, 0);
    c.push(z); a.push(v.map(x => x / z));
  }
  const b = new Array(T);
  b[T - 1] = [1, 1, 1];
  for (let t = T - 2; t >= 0; t--) {
    b[t] = STATES.map((_, i) => STATES.reduce((acc, _j, j) => acc + params.A[i][j] * like[t + 1][j] * b[t + 1][j], 0) / c[t + 1]);
  }
  const gamma = a.map((row, t) => row.map((p, s) => p * b[t][s]));
  const xi = [];
  for (let t = 0; t < T - 1; t++) {
    const m = STATES.map((_, i) => STATES.map((_j, j) => a[t][i] * params.A[i][j] * like[t + 1][j] * b[t + 1][j] / c[t + 1]));
    xi.push(m);
  }
  return { gamma, xi, logLik: c.reduce((acc, z) => acc + Math.log(z), 0) };
}

/** Weighted logistic fit of the error emission: errLogit[s] + errBye * byeFrac. Newton steps. */
function fitErrorEmission(rows, init) {
  let beta = [...init.errLogit, init.errBye];
  for (let it = 0; it < 25; it++) {
    const g = new Array(K + 1).fill(0);
    const H = Array.from({ length: K + 1 }, () => new Array(K + 1).fill(0));
    for (const r of rows) {
      for (let s = 0; s < K; s++) {
        const w = r.g[s];
        if (w <= 0) continue;
        const p = sigmoid(beta[s] + beta[K] * r.bye);
        const d = w * (r.y - p); const h = w * p * (1 - p);
        g[s] += d; g[K] += d * r.bye;
        H[s][s] += h; H[s][K] += h * r.bye; H[K][s] += h * r.bye; H[K][K] += h * r.bye * r.bye;
      }
    }
    for (let i = 0; i <= K; i++) H[i][i] += 1e-6;
    const step = solve(H, g);
    beta = beta.map((x, i) => x + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return { errLogit: beta.slice(0, K), errBye: beta[K] };
}

function solve(M, v) {
  const n = v.length;
  const a = M.map((row, i) => [...row, v[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[p][i])) p = r;
    [a[i], a[p]] = [a[p], a[i]];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = a[r][i] / a[i][i];
      for (let c = i; c <= n; c++) a[r][c] -= f * a[i][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

/** Starting values; the EM moves them. States are re-sorted by add rate after the fit. */
export function initialParams({ popAddRate = 1, popErr = 0.2, alpha = 8, useBye = true } = {}) {
  return {
    pi: [0.7, 0.25, 0.05],
    A: [[0.9, 0.08, 0.02], [0.15, 0.75, 0.1], [0.02, 0.05, 0.93]],
    lam: [popAddRate * 1.6, popAddRate * 0.6, popAddRate * 0.05],
    errLogit: [logit(popErr * 0.6), logit(popErr * 1.2), logit(Math.min(0.9, popErr * 3.5))],
    errBye: 0,
    useBye,
    alpha,
  };
}

/**
 * EM (Baum-Welch) over many manager-seasons. `seasons` is an array of `weeks`
 * arrays (see filterSeason). Returns the fitted params with states sorted
 * engaged -> checked_out by add rate.
 */
export function fitParams(seasons, init, { iterations = 40, tol = 1e-6, log = null } = {}) {
  let params = { ...init, pi: [...init.pi], A: init.A.map(r => [...r]), lam: [...init.lam], errLogit: [...init.errLogit] };
  let prevLL = -Infinity;
  for (let it = 0; it < iterations; it++) {
    const piN = [0, 0, 0];
    const An = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const lamNum = [0, 0, 0]; const lamDen = [0, 0, 0];
    const errRows = [];
    let ll = 0;
    for (const weeks of seasons) {
      if (!weeks.length) continue;
      const rhos = filterSeason(params, weeks).weeks.map(w => w.rho);
      const { gamma, xi, logLik } = smooth(params, weeks, rhos);
      ll += logLik;
      gamma[0].forEach((g, s) => { piN[s] += g; });
      for (const m of xi) for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) An[i][j] += m[i][j];
      weeks.forEach((wk, t) => {
        if (wk.adds != null) for (let s = 0; s < K; s++) { lamNum[s] += gamma[t][s] * wk.adds; lamDen[s] += gamma[t][s] * rhos[t]; }
        if (wk.err != null) errRows.push({ g: gamma[t], y: wk.err, bye: params.useBye ? (wk.byeFrac ?? 0) : 0 });
      });
    }
    const piSum = piN.reduce((a, b) => a + b, 0);
    params.pi = piN.map(x => x / piSum);
    params.A = An.map(row => { const z = row.reduce((a, b) => a + b, 0); return row.map(x => x / z); });
    params.lam = lamNum.map((x, s) => Math.max(1e-4, x / lamDen[s]));
    const e = fitErrorEmission(errRows, params);
    params.errLogit = e.errLogit;
    params.errBye = params.useBye ? e.errBye : 0;
    if (log) log(`em ${it} logLik ${ll.toFixed(1)} lam ${params.lam.map(x => x.toFixed(3)).join('/')}`);
    if (Math.abs(ll - prevLL) < tol * Math.abs(ll)) break;
    prevLL = ll;
  }
  return sortStates(params);
}

function sortStates(p) {
  const order = [0, 1, 2].sort((a, b) => p.lam[b] - p.lam[a]);
  return {
    ...p,
    pi: order.map(i => p.pi[i]),
    A: order.map(i => order.map(j => p.A[i][j])),
    lam: order.map(i => p.lam[i]),
    errLogit: order.map(i => p.errLogit[i]),
  };
}

/* ---------------------------------------------------------- fitted constants */

/**
 * Fitted on Sleeper 2021-22 (10,656 team-seasons, 1938 leagues across 2021-24 in the
 * run) by scripts/living01a-fit.mjs; rounded to 5 significant figures. States:
 * engaged, drifting, checked_out. `lam` = adds per week in each state, `errLogit` +
 * `errBye` x (share of NFL teams on bye) = log-odds of a dead or empty starter,
 * `alpha` = the prior weight, in state-weighted weeks, of the population add rate in a
 * manager's own multiplier. Graded 2023 and 2024 in docs/evidence/2026-09-23/living-01a-activity-model.md.
 */
export const FITTED_PARAMS = Object.freeze({
  pi: [0.55388, 0.37859, 0.067533],
  A: [[0.92682, 0.07262, 0.00055838], [0.11061, 0.83782, 0.051573], [0.0033083, 0.011862, 0.98483]],
  lam: [1.8257, 0.45997, 0.0077193],
  errLogit: [-2.8666, -1.5823, 2.6171],
  errBye: 5.3254,
  useBye: true,
  alpha: 8,
  popAddRate: 1.2501,
  popTradeRate: 0.044608,
  popErrRate: 0.26793,
  fit: 'Sleeper 2021-22',
});

/** Prior weight (weeks) for the reported trade and lineup-error rates. */
const RATE_PRIOR_WEEKS = 8;

/* ------------------------------------------------------------ the producer */

// The one writer of activity.manager. Module-private: never exported.
const ACTIVITY_WRITER = registerField('activity.manager', {
  producer: 'activity', version: MODEL_VERSION, entityTypes: ['league_team'],
  description: 'Per manager: engagement state (engaged/drifting/checked_out), next-week add and lineup-error '
    + 'probabilities, and shrunk add/trade/lineup-error rates (LIVING-01a)',
});

/**
 * Whether the producer may write: GRIDIRON_LIVING01A_ENABLED=1, or the preview switch
 * (preview-mode.js#previewUnconfirmed, PREVIEW-01) when that module is present.
 * Read per call. Returns { on, preview } where preview means on ONLY through preview.
 */
export async function activityEnabled() {
  if (process.env[FLAG] === '1') return { on: true, preview: false };
  let preview = false;
  try {
    const mod = await import('../preview-mode.js');
    preview = typeof mod.previewUnconfirmed === 'function' && mod.previewUnconfirmed() === true;
  } catch {
    preview = false; // PREVIEW-01 not on this build: only the unit's own flag turns it on
  }
  return { on: preview, preview };
}

const PREVIEW_REASON = 'LIVING-01a engagement state: default-off; graded on Sleeper 2023-24, not yet confirmed on ESPN leagues';

/**
 * Weekly adds and completed trades per ESPN team from `espn.transaction` events, with
 * #203's definitions (manager-signals.js addsByTeam / completedTrades): ADD items of
 * EXECUTED WAIVER/FREEAGENT rows, credited to toTeamId; TRADE_ACCEPT/PROCESS/EXECUTED
 * rows, credited to every party. Pure, so the test pins it.
 */
export function weeklyActivityFromEvents(events, season, through) {
  const adds = new Map(); // team -> Map(week -> {n, ids})
  const trades = new Map();
  const put = (m, team, week, id) => {
    const t = m.get(team) ?? m.set(team, new Map()).get(team);
    const cell = t.get(week) ?? t.set(week, { n: 0, ids: [] }).get(week);
    cell.n += 1;
    if (!cell.ids.includes(id)) cell.ids.push(id);
  };
  let collected = false;
  for (const ev of events) {
    const p = ev.payload ?? {};
    if (Number(p.season) !== Number(season)) continue;
    collected = true;
    const week = Number(p.scoring_period);
    if (!(week >= 1 && week <= through)) continue;
    const items = Array.isArray(p.items) ? p.items : [];
    if ((p.type === 'WAIVER' || p.type === 'FREEAGENT') && p.status === 'EXECUTED') {
      for (const i of items) if (i?.type === 'ADD' && Number(i.to_team_id) > 0) put(adds, String(Number(i.to_team_id)), week, ev.id);
    } else if (p.type === 'TRADE_ACCEPT' && p.execution_type === 'PROCESS' && p.status === 'EXECUTED') {
      const parties = new Set(items.flatMap(i => [i?.from_team_id, i?.to_team_id]).filter(x => Number(x) > 0).map(x => String(Number(x))));
      for (const team of parties) put(trades, team, week, ev.id);
    }
  }
  return { collected, adds, trades };
}

const pct = x => `${Math.round(x * 100)}%`;

/**
 * One manager's state from his weekly series. `weeks[i]` is week i+1:
 * { adds: int|null, err: 0|1|null, byeFrac?: number|null, addIds?: int[] }.
 * Returns the engine_state value and its reason_chain (contributions cite only the
 * add events of the weeks they describe).
 */
export function managerState(weeks, { params = FITTED_PARAMS, trades = 0, weeksLeft = null } = {}) {
  const f = filterSeason(params, weeks);
  const post = f.final.post;
  const s = post.indexOf(Math.max(...post));
  const next = f.final.nextPrior;
  const rho = f.final.rho;
  const knownAdds = weeks.filter(w => w.adds != null);
  const addsSeen = knownAdds.reduce((a, w) => a + w.adds, 0);
  const errWeeks = weeks.filter(w => w.err != null);
  const errSeen = errWeeks.reduce((a, w) => a + w.err, 0);
  const pAnyAdd = next.reduce((a, p, i) => a + p * (1 - Math.exp(-rho * params.lam[i])), 0);
  const value = {
    state: STATES[s],
    probs: Object.fromEntries(STATES.map((n, i) => [n, +post[i].toFixed(4)])),
    next_week: {
      p_any_add: +pAnyAdd.toFixed(4),
      adds_mean: +next.reduce((a, p, i) => a + p * rho * params.lam[i], 0).toFixed(4),
      p_lineup_error: +next.reduce((a, p, i) => a + p * errorProb(params, i, null), 0).toFixed(4),
      lineup_error_bye_adjusted: false,
    },
    rates: {
      adds_per_week: knownAdds.length
        ? { value: +(rho * params.popAddRate).toFixed(4), raw: +(addsSeen / knownAdds.length).toFixed(4), weeks: knownAdds.length }
        : { value: null, absence: 'unknown: no transactions collected' },
      trades_per_week: knownAdds.length
        ? { value: +shrunkRate(trades, knownAdds.length, params.popTradeRate, RATE_PRIOR_WEEKS).toFixed(4), raw: trades, weeks: knownAdds.length }
        : { value: null, absence: 'unknown: no transactions collected' },
      lineup_error_rate: errWeeks.length
        ? { value: +shrunkRate(errSeen, errWeeks.length, params.popErrRate, RATE_PRIOR_WEEKS).toFixed(4), raw: errSeen, weeks: errWeeks.length }
        : { value: null, absence: 'unknown: no graded lineup week' },
    },
    p_no_more_adds: weeksLeft > 0 ? +pNoMoreAdds(params, next, rho, weeksLeft).toFixed(4) : null,
    weeks_seen: weeks.length,
  };
  const contributions = [];
  // The last two weeks' evidence, as the move it made in the state he is called.
  const tail = Math.max(0, weeks.length - 2);
  for (let t = tail; t < weeks.length; t++) {
    const wk = weeks[t];
    const x = f.weeks[t];
    const move = x.post[s] - x.prior[s];
    const addTxt = wk.adds == null ? 'adds unknown' : `${wk.adds} add${wk.adds === 1 ? '' : 's'}`;
    const errTxt = wk.err == null ? '' : wk.err ? ', started a dead or empty slot' : ', full lineup';
    contributions.push({ source: 'espn.transaction', event_ids: wk.addIds ?? [], delta: +move.toFixed(4),
      text: `${STATES[s]}: week ${t + 1} ${addTxt}${errTxt} (${move >= 0 ? '+' : ''}${move.toFixed(2)})` });
  }
  const quiet = knownAdds.length >= 2 && weeks.slice(-2).every(w => w.adds === 0);
  if (quiet) {
    contributions.push({ source: 'activity.state', event_ids: [], delta: +post[2].toFixed(4),
      text: `${STATES[s]}: 0 adds in 2 weeks; P(checked out) ${pct(post[2])}` });
  }
  contributions.push({ source: 'activity.shrinkage', event_ids: [], delta: +(rho - 1).toFixed(4),
    text: `own add volume x${rho.toFixed(2)} vs a manager in the same state (${addsSeen} adds over ${knownAdds.length} weeks, `
      + `shrunk with ${params.alpha} weeks of league prior)` });
  if (!errWeeks.length) {
    contributions.push({ source: 'manager_signals', event_ids: [], delta: null,
      text: 'lineup errors unknown: no final lineup with play data was read for this manager' });
  }
  return { value, reasonChain: { contributions } };
}

/**
 * The engine producer. Writes one `activity.manager` row per team in one ESPN league,
 * as of `asOf`, from the events in the log at that time. Returns
 * { written, skipped, off, teams } — `off` (with the reason) when the flag is off.
 *
 *   leagueId, season  the ESPN league and season
 *   through           last completed scoring period
 *   asOf              cutoff (default now): no event after it is read
 *   weeksLeft         regular-season weeks after `through`, for p_no_more_adds (optional)
 *   deadStarts        Map(teamId -> 0|1+) for week `through`, else read from #203's
 *                     manager_signals.lineup_dead_starts_last_week (not recounted here)
 */
export async function produceActivityStates({ leagueId, season, through, asOf = new Date(), weeksLeft = null,
  deadStarts = null, database = null } = {}) {
  const gate = await activityEnabled();
  if (!gate.on) return { written: 0, skipped: 0, off: `${FLAG} is not 1 (default-off)`, teams: [] };
  const { db: appDb } = await import('../../db/index.js');
  const { getEvents, normalizeAsOf } = await import('./events.js');
  const { writeState } = await import('./state.js');
  const dbh = database ?? appDb;
  const cutoff = normalizeAsOf(asOf);
  const events = getEvents({ asOf: cutoff, leagueId, types: ['espn.transaction'], limit: 10000 }, dbh);
  const act = weeklyActivityFromEvents(events, season, through);
  const signalTeams = dbh.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_signals'`).get()
    ? dbh.prepare(`SELECT roster_id, metric, value FROM manager_signals WHERE league_id = ?`).all(Number(leagueId)) : [];
  const dead = deadStarts ?? new Map(signalTeams.filter(r => r.metric === 'lineup_dead_starts_last_week')
    .map(r => [String(r.roster_id), Number(r.value)]));
  const teams = [...new Set([...signalTeams.map(r => String(r.roster_id)), ...act.adds.keys(), ...act.trades.keys()])].sort();
  let written = 0; let skipped = 0;
  const out = [];
  for (const team of teams) {
    const weeks = [];
    for (let w = 1; w <= through; w++) {
      const cell = act.adds.get(team)?.get(w);
      const deadV = w === through && dead.has(team) ? dead.get(team) : null;
      weeks.push({ adds: act.collected ? (cell?.n ?? 0) : null, addIds: cell?.ids ?? [],
        err: deadV == null ? null : deadV > 0 ? 1 : 0, byeFrac: null });
    }
    const trades = [...(act.trades.get(team)?.values() ?? [])].reduce((a, c) => a + c.n, 0);
    const { value, reasonChain } = managerState(weeks, { trades, weeksLeft });
    if (gate.preview) Object.assign(value, { preview: true, preview_reason: PREVIEW_REASON });
    const eventIds = [...new Set(weeks.flatMap(w => w.addIds))];
    const r = writeState({ entityType: 'league_team', entityId: `${leagueId}:${team}`, field: 'activity.manager',
      value, asOf: cutoff, writer: ACTIVITY_WRITER, producerVersion: MODEL_VERSION, reasonChain, eventIds,
      leagueId: Number(leagueId) }, dbh);
    if (r.written) written++; else skipped++;
    out.push({ team, state: value.state });
  }
  return { written, skipped, off: null, teams: out };
}
