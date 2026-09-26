#!/usr/bin/env node
/**
 * EVAL-E4: replay the War Room planner on Sleeper history and grade its moves
 * against simple baselines in REALIZED title / playoff outcomes. Study harness:
 * nothing served reads this file; the grader (server/services/eval/e4-planner.js)
 * holds the frozen aggregate.
 *
 * ============================ PRE-REGISTRATION ============================
 * Written and committed before the graded (2023-24) run. Fit 2021-22 only;
 * 2025 is never read (the exporter asserts season <= 2024).
 *
 * Sample. Sleeper corpus league-seasons 2021-24 (2021-22 fit, 2023-24 graded):
 *   non-IDP; 8-14 teams; 4, 6 or 8 playoff teams (< teams); playoff start week
 *   12-16 with the bracket ending by week 18; every team has a scored week with an
 *   opponent in weeks 1..start-1; the replay of the real scores through this
 *   file's standings code reproduces the stored playoff set (label-free format
 *   check, same idea as E3's primary sample). Two focal teams ("Nick") per
 *   league-season, drawn by a hash of the league id and roster id
 *   (FOCAL_PER_LEAGUE; set from load/time on the fit seasons, ~7 s per team).
 * Decision point. After week 6 (week-6 rosters, values as of week 6); moves take
 *   effect from week 7 (E3's replay week). Every arm uses only as-of information.
 * Player value. As-of points per game shrunk to the ADP prior (the R19 / E1
 *   definition, k = 3), prior curve from the PREVIOUS season for 2022+.
 *   Market value = 100 x max(0, value - positional replacement in that league).
 * Simulator (what the planner and the finder see). Remaining regular season on
 *   the real schedule from the real week-6 standings, then the bracket (reseeded;
 *   6-team: top two seeds bye), wins then points-for. Player week = 0 with the
 *   fitted miss rate, else max(0, value + sd(value) z); sd = a + b value and the
 *   miss rate fitted on 2021-22 (FIT below: sd = 4.28 + 0.2316 value, miss 0.324,
 *   24,434 player-weeks). Lineup by value, byes skipped. RUNS = 400 sims, common
 *   random numbers across rescores.
 * Acceptance (ASSUMED, same for every arm; Sleeper has no declined offers):
 *   p = clamp(0.35 + 0.01 x (his screen %), 0.02, 0.90), his screen % = value
 *   he gets minus value he gives, as % of what he gives.
 * Arms.
 *   planner  planLeague (server/services/campaign/planner.js) with the default
 *            objective (title, balanced); flips off (they do not change the best
 *            plan). Its best plan; do nothing if none or expected <= 0.
 *   finder   Trade Lab finder proxy: 1-for-1 and 2-for-1 inside the finder's
 *            fairness window where BOTH projected lineups improve; top 25 by
 *            p x lineup gain rescored in the same simulator; best p x title delta;
 *            do nothing if <= 0.
 *   nothing  0.
 *   greedy   best 1-for-1 inside the fairness window by Nick's projected lineup
 *            points, no simulator; do nothing if gain <= 0.
 * Realized outcome. The move's players are swapped on the real weekly rosters
 *   from week 7 on (a player the owner no longer holds that week is not swapped).
 *   Each affected team's real score changes by (rule lineup on the new roster -
 *   rule lineup on the real roster), rule lineup = best by as-of value, byes
 *   skipped, REAL points. Playoff weeks (no Sleeper team scores exist) are scored
 *   by the rule lineup for every team on the last regular-season roster. Real
 *   schedule, same standings and bracket code.
 * Metric (primary). Per focal team: expected realized title gain of each arm vs
 *   doing nothing = sum over accept/decline outcomes of P(outcome) x realized
 *   title change (0/1 scale), P from the assumed acceptance curve.
 *   Co-reported: same for made-playoffs; "if completed" (all steps accepted);
 *   per season; do-nothing champion fidelity vs the stored champion (playoff
 *   weeks are rule-scored, so this is reported, not a gate).
 * Pass bar. planner minus the BEST baseline (highest mean realized title gain on
 *   the graded rows), league-clustered bootstrap 95% CI (2,000 reps, seed 404)
 *   lower bound > 0 -> passing; upper bound < 0 -> failing; else not_enough_data.
 * ==========================================================================
 *
 * Usage (reviewer re-runs exactly this):
 *   sqlite3 -readonly ~/Documents/GitHub/gridiron-hq/data/derived/sleeper_history.sqlite ".backup <copy>"
 *   node scripts/eval/e4-planner-replay.mjs --sh <copy> --cache ~/gridiron-local/rnd/skill/cache \
 *        --seasons 2023-2024 --jobs 4 --out server/data/eval/e4-planner-replay.json
 *   --seasons 2021-2022 --fit    prints the simulator fit (FIT constants below)
 *   --write-report               runs every grader with E4 from e4-planner.js and stores one
 *                                brain_report run in GRIDIRON_DB_PATH (use a DB copy)
 * Importing this file runs nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as e4 from '../../server/services/eval/e4-planner.js';

export const DECISION_WEEK = 7;
export const RUNS = 400;
export const FOCAL_PER_LEAGUE = 2;
export const SEED = 4047;
/** Fitted on 2021-22 by --fit (frozen before the graded run). */
export const FIT = Object.freeze({ sd_a: 4.28, sd_b: 0.2316, p_miss: 0.324, fitted_on: '2021-2022 (24,434 player-weeks)' });
export const ACCEPT = Object.freeze({ at_par: 0.35, per_pct: 0.01, lo: 0.02, hi: 0.9 });
export const FINDER_SHORTLIST = 25;
const SK = ['QB', 'RB', 'WR', 'TE'];
const SLOT_OK = { QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'] };

// ---------------------------------------------------------------- export (python: reads the pickles)
// FIX-294-1: the export's Python lives in its own file (it reads the external Sleeper history DB).
const PY_FILE = fileURLToPath(new URL('./e4-planner-replay-export.py', import.meta.url));

export function exportLeagues({ sh, cache, seasons, out }) {
  const [s0, s1] = seasons;
  if (!(s0 >= 2021 && s1 <= 2024 && s0 <= s1)) throw new Error('seasons must lie in 2021-2024 (2025 is held out)');
  const r = spawnSync('python3.12', [PY_FILE, sh, cache, String(s0), String(s1), out], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`export failed: ${(r.stderr || r.error?.message || '').slice(-800)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

// ---------------------------------------------------------------- small utils
export function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const s of parts.map(String)) { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } h ^= 0x1f; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const NO_BLOCK = Object.freeze({ give: new Set(), get: new Set() });

/** Acceptance (assumed): his screen % -> p. */
export function acceptP(theyGetValue, theyGiveValue, a = ACCEPT) {
  if (!(theyGiveValue > 0)) return a.lo;
  const pct = ((theyGetValue - theyGiveValue) / theyGiveValue) * 100;
  return clamp(a.at_par + a.per_pct * pct, a.lo, a.hi);
}

/** Starters by `score` (desc) for one week: dedicated slots first, then flex slots. Returns ids. */
export function lineup(ids, slots, info, week, scoreOf) {
  const pool = ids.filter(id => { const p = info(id); return p && SK.includes(p.pos) && p.bye !== week; })
    .sort((x, y) => scoreOf(y) - scoreOf(x) || (String(x) < String(y) ? -1 : 1));
  const used = new Set();
  for (const s of slots) {
    if (!SK.includes(s)) continue;
    const pick = pool.find(id => !used.has(id) && info(id).pos === s);
    if (pick != null) used.add(pick);
  }
  for (const s of slots) {
    const ok = SK.includes(s) ? null : SLOT_OK[s];
    if (!ok) continue;
    const pick = pool.find(id => !used.has(id) && ok.includes(info(id).pos));
    if (pick != null) used.add(pick);
  }
  return [...used];
}

/** Seeds (team indexes in seed order) from wins and points-for. */
export function seedOrder(wins, pf, idx = [...wins.keys()]) {
  return [...idx].sort((a, b) => (wins[b] - wins[a]) || (pf[b] - pf[a]) || (a - b));
}

/**
 * Reseeded bracket: seeds = team indexes, best first; playoff teams pt (4, 6 or 8; 6 gives the top two a bye).
 * score(team, round) -> points. Higher seed wins ties. Returns the champion index.
 */
export function bracket(seeds, pt, score) {
  const byes = pt === 6 ? 2 : 0;
  let alive = seeds.slice(0, pt).map((t, s) => ({ t, s }));
  let round = 0;
  while (alive.length > 1) {
    const sitting = round === 0 ? alive.slice(0, byes) : [];
    const playing = round === 0 ? alive.slice(byes) : alive;
    const winners = [];
    for (let i = 0; i < playing.length / 2; i++) {
      const hi = playing[i], lo = playing[playing.length - 1 - i];
      winners.push(score(lo.t, round) > score(hi.t, round) ? lo : hi);
    }
    alive = [...sitting, ...winners].sort((a, b) => a.s - b.s);
    round++;
  }
  return alive[0].t;
}

// ---------------------------------------------------------------- one league
/**
 * Everything about one exported league-season that the arms and the grader need.
 * decisionWeek (SEASON-REPLAY, item 30): the week moves take effect; default DECISION_WEEK, so
 * the Sleeper study is unchanged. Everything below reads it from C.dw.
 */
export function prepareLeague(L, { decisionWeek = DECISION_WEEK } = {}) {
  const teams = L.rids.map(String);
  const ix = new Map(teams.map((t, i) => [t, i]));
  const nReg = L.pws - 1;
  const rounds = { 4: 2, 6: 3, 8: 3 }[L.pt];
  const info = id => { const p = L.pl[id]; return p ? { pos: p[0], bye: p[1], pred: p[2], pts: p[3] } : null; };
  const roster = (t, w) => L.tw[t][w - 1][2].map(String).filter(id => info(id));
  const actual = (t, w) => Number(L.tw[t][w - 1][0]) || 0;
  const opp = (t, w) => { const o = L.tw[t][w - 1][1]; return o == null ? null : String(o); };
  const dw = decisionWeek;
  const W0 = dw - 1;
  // Real standings through week 6.
  const wins0 = new Float64Array(teams.length), pf0 = new Float64Array(teams.length);
  for (let w = 1; w <= W0; w++) for (const t of teams) {
    const o = opp(t, w);
    if (o == null || !ix.has(o)) continue;
    const a = actual(t, w), b = actual(o, w);
    wins0[ix.get(t)] += a > b ? 1 : a === b ? 0.5 : 0;
    pf0[ix.get(t)] += a;
  }
  // Positional replacement (as of week 6) and market value.
  const base = new Map(teams.map(t => [t, roster(t, W0)]));
  const dedicated = Object.fromEntries(SK.map(p => [p, L.slots.filter(s => s === p).length]));
  const flexShare = Object.fromEntries(SK.map(p => [p, L.slots.filter(s => !SK.includes(s) && SLOT_OK[s]?.includes(p))
    .reduce((s, x) => s + 1 / SLOT_OK[x].length, 0)]));
  const repl = {};
  for (const p of SK) {
    const vals = [...base.values()].flat().filter(id => info(id).pos === p).map(id => info(id).pred[W0]).sort((a, b) => b - a);
    const k = Math.round(L.nt * (dedicated[p] + flexShare[p]));
    repl[p] = vals[k] ?? vals.at(-1) ?? 0;
  }
  const value = id => { const p = info(id); return p ? Math.round(100 * Math.max(0, p.pred[W0] - repl[p.pos])) : 0; };
  return { L, teams, ix, nReg, rounds, info, roster, actual, opp, dw, W0, wins0, pf0, base, repl, value };
}

/** The label-free format check: real scores through this file's standings reproduce the stored playoff set. */
export function formatCheck(C) {
  const { teams, ix, nReg, actual, opp, L } = C;
  const wins = new Float64Array(teams.length), pf = new Float64Array(teams.length);
  for (let w = 1; w <= nReg; w++) for (const t of teams) {
    const o = opp(t, w);
    if (o == null || !ix.has(o)) continue;
    const a = actual(t, w), b = actual(o, w);
    wins[ix.get(t)] += a > b ? 1 : a === b ? 0.5 : 0;
    pf[ix.get(t)] += a;
  }
  const made = new Set(seedOrder(wins, pf).slice(0, L.pt).map(i => teams[i]));
  return teams.every(t => made.has(t) === (Number(L.made[t]) === 1));
}

/** Projected (sim-mean) lineup points per regular week for a roster, by week-6 value. */
function projected(C, ids) {
  let s = 0;
  for (let w = C.dw; w <= C.nReg; w++) {
    for (const id of lineup(ids, C.L.slots, C.info, w, x => C.info(x).pred[C.W0])) s += C.info(id).pred[C.W0];
  }
  return s / Math.max(1, C.nReg - C.dw + 1);
}

/**
 * The simulator world for one seed: rescore(state, a, b) in the planner's shape.
 * Weeks simulated: C.dw (DECISION_WEEK by default)..nReg, then `rounds` playoff weeks.
 */
export function makeWorld(C, seed, { runs = RUNS, fit = FIT } = {}) {
  const { teams, ix, nReg, rounds, info, L, W0, dw } = C;
  const weeks = [];
  for (let w = dw; w <= nReg + rounds; w++) weeks.push(w);
  const nW = weeks.length, nRegW = nReg - dw + 1;
  const draws = new Map();
  const drawOf = id => {
    if (!draws.has(id)) {
      const r = mulberry(hash32(seed, id));
      const mu = info(id).pred[W0], sd = fit.sd_a + fit.sd_b * mu;
      const a = new Float32Array(nW * runs);
      for (let k = 0; k < a.length; k++) {
        const u1 = r() || 1e-12, u2 = r(), u3 = r();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        a[k] = u3 < fit.p_miss ? 0 : Math.max(0, mu + sd * z);
      }
      draws.set(id, a);
    }
    return draws.get(id);
  };
  const teamCache = new Map();
  const teamPoints = ids => {
    const key = [...ids].map(String).sort().join(',');
    if (teamCache.has(key)) return teamCache.get(key);
    const out = new Float64Array(nW * runs);
    for (let k = 0; k < nW; k++) {
      const w = weeks[k];
      const lu = lineup(ids, L.slots, info, w, x => info(x).pred[W0]);
      for (const id of lu) { const d = drawOf(id); for (let r = 0; r < runs; r++) out[k * runs + r] += d[k * runs + r]; }
    }
    if (teamCache.size > 4000) teamCache.clear();
    teamCache.set(key, out);
    return out;
  };
  const oppIx = [];
  for (let k = 0; k < nRegW; k++) oppIx.push(teams.map(t => { const o = C.opp(t, weeks[k]); return o != null && ix.has(o) ? ix.get(o) : -1; }));
  const simulate = pts => {
    const nT = teams.length;
    const champ = new Int16Array(runs), made = new Uint8Array(nT * runs);
    const wins = new Float64Array(nT), pf = new Float64Array(nT);
    for (let r = 0; r < runs; r++) {
      wins.set(C.wins0); pf.set(C.pf0);
      for (let k = 0; k < nRegW; k++) {
        const o = oppIx[k];
        for (let i = 0; i < nT; i++) {
          const j = o[i];
          const a = pts[i][k * runs + r];
          pf[i] += a;
          if (j < 0) continue;
          const b = pts[j][k * runs + r];
          wins[i] += a > b ? 1 : a === b ? 0.5 : 0;
        }
      }
      const seeds = seedOrder(wins, pf);
      for (let s = 0; s < L.pt; s++) made[seeds[s] * runs + r] = 1;
      champ[r] = bracket(seeds, L.pt, (t, round) => pts[t][(nRegW + round) * runs + r]);
    }
    return { champ, made };
  };
  const basePts = teams.map(t => teamPoints(C.base.get(t)));
  const base = simulate(basePts);
  const odds = (sim, i) => {
    let t = 0, m = 0;
    for (let r = 0; r < runs; r++) { if (sim.champ[r] === i) t++; m += sim.made[i * runs + r]; }
    return { title: t / runs, playoff: m / runs };
  };
  const pairSe = (x, y) => {
    let s = 0, s2 = 0;
    for (let r = 0; r < runs; r++) { const d = y(r) - x(r); s += d; s2 += d * d; }
    const m = s / runs;
    return Math.sqrt(Math.max(0, s2 / runs - m * m) / Math.max(1, runs - 1));
  };
  const seasonAvg = (p, r) => { let s = 0; for (let k = 0; k < nRegW; k++) s += p[k * runs + r]; return s / nRegW; };
  const block = (after, pts, t) => {
    const i = ix.get(String(t));
    const b = odds(base, i), a = odds(after, i);
    const tse = pairSe(r => (base.champ[r] === i ? 1 : 0), r => (after.champ[r] === i ? 1 : 0));
    const pse = pairSe(r => base.made[i * runs + r], r => after.made[i * runs + r]);
    let pb = 0, pa = 0;
    for (let r = 0; r < runs; r++) { pb += seasonAvg(basePts[i], r); pa += seasonAvg(pts[i], r); }
    const pd = (pa - pb) / runs;
    return { roster_id: String(t), title_before: b.title, title_after: a.title, title_delta: a.title - b.title, title_delta_se: tse,
      title_delta_clears_noise: tse > 0 && Math.abs(a.title - b.title) > 2 * tse,
      playoff_before: b.playoff, playoff_after: a.playoff, playoff_delta: a.playoff - b.playoff, playoff_delta_se: pse,
      playoff_delta_clears_noise: pse > 0 && Math.abs(a.playoff - b.playoff) > 2 * pse,
      points_before: pb / runs, points_delta: pd, points_delta_se: null, points_delta_clears: false };
  };
  let count = 0;
  return {
    seed,
    rescore(state, a, b = null) {
      count++;
      const pts = teams.map((t, i) => (state.has(t) ? teamPoints(state.get(t)) : basePts[i]));
      const after = [...state.keys()].length ? simulate(pts) : base;
      const other = b ?? [...state.keys()].find(id => id !== a) ?? teams.find(t => t !== a);
      return { me: block(after, pts, a), them: block(after, pts, other) };
    },
    weekly: null,
    count: () => count,
  };
}

/** The planner's adapter over the Sleeper league (the fixture's shape: test/fixtures/campaign-league.mjs). */
export function makeAdapter(C, me, { runs = RUNS, fit = FIT, leagueKey } = {}) {
  const { teams, info, value, L } = C;
  const rosters = new Map(teams.map(t => [t, [...C.base.get(t)]]));
  const players = new Map();
  for (const ids of rosters.values()) for (const id of ids) {
    const p = info(id);
    players.set(id, { id, name: `p${id}`, position: p.pos, value: value(id), ros_ppg: p.pred[C.W0], injury: 0, bye: p.bye,
      trend_kind: null, available: true });
  }
  const val = ids => ids.reduce((s, id) => s + (players.get(id)?.value ?? 0), 0);
  const worlds = new Map();
  const seed = hash32(SEED, leagueKey, me);
  const world = s => { if (!worlds.has(s)) worlds.set(s, makeWorld(C, s, { runs, fit })); return worlds.get(s); };
  const chat = { engagement: 'unknown', tone: 'unknown', open_to_trade: 'unknown', no_holds: 'unknown', loves: [], hates: [], messages: 0, source: 'chat', status: 'unknown' };
  const managers = new Map(teams.filter(t => t !== me).map(t => [t, { receptiveness: 1, tier: null, needs: null, blocked: false,
    checked_out: false, title_now: null, sent_this_week: 0, send_when: { when: 'now', why: 'replay' }, chat }]));
  const starters = new Set(lineup(rosters.get(me), L.slots, info, C.dw, x => info(x).pred[C.W0]));
  return {
    league: { id: leagueKey, me, fetched_at: 'replay', week: C.dw, deadline_week: null, days_left_in_week: 7, team_count: teams.length },
    seed, world, rosters, players, managers, starters, freeAgents: [],
    priceStep: (team, theyGive, theyGet) => { const p = acceptP(val(theyGet), val(theyGive)); return { p, band: { low: p, high: p }, basis: 'assumed curve' }; },
    priceOf: (team, id) => ({ mult: 1, price: players.get(id)?.value ?? 0 }),
    now: () => Date.now(),
  };
}

export const applyStep = (state, me, st) => {
  const s = new Map(state);
  const mine = s.get(me), theirs = s.get(String(st.team));
  const give = new Set(st.give.map(String)), get = new Set(st.get.map(String));
  s.set(me, [...mine.filter(id => !give.has(id)), ...st.get.map(String)]);
  s.set(String(st.team), [...theirs.filter(id => !get.has(id)), ...st.give.map(String)]);
  return s;
};

/**
 * The counterfactual world of a roster state (Map team -> ids): which players moved, the rule
 * lineup on REAL points (rule(ids, w)), and each team's real weekly roster with the moves applied
 * (a player the owner no longer holds that week is not swapped). Shared by realized() and
 * scripts/eval/season-replay.mjs#realizedPoints (SEASON-REPLAY, item 30).
 */
export function counterfactual(C, state) {
  const { teams, info, L } = C;
  const moved = new Map(); // id -> { from, to }
  for (const t of teams) {
    const before = new Set(C.base.get(t));
    for (const id of state.get(t)) if (!before.has(id)) {
      const from = teams.find(u => C.base.get(u).includes(id));
      if (from != null) moved.set(id, { from, to: t });
    }
  }
  const rule = (ids, w) => lineup(ids, L.slots, info, w, x => info(x).pred[w - 1]).reduce((s, id) => s + (info(id).pts[w] ?? 0), 0);
  const cfRoster = (t, w) => {
    let ids = C.roster(t, w);
    for (const [id, m] of moved) {
      if (m.from === t && ids.includes(id)) ids = ids.filter(x => x !== id);
      if (m.to === t && C.roster(m.from, w).includes(id) && !ids.includes(id)) ids = [...ids, id];
    }
    return ids;
  };
  const affected = new Set([...moved.values()].flatMap(m => [m.from, m.to]));
  return { moved, rule, cfRoster, affected };
}

/**
 * Realized outcome for a week-6 roster state (Map team -> ids, every team): swap the moved players on
 * the real weekly rosters, rescore affected teams with the rule lineup on REAL points, replay standings and bracket.
 * Returns { champion, made: Set }.
 */
export function realized(C, state) {
  const { teams, ix, nReg, L } = C;
  const { rule, cfRoster, affected } = counterfactual(C, state);
  const score = new Map();
  for (let w = 1; w <= nReg; w++) for (const t of teams) {
    let s = C.actual(t, w);
    if (w >= C.dw && affected.has(t)) s += rule(cfRoster(t, w), w) - rule(C.roster(t, w), w);
    score.set(`${t}:${w}`, s);
  }
  const wins = new Float64Array(teams.length), pf = new Float64Array(teams.length);
  for (let w = 1; w <= nReg; w++) for (const t of teams) {
    const o = C.opp(t, w);
    const a = score.get(`${t}:${w}`);
    pf[ix.get(t)] += a;
    if (o == null || !ix.has(o)) continue;
    const b = score.get(`${o}:${w}`);
    wins[ix.get(t)] += a > b ? 1 : a === b ? 0.5 : 0;
  }
  const seeds = seedOrder(wins, pf);
  const lastRoster = teams.map(t => cfRoster(t, nReg));
  const champ = bracket(seeds, L.pt, (i, round) => rule(lastRoster[i], nReg + 1 + round));
  return { champion: teams[champ], made: new Set(seeds.slice(0, L.pt).map(i => teams[i])) };
}

/** Realized gain of a path of steps for `me` vs doing nothing: expected over accept/decline, and if completed. */
export function realizedGain(C, me, steps, baseOut, cache = new Map()) {
  const out = s => {
    const k = [...s.entries()].map(([t, ids]) => `${t}:${[...ids].sort().join(',')}`).sort().join('|');
    if (!cache.has(k)) cache.set(k, realized(C, s));
    return cache.get(k);
  };
  const val = o => ({ title: (o.champion === me ? 1 : 0) - (baseOut.champion === me ? 1 : 0),
    playoff: (o.made.has(me) ? 1 : 0) - (baseOut.made.has(me) ? 1 : 0) });
  if (!steps?.length) return { title: 0, playoff: 0, title_done: 0, playoff_done: 0, steps: 0, p_complete: 0 };
  let state = new Map(C.base), reach = 1;
  const e = { title: 0, playoff: 0 };
  let done = null;
  for (let i = 0; i <= steps.length; i++) {
    const g = i === 0 ? { title: 0, playoff: 0 } : val(out(state));
    const pStop = i < steps.length ? reach * (1 - steps[i].p) : reach;
    e.title += pStop * g.title; e.playoff += pStop * g.playoff;
    if (i === steps.length) { done = g; break; }
    reach *= steps[i].p;
    state = applyStep(state, me, steps[i]);
  }
  return { title: e.title, playoff: e.playoff, title_done: done.title, playoff_done: done.playoff, steps: steps.length, p_complete: reach };
}

/**
 * Trade Lab finder proxy: best p x sim title delta over mutual, fair 1-for-1 / 2-for-1 deals.
 * blocked (SEASON-REPLAY): { give: Set, get: Set } ids never offered / never taken (Nick's pinned
 * rules, campaign/never-give.js); empty by default, so the Sleeper study is unchanged.
 */
export function finderMove(C, adapter, me, W, { blocked = NO_BLOCK } = {}) {
  const { players } = adapter;
  const v = ids => ids.reduce((s, id) => s + (players.get(id)?.value ?? 0), 0);
  const tradable = id => SK.includes(players.get(id)?.position) && (players.get(id)?.value ?? 0) > 0;
  const mine = adapter.rosters.get(me).filter(id => tradable(id) && !blocked.give.has(String(id)));
  const myNow = projected(C, adapter.rosters.get(me));
  const cands = [];
  for (const [t, ids] of adapter.rosters) {
    if (t === me) continue;
    const theirNow = projected(C, ids);
    for (const get of ids.filter(id => tradable(id) && !blocked.get.has(String(id)))) {
      for (const give of combosOf(mine, 2)) {
        const pct = (v(give) - v([get])) / v([get]) * 100;
        if (!(pct >= -12 && pct <= 18)) continue;
        const myAfter = projected(C, [...adapter.rosters.get(me).filter(x => !give.includes(x)), get]);
        if (!(myAfter > myNow)) continue;
        const theirAfter = projected(C, [...ids.filter(x => x !== get), ...give]);
        if (!(theirAfter > theirNow)) continue;
        const p = acceptP(v(give), v([get]));
        cands.push({ team: t, give, get: [get], p, h: p * (myAfter - myNow) });
      }
    }
  }
  cands.sort((a, b) => b.h - a.h);
  let best = null;
  for (const c of cands.slice(0, FINDER_SHORTLIST)) {
    const st = applyStep(new Map(C.base), me, c);
    const s2 = new Map([[me, st.get(me)], [c.team, st.get(c.team)]]);
    const r = W.rescore(s2, me, c.team);
    const e = c.p * r.me.title_delta;
    if (!best || e > best.e) best = { ...c, e, delta: r.me.title_delta };
  }
  return { move: best && best.e > 0 ? [best] : [], candidates: cands.length };
}

/** Greedy: best fair 1-for-1 by Nick's projected lineup points (no simulator). blocked: as finderMove. */
export function greedyMove(C, adapter, me, { blocked = NO_BLOCK } = {}) {
  const { players } = adapter;
  const v = id => players.get(id)?.value ?? 0;
  const tradable = id => SK.includes(players.get(id)?.position) && v(id) > 0;
  const myIds = adapter.rosters.get(me);
  const myNow = projected(C, myIds);
  let best = null;
  for (const [t, ids] of adapter.rosters) {
    if (t === me) continue;
    const gets = ids.filter(id => tradable(id) && !blocked.get.has(String(id)));
    const gives = myIds.filter(id => tradable(id) && !blocked.give.has(String(id)));
    for (const get of gets) for (const give of gives) {
      const pct = (v(give) - v(get)) / v(get) * 100;
      if (!(pct >= -12 && pct <= 18)) continue;
      const g = projected(C, [...myIds.filter(x => x !== give), get]) - myNow;
      if (!best || g > best.g) best = { team: t, give: [give], get: [get], g, p: acceptP(v(give), v(get)) };
    }
  }
  return { move: best && best.g > 0 ? [best] : [] };
}

function combosOf(list, max) {
  const out = list.map(x => [x]);
  if (max >= 2) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
  return out;
}

/** Replay one league-season: every arm for each focal team. */
export async function replayLeague(L, { focal = FOCAL_PER_LEAGUE, runs = RUNS, fit = FIT, planner } = {}) {
  const C = prepareLeague(L);
  if (!formatCheck(C)) return { skipped: 'format' };
  const leagueKey = `L${hash32('e4', L.lid).toString(16)}`;
  const order = [...C.teams].sort((a, b) => hash32('focal', L.lid, a) - hash32('focal', L.lid, b));
  const rows = [];
  const baseOut = realized(C, new Map(C.base));
  const fidelity = baseOut.champion === C.teams.find(t => Number(L.champ[t]) === 1);
  for (const me of order.slice(0, focal)) {
    const t0 = Date.now();
    const adapter = makeAdapter(C, me, { runs, fit, leagueKey });
    const cache = new Map();
    const res = planner.planLeague(adapter, { objective: planner.objective, skips: { player: new Map(), manager: new Map() },
      previous: null, budget: { flipTopPer: 0 } });
    if (res.error) { rows.push({ cluster: leagueKey, season: L.season, error: String(res.error) }); continue; }
    const best = res.best && res.best.expected > 0 ? res.best.steps : [];
    const W = adapter.world(adapter.seed);
    const fm = finderMove(C, adapter, me, W);
    const gm = greedyMove(C, adapter, me);
    rows.push({
      cluster: leagueKey, season: L.season, teams: C.teams.length, playoff_teams: L.pt,
      title_now: res.now?.title ?? null, fidelity_champion: fidelity,
      planner: { ...realizedGain(C, me, best, baseOut, cache), sim_expected: res.best?.expected ?? null, depth: best.length },
      finder: { ...realizedGain(C, me, fm.move, baseOut, cache), sim_expected: fm.move[0]?.e ?? null, candidates: fm.candidates },
      greedy: realizedGain(C, me, gm.move, baseOut, cache),
      same_first_move: { finder: sameDeal(best[0], fm.move[0]), greedy: sameDeal(best[0], gm.move[0]) },
      rescores: res.rescores, ms: Date.now() - t0,
    });
  }
  return { rows };
}

const sameDeal = (a, b) => !!a && !!b && String(a.team) === String(b.team)
  && [...a.give].map(String).sort().join() === [...b.give].map(String).sort().join()
  && [...a.get].map(String).sort().join() === [...b.get].map(String).sort().join();

/** 2021-22 simulator fit: miss rate and sd = a + b x value over played weeks >= DECISION_WEEK. */
export function fitSim(leagues) {
  const seen = new Set();
  const xs = [], ys = [];
  let miss = 0, tot = 0;
  for (const L of leagues) {
    if (L.season > 2022) throw new Error('fit uses 2021-22 only');
    const C = prepareLeague(L);
    for (const id of new Set([...C.base.values()].flat())) {
      const k = `${L.season}:${L.sc}:${L.sf}:${id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const p = C.info(id);
      const mu = p.pred[C.W0];
      if (!(mu >= 3)) continue;
      for (let w = DECISION_WEEK; w < L.pws; w++) {
        if (p.bye === w) continue;
        tot++;
        // pts is 0 for a week he did not play (or scored exactly 0): the simulator's miss rate.
        if (!(p.pts[w] > 0)) { miss++; continue; }
        xs.push(mu); ys.push(p.pts[w] - mu);
      }
    }
  }
  // Binned sd, then least squares sd ~ a + b mu (bins of 2 ppg, weighted by count).
  const bins = new Map();
  xs.forEach((x, i) => { const b = Math.min(15, Math.floor(x / 2)); if (!bins.has(b)) bins.set(b, []); bins.get(b).push([x, ys[i]]); });
  const pts = [...bins.values()].filter(v => v.length >= 50).map(v => {
    const mx = v.reduce((s, q) => s + q[0], 0) / v.length;
    const m = v.reduce((s, q) => s + q[1], 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, q) => s + (q[1] - m) ** 2, 0) / (v.length - 1));
    return { x: mx, sd, n: v.length };
  });
  const W = pts.reduce((s, q) => s + q.n, 0);
  const mx = pts.reduce((s, q) => s + q.n * q.x, 0) / W, my = pts.reduce((s, q) => s + q.n * q.sd, 0) / W;
  const b = pts.reduce((s, q) => s + q.n * (q.x - mx) * (q.sd - my), 0) / pts.reduce((s, q) => s + q.n * (q.x - mx) ** 2, 0);
  return { sd_a: +(my - b * mx).toFixed(3), sd_b: +b.toFixed(4), p_miss: +(miss / tot).toFixed(4), player_weeks: tot, bins: pts };
}

// ---------------------------------------------------------------- CLI
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), nx = argv[i + 1];
    if (nx == null || nx.startsWith('--')) o[k] = true; else { o[k] = nx; i++; }
  }
  return o;
}

async function loadPlanner() {
  const { planLeague } = await import('../../server/services/campaign/planner.js');
  const { normaliseObjective } = await import('../../server/services/campaign/objectives.js');
  return { planLeague, objective: normaliseObjective({}) };
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

async function runShard(o) {
  const leagues = readJsonl(o.data);
  const [k, n] = String(o.shard ?? '0/1').split('/').map(Number);
  const planner = await loadPlanner();
  const out = fs.openSync(o['rows-out'], 'w');
  let i = 0;
  for (const L of leagues) {
    if (i++ % n !== k) continue;
    if (o.limit && i > Number(o.limit) * n) break;
    const r = await replayLeague(L, { planner, focal: Number(o.focal ?? FOCAL_PER_LEAGUE), runs: Number(o.runs ?? RUNS) });
    fs.writeSync(out, JSON.stringify(r.skipped ? { skipped: r.skipped, season: L.season } : { rows: r.rows }) + '\n');
  }
  fs.closeSync(out);
}

export async function main(argv = process.argv.slice(2)) {
  const o = args(argv);
  if (o['write-report']) return writeReport();
  if (o.shard) return runShard(o);
  const seasons = String(o.seasons ?? '').split('-').map(Number);
  if (seasons.length !== 2) throw new Error('--seasons A-B required');
  const tmp = fs.mkdtempSync(path.join(o.tmp ?? os.tmpdir(), 'e4-'));
  const data = path.join(tmp, 'leagues.jsonl');
  const t0 = Date.now();
  const ex = exportLeagues({ sh: o.sh, cache: o.cache, seasons, out: data });
  console.log(`export: ${ex.leagues} league-seasons (${JSON.stringify(ex.skip)}) in ${Math.round((Date.now() - t0) / 1000)} s`);
  if (o.fit) {
    const fit = fitSim(readJsonl(data));
    console.log(JSON.stringify(fit, null, 1));
    fs.rmSync(tmp, { recursive: true, force: true });
    return;
  }
  if (FIT.sd_a == null) throw new Error('FIT is not frozen: run --seasons 2021-2022 --fit first');
  const jobs = Number(o.jobs ?? 1);
  const self = fileURLToPath(import.meta.url);
  await Promise.all(Array.from({ length: jobs }, (_, k) => new Promise((resolve, reject) => {
    const extra = ['focal', 'runs', 'limit'].flatMap(x => (o[x] != null ? [`--${x}`, String(o[x])] : []));
    const c = spawn(process.execPath, [self, '--shard', `${k}/${jobs}`, '--data', data, '--rows-out', path.join(tmp, `rows-${k}.jsonl`), ...extra],
      { stdio: ['ignore', 'inherit', 'inherit'] });
    c.on('exit', code => (code === 0 ? resolve() : reject(new Error(`shard ${k} exited ${code}`))));
  })));
  const parts = Array.from({ length: jobs }, (_, k) => readJsonl(path.join(tmp, `rows-${k}.jsonl`))).flat();
  const rows = parts.flatMap(p => p.rows ?? []).filter(r => !r.error);
  const skipped = parts.filter(p => p.skipped).length;
  const errors = parts.flatMap(p => p.rows ?? []).filter(r => r.error).length;
  const summary = summarizeRows(rows, { seasons, exported: ex.leagues, skipped_format: skipped, errors });
  summary.runtime_s = Math.round((Date.now() - t0) / 1000);
  const file = { study: 'EVAL-E4 planner vs simple baselines (Sleeper replay)', real_behavior_only: false, seasons, summary, rows };
  if (o.out) { fs.mkdirSync(path.dirname(o.out), { recursive: true }); fs.writeFileSync(o.out, JSON.stringify(file)); }
  console.log(JSON.stringify(summary, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
  return summary;
}

/** The aggregate the grader freezes (every number an aggregate; no ids). */
export function summarizeRows(rows, meta = {}) {
  const done = rows.map(r => ({ ...r, planner: { title: r.planner.title_done, playoff: r.planner.playoff_done },
    finder: { title: r.finder.title_done, playoff: r.finder.playoff_done }, greedy: { title: r.greedy.title_done, playoff: r.greedy.playoff_done } }));
  const bySeason = {};
  for (const s of [...new Set(rows.map(r => r.season))].sort()) {
    bySeason[s] = e4.roundSummary(e4.summarize(rows.filter(r => r.season === s), { target: 'title' }));
  }
  const moved = arm => rows.filter(r => r[arm].steps > 0).length;
  const share = (xs, f) => (xs.length ? +(xs.filter(f).length / xs.length).toFixed(4) : null);
  return {
    ...meta,
    split: 'fit 2021-22 (simulator sd/miss rate), graded 2023-24, 2025 untouched',
    focal_teams: rows.length,
    title: e4.roundSummary(e4.summarize(rows, { target: 'title' })),
    playoff: e4.roundSummary(e4.summarize(rows, { target: 'playoff' })),
    title_if_completed: e4.roundSummary(e4.summarize(done, { target: 'title' })),
    playoff_if_completed: e4.roundSummary(e4.summarize(done, { target: 'playoff' })),
    by_season_title: bySeason,
    moves_made: { planner: moved('planner'), finder: moved('finder'), greedy: moved('greedy') },
    planner_mean_depth: rows.length ? +(rows.reduce((s, r) => s + r.planner.steps, 0) / rows.length).toFixed(3) : null,
    planner_mean_sim_expected: rows.length ? +(rows.filter(r => r.planner.steps).reduce((s, r) => s + r.planner.sim_expected, 0) / Math.max(1, moved('planner'))).toFixed(5) : null,
    same_first_move_as_finder: share(rows.filter(r => r.planner.steps), r => r.same_first_move.finder),
    same_first_move_as_greedy: share(rows.filter(r => r.planner.steps), r => r.same_first_move.greedy),
    fidelity_champion_do_nothing: share(rows, r => r.fidelity_champion),
    acceptance: `assumed: p = clamp(${ACCEPT.at_par} + ${ACCEPT.per_pct} x screen%, ${ACCEPT.lo}, ${ACCEPT.hi})`,
    runs: RUNS, decision_week: DECISION_WEEK, fit: FIT,
  };
}

/** Every grader, with E4 from e4-planner.js, stored as one brain_report run (GRIDIRON_DB_PATH: use a copy). */
async function writeReport() {
  process.env.SCHEDULER_DISABLED = '1';
  const { db } = await import('../../server/db/index.js');
  const { runMigrations } = await import('../../server/db/migrate.js');
  await runMigrations();
  const idx = await import('../../server/services/eval/index.js');
  const { results } = idx.runAll(db);
  const merged = [...results.filter(r => r.check !== e4.CHECK), ...e4.run(db)];
  const stored = idx.writeReport(db, merged);
  for (const r of merged.filter(x => x.check.startsWith('E4'))) {
    console.log(`${r.check}: ${r.status} metric ${r.metric} ci [${r.ci_low}, ${r.ci_high}] n ${r.n}${r.needs_text ? ` (${r.needs_text})` : ''}`);
  }
  console.log(`brain_report run ${stored.run_id}: ${stored.rows} rows`);
  return stored;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) {
  main().then(() => process.exit(0), e => { console.error(e.stack ?? e); process.exit(1); });
}
