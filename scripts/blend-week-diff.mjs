#!/usr/bin/env node
/**
 * BROKEN-G diff: the three "this week" numbers per rostered player, flag off vs on.
 *
 *   SCHEDULER_DISABLED=1 node scripts/blend-week-diff.mjs
 *
 * Reads the DB at GRIDIRON_DB_PATH (run it on a copy). For every league and every
 * rostered skill player it prints, as counts and spreads only (no league, team or
 * player names):
 *   off: how many players' Start/Sit week_points, lineup-card week_points and trade
 *        card this-week leg disagree, and the largest gap;
 *   on:  the same (must be 0), and how far adj_ppg moved (the trade horizon now
 *        carries the line on its 25% this-week share).
 */
import { rows } from '../server/db/index.js';
import { assetUniverse, loadRosters, tradeWeekContext, lineupDiffWeekPoints } from '../server/services/trade-engine.js';
import { startSitWeekPoints } from '../server/services/lineup-brain.js';
import { deriveFormat } from '../server/services/format.js';
import { BLEND_WEEK_ENV } from '../server/services/blend-week.js';

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const { season, week } = tradeWeekContext();

function measure(lg, flag) {
  process.env[BLEND_WEEK_ENV] = flag;
  const assets = assetUniverse(lg, deriveFormat(lg).formatKey);
  const players = loadRosters(lg, assets).flatMap(t => t.players).filter(p => SKILL.has(p.position));
  return players.map(p => {
    const startSit = startSitWeekPoints(p, season, week).week_points;
    const card = lineupDiffWeekPoints(p, season, week);
    const trade = p.blend_week ?? p.current_week_ppg ?? p.adj_ppg ?? 0;
    return { id: p.id, startSit, card, trade, adj: p.adj_ppg,
      gap: Math.max(startSit, card, trade) - Math.min(startSit, card, trade) };
  });
}

const r2 = n => Math.round(n * 100) / 100;
const out = { season, week, leagues: [] };
let i = 0;
for (const lg of rows('SELECT * FROM leagues')) {
  i++;
  const off = measure(lg, '0');
  const on = measure(lg, '1');
  const adjOff = new Map(off.map(x => [x.id, x.adj]));
  const moves = on.map(x => Math.abs(x.adj - (adjOff.get(x.id) ?? x.adj)));
  out.leagues.push({
    league: `L${i}`, players: off.length,
    off: { disagree: off.filter(x => x.gap > 0.005).length, max_gap: r2(Math.max(0, ...off.map(x => x.gap))) },
    on: { disagree: on.filter(x => x.gap > 0.005).length, max_gap: r2(Math.max(0, ...on.map(x => x.gap))),
      startsit_changed: on.filter(x => Math.abs(x.startSit - (off.find(o => o.id === x.id)?.startSit ?? x.startSit)) > 0.005).length },
    adj_ppg_moved: { n: moves.filter(m => m > 0.005).length, max: r2(Math.max(0, ...moves)) }
  });
}
console.log(JSON.stringify(out, null, 2));
