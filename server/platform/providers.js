// Contract every external data-provider adapter (NFLverse, Sleeper, ESPN,
// weather, licensed news/stats APIs, ...) should implement so the platform
// can health-check, rate-limit, and cache them uniformly regardless of
// source. This module defines and registers the contract only — it does not
// implement any specific provider; individual services own their own adapters
// and register them here so Dev Hub health/status views have one place to
// query instead of reaching into each service.
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
