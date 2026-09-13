#!/usr/bin/env node
/**
 * One-time backfill: force-reclassify every nfl_prop_clv row whose
 * model_match_status isn't 'modeled'.
 *
 * Context: reconcilePropQuoteMatches({force=false}) — the routine call made
 * by the scheduler on every prop-capture tick (refreshPropCapture,
 * refreshFreePropClv in server/services/scheduler.js) — only revisits rows
 * with model_match_status IS NULL or 'legacy_unclassified'. That's correct
 * for routine runs: it keeps each tick cheap by only touching genuinely new
 * quotes. But it means the ~100,944 rows an older name-key bug in the
 * matcher stamped with a wrong terminal status (e.g. 'identity_unresolved')
 * are stuck there forever — they aren't NULL and aren't
 * 'legacy_unclassified', so the routine call skips them even though the
 * matcher bug that produced that status has since been fixed.
 *
 * This script is the deliberate, occasional, logged exception: it calls
 * reconcilePropQuoteMatches({force: true}), which additionally re-visits any
 * row where model_match_status <> 'modeled', re-running today's (fixed)
 * matcher against every one of them. Run it once after a matcher fix lands;
 * do not wire this into the scheduler or a cron job — see the routine vs.
 * force distinction above. (The already-wired POST /props/quotes/reconcile
 * route also calls force:true, for the same reason, on demand from the UI.)
 *
 * This only UPDATEs existing nfl_prop_clv rows' classification columns
 * (model_match_status, model_match_reason, matched_player_id,
 * model_probability, edge) — no schema change, no INSERT/DELETE, no
 * migration. Safe to run against a live data.sqlite; it never touches -wal
 * or -shm directly, just goes through the normal sqlite connection.
 *
 * Usage:
 *   node scripts/backfill-prop-quote-reconcile.mjs
 *   GRIDIRON_DB_PATH=/tmp/copy.sqlite node scripts/backfill-prop-quote-reconcile.mjs   # dry-run-ish, against a copy
 */
process.env.SCHEDULER_DISABLED ??= '1';

const { reconcilePropQuoteMatches, propMatchCoverage } = await import('../server/services/nfl-prop-clv.js');

const dbPathNote = process.env.GRIDIRON_DB_PATH || '(default server/data.sqlite)';
const before = propMatchCoverage();

console.log(`\nprop quote reconcile backfill — force:true, one-time`);
console.log(`database: ${dbPathNote}`);
console.log(`\nbefore: ${before.quotes} quotes, ${before.modeled} modeled, ${before.unresolved} unresolved (${before.rate == null ? '—' : (before.rate * 100).toFixed(2)}% resolved)`);
for (const r of before.reasons) console.log(`  ${r.status}: ${r.quotes}`);

const start = Date.now();
const result = reconcilePropQuoteMatches({ force: true });
const ms = Date.now() - start;

console.log(`\nreviewed: ${result.reviewed}`);
console.log(`updated:  ${result.updated}`);
console.log(`took:     ${ms}ms`);

const after = result.coverage;
console.log(`\nafter:  ${after.quotes} quotes, ${after.modeled} modeled, ${after.unresolved} unresolved (${after.rate == null ? '—' : (after.rate * 100).toFixed(2)}% resolved)`);
for (const r of after.reasons) console.log(`  ${r.status}: ${r.quotes}`);

console.log(`\nnewly modeled: ${after.modeled - before.modeled}`);
console.log(`newly resolved: ${after.resolved - before.resolved}\n`);
