/**
 * Run the standing start/sit gate once, by hand, and print it (plan item C12).
 *
 *   GRIDIRON_DB_PATH=<a copy> node scripts/run-start-sit-gate.mjs [--store] [--iterations 2000]
 *
 * Prints the configuration before any metric (prereg §7): the role recency read from
 * WEEKLY_ROLE_RECENCY itself, kOverride omitted, and the k control's resolved
 * target-share k per season; then the controls, then the result. --store also writes
 * the result the way the weekly start_sit_gate job does (model_gate_audits via
 * recordGateAudit); without it nothing is written.
 *
 * Pre-registration: docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md.
 */
const { dbPath } = await import('../server/db/index.js');
const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');
const G = await import('../server/services/gates/start-sit-gate.js');

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const iterations = Number(arg('--iterations') ?? 2000);
const store = process.argv.includes('--store');

console.log(`database: ${dbPath}`);
console.log(`configuration: roleRecency ${JSON.stringify(WEEKLY_ROLE_RECENCY)} (WEEKLY_ROLE_RECENCY, passed explicitly); kOverride omitted`);
console.log(`k control (past seasons): ${JSON.stringify(G.kControl([...G.PAST_SEASONS]))}`);

const started = Date.now();
const result = G.runStartSitGate({ iterations });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`k control (all graded seasons): ${JSON.stringify(result.configuration.k_control)}`);
console.log(`champions: ${JSON.stringify(result.configuration.champions)}`);
console.log(`controls: ${JSON.stringify(result.controls)}`);
console.log(JSON.stringify({ ...result, configuration: undefined, controls: undefined }, null, 1));
console.log(`verdict: ${result.verdict}  (run took ${seconds}s, ${iterations} bootstrap draws)`);
if (store) console.log(`stored: ${JSON.stringify(G.refreshStartSitGate({ run: () => result }))}`);
