#!/usr/bin/env node
/**
 * ACQ-01: write the "go get player X" plans for a league as a War Room plans file
 * (contract: server/services/campaign/plans-schema.js, warroom-plans/1).
 *
 * Default-off: without the local preview switch (preview-mode.js) it prints why
 * and writes nothing. Offline only; never run by the web server.
 *
 * Output (league data, outside the repo): GRIDIRON_ACQ_PLANS, default
 * ~/gridiron-local/warroom/acq-plans.json. Stdout: one JSON summary per league
 * with numbers and ids only (no names), safe to paste.
 *
 * Usage (on a DB copy):
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy> node scripts/acq/produce-acq-plans.mjs \
 *     [--leagues 4] [--target <asset id>] [--finder] [--budget-ms 240000] [--free-agents 6] [--out <file>] [--no-write]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';

export function parseArgs(argv) {
  const o = { leagues: [4], target: null, finder: false, budgetMs: 240_000, freeAgents: 6, out: null, write: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--leagues') o.leagues = argv[++i].split(',').map(Number);
    else if (a === '--target') o.target = Number(argv[++i]);
    else if (a === '--finder') o.finder = true;
    else if (a === '--budget-ms') o.budgetMs = Number(argv[++i]);
    else if (a === '--free-agents') o.freeAgents = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--no-write') o.write = false;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

export const acqPlansPath = (env = process.env) =>
  path.resolve(env.GRIDIRON_ACQ_PLANS || path.join(os.homedir(), 'gridiron-local', 'warroom', 'acq-plans.json'));

const r4 = x => (Number.isFinite(x) ? +x.toFixed(4) : null);

/** The paste-safe summary: numbers and ids, no names. */
export function summary(out) {
  if (out.skipped) return { skipped: true, reason: out.reason };
  if (out.error) return { league: out.league, error: out.error };
  const { res, meta, entry, finder } = out;
  const tf = res.stats.two_for_one;
  const plan = p => p && { target: p.target, depth: p.depth, shapes: p.steps.map(s => s.shape), p_complete: r4(p.p_complete),
    delta_final: r4(p.delta_final), expected: r4(p.expected), expected_se: r4(p.expected_se), chained: p.chained };
  return {
    league: meta.league, me: meta.me, runs: meta.runs, sanity_composed_equals_direct: meta.sanity,
    world_ms: meta.world_ms, plan_ms: res.stats.runtime_ms, total_ms: meta.total_ms, under_300s: meta.total_ms < 300_000,
    rescores: res.stats.rescores, candidates: res.stats.candidates, scored: res.stats.scored, truncated: res.stats.truncated,
    phases_ms: res.stats.phases_ms, targets: res.targets.map(t => t.target), deck: res.deck.length,
    best: plan(res.deck[0]), backups_on_best: res.deck[0]?.backups.map(b => (b ? r4(b.expected) : null)) ?? [],
    idea_038: { targets: tf.targets, missed_by_one_for_one: tf.missed_by_one_for_one, one_for_one_finds_nothing: tf.one_for_one_finds_nothing,
      rows: tf.rows.map(r => ({ target: r.target, fair: r.fair_direct, best_1for1: r4(r.best_one_for_one), best_with_2: r4(r.best_with_two),
        gain: r4(r.gain), gain_se: r4(r.gain_se), clears_2se: r.gain_clears_2se, best_is_two: r.best_is_two })) },
    finder_best_expected: finder ? (finder.error ? { error: finder.error } : { expected: r4(finder.expected), se: r4(finder.se) }) : 'not run',
    entry_error: entry.error ?? null
  };
}

async function main() {
  if (!process.env.GRIDIRON_DB_PATH) throw new Error('set GRIDIRON_DB_PATH to a DB copy');
  const o = parseArgs(process.argv);
  const { produceAcq } = await import('../../server/services/acq/produce.js');
  const { plansDoc } = await import('../../server/services/acq/contract.js');
  const entries = [];
  for (const id of o.leagues) {
    const out = await produceAcq(id, { target: o.target, finder: o.finder, budgetMs: o.budgetMs, freeAgents: o.freeAgents });
    console.log(JSON.stringify(summary(out)));
    if (out.skipped) return;
    if (out.entry) entries.push(out.entry);
  }
  if (!o.write || !entries.length) return;
  const doc = plansDoc(entries);
  const file = o.out ? path.resolve(o.out) : acqPlansPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
  fs.renameSync(tmp, file);
  console.log(JSON.stringify({ wrote: 'acq plans file', leagues: doc.leagues.length, failed: doc.leagues.filter(l => l.error).map(l => l.league) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
