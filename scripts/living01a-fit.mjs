#!/usr/bin/env node
/**
 * LIVING-01a: fit the engagement-state + activity-rate model on Sleeper 2021-22 and
 * grade it on 2023 and 2024 SEPARATELY. Study code: reads copies, writes one JSON of
 * aggregates (no league, roster, manager or user ids or names).
 *
 *   node scripts/living01a-fit.mjs --sleeper <copy of sleeper_history.sqlite> \
 *     --nv <nflverse extract: idmap, played, team_games> [--baseline] [--out file.json]
 *
 * The nflverse extract is three small tables built with the sqlite3 CLI from an
 * immutable read of data/line-history/nflverse.sqlite (command in the evidence doc):
 *   idmap(season, sleeper_id, gsis_id)   roster_weekly, 2021-2024
 *   played(season, week, gsis_id)        any REG stat row that week
 *   team_games(season, week, team)       REG games
 *
 * Never opens 2025: every Sleeper query filters season BETWEEN 2021 AND 2024.
 *
 * Metrics (pre-registered in the unit):
 *   1. next-week adds log-likelihood per team-week, model vs the flat per-manager
 *      Poisson (gamma-shrunk as-of rate, its prior fitted on 2021-22), weeks 2..E;
 *      90% CI by league bootstrap.
 *   2. checkout AUC: zero adds in weeks 8..E, scored with data through week 7, vs
 *      win%-only (1 - win% through week 7).
 *   3. calibration of P(dead or empty starter next week): logistic recalibration
 *      slope and intercept of y on logit(p).
 * Ship only if, in BOTH 2023 and 2024: LL gain CI excludes 0 above; AUC >= 0.65 and
 * above win%-only; slope in [0.8, 1.2].
 *
 * Live mode (descriptive only, ESPN 2026): runs the engine producer against a COPY of
 * the app database that carries migration 075 and the engine backfill, and prints the
 * state counts (aggregates only). It refuses the production paths.
 *   GRIDIRON_DB_PATH=<copy> GRIDIRON_LIVING01A_ENABLED=1 node scripts/living01a-fit.mjs --live \
 *     --season 2026 --through 2 [--as-of <ISO>]
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
if (process.argv.includes('--live')) {
  await live();
  process.exit(0);
}
async function live() {
  const dbPath = process.env.GRIDIRON_DB_PATH ?? '';
  if (!dbPath || /gridiron-local\/data\.sqlite$|Documents\/GitHub\/gridiron-hq\//.test(dbPath)) {
    console.error('--live writes engine_state rows: point GRIDIRON_DB_PATH at a copy, never the live database');
    process.exit(2);
  }
  const { db } = await import('../server/db/index.js');
  const m = await import('../server/services/engine/activity-model.js');
  const season = Number(arg('season', 2026));
  const through = Number(arg('through', 2));
  const asOf = arg('as-of', new Date().toISOString());
  const leagues = db.prepare('SELECT DISTINCT league_id FROM league_transactions_raw WHERE season = ? ORDER BY league_id').all(season)
    .map(r => r.league_id);
  const tally = { engaged: 0, drifting: 0, checked_out: 0 };
  let written = 0; let skipped = 0; let teams = 0; const off = [];
  for (const leagueId of leagues) {
    const r = await m.produceActivityStates({ leagueId, season, through, asOf });
    if (r.off) off.push(r.off);
    written += r.written; skipped += r.skipped; teams += r.teams.length;
    for (const t of r.teams) tally[t.state]++;
  }
  console.log(JSON.stringify({ mode: 'live', label: 'local copy', season, through, as_of: asOf, leagues: leagues.length,
    teams, written, skipped, states: tally, off: off[0] ?? null }, null, 2));
}
const SH = arg('sleeper');
const NV = arg('nv');
const OUT = arg('out');
const BASELINE_ONLY = process.argv.includes('--baseline');
const BOOT = Number(arg('boot', 1000));
if (!SH || !NV) {
  console.error('usage: --sleeper <sleeper_history copy> --nv <nflverse extract> [--baseline] [--out json]');
  process.exit(2);
}

const FIT = [2021, 2022];
const GRADE = [2023, 2024];
const CHECKOUT_WEEK = 7;
const IDP = /"(DL|LB|DB|IDP_FLEX|DE|DT|CB|S)"/;
const TEAM_ALIAS = { LAR: 'LA', JAC: 'JAX', OAK: 'LV', SD: 'LAC', STL: 'LA', WSH: 'WAS' };

/* --------------------------------------------------------------- seeded RNG */
let seed = 20260923;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

/* -------------------------------------------------------------------- load */
function load() {
  const sh = new DatabaseSync(SH, { readOnly: true });
  const nv = new DatabaseSync(NV, { readOnly: true });
  const idmap = new Map(); // season:sleeper -> gsis
  const anyMap = new Map();
  for (const r of nv.prepare('SELECT season, sleeper_id, gsis_id FROM idmap').all()) {
    idmap.set(`${r.season}:${r.sleeper_id}`, r.gsis_id);
    anyMap.set(String(r.sleeper_id), r.gsis_id);
  }
  const played = new Set(nv.prepare('SELECT season, week, gsis_id FROM played').all().map(r => `${r.season}:${r.week}:${r.gsis_id}`));
  const games = new Set();
  const teamsPerWeek = new Map();
  for (const r of nv.prepare('SELECT season, week, team FROM team_games').all()) {
    games.add(`${r.season}:${r.week}:${r.team}`);
    const k = `${r.season}:${r.week}`;
    teamsPerWeek.set(k, (teamsPerWeek.get(k) ?? 0) + 1);
  }
  const byeFrac = (season, week) => {
    const n = teamsPerWeek.get(`${season}:${week}`);
    return n == null ? null : Math.max(0, 1 - n / 32);
  };

  const leagues = sh.prepare(`SELECT league_id, season, playoff_week_start, roster_positions FROM sh_leagues
      WHERE season BETWEEN 2021 AND 2024 AND playoff_week_start >= 13 ORDER BY league_id`).all()
    .filter(l => !IDP.test(l.roster_positions ?? ''));
  const twQ = sh.prepare(`SELECT roster_id, week, points, opponent_roster_id, starters_json FROM sh_team_weeks
      WHERE league_id = ? AND week BETWEEN 1 AND ?`);
  const txQ = sh.prepare(`SELECT week, type, roster_ids_json, adds_json FROM sh_transactions
      WHERE league_id = ? AND status = 'complete' AND week BETWEEN 1 AND ? AND type IN ('free_agent','waiver','trade')`);
  const counts = { leagues: 0, teamSeasons: 0, teamWeeks: 0, starterSlots: 0, empty: 0, dead: 0, unknownStarter: 0,
    errUnknownWeeks: 0, leaguesNoTx: 0 };
  const seasons = [];
  for (const lg of leagues) {
    const E = lg.playoff_week_start - 1;
    const tws = twQ.all(lg.league_id, E);
    if (!tws.length) continue;
    const txs = txQ.all(lg.league_id, E);
    if (!txs.length) counts.leaguesNoTx++;
    const adds = new Map(); const trades = new Map();
    const bump = (m, rid, w) => { const k = `${rid}:${w}`; m.set(k, (m.get(k) ?? 0) + 1); };
    for (const t of txs) {
      if (t.type === 'trade') {
        for (const rid of new Set(JSON.parse(t.roster_ids_json ?? '[]'))) bump(trades, rid, t.week);
      } else if (t.adds_json) {
        for (const rid of Object.values(JSON.parse(t.adds_json))) bump(adds, rid, t.week);
      }
    }
    const byTeam = new Map();
    const pts = new Map();
    for (const r of tws) {
      pts.set(`${r.roster_id}:${r.week}`, r.points);
      (byTeam.get(r.roster_id) ?? byTeam.set(r.roster_id, new Map()).get(r.roster_id)).set(r.week, r);
    }
    counts.leagues++;
    for (const [rid, wmap] of byTeam) {
      const weeks = [];
      for (let w = 1; w <= E; w++) {
        const r = wmap.get(w);
        let err = null; let win = null;
        if (r) {
          const st = JSON.parse(r.starters_json ?? '[]');
          let bad = 0; let unknown = 0;
          for (const p of st) {
            counts.starterSlots++;
            if (p == null || p === '0' || p === '') { bad++; counts.empty++; continue; }
            if (/^[A-Z]{2,3}$/.test(p)) {
              const team = TEAM_ALIAS[p] ?? p;
              if (!games.has(`${lg.season}:${w}:${team}`)) { bad++; counts.dead++; }
              continue;
            }
            const g = idmap.get(`${lg.season}:${p}`) ?? anyMap.get(String(p));
            if (!g) { unknown++; counts.unknownStarter++; continue; }
            if (!played.has(`${lg.season}:${w}:${g}`)) { bad++; counts.dead++; }
          }
          err = bad > 0 ? 1 : unknown > 0 ? null : 0;
          if (err == null) counts.errUnknownWeeks++;
          const opp = pts.get(`${r.opponent_roster_id}:${w}`);
          if (r.opponent_roster_id != null && Number.isFinite(opp) && Number.isFinite(r.points)) {
            win = r.points > opp ? 1 : r.points < opp ? 0 : 0.5;
          }
        } else {
          counts.errUnknownWeeks++;
        }
        weeks.push({ adds: adds.get(`${rid}:${w}`) ?? 0, trades: trades.get(`${rid}:${w}`) ?? 0, err, win,
          byeFrac: byeFrac(lg.season, w) });
        counts.teamWeeks++;
      }
      counts.teamSeasons++;
      seasons.push({ league: lg.league_id, season: lg.season, E, weeks });
    }
  }
  return { seasons, counts };
}

/* ------------------------------------------------------------------ helpers */
const LF = [0];
const logFact = n => { for (let i = LF.length; i <= n; i++) LF[i] = LF[i - 1] + Math.log(i); return LF[n]; };
const pois = (k, mu) => k * Math.log(mu) - mu - logFact(k);
const quant = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };

function auc(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rank = 1; let sumPos = 0; let nPos = 0;
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const mid = (rank + rank + (j - i)) / 2;
    for (let k = i; k <= j; k++) if (labels[idx[k]]) { sumPos += mid; nPos++; }
    rank += j - i + 1; i = j + 1;
  }
  const nNeg = labels.length - nPos;
  return nPos && nNeg ? (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg) : null;
}

/** Logistic recalibration y ~ a + b * logit(p). */
function recal(ps, ys) {
  let a = 0; let b = 1;
  const xs = ps.map(p => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(q / (1 - q)); });
  for (let it = 0; it < 50; it++) {
    let ga = 0; let gb = 0; let haa = 0; let hab = 0; let hbb = 0;
    for (let i = 0; i < xs.length; i++) {
      const p = 1 / (1 + Math.exp(-(a + b * xs[i])));
      const d = ys[i] - p; const h = p * (1 - p);
      ga += d; gb += d * xs[i]; haa += h; hab += h * xs[i]; hbb += h * xs[i] * xs[i];
    }
    const det = haa * hbb - hab * hab;
    const da = (hbb * ga - hab * gb) / det; const db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { intercept: a, slope: b };
}

/** League-cluster bootstrap of a statistic over per-league groups. */
function bootstrap(groups, stat, reps = BOOT) {
  const out = [];
  for (let r = 0; r < reps; r++) {
    const pick = [];
    for (let i = 0; i < groups.length; i++) pick.push(groups[Math.floor(rand() * groups.length)]);
    const v = stat(pick);
    if (v != null && Number.isFinite(v)) out.push(v);
  }
  return { lo: quant(out, 0.05), hi: quant(out, 0.95), reps: out.length };
}

const groupBy = (xs, key) => { const m = new Map(); for (const x of xs) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))).push(x); return [...m.values()]; };

/* ---------------------------------------------------------- flat baseline */
function flatBaselineFit(fitSeasons) {
  let n = 0; let s = 0;
  for (const ts of fitSeasons) for (const w of ts.weeks) { n++; s += w.adds; }
  const r0 = s / n;
  let best = null;
  for (const beta of [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64]) {
    let ll = 0;
    for (const ts of fitSeasons) ll += flatLL(ts.weeks, r0, beta).reduce((a, x) => a + (x ?? 0), 0);
    if (!best || ll > best.ll) best = { beta, ll };
  }
  return { r0, beta: best.beta };
}
/** Per-week log P(adds) under the flat as-of rate; index 0 is week 1. */
function flatLL(weeks, r0, beta, profile = null) {
  let seen = 0; let expo = 0;
  return weeks.map((w, t) => {
    const m = profile ? (profile[t] ?? 1) : 1;
    const mu = m * (beta * r0 + seen) / (beta + expo);
    seen += w.adds; expo += m;
    return pois(w.adds, mu);
  });
}

/* --------------------------------------------------------------------- run */
const t0 = Date.now();
const { seasons, counts } = load();
const log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
log('loaded', JSON.stringify(counts));
const fitSet = seasons.filter(s => FIT.includes(s.season));
const flat = flatBaselineFit(fitSet);
// Stress-test baseline only: the population's adds by week of season, relative to its mean (fit seasons).
const weekProfile = (() => {
  const sum = []; const n = [];
  for (const ts of fitSet) ts.weeks.forEach((w, t) => { sum[t] = (sum[t] ?? 0) + w.adds; n[t] = (n[t] ?? 0) + 1; });
  return sum.map((x, t) => (n[t] >= 500 ? x / n[t] / flat.r0 : 1)); // thin tail weeks: no profile
})();
log('flat baseline', JSON.stringify(flat));

const result = {
  unit: 'LIVING-01a', fit: FIT, graded: GRADE, checkout_week: CHECKOUT_WEEK,
  data: { ...counts, per_season: Object.fromEntries([2021, 2022, 2023, 2024].map(y => [y, seasons.filter(s => s.season === y).length])) },
  flat_baseline: flat, seasons: {},
};

let params = null;
let model = null;
if (!BASELINE_ONLY) {
  model = await import('../server/services/engine/activity-model.js');
  const popAdd = flat.r0;
  let e1 = 0; let n1 = 0;
  for (const ts of fitSet) for (const w of ts.weeks) if (w.err != null) { e1 += w.err; n1++; }
  const fitWeeks = fitSet.map(s => s.weeks);
  params = model.fitParams(fitWeeks, model.initialParams({ popAddRate: popAdd, popErr: e1 / n1, alpha: 8 }), { log });
  // Empirical-Bayes shrinkage strength: the alpha that maximises the fit seasons' predictive LL.
  let best = null;
  for (const alpha of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64, 1e9]) {
    const p = { ...params, alpha };
    let ll = 0;
    for (const w of fitWeeks) for (const x of model.filterSeason(p, w).weeks.slice(1)) ll += x.addsLogLik ?? 0;
    if (!best || ll > best.ll) best = { alpha, ll };
  }
  params = model.fitParams(fitWeeks, { ...params, alpha: best.alpha }, { log });
  // Population rates for the reported per-manager shrunk rates (trades, lineup errors).
  let tr = 0; let tw = 0;
  for (const ts of fitSet) for (const w of ts.weeks) { tr += w.trades; tw++; }
  params.popTradeRate = tr / tw;
  params.popErrRate = e1 / n1;
  result.params = params;
  // The served constants (FITTED_PARAMS, rounded) must be this fit.
  const F = model.FITTED_PARAMS;
  const flatten = p => [...p.pi, ...p.A.flat(), ...p.lam, ...p.errLogit, p.errBye];
  const a = flatten(F); const b = flatten(params);
  result.served_params_max_rel_diff = Math.max(...a.map((x, i) => Math.abs(x - b[i]) / Math.max(1e-9, Math.abs(b[i]))));
  log('params', JSON.stringify(params));
}

for (const season of [...FIT, ...GRADE]) {
  const set = seasons.filter(s => s.season === season);
  const rows = []; // per team-week adds LL rows
  const co = []; // checkout rows
  const cal = []; // calibration rows
  for (const ts of set) {
    const fl = flatLL(ts.weeks, flat.r0, flat.beta);
    const f = params ? model.filterSeason(params, ts.weeks) : null;
    for (let t = 1; t < ts.weeks.length; t++) {
      rows.push({ league: ts.league, base: fl[t], model: f ? f.weeks[t].addsLogLik : null });
      if (f && ts.weeks[t].err != null) cal.push({ league: ts.league, p: f.weeks[t].errProb, y: ts.weeks[t].err });
    }
    const upto = ts.weeks.slice(0, CHECKOUT_WEEK);
    const rest = ts.weeks.slice(CHECKOUT_WEEK);
    const wins = upto.filter(w => w.win != null);
    const winPct = wins.length ? wins.reduce((a, w) => a + w.win, 0) / wins.length : 0.5;
    const label = rest.reduce((a, w) => a + w.adds, 0) === 0 ? 1 : 0;
    let score = null;
    if (f) {
      const g = model.filterSeason(params, upto);
      score = model.pNoMoreAdds(params, g.final.nextPrior, g.final.rho, rest.length);
    }
    const addsTo7 = upto.reduce((a, w) => a + w.adds, 0);
    const adds67 = upto.slice(-2).reduce((a, w) => a + w.adds, 0);
    co.push({ league: ts.league, label, winScore: 1 - winPct, score, addsTo7, adds67,
      leagueDead: 0 });
  }
  // Leagues with no completed add or trade all regular season (abandoned, or a crawl gap).
  const leagueTx = new Map();
  for (const ts of set) leagueTx.set(ts.league, (leagueTx.get(ts.league) ?? 0) + ts.weeks.reduce((a, w) => a + w.adds + w.trades, 0));
  for (const x of co) x.leagueDead = leagueTx.get(x.league) === 0 ? 1 : 0;
  const r = { team_weeks_graded: rows.length, team_seasons: set.length, leagues: new Set(set.map(s => s.league)).size };
  const byLeague = groupBy(rows, x => x.league);
  r.flat_ll_per_tw = rows.reduce((a, x) => a + x.base, 0) / rows.length;
  const coByLeague = groupBy(co, x => x.league);
  r.checkout_rate = co.reduce((a, x) => a + x.label, 0) / co.length;
  r.auc_win_only = auc(co.map(x => x.winScore), co.map(x => x.label));
  if (params) {
    r.model_ll_per_tw = rows.reduce((a, x) => a + x.model, 0) / rows.length;
    const gain = g => { let s = 0; let n = 0; for (const L of g) for (const x of L) { s += x.model - x.base; n++; } return s / n; };
    r.ll_gain_per_tw = gain(byLeague);
    r.ll_gain_ci90 = bootstrap(byLeague, gain);
    r.auc_model = auc(co.map(x => x.score), co.map(x => x.label));
    r.auc_model_ci90 = bootstrap(coByLeague, g => { const f = g.flat(); return auc(f.map(x => x.score), f.map(x => x.label)); }, Math.min(BOOT, 300));
    r.auc_diff_ci90 = bootstrap(coByLeague, g => {
      const f = g.flat(); const L = f.map(x => x.label);
      return auc(f.map(x => x.score), L) - auc(f.map(x => x.winScore), L);
    }, Math.min(BOOT, 300));
    const rc = recal(cal.map(x => x.p), cal.map(x => x.y));
    r.calibration = { n: cal.length, observed: cal.reduce((a, x) => a + x.y, 0) / cal.length,
      predicted: cal.reduce((a, x) => a + x.p, 0) / cal.length, ...rc,
      slope_ci90: bootstrap(groupBy(cal, x => x.league), g => { const f = g.flat(); return recal(f.map(x => x.p), f.map(x => x.y)).slope; }, Math.min(BOOT, 200)) };
    // Reliability table by predicted decile (aggregates only).
    const sorted = [...cal].sort((a, b) => a.p - b.p);
    r.calibration.deciles = Array.from({ length: 10 }, (_, d) => {
      const part = sorted.slice(Math.floor(d * sorted.length / 10), Math.floor((d + 1) * sorted.length / 10));
      return { p: +(part.reduce((a, x) => a + x.p, 0) / part.length).toFixed(4), y: +(part.reduce((a, x) => a + x.y, 0) / part.length).toFixed(4), n: part.length };
    });
    // Stress tests (reported, not gated): is the checkout AUC more than "he already stopped"?
    const aucOf = (xs, f) => auc(xs.map(f), xs.map(x => x.label));
    const live = co.filter(x => !x.leagueDead);
    const active = live.filter(x => x.adds67 > 0);
    r.stress = {
      auc_adds_to_week7_only: aucOf(co, x => -x.addsTo7),
      auc_adds_weeks6_7_only: aucOf(co, x => -x.adds67),
      dead_leagues_team_seasons: co.length - live.length,
      live_leagues: { n: live.length, rate: live.reduce((a, x) => a + x.label, 0) / live.length,
        auc_model: aucOf(live, x => x.score), auc_win_only: aucOf(live, x => x.winScore), auc_adds_weeks6_7_only: aucOf(live, x => -x.adds67) },
      added_in_weeks6_7: { n: active.length, rate: active.reduce((a, x) => a + x.label, 0) / active.length,
        auc_model: aucOf(active, x => x.score), auc_win_only: aucOf(active, x => x.winScore), auc_adds_to_week7_only: aucOf(active, x => -x.addsTo7) },
    };
    // LL gain against a stronger flat baseline: the same as-of rate times the fit seasons' week-of-season profile.
    let s2 = 0; let n2 = 0;
    for (const ts of set) {
      const fl2 = flatLL(ts.weeks, flat.r0, flat.beta, weekProfile);
      const f = model.filterSeason(params, ts.weeks);
      for (let t = 1; t < ts.weeks.length; t++) { s2 += f.weeks[t].addsLogLik - fl2[t]; n2++; }
    }
    r.stress.ll_gain_vs_week_profile_baseline = s2 / n2;
    r.pass = {
      ll: r.ll_gain_ci90.lo > 0,
      auc: r.auc_model >= 0.65 && r.auc_model > r.auc_win_only,
      calibration: rc.slope >= 0.8 && rc.slope <= 1.2,
    };
  }
  result.seasons[season] = r;
  log(season, JSON.stringify(r));
}
if (params) {
  result.ship = GRADE.every(y => Object.values(result.seasons[y].pass).every(Boolean));
}
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
