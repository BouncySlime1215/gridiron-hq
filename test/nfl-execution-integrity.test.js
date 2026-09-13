import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-spread-integrity-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, dbPath, run, rows } = await import('../server/db/index.js');
assert.equal(dbPath, path.join(temp, 'fixture.sqlite'));
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
db.exec(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES
  (1,'KC','Kansas City Chiefs','AFC','West'),(2,'BAL','Baltimore Ravens','AFC','North')`);

// Freeze only the expensive forecasting producer; exercise the actual pipeline, route and ledger.
let selected = [];
const auto = await import('../server/services/nfl-auto-picks.js');
mock.module('../server/services/nfl-auto-picks.js', { namedExports: {
  ...auto, autoPickDecisionBoard: () => ({ selected, decisions: selected })
} });
const { contractKey } = await import('../server/services/nfl-contract-key.js');
const { openOpportunity, recordObserved, recordDecision, recordRefresh, recordAcceptance,
  settleOpportunity, getOpportunity } = await import('../server/services/nfl-execution-lifecycle.js');
const { ingestQuoteSnapshot } = await import('../server/services/nfl-quote-tape.js');
const { __test, settleExecutionOpportunities } = await import('../server/services/nfl-execution-pipeline.js');
const { replayDelayedExecution } = await import('../server/services/nfl-execution-replay.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const router = (await import('../server/routes/nfl-market.js')).default;
const { validAmericanPrice } = await import('../server/services/nfl-execution-validation.js');

const day = '2026-09-13', kickoff = `${day}T17:00:00Z`, decisionAt = '2026-09-12T10:07:00Z';
const makeContract = (line = -3.5, commenceTime = kickoff) => contractKey({ homeTeam: 'KC', awayTeam: 'BAL',
  commenceTime, market: 'spreads', side: 'home', line });
const args = { occurredAt: '2026-09-12T10:00:00Z', book: 'draftkings', line: -3.5, price: -110 };
const acceptance = { ...args, occurredAt: '2026-09-12T10:05:00Z', stakeUnits: 1 };
function decided(line = -3.5) {
  const a = { ...args, line };
  const opp = openOpportunity({ contract: makeContract(line), decisionSource: 'integrity-fixture', ...a });
  recordObserved(opp.id, a); recordDecision(opp.id, a);
  return opp;
}

function ingest(at, { event = 'current-game', commenceTime = kickoff, price = -110, line = -3.5,
  historical = false, receivedAt = at } = {}) {
  mock.timers.setTime(Date.parse(receivedAt));
  const payload = [{ id: event, commence_time: commenceTime, home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens',
    bookmakers: [{ key: 'draftkings', markets: [{ key: 'spreads', last_update: at, outcomes: [
      { name: 'Kansas City Chiefs', price, point: line }, { name: 'Baltimore Ravens', price: -110, point: -line }
    ] }] }] }];
  return ingestQuoteSnapshot(historical ? { timestamp: at, data: payload } : payload,
    { requestedAt: receivedAt, sourceRef: 'isolated-integrity-fixture' });
}
const resolve = (line = -3.5, options = {}) => __test.resolveQuoteBasis({ book: 'draftkings',
  american_price: -110, quote_at: '2026-09-12T10:00:00Z' }, makeContract(line), { decisionAt, ...options });

const app = express(); app.use(express.json()); app.use('/api/nfl-market', router);
app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message, code: error.code }));
run("INSERT INTO users(id,subject,display_name) VALUES (909,'spread-integrity','Fixture User')");
run("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES (909,?,'2099-01-01 00:00:00')", hashSessionToken('fixture-only-token'));
run("INSERT INTO model_permissions(user_id,permission) VALUES (909,'model:*')");
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/nfl-market`;
const nativeFetch = global.fetch;
global.fetch = (url, options) => {
  if (!String(url).startsWith(base)) throw new Error('external network forbidden in execution fixture');
  return nativeFetch(url, options);
};
const request = async (route, body) => {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer fixture-only-token', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};

// Test-only reset/legacy corruption injection. Restore every append-only trigger before exercising production code.
function mutateFixture(sql, ...params) {
  assert.equal(dbPath, path.join(temp, 'fixture.sqlite'));
  const triggers = rows("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('nfl_quote_tape','nfl_quote_batches','nfl_execution_lifecycle_events')");
  try {
    for (const t of triggers) db.exec(`DROP TRIGGER "${t.name.replaceAll('"', '""')}"`);
    if (params.length) run(sql, ...params); else db.exec(sql);
  } finally { for (const t of triggers) db.exec(t.sql); }
}

test.beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(decisionAt) });
  mutateFixture('DELETE FROM nfl_quote_tape; DELETE FROM nfl_quote_batches; DELETE FROM nfl_execution_lifecycle_events; DELETE FROM nfl_execution_opportunities; DELETE FROM game_lines;');
  selected = [];
});
test.afterEach(() => mock.timers.reset());
test.after(async () => {
  global.fetch = nativeFetch;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  db.close(); fs.rmSync(temp, { recursive: true, force: true });
});

test('repeated matchup selects this kickoff and the latest eligible price; future quotes cannot leak', () => {
  ingest('2025-09-12T10:00:00Z', { event: 'a-old', commenceTime: '2025-09-13T17:00:00Z', price: -140 });
  ingest('2026-09-12T10:00:00Z', { price: -110 });
  ingest('2026-09-12T10:06:00Z', { price: -155 });
  ingest('2026-09-12T10:08:00Z', { price: 120 });
  const basis = resolve();
  assert.equal(basis.provider_event_id, 'current-game');
  assert.equal(basis.quote.price, -155);
  assert.ok(basis.quote.quote_id);
  assert.equal(basis.timeline.length, 2);
});

test('ambiguous provider events, missing exact line and removed quotes cannot become a fallback', () => {
  ingest('2026-09-12T10:00:00Z', { event: 'one' });
  ingest('2026-09-12T10:01:00Z', { event: 'two' });
  assert.equal(resolve().error, 'ambiguous_provider_event');
  mutateFixture('DELETE FROM nfl_quote_tape; DELETE FROM nfl_quote_batches;');
  ingest('2026-09-12T10:00:00Z', { line: -2.5 });
  assert.equal(resolve().error, 'contract_unavailable');
  ingest('2026-09-12T10:01:00Z');
  ingest('2026-09-12T10:06:00Z', { line: -2.5 });
  assert.equal(resolve().error, 'contract_unavailable');
});

test('late received and historical backfilled quotes do not become live decision-time evidence', () => {
  ingest('2026-09-12T10:00:00Z', { receivedAt: '2026-09-12T10:08:00Z' });
  assert.equal(resolve().error, 'no_decision_quote');
  mutateFixture('DELETE FROM nfl_quote_tape; DELETE FROM nfl_quote_batches;');
  ingest('2026-09-12T10:00:00Z', { historical: true, receivedAt: '2026-09-12T10:08:00Z' });
  assert.equal(resolve().error, 'no_compatible_quote_history');
  assert.equal(resolve(-3.5, { allowHistorical: true }).provenance, 'quote_tape_historical_diagnostic');
  mutateFixture("UPDATE nfl_quote_batches SET received_at='unknown'");
  assert.equal(resolve(-3.5, { allowHistorical: true }).quote.received_at, null, 'unknown receipt must not throw or become prospective evidence');
});

test('stale price, future book update, and wrong period cannot pass decision selection', () => {
  ingest('2026-09-12T09:00:00Z');
  assert.equal(resolve().error, 'stale_decision_quote');
  ingest('2026-09-12T10:06:00Z');
  mutateFixture("UPDATE nfl_quote_tape SET book_updated_at='2026-09-12T10:09:00Z'");
  assert.equal(resolve().error, 'invalid_book_update_time');
  mutateFixture("UPDATE nfl_quote_tape SET period='first_half'");
  assert.equal(resolve().error, 'no_compatible_quote_history');
});

test('invalid price and stake requests leave no acceptance or money event through the real route', async () => {
  const opp = decided();
  for (const patch of [{ price: 0 }, { price: null }, { price: '' }, { price: 'bad' }, { price: 50 },
    { price: '-110' }, { price: -110.5 }, { stakeUnits: 0 }, { stakeUnits: null }, { stakeUnits: '1' },
    { line: null }, { line: -7.5 }, { book: '' }]) {
    const response = await request(`/execution/${opp.id}/accept`, { book: 'draftkings', price: -110,
      stakeUnits: 1, line: -3.5, ...patch });
    assert.equal(response.status, 400, JSON.stringify(patch));
    assert.equal(getOpportunity(opp.id).events.length, 3);
    assert.equal(getOpportunity(opp.id).status, 'decision');
  }
});

test('finite price/stake validation also protects direct ledger callers and old corrupt settlements', () => {
  for (const price of [0, null, NaN, Infinity, -Infinity, '', '-110', -99]) {
    assert.throws(() => openOpportunity({ contract: makeContract(), decisionSource: 'fixture', ...args, price }), /price/);
  }
  const opp = decided();
  for (const stakeUnits of [0, -1, NaN, Infinity]) assert.throws(() => recordAcceptance(opp.id, { ...acceptance, stakeUnits }), /stakeUnits/);
  assert.throws(() => recordAcceptance(opp.id, { ...acceptance, price: 200, stakeUnits: Number.MAX_VALUE }), /non-finite/);
  recordAcceptance(opp.id, acceptance);
  mutateFixture("UPDATE nfl_execution_lifecycle_events SET price=0 WHERE opportunity_id=? AND state='accepted'", opp.id);
  assert.throws(() => settleOpportunity(opp.id, { occurredAt: '2026-09-14T01:00:00Z', result: 'won' }), /price/);
  assert.equal(getOpportunity(opp.id).status, 'accepted');
});

test('changed handicap cannot corrupt the immutable key, while price-only refresh settles the actual price', () => {
  const opp = decided();
  assert.throws(() => recordRefresh(opp.id, { ...acceptance, line: -7.5 }), /new exact-contract/);
  assert.throws(() => recordAcceptance(opp.id, { ...acceptance, line: -7.5 }), /new exact-contract/);
  recordRefresh(opp.id, { ...acceptance, price: 120 });
  recordAcceptance(opp.id, { ...acceptance, price: 120 });
  const result = settleOpportunity(opp.id, { occurredAt: '2026-09-14T01:00:00Z', result: 'won' });
  assert.equal(result.contract_key, opp.contract_key);
  assert.equal(result.events.at(-1).realized_pnl_units, 1.2);
});

test('timestamp order and positive payout remain invariants for generated valid contracts', () => {
  fc.assert(fc.property(fc.integer({ min: -40, max: 40 }), fc.integer({ min: 100, max: 1000 }),
    fc.boolean(), (halfLine, odds, positive) => {
      const line = halfLine / 2, price = positive ? odds : -odds;
      const opp = decided(line);
      assert.throws(() => recordAcceptance(opp.id, { ...acceptance, line, price, occurredAt: '2026-09-11T00:00:00Z' }), /precede/);
      assert.throws(() => recordAcceptance(opp.id, { ...acceptance, line: line + 0.5, price }), /exact-contract/);
      recordAcceptance(opp.id, { ...acceptance, line, price, stakeUnits: 2 });
      const settled = settleOpportunity(opp.id, { occurredAt: '2026-09-14T01:00:00Z', result: 'won' });
      const expected = 2 * (positive ? odds / 100 : 100 / odds);
      assert.ok(Math.abs(settled.events.at(-1).realized_pnl_units - expected) <= 0.000051);
      assert.throws(() => settleOpportunity(opp.id, { occurredAt: '2026-09-14T01:00:01Z', result: 'won' }), /cannot record/);
    }), { seed: 9021026, numRuns: 100 });
  // Seed the original finite-only price validator: the same invalid-price property must detect it.
  const invalid = fc.constantFrom(0, 50, -99);
  const check = predicate => fc.property(invalid, price => !predicate(price));
  assert.equal(fc.check(check(Number.isFinite), { seed: 9021026 }).failed, true);
  fc.assert(check(validAmericanPrice), { seed: 9021026, numRuns: 30 });
});

test('the actual pipeline route retains the selected quote ID and future delay buckets stay pending', async () => {
  run("INSERT INTO game_lines(season,week,team,opponent,home,gameday,gametime) VALUES (2026,1,'KC','BAL',1,?,'13:00')", day);
  ingest('2026-09-12T10:00:00Z');
  ingest('2026-09-12T10:06:00Z', { price: -115 });
  mock.timers.setTime(Date.parse(decisionAt));
  // `eligible` and `abstention_reason` are not decoration: applyNflPolicy sets
  // them on every candidate it evaluates, and Codex correction C01 makes the
  // decision tape validate the board before writing it, so a fixture that
  // omits them is no longer a realistic board.
  selected = [{ market: 'spread', home_team: 'KC', away_team: 'BAL', selection: 'KC', matchup: 'BAL @ KC',
    book: 'draftkings', line: -3.5, american_price: -110, quote_at: args.occurredAt, edge_points: 4,
    eligible: true, abstention_reason: null, policy_rank: 1 }];
  const response = await request('/execution/run', { season: 2026, week: 1 });
  assert.equal(response.status, 200);
  const opened = response.body.results[0]; assert.equal(opened.opened, true);
  const opp = getOpportunity(opened.opportunity_id);
  assert.equal(opp.events.at(-1).price, -115);
  assert.ok(opp.events.every(e => e.quote_id === opp.events[0].quote_id && e.quote_id));
  assert.ok(opened.replay_preview.every(x => x.outcome === 'pending' && x.obtained_stake_units === 0));
  const retry = await request('/execution/run', { season: 2026, week: 1 });
  assert.equal(retry.body.results[0].skipped, 'already_open');
  assert.equal(rows('SELECT * FROM nfl_execution_opportunities').length, 1);
});

test('incomplete, mismatched and not-yet-started results cannot settle; no close is needed for valid P&L', () => {
  const opp = decided(); recordAcceptance(opp.id, acceptance);
  run("INSERT INTO game_lines(season,week,team,opponent,home,gameday,gametime,team_score,opp_score) VALUES (2026,1,'KC','BAL',1,?,'13:00',20,NULL),(2026,1,'BAL','KC',0,?,'13:00',17,20)", day, day);
  const after = { occurredAt: '2026-09-14T01:00:00Z' };
  assert.equal(settleExecutionOpportunities(after).skipped[0].reason, 'game_not_final');
  run("UPDATE game_lines SET opp_score=10 WHERE team='KC'");
  assert.equal(settleExecutionOpportunities(after).skipped[0].reason, 'conflicting_game_result');
  run("UPDATE game_lines SET opp_score=17 WHERE team='KC'");
  assert.equal(settleExecutionOpportunities({ occurredAt: decisionAt }).skipped[0].reason, 'game_not_final');
  const settled = settleExecutionOpportunities(after).settled[0];
  assert.equal(settled.result, 'lost'); assert.equal(settled.realized_pnl_units, -1);
  assert.equal(settleExecutionOpportunities(after).settled.length, 0);
});

test('carry-forward replay is labeled as modeled and an unobserved live horizon is pending', () => {
  const input = { timeline: [{ snapshot_at: args.occurredAt, type: 'quote', line: -3.5, price: -110 }],
    decisionAt: args.occurredAt, delaySeconds: 30 };
  // The single generic 'carry_forward_model' label was split for Codex audit
  // finding E7 into the two materially different cases it was covering. This
  // timeline has ONE sample, so +30s is past the last look anyone took:
  // extrapolated, not interpolated between two observations.
  assert.equal(replayDelayedExecution(input).availability_basis, 'carry_forward_extrapolated');
  assert.equal(replayDelayedExecution({ ...input, observedThrough: args.occurredAt }).outcome, 'pending');
});

test('the existing research plan endpoint serves the installed spread plan', async () => {
  const response = await fetch(base + '/research-lab/plan');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Scope: ordinary full-game, pregame NFL spreads/);
  assert.equal(body, fs.readFileSync(new URL('../docs/CLAUDE-NEXT-STEPS.md', import.meta.url), 'utf8'));
});
