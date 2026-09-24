#!/usr/bin/env node
/**
 * TELLS-01b: the post-sync run of producer 'tells', off the web server's request thread.
 *
 * 1. Appends this sync's rows to engine_events through the two tells adapters
 *    (league.transaction from league_transactions_raw, league.team_week from
 *    league_week_scores); compare-latest, so a re-run appends only what changed.
 * 2. Runs `runTellsProducer` for every ESPN league as of now: tells.card,
 *    tells.prior_trades and tells.checkout_risk in engine_state.
 *
 * Role engine: the engine daemon (#242) is the one writer of engine tables, and until it
 * registers this producer the refresh loop spawns this script after each sync (the
 * refresh process itself never imports services/engine/*). Prints one
 * "tells: ..." summary line and the per-league JSON. Exit 2 when the engine tables are
 * missing (migration 075 not applied).
 *
 * Usage: node --env-file-if-exists=.env scripts/engine-tells.mjs [--league N]
 */
process.env.GRIDIRON_PROCESS_ROLE = 'engine';
process.env.SCHEDULER_DISABLED ??= '1';

const { db, dbPath } = await import('../server/db/index.js');
const has = t => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
if (!has('engine_events') || !has('engine_state') || !has('engine_fields')) {
  console.error(`tells: engine tables missing on ${dbPath}: apply migration 075_engine_spine first`);
  process.exit(2);
}
const { backfillStream } = await import('../server/services/engine/backfill.js');
const { runTellsProducer } = await import('../server/services/tells/producer.js');

const argv = process.argv.slice(2);
const only = argv.includes('--league') ? Number(argv[argv.indexOf('--league') + 1]) : null;
const started = Date.now();
const streams = ['tells_transactions', 'tells_team_weeks'].map(s => backfillStream(s, { database: db, provenance: 'captured' }));
const leagues = db.prepare(`SELECT id, season FROM leagues WHERE platform = 'espn' ${only ? 'AND id = ?' : ''} ORDER BY id`)
  .all(...(only ? [only] : [])).map(l => ({ leagueId: Number(l.id), season: Number(l.season) }));
const out = await runTellsProducer({ database: db, leagues });
console.log(JSON.stringify({ streams: streams.map(s => ({ stream: s.stream, table_state: s.table_state, inserted: s.inserted,
  skipped: s.skipped })), leagues: out }, null, 2));
console.log(`tells: ${out.length} leagues, ${out.reduce((a, l) => a + l.rows_written, 0)} rows written, `
  + `${out.reduce((a, l) => a + l.rows_unchanged, 0)} unchanged in ${Date.now() - started} ms`);
db.close();
