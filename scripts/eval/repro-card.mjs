#!/usr/bin/env node
/**
 * SERVE-LOG REPRO (batch D item 31): reproduce one served card.
 *
 * Reads the served numbers and their pin (code sha, league snapshot hash,
 * producer arguments, seed; server/services/serve-pin.js) for one response,
 * re-runs the producer and compares every number
 * (server/services/serve-repro.js). Read-only: writes nothing.
 * Pins exist only for responses served while GRIDIRON_SERVE_PIN=1.
 *
 * Usage:
 *   node scripts/eval/repro-card.mjs --league 4 --request-id <X-Served-Request-Id> [--db <path>] [--json]
 *   node scripts/eval/repro-card.mjs --league 4 --latest [--surface trade_impact] [--db <path>]
 *   --any-code       compare even though the running commit or GRIDIRON_* switches differ from the pin
 *   --any-snapshot   compare even though the league data changed since serving
 * Run it with the same GRIDIRON_* switches the server had: the pin records them.
 * Exit: 0 reproduced, 1 a number did not come back, 2 not re-run (the output says why and how).
 */
const HELP = `Reproduce one served card from its pin.

  node scripts/eval/repro-card.mjs --league <id> --request-id <id> [--db <path>] [--json]
  node scripts/eval/repro-card.mjs --league <id> --latest [--surface <surface>] [--db <path>] [--json]
  --any-code / --any-snapshot   compare instead of refusing on a different commit or switches / changed league data
  Run with the same GRIDIRON_* switches the server had; the pin records them.

Exit 0 reproduced, 1 a number did not come back, 2 not re-run.`;

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const value = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? null : null; };

if (flag('--help') || flag('-h')) { console.log(HELP); process.exit(0); }
const leagueId = Number(value('--league'));
if (!Number.isInteger(leagueId)) { console.error('--league <id> is required'); process.exit(2); }
if (!value('--request-id') && !flag('--latest')) { console.error('--request-id <id> or --latest is required'); process.exit(2); }

// The DB path must be set before the db module loads.
if (value('--db')) process.env.GRIDIRON_DB_PATH = value('--db');
process.env.SCHEDULER_DISABLED = '1';
const { reproduceCard, latestPinnedRequest, reproLines } = await import('../../server/services/serve-repro.js');

const requestId = value('--request-id') ?? latestPinnedRequest(leagueId, { surface: value('--surface') });
const result = requestId
  ? await reproduceCard({ leagueId, requestId, anyCode: flag('--any-code'), anySnapshot: flag('--any-snapshot') })
  : { league_id: leagueId, request_id: null, status: 'not_found', exit: 2, surfaces: [],
    reason: 'no pinned response for this league (pins are written only while GRIDIRON_SERVE_PIN=1)' };

if (flag('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`League ${leagueId}, request ${result.request_id ?? '(none)'}: ${result.status}.`);
  for (const line of reproLines(result)) console.log(`  ${line}`);
}
process.exit(result.exit);
