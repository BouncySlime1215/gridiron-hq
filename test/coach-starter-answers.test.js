/**
 * COACH-ANSWERS: Coach answers the War Room dock's four starter prompts with no
 * paid model call.
 *
 * Pinned here:
 *   - the four STARTER_PROMPTS (CoachDock.tsx) and two paraphrases each go
 *     through the real POST /api/coach/ask route with no model key and a
 *     stand-in client that counts calls: every one comes back 200 with at
 *     least two claims, every claim cited, verification ok, every number in
 *     the claims found in the plan, cost_usd 0 and zero model calls
 *   - the War Room screen actions stay alongside the claims
 *   - who to message first never names a blocked (unreachable) team and puts
 *     the active pool first
 *   - a league where nothing clears says the producer's reason and the
 *     nearest miss
 *   - mutation: a broken cite fails grounding; a changed plan number changes
 *     the claim
 *   - flag (GRIDIRON_COACH_BRIEF_ENABLED, or preview mode) off and no key:
 *     the route's old 400 stands
 * Plans from main's regenerated producer fixture (FIX-03). No network, no
 * league or manager names.
 *
 * The metric line (`# METRIC {...}`) is what the PR's Measured section quotes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-starter-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.GRIDIRON_ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
process.env.GRIDIRON_WARROOM_ENABLED = '1';

const FIXTURE = new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url);
const PLANS = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const plans = () => structuredClone(PLANS);
const PLANS_FILE = path.join(temp, 'plans.json');
const writePlans = file => fs.writeFileSync(PLANS_FILE, JSON.stringify(file));
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
writePlans(plans());

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { default: coachRouter } = await import('../server/routes/coach.js');
const { hashSessionToken } = await import('../server/platform/auth.js');

// The route allows 12 asks a minute per user; each ask here signs in as its own reader.
const READERS = 60;
for (let i = 0; i < READERS; i++) {
  run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, ?, 'Reader')`, 9301 + i, `coach-starter-${i}`);
  run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
       VALUES (?, ?, datetime('now','+1 day'))`, 9301 + i, hashSessionToken(`starter-token-${i}`));
}
let reader = 0;

let modelCalls = 0;
setAnthropicClientForTesting({ messages: { create: async () => { modelCalls += 1; throw new Error('no model in this test'); } } });

const app = express();
app.use(express.json());
app.use('/api/coach', coachRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/coach`;
test.after(() => { server.close(); setAnthropicClientForTesting(null); fs.rmSync(temp, { recursive: true, force: true }); });

const ask = (question, leagueId = 4) => fetch(`${base}/ask`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer starter-token-${reader++ % READERS}` },
  body: JSON.stringify({ question, league_id: leagueId,
    context: { surface: 'war_room', route: '/trade-brain?view=war-room', league: leagueId } }) });

const QUESTIONS = [
  ['next_move', "What's my next move and why?"], ['next_move', 'What should I do next?'],
  ['next_move', "What's the best trade to make right now?"],
  ['why_nothing', 'Why is nothing clearing?'], ['why_nothing', "Why aren't any moves clearing the bar?"],
  ['why_nothing', 'How come no trade clears?'],
  ['all_in', 'Show me the all-in plan'], ['all_in', 'What if I go all in?'],
  ['all_in', 'What does the aggressive plan look like?'],
  ['message_first', 'Who should I message first?'], ['message_first', 'Who do I reach out to first?'],
  ['message_first', 'Which manager should I contact first?']
];

/* ------------------------------------------- numbers only from the plan */

const NUMBER = /[-+]?\d[\d,]*(?:\.\d+)?/g;
/** Every number the plan entry holds: numeric leaves, numeric strings, and digits inside its strings. */
function planNumbers(node, out = new Set()) {
  if (typeof node === 'number' && Number.isFinite(node)) out.add(node);
  else if (typeof node === 'string') for (const m of node.matchAll(NUMBER)) out.add(Number(m[0].replace(/,/g, '')));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { planNumbers(k, out); planNumbers(v, out); }
  return out;
}
const places = t => (t.includes('.') ? t.length - t.indexOf('.') - 1 : 0);
const round = (v, p) => Math.round(v * 10 ** p) / 10 ** p;
function inPlan(token, numbers) {
  const target = Number(token.replace(/,/g, ''));
  const p = places(token);
  for (const v of numbers) {
    for (const c of [v, v * 100, -v, -v * 100]) if (round(c, p) === round(target, p)) return true;
  }
  return false;
}
/** Numbers in claim text that appear nowhere in the plan entry (the metric's "unverified numbers"). */
function strayNumbers(claims, entry) {
  const numbers = planNumbers(entry);
  return claims.flatMap(c => [...c.text.matchAll(NUMBER)].map(m => m[0]).filter(t => !inPlan(t, numbers)));
}

function citesResolve(body) {
  const cells = new Set();
  for (const q of body.ledger?.queries ?? []) (q.rows ?? []).forEach((row, i) => Object.keys(row).forEach(k => cells.add(`${q.id}#${i}.${k}`)));
  for (const d of body.ledger?.derived ?? []) cells.add(d.id);
  return (body.answer?.claims ?? []).every(c => c.cites.length && c.cites.every(x => cells.has(x)));
}

/* ------------------------------------------------------------- metric */

test('12 starter questions: >= 2 cited claims each, verification ok, numbers from the plan, $0, fast', async () => {
  const entry = PLANS.leagues.find(e => e.league === 4);
  const rows = [];
  for (const [intent, q] of QUESTIONS) {
    const t0 = performance.now();
    const res = await ask(q);
    const ms = performance.now() - t0;
    const body = await res.json();
    const claims = body.answer?.claims ?? [];
    rows.push({ intent, q, status: res.status, ms: Math.round(ms), claims: claims.length,
      cited: res.status === 200 && citesResolve(body), verified: body.verification?.ok === true,
      stray: strayNumbers(claims, entry), cost: body.cost_usd ?? null,
      actions: (body.actions ?? []).map(a => a.type) });
  }
  const sorted = rows.map(r => r.ms).sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  const answered = rows.filter(r => r.status === 200 && r.claims >= 2 && r.cited && r.verified && !r.stray.length && r.cost === 0);
  console.log('# METRIC ' + JSON.stringify({ answered: `${answered.length}/${rows.length}`,
    claims: rows.map(r => r.claims), stray_numbers: rows.reduce((n, r) => n + r.stray.length, 0),
    cost_usd: rows.reduce((n, r) => n + (r.cost ?? 0), 0), model_calls: modelCalls, p95_ms: p95,
    statuses: [...new Set(rows.map(r => r.status))] }));
  for (const r of rows) {
    assert.equal(r.status, 200, r.q);
    assert.ok(r.claims >= 2, `${r.q}: ${r.claims} claims`);
    assert.ok(r.cited, `${r.q}: a cite does not resolve`);
    assert.ok(r.verified, `${r.q}: verification failed`);
    assert.deepEqual(r.stray, [], `${r.q}: numbers not in the plan`);
    assert.equal(r.cost, 0, r.q);
  }
  assert.equal(modelCalls, 0);
  assert.ok(p95 < 1500, `p95 ${p95} ms`);
});

/* ---------------------------------------------------------- content */

const texts = body => body.answer.claims.map(c => c.text).join('\n');

test('next move: partner, give, get, chance with its guess label, title-odds change, step k of n, send-when; actions kept', async () => {
  const body = await (await ask("What's my next move and why?")).json();
  const t = texts(body);
  assert.match(t, /Offer Team 3 P4 \(WR\) \+ P6 \(RB\) for P21 \(WR\)\./);
  assert.match(t, /Chance he says yes: 53%, a guess/);
  assert.match(t, /title odds move \+11\.6 pts to 54%/);
  assert.match(t, /Step 1 of 1 toward/);
  assert.match(t, /When: Now/);
  assert.deepEqual(body.actions.map(a => a.type), ['focus_panel', 'plug_in']);
  assert.equal(body.actions[0].panel, 'next_move');
  assert.equal(body.cost_usd, 0);
});

test('why nothing clears, when something does: says so, with the gain and the runner-up; explain action kept', async () => {
  const body = await (await ask('Why is nothing clearing?')).json();
  const t = texts(body);
  assert.match(t, /A move does clear/);
  assert.match(t, /\+11\.6 pts/);
  assert.match(t, /Next best: Team 3/);
  assert.deepEqual(body.actions.map(a => a.type), ['explain']);
});

test('why nothing clears, when nothing does: the producer reason and the nearest miss', async () => {
  const body = await (await ask('Why is nothing clearing?', 5)).json();
  const t = texts(body);
  assert.equal(body.verification.ok, true);
  assert.match(t, /None of the 87 paths searched clears the sliders/);
  assert.match(t, /Nearest miss: .*mode/);
  assert.equal(strayNumbers(body.answer.claims, PLANS.leagues.find(e => e.league === 5)).length, 0);
});

test('all-in plan: first step, expected, if complete, chance to complete (a guess)', async () => {
  const body = await (await ask('Show me the all-in plan')).json();
  const t = texts(body);
  assert.match(t, /first step: offer Team 2 P4 \(WR\) \+ P6 \(RB\) \+ P7 \(WR\) for P11 \(WR\)/);
  assert.match(t, /Expected: \+3\.7 pts of title odds; \+40\.7 pts if it all lands\./);
  assert.match(t, /Chance it completes: 9%, a guess/);
});

test('who to message first: planner order, active pool first, never a blocked team', async () => {
  const file = plans();
  const e = file.leagues.find(x => x.league === 4);
  e.partners.value.push({ team: '9', p_responds: 0, basis: 'Nick: unreachable', edge: { status: 'ok', value: 0 },
    offers_logged: 0, checked_out: false, blocked: true });
  e.partners.value[2].basis = 'Nick: active; activity read (receptiveness 0.30)';
  writePlans(file);
  try {
    const body = await (await ask('Who should I message first?')).json();
    const t = texts(body);
    assert.match(body.answer.claims[0].text, /^Message Team 2 first/);
    assert.match(t, /Then Team 3, then Team 4\./);
    assert.doesNotMatch(t.replace(/Skipped:.*$/m, ''), /Team 9/);
    assert.match(t, /Skipped: Team 9/);
    assert.equal(body.verification.ok, true);
  } finally { writePlans(plans()); }
});

/* ---------------------------------------------------------- mutation */

test('mutation: a broken cite fails grounding and the claim does not ship', async () => {
  const { starterClaims, groundStarter } = await import('../server/services/coach/starter-answers.js');
  const { newLedger } = await import('../server/services/coach/ledger.js');
  const ledger = newLedger();
  const draft = starterClaims('next_move', { entry: plans().leagues.find(e => e.league === 4), ledger });
  const good = groundStarter(draft, ledger);
  assert.equal(good.dropped.length, 0);
  const broken = draft.map((c, i) => (i === 0 ? { ...c, cites: c.cites.map(x => x.replace(/^r\d+/, 'r999')) } : c));
  const out = groundStarter(broken, ledger);
  assert.equal(out.dropped.length, 1);
  assert.match(out.dropped[0].violations.join(' '), /not in this turn's ledger/);
  assert.equal(out.claims.length, good.claims.length - 1);
});

test('mutation: a changed plan number changes the claim', async () => {
  const file = plans();
  file.leagues.find(e => e.league === 4).next_move.value.steps[0].p_yes.value = 0.61;
  writePlans(file);
  try {
    const body = await (await ask("What's my next move and why?")).json();
    assert.match(texts(body), /Chance he says yes: 61%/);
    assert.equal(body.verification.ok, true);
  } finally { writePlans(plans()); }
});

/* -------------------------------------------------------------- flag */

test('flag off and no key: the route keeps its 400 and reads nothing', async () => {
  process.env.GRIDIRON_COACH_BRIEF_ENABLED = '0';
  try {
    const res = await ask("What's my next move and why?");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /No Anthropic API key/);
  } finally { process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1'; }
  assert.equal(modelCalls, 0);
});

test('no key, a question outside the four: a plain refusal naming what Coach can answer, $0', async () => {
  const res = await ask('How many points did my kicker score last week?');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.answer.claims.length, 0);
  assert.match(body.answer.refusals[0], /no model key/i);
  assert.equal(body.cost_usd, 0);
  assert.equal(modelCalls, 0);
});
