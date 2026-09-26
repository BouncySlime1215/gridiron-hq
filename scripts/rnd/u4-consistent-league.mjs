#!/usr/bin/env node
/**
 * U4 CONSISTENT-CHIP, one league now: rule D (scripts/rnd/consistent-chip.mjs) on every 83+ player of the
 * served blue-chip board. Descriptive (every position is read); the served reader is SERVED_POSITIONS,
 * which the pre-registered test left empty. Prints ids, positions and reasons only (no names).
 *
 * Usage: node scripts/rnd/u4-consistent-league.mjs --db <copy.sqlite> --plans <plans copy.json> [--league 4] [--season 2026]
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { RULE, SERVED_POSITIONS, starterBaselines, teamWindow, consistentRead, consistentOfFrom } from './consistent-chip.mjs';
import { residuals } from '../../server/services/range-residuals.js';
import { loadGames } from './u4-consistent-backtest.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const db = new DatabaseSync(arg('--db'), { readOnly: true });
const plans = JSON.parse(fs.readFileSync(arg('--plans'), 'utf8'));
const league = String(arg('--league', '4'));
const season = Number(arg('--season', '2026'));
const entry = plans.leagues.find(l => String(l.league) === league);
if (entry?.blue_chips?.status !== 'ok') throw new Error(`league ${league}: no served blue-chip board`);
const games = loadGames(db, { from: season - 1, to: season });
const week = 1 + Math.max(...games.rows.filter(g => g.season === season).map(g => g.week));
const baselines = starterBaselines(games.rows.filter(g => g.season === season - 1));
const repWeek = db.prepare('SELECT MAX(week) AS w FROM nfl_injuries WHERE season = ?').get(season).w;
const status = id => db.prepare('SELECT report_status AS s FROM nfl_injuries WHERE season = ? AND week = ? AND gsis_id = ?').get(season, repWeek, id)?.s ?? null;
const gsisOf = id => db.prepare('SELECT gsis_id FROM players WHERE id = ?').get(Number(id))?.gsis_id ?? null;
const hasCal = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'range_calibration'`).get();
const cal = hasCal ? db.prepare(`SELECT k FROM range_calibration WHERE decision IN ('initial','refit','kept') ORDER BY id DESC LIMIT 1`).get() : null;
const table = residuals();
const k = cal ? Number(cal.k) : Number(table.k.value);
const inputs = new Map();
const out = [];
for (const r of entry.blue_chips.value.rows) {
  if (!(r.score >= RULE.min_score)) continue;
  const g = gsisOf(r.player);
  const p = { position: r.position, score: r.score, hurt: r.hurt, injuryStatus: g ? status(g) : undefined,
    window: g && games.byId.has(g) ? teamWindow(games.byId.get(g), games.teamWeeks, { season, week }) : null, mean: r.parts?.prod_value ?? null };
  inputs.set(String(r.player), p);
  const d = consistentRead(p, { baseline: baselines.get(r.position), k, table });
  out.push({ id: String(r.player), position: r.position, score: r.score, mine: !!r.mine, consistent_rule_d: d.consistent, hits: d.hits, p25: d.p25, reasons: d.reasons });
}
const served = consistentOfFrom(inputs, { baselines, k, table });
console.log(JSON.stringify({ league, season, as_of_week: week, injury_report_week: repWeek, k, served_positions: SERVED_POSITIONS,
  baselines: Object.fromEntries(baselines), blue_chips: out.length,
  consistent_rule_d: out.filter(x => x.consistent_rule_d).map(x => `${x.id} ${x.position}`),
  consistent_served: out.filter(x => served(x.id)).map(x => `${x.id} ${x.position}`), rows: out }, null, 2));
