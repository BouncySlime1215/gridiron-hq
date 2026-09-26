#!/usr/bin/env node
/**
 * O1C-WIRE grader (batch D item 14): does wiring a validated O1-RADAR cell into the weekly
 * projection beat (1) the unwired projection and (2) ESPN's as-of projection on the same
 * player-weeks? Pre-registered in docs/tdd/2026-09-25-o1c-wire.tdd.md; the bar is
 * server/services/o1c-gate.js#gradeO1cCell. Research tooling: it reads the local database and
 * the ESPN poller's JSONL, writes nothing, and never flips a gate itself.
 *
 * Needs server/services/opportunity-radar.js (PR #440). Without it the script exits 2.
 *
 * Usage:
 *   node scripts/rnd/o1c-grade.mjs --season 2024
 *   node scripts/rnd/o1c-grade.mjs --season 2026 --espn-dir ~/gridiron-local/rnd/loop/data/espn-flip-timing
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { O1C_CELLS, gradeO1cCell } from '../../server/services/o1c-gate.js';

const GROUP = { RB: 'RB', WR: 'WRTE', TE: 'WRTE' };

/**
 * Pure: graded player-weeks per cell. radarRows are buildRadarRows rows (played weeks carry ppr1);
 * serve(row) -> serveRow(row); projectionAt(week) -> Map<player_id, projection as of week - 1>;
 * wire(projection, served) -> opportunityWire(...) in shadow mode; espnOf(row, projection) -> ESPN's
 * as-of points or null. A player-week counts once per cell that fired for him.
 */
export function assembleCellRows(radarRows, { serve, projectionAt, wire, espnOf = () => null }) {
  const byCell = new Map(O1C_CELLS.map(c => [c, []]));
  const missing = { projection: 0 };
  for (const row of radarRows) {
    if (!row.played || !Number.isFinite(row.ppr1) || !GROUP[row.position]) continue;
    const served = serve(row);
    const cells = served.opportunity_events.filter(e => e.passes_gate && Number.isFinite(e.effect))
      .map(e => `${e.type}|${GROUP[row.position]}`).filter(c => byCell.has(c));
    if (!cells.length) continue;
    const p = projectionAt(row.week).get(row.player_id);
    if (!p) { missing.projection++; continue; }
    const w = wire(p, served);
    const espn = espnOf(row, p);
    for (const c of new Set(cells)) {
      byCell.get(c).push({ player: row.player_id, week: row.week,
        err_base: Math.abs(p.ppg - row.ppr1), err_wired: Math.abs(w.shadow.ppg_wired - row.ppr1),
        err_espn: Number.isFinite(espn) ? Math.abs(espn - row.ppr1) : null });
    }
  }
  return { byCell, missing };
}

/** Last ESPN reading per (espn_id, week) fetched before that week's first game date. */
export function espnAsOf(dir, cutoffs) {
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      const at = Date.parse(r.source_fetched_at ?? r.ts);
      if (!Number.isFinite(at) || !Number.isFinite(r.projected_points)) continue;
      for (const [week, cut] of cutoffs) {
        if (at >= cut) continue;
        const k = `${r.player_id}|${week}`;
        const prev = out.get(k);
        if (!prev || prev.at < at) out.set(k, { at, points: r.projected_points });
      }
    }
  }
  return out;
}

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}

async function main() {
  const season = Number(arg('season', 2024));
  const espnDir = arg('espn-dir');
  let R;
  try { R = await import('../../server/services/opportunity-radar.js'); } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    console.error('opportunity-radar.js is not on this branch (PR #440). Merge it first.');
    process.exit(2);
  }
  const { buildProjections } = await import('../../server/services/projections.js');
  const { opportunityWire } = await import('../../server/services/betting-fantasy-link.js');
  const { rows } = await import('../../server/db/index.js');

  const radarRows = R.buildRadarRows(season);
  const projCache = new Map();
  const projectionAt = week => {
    if (!projCache.has(week)) projCache.set(week, buildProjections({ through: season, throughWeek: week - 1 }));
    return projCache.get(week);
  };
  let espnOf = () => null;
  if (espnDir) {
    const cutoffs = new Map(rows(`SELECT week, MIN(date) AS first FROM schedule_games WHERE season = ? AND week IS NOT NULL GROUP BY week`, season)
      .map(r => [r.week, Date.parse(r.first)]).filter(([, t]) => Number.isFinite(t)));
    const asOf = espnAsOf(espnDir.replace(/^~/, process.env.HOME ?? ''), cutoffs);
    espnOf = (row, p) => (p.espn_id ? asOf.get(`${p.espn_id}|${row.week}`)?.points ?? null : null);
  }
  const { byCell, missing } = assembleCellRows(radarRows, {
    serve: r => R.serveRow(r), projectionAt, espnOf,
    wire: (p, served) => opportunityWire(p, served, { env: { GRIDIRON_O1C_WIRE: 'shadow' } })
  });
  const report = { season, espn: !!espnDir, missing, cells: {} };
  for (const [cell, list] of byCell) {
    const g = gradeO1cCell(list);
    report.cells[cell] = { n: g.n, n_espn: g.n_espn, passes: g.passes, reason: g.reason,
      vs_unwired: g.vs_unwired, vs_espn: g.vs_espn };
  }
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
