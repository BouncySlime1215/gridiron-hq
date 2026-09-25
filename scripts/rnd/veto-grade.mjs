#!/usr/bin/env node
/**
 * VETO-RISK league grade (batch D item 24; pre-registered in docs/tdd/2026-09-25-veto-risk.tdd.md).
 *
 * Reads one league's accepted offers from the local DB (through the War Room adapter, so deals are
 * priced with the same market values the planner uses), then scores the three arms forward-only:
 * none (P(veto) = 0, served today), base (league veto share), skew (two skew buckets).
 * Read-only: nothing is written. Prints ids and numbers only (no manager or player names).
 *
 *   node scripts/rnd/veto-grade.mjs --league 4 [--json]
 */
import { pathToFileURL } from 'node:url';
import { gradeVeto } from '../../server/services/veto-risk.js';

function args(argv) {
  const out = { league: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--league') out.league = Number(argv[++i]);
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

const f = x => (x == null ? 'n/a' : x.toFixed(4));

export async function main(argv = process.argv) {
  const opts = args(argv);
  if (!Number.isInteger(opts.league)) throw new Error('usage: node scripts/rnd/veto-grade.mjs --league <id> [--json]');
  const { loadServices, buildAdapter } = await import('../campaign/league-adapter.mjs');
  const svc = await loadServices();
  const adapter = buildAdapter(svc, opts.league, { finder: false, vetoRisk: 'shadow' });
  if (adapter.fail) throw new Error(`adapter failed: ${adapter.fail}`);
  const vr = adapter.vetoRisk;
  const g = gradeVeto(vr.deals, { votesRequired: vr.table.votes_required, otherOwners: vr.table.other_owners });
  const summary = { league: opts.league, source: vr.status, counts: vr.counts, priced_n: vr.table.priced_n,
    votes_required: vr.table.votes_required, other_owners: vr.table.other_owners,
    n_decided: g.n_decided, n_scored: g.n_scored, observed_rate: g.observed_rate, arms: g.arms,
    pick: g.pick, calibration_gap: g.calibration_gap ?? null, verdict: g.verdict, why: g.why, model: g.model };
  if (opts.json) { console.log(JSON.stringify(summary, null, 2)); return summary; }
  console.log(`[veto-grade] league ${opts.league}: source ${vr.status}, counts ${JSON.stringify(vr.counts)}, priced ${vr.table.priced_n}`);
  console.log(`[veto-grade] votes required ${vr.table.votes_required} of ${vr.table.other_owners} other owners`);
  for (const arm of ['none', 'base', 'skew']) {
    console.log(`[veto-grade] ${arm.padEnd(4)} brier ${f(g.arms[arm].brier)} log loss ${f(g.arms[arm].log_loss)} mean p ${f(g.arms[arm].mean_p)}`);
  }
  console.log(`[veto-grade] observed ${f(g.observed_rate)} on n_scored ${g.n_scored} (n_decided ${g.n_decided})`);
  console.log(`[veto-grade] verdict ${g.verdict}, pick ${g.pick ?? 'none'}: ${g.why}`);
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`[veto-grade] ${e.message}`); process.exit(1); });
}
