#!/usr/bin/env node
/**
 * E-LATENCY local measurement: print the reply-time table and the
 * pre-registered grade of the follow-up hint, read-only.
 *
 *   node scripts/eval/reply-latency.mjs [--league 4] [--season 2026] [--db path]
 *
 * Team ids only, no names. Descriptive; never a P(yes) input.
 */
import { DatabaseSync } from 'node:sqlite';
import { loadReplyLatency } from '../../server/services/eval/reply-latency.js';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const dbPath = arg('db') ?? process.env.GRIDIRON_DB_PATH;
if (!dbPath) { console.error('set --db or GRIDIRON_DB_PATH'); process.exit(2); }
const database = new DatabaseSync(dbPath, { readOnly: true });
const league = arg('league');
const season = arg('season');
const r = loadReplyLatency(database, { leagueId: league == null ? null : Number(league), season: season == null ? null : Number(season) });
if (r.reason) console.log(`no evidence: ${r.reason}`);
for (const [lid, L] of Object.entries(r.table.leagues)) {
  console.log(`league ${lid}  pooled n=${L.pooled.n_answered} median=${L.pooled.median_h} h p90=${L.pooled.p90_h} h  expired=${L.pooled.n_expired} withdrawn=${L.pooled.n_withdrawn} unanswered=${L.pooled.n_unanswered}`);
  for (const [team, M] of Object.entries(L.managers)) {
    console.log(`  team ${team}: n=${M.n_answered} median=${M.median_h} p75=${M.p75_h} p90=${M.p90_h} <=24h=${M.within_24h} expired=${M.n_expired} N=${M.threshold_h} (${M.threshold_basis})`);
  }
}
console.log(`grade: ${r.grade.verdict}`);
for (const p of r.pending) console.log(`pending ${p.source} league ${p.league_id} -> team ${p.counterparty_team_id}: ${p.hint}${p.shadow ? ' (shadow)' : ''}: ${p.reason}`);
