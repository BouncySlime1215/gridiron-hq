#!/usr/bin/env node
/**
 * EA-06 pre-registration: the drift monitor's false-flip rate by simulation, at a range of
 * variance and cluster structures, before the rule goes live (ENGINE-SPECS "EA-05 monitor +
 * fallback" PRE; replaces the 2024 null replay, ML I7). No database: pure simulation of the
 * exact rule in server/services/engine/producers/monitor.js#decideDrift.
 *
 * Each season: `weeks` graded weeks; each week `players` paired players; the weekly paired
 * difference is shift + week effect N(0, between^2) + mean of `players` draws N(0, within^2).
 * The grader reports the week's mean, its sd and n; the monitor decides after every week.
 * Reported: false flips per season under the null (shift 0), per field alpha, and power.
 *
 *   node scripts/engine-monitor-null-sim.mjs [--seasons 2000] [--weeks 20] [--json]
 */
import { decideDrift, alphaFor } from '../server/services/engine/producers/monitor.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : dflt; };
const SEASONS = opt('seasons', 2000);
const WEEKS = opt('weeks', 20);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = u => { let x = 0; while (x === 0) x = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u()); };

function season(u, { shift, between, within, players, alpha }) {
  const weeks = [];
  let state = { status: 'ok' };
  for (let w = 1; w <= WEEKS; w++) {
    const b = between * normal(u);
    const xs = Array.from({ length: players }, () => shift + b + within * normal(u));
    const m = xs.reduce((s, x) => s + x, 0) / players;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (players - 1));
    weeks.push({ key: `2026:${w}`, d: m, n: players, entities: players, sd });
    const r = decideDrift({ weeks, prev: state, alpha });
    state = r.state;
    if (r.flip === 'fallback') return w;
  }
  return null;
}

const SCENARIOS = [
  { name: 'within only', between: 0, within: 1, players: 30 },
  { name: 'between = within/sqrt(n)', between: 1 / Math.sqrt(30), within: 1, players: 30 },
  { name: 'between = 3 x within/sqrt(n)', between: 3 / Math.sqrt(30), within: 1, players: 30 },
  { name: 'few players, between dominates', between: 0.5, within: 1, players: 20 },
];
const FIELDS = [1, 10, 20];
const out = [];
let seed = 20260924;
for (const sc of SCENARIOS) {
  for (const k of FIELDS) {
    const alpha = alphaFor(k);
    const u = rng(seed++);
    let flips = 0;
    for (let s = 0; s < SEASONS; s++) if (season(u, { ...sc, shift: 0, alpha }) != null) flips += 1;
    const se = Math.sqrt(Math.max(flips, 1) * (1 - flips / SEASONS)) / SEASONS;
    out.push({ scenario: sc.name, fields: k, alpha, null_flip_rate: flips / SEASONS, se: +se.toFixed(4),
      expected_false_flips_per_season: +(k * flips / SEASONS).toFixed(3) });
  }
  const sdWeek = Math.sqrt(sc.between ** 2 + sc.within ** 2 / sc.players);
  for (const effect of [0.5, 1]) {
    const u = rng(seed++);
    const alpha = alphaFor(10);
    const firsts = [];
    for (let s = 0; s < SEASONS; s++) firsts.push(season(u, { ...sc, shift: effect * sdWeek, alpha }));
    const hit = firsts.filter(x => x != null).sort((a, b) => a - b);
    out.push({ scenario: sc.name, power_at_effect_in_weekly_sd: effect, alpha, power: hit.length / SEASONS,
      median_weeks_to_flip: hit.length ? hit[hit.length >> 1] : null });
  }
}
if (args.includes('--json')) console.log(JSON.stringify({ seasons: SEASONS, weeks: WEEKS, rows: out }, null, 2));
else for (const r of out) console.log(JSON.stringify(r));
