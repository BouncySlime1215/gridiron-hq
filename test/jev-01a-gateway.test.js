import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// JEV-01a: the Jev gateway as a shadow engine stage. Every test injects the
// gateway's `evaluate` and `getCredits`, so nothing here reaches the network,
// needs a key, or spends money. ENGINE-00a (#216) is not on main yet, so the
// engine sink is a recording fake with the same one-writer rule.
process.env.SCHEDULER_DISABLED = '1';
// FIX-248-2: the engine adapter writes through #216's appendEvents/writeState, which
// refuse any process role but engine/script/test.
process.env.GRIDIRON_PROCESS_ROLE = 'test';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-jev-01a-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db, rows } = await import('../server/db/index.js');
const { PRICING } = await import('../server/services/llm-budget.js');
const { createJevGateway, createRunawayMonitor, JEV_MODEL } = await import('../server/services/jev/gateway.js');
const { QUESTION_TYPES, buildQuestions, interpret, askable, PITCH_ARMS } = await import('../server/services/jev/questions.js');
const { buildJevState } = await import('../server/services/jev/state.js');
const { runJevStage, guardSink } = await import('../server/services/jev/stage.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_ENV = { AI_GATEWAY_API_KEY: 'test-key-not-real' };

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

function fakeSink() {
  const events = [];
  const state = [];
  return {
    events, state,
    appendEvent(e) { events.push(e); return events.length; },
    writeState(r) { state.push(r); return state.length; },
  };
}

const T = '2026-09-27T16:00:00.000Z';
const NAMES = ['Alex Placeholder', 'Jordan Fixture'];
const view = () => ({
  as_of: T,
  managers: [{ id: 'm1', name: NAMES[0] }, { id: 'm2', name: NAMES[1] }],
  rows: [
    { id: 11, entity_type: 'player', entity_id: 'p1', field: 'sim.week.q50', value: 14.2, as_of: '2026-09-27T12:00:00.000Z' },
    { id: 12, entity_type: 'player', entity_id: 'p1', field: 'sim.week.q90', value: 24.0, as_of: '2026-09-27T12:00:00.000Z' },
    { id: 13, entity_type: 'league_team', entity_id: 'm1', field: 'tells.card', value: `${NAMES[0]} trades after losses`, as_of: '2026-09-26T12:00:00.000Z' },
    { id: 99, entity_type: 'player', entity_id: 'p1', field: 'sim.week.q50', value: 3.1, as_of: '2026-09-28T12:00:00.000Z' },
  ],
  events: [
    { id: 501, ts: '2026-09-27T10:00:00.000Z', type: 'news', entity_id: 'p1', text: 'Limited in practice Friday' },
    { id: 502, ts: '2026-09-27T20:00:00.000Z', type: 'news', entity_id: 'p1', text: 'FUTURE: ruled out' },
    { id: 503, ts: '2026-09-26T10:00:00.000Z', type: 'chat', entity_id: 'm2', text: `${NAMES[1]} wants a WR` },
  ],
});

const okEvaluate = (probability = 0.7, inputTokens = 1000) => {
  const calls = [];
  const fn = async ({ model, state, questions }) => {
    calls.push({ model, state, questions });
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'boolean') answers[id] = { type: 'boolean', probability };
      else {
        const keys = Object.keys(q.criteria);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.6 : 0.4 / (keys.length - 1)]));
        answers[id] = { type: 'choice', choice: keys[0], probabilities };
      }
    }
    return { answers, usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens } };
  };
  fn.calls = calls;
  return fn;
};

// RED (1): one client. Nothing else in server/ calls experimental_evaluate.
test('only server/services/jev/gateway.js imports experimental_evaluate', () => {
  const hits = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js|ts)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('experimental_evaluate')) {
        hits.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, 'server'));
  assert.deepEqual(hits, ['server/services/jev/gateway.js']);
});

// RED (2): one writer. jev.* fields belong to producer 'jev' only.
test('a jev.* write under another producer throws, and jev may not write outside jev.*', () => {
  const sink = guardSink(fakeSink());
  assert.throws(() => sink.writeState({ entity_type: 'player', entity_id: 'p1', field: 'jev.plays_sunday.jev_a', producer: 'proj', value: {} }),
    /jev\.plays_sunday\.jev_a.*producer 'jev'/);
  assert.throws(() => sink.writeState({ entity_type: 'player', entity_id: 'p1', field: 'sim.week.q50', producer: 'jev', value: 1 }),
    /jev may only write jev\.\* fields/);
  assert.doesNotThrow(() => sink.writeState({ entity_type: 'player', entity_id: 'p1', field: 'jev.plays_sunday.jev_a', producer: 'jev', value: {} }));
});

// RED (3): as-of. A snapshot built at t has no row or event stamped after t.
test('the state pack built at t carries no row or event after t', () => {
  const pack = buildJevState(view(), { asOf: T, subject: { entity_type: 'player', entity_id: 'p1', label: 'Player One' } });
  assert.ok(!pack.text.includes('FUTURE'), 'a future event leaked into the pack');
  assert.ok(!pack.text.includes('3.1'), 'a future state row leaked into the pack');
  assert.ok(!pack.stateIds.includes(99));
  assert.ok(!pack.eventIds.includes(502));
  assert.deepEqual(pack.stateIds, [11, 12, 13]);
  assert.deepEqual(pack.dropped, { rows: 1, events: 1 });
});

// RED (4): a mocked call writes exactly 1 jev_call event + 1 ai_usage row priced tokens x price.
test('one mocked call logs one jev_call event and one ai_usage row at tokens x price', async () => {
  assert.ok(PRICING[JEV_MODEL], 'typesafe-ai/jev must be priced');
  const sink = fakeSink();
  const before = rows(`SELECT id FROM ai_usage`).length;
  const gw = createJevGateway({ evaluate: okEvaluate(0.7, 25_000), sink, env: KEY_ENV });
  const q = buildQuestions('plays_sunday', 'a', { entity_type: 'player', entity_id: 'p1', label: 'Player One' });
  const res = await gw.ask({ qtype: 'plays_sunday', arm: 'a', state: 'STATE', questions: q, asOf: T, stateIds: [11] });
  assert.equal(res.ok, true);
  const calls = sink.events.filter(e => e.type === 'jev_call');
  assert.equal(calls.length, 1);
  const usage = rows(`SELECT * FROM ai_usage ORDER BY id`).slice(before);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].feature, 'jev:plays_sunday');
  assert.equal(usage[0].model, JEV_MODEL);
  assert.equal(usage[0].input_tokens, 25_000);
  const expected = 25_000 * PRICING[JEV_MODEL].in / 1e6;
  assert.ok(Math.abs(usage[0].cost_usd - expected) < 1e-12);
  const p = calls[0].payload;
  assert.equal(p.ok, 1);
  assert.equal(p.qtype, 'plays_sunday');
  assert.equal(p.question_version, QUESTION_TYPES.plays_sunday.version);
  assert.equal(p.model, JEV_MODEL);
  assert.equal(p.input_tokens, 25_000);
  assert.ok(Math.abs(p.cost_usd - expected) < 1e-12);
  assert.equal(p.ai_usage_id, usage[0].id);
  assert.match(p.prompt_hash, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(p.latency_ms));
});

test('a mocked 5xx writes ok=0 and the stage writes no answer row', async () => {
  const sink = fakeSink();
  const failing = async () => { throw Object.assign(new Error('Internal Server Error'), { statusCode: 503 }); };
  const gw = createJevGateway({ evaluate: failing, sink, env: KEY_ENV, getCredits: async () => ({ balance: '5', totalUsed: '0' }) });
  const out = await runJevStage({ view: view(), asOf: T, gateway: gw, sink,
    asks: [{ qtype: 'plays_sunday', subject: { entity_type: 'player', entity_id: 'p1', label: 'Player One' } }] });
  const calls = sink.events.filter(e => e.type === 'jev_call');
  assert.equal(calls.length, 2, 'one call per arm');
  assert.ok(calls.every(c => c.payload.ok === 0 && /Internal Server Error/.test(c.payload.error)));
  assert.equal(sink.state.filter(r => r.field.startsWith('jev.plays_sunday.')).length, 0);
  assert.equal(out.results[0].status, 'error');
  assert.equal(out.results[0].p, null);
});

// RED (5): runaway raises an alert and never blocks.
test('60 calls in a minute against a 2/h median raise jev_runaway and the 61st call still goes out', async () => {
  let clock = Date.parse(T);
  const sink = fakeSink();
  const evaluate = okEvaluate(0.5, 10);
  const runaway = createRunawayMonitor({ now: () => clock, medianPerHour: () => 2 });
  const gw = createJevGateway({ evaluate, sink, env: KEY_ENV, now: () => clock, runaway });
  for (let i = 0; i < 61; i++) {
    const q = buildQuestions('p_accept', 'a', { entity_type: 'offer', entity_id: `o${i}`, label: `offer o${i}` });
    const r = await gw.ask({ qtype: 'p_accept', arm: 'a', state: `S${i}`, questions: q, asOf: T, stateIds: [] });
    assert.equal(r.ok, true, `call ${i + 1} was blocked`);
    clock += 1000;
  }
  assert.equal(evaluate.calls.length, 61);
  const alerts = sink.events.filter(e => e.type === 'jev_runaway');
  assert.ok(alerts.length >= 1);
  assert.ok(alerts.some(a => a.payload.reasons.some(r => r.kind === 'rate')));
  assert.equal(alerts.filter(a => a.payload.reasons.some(r => r.kind === 'rate')).length, 1, 'one rate alert per hour, not one per call');
  assert.match(gw.status().runaway, /calls in the last hour/);
});

test('the same prompt hash more than 3 times in 10 minutes raises a repeat alert', async () => {
  let clock = Date.parse(T);
  const sink = fakeSink();
  const runaway = createRunawayMonitor({ now: () => clock, medianPerHour: () => 1000 });
  const gw = createJevGateway({ evaluate: okEvaluate(), sink, env: KEY_ENV, now: () => clock, runaway });
  const q = buildQuestions('p_accept', 'a', { entity_type: 'offer', entity_id: 'o1', label: 'offer o1' });
  for (let i = 0; i < 4; i++) { await gw.ask({ qtype: 'p_accept', arm: 'a', state: 'SAME', questions: q, asOf: T, stateIds: [] }); clock += 60_000; }
  assert.ok(sink.events.some(e => e.type === 'jev_runaway' && e.payload.reasons.some(r => r.kind === 'repeat_hash')));
});

test('a balance projected to hit zero within 24h raises a balance alert', () => {
  let clock = Date.parse(T);
  const m = createRunawayMonitor({ now: () => clock, medianPerHour: () => 1000 });
  m.recordSend({ hash: 'h', costUsd: 0.5 });
  const reasons = m.check({ balanceUsd: 5 });
  assert.ok(reasons.some(r => r.kind === 'balance' && r.hours_to_zero <= 24));
  assert.ok(!m.check({ balanceUsd: 500 }).some(r => r.kind === 'balance'));
});

// RED (6): no key -> typed status, never a default probability.
test('without AI_GATEWAY_API_KEY the stage writes jev.status=no_key and no probability', async () => {
  const sink = fakeSink();
  const evaluate = okEvaluate();
  const gw = createJevGateway({ evaluate, sink, env: {} });
  const out = await runJevStage({ view: view(), asOf: T, gateway: gw, sink,
    asks: [{ qtype: 'plays_sunday', subject: { entity_type: 'player', entity_id: 'p1', label: 'Player One' } }] });
  assert.equal(out.status, 'no_key');
  assert.equal(evaluate.calls.length, 0);
  const st = sink.state.find(r => r.field === 'jev.status');
  assert.equal(st.value.status, 'no_key');
  assert.match(st.value.reason, /AI_GATEWAY_API_KEY/);
  assert.ok(!sink.state.some(r => r.value && typeof r.value === 'object' && 'p' in r.value));
  assert.ok(!JSON.stringify(sink.state).includes('test-key-not-real'));
});

// RED (7): no real manager name anywhere Jev or the log sees.
test('no manager name appears in the prompt, the events or the state rows', async () => {
  const sink = fakeSink();
  const evaluate = okEvaluate();
  const gw = createJevGateway({ evaluate, sink, env: KEY_ENV, getCredits: async () => ({ balance: '5.00', totalUsed: '1.25' }) });
  await runJevStage({ view: view(), asOf: T, gateway: gw, sink, asks: [
    { qtype: 'p_accept', subject: { entity_type: 'offer', entity_id: 'o1', label: 'offer o1', counterparty: 'm2' } },
    { qtype: 'role_change', subject: { entity_type: 'player', entity_id: 'p1', label: 'Player One' } },
  ] });
  const blob = JSON.stringify({ prompts: evaluate.calls, events: sink.events, state: sink.state });
  for (const n of NAMES) {
    for (const part of n.split(' ')) assert.ok(!blob.includes(part), `"${part}" leaked`);
  }
  assert.ok(blob.includes('MANAGER M'), 'managers appear under their pseudonym');
});

// The stage output: probability + recommended action + cited fields, weight 0.
test('each question type returns a probability, an action and the cited state ids, in shadow', async () => {
  const sink = fakeSink();
  const gw = createJevGateway({ evaluate: okEvaluate(0.8), sink, env: KEY_ENV, getCredits: async () => ({ balance: '4.50', totalUsed: '0.50' }) });
  const out = await runJevStage({ view: view(), asOf: T, gateway: gw, sink, asks: [
    { qtype: 'plays_sunday', subject: { entity_type: 'player', entity_id: 'p1', label: 'Player One' } },
    { qtype: 'role_change', subject: { entity_type: 'player', entity_id: 'p1', label: 'Player One' } },
    { qtype: 'p_accept', subject: { entity_type: 'offer', entity_id: 'o1', label: 'offer o1', counterparty: 'm2' } },
    { qtype: 'sim_contradiction', subject: { entity_type: 'player', entity_id: 'p1', label: 'Player One', links: ['sim.week.q50', 'news'] } },
  ] });
  assert.equal(out.status, 'ok');
  assert.equal(out.results.length, 4);
  for (const r of out.results) {
    assert.equal(r.status, 'ok');
    assert.ok(r.p >= 0 && r.p <= 1, `${r.qtype} p`);
    assert.equal(typeof r.action, 'string');
    assert.equal(r.weight, 0);
    assert.equal(r.lane, 'shadow');
    assert.ok(r.cited.state_ids.length > 0);
    assert.ok(!r.cited.state_ids.includes(99));
    // Player questions read the player's rows; an offer question reads team context, not p1's sim rows.
    assert.equal(r.cited.state_ids.includes(11), r.qtype !== 'p_accept');
  }
  assert.equal(out.results[0].action, 'no_change');
  assert.equal(out.results[1].choice, 'down');
  assert.equal(out.results[2].action, 'send');
  assert.equal(out.results[3].link, 'sim.week.q50');
  const logged = sink.events.filter(e => e.type === 'jev_call');
  assert.equal(logged.length, 8);
  for (const e of logged) {
    const r = out.results.find(x => x.qtype === e.payload.qtype);
    assert.deepEqual(e.payload.state_ids, r.cited.state_ids, 'each jev_call names the state rows Jev read');
  }
  const answers = sink.state.filter(r => /^jev\.[a-z_]+\.jev_[ab]$/.test(r.field));
  assert.equal(answers.length, 8, 'two arms per question type');
  assert.ok(answers.every(r => r.producer === 'jev' && r.value.weight === 0 && r.reason_chain.state_ids.length));
  const bal = sink.state.find(r => r.field === 'jev.balance');
  assert.deepEqual(bal.value, { balance_usd: 4.5, total_used_usd: 0.5 });
});

test('arms disagreeing by more than 0.25 store a disagreement field', async () => {
  const sink = fakeSink();
  let n = 0;
  const evaluate = async ({ questions }) => {
    const p = n++ === 0 ? 0.9 : 0.4;
    return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'boolean', probability: p }])), usage: { inputTokens: 10 } };
  };
  const gw = createJevGateway({ evaluate, sink, env: KEY_ENV, getCredits: async () => ({ balance: '5', totalUsed: '0' }) });
  const out = await runJevStage({ view: view(), asOf: T, gateway: gw, sink,
    asks: [{ qtype: 'plays_sunday', subject: { entity_type: 'player', entity_id: 'p1', label: 'Player One' } }] });
  const d = sink.state.find(r => r.field === 'jev.plays_sunday.disagreement');
  assert.ok(d);
  assert.ok(Math.abs(d.value.spread - 0.5) < 1e-9);
  assert.ok(Math.abs(out.results[0].p - 0.65) < 1e-9);
});

test('a repeat question inside the same as-of window is served from the stage, not re-sent', async () => {
  const sink = fakeSink();
  const evaluate = okEvaluate();
  const gw = createJevGateway({ evaluate, sink, env: KEY_ENV, getCredits: async () => ({ balance: '5', totalUsed: '0' }) });
  const asks = [{ qtype: 'plays_sunday', subject: { entity_type: 'player', entity_id: 'p1', label: 'Player One' } }];
  await runJevStage({ view: view(), asOf: T, gateway: gw, sink, asks });
  await runJevStage({ view: view(), asOf: T, gateway: gw, sink, asks });
  assert.equal(evaluate.calls.length, 2, 'two arms once, then deduped');
});

test('a balance read failure is recorded, not swallowed, and the stage still runs', async () => {
  const sink = fakeSink();
  const gw = createJevGateway({ evaluate: okEvaluate(), sink, env: KEY_ENV,
    getCredits: async () => { throw new Error('credits endpoint down'); } });
  const out = await runJevStage({ view: view(), asOf: T, gateway: gw, sink,
    asks: [{ qtype: 'plays_sunday', subject: { entity_type: 'player', entity_id: 'p1', label: 'Player One' } }] });
  const bal = sink.state.find(r => r.field === 'jev.balance');
  assert.equal(bal.value.status, 'unavailable');
  assert.match(bal.value.reason, /credits endpoint down/);
  assert.equal(out.results[0].status, 'ok');
});

test('the stage refuses to run without an engine sink', async () => {
  const gw = createJevGateway({ evaluate: okEvaluate(), sink: fakeSink(), env: KEY_ENV });
  await assert.rejects(runJevStage({ view: view(), asOf: T, gateway: gw, asks: [] }), /engine sink/);
});

test('interpret maps each typed answer to a probability and an action', () => {
  assert.deepEqual(interpret('plays_sunday', { plays: { type: 'boolean', probability: 0.2 } }).action, 'bench_or_replace');
  assert.deepEqual(interpret('p_accept', { accepts: { type: 'boolean', probability: 0.1 } }).action, 'drop_offer');
  const role = interpret('role_change', { role: { type: 'choice', choice: 'up', probabilities: { down: 0.1, same: 0.2, up: 0.7 } } });
  assert.equal(role.p, 0.7);
  assert.equal(role.action, 'review_role_up');
  assert.throws(() => interpret('plays_sunday', {}), /missing answer/);
});

/* ------------------------------------------- FIX-248-1: pitch_framing, startsit_tiebreak */

test('pitch_framing is a choice over the four PITCH arms, in two phrasings', () => {
  assert.deepEqual([...PITCH_ARMS], ['need_first', 'fairness_first', 'urgency_first', 'face_safe_short']);
  const t = QUESTION_TYPES.pitch_framing;
  assert.equal(t.version, 1);
  assert.equal(t.subject, 'offer');
  const subject = { entity_type: 'offer', entity_id: '7', label: 'offer 7' };
  const a = buildQuestions('pitch_framing', 'a', subject);
  const b = buildQuestions('pitch_framing', 'b', subject);
  assert.equal(a.pitch.type, 'choice');
  assert.equal(b.pitch.type, 'choice');
  assert.deepEqual(Object.keys(a.pitch.criteria), [...PITCH_ARMS]);
  assert.deepEqual(Object.keys(b.pitch.criteria), [...PITCH_ARMS]);
  assert.notEqual(a.pitch.instructions, b.pitch.instructions, 'the two arms are two phrasings');
  const out = interpret('pitch_framing', { pitch: { type: 'choice', choice: 'fairness_first',
    probabilities: { need_first: 0.2, fairness_first: 0.5, urgency_first: 0.2, face_safe_short: 0.1 } } });
  assert.equal(out.choice, 'fairness_first');
  assert.equal(out.p, 0.5);
  assert.deepEqual(out.vector, [0.2, 0.5, 0.2, 0.1]);
  assert.equal(out.action, 'pitch_fairness_first');
  assert.throws(() => interpret('pitch_framing', { pitch: { type: 'choice', choice: 'flattery' } }), /not one of/);
});

test('startsit_tiebreak is a choice A/B, in two phrasings, asked only inside 1 paired SE', () => {
  const t = QUESTION_TYPES.startsit_tiebreak;
  assert.equal(t.version, 1);
  const subject = { entity_type: 'league_team_week', entity_id: '4:3:2026:4', label: 'the FLEX spot',
    options: { A: 'Player One', B: 'Player Two' }, sim_margin: 0.4, paired_se: 1.1 };
  const a = buildQuestions('startsit_tiebreak', 'a', subject);
  const b = buildQuestions('startsit_tiebreak', 'b', subject);
  assert.deepEqual(Object.keys(a.start.criteria), ['A', 'B']);
  assert.deepEqual(Object.keys(b.start.criteria), ['A', 'B']);
  assert.notEqual(a.start.instructions, b.start.instructions);
  assert.match(a.start.criteria.A, /Player One/);
  assert.match(a.start.criteria.B, /Player Two/);
  assert.deepEqual(askable('startsit_tiebreak', subject), { ok: true });
  assert.deepEqual(askable('startsit_tiebreak', { ...subject, sim_margin: -1.1 }),
    { ok: false, reason: 'sim_margin_over_1_paired_se' }, 'a margin of exactly 1 SE is not a tie');
  assert.deepEqual(askable('startsit_tiebreak', { ...subject, paired_se: null }), { ok: false, reason: 'no_paired_se' });
  assert.deepEqual(askable('startsit_tiebreak', { ...subject, sim_margin: undefined }), { ok: false, reason: 'no_sim_margin' });
  assert.deepEqual(askable('plays_sunday', { label: 'x' }), { ok: true }, 'other types have no gate');
  const out = interpret('startsit_tiebreak', { start: { type: 'choice', choice: 'B', probabilities: { A: 0.45, B: 0.55 } } });
  assert.deepEqual([out.choice, out.p, out.action], ['B', 0.55, 'start_B']);
  assert.deepEqual(out.vector, [0.45, 0.55]);
  assert.throws(() => buildQuestions('startsit_tiebreak', 'a', { ...subject, options: { A: 'Player One' } }), /options A and B/);
});

test('the stage does not ask a start/sit tiebreak when the sim margin is 1 paired SE or more', async () => {
  const sink = fakeSink();
  const evaluate = okEvaluate();
  const gw = createJevGateway({ evaluate, sink, env: KEY_ENV, getCredits: async () => ({ balance: '5', totalUsed: '0' }) });
  const subject = { entity_type: 'league_team_week', entity_id: '4:3:2026:4', label: 'the FLEX spot',
    options: { A: 'Player One', B: 'Player Two' }, sim_margin: 2.5, paired_se: 1.0 };
  const out = await runJevStage({ view: view(), asOf: T, gateway: gw, sink,
    asks: [{ qtype: 'startsit_tiebreak', subject }, { qtype: 'startsit_tiebreak', subject: { ...subject, sim_margin: 0.3 } }] });
  assert.equal(evaluate.calls.length, 2, 'only the in-band ask reaches Jev (two arms)');
  assert.deepEqual([out.results[0].status, out.results[0].reason, out.results[0].p], ['not_asked', 'sim_margin_over_1_paired_se', null]);
  assert.equal(out.results[1].status, 'ok');
  assert.ok(['start_A', 'start_B'].includes(out.results[1].action));
});

/* ------------------------------------------- FIX-248-2: #216's engine spine as the sink */

const registry = await import('../server/services/engine/registry.js');
const engineState = await import('../server/services/engine/state.js');
const { getEvents } = await import('../server/services/engine/events.js');
const { createEngineSink, jevCallMedianPerHour, JEV_PRODUCER_VERSIONS } = await import('../server/services/jev/engine-sink.js');

// RED: the registry, not only guardSink, refuses jev.* to any other producer.
test('a jev.* write under another producer throws via the one-writer registry', () => {
  const spec = registry.producerSpec('jev');
  assert.ok(spec, "producer 'jev' is registered in #216's registry");
  for (const f of ['jev.status', 'jev.balance', 'jev.p_accept.jev_a', 'jev.pitch_framing.jev_b', 'jev.startsit_tiebreak.disagreement']) {
    assert.ok(spec.fields.includes(f), `${f} is declared by jev`);
    assert.equal(registry.fieldSpec(f).producer, 'jev');
  }
  assert.throws(() => registry.registerField('jev.p_accept.jev_a', { producer: 'acceptance', version: '1' }),
    /already has its one producer jev/);
  const other = registry.registerField('test.not_jev', { producer: 'someone-else', version: '1', entityTypes: ['offer'] });
  assert.throws(() => engineState.writeState({ entityType: 'offer', entityId: '1', field: 'jev.p_accept.jev_a', value: { p: 0.5 },
    asOf: T, writer: other, producerVersion: '1', reasonChain: { contributions: [] } }), /one writer per field/);
});

test('runJevStage through the engine sink lands jev.call events and jev.* rows in engine tables', async () => {
  const sink = createEngineSink();
  const gw = createJevGateway({ evaluate: okEvaluate(0.8), sink, env: KEY_ENV,
    getCredits: async () => ({ balance: '4.50', totalUsed: '0.50' }) });
  const asOf = '2026-09-20T16:00:00.000Z';
  const out = await runJevStage({ view: { as_of: asOf, managers: [], rows: [], events: [] }, asOf, gateway: gw, sink,
    asks: [{ qtype: 'plays_sunday', subject: { entity_type: 'player', entity_id: '101', label: 'Player One' } }] });
  assert.equal(out.results[0].status, 'ok');
  const calls = getEvents({ asOf: new Date(), types: ['jev.call'] });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(e => e.source === 'jev' && e.payload.ok === 1 && e.payload.qtype === 'plays_sunday'));
  const rowsOut = rows(`SELECT field, producer, producer_version, lane, event_ids, entity_type, entity_id FROM engine_state
    WHERE producer = 'jev' ORDER BY id`);
  const answers = rowsOut.filter(r => /^jev\.plays_sunday\.jev_[ab]$/.test(r.field));
  assert.equal(answers.length, 2);
  for (const r of answers) {
    assert.equal(r.lane, 'shadow', 'answers are shadow rows (weight 0)');
    assert.equal(r.producer_version, JEV_PRODUCER_VERSIONS.shadow);
    assert.equal(JSON.parse(r.event_ids).length, 1, 'each answer cites its jev.call event');
    assert.ok(calls.some(c => c.id === JSON.parse(r.event_ids)[0]));
  }
  const bal = engineState.getState('engine', 'jev', 'jev.balance', { asOf: new Date() });
  assert.ok(bal, 'jev.balance is written at stage start, readable in lane live');
  assert.deepEqual(bal.value, { balance_usd: 4.5, total_used_usd: 0.5 });
});

test('jev.balance is written at stage start and again only after an hour', async () => {
  let clock = Date.parse('2026-09-21T12:00:00.000Z');
  let credits = 0;
  const sink = createEngineSink();
  const gw = createJevGateway({ evaluate: okEvaluate(), sink, env: KEY_ENV, now: () => clock,
    getCredits: async () => ({ balance: String(10 - credits++), totalUsed: '0' }) });
  const run = () => runJevStage({ view: { as_of: new Date(clock).toISOString(), managers: [], rows: [], events: [] },
    asOf: new Date(clock).toISOString(), gateway: gw, sink, now: () => clock, asks: [] });
  await run();
  clock += 30 * 60_000; await run();
  assert.equal(credits, 1, 'no second balance read inside the hour');
  clock += 31 * 60_000; await run();
  assert.equal(credits, 2, 'hourly');
  const n = rows(`SELECT COUNT(*) AS n FROM engine_state WHERE field = 'jev.balance' AND as_of >= '2026-09-21'`)[0].n;
  assert.equal(n, 2);
});

test('the no_key status lands as an engine row, and a runaway alert as a jev.runaway event', async () => {
  const sink = createEngineSink();
  const gw = createJevGateway({ evaluate: okEvaluate(), sink, env: {} });
  await runJevStage({ view: { as_of: T, managers: [], rows: [], events: [] }, asOf: '2026-09-22T00:00:00.000Z', gateway: gw, sink,
    asks: [{ qtype: 'plays_sunday', subject: { entity_type: 'player', entity_id: '101', label: 'Player One' } }] });
  const st = engineState.getState('engine', 'jev', 'jev.status', { asOf: new Date() });
  assert.equal(st.value.status, 'no_key');
  let clock = Date.now();
  const gw2 = createJevGateway({ evaluate: okEvaluate(), sink, env: KEY_ENV, now: () => clock,
    runaway: createRunawayMonitor({ now: () => clock, medianPerHour: () => 1000 }) });
  const q = buildQuestions('p_accept', 'a', { entity_type: 'offer', entity_id: '1', label: 'offer 1' });
  for (let i = 0; i < 4; i++) {
    await gw2.ask({ qtype: 'p_accept', arm: 'a', state: 'SAME', questions: q, asOf: new Date(clock).toISOString() });
    clock += 1000;
  }
  const alerts = getEvents({ asOf: new Date(), types: ['jev.runaway'] });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].payload.reasons[0].kind, 'repeat_hash');
});

test("the runaway monitor's trailing median reads jev.call events", () => {
  // A window in the past (appendEvents clamps a future stamp to the capture time), far
  // from the calls the tests above logged.
  const now = Date.parse('2026-01-08T00:00:00.000Z');
  const sink = createEngineSink();
  // Seven days of history: 2 calls in every past hour, 10 in the most recent full hour.
  for (let h = 1; h <= 167; h++) {
    const n = h === 1 ? 10 : 2;
    for (let i = 0; i < n; i++) {
      sink.appendEvent({ type: 'jev_call', as_of: new Date(now - (h + 0.5) * 3_600_000 + i * 1000).toISOString(),
        payload: { qtype: 'p_accept', ok: 1, prompt_hash: `h${h}-${i}` } });
    }
  }
  assert.equal(jevCallMedianPerHour({ now: () => now })(), 2);
  // The current hour is not history: 50 calls in it leave a 2-hour log of 1/h at median 1.
  const now2 = Date.parse('2026-01-20T00:00:00.000Z');
  for (const [ago, n] of [[2.5, 1], [1.5, 1], [0.2, 50]]) {
    for (let i = 0; i < n; i++) {
      sink.appendEvent({ type: 'jev_call', as_of: new Date(now2 - ago * 3_600_000 + i * 1000).toISOString(),
        payload: { qtype: 'p_accept', ok: 1, prompt_hash: `n2-${ago}-${i}` } });
    }
  }
  assert.equal(jevCallMedianPerHour({ now: () => now2 })(), 1);
  const m = createRunawayMonitor({ now: () => now, medianPerHour: jevCallMedianPerHour({ now: () => now }) });
  for (let i = 0; i < 11; i++) m.recordSend({ hash: `x${i}` });
  assert.ok(m.check().some(r => r.kind === 'rate' && r.trailing_median_per_hour === 2));
});
