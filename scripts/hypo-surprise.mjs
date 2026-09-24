#!/usr/bin/env node
/**
 * HYPO-01a: run the surprise detector for one league and print what it found.
 *
 *   GRIDIRON_HYPO_ENABLED=1 node scripts/hypo-surprise.mjs --league 4 [--season 2026] [--dry-run] [--json]
 *   node scripts/hypo-surprise.mjs --league 4 --list      # read the open hypotheses
 *
 * Off unless GRIDIRON_HYPO_ENABLED=1: with the flag unset it says so and writes nothing.
 * Prints team ids, probabilities and evidence ids only. Exit 1 on a bad argument or a
 * failed run; an empty result is exit 0 with the reason printed.
 */
import { parseArgs } from 'node:util';

process.env.SCHEDULER_DISABLED = '1';
const { values } = parseArgs({
  options: {
    league: { type: 'string' }, season: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, list: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
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
const { detectSurprises, listHypotheses, hypoEnabled } = await import('../server/services/hypo/surprise.js');

if (values.list) {
  const open = listHypotheses({ leagueId, status: 'open' });
  if (values.json) console.log(JSON.stringify(open, null, 2));
  else for (const h of open) console.log(`#${h.id} ${h.kind} team ${h.team_id} p=${h.model_p.toPrecision(2)} evidence ${JSON.stringify(h.evidence.trade_outcome_ids ?? h.evidence.tx_ids)}`);
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
if (!hypoEnabled()) {
  console.log('hypo_surprise: off (GRIDIRON_HYPO_ENABLED is not set); nothing written');
  process.exit(0);
}

const r = detectSurprises({ leagueId, season, enabled: true, write: !values['dry-run'] });
if (values.json) console.log(JSON.stringify(r, null, 2));
else {
  for (const s of r.surprises) {
    const ids = s.evidence.trade_outcome_ids ?? s.evidence.tx_ids;
    console.log(`${s.kind.padEnd(13)} team ${String(s.team_id).padEnd(3)} p=${s.model_p.toPrecision(2)} `
      + `s=${s.surprisal.toFixed(2)} ${s.outcome} evidence ${JSON.stringify(ids)}`);
  }
  for (const k of r.skipped) console.log(`skipped       team ${k.team_id} ${k.reason}`);
}
const counts = r.surprises.reduce((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {});
console.log(`hypo_surprise: league ${leagueId} season ${season} ${r.dry_run ? 'dry run, ' : ''}`
  + `found ${r.surprises.length} ${JSON.stringify(counts)} written ${r.written} already ${r.already ?? '-'} `
  + `skipped ${r.skipped.length} roster_moves ${r.roster_moves}`);
