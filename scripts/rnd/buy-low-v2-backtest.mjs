#!/usr/bin/env node
/**
 * BUY-LOW v2 (gap-only) vs v1, exactly as pre-registered in docs/tdd/BUY-LOW-V2-PREREG.md.
 * Same design as v1 (scripts/rnd/buy-low-backtest.mjs, whose loaders and matching it reuses):
 * primary on held-out 2021-2022; 2023-2025 reported as a secondary that is not new evidence.
 *
 * Usage: node scripts/rnd/buy-low-v2-backtest.mjs --db <copy.sqlite> [--out <results.json>]
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadGames, buildRows, effects, bootstrap, rng, mean, POSITIONS, MIN_ROWS, B, SEED } from './buy-low-backtest.mjs';

const HELD_OUT = [2021, 2022];
const SEEN = [2023, 2024, 2025];
const MARGIN = 0.5;
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);

const V1 = r => r.flag;
const V2 = r => r.flagV2;

/** diff = mean v2 effect - mean v1 effect, with a cluster bootstrap over the union of both arms' clusters. */
export function headToHead(e1, e2, { b = B, seed = SEED } = {}) {
  const by = new Map();
  const add = (arm, x) => { if (!by.has(x.cluster)) by.set(x.cluster, { v1: [], v2: [] }); by.get(x.cluster)[arm].push(x.e); };
  for (const x of e1) add('v1', x);
  for (const x of e2) add('v2', x);
  const groups = [...by.values()];
  if (!e1.length || !e2.length) return { estimate: null, lo: null, hi: null };
  const rand = rng(seed);
  const stats = [];
  for (let i = 0; i < b; i++) {
    let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
    for (let j = 0; j < groups.length; j++) {
      const g = groups[Math.floor(rand() * groups.length)];
      for (const e of g.v1) { s1 += e; n1++; }
      for (const e of g.v2) { s2 += e; n2++; }
    }
    if (n1 && n2) stats.push(s2 / n2 - s1 / n1);
  }
  stats.sort((x, y) => x - y);
  return { estimate: r2(mean(e2.map(x => x.e)) - mean(e1.map(x => x.e))),
    lo: r2(stats[Math.floor(0.025 * stats.length)]), hi: r2(stats[Math.ceil(0.975 * stats.length) - 1]), resamples_used: stats.length };
}

function arm(rows, isFlag, opts = {}) {
  const { eff, dropped } = effects(rows, { isFlag, ...opts });
  const per = Object.fromEntries(POSITIONS.map(pos => { const r = bootstrap(eff.filter(x => x.position === pos)); return [pos, { ...r, too_few: r.n < MIN_ROWS }]; }));
  return { eff, summary: { pooled: { ...bootstrap(eff), dropped, flagged_rows: rows.filter(isFlag).length }, per_position: per } };
}

function compare(rows) {
  const a1 = arm(rows, V1), a2 = arm(rows, V2);
  const perDiff = Object.fromEntries(POSITIONS.map(pos => [pos, headToHead(a1.eff.filter(x => x.position === pos), a2.eff.filter(x => x.position === pos))]));
  return { player_weeks: rows.length, v1: a1.summary, v2: a2.summary, diff_v2_minus_v1: { pooled: headToHead(a1.eff, a2.eff), per_position: perDiff } };
}

async function main() {
  const dbPath = arg('--db');
  if (!dbPath) throw new Error('--db <copy.sqlite> is required (a copy, never the live DB)');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const held = buildRows(loadGames(db, { seasons: HELD_OUT }), { seasons: HELD_OUT });
  const seen = buildRows(loadGames(db, { seasons: SEEN }), { seasons: SEEN });
  const primary = compare(held);
  const v2Pass = primary.v2.pooled.lo != null && primary.v2.pooled.lo > 0;
  const nonInferior = primary.diff_v2_minus_v1.pooled.lo != null && primary.diff_v2_minus_v1.pooled.lo > -MARGIN;
  const replace = v2Pass && nonInferior;
  const servedPositions = replace ? POSITIONS.filter(p => { const r = primary.v2.per_position[p]; return !r.too_few && r.lo != null && r.lo > 0; }) : [];
  const out = {
    prereg: 'docs/tdd/BUY-LOW-V2-PREREG.md', held_out: HELD_OUT, margin: MARGIN,
    bootstrap: { resamples: B, seed: SEED, cluster: 'player-season' },
    primary: { ...primary, v2_pass: v2Pass, non_inferior: nonInferior, replace_v1: replace, v2_served_positions: servedPositions },
    secondary: {
      seen_2023_2025_not_new_evidence: compare(seen),
      v2_xfp_matched_held_out: arm(held, V2, { matchXfp: true }).summary,
    },
  };
  const json = JSON.stringify(out, null, 2);
  if (arg('--out')) fs.writeFileSync(arg('--out'), json + '\n');
  console.log(json);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.stack ?? e); process.exit(1); });
