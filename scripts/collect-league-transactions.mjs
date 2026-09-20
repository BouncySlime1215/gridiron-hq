#!/usr/bin/env node
/**
 * Hand-run of the ESPN transaction collector.
 *
 * Why it exists (Nick, 2026-09-17): "source data on when trades were proposed /
 * accepted vs when the text messages were sent — this gives us reactions to live
 * information." ESPN's `mTransactions2` view only answers with the last ~3 days
 * (verified: 132 rows, 2026-09-15 → 09-17, incl. 36 TRADE_PROPOSAL, 9 ACCEPT,
 * 6 DECLINE, 4 VETO, each with `proposedDate` in ms and `relatedTransactionId`
 * tying a decision back to its proposal). Anything not captured inside that
 * window is gone.
 *
 * WHAT CHANGED 2026-09-20: this file used to BE the collector. The body now
 * lives in server/services/league-transactions.js and is registered as a
 * scheduler job, because a three-day window cannot be sampled by something
 * that only runs when a person types it — and nothing on the deployed app was
 * typing it. This script is now a thin wrapper over that same function, so a
 * hand-run and the scheduled run cannot drift apart. It is one body, two
 * callers.
 *
 * The sync_log row is written here too, through the scheduler's own
 * `recordSync`, so an off-server run counts as the job having run and the two
 * paths do not repeat each other's work — the same arrangement
 * `manager_signals` has with scripts/build-manager-signals.mjs.
 *
 * Read-only against ESPN with the leagues' own stored cookies (pull approved
 * 2026-09-17).
 * Usage: node --env-file-if-exists=.env scripts/collect-league-transactions.mjs
 */
// Importing db/index.js from a CLI must not start the background scheduler.
// This line belongs to the SCRIPT and deliberately does not exist in the
// service module — the registry job runs inside a server that is meant to be
// scheduling things.
process.env.SCHEDULER_DISABLED = '1';
const { collectLeagueTransactions } = await import('../server/services/league-transactions.js');
const { recordSync } = await import('../server/services/scheduler.js');

// No live-draft gate here, unlike the registry entry. That gate protects Nick
// from a SERVER sweep colliding with a draft he is in; a hand-run is him, at a
// keyboard, and he can see his own draft. Stated rather than left as an
// accident of where the call sits.
const detail = await collectLeagueTransactions();

for (const r of detail.reasons) console.log(`league ${r.league_id}: ${r.reason}`);
// This exact line is parsed by scripts/refresh-live-data.mjs
// (`transactionsCapture`, /failed (\d+)/ against the LAST output line), which
// is how the refresh loop decides whether to print ok or ERROR. Changing its
// shape silently turns every failed collection into a success there.
console.log(`transactions: seen ${detail.seen}, new ${detail.new}, failed ${detail.failed}`);
recordSync('league_transactions', detail.failed ? 'error' : 'ok', detail);
process.exit(0);
