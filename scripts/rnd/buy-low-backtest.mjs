#!/usr/bin/env node
/**
 * BUY-LOW backtest, exactly as pre-registered in docs/tdd/BUY-LOW-PREREG.md (rule v1).
 *
 * Reads a COPY of the app DB (never the live file): nfl_ffopportunity_weekly (xFP, actual, full PPR),
 * player_week_usage (target share, carries, targets) joined through players.gsis_id -> players.id.
 * Every as-of read goes through campaign/buy-low.js#scoreBuyLow, the producer itself, so the
 * backtest and the served number are one producer.
 *
 * Usage: node scripts/rnd/buy-low-backtest.mjs --db <copy.sqlite> [--out <results.json>]
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { scoreBuyLow, priorGames, BUY_LOW_RULE } from '../../server/services/campaign/buy-low.js';

const SEASONS = [2023, 2024, 2025];
const WEEKS = { from: 4, to: 15 };
const MAX_CONTROLS = 5;
const MATCH_PPG = 2.0;
const B = 2000;
const SEED = 20260925;
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const MIN_ROWS = 30;

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

/** Deterministic PRNG (mulberry32), so the CI is reproducible from the seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;

export function loadGames(db) {
  const rows = db.prepare(`SELECT o.player_gsis_id AS gsis, o.position, o.season, o.week,
      o.expected_fantasy_points AS xfp, o.actual_fantasy_points AS act, u.target_share, u.carries, u.targets
    FROM nfl_ffopportunity_weekly o
    LEFT JOIN players p ON p.gsis_id = o.player_gsis_id
    LEFT JOIN player_week_usage u ON u.player_id = p.id AND u.season = o.season AND u.week = o.week
    WHERE o.season BETWEEN ? AND ? AND o.week <= ? AND o.position IN ('QB','RB','WR','TE')`)
    .all(SEASONS[0] - 1, SEASONS[SEASONS.length - 1], BUY_LOW_RULE.last_regular_week);
  const by = new Map();
  const seen = new Set();
  for (const r of rows) {
    // One row per player-game even if two app players share a gsis id.
    const k = `${r.gsis}:${r.season}:${r.week}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!by.has(r.gsis)) by.set(r.gsis, { position: r.position, games: [] });
    by.get(r.gsis).games.push({ season: r.season, week: r.week, xfp: r.xfp, act: r.act,
      target_share: r.target_share, carries: r.carries, targets: r.targets });
  }
  return by;
}

/** Every eligible player-week (prereg "Test"), with the detector's read as of that week. */
export function buildRows(players) {
  const out = [];
  for (const [gsis, p] of players) {
    for (const season of SEASONS) {
      for (let W = WEEKS.from; W <= WEEKS.to; W++) {
        const T = priorGames(p.games, { season, week: W }).filter(g => g.season === season).sort((a, b) => a.week - b.week).slice(-3);
        if (T.length < 2) continue;
        const xfpT = mean(T.map(g => g.xfp));
        if (xfpT < BUY_LOW_RULE.min_xfp_ppg) continue;
        const next = p.games.filter(g => g.season === season && g.week >= W && g.week <= W + 2);
        if (next.length < 2) continue;
        const read = scoreBuyLow(p, { season, week: W });
        const prior3 = mean(T.map(g => g.act));
        out.push({ gsis, season, W, position: p.position, prior3, xfpT, gain: mean(next.map(g => g.act)) - prior3,
          flag: read.buy_low === true, role: read.role, status: read.status,
          gapOnly: (xfpT - prior3) * T.length / (T.length + BUY_LOW_RULE.shrink_games) >= BUY_LOW_RULE.min_gap_ppg });
      }
    }
  }
  return out;
}

/** Matched-control effects for flagged rows; isFlag picks the arm, matchXfp adds the xFP match. */
export function effects(rows, { isFlag = r => r.flag, matchXfp = false, subset = () => true } = {}) {
  const cell = new Map();
  for (const r of rows) {
    const k = `${r.season}:${r.W}:${r.position}`;
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(r);
  }
  const eff = [];
  let dropped = 0;
  for (const r of rows) {
    if (!isFlag(r) || !subset(r)) continue;
    const pool = cell.get(`${r.season}:${r.W}:${r.position}`).filter(c => !isFlag(c)
      && Math.abs(c.prior3 - r.prior3) <= MATCH_PPG && (!matchXfp || Math.abs(c.xfpT - r.xfpT) <= MATCH_PPG))
      .sort((a, b) => (Math.abs(a.prior3 - r.prior3) - Math.abs(b.prior3 - r.prior3)) || a.gsis.localeCompare(b.gsis))
      .slice(0, MAX_CONTROLS);
    if (!pool.length) { dropped++; continue; }
    eff.push({ cluster: `${r.gsis}:${r.season}`, position: r.position, e: r.gain - mean(pool.map(c => c.gain)) });
  }
  return { eff, dropped };
}

/** Mean effect with a percentile bootstrap CI over player-season clusters. */
export function bootstrap(eff, { b = B, seed = SEED } = {}) {
  if (!eff.length) return { n: 0, clusters: 0, estimate: null, lo: null, hi: null };
  const cl = new Map();
  for (const x of eff) { if (!cl.has(x.cluster)) cl.set(x.cluster, []); cl.get(x.cluster).push(x.e); }
  const groups = [...cl.values()];
  const rand = rng(seed);
  const stats = [];
  for (let i = 0; i < b; i++) {
    let s = 0, n = 0;
    for (let j = 0; j < groups.length; j++) { const g = groups[Math.floor(rand() * groups.length)]; for (const e of g) { s += e; n++; } }
    stats.push(s / n);
  }
  stats.sort((x, y) => x - y);
  const r2 = x => Math.round(x * 100) / 100;
  return { n: eff.length, clusters: groups.length, estimate: r2(mean(eff.map(x => x.e))),
    lo: r2(stats[Math.floor(0.025 * b)]), hi: r2(stats[Math.ceil(0.975 * b) - 1]) };
}

function report(rows, opts) {
  const { eff, dropped } = effects(rows, opts);
  const pooled = { ...bootstrap(eff), dropped };
  const per = Object.fromEntries(POSITIONS.map(pos => {
    const r = bootstrap(eff.filter(x => x.position === pos));
    return [pos, { ...r, too_few: r.n < MIN_ROWS }];
  }));
  return { pooled, per_position: per };
}

async function main() {
  const dbPath = arg('--db');
  if (!dbPath) throw new Error('--db <copy.sqlite> is required (a copy, never the live DB)');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const players = loadGames(db);
  const rows = buildRows(players);
  const primary = report(rows, {});
  const pooledPass = primary.pooled.lo != null && primary.pooled.lo > 0;
  for (const [pos, r] of Object.entries(primary.per_position)) {
    r.passes = pooledPass && !r.too_few && r.lo != null && r.lo > 0;
  }
  const out = {
    prereg: 'docs/tdd/BUY-LOW-PREREG.md', rule_version: BUY_LOW_RULE.version, seasons: SEASONS, weeks: WEEKS,
    bootstrap: { resamples: B, seed: SEED, cluster: 'player-season' },
    universe: { player_weeks: rows.length, flagged: rows.filter(r => r.flag).length,
      detected: rows.filter(r => r.flag && r.role === 'detected').length, confirmed: rows.filter(r => r.flag && r.role === 'confirmed').length,
      no_baseline: rows.filter(r => r.status === 'no_baseline').length },
    primary: { ...primary, pass: pooledPass },
    secondary: {
      detected: report(rows, { subset: r => r.role === 'detected' }),
      confirmed: report(rows, { subset: r => r.role === 'confirmed' }),
      xfp_matched: report(rows, { matchXfp: true }),
      gap_only: report(rows, { isFlag: r => r.gapOnly }),
    },
  };
  const json = JSON.stringify(out, null, 2);
  if (arg('--out')) fs.writeFileSync(arg('--out'), json + '\n');
  console.log(json);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.stack ?? e); process.exit(1); });
