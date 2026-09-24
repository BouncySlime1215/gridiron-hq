#!/usr/bin/env node
/**
 * ACTIVITY-01 grade: the SHIPPED add intensity (server/services/people/activity-intensity.js)
 * against the constant-rate baseline it replaces (leagueBaselineRate, r25 IDEA-084's B0),
 * scored as held-out Poisson log-likelihood per team-week on the Sleeper corpus.
 *
 *   node scripts/rnd/grade-activity-intensity.mjs --corpus <copy of team_seasons.sqlite>
 *
 * Same league filters and rows as rnd/loop/scripts/r25_IDEA-084_pp.py (weeks 3..reg_end,
 * complete leagues with reg_end >= 10). The coefficients were fit on 2021-22, so 2021-22
 * is in-sample and printed for reference only; 2023 and 2024 are the grade. Never 2025
 * (asserted). 90% intervals: league bootstrap, fixed seed. Aggregates only; no ids printed.
 *
 * Part 2, the consumer: counterparty-pricing's activityFactor (the "how active"
 * term behind P(responds)) scored with the constant rate it reads today vs the
 * intensity, as the within-league-week AUC for "he completes a trade in week w",
 * over league-weeks where someone traded (RL-11-1's conditioning). ACTIVITY_FIT
 * was fit on 2021-23, so only 2024 is held out for this part.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  leagueActivityIntensity, leagueBaselineRate, poissonLogLik,
} from '../../server/services/people/activity-intensity.js';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const corpusPath = arg('--corpus');
if (!corpusPath) { console.error('usage: --corpus <copy of team_seasons.sqlite>'); process.exit(2); }
const RESAMPLES = 2000;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

const db = new DatabaseSync(corpusPath, { readOnly: true });
const ts = db.prepare(`SELECT lg, season, roster_id, playoff_week_start FROM team_seasons
  WHERE season IN (2021, 2022, 2023, 2024) AND source = 'sleeper'
    AND league_extreme_scores = 0 AND league_dead = 0`).all();
if (Math.max(...ts.map(r => r.season)) > 2024) throw new Error('2025 must stay held out');
const tw = new Map();
for (const r of db.prepare(`SELECT lg, season, roster_id, week, points, opp_roster_id, dead_starts, empty_starts
                            FROM team_weeks WHERE season IN (2021, 2022, 2023, 2024)`).iterate()) {
  tw.set(`${r.lg}|${r.season}|${r.roster_id}|${r.week}`, r);
}
const tradeWeeks = new Set();
for (const r of db.prepare(`SELECT DISTINCT lg, season, roster_id, leg_week AS w FROM trade_sides
                            WHERE season IN (2021, 2022, 2023, 2024)`).iterate()) {
  tradeWeeks.add(`${r.lg}|${r.season}|${r.roster_id}|${r.w}`);
}
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'activity-01-grade-')), 'x.sqlite');
const { activityFactor } = await import('../../server/services/counterparty-pricing.js');
const aucRows = new Map([[2023, []], [2024, []]]);
const addCount = new Map();
for (const r of db.prepare(`SELECT lg, season, roster_id, leg_week AS w, COUNT(*) AS n FROM adds
                            WHERE season IN (2021, 2022, 2023, 2024) GROUP BY 1, 2, 3, 4`).iterate()) {
  addCount.set(`${r.lg}|${r.season}|${r.roster_id}|${r.w}`, r.n);
}

const groups = new Map();
for (const r of ts) {
  const k = `${r.lg}|${r.season}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

// Per season: league -> [sum LL intensity, sum LL baseline, rows].
const bySeason = new Map([[2021, []], [2022, []], [2023, []], [2024, []]]);
let complete = 0;
for (const [k, g] of groups) {
  const regEnd = g.map(r => Math.min((r.playoff_week_start ?? 15) - 1, 14));
  if (new Set(regEnd).size !== 1 || regEnd[0] < 10) continue;
  const R = regEnd[0];
  const ids = g.map(r => r.roster_id);
  let ok = true;
  const teams = ids.map(id => {
    const t = { roster_id: String(id), adds: [], points: [], opp_points: [], dead: [], empty: [] };
    for (let w = 1; w <= R; w++) {
      const row = tw.get(`${k}|${id}|${w}`);
      const opp = row && tw.get(`${k}|${row.opp_roster_id}|${w}`);
      if (!row || !opp || row.points == null || opp.points == null || !ids.includes(row.opp_roster_id)) { ok = false; break; }
      t.adds.push(addCount.get(`${k}|${id}|${w}`) ?? 0);
      t.points.push(row.points);
      t.opp_points.push(opp.points);
      t.dead.push(row.dead_starts ?? 0);
      t.empty.push(row.empty_starts ?? 0);
    }
    return t;
  });
  if (!ok) continue;
  complete++;
  let llI = 0, llB = 0, n = 0;
  for (let w = 3; w <= R; w++) {
    const hist = teams.map(t => ({ ...t, adds: t.adds.slice(0, w - 1) }));
    const lam = leagueActivityIntensity(hist, w);
    const base = leagueBaselineRate(hist, w);
    for (const t of teams) {
      const y = t.adds[w - 1];
      llI += poissonLogLik(y, lam.get(t.roster_id).lambda);
      llB += poissonLogLik(y, base.get(t.roster_id));
      n++;
    }
    const season = Number(k.split('|')[1]);
    if (!aucRows.has(season)) continue;
    const lw = teams.map(t => {
      const traded = Array.from({ length: w - 1 }, (_, i) => tradeWeeks.has(`${k}|${t.roster_id}|${i + 1}`)).some(Boolean);
      return { y: tradeWeeks.has(`${k}|${t.roster_id}|${w}`) ? 1 : 0, metrics: {
        tx_adds_per_week: t.adds.slice(0, w - 1).reduce((a, b) => a + b, 0) / (w - 1),
        tx_adds_intensity: lam.get(t.roster_id).lambda, tx_completed_trades: traded ? 1 : 0 } };
    });
    if (!lw.some(r => r.y)) continue;
    const mean = { adds: lw.reduce((a, r) => a + r.metrics.tx_adds_per_week, 0) / lw.length,
      traded: lw.reduce((a, r) => a + r.metrics.tx_completed_trades, 0) / lw.length,
      intensity: lw.reduce((a, r) => a + r.metrics.tx_adds_intensity, 0) / lw.length };
    // The weeks gate is lifted (as RL-11-1's grade does) so every row is scored.
    const samples = { tx_adds_per_week: 99 };
    for (const r of lw) {
      r.before = activityFactor({ ...r.metrics, tx_adds_intensity: undefined }, samples, { ...mean, intensity: null }).effect;
      r.after = activityFactor(r.metrics, samples, mean).effect;
    }
    aucRows.get(season).push({ lg: k, rows: lw });
  }
  bySeason.get(Number(k.split('|')[1])).push([llI, llB, n]);
}

console.log(`complete league-seasons ${complete}`);
const rand = rng(20260924);
for (const [season, L] of bySeason) {
  const sum = xs => xs.reduce((a, r) => [a[0] + r[0], a[1] + r[1], a[2] + r[2]], [0, 0, 0]);
  const [i, b, n] = sum(L);
  const boots = [];
  for (let s = 0; s < RESAMPLES; s++) {
    const [bi, bb, bn] = sum(Array.from({ length: L.length }, () => L[Math.floor(rand() * L.length)]));
    boots.push((bi - bb) / bn);
  }
  const f = x => (x >= 0 ? '+' : '') + x.toFixed(5);
  console.log(`${season}${season <= 2022 ? ' (in-sample)' : ' (held out)'}: ${L.length} leagues, ${n} team-weeks; `
    + `LL/row constant rate ${(b / n).toFixed(4)} -> intensity ${(i / n).toFixed(4)}; `
    + `gain ${f((i - b) / n)} [${f(pct(boots, 0.05))}, ${f(pct(boots, 0.95))}] nats/team-week`);
}

function aucWithin(groups, key) {
  let num = 0, den = 0;
  for (const g of groups) {
    const pos = g.rows.filter(r => r.y === 1), neg = g.rows.filter(r => r.y === 0);
    for (const p of pos) for (const q of neg) num += p[key] > q[key] ? 1 : p[key] === q[key] ? 0.5 : 0;
    den += pos.length * neg.length;
  }
  return den ? num / den : NaN;
}
console.log('consumer: activityFactor AUC, trade completed in week w, league-weeks with a trade');
for (const [season, G] of aucRows) {
  const byLg = new Map();
  for (const g of G) (byLg.get(g.lg) ?? byLg.set(g.lg, []).get(g.lg)).push(g);
  const lgs = [...byLg.values()];
  const boots = [];
  for (let s = 0; s < RESAMPLES; s++) {
    const pick = Array.from({ length: lgs.length }, () => lgs[Math.floor(rand() * lgs.length)]).flat();
    boots.push(aucWithin(pick, 'after') - aucWithin(pick, 'before'));
  }
  const b = aucWithin(G, 'before'), a = aucWithin(G, 'after');
  const f = x => (x >= 0 ? '+' : '') + x.toFixed(4);
  console.log(`${season}${season <= 2023 ? ' (ACTIVITY_FIT in-sample)' : ' (held out)'}: ${G.length} league-weeks, `
    + `${G.reduce((n, g) => n + g.rows.length, 0)} team-weeks; AUC constant rate ${b.toFixed(4)} -> intensity ${a.toFixed(4)} `
    + `(${f(a - b)} [${f(pct(boots, 0.05))}, ${f(pct(boots, 0.95))}])`);
}
