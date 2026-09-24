/**
 * LIVING-01a: per-manager engagement state and activity rates.
 *
 * A slow hidden state per manager-season, ENGAGED / DRIFTING / CHECKED_OUT, that
 * emits each week's players added (Poisson) and whether he started a dead or empty
 * slot (Bernoulli). On top of the state, each manager's add volume is scaled by his
 * own rate, shrunk to the population (gamma-Poisson: `rho` below). The served
 * adds, trade and lineup-error rates are each his raw rate shrunk to the population
 * rate (`shrunkRate`); `rho` is only the state-relative volume multiplier.
 *
 * Evidence and grade: docs/evidence/2026-09-23/living-01a-activity-model.md, fit on
 * Sleeper 2021-22 by scripts/living01a-fit.mjs, graded on 2023 and 2024 separately.
 * Post-loss "tilt" is NOT modelled: two R&D lenses found no population effect.
 *
 * This file has two halves:
 *   1. pure math (no database): the filter, the EM fit, the checkout probability and
 *      the shrunk rates. The fit script grades exactly these functions.
 *   2. the engine producer 'activity' on the ONE ENGINE spine v2 (ENGINE-ARCHITECTURE
 *      §4.1, §11.5). It reads engine_events only, through getEvents with a cutoff and a
 *      season window: `espn.transaction` (the ADD items #203's manager-signals counts),
 *      `manager.signal` (#203's dead starts, per scoring period, never the latest row)
 *      and `source.coverage` (a week the transactions collector did not cover reads
 *      adds = null, never 0). It always computes and writes `activity.manager` under
 *      the model version (lane shadow until a promotion PR edits VERSIONS) and the
 *      fallback field `activity.population` under the active version. The flag
 *      GRIDIRON_LIVING01A_ENABLED (or preview-mode.js, PREVIEW-01) only lets a reader
 *      show the shadow rows (readActivityManager); it never changes lanes.
 */
import { registerProducer } from './registry.js';

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

/**
 * Versions (ENGINE-ARCHITECTURE §6.2). Promotion is a PR that edits this line, with the
 * grade report (§6.3): `{ active: 'living01a-1', shadow: [] }`. Until then the model
 * `living01a-1` runs in lane `shadow` (rows written and graded, never served by default)
 * and the active version `activity-population-1` writes only the fallback field
 * `activity.population` (the fitted population prior, in lane `live`). Nothing at runtime
 * moves a version; GRIDIRON_LIVING01A_ENABLED / preview only change what a reader shows.
 */
export const VERSIONS = Object.freeze({ active: 'activity-population-1', shadow: Object.freeze([MODEL_VERSION]) });

const FIT_REF = 'docs/evidence/2026-09-23/living-01a-activity-model.md';
const TRAINING_WINDOW = Object.freeze({ source: 'Sleeper 2021-22', from: '2021-09-01', to: '2023-01-15' });
const POPULATION_PARAMS = Object.freeze({ pi: FITTED_PARAMS.pi, popAddRate: FITTED_PARAMS.popAddRate,
  popTradeRate: FITTED_PARAMS.popTradeRate, popErrRate: FITTED_PARAMS.popErrRate });

// The one writer of activity.manager and activity.population. Module-private: never exported.
const WRITERS = registerProducer({ name: 'activity',
  active: VERSIONS.active,
  shadow: VERSIONS.shadow,
  versions: {
    [MODEL_VERSION]: { params: FITTED_PARAMS, fitId: FITTED_PARAMS.fit, fit_ref: FIT_REF, training_window: TRAINING_WINDOW },
    'activity-population-1': { params: POPULATION_PARAMS, fitId: FITTED_PARAMS.fit, fit_ref: FIT_REF, training_window: TRAINING_WINDOW },
  },
  fields: [
    { field: 'activity.manager', valueType: 'state', space: 'prob', entityTypes: ['league_team'], maxAgeSec: 3600,
      tolerance: 0.005, fallbackField: 'activity.population', checks: ['probs_sum_1', 'no_nan'],
      replaces: ['counterparty-pricing.js#checkedOutFactor'],
      description: 'Per manager: engagement state (engaged/drifting/checked_out), next-week add and lineup-error '
        + 'probabilities, and shrunk add/trade/lineup-error rates (LIVING-01a)' },
    { field: 'activity.population', valueType: 'state', space: 'prob', entityTypes: ['league'], maxAgeSec: 3600,
      tolerance: 0.005, checks: ['probs_sum_1', 'no_nan'],
      description: "The population prior a manager with no evidence gets (state probabilities and rates): activity.manager's fallback" },
  ],
  inputs: { events: ['espn.transaction', 'manager.signal', 'source.coverage'], fields: ['league.week', 'league.rules'],
    scope: 'league_team', schedule: 'tick', budget_ms: 2000,
    note: 'season, through, weeksLeft are caller-supplied until the league producer (EA-02) writes league.week' },
});

/**
 * Whether a reader may SHOW shadow rows: GRIDIRON_LIVING01A_ENABLED=1, or the preview
 * switch (preview-mode.js#previewUnconfirmed, PREVIEW-01) when that module is present.
 * Display only: the producer computes and writes shadow rows either way.
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

const PREVIEW_REASON = 'LIVING-01a engagement state: shadow version, graded on Sleeper 2023-24, not yet confirmed on ESPN leagues';

/** The job whose sync_log runs are the ESPN transactions collector's coverage. */
export const TX_COVERAGE_JOB = 'league_transactions';
/** ESPN's transactions feed returns about the last 3 days, so one run covers [t - 3 days, t]. */
export const TX_COVERAGE_HORIZON_MS = 3 * 86400000;
const DAY_MS = 86400000;

const isoDate = ms => new Date(ms).toISOString().slice(0, 10);

/** 23:59:59.999 America/New_York on a bare date (events.js#endOfDayEastern, kept here so the
 * pure half never opens the database through events.js). */
function endOfDayEastern(date) {
  const [y, m, d] = date.split('-').map(Number);
  const noonUtc = Date.UTC(y, m - 1, d, 16);
  const hourNy = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' })
    .format(new Date(noonUtc)));
  return new Date(Date.UTC(y, m - 1, d, 23 + (16 - hourNy), 59, 59, 999)).toISOString();
}

/**
 * The window [start, end) of NFL week `week` of `season`: Tuesday 00:00 ET after Labor
 * Day, plus 7 days per week. Caller-overridable (`weekWindows`) until the calendar
 * producer (EA-02) writes nfl.week.
 */
export function nflWeekWindow(season, week) {
  const sep1 = Date.UTC(Number(season), 8, 1);
  const laborDay = sep1 + ((8 - new Date(sep1).getUTCDay()) % 7) * DAY_MS; // first Monday of September
  const mondayBefore = w => isoDate(laborDay + 7 * (w - 1) * DAY_MS);
  const after = d => new Date(Date.parse(endOfDayEastern(d)) + 1).toISOString(); // Tuesday 00:00 ET
  return { start: after(mondayBefore(week)), end: after(mondayBefore(week + 1)) };
}

/**
 * Which weeks 1..through the transactions collector covered, as of `cutoff`: a week is
 * covered only when the union of [t - horizon, t] over successful `source.coverage` runs
 * t <= cutoff spans the whole week (clipped at the cutoff). Any hole -> the week's adds
 * are UNKNOWN (null), never zero. Pure, so the test pins it.
 */
export function coveredWeeks(coverageEvents, season, through, cutoff, {
  job = TX_COVERAGE_JOB, horizonMs = TX_COVERAGE_HORIZON_MS, weekWindows = null,
} = {}) {
  const cut = Date.parse(cutoff);
  const runs = coverageEvents
    .filter(e => (e.payload?.job ?? null) === job && e.payload?.status === 'ok')
    .map(e => Date.parse(e.as_of))
    .filter(t => Number.isFinite(t) && t <= cut)
    .sort((a, b) => a - b);
  const covered = new Set();
  for (let w = 1; w <= through; w++) {
    const win = weekWindows?.get?.(w) ?? nflWeekWindow(season, w);
    const a = Date.parse(win.start);
    const b = Math.min(Date.parse(win.end), cut);
    if (!(b > a)) continue; // the week has not started at the cutoff
    let reach = a; // covered up to here
    for (const t of runs) {
      if (t < reach) continue;
      if (t - horizonMs > reach) break; // a hole before this run
      reach = t;
      if (reach >= b) break;
    }
    if (reach >= b) covered.add(w);
  }
  return covered;
}

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

/** The #203 metric the dead starts come from; its signal for period p describes week p - 1. */
export const DEAD_START_METRIC = 'lineup_dead_starts_last_week';

/**
 * Dead starts per team and week from `manager.signal` events read as of the cutoff.
 * #203 computes the metric for the last COMPLETED period (its scoring period - 1), and
 * the signal adapter keys each event by the league's scoring period at capture, so the
 * event for period p is week p - 1's value. A week with no signal event at or before
 * the cutoff is unknown (absent). The latest event per (team, week) wins. Pure.
 * Returns Map(team -> Map(week -> {dead, id})).
 */
export function deadStartsFromSignals(events, through) {
  const out = new Map();
  for (const ev of events) {
    const p = ev.payload ?? {};
    if (p.metric !== DEAD_START_METRIC) continue;
    const period = Number(p.scoring_period);
    const week = period - 1;
    if (!(Number.isInteger(period) && week >= 1 && week <= through)) continue;
    const value = Number(p.value);
    if (!Number.isFinite(value) || ev.team_id == null) continue;
    const team = String(ev.team_id);
    const t = out.get(team) ?? out.set(team, new Map()).get(team);
    t.set(week, { dead: value, id: ev.id }); // events arrive oldest first: the latest wins
  }
  return out;
}

const pct = x => `${Math.round(x * 100)}%`;

/** Probabilities rounded to 4 places that still sum to exactly 1 (the probs_sum_1 check). */
function roundProbs(probs) {
  const r = probs.map(p => Math.round(p * 1e4) / 1e4);
  const top = probs.indexOf(Math.max(...probs));
  r[top] = Math.round((1 - r.reduce((a, x, i) => (i === top ? a : a + x), 0)) * 1e4) / 1e4;
  return Object.fromEntries(STATES.map((n, i) => [n, r[i]]));
}

/**
 * One manager's state from his weekly series. `weeks[i]` is week i+1:
 * { adds: int|null, err: 0|1|null, byeFrac?: number|null, addIds?: int[], errIds?: int[] }.
 * Returns the engine_state value and its reason chain v2 (space 'prob', not additive:
 * posterior moves do not add; each week's contribution is a counterfactual, the change in
 * P(called state) had that week been unknown). Contributions cite only their own events.
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
    probs: roundProbs(post),
    next_week: {
      p_any_add: +pAnyAdd.toFixed(4),
      adds_mean: +next.reduce((a, p, i) => a + p * rho * params.lam[i], 0).toFixed(4),
      p_lineup_error: +next.reduce((a, p, i) => a + p * errorProb(params, i, null), 0).toFixed(4),
      lineup_error_bye_adjusted: false,
    },
    rates: {
      adds_per_week: knownAdds.length
        ? { value: +shrunkRate(addsSeen, knownAdds.length, params.popAddRate, params.alpha).toFixed(4), raw: +(addsSeen / knownAdds.length).toFixed(4), weeks: knownAdds.length }
        : { value: null, absence: 'unknown: no week with collector coverage' },
      trades_per_week: knownAdds.length
        ? { value: +shrunkRate(trades, knownAdds.length, params.popTradeRate, RATE_PRIOR_WEEKS).toFixed(4), raw: trades, weeks: knownAdds.length }
        : { value: null, absence: 'unknown: no week with collector coverage' },
      lineup_error_rate: errWeeks.length
        ? { value: +shrunkRate(errSeen, errWeeks.length, params.popErrRate, RATE_PRIOR_WEEKS).toFixed(4), raw: errSeen, weeks: errWeeks.length }
        : { value: null, absence: 'unknown: no graded lineup week' },
    },
    p_no_more_adds: weeksLeft > 0 ? +pNoMoreAdds(params, next, rho, weeksLeft).toFixed(4) : null,
    weeks_seen: weeks.length,
    weeks_unknown_adds: weeks.length - knownAdds.length,
  };
  const contributions = [];
  // The last two weeks' evidence: what P(called state) would be had that week been unknown.
  const tail = Math.max(0, weeks.length - 2);
  for (let t = tail; t < weeks.length; t++) {
    const wk = weeks[t];
    const without = filterSeason(params, weeks.map((w, i) => (i === t ? { ...w, adds: null, err: null } : w))).final.post;
    const move = post[s] - without[s];
    const addTxt = wk.adds == null ? 'adds unknown (no collector coverage)' : `${wk.adds} add${wk.adds === 1 ? '' : 's'}`;
    const errTxt = wk.err == null ? '' : wk.err ? ', started a dead or empty slot' : ', full lineup';
    contributions.push({ source: 'espn.transaction', kind: 'event', event_ids: [...(wk.addIds ?? []), ...(wk.errIds ?? [])],
      delta: +move.toFixed(4),
      text: `${STATES[s]}: week ${t + 1} ${addTxt}${errTxt} (${move >= 0 ? '+' : ''}${move.toFixed(2)} vs that week unknown)` });
  }
  const quiet = knownAdds.length >= 2 && weeks.slice(-2).every(w => w.adds === 0);
  if (quiet) {
    contributions.push({ source: 'activity.state', kind: 'state', event_ids: [], delta: +post[2].toFixed(4),
      text: `${STATES[s]}: 0 adds in 2 weeks; P(checked out) ${pct(post[2])}` });
  }
  contributions.push({ source: 'activity.shrinkage', kind: 'model', event_ids: [], delta: +(rho - 1).toFixed(4),
    text: `own add volume x${rho.toFixed(2)} vs a manager in the same state (${addsSeen} adds over ${knownAdds.length} weeks, `
      + `shrunk with ${params.alpha} weeks of league prior)` });
  if (!errWeeks.length) {
    contributions.push({ source: 'manager.signal', kind: 'event', event_ids: [], delta: null,
      text: 'lineup errors unknown: no dead-start signal for a completed week was read for this manager' });
  }
  return {
    value,
    reasonChain: {
      v: 2, space: 'prob', additive: false,
      baseline: { value: +params.pi[s].toFixed(4), source: 'activity.prior', text: `population prior P(${STATES[s]}) ${pct(params.pi[s])}` },
      contributions,
    },
  };
}

/** The population prior (activity.population): what a manager with no evidence gets. */
export function populationState(params = FITTED_PARAMS) {
  const s = params.pi.indexOf(Math.max(...params.pi));
  return {
    value: {
      state: STATES[s],
      probs: roundProbs(params.pi),
      rates: { adds_per_week: params.popAddRate, trades_per_week: params.popTradeRate, lineup_error_rate: params.popErrRate },
      fit: params.fit,
    },
    reasonChain: { v: 2, space: 'prob', additive: false,
      baseline: { value: +params.pi[s].toFixed(4), source: 'activity.prior', text: `population prior fitted on ${params.fit}` },
      contributions: [] },
  };
}

const EVENT_LIMIT = 50000; // getEvents' ceiling: it THROWS past it, never truncates silently

/** The season's read window: July 1 of the season (covers the draft and preseason moves). */
export const seasonFrom = season => `${Number(season)}-07-01T00:00:00.000Z`;

/**
 * Everything the producer reads for one league, as of `asOf`, through `getEvents` only
 * (engine_events: no source table). Returns { cutoff, covered, weeksByTeam, tradesByTeam }.
 */
export async function activityInputs({ leagueId, season, through, asOf, weekWindows = null }, database = null) {
  const { db: appDb } = await import('../../db/index.js');
  const { getEvents, normalizeAsOf } = await import('./events.js');
  const dbh = database ?? appDb;
  const cutoff = normalizeAsOf(asOf);
  const from = seasonFrom(season);
  const tx = getEvents({ asOf: cutoff, from, leagueId, types: ['espn.transaction'], limit: EVENT_LIMIT }, dbh);
  const signals = getEvents({ asOf: cutoff, from, leagueId, types: ['manager.signal'], limit: EVENT_LIMIT }, dbh);
  const coverage = getEvents({ asOf: cutoff, from, types: ['source.coverage'], entities: [`source:${TX_COVERAGE_JOB}`],
    limit: EVENT_LIMIT }, dbh);
  const act = weeklyActivityFromEvents(tx, season, through);
  const dead = deadStartsFromSignals(signals, through);
  const covered = coveredWeeks(coverage, season, through, cutoff, { weekWindows });
  const teams = [...new Set([...signals.map(e => e.team_id).filter(t => t != null).map(String), ...act.adds.keys(),
    ...act.trades.keys()])].sort();
  const weeksByTeam = new Map();
  const tradesByTeam = new Map();
  for (const team of teams) {
    const weeks = [];
    let trades = 0;
    for (let w = 1; w <= through; w++) {
      const known = covered.has(w);
      const cell = known ? act.adds.get(team)?.get(w) : null;
      const d = dead.get(team)?.get(w);
      weeks.push({ adds: known ? (cell?.n ?? 0) : null, addIds: cell?.ids ?? [],
        err: d == null ? null : d.dead > 0 ? 1 : 0, errIds: d == null ? [] : [d.id], byeFrac: null });
      if (known) trades += act.trades.get(team)?.get(w)?.n ?? 0;
    }
    weeksByTeam.set(team, weeks);
    tradesByTeam.set(team, trades);
  }
  return { cutoff, covered, weeksByTeam, tradesByTeam };
}

/**
 * The engine producer 'activity' for one ESPN league, as of `asOf`. Always computes;
 * writes `activity.manager` (one row per team) under the model version, whose lane the
 * registry decides (shadow until promoted), and `activity.population` (one league row)
 * under the active version. `season`, `through` (last completed scoring period) and
 * `weeksLeft` are caller-supplied until EA-02's league producer writes league.week.
 * Returns { written, unchanged, skipped, lane, teams, population }.
 */
export async function produceActivityStates({ leagueId, season, through, asOf = new Date(), weeksLeft = null,
  weekWindows = null, database = null } = {}) {
  if (!(Number(through) >= 1)) throw new Error('produceActivityStates needs through (the last completed scoring period) >= 1');
  const { db: appDb } = await import('../../db/index.js');
  const { writeState } = await import('./state.js');
  const dbh = database ?? appDb;
  const { cutoff, weeksByTeam, tradesByTeam } = await activityInputs({ leagueId, season, through, asOf, weekWindows }, dbh);
  const tally = { written: 0, unchanged: 0, skipped: 0 };
  const count = r => { if (r.written) tally.written++; else if (r.unchanged) tally.unchanged++; else tally.skipped++; };
  let lane = null;
  const out = [];
  for (const [team, weeks] of weeksByTeam) {
    const { value, reasonChain } = managerState(weeks, { trades: tradesByTeam.get(team), weeksLeft });
    const eventIds = [...new Set(weeks.flatMap(w => [...w.addIds, ...w.errIds]))];
    const r = writeState({ entityType: 'league_team', entityId: `${leagueId}:${team}`, field: 'activity.manager',
      value, asOf: cutoff, writer: WRITERS['activity.manager'], producerVersion: MODEL_VERSION, reasonChain, eventIds,
      leagueId: Number(leagueId) }, dbh);
    count(r);
    lane = r.lane;
    out.push({ team, state: value.state, weeks: weeks.map(w => ({ adds: w.adds, err: w.err })) });
  }
  const pop = populationState();
  const p = writeState({ entityType: 'league', entityId: String(Number(leagueId)), field: 'activity.population',
    value: pop.value, asOf: cutoff, writer: WRITERS['activity.population'], producerVersion: VERSIONS.active,
    reasonChain: pop.reasonChain, leagueId: Number(leagueId) }, dbh);
  return { ...tally, lane, teams: out, population: { written: p.written, lane: p.lane } };
}

/**
 * What a reader shows for one manager: the live row; else, when the flag or preview is
 * on, the shadow row labelled preview; else the population fallback. Never writes.
 * Returns { status: 'ok'|'preview'|'fallback'|'unknown', row, preview_reason? }.
 */
export async function readActivityManager({ leagueId, team, asOf = new Date() }, database = null) {
  const { db: appDb } = await import('../../db/index.js');
  const { getState } = await import('./state.js');
  const dbh = database ?? appDb;
  const id = `${leagueId}:${team}`;
  const live = getState('league_team', id, 'activity.manager', { asOf, leagueId }, dbh);
  if (live) return { status: 'ok', row: live };
  if ((await activityEnabled()).on) {
    const shadow = getState('league_team', id, 'activity.manager', { asOf, leagueId, lane: 'shadow', version: MODEL_VERSION }, dbh);
    if (shadow) return { status: 'preview', row: shadow, preview_reason: PREVIEW_REASON };
  }
  const pop = getState('league', String(Number(leagueId)), 'activity.population', { asOf, leagueId }, dbh);
  return pop ? { status: 'fallback', row: pop } : { status: 'unknown', row: null };
}
