/**
 * An enforced external-network guard for the test suite.
 *
 * Codex correction C06 asks for "an enforced external-network guard with
 * explicit localhost exceptions." The CI workflow previously asserted that no
 * network was needed "by construction of the test suite itself" — a claim
 * about the tests rather than a property of the run. A test that quietly
 * reached a provider would have passed, and would have kept passing until the
 * day it did not, or until it cost money.
 *
 * This makes the claim enforceable: any fetch to a host other than the local
 * machine throws, naming the host, so a leak is a loud failure rather than a
 * silent dependency. Localhost is exempted explicitly, because several tests
 * boot the real server and talk to it over a real socket, which is the whole
 * point of an integration test.
 *
 * Loaded via NODE_OPTIONS="--import ./test/offline-guard.mjs" so it applies to
 * the test runner and every worker beneath it, rather than depending on each
 * test file remembering to install it.
 */
// Same discipline for on-disk research exports as for the network: no test
// reads the real `server/data/research/market-correction-lookup.json` unless
// it explicitly points at a file of its own. 1,278 of that export's 3,044
// real-game keys collide with the synthetic ensemble fixture's key space, so
// without this every fixture-based ensemble test would silently measure real
// research values mixed into a synthetic league. `??=` so an explicit setting
// from outside the suite still wins.
process.env.GRIDIRON_MARKET_CORRECTION_LOOKUP ??= '/nonexistent/market-correction-lookup.json';
// Same isolation for the TeamRankings power-rating lookup
// (`server/services/nfl-teamrankings-lookup.js`): the real export's keys are
// real team codes across real seasons and would otherwise collide with the
// synthetic ensemble fixture's key space in any fixture-based test.
process.env.GRIDIRON_TEAMRANKINGS_LOOKUP ??= '/nonexistent/teamrankings-lookup.json';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, options) {
  let url;
  try {
    url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  } catch {
    // Not a parseable absolute URL; there is no host to reach, so nothing to guard.
    return originalFetch.call(this, input, options);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `offline test guard: blocked an external request to ${url.hostname} (${url.protocol}//${url.host}${url.pathname}). ` +
      'The test suite must run with no network, no provider credentials and no paid API calls. ' +
      'Mock the client, or point the test at a local fixture server.');
  }
  return originalFetch.call(this, input, options);
};
