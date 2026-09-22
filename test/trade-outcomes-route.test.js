/**
 * The outcome ledger at its call site: GET /api/trades/:leagueId/proposals.
 *
 * `routes/trades.js` is the only caller of `recordProposalSlate`, and it is the
 * only layer that holds both the slate that passed the edge test and the model's
 * answer. The service tests in trade-outcomes.test.js prove the recorder; they
 * cannot prove the route hands it the right things. This file does, through the
 * route as `server/index.js` mounts it.
 *
 * WHAT IS REAL AND WHAT IS NOT. The route, the proposals pass
 * (`proposalsFor` and its verifier), the cache, the acceptance band, the ledger
 * and the migration are all real. Two things are stubbed: `findTrades`, because
 * a full league valuation is not what is under test and the deals it returns are
 * built here in its own field names (trade-engine.js:1688-1692, :1930); and
 * `callClaude`, because the model is the one part that costs money. Its reply is
 * a fixture that the real verifier then checks.
 *
 * Every name below is made up. No league, manager or player in it is real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-outcome-route-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const { acceptanceBand } = await import('../server/services/trade-acceptance.js');
const { PROMPT_VERSION } = await import('../server/services/trade-proposals.js');

// ------------------------------------------------------------ the two stubs
const band = acceptanceBand({
  counterparty: { receptiveness: 1, perception_delta: null, counterparty_data: false },
  edge: { passes: true } });
const deal = (id, partnerId, give, get) => ({
  id, partner: `Owner ${partnerId}`, partner_id: partnerId,
  i_give: [{ id: 100 + partnerId, name: give, value: 10 }],
  i_get: [{ id: 200 + partnerId, name: get, value: 12 }],
  me: { ppg_delta: 1.5 }, their_value_pct: 3, tactics: [],
  counterparty: { receptiveness: 1, perception_delta: null, perception_shift: null,
    perception_reasons: [], chat_msgs: 0, accept_rate: null, counterparty_data: false },
  acceptance: band,
});
const DEALS = [
  deal('Alpha Give>Alpha Get', 2, 'Alpha Give', 'Alpha Get'),
  deal('Beta Give>Beta Get', 3, 'Beta Give', 'Beta Get'),
  deal('Gamma Give>Gamma Get', 4, 'Gamma Give', 'Gamma Get'),
];
const UNIVERSE = ['Alpha Give', 'Alpha Get', 'Beta Give', 'Beta Get', 'Gamma Give', 'Gamma Get', 'Other Player'];

const realEngine = await import('../server/services/trade-engine.js');
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realEngine,
    findTrades: () => ({ deals: DEALS.map(d => ({ ...d })), league_player_names: UNIVERSE }),
  },
});

const proposal = (ideaIds, give, get) => ({
  idea_ids: ideaIds, package: { i_give: give, i_get: get },
  why_they_say_yes: 'he is thin at the position', opener: 'hey, open to a swap?',
  ask: 'the package as listed', fair: 'the package as listed', floor: 'the package as listed',
  timing: { send: 'now', reason: 'before the waiver run' }, risk: 'an injury changes it',
  data_used: 'the lineup gain',
});
let modelCalls = 0;
const realClaude = await import('../server/services/claude.js');
mock.module('../server/services/claude.js', {
  namedExports: {
    ...realClaude,
    callClaude: async () => {
      modelCalls++;
      return JSON.stringify([
        proposal(['Alpha Give>Alpha Get'], ['Alpha Give'], ['Alpha Get']),
        // Names a player in none of the ideas it cites, so the real verifier discards it.
        proposal(['Beta Give>Beta Get'], ['Beta Give'], ['Other Player']),
      ]);
    },
  },
});

const { default: tradesRouter } = await import('../server/routes/trades.js');

// ------------------------------------------------------------------ app setup
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (8801, 'outcome-route-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (8801, ?, datetime('now','+1 day'))`, hashSessionToken('outcome-token'));

function insertLeague(id, season) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id)
       VALUES (?, 'espn', ?, ?, ?, ?, 4, '1')`,
  id, `espn-outcome-${id}`, season, `L${id}`, JSON.stringify({ teams: [], members: [] }));
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 8801, 'member')`, id);
}
insertLeague(41, 2026);
insertLeague(42, null);

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const get = async url => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`,
    { headers: { authorization: 'Bearer outcome-token' } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const ledgerRows = leagueId => rows(
  `SELECT idea_id, source, status, proposer_team_id, counterparty_team_id, give_json, get_json,
          model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version,
          not_proposed_reason, season
   FROM trade_outcomes WHERE league_id = ? ORDER BY idea_id`, leagueId);

// ---------------------------------------------------------------------- tests

test('route: a fresh proposals run writes what it sent and what it did not, with the model\'s band', async () => {
  const res = await get('/api/trades/41/proposals?team_id=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'model', 'precondition: the model path ran');
  assert.equal(res.body.proposals.length, 1, 'precondition: the verifier passed one proposal');

  assert.equal(res.body.outcome_ledger?.state, 'recorded',
    'the ledger state reaches the response, so an inert ledger says so on the surface');
  assert.equal(res.body.outcome_ledger.proposed, 1);
  assert.equal(res.body.outcome_ledger.considered, 2);

  const byIdea = Object.fromEntries(ledgerRows(41).map(r => [r.idea_id, r]));
  const a = byIdea['Alpha Give>Alpha Get'];
  assert.equal(a.source, 'app_proposed');
  assert.equal(a.status, 'proposed');
  assert.equal(a.season, 2026, 'the league\'s own season');
  assert.equal(a.proposer_team_id, '1', 'the team the caller asked for');
  assert.equal(a.counterparty_team_id, '2', 'the engine\'s partner_id');
  assert.equal(a.model_version, PROMPT_VERSION, 'the prompt version that produced the decision');
  assert.equal(a.model_p_accept, band.band.mid);
  assert.equal(a.model_p_accept_low, band.band.low);
  assert.equal(a.model_p_accept_high, band.band.high);
  assert.equal(a.model_basis, band.basis);
  assert.deepEqual(JSON.parse(a.give_json).map(p => p.name), ['Alpha Give']);
  assert.deepEqual(JSON.parse(a.get_json).map(p => p.name), ['Alpha Get']);

  const b = byIdea['Beta Give>Beta Get'];
  assert.equal(b.source, 'considered_only');
  assert.match(b.not_proposed_reason, /names Other Player, who is in none of the ideas it cites/);
  assert.equal(byIdea['Gamma Give>Gamma Get'].source, 'considered_only');
  assert.match(byIdea['Gamma Give>Gamma Get'].not_proposed_reason, /did not select it/);
});

test('route: a page re-open is served from cache and writes nothing', async () => {
  const before = ledgerRows(41).length;
  const callsBefore = modelCalls;
  const res = await get('/api/trades/41/proposals?team_id=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'cache', 'precondition: the second open is a cache hit');
  assert.equal(modelCalls, callsBefore, 'precondition: the model was not called again');
  assert.equal(res.body.outcome_ledger?.state, 'no_decision_made');
  assert.equal(ledgerRows(41).length, before, 'one decision is one set of rows, however often the page opens');
});

test('route: a ledger write that fails does not fail the proposals, and says why on the surface', async () => {
  // A league with no season: the ledger refuses the row (season is required, in
  // the service and NOT NULL in the table). The proposals are the product and
  // still arrive; the ledger's failure travels with them instead of vanishing.
  const res = await get('/api/trades/42/proposals?team_id=1');
  assert.equal(res.status, 200, 'the measurement must never fail the thing it measures');
  assert.equal(res.body.proposals.length, 1, 'the proposals still arrive');
  assert.equal(res.body.outcome_ledger?.state, 'write_failed');
  assert.match(res.body.outcome_ledger.reason, /season is required/);
  assert.equal(ledgerRows(42).length, 0);
});
