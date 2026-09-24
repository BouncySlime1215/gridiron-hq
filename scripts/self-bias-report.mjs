#!/usr/bin/env node
/**
 * SELF-01b read-out: run the bias-flag check on the database at GRIDIRON_DB_PATH and
 * print one JSON line per league, by league id only (no names).
 *
 * Point it at a COPY. It migrates (082 creates follow_ledger), fills the follow ledger
 * from rec_ledger and resolves it (syncFollowLedger), settles observed trades into
 * trade_outcomes for each league's season, and then reads selfBiasFlags(): flags, held
 * counts, and the regret ledger and concession guard as counts only.
 *
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=/path/to/copy.sqlite node scripts/self-bias-report.mjs
 */
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { syncFollowLedger } = await import('../server/services/engine/follow-ledger.js');
const { settleObservedOutcomes } = await import('../server/services/trade-outcomes.js');
const { selfBiasFlags } = await import('../server/services/engine/self-bias.js');

const sync = syncFollowLedger();
console.log(JSON.stringify({ follow_sync: { backfill: sync.backfill, resolve: sync.resolve } }));
for (const lg of rows('SELECT id, season FROM leagues ORDER BY id')) {
  const settle = settleObservedOutcomes(lg.id, lg.season);
  const b = selfBiasFlags(lg.id);
  console.log(JSON.stringify({
    league_id: lg.id, season: lg.season,
    settle: { state: settle.state, written: settle.written, skipped: settle.skipped },
    sources: b.sources, follow: b.follow, trades: b.trades,
    flags: b.flags.map(f => ({ category: f.category, bias: f.bias, forward: f.forward })),
    held: b.held, held_by_reason: b.held_by_reason,
    regret: {
      choices: b.regret.entries.length, scored: b.regret.scored, aside: b.regret.aside,
      horizon_open: b.regret.entries.filter(e => e.realised_state === 'horizon_open').length,
      no_snapshot: b.regret.entries.filter(e => e.as_of_state === 'no_snapshot').length,
    },
    concession: { reoffers: b.concession.reoffers, events: b.concession.events, aside: b.concession.aside,
      guarded: b.concession.guarded.length, guarded_held: b.concession.guarded_held },
  }));
}
