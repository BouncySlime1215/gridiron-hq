#!/usr/bin/env node
/**
 * Rebuild who-is-who and the per-manager signals for every league.
 *
 * Until 2026-09-18 nothing called buildManagerSignals or matchIdentities: the
 * trade finder read a one-off league-4 snapshot taken by hand, and the other
 * four leagues had no counterparty data at all. This runs both for every ESPN
 * league (server/services/manager-signals.js#refreshManagerData):
 *
 *   - identities: ESPN members for every league; chat names only in a league
 *     where Nick has confirmed chat identities (league 4). His confirmations
 *     are carried forward, never re-guessed.
 *   - signals: roster, standings, transactions, draft and outcome for every
 *     roster; chat and Nick's priors only for trusted league-4 identities.
 *
 * Idempotent and cheap: a league whose inputs did not change is not rewritten,
 * so its timestamps (and any cache keyed on them) stay put. One sync_log row,
 * job 'manager_signals', with a per-league summary. Reads the private chat DB
 * read-only and never prints its contents or any league credential.
 *
 * Meant to run on the refresh loop right after the league-chat rollup, so the
 * chat-derived rows are built from that tick's rollup.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/build-manager-signals.mjs          # summary lines
 *   node --env-file-if-exists=.env scripts/build-manager-signals.mjs --json   # last line is JSON
 * Exit 0 when every synced league built; 1 when any league failed.
 */
process.env.SCHEDULER_DISABLED = '1';
const { run } = await import('../server/db/index.js');
const { exitWhenFlushed } = await import('./lib/flush-then-exit.mjs');
const { refreshManagerData } = await import('../server/services/manager-signals.js');

const AS_JSON = process.argv.includes('--json');
const startedAt = new Date().toISOString();

let result;
try {
  result = refreshManagerData();
} catch (e) {
  result = { status: 'error', error: String(e?.message ?? e), leagues: [] };
}

const detail = {
  ms: result.ms ?? null, chat_db: result.chat_db ?? null, error: result.error ?? null,
  leagues: result.leagues.map(l => (l.skipped || l.error
    ? { league_id: l.league_id, skipped: l.skipped ?? null, error: l.error ?? null }
    : { league_id: l.league_id, chat_corpus: l.chat_corpus, unchanged: l.unchanged,
      identities: l.identities, signals: l.signals, player_views: l.player_views,
      rosters_with_signals: l.rosters_with_signals, by_source: l.by_source,
      archetypes_as_of: l.archetypes_as_of })),
};
run(`INSERT INTO sync_log (job, last_run_at, last_status, last_detail, runs) VALUES ('manager_signals', ?, ?, ?, 1)
     ON CONFLICT(job) DO UPDATE SET last_run_at=excluded.last_run_at, last_status=excluded.last_status,
     last_detail=excluded.last_detail, runs=runs+1`, startedAt, result.status, JSON.stringify(detail));

if (AS_JSON) {
  console.log(JSON.stringify({ status: result.status, ...detail }));
} else {
  for (const l of result.leagues) {
    const head = `league ${l.league_id} ${l.name ?? ''}`.trim();
    if (l.skipped) { console.log(`${head}: skipped — ${l.skipped}`); continue; }
    if (l.error) { console.log(`${head}: ERROR ${l.error}`); continue; }
    const sources = Object.entries(l.by_source ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`${head}: ${l.identities.rosters} managers (${l.identities.trusted} with a trusted chat name, `
      + `${l.identities.changed} identity rows changed), ${l.signals} signals [${sources}], `
      + `${l.player_views} player views — ${l.unchanged ? 'unchanged' : 'rewritten'}`);
  }
  console.log(`manager_signals: ${result.status}${result.error ? ` (${result.error})` : ''} in ${result.ms ?? '?'} ms`);
}
// Flush before coming down: this script's stdout is CAPTURED by
// scripts/refresh-live-data.mjs:220 through spawnSync, whose stdio is a pipe,
// and process.exit() does not flush a pipe. The summary line above is the LAST
// thing printed and so the first thing a truncated pipe loses -- and the parent
// reads exactly that line to decide whether this run succeeded.
exitWhenFlushed(result.status === 'ok' ? 0 : 1);
