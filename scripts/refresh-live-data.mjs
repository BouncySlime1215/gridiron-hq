#!/usr/bin/env node
/**
 * Off-server refresh of the fantasy live-data feeds.
 *
 * The in-server scheduler's "live" tier runs its jobs synchronously on the web
 * server's event loop and has pegged the app at 100% CPU with HTTP
 * unresponsive (2026-09-17). The app now runs with SCHEDULER_DISABLED=1 and
 * this script does the fantasy-relevant refreshes from a separate process, so a
 * slow ESPN response can never take the UI down.
 *
 * It calls the scheduler's own `runIfStale`, so each job keeps its declared
 * cadence (`maxAgeMinutes`), its timeout, and its `sync_log` row — the Data
 * Health page reads that table, nothing new to wire.
 *
 * ALLOWLIST ONLY. Betting collectors (line snapshots, Polymarket, book feeds,
 * prop capture, t60 runner…) are deliberately absent: Nick turned them off.
 *
 * Usage:
 *   node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/refresh-live-data.mjs --once
 *   node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/refresh-live-data.mjs --loop 900
 */
process.env.SCHEDULER_DISABLED = '1';

const FANTASY_LIVE_JOBS = [
  'nfl_lines',          // ESPN game lines + finals — scores are what advance the current week
  'nfl_injuries',       // nflverse official reports (nightly upstream)
  'league_rosters',     // the 5 ESPN leagues — rosters, matchups, settings
  'player_rosters',     // ESPN player ↔ NFL team map
  'nfl_offseason_depth_injury',   // depth charts, daily
  'espn_rosters',       // NFL team rosters, daily
  'rss_news',           // ESPN RSS
  'espn_news',          // ESPN team pages
  'nfl_news_signals',   // typed extraction (Haiku; hourly by its own maxAge)
];

const args = process.argv.slice(2);
const loopIdx = args.indexOf('--loop');
const loopSeconds = loopIdx > -1 ? Number(args[loopIdx + 1]) || 900 : 0;
const force = args.includes('--force');

const { JOBS, runIfStale } = await import('../server/services/scheduler.js');

const stamp = () => new Date().toISOString().slice(11, 19);

async function tick() {
  const started = Date.now();
  for (const name of FANTASY_LIVE_JOBS) {
    if (!JOBS[name]) { console.log(`${stamp()} ${name.padEnd(18)} UNKNOWN JOB`); continue; }
    const t0 = Date.now();
    try {
      const r = await runIfStale(name, { force });
      const ms = Date.now() - t0;
      if (r?.skipped) console.log(`${stamp()} ${name.padEnd(18)} fresh (${r.age_minutes}/${r.max_age_minutes} min)`);
      else if (r?.error) console.log(`${stamp()} ${name.padEnd(18)} ERROR ${String(r.error).slice(0, 160)} (${ms} ms)`);
      else console.log(`${stamp()} ${name.padEnd(18)} ok ${JSON.stringify(r?.detail ?? r ?? {}).slice(0, 120)} (${ms} ms)`);
    } catch (e) {
      console.log(`${stamp()} ${name.padEnd(18)} THREW ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  console.log(`${stamp()} tick done in ${Math.round((Date.now() - started) / 1000)} s`);
}

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

if (!loopSeconds) {
  await tick();
  process.exit(0);
}

console.log(`${stamp()} refresh-live-data loop every ${loopSeconds} s — jobs: ${FANTASY_LIVE_JOBS.join(', ')}`);
while (!stopping) {
  await tick();
  const until = Date.now() + loopSeconds * 1000;
  while (!stopping && Date.now() < until) await new Promise(r => setTimeout(r, 1000));
}
console.log(`${stamp()} stopped`);
process.exit(0);
