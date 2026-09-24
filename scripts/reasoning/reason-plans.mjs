/**
 * FIX-08: the one function both writers of reasoning go through.
 *
 *   scripts/campaign/produce-plans.mjs  every producer run, after planning and before its atomic write
 *   scripts/reasoning/run.mjs           a manual re-run over the current plans file
 *
 * It decides the two gates (reasoning-flag.js and the paid-run opt-in, by
 * presence only), reads the reuse cache next to the plans file, writes each
 * move's `reasoning` through plan-reasoning.js#applyReasoning, and hands back
 * a commit() that saves the cache once the plans file itself is written.
 *
 * FIX-234-1: the same pass writes each flip's and target's `reasoning`. An
 * `open: [card ids]` in `inject` (run.mjs --open) rebuilds those items even
 * when their inputs are unchanged; everything else reuses its cached panel.
 */
import { paidRunOptIn } from '../paid-run-optin.mjs';

export async function reasonPlans({ plans, plansFile, env = process.env, dryRun = false, log = () => {}, ...inject }) {
  const { reasoningFlag } = await import('../../server/services/reasoning-flag.js');
  const { applyReasoning, readPanelsCache, writePanelsCache, panelsCachePath } =
    await import('../../server/services/reasoning/plan-reasoning.js');
  const flag = reasoningFlag();
  const gates = { enabled: flag.enabled, paid: paidRunOptIn(env).allowed };
  const cachePath = panelsCachePath(plansFile);
  // Gates off: the cache is neither read nor touched.
  const cache = gates.enabled && (gates.paid || dryRun) ? readPanelsCache(cachePath) : { previous: null, warning: null };
  if (cache.warning) log({ reasoning_warning: cache.warning });
  const result = await applyReasoning({ plans, gates, previous: cache.previous, dryRun,
    log: c => log({ reasoning_call: c }), ...inject });
  const summary = {
    status: result.status, preview: flag.preview, moves: result.moves, items: result.items ?? 0, calls: result.calls.length,
    reused: result.reused, total_cost_usd: +result.total_cost_usd.toFixed(4),
    ...(result.reason ? { reason: result.reason } : {}), ...(result.error ? { error: result.error } : {}),
    cache: result.cache ? cachePath : null
  };
  return {
    result, summary,
    commit: () => { if (result.cache && !dryRun) writePanelsCache(cachePath, result.cache); }
  };
}
