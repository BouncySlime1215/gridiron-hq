#!/usr/bin/env node
/**
 * PRODUCER-FAST benchmark: plans one league three ways on the same league state
 * and the same seed, and prints only timings, counts and whether the plans match.
 *
 *   off   the producer as it ships today (GRIDIRON_PRODUCER_FAST unset)
 *   cold  fast lineups + an empty rescore cache (the first run after a sync)
 *   warm  fast lineups + the cache the cold run left (a replan with nothing new)
 *   speed fast lineups + PRODUCER-SPEED (points-memo.mjs) + an empty cache (plan item 32)
 *   --wide  SEARCH-WIDE on in every mode (plan item 32's target: under 60 s with it on)
 *
 * Read-only: writes no plans file and no cache file. Prints no names, only ids.
 *
 * Usage: SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<db> node scripts/campaign/bench-producer.mjs [--league 4] [--no-finder] [--wide] [--modes off,cold,warm,speed]
 */
import { planLeague } from '../../server/services/campaign/planner.js';
import { normaliseObjective } from '../../server/services/campaign/objectives.js';
import { dealKey } from '../../server/services/campaign/paths.js';
import { pathToFileURL } from 'node:url';

function args(argv) {
  const out = { league: 4, finder: true, wide: false, modes: ['off', 'cold', 'warm'] };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--league') out.league = Number(argv[++i]);
    else if (argv[i] === '--no-finder') out.finder = false;
    else if (argv[i] === '--wide') out.wide = true;
    else if (argv[i] === '--modes') out.modes = argv[++i].split(',');
  }
  return out;
}

/** The plan with timings dropped, for an exact same-plan check. */
export const planPrint = res => JSON.stringify(res, (k, v) => (v instanceof Map ? [...v]
  : k === 'runtime_ms' || k === 'phases_ms' ? undefined : v));

async function main() {
  process.env.SCHEDULER_DISABLED = '1';
  const opts = args(process.argv);
  const { loadServices, buildAdapter } = await import('./league-adapter.mjs');
  const { leagueCache } = await import('./rescore-cache.mjs');
  const svc = await loadServices();
  const objective = normaliseObjective({}, { leagueGoal: 'title' });
  // One clock for every mode, so the offer-fatigue window and days-left read the same.
  const now = Date.now();
  let prev = {}, ref = null;
  for (const mode of opts.modes) {
    const fast = mode !== 'off';
    const cache = fast ? leagueCache(mode === 'warm' ? prev : {}) : null;
    // --wide: the adapter reads it from its env (the claim universe) and the planner follows the adapter;
    // the planner's own env stays as before (empty) plus the flag.
    const wideEnv = opts.wide ? { GRIDIRON_SEARCH_WIDE: '1' } : {};
    const env = { ...process.env, ...wideEnv };
    const t0 = Date.now();
    const adapter = buildAdapter(svc, opts.league, { finder: opts.finder, fast, rescoreCache: cache, now, env,
      speed: mode === 'speed' });
    if (adapter.fail) throw new Error(`league ${opts.league}: ${adapter.fail}`);
    const adapterMs = Date.now() - t0;
    const res = planLeague(adapter, { objective, env: wideEnv });
    if (res.error) throw new Error(`league ${opts.league}: ${res.error}`);
    const total = Date.now() - t0;
    const print = planPrint(res);
    ref ??= print;
    console.log(JSON.stringify({ mode, league: opts.league, total_ms: total, adapter_and_world_ms: adapterMs,
      plan_ms: res.runtime_ms, phases_ms: res.phases_ms, rescores: res.rescores, cache: adapter.cacheStats?.() ?? null,
      speed: adapter.speedStats?.() ?? null, search_wide: res.search_wide ? res.search_wide.used : null,
      next_move: res.best ? dealKey(res.best.steps[0]) : null, same_plan_as_first_mode: print === ref }));
    if (cache) prev = cache.next;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
}
