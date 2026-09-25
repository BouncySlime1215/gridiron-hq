/**
 * SOURCE-TABLES switch. Off unless GRIDIRON_SOURCE_TABLES=1: the refresh tick then runs
 * scripts/eval/produce-source-tables.mjs before the graders. Preview mode does not turn it
 * on; it stays off until Nick's Mac has measured it (the PR's "Needs local measurement").
 * Off, no table is created and the brain report reads exactly as before.
 */
export const SOURCE_TABLES_ENV = 'GRIDIRON_SOURCE_TABLES';
export const sourceTablesEnabled = (env = process.env) => env[SOURCE_TABLES_ENV] === '1';
