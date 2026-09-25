#!/usr/bin/env node
/**
 * TELLS-01b: grade the tells clone by E1 on one league's offers, read-only.
 *
 * Opens GRIDIRON_DB_PATH read-only (no migration, no write) and prints one JSON
 * object of aggregates: E1 for the clone and for today's replayed band on the
 * same offers, the final weights, and how many offers each tell was present on.
 * No team, manager or player names are printed.
 *
 * Usage: node scripts/eval/tells-clone-e1.mjs [leagueId=4]
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { loadCloneContext, cloneScores, gradeClone, fitWeights, GRADED_FEATURES, FEATURES } from '../../server/services/tells/clone-features.js';

const pick = r => ({ status: r.status, n: r.n, gain: r.metric, ci: [r.ci_low, r.ci_high],
  log_loss_model: r.detail?.log_loss_model ?? null, log_loss_activity_only: r.detail?.log_loss_activity_only ?? null,
  slope: r.detail?.slope ?? null, needs: r.needs_text });

export function report(database, leagueId) {
  const started = Date.now();
  const ctx = loadCloneContext(database);
  const g = gradeClone(ctx.offers, ctx, { leagueId, excluded: ctx.excluded, sources: ctx.sources, reason: ctx.reason });
  const scored = cloneScores(ctx.offers, ctx).filter(o => String(o.league_id) === String(leagueId));
  const present = Object.fromEntries(FEATURES.map(f => [f.id, scored.filter(o => !o.features[f.id].missing).length]));
  const last = scored.at(-1);
  const final = fitWeights(cloneScores(ctx.offers, ctx).map(o => ({
    x: GRADED_FEATURES.map(id => (o.features[id].missing ? 0 : o.features[id].value)),
    offset: Math.log(o.baseline / (1 - o.baseline)), y: o.y,
  })));
  return {
    league_id: leagueId,
    offers_all_leagues: ctx.offers.length,
    offers_target: scored.length,
    accepted_target: scored.filter(o => o.y === 1).length,
    features_present_on: present,
    weights_last_offer: last ? Object.fromEntries(GRADED_FEATURES.map((id, i) => [id, last.weights[i]])) : null,
    weights_all_offers: Object.fromEntries(GRADED_FEATURES.map((id, i) => [id, final.weights[i]])),
    fit_reason: final.reason,
    e1_clone: pick(g.clone),
    e1_production: pick(g.production),
    excluded: ctx.excluded,
    missing_sources: ctx.missing,
    // FIX-268-4: which table each target-league offer's terms came from (snapshot first).
    terms_sources: g.terms_sources,
    seconds: (Date.now() - started) / 1000,
  };
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) {
  const file = process.env.GRIDIRON_DB_PATH;
  if (!file || !fs.existsSync(file)) {
    console.error(`GRIDIRON_DB_PATH is ${file ? 'not a file' : 'unset'}`);
    process.exit(2);
  }
  const database = new DatabaseSync(file, { readOnly: true });
  console.log(JSON.stringify(report(database, Number(process.argv[2] ?? 4)), null, 2));
}
