#!/usr/bin/env node
/**
 * E-DATA (a): the fast ESPN offer poller. Runs scripts/collect-league-transactions.mjs (every
 * ESPN league: the pooled P(yes) weights learn from every league's offers) every
 * offer-capture.js#pollSeconds: 120 s between 07:00 and 24:00 New York, 600 s otherwise.
 *
 * Why a separate process: the refresh loop reads ESPN once per tick with spawnSync, and a tick can
 * run for many minutes (the chat step alone may take 20), so no timer inside it fires mid-tick. A
 * decline arrives ~0.4 h after its offer; an offer made and answered inside one tick was never
 * seen, and its answer became an orphan.
 *
 * Started by scripts/refresh-live-data.mjs --loop only with GRIDIRON_OFFER_WATCH=1 (its own flag),
 * or by hand. Read-only toward ESPN with Nick's own cookies, the same request the loop already makes.
 * Importing this file runs nothing (tests import watchOnce); only running it does.
 *
 * Usage: node --env-file-if-exists=.env scripts/watch-trade-offers.mjs [--once]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pollSeconds } from '../server/services/offer-capture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = () => new Date().toISOString().slice(11, 19);

/** One collector pass. Returns { ok, last } with the collector's summary line (never a cookie). */
export function watchOnce({ spawn = spawnSync, log = console.log } = {}) {
  const t0 = Date.now();
  const r = spawn(process.execPath, ['--env-file-if-exists=.env', 'scripts/collect-league-transactions.mjs'],
    { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 5 * 60 * 1000 });
  const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter(l => l && !/espn_s2|SWID/.test(l));
  const failure = r.error || r.status == null ? String(r.error?.message ?? `killed by ${r.signal ?? 'an unknown signal'}`) : null;
  const last = lines.at(-1) ?? failure ?? `exit ${r.status}`;
  const ok = r.status === 0 && Number(/failed (\d+)/.exec(last)?.[1] ?? 0) === 0;
  const offers = lines.filter(l => /offers \d+ captured/.test(l)).map(l => /offers [^;]*/.exec(l)[0]);
  log(`${stamp()} ${'offer_watch'.padEnd(18)} ${ok ? 'ok' : 'ERROR'} ${last.slice(0, 160)}`
    + `${offers.length ? ` | ${offers.join(' | ').slice(0, 200)}` : ''} (${Date.now() - t0} ms)`);
  return { ok, last };
}

async function main(args = process.argv.slice(2)) {
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  if (args.includes('--once')) return watchOnce().ok ? 0 : 1;
  console.log(`${stamp()} offer_watch every ${pollSeconds()} s now (active ${process.env.GRIDIRON_OFFER_WATCH_ACTIVE_HOURS ?? '7-24'}`
    + ` ${process.env.GRIDIRON_OFFER_WATCH_TZ || 'America/New_York'})`);
  while (!stopping) {
    watchOnce();
    const until = Date.now() + pollSeconds() * 1000;
    while (!stopping && Date.now() < until) await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`${stamp()} offer_watch stopped`);
  return 0;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) process.exit(await main());
