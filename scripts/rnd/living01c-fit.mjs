#!/usr/bin/env node
/**
 * LIVING-01c fit + held-out grade: the activity-adjusted team mean (R&D r25 IDEA-046).
 *
 *   node scripts/rnd/living01c-fit.mjs --corpus ~/gridiron-local/rnd/skill/team_seasons.sqlite
 *
 * Read-only on the corpus. Seasons 2021-24 only (asserted: 2025 stays closed).
 * No league, roster or user ids are printed.
 *
 * Definitions match the live signals (manager-signals.js) the sim reads:
 *   adds  = adds with leg_week <= c, divided by c       (tx_adds_per_week)
 *   dead  = team_weeks.dead_starts in week c              (lineup_dead_starts_last_week)
 * Frozen mean m = the team's mean points over weeks 1..c (the corpus has no projections,
 * so "frozen roster" is "keeps scoring what it has scored").
 *
 * FIT (2021-22): at cuts c = 4..9, y = mean(points c+1..c+5, regular season) - m.
 *   x and y demeaned within league-cut (the live shift is league-centred), OLS without
 *   an intercept; league-clustered SEs.
 * GRADE (2023 and 2024 separately, cut c = 9):
 *   points MSE over weeks 10-14, frozen m vs m + shift (shift league-centred, clamped)
 *   playoff Brier: each league's remaining regular season played RUNS times with
 *   N(m [+ shift], league sd) on the real pairings, seeded wins then points-for, top N
 *   (N = the league's real playoff count). Both arms share every normal draw.
 *   Delta = frozen - adjusted, so positive means the adjusted mean is better.
 *   90% intervals: league bootstrap.
 */
import { DatabaseSync } from 'node:sqlite';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const corpusPath = arg('--corpus');
if (!corpusPath) { console.error('usage: --corpus <team_seasons.sqlite>'); process.exit(2); }
const RUNS = Number(arg('--runs') ?? 1000);
const CAP = Number(arg('--cap') ?? 10);
const MIN_WEEKS = 4;
const FIT_SEASONS = [2021, 2022];
const HOLDOUT = [2023, 2024];
const GRADE_CUT = 9;
const BOOT = 1000;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normal(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const f = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : 'NA');

const c = new DatabaseSync(corpusPath, { readOnly: true });
const cols = t => c.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name);
const TS = cols('team_seasons'), TW = cols('team_weeks'), AD = cols('adds');
console.log('schema team_seasons:', TS.join(','));
console.log('schema team_weeks:', TW.join(','));
console.log('schema adds:', AD.join(','));
const pick = (have, names) => names.find(n => have.includes(n)) ?? null;
const poCol = pick(TS, ['made_playoffs', 'playoffs', 'made_po', 'in_playoffs', 'playoff']);
const oppCol = pick(TW, ['opp_roster_id', 'opponent_roster_id', 'opp_id', 'opp']);
const deadCol = pick(TW, ['dead_starts']);
if (!poCol || !deadCol || !TW.includes('opp_points')) {
  console.error(`missing a needed column: playoff outcome ${poCol ?? 'NONE'}, dead_starts ${deadCol ?? 'NONE'}, opp_points ${TW.includes('opp_points')}`);
  process.exit(3);
}
const filt = ['league_dead', 'late_start', 'team_inactive', 'idp'].filter(x => TS.includes(x))
  .map(x => `AND COALESCE(${x},0) = 0`).join(' ');
const src = TS.includes('source') ? `AND source = 'sleeper'` : '';

const ts = c.prepare(`SELECT lg, season, roster_id, playoff_week_start AS pws, ${poCol} AS po FROM team_seasons
  WHERE season BETWEEN 2021 AND 2024 ${src} ${filt}`).all();
if (ts.some(t => t.season > 2024 || t.season < 2021)) throw new Error('season filter broken: 2025 must stay closed');
const tw = c.prepare(`SELECT lg, season, roster_id, week, points, opp_points, ${deadCol} AS dead
  ${oppCol ? `, ${oppCol} AS opp` : ''} FROM team_weeks WHERE season BETWEEN 2021 AND 2024`).all();
const addRows = c.prepare('SELECT lg, roster_id, leg_week FROM adds WHERE season BETWEEN 2021 AND 2024').all();
c.close();

// league-season -> { season, pws, teams: Map<roster, {po, weeks: Map<week,row>, adds: []}> }
const leagues = new Map();
for (const t of ts) {
  const L = leagues.get(t.lg) ?? leagues.set(t.lg, { season: t.season, pws: t.pws, teams: new Map() }).get(t.lg);
  L.teams.set(String(t.roster_id), { po: Number(t.po) ? 1 : 0, weeks: new Map(), adds: [] });
}
for (const r of tw) {
  const T = leagues.get(r.lg)?.teams.get(String(r.roster_id));
  if (T && r.points != null) T.weeks.set(r.week, r);
}
for (const r of addRows) leagues.get(r.lg)?.teams.get(String(r.roster_id))?.adds.push(r.leg_week);

/** Per-team features at cut c, or null when a week 1..c is missing. */
function features(T, cut) {
  const pts = [];
  for (let w = 1; w <= cut; w++) { const r = T.weeks.get(w); if (!r) return null; pts.push(r.points); }
  const dead = T.weeks.get(cut).dead;
  return { m: mean(pts), adds: T.adds.filter(w => w <= cut).length / cut, dead: dead == null ? null : Number(dead) };
}
function centred(vals) {
  const known = vals.filter(v => v != null);
  const mu = known.length ? mean(known) : 0;
  return vals.map(v => (v == null ? 0 : v - mu));
}

/* ------------------------------------------------------------------ fit */
const X = [], Y = [], G = [];
for (const [lg, L] of leagues) {
  if (!FIT_SEASONS.includes(L.season)) continue;
  const last = L.pws - 1;
  for (let cut = MIN_WEEKS; cut <= 9; cut++) {
    if (cut + 1 > last) continue;
    const ids = [], xa = [], xd = [], ys = [];
    for (const [rid, T] of L.teams) {
      const ft = features(T, cut); if (!ft) continue;
      const fut = [];
      for (let w = cut + 1; w <= Math.min(cut + 5, last); w++) { const r = T.weeks.get(w); if (r) fut.push(r.points); }
      if (!fut.length) continue;
      ids.push(rid); xa.push(ft.adds); xd.push(ft.dead); ys.push(mean(fut) - ft.m);
    }
    if (ids.length < 4) continue;
    const ca = centred(xa), cd = centred(xd), cy = centred(ys);
    for (let i = 0; i < ids.length; i++) { X.push([ca[i], cd[i]]); Y.push(cy[i]); G.push(lg); }
  }
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
  // league-clustered sandwich
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
const [bA, bD] = fit.beta;
console.log(`\nFIT Sleeper ${FIT_SEASONS.join('-')}: n=${X.length} team-cuts, leagues=${new Set(G).size}`);
console.log(`  per_add_per_week = ${f(bA, 3)} (SE ${f(fit.se[0], 3)})   per_dead_start = ${f(bD, 3)} (SE ${f(fit.se[1], 3)})`);

/* ------------------------------------------------------------------ grade */
function pairings(L, week) {
  const rows = [...L.teams].map(([rid, T]) => [rid, T.weeks.get(week)]).filter(([, r]) => r);
  const out = [], used = new Set();
  for (const [rid, r] of rows) {
    if (used.has(rid)) continue;
    let o = null;
    if (oppCol && r.opp != null) o = rows.find(([id]) => id === String(r.opp) && !used.has(id));
    else o = rows.find(([id, x]) => id !== rid && !used.has(id) && x.points === r.opp_points && x.opp_points === r.points);
    if (!o) continue;
    used.add(rid); used.add(o[0]); out.push([rid, o[0]]);
  }
  return out;
}

function gradeLeague(lg, L, seed) {
  const last = L.pws - 1;
  if (last < GRADE_CUT + 1) return null;
  const ids = [], ft = [];
  for (const [rid, T] of L.teams) { const x = features(T, GRADE_CUT); if (!x) return null; ids.push(rid); ft.push(x); }
  const N = [...L.teams.values()].reduce((s, T) => s + T.po, 0);
  if (ids.length < 4 || !(N > 0 && N < ids.length)) return null;
  const ca = centred(ft.map(x => x.adds)), cd = centred(ft.map(x => x.dead));
  const raw = ids.map((_, i) => bA * ca[i] + bD * cd[i]);
  const rawMu = mean(raw);
  const shift = raw.map(s => Math.max(-CAP, Math.min(CAP, s - rawMu)));
  const capped = raw.filter(s => Math.abs(s - rawMu) > CAP).length;
  // sd of weekly points around each team's own mean, weeks 1..c (known at the cut)
  const resid = [];
  ids.forEach((rid, i) => { for (let w = 1; w <= GRADE_CUT; w++) resid.push(L.teams.get(rid).weeks.get(w).points - ft[i].m); });
  const sd = Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / Math.max(1, resid.length - ids.length));
  // points MSE weeks 10-14
  let seF = 0, seA = 0, nW = 0;
  ids.forEach((rid, i) => {
    for (let w = GRADE_CUT + 1; w <= Math.min(14, last); w++) {
      const r = L.teams.get(rid).weeks.get(w); if (!r) continue;
      seF += (r.points - ft[i].m) ** 2; seA += (r.points - ft[i].m - shift[i]) ** 2; nW++;
    }
  });
  // records through the cut
  const w0 = new Map(ids.map(id => [id, { w: 0, pf: 0 }]));
  for (const rid of ids) {
    for (let w = 1; w <= GRADE_CUT; w++) {
      const r = L.teams.get(rid).weeks.get(w);
      w0.get(rid).pf += r.points;
      w0.get(rid).w += r.points > r.opp_points ? 1 : r.points === r.opp_points ? 0.5 : 0;
    }
  }
  const sched = [];
  for (let w = GRADE_CUT + 1; w <= last; w++) {
    const p = pairings(L, w);
    if (p.length * 2 < ids.length - 1) return null; // pairings not recoverable
    sched.push(p);
  }
  const idx = new Map(ids.map((id, i) => [id, i]));
  const hitsF = new Array(ids.length).fill(0), hitsA = new Array(ids.length).fill(0);
  const r = rng(seed);
  for (let run = 0; run < RUNS; run++) {
    const recF = ids.map(id => ({ ...w0.get(id) })), recA = ids.map(id => ({ ...w0.get(id) }));
    for (const week of sched) {
      const z = ids.map(() => normal(r));
      const sF = ids.map((_, i) => ft[i].m + sd * z[i]);
      const sA = ids.map((_, i) => ft[i].m + shift[i] + sd * z[i]);
      for (const [a, b] of week) {
        const ia = idx.get(a), ib = idx.get(b);
        for (const [s, rec] of [[sF, recF], [sA, recA]]) {
          rec[ia].pf += s[ia]; rec[ib].pf += s[ib];
          if (s[ia] > s[ib]) rec[ia].w++; else if (s[ib] > s[ia]) rec[ib].w++; else { rec[ia].w += 0.5; rec[ib].w += 0.5; }
        }
      }
    }
    for (const [rec, hits] of [[recF, hitsF], [recA, hitsA]]) {
      const order = ids.map((_, i) => i).sort((x, y) => rec[y].w - rec[x].w || rec[y].pf - rec[x].pf);
      for (const i of order.slice(0, N)) hits[i]++;
    }
  }
  let bF = 0, bAd = 0;
  ids.forEach((rid, i) => {
    const y = L.teams.get(rid).po;
    bF += (hitsF[i] / RUNS - y) ** 2; bAd += (hitsA[i] / RUNS - y) ** 2;
  });
  return { teams: ids.length, bF, bA: bAd, seF, seA, nW, capped };
}

function summarise(label, rows) {
  const tot = rs => rs.reduce((s, x) => ({ t: s.t + x.teams, bF: s.bF + x.bF, bA: s.bA + x.bA,
    seF: s.seF + x.seF, seA: s.seA + x.seA, nW: s.nW + x.nW, cap: s.cap + x.capped }),
  { t: 0, bF: 0, bA: 0, seF: 0, seA: 0, nW: 0, cap: 0 });
  const T = tot(rows);
  const r = rng(4601);
  const dB = [], dM = [];
  for (let b = 0; b < BOOT; b++) {
    const s = tot(Array.from({ length: rows.length }, () => rows[Math.floor(r() * rows.length)]));
    dB.push((s.bF - s.bA) / s.t); dM.push((s.seF - s.seA) / s.nW);
  }
  console.log(`\n${label}: leagues=${rows.length} teams=${T.t} team-weeks(10-14)=${T.nW} shifts capped=${T.cap}`);
  console.log(`  playoff Brier  frozen ${f(T.bF / T.t)}  adjusted ${f(T.bA / T.t)}  delta ${f((T.bF - T.bA) / T.t)}  90% [${f(pct(dB, 0.05))}, ${f(pct(dB, 0.95))}]`);
  console.log(`  points MSE w10-14  frozen ${f(T.seF / T.nW, 1)}  adjusted ${f(T.seA / T.nW, 1)}  delta ${f((T.seF - T.seA) / T.nW, 1)}  90% [${f(pct(dM, 0.05), 1)}, ${f(pct(dM, 0.95), 1)}]`);
  return { leagues: rows.length, brier_delta: +((T.bF - T.bA) / T.t).toFixed(5), mse_delta: +((T.seF - T.seA) / T.nW).toFixed(2) };
}

const out = {};
let seed = 1;
const dropped = {};
for (const season of HOLDOUT) {
  const rows = [];
  for (const [lg, L] of leagues) {
    if (L.season !== season) continue;
    const g = gradeLeague(lg, L, 7919 * seed++);
    if (g) rows.push(g); else dropped[season] = (dropped[season] ?? 0) + 1;
  }
  out[season] = rows.length ? summarise(`HELD OUT ${season}`, rows) : null;
}
console.log(`\nleagues dropped (short season, missing weeks, pairings not recoverable, no playoff count): ${JSON.stringify(dropped)}`);
console.log(`\nLIVING01C_FIT ${JSON.stringify({
  per_add_per_week: +bA.toFixed(3), per_dead_start: +bD.toFixed(3), se: fit.se.map(x => +x.toFixed(3)),
  n: X.length, cap: CAP, min_weeks: MIN_WEEKS, runs: RUNS, holdout: out,
})}`);
