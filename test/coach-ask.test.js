/**
 * The answering loop: question in, verified answer out, and nothing in between
 * that the user has to take on trust.
 *
 * The shape is the one /trades/:leagueId/sense-check already proved
 * (server/routes/trades.js:705-887): produce, check against the real numbers,
 * retry once when the check fails. The difference is that the check here is
 * deterministic — verify.js, not a second opinion — and that a second failure
 * is not softened into a hedge. If Coach cannot stand a sentence up twice, the
 * sentence does not ship and Coach says which numbers it could not support.
 *
 * Every Claude call is a stand-in client (claude.js#setAnthropicClientForTesting).
 * No network, no spend, no key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-ask-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { askCoach, MAX_TOOL_ROUNDS } = await import('../server/services/coach/ask.js');

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division, head_coach)
     VALUES (1, 'PHI', 'Philadelphia Eagles', 'NFC', 'East', 'Nick Sirianni')`);
run(`INSERT INTO players (id, name, position, team_id, depth_rank) VALUES (1, 'A Player', 'WR', 1, 1)`);
run(`INSERT INTO players (id, name, position, team_id, depth_rank) VALUES (2, 'B Player', 'WR', 1, 2)`);

const usage = { input_tokens: 100, output_tokens: 50 };
const toolUse = (name, input, id = 'tu1') =>
  ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage });
const says = object => ({ content: [{ type: 'text', text: JSON.stringify(object) }], stop_reason: 'end_turn', usage });

/** A client that plays a fixed script and records every request it was sent. */
function scripted(...replies) {
  const sent = [];
  let turn = 0;
  return {
    sent,
    messages: {
      create: async body => {
        sent.push(body);
        const reply = replies[turn++];
        if (!reply) throw new Error(`the stand-in client ran out of replies at turn ${turn}`);
        return typeof reply === 'function' ? reply(body) : reply;
      }
    }
  };
}

test.afterEach(() => setAnthropicClientForTesting(null));

test('a question answered from one query comes back verified, with the ledger behind it', async () => {
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: 'SELECT name, depth_rank FROM players ORDER BY depth_rank' }),
    says({ claims: [{ text: 'A Player is the WR at depth 1.', cites: ['r1#0.name', 'r1#0.depth_rank'] }],
      refusals: [], as_of: null })
  ));
  const result = await askCoach({ question: 'who is the top WR on PHI' });

  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.violations));
  assert.equal(result.answer.claims.length, 1);
  assert.equal(result.ledger.queries.length, 1);
  assert.equal(result.ledger.queries[0].id, 'r1');
  assert.equal(result.ledger.queries[0].rows[0].name, 'A Player');
  assert.equal(result.verification.retried, false);
});

test('the events describe what actually happened, in order', async () => {
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: 'SELECT name FROM players' }),
    says({ claims: [{ text: 'A Player is on the roster.', cites: ['r1#0.name'] }], refusals: [] })
  ));
  const events = [];
  const result = await askCoach({ question: 'who is on PHI', onEvent: e => events.push(e) });

  const kinds = events.map(e => e.t);
  assert.deepEqual(kinds.filter(k => k === 'understood').length, 1);
  assert.ok(kinds.indexOf('understood') < kinds.indexOf('query'));
  assert.ok(kinds.indexOf('query') < kinds.indexOf('checking'));
  assert.ok(kinds.indexOf('checking') < kinds.indexOf('answer'));
  const done = events.find(e => e.t === 'query' && e.status === 'done');
  assert.equal(done.id, 'r1');
  assert.equal(done.row_count, 2);
  assert.ok(Number.isFinite(done.ms));
  assert.deepEqual(result.plan.map(e => e.t), kinds, 'the returned plan is the same trace');
});

test('an ungrounded number is rejected, named back to the model, and fixed on the retry', async () => {
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: 'SELECT name, depth_rank FROM players' }),
    says({ claims: [{ text: 'A Player ran 41 routes.', cites: ['r1#0.name'] }], refusals: [] }),
    says({ claims: [{ text: 'A Player is at depth 1.', cites: ['r1#0.depth_rank', 'r1#0.name'] }], refusals: [] })
  ));
  const events = [];
  const result = await askCoach({ question: 'how many routes did A Player run', onEvent: e => events.push(e) });

  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.violations));
  assert.equal(result.verification.retried, true);
  const rejected = events.find(e => e.t === 'rejected');
  assert.ok(rejected, 'the rejection is visible in the trace');
  assert.equal(rejected.violations[0].number, '41');
});

test('the retry prompt names the exact numbers that failed, so it is actionable', async () => {
  const client = scripted(
    toolUse('sql_select', { sql: 'SELECT name FROM players' }),
    says({ claims: [{ text: 'He saw 14 targets.', cites: ['r1#0.name'] }], refusals: [] }),
    says({ claims: [], refusals: ['Target counts are not in what Coach retrieved.'] })
  );
  setAnthropicClientForTesting(client);
  await askCoach({ question: 'targets?' });

  const retryTurn = client.sent[2];
  const text = JSON.stringify(retryTurn.messages);
  assert.match(text, /14/);
  assert.match(text, /ungrounded_number|not in|cite/i);
});

test('a sentence Coach cannot stand up twice does not ship', async () => {
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: 'SELECT name FROM players' }),
    says({ claims: [{ text: 'He saw 14 targets.', cites: ['r1#0.name'] }], refusals: [] }),
    says({ claims: [{ text: 'He saw 14 targets, really.', cites: ['r1#0.name'] }], refusals: [] })
  ));
  const result = await askCoach({ question: 'targets?' });

  assert.equal(result.answer.claims.length, 0, 'an unverified claim must not reach the user');
  assert.equal(result.answer.refusals.length, 1);
  assert.match(result.answer.refusals[0], /14/);
  assert.equal(result.verification.ok, false);
  assert.equal(result.verification.retried, true);
});

test('a refused tool call is fed back to the model rather than failing the question', async () => {
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: 'SELECT * FROM nfl_bet_log' }),
    toolUse('sql_select', { sql: 'SELECT name FROM players' }, 'tu2'),
    says({ claims: [{ text: 'A Player is on the roster.', cites: ['r1#0.name'] }], refusals: [] })
  ));
  const events = [];
  const result = await askCoach({ question: 'what is in the bet log', onEvent: e => events.push(e) });

  const refused = events.find(e => e.t === 'refused');
  assert.ok(refused, 'the refusal is visible in the trace');
  assert.match(refused.reason, /nfl_bet_log/);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.violations));
  assert.equal(result.ledger.queries.length, 1, 'the refused query left no ledger entry');
});

test('a refusal with no claims is a valid answer and is not retried', async () => {
  setAnthropicClientForTesting(scripted(
    says({ claims: [], refusals: ['Coach does not read the transaction wire, so it cannot say.'] })
  ));
  const result = await askCoach({ question: 'what trades happened last week' });
  assert.equal(result.verification.ok, true);
  assert.equal(result.verification.retried, false);
  assert.equal(result.answer.refusals.length, 1);
});

test('the loop is capped, and the last round is asked for an answer rather than another lookup', async () => {
  const client = scripted(...Array.from({ length: MAX_TOOL_ROUNDS - 1 },
    (_, i) => toolUse('sql_select', { sql: 'SELECT name FROM players' }, `tu${i}`)),
    says({ claims: [{ text: 'A Player is on the roster.', cites: ['r1#0.name'] }], refusals: [] }));
  setAnthropicClientForTesting(client);
  const result = await askCoach({ question: 'keep looking' });

  assert.equal(client.sent.length, MAX_TOOL_ROUNDS);
  assert.equal(client.sent.at(-1).tools, undefined, 'the final round must offer no tools');
  assert.ok(result.answer.claims.length >= 0);
});

test('spend is booked against the coach budget, and the model is one the price table knows', async () => {
  setAnthropicClientForTesting(scripted(
    says({ claims: [], refusals: ['Nothing to answer.'] })
  ));
  await askCoach({ question: 'hello' });
  const { row } = await import('../server/db/index.js');
  const logged = row(`SELECT feature, model FROM ai_usage ORDER BY id DESC LIMIT 1`);
  assert.match(logged.feature, /^coach/);
  const { PRICING } = await import('../server/services/llm-budget.js');
  assert.ok(Object.hasOwn(PRICING, logged.model), `${logged.model} is not in the price table`);
});

test('every answer is written to the audit, verified or not', async () => {
  setAnthropicClientForTesting(scripted(
    says({ claims: [{ text: 'He saw 14 targets.', cites: [] }], refusals: [] }),
    says({ claims: [{ text: 'He saw 14 targets.', cites: [] }], refusals: [] })
  ));
  const result = await askCoach({ question: 'audit me' });
  const { row } = await import('../server/db/index.js');
  const audited = row(`SELECT * FROM coach_answers WHERE id = ?`, result.audit_id);
  assert.ok(audited, 'the answer was not recorded');
  assert.equal(audited.question, 'audit me');
  assert.equal(audited.verified, 0);
  assert.match(audited.violations_json, /uncited_claim/);
});

test('the system prompt tells the model what it may read and how to cite', async () => {
  const client = scripted(says({ claims: [], refusals: ['nothing'] }));
  setAnthropicClientForTesting(client);
  await askCoach({ question: 'anything' });
  const system = JSON.stringify(client.sent[0].system);
  assert.match(system, /player_week_usage/, 'the catalog is not in the prompt');
  assert.match(system, /r1#0\./, 'the cite grammar is not in the prompt');
  assert.match(system, /refus/i, 'the model is not told it may refuse');
  assert.ok(client.sent[0].tools.length >= 4, 'no tools were offered');
});

test('what is on screen is context, never evidence', async () => {
  const client = scripted(
    says({ claims: [{ text: 'The page shows 7 players.', cites: [] }], refusals: [] }),
    says({ claims: [], refusals: ['Coach cannot verify what the page shows.'] })
  );
  setAnthropicClientForTesting(client);
  const result = await askCoach({
    question: 'what am I looking at',
    context: { route: '/lineup', section: 'points', visible_summary: { players_shown: 7 } }
  });
  assert.match(JSON.stringify(client.sent[0].messages), /players_shown/);
  assert.equal(result.answer.claims.length, 0,
    'a number that is only on screen is not retrieved and must not be citable');
});
