/**
 * HEALTH-01c: Coach reads health (ENGINE-SPECS.md HEALTH-01).
 *
 * Coach never repeats a broken number. An engine number reaches Coach through engine_read
 * (engine/state.js#readServed) with its health, and verify.js holds every claim to it:
 *   HEALTH_MISSING     a claim cites an engine number read without its health, or the
 *                      answer cites engine numbers without the as-of and checks line;
 *   DEGRADED_UNSTATED  a claim stands on a fallback, degraded or failed number and does
 *                      not say so.
 * A failed number is declined with its reason; a tool that throws becomes a plain
 * "I couldn't check X because Y" and the answer still ships with HTTP 200.
 *
 * RED rows: a fixture with a failed field -> the answer contains no digit from the failed
 * row and names the reason; degraded -> the answer names the fallback; a thrown tool error
 * -> the answer ships with the plain explanation, HTTP 200.
 *
 * Every Claude call is a stand-in client. No network, no spend, no key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-health-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { askCoach } = await import('../server/services/coach/ask.js');
const { verifyAnswer, VIOLATIONS } = await import('../server/services/coach/verify.js');
const { newLedger } = await import('../server/services/coach/ledger.js');
const { COACH_TOOLS } = await import('../server/services/coach/tools.js');
const { default: coachRouter } = await import('../server/routes/coach.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const registry = await import('../server/services/engine/registry.js');
const state = await import('../server/services/engine/state.js');

/* ---------------------------------------------------------------- fixture */
const W = registry.registerProducer({ name: 'producer-coach-health', active: '1', versions: { 1: {} },
  fields: [
    { field: 'test.ch_prob', valueType: 'prob', space: 'prob', entityTypes: ['player'], checks: ['prob_unit'],
      fallbackField: 'test.ch_market' },
    { field: 'test.ch_market', valueType: 'prob', space: 'prob', entityTypes: ['player'], checks: ['prob_unit'] },
  ],
});
const put = (field, entityId, value, asOf, extra = {}) => state.writeState({ entityType: 'player', entityId, field, value,
  asOf, writer: W[field], producerVersion: '1', eventIds: [], reasonChain: { contributions: [] }, ...extra });
// 9201: healthy. 9202: its latest row FAILED (1.37, prob_unit), the market fallback holds 0.42.
// 9203: its latest row is DEGRADED, the market fallback holds 0.51.
put('test.ch_prob', '9201', 0.64, '2026-09-01T00:00:00Z');
put('test.ch_market', '9202', 0.42, '2026-09-01T00:00:00Z');
put('test.ch_prob', '9202', 0.3, '2026-09-01T00:00:00Z');
put('test.ch_prob', '9202', 1.37, '2026-09-02T00:00:00Z');
put('test.ch_market', '9203', 0.51, '2026-09-01T00:00:00Z');
put('test.ch_prob', '9203', 0.6, '2026-09-02T00:00:00Z', { inputsHealth: 'degraded' });

const usage = { input_tokens: 100, output_tokens: 50 };
const toolUse = (name, input, id = 'tu1') =>
  ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage });
const says = object => ({ content: [{ type: 'text', text: JSON.stringify(object) }], stop_reason: 'end_turn', usage });
function scripted(...replies) {
  let turn = 0;
  return { messages: { create: async () => {
    const reply = replies[turn++];
    if (!reply) throw new Error(`the stand-in client ran out of replies at turn ${turn}`);
    return reply;
  } } };
}
const read = entityId => toolUse('engine_read', { entity: `player:${entityId}`, field: 'test.ch_prob',
  as_of: '2026-09-10T00:00:00Z' });

test.afterEach(() => setAnthropicClientForTesting(null));

/* ---------------------------------------------------------------- verify.js */
test('verify: HEALTH_MISSING and DEGRADED_UNSTATED are violations', () => {
  assert.equal(VIOLATIONS.HEALTH_MISSING, 'health_missing');
  assert.equal(VIOLATIONS.DEGRADED_UNSTATED, 'degraded_unstated');

  // An engine number read without its health (a raw engine_state row, not engine_read).
  const raw = newLedger();
  raw.record({ tool: 'sql_select', tables: ['engine_state'], columns: ['value'], rows: [{ value: 0.64 }] });
  const rawCheck = verifyAnswer({ ledger: raw, answer: { claims: [{ text: 'It is 0.64.', cites: ['r1#0.value'] }], refusals: [] } });
  assert.ok(rawCheck.violations.some(v => v.kind === 'health_missing'), JSON.stringify(rawCheck.violations));

  // An engine_read cell cited, but the answer carries no as-of / checks line.
  const ok = newLedger();
  ok.record({ tool: 'engine_read', tables: ['engine_state'], columns: ['value'], rows: [{ value: 0.64 }],
    health: { field: 'f.x', entity: 'player:1', status: 'ok', as_of: '2026-09-01T00:00:00.000Z', checks_passed: true,
      fallback_used: false, fallback_field: null, reason: null, problem: null } });
  const noLine = verifyAnswer({ ledger: ok, answer: { claims: [{ text: 'It is 0.64.', cites: ['r1#0.value'] }], refusals: [] } });
  assert.ok(noLine.violations.some(v => v.kind === 'health_missing'), JSON.stringify(noLine.violations));
  const withLine = verifyAnswer({ ledger: ok, answer: { claims: [{ text: 'It is 0.64.', cites: ['r1#0.value'] }],
    refusals: [], health: 'f.x for player:1 as of 2026-09-01: checks passed' } });
  assert.equal(withLine.ok, true, JSON.stringify(withLine.violations));

  // A fallback number stated as if it were the real one.
  const fb = newLedger();
  fb.record({ tool: 'engine_read', tables: ['engine_state'], columns: ['value'], rows: [{ value: 0.42 }],
    health: { field: 'f.x', entity: 'player:1', status: 'fallback', as_of: '2026-09-01T00:00:00.000Z', checks_passed: true,
      fallback_used: true, fallback_field: 'f.market', reason: 'f.x failed its checks (prob_unit)', problem: 'failed' } });
  const line = 'f.x for player:1 as of 2026-09-01: checks passed';
  const unstated = verifyAnswer({ ledger: fb, answer: { claims: [{ text: 'It is 0.42.', cites: ['r1#0.value'] }],
    refusals: [], health: line } });
  assert.ok(unstated.violations.some(v => v.kind === 'degraded_unstated'), JSON.stringify(unstated.violations));
  // A number derived from the fallback carries the fallback's health.
  fb.derive({ op: 'percent_of', inputs: ['r1#0.value', 'r1#0.value'] });
  const derived = verifyAnswer({ ledger: fb, answer: { claims: [{ text: 'It is 100%.', cites: ['d1'] }], refusals: [] } });
  assert.ok(derived.violations.some(v => v.kind === 'degraded_unstated'), JSON.stringify(derived.violations));
  assert.ok(derived.violations.some(v => v.kind === 'health_missing'), 'a derived engine number needs the health line too');
  const stated = verifyAnswer({ ledger: fb, answer: { claims: [{ text: 'The market fallback says 0.42.',
    cites: ['r1#0.value'] }], refusals: [], health: line } });
  assert.equal(stated.ok, true, JSON.stringify(stated.violations));
});

/* ---------------------------------------------------------------- askCoach */
test('a healthy engine number ships with its as-of and "checks passed" line', async () => {
  setAnthropicClientForTesting(scripted(read('9201'),
    says({ claims: [{ text: 'His chance is 0.64.', cites: ['r1#0.value'] }], refusals: [], as_of: null })));
  const result = await askCoach({ question: 'what is his chance' });
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.violations));
  assert.equal(result.answer.claims.length, 1);
  assert.match(result.answer.health, /as of 2026-09-01/);
  assert.match(result.answer.health, /checks passed/);
});

test('RED (c1): a failed field -> no digit from the failed row, and the reason is named', async () => {
  // The model states the failed number twice (it can only have invented it: the ledger never holds it).
  const bad = says({ claims: [{ text: 'His chance is 137%.', cites: ['r1#0.value'] }], refusals: [] });
  setAnthropicClientForTesting(scripted(read('9202'), bad, bad));
  const result = await askCoach({ question: 'what is his chance' });
  const shipped = JSON.stringify(result.answer);
  assert.doesNotMatch(shipped, /1\.37|137/, `the failed number shipped: ${shipped}`);
  assert.doesNotMatch(JSON.stringify(result.ledger), /1\.37/, 'the failed value reached the ledger');
  assert.ok(result.answer.refusals.some(r => /test\.ch_prob/.test(r) && /failed its checks \(prob_unit\)/.test(r)),
    `no refusal names the reason: ${shipped}`);
});

test('RED (c2): degraded -> the answer names the fallback', async () => {
  setAnthropicClientForTesting(scripted(read('9203'),
    says({ claims: [{ text: 'His chance is 0.51.', cites: ['r1#0.value'] }], refusals: [] }),
    says({ claims: [{ text: 'His chance is 0.51 on the test.ch_market fallback; the model number is degraded.',
      cites: ['r1#0.value'] }], refusals: [] })));
  const result = await askCoach({ question: 'what is his chance' });
  assert.equal(result.verification.retried, true, 'an unstated fallback passed the first check');
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.violations));
  assert.match(result.answer.claims[0].text, /test\.ch_market/);
  assert.match(result.answer.health, /fallback test\.ch_market served/);
  assert.match(result.answer.health, /degraded inputs/);
});

/* ---------------------------------------------------------------- the route */
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (9301, 'coach-health-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (9301, ?, datetime('now','+1 day'))`, hashSessionToken('coach-health-token'));

test('RED (c3): a thrown tool error -> the answer still ships, "I couldn\'t check X because Y", HTTP 200', async () => {
  const tool = COACH_TOOLS.find(t => t.name === 'who_plays');
  const original = tool.run;
  tool.run = () => { throw new Error('the injury table is locked'); };
  const app = express();
  app.use(express.json());
  app.use('/api/coach', coachRouter);
  const server = app.listen(0);
  try {
    let calls = 0;
    setAnthropicClientForTesting({ messages: { create: async () => {
      calls += 1;
      return calls === 1 ? toolUse('who_plays', { season: 2026, week: 3, team: 'PHI' })
        : says({ claims: [{ text: 'Everyone plays.', cites: [] }], refusals: [] });
    } } });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/coach/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer coach-health-token' },
      body: JSON.stringify({ question: 'who plays for PHI' }) });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(body.answer.refusals.includes("I couldn't check who_plays because the injury table is locked."),
      JSON.stringify(body.answer));
    assert.equal(body.verification.ok, true, JSON.stringify(body.verification.violations));
    assert.ok(body.plan.some(e => e.t === 'tool_error' && e.tool === 'who_plays'), 'the fault is not in the trace');
    assert.equal(calls, 1, 'the model was asked to carry on past a real fault');
    assert.equal(body.answer.claims.length, 0);
  } finally {
    tool.run = original;
    server.close();
  }
});
