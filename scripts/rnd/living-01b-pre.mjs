#!/usr/bin/env node
/**
 * LIVING-01b PRE kill test (FIX-261-2), as pre-registered in
 * docs/evidence/2026-09-24/living-01b-pre-preregistration.md.
 *
 *   node scripts/rnd/living-01b-pre.mjs --corpus ~/gridiron-local/rnd/skill/team_seasons.sqlite
 *
 * Fit g (points per claim) and L (points per lineup-error week) on Sleeper 2021-22; grade
 * 2023 and 2024 separately from week 7: the living arm (LIVING-01a's engagement chain,
 * claims and lineup errors, team level) against the frozen arm (keeps scoring what it
 * scored) on the log score of real playoff and title outcomes. Both arms share every
 * normal draw. Read-only on the corpus; seasons 2021-24 only (2025 stays closed).
 * No league, roster or manager ids are printed.
 */
import { DatabaseSync } from 'node:sqlite';
import { ACTIVITY_PARAMS as P } from '../../server/services/living-league.js';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const corpusPath = arg('--corpus');
if (!corpusPath) { console.error('usage: --corpus <team_seasons.sqlite>'); process.exit(2); }
const RUNS = Number(arg('--runs') ?? 1000);
const CUT = 6;                      // weeks 1-6 known; graded from week 7
const FIT_SEASONS = [2021, 2022];
const HOLDOUT = [2023, 2024];
const BOOT = 1000;
const SHRINK_WEEKS = 6;
const RHO_MIN = 0.25, RHO_MAX = 4;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normal(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function poisson(r, lam) {
  if (lam <= 0) return 0;
  const L = Math.exp(-lam); let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const f = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : 'NA');
const sigmoid = x => 1 / (1 + Math.exp(-x));
const pErr = P.errLogit.map(sigmoid);

/* ------------------------------------------------------------------ load */
const c = new DatabaseSync(corpusPath, { readOnly: true });
const filt = ['league_dead', 'late_start', 'team_inactive', 'idp'].map(x => `AND COALESCE(${x},0) = 0`).join(' ');
const ts = c.prepare(`SELECT lg, season, roster_id, playoff_week_start AS pws, made_playoffs AS po, champion AS champ
  FROM team_seasons WHERE season BETWEEN 2021 AND 2024 AND source = 'sleeper' ${filt}`).all();
if (ts.some(t => t.season > 2024 || t.season < 2021)) throw new Error('season filter broken: 2025 must stay closed');
const tw = c.prepare(`SELECT lg, roster_id, week, points, opp_roster_id AS opp, opp_points, dead_starts AS dead, empty_starts AS empty
  FROM team_weeks WHERE season BETWEEN 2021 AND 2024`).all();
const addRows = c.prepare('SELECT lg, roster_id, leg_week FROM adds WHERE season BETWEEN 2021 AND 2024').all();
c.close();

const leagues = new Map();
for (const t of ts) {
  const L = leagues.get(t.lg) ?? leagues.set(t.lg, { season: t.season, pws: t.pws, teams: new Map() }).get(t.lg);
  L.teams.set(String(t.roster_id), { po: Number(t.po) ? 1 : 0, champ: Number(t.champ) ? 1 : 0, weeks: new Map(), adds: new Map() });
}
for (const r of tw) {
  const T = leagues.get(r.lg)?.teams.get(String(r.roster_id));
  if (T && r.points != null) T.weeks.set(r.week, { ...r, err: (Number(r.dead) || 0) + (Number(r.empty) || 0) > 0 ? 1 : 0 });
}
for (const r of addRows) {
  const T = leagues.get(r.lg)?.teams.get(String(r.roster_id));
  if (T) T.adds.set(r.leg_week, (T.adds.get(r.leg_week) ?? 0) + 1);
}

/* ------------------------------------------------------------------ fit g, L (2021-22) */
// Two-way within: points, cumulative adds and err demeaned by league-week, then by team-season.
const X = [], Y = [], G = [];
for (const [lg, L] of leagues) {
  if (!FIT_SEASONS.includes(L.season)) continue;
  const last = L.pws - 1;
  const rows = [];
  for (const [rid, T] of L.teams) {
    let cum = 0;
    for (let w = 1; w <= last; w++) {
      cum += T.adds.get(w) ?? 0;
      const r = T.weeks.get(w);
      if (r) rows.push({ rid, w, y: r.points, a: cum, e: r.err });
    }
  }
  const demean = (key, fields) => {
    const g = new Map();
    for (const r of rows) { const k = r[key]; const s = g.get(k) ?? { n: 0, y: 0, a: 0, e: 0 }; s.n++; for (const x of fields) s[x] += r[x]; g.set(k, s); }
    for (const r of rows) { const s = g.get(r[key]); for (const x of fields) r[x] -= s[x] / s.n; }
  };
  demean('w', ['y', 'a', 'e']);
  demean('rid', ['y', 'a', 'e']);
  for (const r of rows) { X.push([r.a, r.e]); Y.push(r.y); G.push(lg); }
}
function ols(X, Y, G) {
  let a = 0, b = 0, d = 0, u = 0, v = 0;
  for (let i = 0; i < X.length; i++) {
    const [x1, x2] = X[i];
    a += x1 * x1; b += x1 * x2; d += x2 * x2; u += x1 * Y[i]; v += x2 * Y[i];
  }
  const det = a * d - b * b;
  const inv = [[d / det, -b / det], [-b / det, a / det]];
  const beta = [inv[0][0] * u + inv[0][1] * v, inv[1][0] * u + inv[1][1] * v];
  const score = new Map();
  for (let i = 0; i < X.length; i++) {
    const e = Y[i] - beta[0] * X[i][0] - beta[1] * X[i][1];
    const s = score.get(G[i]) ?? [0, 0];
    s[0] += X[i][0] * e; s[1] += X[i][1] * e; score.set(G[i], s);
  }
  const M = [[0, 0], [0, 0]];
  for (const [s0, s1] of score.values()) { M[0][0] += s0 * s0; M[0][1] += s0 * s1; M[1][0] += s1 * s0; M[1][1] += s1 * s1; }
  const mul = (A, B) => [[A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],
    [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]]];
  const V = mul(mul(inv, M), inv);
  return { beta, se: [Math.sqrt(V[0][0]), Math.sqrt(V[1][1])] };
}
const fit = ols(X, Y, G);
const gRaw = fit.beta[0], LOSS = fit.beta[1];
const GAIN = Math.max(0, gRaw);
console.log(`FIT Sleeper ${FIT_SEASONS.join('-')}: n=${X.length} team-weeks, leagues=${new Set(G).size}`);
console.log(`  g (points per cumulative claim) = ${f(gRaw, 3)} (SE ${f(fit.se[0], 3)}) -> used ${f(GAIN, 3)}`);
console.log(`  L (points in a lineup-error week) = ${f(LOSS, 3)} (SE ${f(fit.se[1], 3)})`);

/* ------------------------------------------------------------------ helpers */
/** Week-6 state probabilities by the forward filter over weeks 1..CUT. */
function stateAtCut(T) {
  let a = [...P.pi];
  for (let w = 1; w <= CUT; w++) {
    if (w > 1) a = [0, 1, 2].map(j => a.reduce((s, ai, i) => s + ai * P.A[i][j], 0));
    const k = T.adds.get(w) ?? 0, e = T.weeks.get(w).err;
    const like = [0, 1, 2].map(s => {
      const pois = Math.exp(-P.lam[s]) * P.lam[s] ** k / factorial(k);
      return pois * (e ? pErr[s] : 1 - pErr[s]);
    });
    a = a.map((x, s) => x * like[s]);
    const z = a.reduce((s, x) => s + x, 0) || 1;
    a = a.map(x => x / z);
  }
  return a;
}
function factorial(n) { let x = 1; for (let i = 2; i <= n; i++) x *= i; return x; }
function sample(r, probs) { const u = r(); let acc = 0; for (let i = 0; i < probs.length; i++) { acc += probs[i]; if (u < acc) return i; } return probs.length - 1; }

function pairings(L, week) {
  const rows = [...L.teams].map(([rid, T]) => [rid, T.weeks.get(week)]).filter(([, r]) => r);
  const out = [], used = new Set();
  for (const [rid, r] of rows) {
    if (used.has(rid)) continue;
    const o = r.opp != null ? rows.find(([id]) => id === String(r.opp) && !used.has(id)) : null;
    if (!o) continue;
    used.add(rid); used.add(o[0]); out.push([rid, o[0]]);
  }
  return out;
}
function bracketOrder(B) {
  let o = [1];
  while (o.length < B) { const n = o.length * 2; o = o.flatMap(s => [s, n + 1 - s]); }
  return o;
}
function playBracket(seeds, draw) {
  let B = 1; while (B < seeds.length) B *= 2;
  let slots = bracketOrder(B).map(s => (s <= seeds.length ? seeds[s - 1] : null));
  for (let round = 0; slots.length > 1; round++) {
    const next = [];
    for (let i = 0; i < slots.length; i += 2) {
      const a = slots[i], b = slots[i + 1];
      if (a == null || b == null) { next.push(a ?? b); continue; }
      next.push(draw(a, round) >= draw(b, round) ? a : b);
    }
    slots = next;
  }
  return slots[0];
}

/* ------------------------------------------------------------------ grade */
const ARMS = ['frozen', 'living', 'errors_only'];

function gradeLeague(L, seed) {
  const last = L.pws - 1;
  if (last < CUT + 2) return null;
  const ids = [...L.teams.keys()];
  const T = ids.map(id => L.teams.get(id));
  if (T.some(t => { for (let w = 1; w <= CUT; w++) if (!t.weeks.get(w)) return true; return false; })) return null;
  const N = T.reduce((s, t) => s + t.po, 0);
  if (ids.length < 4 || !(N > 0 && N < ids.length)) return null;
  const m = T.map(t => mean([...Array(CUT)].map((_, i) => t.weeks.get(i + 1).points)));
  const h = T.map(t => mean([...Array(CUT)].map((_, i) => t.weeks.get(i + 1).err)));
  const resid = [];
  T.forEach((t, i) => { for (let w = 1; w <= CUT; w++) resid.push(t.weeks.get(w).points - m[i]); });
  const sd = Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / Math.max(1, resid.length - ids.length));
  const probs = T.map(stateAtCut);
  const rho = T.map(t => {
    let a = 0; for (let w = 1; w <= CUT; w++) a += t.adds.get(w) ?? 0;
    const shrunk = (a + SHRINK_WEEKS * P.popAddRate) / (CUT + SHRINK_WEEKS);
    return Math.min(RHO_MAX, Math.max(RHO_MIN, shrunk / P.popAddRate));
  });
  const w0 = T.map(t => {
    let w = 0, pf = 0;
    for (let k = 1; k <= CUT; k++) { const r = t.weeks.get(k); pf += r.points; w += r.points > r.opp_points ? 1 : r.points === r.opp_points ? 0.5 : 0; }
    return { w, pf };
  });
  const sched = [];
  for (let w = CUT + 1; w <= last; w++) {
    const p = pairings(L, w);
    if (p.length * 2 < ids.length - 1) return null;
    sched.push(p);
  }
  const idx = new Map(ids.map((id, i) => [id, i]));
  const champs = T.reduce((s, t) => s + t.champ, 0);
  const gradeTitle = champs === 1;
  let B = 1; while (B < N) B *= 2;
  const rounds = Math.log2(B);
  const weeksTotal = sched.length + rounds;
  const po = Object.fromEntries(ARMS.map(a => [a, new Array(ids.length).fill(0)]));
  const ti = Object.fromEntries(ARMS.map(a => [a, new Array(ids.length).fill(0)]));
  const r = rng(seed), rb = rng((seed ^ 0x9E3779B9) >>> 0), rl = rng((seed ^ 0x85EBCA6B) >>> 0);
  for (let run = 0; run < RUNS; run++) {
    // Each team's living script for the rest of the season (regular weeks, then rounds).
    const shift = T.map((_, i) => {
      let s = sample(rl, probs[i]);
      let cum = 0;
      const liv = [], err = [];
      for (let k = 0; k < weeksTotal; k++) {
        s = sample(rl, P.A[s]);
        cum += poisson(rl, rho[i] * P.lam[s]);
        const e = rl() < pErr[s] ? 1 : 0;
        liv.push(GAIN * cum + LOSS * (e - h[i]));
        err.push(LOSS * (e - h[i]));
      }
      return { living: liv, errors_only: err };
    });
    const rec = Object.fromEntries(ARMS.map(a => [a, w0.map(x => ({ ...x }))]));
    sched.forEach((week, k) => {
      const z = ids.map(() => normal(r));
      for (const arm of ARMS) {
        const s = ids.map((_, i) => m[i] + sd * z[i] + (arm === 'frozen' ? 0 : shift[i][arm][k]));
        const R = rec[arm];
        for (const [a, b] of week) {
          const ia = idx.get(a), ib = idx.get(b);
          R[ia].pf += s[ia]; R[ib].pf += s[ib];
          if (s[ia] > s[ib]) R[ia].w++; else if (s[ib] > s[ia]) R[ib].w++; else { R[ia].w += 0.5; R[ib].w += 0.5; }
        }
      }
    });
    const zb = Array.from({ length: rounds }, () => ids.map(() => normal(rb)));
    for (const arm of ARMS) {
      const R = rec[arm];
      const order = ids.map((_, i) => i).sort((x, y) => R[y].w - R[x].w || R[y].pf - R[x].pf);
      const seeds = order.slice(0, N);
      for (const i of seeds) po[arm][i]++;
      if (gradeTitle) {
        const champ = playBracket(seeds, (i, k) => m[i] + sd * zb[k][i]
          + (arm === 'frozen' ? 0 : shift[i][arm][sched.length + k]));
        ti[arm][champ]++;
      }
    }
  }
  const p = hits => (hits + 0.5) / (RUNS + 1);
  const logs = (hits, y) => y * Math.log(p(hits)) + (1 - y) * Math.log(1 - p(hits));
  const out = { teams: ids.length, titleTeams: gradeTitle ? ids.length : 0 };
  for (const arm of ARMS) {
    out[`po_log_${arm}`] = T.reduce((s, t, i) => s + logs(po[arm][i], t.po), 0);
    out[`po_brier_${arm}`] = T.reduce((s, t, i) => s + (po[arm][i] / RUNS - t.po) ** 2, 0);
    out[`ti_log_${arm}`] = gradeTitle ? T.reduce((s, t, i) => s + logs(ti[arm][i], t.champ), 0) : 0;
    out[`ti_brier_${arm}`] = gradeTitle ? T.reduce((s, t, i) => s + (ti[arm][i] / RUNS - t.champ) ** 2, 0) : 0;
  }
  return out;
}

function summarise(label, rows) {
  const sum = rs => {
    const s = {};
    for (const x of rs) for (const [k, v] of Object.entries(x)) s[k] = (s[k] ?? 0) + v;
    return s;
  };
  // log: living - frozen (positive = living better); Brier: frozen - living (positive = living better).
  const deltas = s => ({
    po_log: (s.po_log_living - s.po_log_frozen) / s.teams,
    ti_log: s.titleTeams ? (s.ti_log_living - s.ti_log_frozen) / s.titleTeams : NaN,
    po_brier: (s.po_brier_frozen - s.po_brier_living) / s.teams,
    ti_brier: s.titleTeams ? (s.ti_brier_frozen - s.ti_brier_living) / s.titleTeams : NaN,
    po_log_err: (s.po_log_errors_only - s.po_log_frozen) / s.teams,
    ti_log_err: s.titleTeams ? (s.ti_log_errors_only - s.ti_log_frozen) / s.titleTeams : NaN,
  });
  const S = sum(rows), D = deltas(S);
  const r = rng(4601);
  const boot = Object.fromEntries(Object.keys(D).map(k => [k, []]));
  for (let b = 0; b < BOOT; b++) {
    const d = deltas(sum(Array.from({ length: rows.length }, () => rows[Math.floor(r() * rows.length)])));
    for (const k of Object.keys(D)) if (Number.isFinite(d[k])) boot[k].push(d[k]);
  }
  const ci = k => [pct(boot[k], 0.05), pct(boot[k], 0.95)];
  const res = { leagues: rows.length, teams: S.teams, title_leagues: rows.filter(x => x.titleTeams).length,
    frozen_po_log: S.po_log_frozen / S.teams, frozen_ti_log: S.ti_log_frozen / S.titleTeams };
  for (const k of Object.keys(D)) res[k] = { est: +D[k].toFixed(5), ci90: ci(k).map(x => +x.toFixed(5)) };
  console.log(`\nHELD OUT ${label}: leagues=${res.leagues} teams=${res.teams} title leagues=${res.title_leagues}`);
  console.log(`  frozen mean log score: playoff ${f(res.frozen_po_log)}  title ${f(res.frozen_ti_log)}`);
  for (const [k, name] of [['po_log', 'playoff log score'], ['ti_log', 'title log score'], ['po_brier', 'playoff Brier'],
    ['ti_brier', 'title Brier'], ['po_log_err', 'playoff log, errors only'], ['ti_log_err', 'title log, errors only']]) {
    console.log(`  ${name.padEnd(26)} delta ${f(res[k].est, 5)}  90% [${f(res[k].ci90[0], 5)}, ${f(res[k].ci90[1], 5)}]`);
  }
  res.pass = res.po_log.ci90[0] > 0 && res.ti_log.ci90[0] > 0;
  return res;
}

const out = {};
const dropped = {};
let k = 1;
for (const season of HOLDOUT) {
  const rows = [];
  for (const [, L] of leagues) {
    if (L.season !== season) continue;
    const g = gradeLeague(L, 7919 * k++);
    if (g) rows.push(g); else dropped[season] = (dropped[season] ?? 0) + 1;
  }
  out[season] = summarise(String(season), rows);
}
const pass = HOLDOUT.every(s => out[s].pass);
console.log(`\nleagues dropped (short season, missing weeks 1-6, pairings not recoverable, no playoff count): ${JSON.stringify(dropped)}`);
console.log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'} (rule: playoff AND title log-score delta 90% lower bound > 0, in 2023 AND 2024)`);
console.log(`\nLIVING01B_PRE ${JSON.stringify({ cut: CUT, runs: RUNS, g_raw: +gRaw.toFixed(4), g: +GAIN.toFixed(4),
  L: +LOSS.toFixed(4), se: fit.se.map(x => +x.toFixed(4)), fit_n: X.length, holdout: out, pass })}`);
