#!/usr/bin/env node
/**
 * Print the engine's producer DAG (ENGINE-ARCHITECTURE.md §4.2): for each producer in run
 * order, its cost (cheap: whole every tick; heavy: per dirty league), the fields it writes,
 * the fields and event types it reads, and the producers it runs after. A declaration
 * cycle, or an input no producer writes, is printed as the error the daemon refuses on
 * (exit 4). Reads no database.
 *
 * Usage: node scripts/engine-dag.mjs
 */
process.env.SCHEDULER_DISABLED ??= '1';
const { daemonProducers } = await import('../server/services/engine/producers/index.js');
const { describeDag } = await import('../server/services/engine/daemon/dag.js');
try {
  console.log(JSON.stringify(describeDag(daemonProducers()), null, 2));
} catch (error) {
  console.error(`engine DAG: ${error.message}`);
  process.exit(4);
}
