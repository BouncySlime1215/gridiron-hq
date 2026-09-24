import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// FIX-08: reasoning goes into the plan, one writer. The producer's one
// function (scripts/reasoning/reason-plans.mjs) writes `reasoning` into every
// deck move of a contract plans file. Every call goes to an injected stand-in:
// no network, no key, no spend.
process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-reasoning-plan-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db } = await import('../server/db/index.js');
const { reasonPlans } = await import('../scripts/reasoning/reason-plans.mjs');
const { reasoningFlag, REASONING_ENV } = await import('../server/services/reasoning-flag.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { REASON_OFF, REASON_UNPAID, REASON_STEP_FAILED, PANELS_CACHE, panelsCachePath } =
  await import('../server/services/reasoning/plan-reasoning.js');
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/reasoning/plans.json'), 'utf8'));
const NEWS = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/reasoning/news.json'), 'utf8'));
const PAID = { GRIDIRON_ALLOW_PAID_RUN: 'yes' };
const UNPAID = {};

const saved = { [REASONING_ENV]: process.env[REASONING_ENV], [PREVIEW_ENV]: process.env[PREVIEW_ENV] };
function setEnv(k, v) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
test.beforeEach(() => { setEnv(REASONING_ENV, undefined); setEnv(PREVIEW_ENV, undefined); });
test.after(() => {
  for (const [k, v] of Object.entries(saved)) setEnv(k, v);
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

let dirN = 0;
function plansFileIn() {
  const dir = path.join(temp, `run-${dirN++}`);
  fs.mkdirSync(dir);
  return path.join(dir, 'plans.json');
}

/** Every move a panel belongs to: each deck entry, and next_move. */
function moves(plans) {
  return plans.leagues.flatMap(l => [
    ...(l.alternatives?.status === 'ok' ? l.alternatives.value : []),
    ...(l.next_move?.status === 'ok' ? [l.next_move.value] : [])
  ]);
}

/** An injected writer: grounded words for every card it is sent. */
function writer() {
  const prompts = [];
  const callClaude = async req => {
    prompts.push(req);
    const cards = JSON.parse(req.prompt.slice(req.prompt.indexOf('\n') + 1));
    const panels = cards.map(c => ({
      card_id: c.card_id,
      case_for: { claims: [{ text: `Chance he says yes is ${Math.round(c.facts['card.p_yes'] * 100)}%.`, cites: ['card.p_yes'] }] },
      his_side: { claims: [{ text: 'He is rebuilding.', cites: ['his.label.0'] }] },
      devils_advocate: { claims: [{ text: 'The gain may not last.', cites: ['card.title_delta'] }],
        would_change: [{ text: 'Missing the send window.', cites: ['card.send_when'] }] },
      news_check: { contradictions: c.news.map(n => ({ quote_id: n.quote_id,
        claim: { text: 'The back you get was limited in practice.', cites: [`news.${n.quote_id}.headline`] } })) },
      counter: { likely: { text: 'He asks for the tight end.', cites: ['reply.counter.counter'] },
        answer: { text: 'Answer by the counter rules.', cites: ['reply.counter.action'] } }
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ panels }) }], usage: { input_tokens: 10, output_tokens: 10 }, cost_usd: 0.01 };
  };
  return { prompts, callClaude };
}

test('reasoning-flag.js: off by default, on for exactly "1", on under preview and says so', () => {
  assert.deepEqual(reasoningFlag(), { enabled: false, preview: false });
  process.env[REASONING_ENV] = 'true';
  assert.equal(reasoningFlag().enabled, false);
  process.env[REASONING_ENV] = '1';
  assert.deepEqual(reasoningFlag(), { enabled: true, preview: false });
  delete process.env[REASONING_ENV];
  process.env[PREVIEW_ENV] = '1';
  assert.deepEqual(reasoningFlag(), { enabled: true, preview: true });
});

test('reasoning-flag.js is the only file under server/, scripts/ or client/src that names GRIDIRON_REASONING_ENABLED', () => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : /\.(c|m)?js$|\.tsx?$/.test(e.name) ? [full] : [];
  });
  const hits = ['server', 'scripts', 'client/src'].flatMap(d => walk(path.join(REPO, d)))
    .filter(f => fs.readFileSync(f, 'utf8').includes('GRIDIRON_REASONING_ENABLED'))
    .map(f => path.relative(REPO, f));
  assert.deepEqual(hits, ['server/services/reasoning-flag.js']);
});

test('gate off (flag): 0 calls, every move reasoning unknown with the reason, file still the contract', async () => {
  const plans = structuredClone(FIXTURE);
  const file = plansFileIn();
  const w = writer();
  const run = await reasonPlans({ plans, plansFile: file, env: PAID, news: NEWS, callClaude: w.callClaude });
  run.commit();
  assert.equal(w.prompts.length, 0);
  assert.equal(run.summary.status, 'off');
  const all = moves(plans);
  assert.equal(all.length, 8, 'league 1: five deck moves + next_move; league 4: one + next_move');
  for (const m of all) assert.deepEqual(m.reasoning, { status: 'unknown', source: 'coach.text', reason: REASON_OFF, as_of: FIXTURE.generated_at });
  assert.deepEqual(validatePlans(plans).errors, []);
  assert.equal(fs.existsSync(panelsCachePath(file)), false, 'gate off never writes the cache');
});

test('gate off (paid run not allowed): 0 calls, unknown with the paid-run reason', async () => {
  process.env[REASONING_ENV] = '1';
  const plans = structuredClone(FIXTURE);
  const w = writer();
  const run = await reasonPlans({ plans, plansFile: plansFileIn(), env: UNPAID, news: NEWS, callClaude: w.callClaude });
  assert.equal(w.prompts.length, 0);
  assert.equal(run.summary.status, 'unpaid');
  assert.ok(moves(plans).every(m => m.reasoning.status === 'unknown' && m.reasoning.reason === REASON_UNPAID));
  assert.deepEqual(validatePlans(plans).errors, []);
});

test('both gates on: each panel lands in move.reasoning as a contract field; cache sits next to the plans file', async () => {
  process.env[REASONING_ENV] = '1';
  const plans = structuredClone(FIXTURE);
  const file = plansFileIn();
  const w = writer();
  const run = await reasonPlans({ plans, plansFile: file, env: PAID, news: NEWS, callClaude: w.callClaude });
  assert.equal(w.prompts.length, 2);
  assert.deepEqual(validatePlans(plans).errors, [], 'the plans file with reasoning is still the contract');

  const [l1] = plans.leagues;
  const head = l1.alternatives.value[0].reasoning;
  assert.equal(head.status, 'ok');
  assert.equal(head.value.case_for, 'Chance he says yes is 38%.');
  assert.equal(head.value.check_first, true, '48 h news on a player in the move');
  assert.ok(head.value.cites.includes('card.p_yes'));
  assert.match(head.value.confidence, /calibration/);
  assert.deepEqual(l1.next_move.value.reasoning, head, 'next_move is the deck head and carries the same panel');
  assert.equal(l1.alternatives.value[1].reasoning.value.check_first, false);

  const l4 = plans.leagues[3].alternatives.value[0].reasoning;
  assert.equal(l4.status, 'ok');
  assert.match(l4.value.his_side, /nothing on his roster/, 'an omitted section carries its reason, in words');
  assert.match(l4.value.counter, /no reply table/);

  run.commit();
  assert.equal(run.summary.cache, path.join(path.dirname(file), PANELS_CACHE));
  assert.ok(fs.existsSync(run.summary.cache));
  assert.ok(!run.summary.cache.includes(`${path.sep}server${path.sep}data${path.sep}`));
});

test('an unchanged move_id -> 0 calls on the next run (reused from panels.json)', async () => {
  process.env[REASONING_ENV] = '1';
  const file = plansFileIn();
  const first = await reasonPlans({ plans: structuredClone(FIXTURE), plansFile: file, env: PAID, news: NEWS, callClaude: writer().callClaude });
  first.commit();
  const plans = structuredClone(FIXTURE);
  const w = writer();
  const again = await reasonPlans({ plans, plansFile: file, env: PAID, news: NEWS, callClaude: w.callClaude });
  assert.equal(w.prompts.length, 0);
  assert.equal(again.summary.reused, 6);
  assert.equal(again.summary.total_cost_usd, 0);
  assert.equal(plans.leagues[0].alternatives.value[0].reasoning.status, 'ok', 'a reused panel is written into the move again');
});

test('a failed call is failed and a spent allowance is unknown, both with words', async () => {
  process.env[REASONING_ENV] = '1';
  const failing = structuredClone(FIXTURE);
  await reasonPlans({ plans: failing, plansFile: plansFileIn(), env: PAID, news: NEWS,
    callClaude: async () => { throw new Error('boom'); } });
  const f = failing.leagues[0].alternatives.value[0].reasoning;
  assert.equal(f.status, 'failed');
  assert.match(f.reason, /call failed/);

  const capped = structuredClone(FIXTURE);
  await reasonPlans({ plans: capped, plansFile: plansFileIn(), env: PAID, news: NEWS,
    callClaude: async () => { throw Object.assign(new Error('cap'), { code: 'LLM_BUDGET_EXHAUSTED' }); } });
  const c = capped.leagues[0].alternatives.value[0].reasoning;
  assert.equal(c.status, 'unknown');
  assert.match(c.reason, /allowance for this league is spent/);
  assert.deepEqual(validatePlans(failing).errors, []);
  assert.deepEqual(validatePlans(capped).errors, []);
});

test('a reasoning step that throws marks every move failed and reports the error; the plans still validate', async () => {
  process.env[REASONING_ENV] = '1';
  const plans = structuredClone(FIXTURE);
  const run = await reasonPlans({ plans, plansFile: plansFileIn(), env: PAID,
    produceReasoning: async () => { throw new Error('panel contract broken'); } });
  assert.equal(run.summary.status, 'failed');
  assert.equal(run.summary.error, 'panel contract broken');
  assert.ok(moves(plans).every(m => m.reasoning.status === 'failed' && m.reasoning.reason === REASON_STEP_FAILED));
  assert.deepEqual(validatePlans(plans).errors, []);
});

test('no news feed for a league: news_check says the check did not run', async () => {
  process.env[REASONING_ENV] = '1';
  const plans = structuredClone(FIXTURE);
  await reasonPlans({ plans, plansFile: plansFileIn(), env: PAID, callClaude: writer().callClaude });
  const r = plans.leagues[0].alternatives.value[0].reasoning;
  assert.match(r.value.news_check, /No news feed reached this run/);
  assert.equal(r.value.check_first, false);
});

test('one writer: the producer reasons after planning and before its atomic write; run.mjs goes through the same function', () => {
  const producer = fs.readFileSync(path.join(REPO, 'scripts/campaign/produce-plans.mjs'), 'utf8');
  const plan = producer.indexOf('planLeague(adapter');
  const reason = producer.indexOf('reasonPlans({ plans: file');
  const write = producer.indexOf('fs.renameSync(tmp, out)');
  const commit = producer.indexOf('reasoning.commit()');
  assert.ok(plan > 0 && reason > plan && write > reason && commit > write, 'plan -> reason -> write -> cache');
  const manual = fs.readFileSync(path.join(REPO, 'scripts/reasoning/run.mjs'), 'utf8');
  assert.match(manual, /reasonPlans\(/);
  assert.match(manual, /warRoomPlansPath\(\)/);
  assert.doesNotMatch(manual, /server\/data/);
});
