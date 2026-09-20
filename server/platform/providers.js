// Contract every external data-provider adapter (NFLverse, Sleeper, ESPN,
// weather, licensed news/stats APIs, ...) should implement so the platform
// can health-check, rate-limit, and cache them uniformly regardless of
// source. This module defines and registers the contract only — it does not
// implement any specific provider; individual services own their own adapters
// and register them here so Dev Hub health/status views have one place to
// query instead of reaching into each service.
//
// Nothing registers an adapter yet, so listProviders() returns [] and
// checkAllProviderHealth() returns {} today. That is the current state of the
// platform, not a fault in this file: server/modeling/candidates.js names this
// module twice (at :11 and in the user-facing unavailable_reason at :30) as the
// place a weather provider would be wired, and reports weather as unavailable
// precisely because none is. Deleting this module would leave that message
// pointing at nothing. It stays until either an adapter registers or that
// message is rewritten.
const REQUIRED_KEYS = ['id', 'fetch', 'health'];

const registry = new Map();

/**
 * @param {{id: string, fetch: Function, health: () => Promise<{ok:boolean,latencyMs?:number,message?:string}>,
 *          rateLimit?: {requestsPerMinute: number}, cachePolicyMs?: number}} adapter
 */
export function registerProvider(adapter) {
  for (const key of REQUIRED_KEYS) {
    if (!(key in adapter)) throw new Error(`provider adapter missing required "${key}"`);
  }
  registry.set(adapter.id, adapter);
}

export function getProvider(id) {
  return registry.get(id) ?? null;
}

export function listProviders() {
  return [...registry.values()].map(({ id, rateLimit, cachePolicyMs }) => ({ id, rateLimit, cachePolicyMs }));
}

export async function checkProviderHealth(id) {
  const provider = registry.get(id);
  if (!provider) return { ok: false, message: 'unknown provider' };
  try {
    return await provider.health();
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

export async function checkAllProviderHealth() {
  const out = {};
  for (const id of registry.keys()) out[id] = await checkProviderHealth(id);
  return out;
}
