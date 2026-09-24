#!/usr/bin/env node
/**
 * The promotion check (ENGINE-ARCHITECTURE.md §6.3, D16; ENGINE-SPECS EA-04 row): exits 0 only
 * when a producer's SHADOW version beats its ACTIVE version on one graded field by the rule,
 * reading `grade.season_to_date` rows only (engine_state, written by the grader).
 *
 *   node scripts/check-promotion.mjs --producer P --field F [--shadow V]
 *
 * THE RULE (§6.3 (1), with §7.2's floors and §6.7's "same outcomes"):
 *   1. both rows exist: the active version (lane live) and the shadow version (lane shadow);
 *   2. both were graded on the same outcomes (equal outcomes_hash);
 *   3. the shadow meets the floor IN CLUSTERS: >= 4 distinct weeks and >= 20 distinct
 *      entities (floor_met; thirty player-weeks from one Sunday are one week);
 *   4. every graded row is `forward` (no test / history rows in the window);
 *   5. the paired interval (vs_incumbent: shadow minus active, per week cluster, primary
 *      score, lower is better) is clear of 0 in the right direction: its upper bound < 0.
 * Not checked here, because they are not grade.* fields: §6.3 (2) the BENCHMARKS.md row,
 * (3) prereg-before-first-grade (scripts/check-prereg-order.mjs), and (4) the training
 * window, which the grader already enforces by excluding any row whose window reaches its
 * decision time (excluded.training_after_decision).
 * The interval is grade/compare.js's normal-mixture confidence sequence with a plug-in sd,
 * named in the row (interval.method); the monitor's e-process (§7.4) replaces it when built.
 *
 * Exit 0 PROMOTE; 1 REFUSE (reasons printed); 64 usage.
 */
import { pathToFileURL } from 'node:url';
import { readSeasonGrades } from './engine-grade-report.mjs';

/** The verdict for one field: {promote, reasons[]} (reasons are the failed checks). */
export function promotionVerdict({ field, active, shadow }) {
  const reasons = [];
  if (!active) reasons.push(`no active (live) grade row for ${field}`);
  if (!shadow) reasons.push(`no shadow grade row for ${field}`);
  if (!active || !shadow) return { promote: false, reasons };
  if (active.lane !== 'live') reasons.push(`the active row is lane ${active.lane}, not live`);
  if (shadow.lane !== 'shadow') reasons.push(`the shadow row is lane ${shadow.lane}, not shadow`);
  if (!shadow.outcomes_hash || shadow.outcomes_hash !== active.outcomes_hash) {
    reasons.push('not graded on the same outcomes (outcomes_hash differs)');
  }
  if (shadow.floor_met !== true) {
    reasons.push(`floor not met: ${shadow.clusters?.weeks ?? 0} weeks x ${shadow.clusters?.entities ?? 0} entities `
      + '(needs >= 4 weeks and >= 20 entities, counted in clusters)');
  }
  const forward = Number(shadow.labels?.forward ?? 0);
  if (!(shadow.n > 0) || forward !== shadow.n) {
    reasons.push(`forward rows only: ${forward} of ${shadow.n} are forward (${JSON.stringify(shadow.labels ?? {})})`);
  }
  const v = shadow.vs_incumbent;
  const hi = v?.interval?.hi; const lo = v?.interval?.lo;
  if (!v || !Number.isFinite(hi) || !Number.isFinite(lo)) {
    reasons.push('no paired interval against the active version (vs_incumbent)');
  } else if (!(hi < 0)) {
    reasons.push(`interval not clear of 0 in the shadow's favour: delta ${v.delta_mean} [${lo}, ${hi}] `
      + '(shadow minus active, lower is better: needs upper bound < 0)');
  }
  return { promote: reasons.length === 0, reasons };
}

function args(argv) {
  const out = { producer: null, field: null, shadow: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--producer') out.producer = argv[++i];
    else if (argv[i] === '--field') out.field = argv[++i];
    else if (argv[i] === '--shadow') out.shadow = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out.producer || !out.field) throw new Error('--producer and --field are required');
  return out;
}

async function main() {
  let opts;
  try { opts = args(process.argv.slice(2)); } catch (e) {
    console.error(`${e.message}\nusage: check-promotion.mjs --producer P --field F [--shadow V]`);
    process.exit(64);
  }
  const { db } = await import('../server/db/index.js');
  const rows = readSeasonGrades(db, { producer: opts.producer })
    .map(r => ({ entity: r.entity, version: r.entity.slice(r.entity.lastIndexOf('@') + 1), f: r.value.by_field?.[opts.field] }))
    .filter(r => r.f);
  const active = rows.find(r => r.f.lane === 'live') ?? null;
  const shadows = rows.filter(r => r.f.lane === 'shadow' && (opts.shadow == null || r.version === String(opts.shadow)));
  if (!shadows.length) shadows.push(null);
  let promoted = false;
  for (const s of shadows) {
    const verdict = promotionVerdict({ field: opts.field, active: active?.f ?? null, shadow: s?.f ?? null });
    const name = s ? s.entity : `${opts.producer}@<no shadow>`;
    if (verdict.promote) {
      promoted = true;
      const v = s.f.vs_incumbent;
      console.log(`PROMOTE ${name} over ${active.entity} on ${opts.field}: delta ${v.delta_mean} [${v.interval.lo}, ${v.interval.hi}]`
        + ` over ${v.weeks} weeks, ${s.f.clusters.entities} entities`);
    } else {
      console.log(`REFUSE ${name} on ${opts.field}:`);
      for (const r of verdict.reasons) console.log(`  - ${r}`);
    }
  }
  process.exit(promoted ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
