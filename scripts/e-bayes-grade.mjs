#!/usr/bin/env node
/**
 * E-BAYES (shadow) forward grade on the local league database, read-only.
 * Pre-registration: docs/tdd/2026-09-25-e-bayes.tdd.md.
 *
 *   node scripts/e-bayes-grade.mjs            # summary (no per-offer rows, no names)
 *   node scripts/e-bayes-grade.mjs --json     # summary as JSON
 *
 * Reads the decided offers through eval/e1-league.js#loadLeagueOffers (the one producer).
 * Prints counts, log losses, gains with their 95% anytime-valid CS, and the verdict.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { SERVER_ROOT } from '../server/platform/paths.js';
import { loadLeagueOffers } from '../server/services/eval/e1-league.js';
import { gradeForward, fitPooled } from '../server/services/eval/e-bayes.js';

const file = process.env.GRIDIRON_DB_PATH || path.join(SERVER_ROOT, 'data.sqlite');
const database = new DatabaseSync(file, { readOnly: true });
const { offers, reason, by_league: byLeague } = loadLeagueOffers(database);
if (reason) console.error(`[e-bayes] decided-offer loader: ${reason}`);
const g = gradeForward(offers);
const fit = fitPooled(offers, { now: Date.now() });
const r4 = x => (x == null ? null : Math.round(x * 1e4) / 1e4);
const out = {
  n: g.n, min_n: g.min_n, verdict: g.verdict, pass_bar: g.pass_bar,
  log_loss: Object.fromEntries(Object.entries(g.log_loss).map(([k, v]) => [k, r4(v)])),
  gain_vs_blend: { mean: r4(g.vs_blend.gain), ci: g.vs_blend.ci?.map(r4) ?? null },
  gain_vs_baseline: { mean: r4(g.vs_baseline.gain), ci: g.vs_baseline.ci?.map(r4) ?? null },
  kappa_now: fit.kappa, by_league: byLeague ?? null,
};
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`E-BAYES forward grade: n=${out.n} (decisive n >= ${out.min_n}) verdict=${out.verdict.toUpperCase()}`);
  console.log(`log loss  e_bayes ${out.log_loss.e_bayes}  blend ${out.log_loss.blend}  baseline ${out.log_loss.baseline}`);
  console.log(`gain vs served blend ${out.gain_vs_blend.mean} CS ${JSON.stringify(out.gain_vs_blend.ci)}`);
  console.log(`gain vs baseline     ${out.gain_vs_baseline.mean} CS ${JSON.stringify(out.gain_vs_baseline.ci)}`);
  console.log(`kappa now: league ${r4(out.kappa_now.league)}, manager ${r4(out.kappa_now.manager)}`);
  console.log(`bar: ${out.pass_bar}`);
}
