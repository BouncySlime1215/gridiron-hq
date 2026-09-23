/**
 * WV-01 history check: does streaming the top-ranked defense each week gain points
 * over the defense you hold? Pre-registered in
 * docs/tdd/2026-09-23-wv-01-streaming-board.tdd.md section 2 (committed before this
 * script was run).
 *
 * It replays the production ranker, server/services/streaming-board.js#rankDefenses,
 * on each week's game_lines rows read through gamescript.js#linesFor. Nothing about
 * the ranking is re-implemented here.
 *
 * Run (local copy of the app database, never production; the nflverse mirror is
 * opened read-only):
 *   GRIDIRON_DB_PATH=<worktree>/.local-db/data.sqlite GRIDIRON_DB_INTEGRITY_CHECK=off \
 *   SCHEDULER_DISABLED=1 node docs/evidence/streaming-def-history.mjs \
 *     --nflverse <path>/data/line-history/nflverse.sqlite [--json out.json]
 *
 * Data: game_lines (lines, opponent, final scores; writer gamescript.js
 * syncHistoricalLinesImpl :55) and nflverse stats_team_week (team defensive counts,
 * CC BY 4.0, attributed in the app: docs/tdd/nflverse-attribution.tdd.md).
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const NV = arg('--nflverse');
if (!NV) throw new Error('--nflverse <path to nflverse.sqlite> is required');
if (!process.env.GRIDIRON_DB_PATH) throw new Error('GRIDIRON_DB_PATH must point at a local copy');

const { rankDefenses } = await import('../../server/services/streaming-board.js');
const { linesFor } = await import('../../server/services/gamescript.js');
const { canonicalTeamCode } = await import('../../server/services/team-codes.js');

const SEASONS = [2021, 2022, 2023, 2024, 2025, 2026];
const EVAL = [2022, 2023, 2024, 2025];
const WEEKS = 18;
const BEFORE_ANY_KICKOFF = new Date(0); // historical picks are made before the games: nothing is locked

// ------------------------------------------------------------------ DEF points
// The study's scoring, rnd/skill/build_01_points.py:11-12 and :126-141.
const paPoints = pa => (pa === 0 ? 10 : pa <= 6 ? 7 : pa <= 13 ? 4 : pa <= 20 ? 1 : pa <= 27 ? 0 : pa <= 34 ? -1 : -4);
const nv = new DatabaseSync(NV, { readOnly: true });
const counts = new Map();
for (const r of nv.prepare(`SELECT season, week, team, def_sacks, def_interceptions, fumble_recovery_opp,
    def_fumbles_forced, def_tds, def_safeties, special_teams_tds, def_fg_blocks, def_punt_blocks, def_pat_blocks
    FROM stats_team_week WHERE season BETWEEN 2021 AND 2026 AND season_type = 'REG'`).all()) {
  counts.set(`${r.season}|${r.week}|${canonicalTeamCode(r.team)}`, r);
}
nv.close();

const lines = new Map();   // season|week -> game_lines rows
const pts = new Map();     // season|week|team -> DEF points
let noCounts = 0, noScore = 0;
for (const s of SEASONS) {
  for (let w = 1; w <= WEEKS; w++) {
    const ls = linesFor(s, w);
    if (!ls.length) continue;
    lines.set(`${s}|${w}`, ls);
    for (const g of ls) {
      const team = canonicalTeamCode(g.team);
      const c = counts.get(`${s}|${w}|${team}`);
      if (g.opp_score == null) { noScore++; continue; }
      if (!c) { noCounts++; continue; }
      const n = v => v ?? 0;
      pts.set(`${s}|${w}|${team}`, n(c.def_sacks) + 2 * n(c.def_interceptions) + 2 * n(c.fumble_recovery_opp)
        + n(c.def_fumbles_forced) + 2 * n(c.def_safeties)
        + 2 * (n(c.def_fg_blocks) + n(c.def_punt_blocks) + n(c.def_pat_blocks))
        + 6 * (n(c.def_tds) + n(c.special_teams_tds)) + paPoints(g.opp_score));
    }
  }
}
const P = (s, w, t) => pts.get(`${s}|${w}|${t}`);

// Points per game to date: same season before week w; before week 4, the previous season.
function ppgToDate(s, w) {
  const acc = new Map();
  const add = (ss, ww) => { for (const [k, v] of pts) { const [a, b, t] = k.split('|'); if (+a === ss && +b === ww) { const x = acc.get(t) ?? [0, 0]; x[0] += v; x[1]++; acc.set(t, x); } } };
  if (w < 4) { for (let ww = 1; ww <= WEEKS; ww++) add(s - 1, ww); } else { for (let ww = 1; ww < w; ww++) add(s, ww); }
  return new Map([...acc].map(([t, [a, n]]) => [t, a / n]));
}
const topK = (s, w, k) => new Set([...ppgToDate(s, w)].sort((a, b) => b[1] - a[1]).slice(0, k).map(([t]) => t));

// ------------------------------------------------------------------ simulation
function simulate(season, K, pickRule) {
  let held = null;
  const swaps = [];
  const picks = [];
  for (let w = 1; w <= WEEKS; w++) {
    const ls = lines.get(`${season}|${w}`);
    if (!ls) continue;
    const others = topK(season, w, K);
    const ranked = rankDefenses(ls, { now: BEFORE_ANY_KICKOFF });
    const pool = ranked.filter(r => (!others.has(r.team) || r.team === held) && r.opp_implied != null && P(season, w, r.team) != null);
    const X = pickRule(pool, season, w);
    if (!X) continue;
    picks.push({ w, team: X.team, pts: P(season, w, X.team) });
    if (held && X.team !== held) {
      const yPts = P(season, w, held);
      const yRank = ranked.find(r => r.team === held);
      if (yPts != null && yRank) {
        swaps.push({ season, w, add: X.team, drop: held, gain: P(season, w, X.team) - yPts,
          edge: yRank.opp_implied - X.opp_implied });
      }
    }
    held = X.team;
  }
  return { swaps, picks };
}
const byImplied = pool => pool[0] ?? null; // rankDefenses already sorted, lowest opponent implied first
const byLastWeek = (pool, s, w) => {
  const last = t => (w > 1 ? P(s, w - 1, t) : null);
  return [...pool].sort((a, b) => (last(b.team) ?? -Infinity) - (last(a.team) ?? -Infinity) || a.rank - b.rank)[0] ?? null;
};

// ------------------------------------------------------------------ statistics
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
function boot(values, stat = mean, B = 10000, seed = 1) {
  const r = rng(seed); const out = [];
  for (let b = 0; b < B; b++) { const s = []; for (let i = 0; i < values.length; i++) s.push(values[Math.floor(r() * values.length)]); out.push(stat(s)); }
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * B)], out[Math.floor(0.975 * B) - 1]];
}
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const f2 = v => (v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2));
function summary(gains) {
  if (!gains.length) return { n: 0 };
  const [lo, hi] = boot(gains);
  const se = sd(gains) / Math.sqrt(gains.length);
  return { n: gains.length, mean: mean(gains), lo, hi, se, mde80: 2.8 * se };
}

const out = { pts_rows: pts.size, no_counts: noCounts, no_score: noScore, K: {} };
console.log(`DEF team-weeks scored: ${pts.size} (skipped: ${noScore} without a final score, ${noCounts} without nflverse counts)`);
for (const s of EVAL) {
  const n = [...pts.keys()].filter(k => k.startsWith(`${s}|`)).length;
  console.log(`  ${s}: ${n} team-weeks, mean ${f2(mean([...pts].filter(([k]) => k.startsWith(`${s}|`)).map(([, v]) => v)))} pts/game`);
}

for (const K of [10, 0, 16]) {
  const res = { seasons: {} };
  const all = [], dev = [], hold = [], chaseAll = [], edges = [];
  let wins = 0, weeks = 0;
  for (const s of EVAL) {
    const a = simulate(s, K, byImplied);
    const c = simulate(s, K, byLastWeek);
    const g = a.swaps.map(x => x.gain);
    res.seasons[s] = summary(g);
    all.push(...g); (s === 2025 ? hold : dev).push(...g);
    chaseAll.push(...c.swaps.map(x => x.gain));
    edges.push(...a.swaps.map(x => x.edge));
    const cp = new Map(c.picks.map(p => [p.w, p.pts]));
    for (const p of a.picks) { if (!cp.has(p.w)) continue; weeks++; wins += p.pts > cp.get(p.w) ? 1 : p.pts === cp.get(p.w) ? 0.5 : 0; }
  }
  res.pooled = summary(all); res.dev = summary(dev); res.holdout2025 = summary(hold);
  res.chase = summary(chaseAll);
  res.mean_edge = mean(edges);
  res.decision_win_rate = { rate: wins / weeks, weeks };
  out.K[K] = res;
  console.log(`\nK = ${K} (defenses assumed rostered by the other managers)`);
  for (const s of EVAL) { const x = res.seasons[s]; console.log(`  ${s}: swaps ${x.n}, gain ${f2(x.mean)} [${f2(x.lo)}, ${f2(x.hi)}]`); }
  const line = (lab, x) => console.log(`  ${lab}: swaps ${x.n}, gain ${f2(x.mean)} [${f2(x.lo)}, ${f2(x.hi)}], SE ${x.se?.toFixed(2)}, MDE80 ${x.mde80?.toFixed(2)}`);
  line('pooled 2022-2025', res.pooled); line('dev 2022-2024', res.dev); line('held-out 2025', res.holdout2025);
  line('chase baseline (most points last week), pooled', res.chase);
  console.log(`  mean implied-point edge per swap ${f2(res.mean_edge)}; weekly decision win rate, implied pick vs chase pick: ${(100 * res.decision_win_rate.rate).toFixed(1)}% of ${weeks} weeks`);
}

// Comparator 2: holding one drafted defense all season (11th best by previous-season ppg), K = 10.
{
  const g = [];
  for (const s of EVAL) {
    const prev = [...ppgToDate(s, 1)].sort((a, b) => b[1] - a[1]);
    const drafted = prev[10]?.[0];
    const a = simulate(s, 10, byImplied);
    for (const p of a.picks) { const d = P(s, p.w, drafted); if (p.team !== drafted && d != null) g.push(p.pts - d); }
  }
  out.vs_drafted = summary(g);
  const x = out.vs_drafted;
  console.log(`\nvs holding the drafted defense (K = 10): weeks ${x.n}, gain ${f2(x.mean)} [${f2(x.lo)}, ${f2(x.hi)}]`);
}

// Mechanism: D/ST points on opponent implied total, every team-week 2022-2025, bootstrap by NFL week.
{
  const byWeek = new Map();
  for (const s of EVAL) for (let w = 1; w <= WEEKS; w++) {
    const ls = lines.get(`${s}|${w}`); if (!ls) continue;
    const obs = rankDefenses(ls, { now: BEFORE_ANY_KICKOFF }).filter(r => r.opp_implied != null && P(s, w, r.team) != null)
      .map(r => [r.opp_implied, P(s, w, r.team)]);
    byWeek.set(`${s}|${w}`, obs);
  }
  const slope = weeks => { const o = weeks.flat(); const mx = mean(o.map(v => v[0])), my = mean(o.map(v => v[1]));
    let sxy = 0, sxx = 0; for (const [x, y] of o) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; } return sxy / sxx; };
  const wk = [...byWeek.values()];
  const b = slope(wk);
  const [lo, hi] = boot(wk, slope, 2000, 1);
  out.mechanism = { per_implied_point: -b, lo: -hi, hi: -lo, team_weeks: wk.flat().length, weeks: wk.length };
  console.log(`mechanism: each implied point LOWER for the opponent = ${f2(-b)} D/ST points [${f2(-hi)}, ${f2(-lo)}], ${wk.flat().length} team-weeks, ${wk.length} NFL weeks (study: +0.446, by-week [0.345, 0.554])`);
}

// Forward 2026: a swap-week needs two consecutive scored weeks.
{
  const w26 = [...new Set([...pts.keys()].filter(k => k.startsWith('2026|')).map(k => +k.split('|')[1]))].sort((a, b) => a - b);
  out.forward2026 = { scored_weeks: w26, swaps: simulate(2026, 10, byImplied).swaps.length };
  console.log(`forward 2026: scored weeks [${w26.join(', ')}], swap-weeks computable ${out.forward2026.swaps}`);
}

const pr = out.K[10];
const pass1 = pr.pooled.mean > 0 && pr.pooled.lo > 0;
const pass2 = pr.pooled.lo <= 2.55 && pr.pooled.hi >= 1.38;
const pass3 = pr.holdout2025.mean > 0;
out.ship_rule = { lower_bound_above_zero: pass1, overlaps_study_ci: pass2, holdout_positive: pass3, pass: pass1 && pass2 && pass3 };
console.log(`\nship rule (pre-registered, K = 10): lower bound > 0 ${pass1}; overlaps [1.38, 2.55] ${pass2}; 2025 positive ${pass3} => ${out.ship_rule.pass ? 'PASS' : 'FAIL'}`);
if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(out, null, 2));
