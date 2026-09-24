#!/usr/bin/env node
/**
 * HYPO-01a: run the surprise detector for one league and print what it found.
 *
 *   GRIDIRON_HYPO_ENABLED=1 node scripts/hypo-surprise.mjs --league 4 [--season 2026] [--dry-run] [--json]
 *   node scripts/hypo-surprise.mjs --league 4 --list      # read the open hypotheses
 *   node scripts/hypo-surprise.mjs --league 4 --calibrate # walk-forward threshold per stream (read-only)
 *
 * Off unless GRIDIRON_HYPO_ENABLED=1 or preview mode (hypo/surprise.js#hypoFlag; =0 vetoes
 * preview): off, it says so and writes nothing. A write also publishes each hypothesis as a
 * hypo.surprise event on the engine hub (FIX-277-6).
 * Prints team ids, probabilities and evidence ids only. Exit 1 on a bad argument or a
 * failed run; an empty result is exit 0 with the reason printed.
 */
import { parseArgs } from 'node:util';

process.env.SCHEDULER_DISABLED = '1';
// A write appends hypo.surprise events to engine_events (FIX-277-6), an engine write.
process.env.GRIDIRON_PROCESS_ROLE = 'script';
const { values } = parseArgs({
  options: {
    league: { type: 'string' }, season: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, list: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false }, calibrate: { type: 'boolean', default: false },
  },
});
const leagueId = Number(values.league);
if (!Number.isInteger(leagueId) || leagueId <= 0) {
  console.error('hypo_surprise: --league <id> is required');
  process.exit(1);
}

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { row } = await import('../server/db/index.js');
const { detectSurprises, listHypotheses, hypoFlag, HYPO_ENV } = await import('../server/services/hypo/surprise.js');
const { previewText } = await import('../server/services/preview-mode.js');
const evidenceIds = e => [...(e.trade_outcome_ids ?? []), ...(e.tx_ids ?? []), ...(e.snapshot_keys ?? [])];

if (values.list) {
  const open = listHypotheses({ leagueId, status: 'open' });
  if (values.json) console.log(JSON.stringify(open, null, 2));
  else for (const h of open) console.log(`#${h.id} ${h.kind} team ${h.team_id} p=${h.model_p.toPrecision(2)} evidence ${JSON.stringify(evidenceIds(h.evidence))}`);
  console.log(`hypo_surprise: ${open.length} open hypotheses for league ${leagueId}`);
  process.exit(0);
}

function latestSeason() {
  const q = (sql) => { try { return row(sql, leagueId)?.s ?? null; } catch (e) {
    if (/no such table/i.test(String(e?.message))) return null;
    throw e;
  } };
  const a = q('SELECT MAX(season) AS s FROM trade_outcomes WHERE league_id = ?');
  const b = q('SELECT MAX(season) AS s FROM league_transactions_raw WHERE league_id = ?');
  return Math.max(a ?? 0, b ?? 0) || null;
}
const season = values.season ? Number(values.season) : latestSeason();
if (!season) {
  console.log(`hypo_surprise: league ${leagueId} has no trade_outcomes or league_transactions_raw rows; nothing to score`);
  process.exit(0);
}
if (values.calibrate) {
  // Read-only: fits and reports the pre-registered walk-forward threshold per stream.
  const { calibrateStreams } = await import('../server/services/hypo/calibrate.js');
  const c = calibrateStreams({ leagueId, season });
  for (const [name, s] of Object.entries(c.streams)) {
    const rate = s.flag_rate == null ? 'n/a' : `${(s.flag_rate * 100).toFixed(1)}%`;
    console.log(`${name.padEnd(15)} units ${s.units} evaluated ${s.evaluated} flagged ${s.flagged} rate ${rate} `
      + `target 3.5-6.5% ${s.within_target == null ? 'not evaluable' : s.within_target ? 'within' : 'outside'} `
      + `threshold(all) ${s.threshold_all == null ? '-' : s.threshold_all.toFixed(2)}${s.state ? ` ${s.state}` : ''}`);
    for (const f of s.flagged_units.slice(0, 25)) console.log(`  flagged ${f.id} p=${f.p.toPrecision(2)}`);
  }
  if (values.json) console.log(JSON.stringify(c, null, 2));
  process.exit(0);
}
const flag = hypoFlag();
if (!flag.on) {
  const why = process.env[HYPO_ENV] == null || process.env[HYPO_ENV] === '' ? 'is not set' : `is ${process.env[HYPO_ENV]}`;
  console.log(`hypo_surprise: off (${HYPO_ENV} ${why}); nothing written`);
  process.exit(0);
}

const r = detectSurprises({ leagueId, season, write: !values['dry-run'] });
if (r.preview) console.log(previewText(r.preview_reason));
if (values.json) console.log(JSON.stringify(r, null, 2));
else {
  for (const s of r.surprises) {
    const ids = evidenceIds(s.evidence);
    console.log(`${s.kind.padEnd(13)} team ${String(s.team_id).padEnd(3)} p=${s.model_p.toPrecision(2)} `
      + `s=${s.surprisal.toFixed(2)} ${s.outcome} evidence ${JSON.stringify(ids)}`);
  }
  for (const k of r.skipped) console.log(`skipped       team ${k.team_id} ${k.reason}`);
}
const counts = r.surprises.reduce((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {});
console.log(`hypo_surprise: league ${leagueId} season ${season} ${r.dry_run ? 'dry run, ' : ''}`
  + `found ${r.surprises.length} ${JSON.stringify(counts)} written ${r.written} already ${r.already ?? '-'} published ${r.published} `
  + `skipped ${r.skipped.length} roster_moves ${r.roster_moves} projections ${r.projections}`);
